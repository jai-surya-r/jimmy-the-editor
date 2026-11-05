// The frame compositor. The live viewer and the export worker both call composeFrame(), so
// what you see while editing is what gets rendered.
import { resolveFrame, transformAt, clamp, maxScaleOf, effectsAt, cropAt, belowAt, nestSize } from './model.js';
import { lutState, loadLut, applyLut } from './lut.js';
import { textLayout, drawTextBitmap } from './text.js';
import { isFontReady, prepareFont } from './fonts.js';
import { registerStats } from './perf.js';

export const OFFLINE = Symbol('offline');

const BLEND = {
  normal: 'source-over', add: 'lighter', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken',
  lighten: 'lighten', 'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'soft-light': 'soft-light',
  'hard-light': 'hard-light', difference: 'difference',
};

// ---------------------------------------------------------------- text cache

const textCache = new Map();
export function clearTextCache() { textCache.clear(); }
// for the performance recorder: entries, and the megapixels of their drawn bitmaps
registerStats('textCache', () => {
  let px = 0, n = 0;
  for (const e of textCache.values()) for (const b of e.bitmaps.values()) { n++; px += (b.width || 0) * (b.height || 0); }
  return `${textCache.size} texts, ${n} bitmaps, ${Math.round(px / 1e6)} Mpx`;
});

function textEntry(clip, seq) {
  const key = `${seq.width}\u0000${clip.text}\u0000${JSON.stringify(clip.style)}`;
  let e = textCache.get(key);
  if (!e) {
    if (!isFontReady(clip.style)) prepareFont(clip.style).then(clearTextCache);
    e = { layout: textLayout(clip, seq), bitmaps: new Map() };
    textCache.set(key, e);
    if (textCache.size > 400) textCache.delete(textCache.keys().next().value);
  }
  return e;
}
export function textSource(clip, seq, factor) {
  const e = textEntry(clip, seq);
  const fk = clamp(Math.ceil(factor * 4) / 4, 0.25, 6);
  let bmp = e.bitmaps.get(fk);
  if (!bmp) {
    bmp = drawTextBitmap(e.layout, fk);
    e.bitmaps.set(fk, bmp);
  }
  return bmp;
}

// Native (unscaled) size of a clip's layer in sequence pixels.
export function layerSize(clip, mediaById, seq) {
  if (clip.type === 'text') { const l = textEntry(clip, seq).layout; return { w: l.w, h: l.h }; }
  if (clip.type === 'solid' || clip.type === 'adjust') return { w: seq.width, h: seq.height };
  if (clip.type === 'sequence') { const n = nestSize(clip.sequence); return { w: n?.width || seq.width, h: n?.height || seq.height }; }
  const m = mediaById[clip.media];
  return { w: m?.width || seq.width, h: m?.height || seq.height };
}

export function effectsFilter(fx, k) {
  if (!fx) return '';
  const p = [];
  if (fx.brightness) p.push(`brightness(${Math.max(0, 1 + fx.brightness)})`);
  if (fx.contrast) p.push(`contrast(${Math.max(0, 1 + fx.contrast)})`);
  if (fx.saturation) p.push(`saturate(${Math.max(0, 1 + fx.saturation)})`);
  if (fx.hue) p.push(`hue-rotate(${fx.hue}deg)`);
  if (fx.grayscale) p.push(`grayscale(${clamp(fx.grayscale, 0, 1)})`);
  if (fx.blur > 0) p.push(`blur(${(fx.blur * k).toFixed(2)}px)`);
  return p.join(' ');
}

// Layer geometry at time t: centre, rotation, scale and the 4 corners (sequence px) — used for
// the viewer's selection box and hit testing.
export function layerGeometry(layer, mediaById, seq) {
  const c = layer.clip;
  const tr = transformAt(c, layer.localT);
  const { w, h } = layerSize(c, mediaById, seq);
  const crop = cropAt(c, layer.localT);
  const cx = seq.width / 2 + tr.x + (layer.dx || 0);
  const cy = seq.height / 2 + tr.y + (layer.dy || 0);
  const s = tr.scale * (layer.scale || 1);
  const sx = s * (c.transform?.flipH ? -1 : 1), sy = s * (c.transform?.flipV ? -1 : 1);
  const rad = (tr.rotation * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const x0 = -w / 2 + crop.left * w, x1 = w / 2 - crop.right * w;
  const y0 = -h / 2 + crop.top * h, y1 = h / 2 - crop.bottom * h;
  const map = (x, y) => [cx + (x * sx) * cos - (y * sy) * sin, cy + (x * sx) * sin + (y * sy) * cos];
  return {
    cx, cy, w, h, scale: s, rotation: tr.rotation, transform: tr,
    corners: [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)],
    toLocal(px, py) {
      const dx = px - cx, dy = py - cy;
      const lx = (dx * cos + dy * sin) / sx, ly = (-dx * sin + dy * cos) / sy;
      return [lx, ly];
    },
    contains(px, py) {
      const [lx, ly] = this.toLocal(px, py);
      return lx >= Math.min(x0, x1) && lx <= Math.max(x0, x1) && ly >= Math.min(y0, y1) && ly <= Math.max(y0, y1);
    },
  };
}

// ---------------------------------------------------------------- drawing

const scratch = new WeakMap();
function scratchFor(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  let c = scratch.get(ctx);
  if (!c || c.width !== W || c.height !== H) {
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    scratch.set(ctx, c);
  }
  return c;
}

function drawOffline(ctx, x, y, w, h, k, motion) {
  // a motion graphic that hasn't finished rendering yet gets a calm placeholder, not an error
  ctx.fillStyle = motion ? 'rgba(40, 30, 70, 0.55)' : '#3a0d14';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = motion ? '#9d8cff' : '#ff4d6a';
  ctx.lineWidth = 4 / k;
  if (motion) ctx.setLineDash([16 / k, 10 / k]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = motion ? '#d6ceff' : '#ff9aac';
  ctx.font = `600 ${Math.max(14, Math.min(w, h) / 12)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(motion ? 'Rendering motion graphic…' : 'Media offline', x + w / 2, y + h / 2);
}

function drawLayer(ctx, l, env) {
  const { seq, mediaById, getSource, scale } = env;
  const c = l.clip;
  const tr = transformAt(c, l.localT);
  let alpha = clamp(tr.opacity * l.alpha, 0, 1);
  // layers that can be see-through (stills, text, motion graphics) don't get a colour wash on dips — it would
  // paint their transparent areas — they fade instead
  const seeThrough = c.type === 'text' || c.type === 'image' || !!mediaById[c.media]?.motion;
  if (l.tint && seeThrough) alpha *= 1 - clamp(l.tint.amount, 0, 1);
  if (alpha <= 0.001) return;

  let src = null, w, h, margin = 0;
  if (c.type === 'text') {
    const ts = textSource(c, seq, scale * maxScaleOf(c) * (l.scale || 1));
    src = ts.canvas; w = ts.w; h = ts.h; margin = ts.margin;
  } else if (c.type === 'solid') {
    w = seq.width; h = seq.height;
  } else if (c.type === 'sequence') {
    // a nested sequence: its contents, already drawn into its own picture this frame (composeFrame)
    const b = env.nestBuffers?.get(c.id);
    if (!b) return;
    src = b.canvas; w = b.w; h = b.h;
  } else if (c.type === 'adjust') {
    return; // drawn by applyAdjust
  } else {
    const m = mediaById[c.media];
    w = m?.width || seq.width;
    h = m?.height || seq.height;
    src = m ? getSource(l) : OFFLINE;
    if (!src) return; // still loading
  }

  ctx.save();
  if (l.reveal) {
    const a = clamp(l.reveal.amount, 0, 1);
    ctx.beginPath();
    if (l.reveal.from === 'right') ctx.rect(seq.width * (1 - a), 0, seq.width * a, seq.height);
    else ctx.rect(0, 0, seq.width * a, seq.height);
    ctx.clip();
  }
  ctx.translate(seq.width / 2 + tr.x + (l.dx || 0), seq.height / 2 + tr.y + (l.dy || 0));
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  const s = tr.scale * (l.scale || 1);
  ctx.scale(s * (c.transform?.flipH ? -1 : 1), s * (c.transform?.flipV ? -1 : 1));
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = l.composite || BLEND[c.blend] || 'source-over';
  const f = effectsFilter(effectsAt(c, l.localT), scale);
  if (f) ctx.filter = f;

  const crop = cropAt(c, l.localT);
  // exports send only the part of a picture that is on screen: { x, y, w, h } of the whole fw × fh
  const region = src?.region || null;
  if (c.lut?.path && src && src !== OFFLINE && (c.type === 'video' || c.type === 'image')) {
    const st = lutState(env.projectId, c.lut.path);
    if (!st) loadLut(env.projectId, c.lut.path);
    else if (st.status === 'ready') src = applyLut(src, st.lut, c.lut.intensity ?? 1);
  }
  const dx = -w / 2 + crop.left * w, dy = -h / 2 + crop.top * h;
  const dw = w * (1 - crop.left - crop.right), dh = h * (1 - crop.top - crop.bottom);
  if (dw > 0 && dh > 0) {
    if (c.type === 'solid') {
      ctx.fillStyle = c.color || '#ffffff';
      ctx.fillRect(dx, dy, dw, dh);
    } else if (c.type === 'text') {
      ctx.drawImage(src, -w / 2 - margin, -h / 2 - margin, w + margin * 2, h + margin * 2);
    } else if (src === OFFLINE) {
      ctx.filter = 'none';
      // the viewer plays a graphic that hasn't rendered yet live, on top of the frame (see LiveMotionLayers)
      if (!(env.liveMotion && mediaById[c.media]?.motion)) drawOffline(ctx, dx, dy, dw, dh, s * scale, !!mediaById[c.media]?.motion);
    } else {
      const iw = region ? region.fw : src.videoWidth || src.naturalWidth || src.width;
      const ih = region ? region.fh : src.videoHeight || src.naturalHeight || src.height;
      const sx = crop.left * iw, sy = crop.top * ih, sw = iw * (1 - crop.left - crop.right), sh = ih * (1 - crop.top - crop.bottom);
      if (!(iw && ih)) { /* nothing to draw */ } else if (!region) ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
      else {
        const x0 = Math.max(sx, region.x), y0 = Math.max(sy, region.y);
        const x1 = Math.min(sx + sw, region.x + region.w), y1 = Math.min(sy + sh, region.y + region.h);
        if (x1 > x0 && y1 > y0) {
          ctx.drawImage(src, x0 - region.x, y0 - region.y, x1 - x0, y1 - y0,
            dx + ((x0 - sx) * dw) / sw, dy + ((y0 - sy) * dh) / sh, ((x1 - x0) * dw) / sw, ((y1 - y0) * dh) / sh);
        }
      }
    }
    if (l.tint && l.tint.amount > 0 && !seeThrough) {
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * clamp(l.tint.amount, 0, 1);
      ctx.fillStyle = l.tint.color;
      ctx.fillRect(dx, dy, dw, dh);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- adjustment layers and nested sequences

// spare canvases per drawing context: key → canvas of a given size
const spares = new WeakMap();
function spare(ctx, key, W, H) {
  let m = spares.get(ctx);
  if (!m) { m = new Map(); spares.set(ctx, m); }
  let c = m.get(key);
  W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
  if (!c || c.width !== W || c.height !== H) {
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    m.set(key, c);
    if (m.size > 24) m.delete(m.keys().next().value);
  }
  return c;
}

// An adjustment layer: takes everything drawn below it so far, moves/scales/rotates it about the frame's centre by
// its "layers below" transform (clip.below, keyframed as belowX/belowY/belowScale/belowRotation) and treats it with its
// effects. The result replaces the picture inside the layer's own area: the frame, moved/scaled/rotated/cropped by the
// layer's own transform, and mixed in by its opacity (and fades). Uncovered parts show the background.
function applyAdjust(ctx, l, env) {
  const { seq, scale } = env;
  const c = l.clip;
  const own = transformAt(c, l.localT);
  const alpha = clamp(own.opacity * l.alpha, 0, 1);
  if (alpha <= 0.001) return;
  const b = belowAt(c, l.localT);
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const snap = spare(ctx, 'adj-in', W, H);
  const sctx = snap.getContext('2d');
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = 'copy';
  sctx.drawImage(ctx.canvas, 0, 0);
  sctx.globalCompositeOperation = 'source-over';
  const res = spare(ctx, 'adj-out', W, H);
  const rctx = res.getContext('2d');
  rctx.setTransform(1, 0, 0, 1, 0, 0);
  rctx.filter = 'none';
  rctx.globalAlpha = 1;
  rctx.globalCompositeOperation = 'source-over';
  rctx.clearRect(0, 0, W, H);
  if (!env.nested && !env.transparent) { rctx.fillStyle = seq.background || '#000000'; rctx.fillRect(0, 0, W, H); }
  rctx.setTransform(scale, 0, 0, scale, 0, 0);
  rctx.translate(seq.width / 2 + b.x, seq.height / 2 + b.y);
  if (b.rotation) rctx.rotate((b.rotation * Math.PI) / 180);
  rctx.scale(b.scale, b.scale);
  rctx.translate(-seq.width / 2, -seq.height / 2);
  const f = effectsFilter(effectsAt(c, l.localT), scale);
  if (f) rctx.filter = f;
  rctx.drawImage(snap, 0, 0, seq.width, seq.height);
  rctx.filter = 'none';
  // its own area: the frame, placed by its own transform and crop
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(seq.width / 2 + own.x + (l.dx || 0), seq.height / 2 + own.y + (l.dy || 0));
  if (own.rotation) ctx.rotate((own.rotation * Math.PI) / 180);
  const s = own.scale * (l.scale || 1);
  ctx.scale(s * (c.transform?.flipH ? -1 : 1), s * (c.transform?.flipV ? -1 : 1));
  const cr = cropAt(c, l.localT);
  const w = seq.width, h = seq.height;
  ctx.beginPath();
  ctx.rect(-w / 2 + cr.left * w, -h / 2 + cr.top * h, w * (1 - cr.left - cr.right), h * (1 - cr.top - cr.bottom));
  ctx.clip();
  // inside it: the original × (1 − opacity) + the adjusted × opacity
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(res, 0, 0);
  ctx.restore();
}

// env: { seq, mediaById, t, scale (canvas px per sequence px), getSource(layer) → drawable | OFFLINE | null, frame? }
// A flattened sequence's nested contents (tracks with `nest`, model.js flattenSequence) are drawn into a picture of
// their own per nested clip first; the nested clip's layer, on its track above them, then draws that picture.
export function composeFrame(ctx, env) {
  const { seq, t, scale } = env;
  const frame = env.frame || resolveFrame(seq, t);
  const nestBuffers = new Map(); // nested clip id -> { canvas, ctx, w, h, env }
  const mainEnv = { ...env, nestBuffers };
  const targetOf = (track) => {
    const n = track.nest;
    if (!n) return { c: ctx, e: mainEnv };
    let b = nestBuffers.get(n.id);
    if (!b) {
      const canvas = spare(ctx, `nest:${n.id}`, n.width * scale, n.height * scale);
      const bctx = canvas.getContext('2d');
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.globalAlpha = 1;
      bctx.globalCompositeOperation = 'source-over';
      bctx.filter = 'none';
      bctx.clearRect(0, 0, canvas.width, canvas.height);
      bctx.setTransform(scale, 0, 0, scale, 0, 0);
      b = { canvas, ctx: bctx, w: n.width, h: n.height, env: { ...env, nestBuffers, nested: true, seq: { ...seq, width: n.width, height: n.height, background: n.background } } };
      nestBuffers.set(n.id, b);
    }
    return { c: b.ctx, e: b.env };
  };
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  if (env.transparent) ctx.clearRect(0, 0, seq.width, seq.height);
  else {
    ctx.fillStyle = seq.background || '#000000';
    ctx.fillRect(0, 0, seq.width, seq.height);
  }
  for (const tr of frame) {
    const { c, e } = targetOf(tr.track);
    if (tr.layers.some((l) => l.clip.type === 'adjust')) {
      for (const l of tr.layers) { if (l.clip.type === 'adjust') applyAdjust(c, l, e); else drawLayer(c, l, e); }
    } else if (tr.group) {
      const off = scratchFor(c);
      const octx = off.getContext('2d');
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, off.width, off.height);
      octx.setTransform(scale, 0, 0, scale, 0, 0);
      for (const l of tr.layers) drawLayer(octx, l, e);
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(off, 0, 0);
      c.restore();
    } else {
      for (const l of tr.layers) drawLayer(c, l, e);
    }
  }
  ctx.restore();
  return frame;
}
