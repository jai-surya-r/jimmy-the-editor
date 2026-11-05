// Project model shared by the server (Node) and the browser. No DOM or Node APIs in here.
//
// Conventions (also documented for Claude in each project's CLAUDE.md):
//  - All times are seconds (floats). clip.start / clip.duration are timeline time;
//    clip.in is the source in-point. Source time = in + (t - start) * speed.
//  - Keyframe `t` is relative to the clip's start on the timeline.
//  - transform.x / transform.y are pixel offsets of the layer centre from the frame centre.
//    scale 1 = the media's native pixel size.
//  - seq.tracks: video tracks composite in array order (first video track = V1 = bottom).
//  - Clips, markers and in/out points sit on the sequence's frame grid: normalisation moves anything
//    that isn't on a whole frame to the nearest one, so nothing on a timeline can start mid-frame.

export const FORMAT = 'claude-edit/1';
export const REVIEWS_FORMAT = 'claude-edit-reviews/1';

// sequence: a nested sequence (clip.sequence = its id), played and rendered as its contents (flattenSequence);
// adjust: an adjustment layer: moves and treats everything below it (clip.below), within its own area (clip.transform)
export const CLIP_TYPES = ['video', 'audio', 'image', 'text', 'solid', 'sequence', 'adjust'];
// Label colours (Premiere's sixteen): clip.label names one; the timeline draws the clip in it instead of its type's
export const LABEL_COLORS = {
  violet: '#a990dd', iris: '#7d82dd', caribbean: '#1db398', lavender: '#e384e3', cerulean: '#1d9bd3', forest: '#51883a',
  rose: '#f45b8e', mango: '#f89d33', purple: '#9b3eb0', blue: '#2f5ec9', teal: '#2c8c8c', magenta: '#e3317b',
  tan: '#ceb582', green: '#3da34a', brown: '#8e5a2b', yellow: '#e5d33a',
};
export const FX_PROPS = ['brightness', 'contrast', 'saturation', 'hue', 'grayscale', 'blur'];
export const CROP_PROPS = { cropLeft: 'left', cropTop: 'top', cropRight: 'right', cropBottom: 'bottom' };
// an adjustment layer's transform of the layers below it (clip.below), keyframed as these
export const BELOW_PROPS = { belowX: 'x', belowY: 'y', belowScale: 'scale', belowRotation: 'rotation' };
export const ANIMATABLE = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume', ...FX_PROPS, ...Object.keys(CROP_PROPS), ...Object.keys(BELOW_PROPS)];
export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'];
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'add'];

export const SEQUENCE_PRESETS = [
  { id: 'hd', label: 'HD 1080p · 16:9', width: 1920, height: 1080 },
  { id: 'uhd', label: '4K UHD · 16:9', width: 3840, height: 2160 },
  { id: 'hd720', label: 'HD 720p · 16:9', width: 1280, height: 720 },
  { id: 'vertical', label: 'Vertical 9:16 · Reels / Shorts / TikTok', width: 1080, height: 1920 },
  { id: 'portrait', label: 'Portrait 4:5 · Feed', width: 1080, height: 1350 },
  { id: 'square', label: 'Square 1:1', width: 1080, height: 1080 },
];
export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

// Transitions are stored on the clip they belong to: transitionIn / transitionOut = { type, duration }.
// "pair" types blend with the adjacent clip on the same track when there is one (the incoming
// clip owns the transition). Without a neighbour they degrade to a single-clip animation.
export const TRANSITIONS = {
  crossfade: { label: 'Cross dissolve', pair: true },
  dipBlack: { label: 'Dip to black', pair: true, center: true, color: '#000000' },
  dipWhite: { label: 'Dip to white', pair: true, center: true, color: '#ffffff' },
  wipe: { label: 'Wipe', pair: true },
  push: { label: 'Push', pair: true },
  slide: { label: 'Slide over', pair: true },
  fade: { label: 'Fade', pair: false },
  pop: { label: 'Pop', pair: false },
  zoom: { label: 'Zoom', pair: false },
  slideUp: { label: 'Slide up', pair: false },
  slideDown: { label: 'Slide down', pair: false },
  slideLeft: { label: 'Slide left', pair: false },
  slideRight: { label: 'Slide right', pair: false },
};

export const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_CROP = { left: 0, top: 0, right: 0, bottom: 0 };
export const DEFAULT_EFFECTS = { brightness: 0, contrast: 0, saturation: 0, hue: 0, grayscale: 0, blur: 0 };
export const DEFAULT_BELOW = { x: 0, y: 0, scale: 1, rotation: 0 };
export const DEFAULT_TEXT_STYLE = {
  font: 'Inter', size: 96, weight: 800, italic: false, color: '#ffffff',
  align: 'center', lineHeight: 1.15, letterSpacing: 0, uppercase: false, maxWidth: 0,
  stroke: { color: '#000000', width: 0 },
  shadow: { color: '#000000', opacity: 0, blur: 12, x: 0, y: 4 },
  background: { color: '#000000', opacity: 0, padding: 24, radius: 16, mode: 'block' },
};
export const CAPTION_STYLE = {
  ...DEFAULT_TEXT_STYLE, size: 64, weight: 800,
  stroke: { color: '#000000', width: 6 },
  shadow: { color: '#000000', opacity: 0.45, blur: 10, x: 0, y: 3 },
};

// ---------------------------------------------------------------- small helpers

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function uid(prefix) {
  let s = '';
  for (let i = 0; i < 8; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `${prefix}_${s}`;
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) return +v;
  return d;
};
const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isObj(v) ? v : {});

export function deepClone(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------- time

export function fpsRational(fps) {
  const ntsc = [[23.976, '24000/1001'], [29.97, '30000/1001'], [47.952, '48000/1001'], [59.94, '60000/1001'], [119.88, '120000/1001']];
  for (const [f, r] of ntsc) if (Math.abs(fps - f) < 0.01) return r;
  if (Math.abs(fps - Math.round(fps)) < 1e-6) return String(Math.round(fps));
  return `${Math.round(fps * 1000)}/1000`;
}
export const snapTime = (t, fps) => Math.round(t * fps) / fps;

export function timecode(t, fps, { frames = true } = {}) {
  const neg = t < 0;
  const nominal = Math.max(1, Math.round(fps));
  const f = Math.round(Math.abs(t) * fps);
  const ff = f % nominal;
  const total = Math.floor(f / nominal);
  const ss = total % 60, mm = Math.floor(total / 60) % 60, hh = Math.floor(total / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return (neg ? '-' : '') + `${p(hh)}:${p(mm)}:${p(ss)}` + (frames ? `:${p(ff)}` : '');
}

// Short human readable time: 1:23.4 / 12.0s
export function shortTime(t) {
  if (!Number.isFinite(t)) return '—';
  t = Math.round(t * 10) / 10; // round first, so 59.96 is "1:00.0" rather than "60.0s"
  if (t < 60) return `${t.toFixed(1)}s`;
  const m = Math.floor(t / 60), s = t - m * 60;
  if (m < 60) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
}

// Accepts "hh:mm:ss:ff", "mm:ss", "ss.s", "12s", "1.5" → seconds (or null)
export function parseTime(input, fps) {
  const s = String(input ?? '').trim().replace(/s$/i, '');
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  const parts = s.split(/[:;]/).map((x) => x.trim());
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 4) {
    // the inverse of timecode(): frames are counted at the nominal rate (30 per displayed second at 29.97)
    const nominal = Math.max(1, Math.round(fps || 30));
    return ((n[0] * 3600 + n[1] * 60 + n[2]) * nominal + n[3]) / (fps || nominal);
  }
  if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
  if (n.length === 2) return n[0] * 60 + n[1];
  return null;
}

// ---------------------------------------------------------------- easing / keyframes

export function ease(name, p) {
  p = clamp(p, 0, 1);
  switch (name) {
    case 'easeIn': return p * p * p;
    case 'easeOut': return 1 - Math.pow(1 - p, 3);
    case 'easeInOut': return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case 'hold': return 0;
    default: return p;
  }
}
const easeOutCubic = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);
const easeOutBack = (p) => { const c1 = 1.70158, c3 = c1 + 1; p = clamp(p, 0, 1); return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };

export function evalKeyframes(kfs, t, fallback) {
  if (!kfs || kfs.length === 0) return fallback;
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = kfs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (kfs[mid].t <= t) lo = mid; else hi = mid; }
  return segmentValue(kfs[lo], kfs[hi], t);
}

// ---- bezier keyframes (After Effects style)
// A keyframe may carry temporal handles: `out` shapes the segment after it, `in` the segment before it.
// Each is { speed, influence }: speed in value units per second, influence as a fraction (0–1] of the
// segment's duration. A segment with neither handle uses the keyframe's named `ease` exactly as before;
// with one, the missing side is filled in from that named ease.
export const isBezierSeg = (a, b) => a.ease !== 'hold' && !!(a.out || b.in);

// The segment's handles, filling in a missing side from the named ease so a curve can be edited from any start.
export function segmentHandles(a, b) {
  const dt = Math.max(1e-6, b.t - a.t);
  const slope = (b.v - a.v) / dt;
  const named = {
    linear: [slope, 1 / 3, slope, 1 / 3],
    easeIn: [0, 1 / 3, 3 * slope, 1 / 3],
    easeOut: [3 * slope, 1 / 3, 0, 1 / 3],
    easeInOut: [0, 0.65, 0, 0.65],
    hold: [0, 1 / 3, 0, 1 / 3],
  }[a.ease || 'linear'] || [slope, 1 / 3, slope, 1 / 3];
  const out = a.out || { speed: named[0], influence: named[1] };
  const inn = b.in || { speed: named[2], influence: named[3] };
  return { out, in: inn, dt };
}

// Bezier control points of a segment in (time, value).
export function segmentBezier(a, b) {
  const { out, in: inn, dt } = segmentHandles(a, b);
  const io = clamp(out.influence, 0.001, 1) * dt, ii = clamp(inn.influence, 0.001, 1) * dt;
  return [a.t, a.v, a.t + io, a.v + out.speed * io, b.t - ii, b.v - inn.speed * ii, b.t, b.v];
}

const bez = (p0, p1, p2, p3, s) => { const u = 1 - s; return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3; };
const bezD = (p0, p1, p2, p3, s) => { const u = 1 - s; return 3 * u * u * (p1 - p0) + 6 * u * s * (p2 - p1) + 3 * s * s * (p3 - p2); };

// Curve parameter for time t (x(s) is monotonic because both influences are within 0–1).
function bezParam(P, t) {
  let lo = 0, hi = 1, s = (t - P[0]) / Math.max(1e-9, P[6] - P[0]);
  for (let i = 0; i < 6; i++) { // Newton, then bisection as a fallback
    const x = bez(P[0], P[2], P[4], P[6], s) - t, d = bezD(P[0], P[2], P[4], P[6], s);
    if (Math.abs(x) < 1e-7) return s;
    if (Math.abs(d) < 1e-9) break;
    s -= x / d;
    if (s < 0 || s > 1) break;
  }
  for (let i = 0; i < 40; i++) {
    s = (lo + hi) / 2;
    if (bez(P[0], P[2], P[4], P[6], s) < t) lo = s; else hi = s;
  }
  return s;
}

export function segmentValue(a, b, t) {
  if (a.ease === 'hold' || b.t <= a.t) return a.v;
  if (!isBezierSeg(a, b)) return a.v + (b.v - a.v) * ease(a.ease || 'linear', (t - a.t) / (b.t - a.t));
  const P = segmentBezier(a, b);
  const s = bezParam(P, clamp(t, a.t, b.t));
  return bez(P[1], P[3], P[5], P[7], s);
}

// Rate of change (units per second) at clip-local time t — what the speed graph plots.
export function speedAt(kfs, t) {
  if (!kfs || kfs.length < 2 || t < kfs[0].t || t > kfs[kfs.length - 1].t) return 0;
  let i = 0;
  while (i < kfs.length - 2 && kfs[i + 1].t <= t) i++;
  const a = kfs[i], b = kfs[i + 1];
  if (a.ease === 'hold' || b.t <= a.t) return 0;
  if (isBezierSeg(a, b)) {
    const P = segmentBezier(a, b);
    const s = bezParam(P, t);
    const dx = bezD(P[0], P[2], P[4], P[6], s);
    return Math.abs(dx) < 1e-9 ? 0 : bezD(P[1], P[3], P[5], P[7], s) / dx;
  }
  const h = Math.min(1e-3, (b.t - a.t) / 50);
  const t0 = Math.max(a.t, t - h), t1 = Math.min(b.t, t + h);
  return t1 > t0 ? (segmentValue(a, b, t1) - segmentValue(a, b, t0)) / (t1 - t0) : 0;
}

export function staticValue(clip, prop) {
  if (prop === 'volume') return clip.volume ?? 1;
  if (FX_PROPS.includes(prop)) return clip.effects?.[prop] ?? 0;
  if (CROP_PROPS[prop]) return clip.crop?.[CROP_PROPS[prop]] ?? 0;
  if (BELOW_PROPS[prop]) return clip.below?.[BELOW_PROPS[prop]] ?? DEFAULT_BELOW[BELOW_PROPS[prop]];
  return clip.transform?.[prop] ?? DEFAULT_TRANSFORM[prop];
}
export function propAt(clip, prop, localT) {
  return evalKeyframes(clip.keyframes?.[prop], localT, staticValue(clip, prop));
}
export function isAnimated(clip, prop) {
  return (clip.keyframes?.[prop]?.length || 0) > 0;
}
export function transformAt(clip, localT) {
  return {
    x: propAt(clip, 'x', localT),
    y: propAt(clip, 'y', localT),
    scale: propAt(clip, 'scale', localT),
    rotation: propAt(clip, 'rotation', localT),
    opacity: clamp(propAt(clip, 'opacity', localT), 0, 1),
  };
}
// An adjustment layer's transform of the layers below it at clip-local time t
export function belowAt(clip, localT) {
  return { x: propAt(clip, 'belowX', localT), y: propAt(clip, 'belowY', localT), scale: propAt(clip, 'belowScale', localT), rotation: propAt(clip, 'belowRotation', localT) };
}
// Effects / crop at clip-local time t (keyframed values win over the static ones).
export function effectsAt(clip, localT) {
  const fx = clip.effects || DEFAULT_EFFECTS;
  if (!FX_PROPS.some((p) => clip.keyframes?.[p]?.length)) return fx;
  const out = { ...DEFAULT_EFFECTS, ...fx };
  for (const p of FX_PROPS) out[p] = propAt(clip, p, localT);
  return out;
}
export function cropAt(clip, localT) {
  const cr = clip.crop || DEFAULT_CROP;
  if (!Object.keys(CROP_PROPS).some((p) => clip.keyframes?.[p]?.length)) return cr;
  const out = {};
  for (const [p, side] of Object.entries(CROP_PROPS)) out[side] = clamp(propAt(clip, p, localT), 0, 0.95);
  return out;
}

export function maxScaleOf(clip) {
  let m = Math.abs(staticValue(clip, 'scale'));
  for (const k of clip.keyframes?.scale || []) m = Math.max(m, Math.abs(k.v));
  return m || 1;
}

// ---------------------------------------------------------------- clips / tracks

export const clipEnd = (c) => c.start + c.duration;
export const isVisualClip = (c) => c.type === 'video' || c.type === 'image' || c.type === 'text' || c.type === 'solid' || c.type === 'sequence' || c.type === 'adjust';
// clip.in / speed: where in its source (a file, or a nested sequence's own time) the clip starts, and how fast it plays
export const usesSourceTime = (c) => c.type === 'video' || c.type === 'audio' || c.type === 'sequence';
export const clipSourceTime = (c, t) => (c.in || 0) + (t - c.start) * (c.speed || 1);

// Longest the clip may be given its media handles (Infinity for stills/text/solids).
export function maxDurationFor(clip, media) {
  if (!usesSourceTime(clip) || !media || !Number.isFinite(media.duration) || media.duration <= 0) return Infinity;
  return Math.max(0, (media.duration - (clip.in || 0)) / (clip.speed || 1));
}

export const videoTracks = (seq) => seq.tracks.filter((t) => t.kind === 'video');
export const audioTracks = (seq) => seq.tracks.filter((t) => t.kind === 'audio');
export function trackLabel(seq, track) {
  if (track.name) return track.name;
  const list = track.kind === 'video' ? videoTracks(seq) : audioTracks(seq);
  return (track.kind === 'video' ? 'V' : 'A') + (list.indexOf(track) + 1);
}
export function clipsOnTrack(seq, trackId) {
  return seq.clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
}
export function sequenceDuration(seq) {
  let d = 0;
  for (const c of seq.clips) d = Math.max(d, clipEnd(c));
  return d;
}
export function mediaMap(project) {
  const m = {};
  for (const it of project.media) m[it.id] = it;
  return m;
}
export function findSequence(project, id) {
  return project.sequences.find((s) => s.id === id) || null;
}

export function fitScale(srcW, srcH, seq, mode = 'fit') {
  if (!srcW || !srcH) return 1;
  const sx = seq.width / srcW, sy = seq.height / srcH;
  if (mode === 'fill') return Math.max(sx, sy);
  if (mode === 'none') return 1;
  return Math.min(sx, sy);
}

// ---------------------------------------------------------------- layer resolution
// Shared by the preview engine, the exporter and the render worker so they always agree on
// what is on screen at time t.

function layer(clip, t) {
  const localT = t - clip.start;
  return { clip, localT, srcTime: clipSourceTime(clip, t), alpha: 1, dx: 0, dy: 0, scale: 1, reveal: null, tint: null, composite: null };
}

function applySingle(l, type, p, seq, out) {
  const e = easeOutCubic(p);
  const dir = out ? -1 : 1;
  const W = seq.width, H = seq.height;
  switch (type) {
    case 'crossfade': case 'fade': l.alpha *= clamp(p, 0, 1); break;
    case 'dipBlack': case 'dipWhite': l.tint = { color: TRANSITIONS[type].color, amount: 1 - clamp(p, 0, 1) }; break;
    case 'wipe': l.reveal = out ? { from: 'right', amount: clamp(p, 0, 1) } : { from: 'left', amount: clamp(p, 0, 1) }; break;
    case 'push': case 'slide': l.dx += (1 - e) * W * dir; break;
    case 'pop': l.scale *= 0.6 + 0.4 * easeOutBack(p); l.alpha *= clamp(p * 2.5, 0, 1); break;
    case 'zoom': l.scale *= 1 + 0.15 * (1 - e); l.alpha *= clamp(p, 0, 1); break;
    case 'slideUp': l.dy += (1 - e) * H * 0.08 * dir; l.alpha *= clamp(p * 1.5, 0, 1); break;
    case 'slideDown': l.dy -= (1 - e) * H * 0.08 * dir; l.alpha *= clamp(p * 1.5, 0, 1); break;
    case 'slideLeft': l.dx += (1 - e) * W * 0.08 * dir; l.alpha *= clamp(p * 1.5, 0, 1); break;
    case 'slideRight': l.dx -= (1 - e) * W * 0.08 * dir; l.alpha *= clamp(p * 1.5, 0, 1); break;
    default: break;
  }
}

const EPS = 1e-6;
export function clipActiveAt(c, t) { return t >= c.start - EPS && t < clipEnd(c) - EPS; }

// Returns { layers: [...bottom→top], group: bool } for one video track at time t.
// group = true means the layers must be blended in an offscreen buffer first (cross dissolve).
export function resolveVisualTrack(seq, track, t) {
  const clips = clipsOnTrack(seq, track.id).filter((c) => isVisualClip(c) && c.enabled !== false);
  const tol = 0.5 / (seq.fps || 30);
  let idx = -1;
  for (let i = 0; i < clips.length; i++) if (clipActiveAt(clips[i], t)) idx = i; // last wins on overlap
  if (idx < 0) return { layers: [], group: false };
  const cur = clips[idx];
  const prev = idx > 0 && Math.abs(clipEnd(clips[idx - 1]) - cur.start) <= tol ? clips[idx - 1] : null;
  const next = idx < clips.length - 1 && Math.abs(clipEnd(cur) - clips[idx + 1].start) <= tol ? clips[idx + 1] : null;
  const B = layer(cur, t);
  let A = null, group = false;

  const tin = cur.transitionIn;
  if (tin && TRANSITIONS[tin.type] && tin.duration > 0) {
    const def = TRANSITIONS[tin.type];
    const d = Math.min(tin.duration, cur.duration);
    if (def.pair && def.center && prev) {
      const half = d / 2;
      if (t < cur.start + half) B.tint = { color: def.color, amount: 1 - (t - cur.start) / half };
    } else if (def.pair && prev && t < cur.start + d) {
      const p = (t - cur.start) / d, e = easeOutCubic(p);
      A = layer(prev, t); // the outgoing clip keeps playing past its out point (handles)
      if (tin.type === 'crossfade') { A.alpha *= 1 - p; B.alpha *= p; B.composite = 'lighter'; group = true; }
      else if (tin.type === 'wipe') { B.reveal = { from: 'left', amount: p }; }
      else if (tin.type === 'push') { A.dx -= e * seq.width; B.dx += (1 - e) * seq.width; }
      else if (tin.type === 'slide') { B.dx += (1 - e) * seq.width; }
    } else if (t < cur.start + d) {
      applySingle(B, tin.type, (t - cur.start) / d, seq, false);
    }
  }
  // the outgoing half of a dip that belongs to the next clip
  if (next && next.transitionIn && TRANSITIONS[next.transitionIn.type]?.center && next.transitionIn.duration > 0) {
    const half = Math.min(next.transitionIn.duration, next.duration) / 2;
    if (t >= next.start - half) {
      const amount = 1 - (next.start - t) / half;
      B.tint = { color: TRANSITIONS[next.transitionIn.type].color, amount: Math.max(B.tint?.amount || 0, amount) };
    }
  }
  const tout = cur.transitionOut;
  if (tout && TRANSITIONS[tout.type] && tout.duration > 0) {
    const d = Math.min(tout.duration, cur.duration);
    const end = clipEnd(cur);
    if (t > end - d) applySingle(B, tout.type, (end - t) / d, seq, true);
  }
  return { layers: A ? [A, B] : [B], group };
}

// All visual layers at time t across the sequence, bottom → top.
export function resolveFrame(seq, t) {
  const out = [];
  for (const track of videoTracks(seq)) {
    if (track.hidden) continue;
    const r = resolveVisualTrack(seq, track, t);
    if (r.layers.length) out.push({ track, ...r });
  }
  return out;
}

// ---------------------------------------------------------------- nested sequences
// A nested sequence clip (type 'sequence') plays its sequence's contents. For playing and rendering, flattenSequence
// gives a sequence in which every nested clip's contents are clips of their own: copies of the inner clips that the
// nested clip shows (moved to its place, trimmed to the part it uses, sped up or slowed down with it), on tracks of
// their own. Their video tracks sit just below the nested clip's track and carry `nest` ({ id, clip, width, height,
// path }), so the compositor draws them into the nested clip's own picture first and then draws that picture with the
// nested clip's position, scale, crop, effects, opacity and transitions. Audio tracks follow the sequence's own. The
// nested clip stays where it is. Editing works on the sequence itself; only playback and rendering use this.
// Sequences without nested clips come back as they are. A sequence nested in itself (at any depth) is left out.
const nestSizes = new Map(); // sequence id -> { width, height }, for layerSize
export const nestSize = (id) => nestSizes.get(id) || null;
// Nested sound: an audio clip with `sequence` (and no media) plays that sequence's sound, as a nested clip shows its
// picture: one clip on the outer timeline, linked to the nested video clip, whose volume, fades and keyframes apply to
// the whole mix (and its track's mute, solo and volume). A nested video clip with `audioClip: true` leaves its sound
// to such a clip; one without (made before nested sound had a clip of its own) still plays its sequence's sound.
export const isNestAudio = (c) => c?.type === 'audio' && !!c.sequence;
const hasNested = (seq) => !!seq?.clips?.some((c) => c.type === 'sequence' || isNestAudio(c));

// A copy of inner clip `ic` placed where nested clip `c` shows it (trimmed to c's window w0..w1 of the inner
// timeline, k = c's speed), on track `trackId`; null when c doesn't show it.
function liftClip(ic, c, trackId, w0, w1, k) {
  const e = ic.start + ic.duration;
  const s0 = Math.max(ic.start, w0), s1 = Math.min(e, w1);
  if (s1 - s0 <= EPS) return null;
  const head = s0 - ic.start, tail = e - s1;
  const cc = { ...ic, id: `${c.id}~${ic.id}`, track: trackId, start: c.start + (s0 - w0) / k, duration: (s1 - s0) / k, link: ic.link ? `${c.id}~${ic.link}` : null };
  if (usesSourceTime(ic)) { cc.in = (ic.in || 0) + head * (ic.speed || 1); cc.speed = (ic.speed || 1) * k; }
  if (ic.keyframes && (head > EPS || k !== 1)) {
    cc.keyframes = Object.fromEntries(Object.entries(ic.keyframes).map(([p, list]) => [p, list.map((kf) => ({ ...kf, t: (kf.t - head) / k }))]));
  }
  if (head > EPS) { cc.transitionIn = null; if (cc.fadeIn) cc.fadeIn = Math.max(0, cc.fadeIn - head) / k; } else if (cc.transitionIn) cc.transitionIn = { ...cc.transitionIn, duration: cc.transitionIn.duration / k };
  if (tail > EPS) { cc.transitionOut = null; if (cc.fadeOut) cc.fadeOut = Math.max(0, cc.fadeOut - tail) / k; } else if (cc.transitionOut) cc.transitionOut = { ...cc.transitionOut, duration: cc.transitionOut.duration / k };
  // the nested audio clips this sound already plays through, moved the same way (whole: their fades stay put)
  if (ic.gains) cc.gains = ic.gains.map((p) => liftGain(p, c, w0, k));
  return cc;
}
function liftGain(p, c, w0, k) {
  const q = { ...p, start: c.start + (p.start - w0) / k, duration: p.duration / k };
  if (k !== 1) {
    if (p.fadeIn) q.fadeIn = p.fadeIn / k;
    if (p.fadeOut) q.fadeOut = p.fadeOut / k;
    if (p.keyframes) q.keyframes = Object.fromEntries(Object.entries(p.keyframes).map(([pr, list]) => [pr, list.map((kf) => ({ ...kf, t: kf.t / k }))]));
  }
  return q;
}

const flatCache = new WeakMap(); // seq -> { project sequences it used, flat }
export function flattenSequence(project, seq, depth = 0, path = [], deps = null) {
  if (!seq || seq.flat || !hasNested(seq)) return seq; // flattened already, or nothing nested
  for (const s of project.sequences) nestSizes.set(s.id, { width: s.width, height: s.height });
  const hit = depth === 0 ? flatCache.get(seq) : null;
  if (hit && hit.deps.every(([id, s]) => findSequence(project, id) === s)) return hit.flat;
  deps = deps || [];
  // nested audio clips are replaced by the sound they stand for
  const out = { ...seq, flat: true, tracks: [], clips: seq.clips.filter((c) => !isNestAudio(c)) };
  const extraAudio = [];
  const innerOf = (c) => {
    const inner0 = findSequence(project, c.sequence);
    deps.push([c.sequence, inner0]);
    if (!inner0 || inner0.id === seq.id || path.includes(inner0.id) || depth > 8) return null;
    return flattenSequence(project, inner0, depth + 1, [...path, seq.id], deps);
  };
  for (const track of seq.tracks) {
    if (track.kind === 'video') {
      // each nested clip's contents go just below the track the nested clip is on
      for (const c of seq.clips.filter((x) => x.track === track.id && x.type === 'sequence' && x.enabled !== false)) {
        const inner = innerOf(c);
        if (!inner) continue;
        const nest = { id: c.id, clip: c, width: inner.width, height: inner.height, background: inner.background, path: [...path, seq.id, inner.id] };
        const k = c.speed || 1, w0 = c.in || 0, w1 = w0 + c.duration * k;
        const vmap = {}, amap = {};
        for (const it of inner.tracks) {
          if (it.kind === 'video' && it.hidden) continue;
          if (it.kind !== 'video' && c.audioClip) continue; // its sound plays through its audio clip
          const vt = { ...it, id: `${c.id}~${it.id}`, name: it.name || '', nest: it.kind === 'video' ? (it.nest ? { ...it.nest, id: `${c.id}~${it.nest.id}` } : nest) : undefined, locked: true, solo: false };
          if (it.kind === 'video') { if (track.hidden) vt.hidden = true; vmap[it.id] = vt; } else amap[it.id] = vt;
        }
        // inner video tracks, bottom to top, then the nested clip's own track above them
        for (const it of inner.tracks) if (vmap[it.id]) out.tracks.push(vmap[it.id]);
        for (const it of inner.tracks) if (amap[it.id]) extraAudio.push(amap[it.id]);
        for (const ic of inner.clips) {
          const vt = vmap[ic.track] || amap[ic.track];
          if (!vt || ic.enabled === false) continue;
          const cc = liftClip(ic, c, vt.id, w0, w1, k);
          if (cc) out.clips.push(cc);
        }
      }
    } else {
      // a nested audio clip: its sequence's sound on tracks of its own, through this track and the clip's gain
      for (const a of seq.clips.filter((x) => x.track === track.id && isNestAudio(x) && x.enabled !== false)) {
        const inner = innerOf(a);
        if (!inner) continue;
        const k = a.speed || 1, w0 = a.in || 0, w1 = w0 + a.duration * k;
        const amap = {};
        for (const it of inner.tracks) {
          if (it.kind !== 'audio') continue;
          amap[it.id] = { ...it, id: `${a.id}~${it.id}`, name: it.name || '', nest: undefined, locked: true,
            solo: !!track.solo, muted: !!(track.muted || it.muted), volume: (track.volume ?? 1) * (it.volume ?? 1) };
          extraAudio.push(amap[it.id]);
        }
        for (const ic of inner.clips) {
          const at = amap[ic.track];
          if (!at || ic.type !== 'audio' || ic.enabled === false) continue;
          const cc = liftClip(ic, a, at.id, w0, w1, k);
          if (cc) { cc.gains = [...(cc.gains || []), a]; out.clips.push(cc); }
        }
      }
    }
    out.tracks.push(track);
  }
  out.tracks.push(...extraAudio);
  if (depth === 0) flatCache.set(seq, { deps, flat: out });
  return out;
}

// Gain for an audio clip at timeline time t (clip volume × keyframes × fades, and those of the nested audio clips it
// plays through). Track gain separate.
function ownGain(clip, t) {
  const local = t - clip.start;
  let g = propAt(clip, 'volume', local);
  if (clip.fadeIn > 0) g *= clamp(local / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0) g *= clamp((clip.duration - local) / clip.fadeOut, 0, 1);
  return Math.max(0, g);
}
export function audioGainAt(clip, t) {
  let g = ownGain(clip, t);
  for (const p of clip.gains || []) g *= ownGain(p, t);
  return g;
}

// Does sequence `id` make any sound (its own audio clips, or through sequences nested in it)?
export function sequenceHasSound(project, id, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const s = findSequence(project, id);
  return !!s?.clips.some((c) => (c.type === 'audio' && (c.media || c.sequence) && (!c.sequence || sequenceHasSound(project, c.sequence, seen)))
    || (c.type === 'sequence' && !c.audioClip && sequenceHasSound(project, c.sequence, seen)));
}

// Nested clips made before nested sound had its own clip get one (once per project: settings.nestAudio), linked to
// them, on the first audio track free at that time (or a new one). Ids come from the nested clip's, so every reader
// of the same file makes the same clips.
function addNestAudio(project) {
  for (const seq of project.sequences) {
    for (const v of seq.clips.filter((c) => c.type === 'sequence' && !c.audioClip)) {
      if (!sequenceHasSound(project, v.sequence)) continue;
      const end = v.start + v.duration;
      const free = (t) => !seq.clips.some((c) => c.track === t.id && c.start < end - EPS && c.start + c.duration > v.start + EPS);
      let track = audioTracks(seq).find(free);
      if (!track) {
        let n = audioTracks(seq).length + 1;
        while (seq.tracks.some((t) => t.id === `a${n}`)) n++;
        track = { id: `a${n}`, kind: 'audio', name: '', hidden: false, muted: false, locked: false, solo: false, volume: 1 };
        seq.tracks.push(track);
      }
      if (!v.link) v.link = `l_${v.id}`;
      v.audioClip = true;
      let id = `${v.id}_a`;
      while (seq.clips.some((c) => c.id === id)) id += 'a';
      seq.clips.push({ id, type: 'audio', sequence: v.sequence, track: track.id, start: v.start, duration: v.duration, in: v.in || 0, speed: v.speed || 1,
        volume: 1, fadeIn: 0, fadeOut: 0, keyframes: {}, enabled: v.enabled !== false, link: v.link, name: '' });
    }
  }
}
export function audibleTracks(seq) {
  const tracks = audioTracks(seq);
  const solo = tracks.some((t) => t.solo);
  return tracks.filter((t) => !t.muted && (!solo || t.solo));
}

// ---------------------------------------------------------------- normalisation
// Tolerant of hand-written JSON (Claude edits project.json directly): fills defaults,
// coerces types, keeps unknown keys, and reports problems as warnings instead of throwing.

function normKeyframes(kf) {
  const out = {};
  for (const [prop, list] of Object.entries(obj(kf))) {
    if (!ANIMATABLE.includes(prop)) continue;
    const pts = arr(list)
      .filter(isObj)
      .map((k) => {
        const o = { ...k, t: num(k.t, 0), v: num(k.v, 0), ease: EASINGS.includes(k.ease) ? k.ease : 'linear' };
        for (const side of ['in', 'out']) {
          if (isObj(k[side])) o[side] = { speed: num(k[side].speed, 0), influence: clamp(num(k[side].influence, 1 / 3), 0.01, 1) };
          else delete o[side];
        }
        return o;
      })
      .sort((a, b) => a.t - b.t);
    if (pts.length) out[prop] = pts;
  }
  return out;
}
function normTransition(tr, fallbackDur) {
  if (!isObj(tr) || !TRANSITIONS[tr.type]) return null;
  return { ...tr, type: tr.type, duration: Math.max(0, num(tr.duration, fallbackDur)) };
}
export function normalizeTextStyle(s) {
  const st = obj(s);
  return {
    ...DEFAULT_TEXT_STYLE, ...st,
    size: num(st.size, DEFAULT_TEXT_STYLE.size),
    weight: num(st.weight, DEFAULT_TEXT_STYLE.weight),
    lineHeight: num(st.lineHeight, DEFAULT_TEXT_STYLE.lineHeight),
    letterSpacing: num(st.letterSpacing, 0),
    maxWidth: num(st.maxWidth, 0),
    italic: bool(st.italic), uppercase: bool(st.uppercase),
    align: ['left', 'center', 'right'].includes(st.align) ? st.align : 'center',
    stroke: styleGroup(DEFAULT_TEXT_STYLE.stroke, st.stroke),
    shadow: styleGroup(DEFAULT_TEXT_STYLE.shadow, st.shadow),
    background: styleGroup(DEFAULT_TEXT_STYLE.background, st.background),
  };
}
// A nested style group over its defaults; fields that are numbers by default stay numbers ("6" → 6).
function styleGroup(def, value) {
  const out = { ...def, ...obj(value) };
  for (const k of Object.keys(def)) if (typeof def[k] === 'number') out[k] = num(out[k], def[k]);
  return out;
}

function inferType(c, media, track) {
  if (CLIP_TYPES.includes(c.type)) return c.type;
  if (media) {
    if (media.type === 'audio' || track?.kind === 'audio') return 'audio';
    if (media.type === 'image') return 'image';
    return 'video';
  }
  if (typeof c.text === 'string') return 'text';
  if (c.sequence) return track?.kind === 'audio' ? 'audio' : 'sequence';
  if (c.below) return 'adjust';
  if (c.color) return 'solid';
  return track?.kind === 'audio' ? 'audio' : 'video';
}

export function normalizeClip(c, ctx) {
  const { mediaById, trackById, warnings, settings } = ctx;
  const id = str(c.id) || uid('c');
  const media = c.media ? mediaById[c.media] : null;
  const track = trackById[c.track];
  const type = inferType(c, media, track);
  const out = {
    ...c, id, type, track: str(c.track),
    start: Math.max(0, num(c.start, 0)),
    duration: Math.max(1e-3, num(c.duration, media && usesSourceTime({ type }) ? Math.max(0.1, (media.duration || 5) - num(c.in, 0)) : settings.stillDuration)),
  };
  if (type === 'sequence') {
    out.sequence = str(c.sequence);
    out.in = Math.max(0, num(c.in, 0));
    out.speed = clamp(num(c.speed, 1), 0.05, 16);
    if (!out.sequence) warnings.push(`clip ${id}: nested sequence clip has no "sequence"`);
  } else if (type === 'video' || type === 'audio') {
    out.in = Math.max(0, num(c.in, 0));
    out.speed = clamp(num(c.speed, 1), 0.05, 16);
    if (type === 'audio' && c.sequence) out.sequence = str(c.sequence); // nested sound (isNestAudio): no media
    else if (!c.media) warnings.push(`clip ${id}: ${type} clip has no "media"`);
    else if (!media) warnings.push(`clip ${id}: media "${c.media}" is not in the bin`);
  } else if (type === 'image') {
    if (!c.media) warnings.push(`clip ${id}: image clip has no "media"`);
    else if (!media) warnings.push(`clip ${id}: media "${c.media}" is not in the bin`);
  }
  if (type !== 'audio') {
    out.transform = { ...DEFAULT_TRANSFORM, ...obj(c.transform) };
    for (const k of Object.keys(DEFAULT_TRANSFORM)) out.transform[k] = num(out.transform[k], DEFAULT_TRANSFORM[k]);
    out.transform.flipH = bool(out.transform.flipH);
    out.transform.flipV = bool(out.transform.flipV);
    out.crop = { ...DEFAULT_CROP, ...obj(c.crop) };
    for (const k of Object.keys(DEFAULT_CROP)) out.crop[k] = clamp(num(out.crop[k], 0), 0, 1);
    out.effects = { ...DEFAULT_EFFECTS, ...obj(c.effects) };
    for (const k of Object.keys(DEFAULT_EFFECTS)) out.effects[k] = num(out.effects[k], 0);
    out.blend = BLEND_MODES.includes(c.blend) ? c.blend : 'normal';
    out.lut = isObj(c.lut) && str(c.lut.path) ? { ...c.lut, path: str(c.lut.path), intensity: clamp(num(c.lut.intensity, 1), 0, 1) } : null;
    out.transitionIn = normTransition(c.transitionIn, settings.transitionDuration);
    out.transitionOut = normTransition(c.transitionOut, settings.transitionDuration);
  } else {
    out.volume = Math.max(0, num(c.volume, 1));
    out.fadeIn = Math.max(0, num(c.fadeIn, 0));
    out.fadeOut = Math.max(0, num(c.fadeOut, 0));
  }
  if (type === 'text') {
    out.text = str(c.text, 'Text');
    out.style = normalizeTextStyle(c.style);
  }
  if (type === 'solid') out.color = str(c.color, '#ffffff');
  if (type === 'adjust') {
    out.below = { ...DEFAULT_BELOW, ...obj(c.below) };
    for (const k of Object.keys(DEFAULT_BELOW)) out.below[k] = num(out.below[k], DEFAULT_BELOW[k]);
  }
  out.keyframes = normKeyframes(c.keyframes);
  out.enabled = c.enabled !== false;
  out.link = c.link ? str(c.link) : null;
  out.name = str(c.name, '');
  if (c.label != null) { if (LABEL_COLORS[c.label]) out.label = c.label; else delete out.label; }
  if (track && (track.kind === 'audio') !== (type === 'audio')) {
    warnings.push(`clip ${id}: ${type} clip is on ${track.kind} track "${track.id}"`);
  }
  return out;
}

function normTrack(t, kind) {
  return {
    ...t,
    id: str(t.id) || uid('t'),
    kind: t.kind === 'audio' || t.kind === 'video' ? t.kind : kind,
    name: str(t.name, ''),
    hidden: bool(t.hidden), muted: bool(t.muted), locked: bool(t.locked), solo: bool(t.solo),
    volume: Math.max(0, num(t.volume, 1)),
  };
}

// Put a clip's start and end on whole frames. A video/audio clip keeps showing the same source moment at
// the same timeline time (its in-point moves with its start). Returns true if anything had to move.
function snapClipToFrames(c, fps) {
  const off = (v) => Math.abs(v * fps - Math.round(v * fps)) > 1e-3;
  const end = c.start + c.duration;
  if (!off(c.start) && !off(end)) return false;
  const start = Math.max(0, Math.round(c.start * fps) / fps);
  const stop = Math.max(start + 1 / fps, Math.round(end * fps) / fps);
  if (usesSourceTime(c)) c.in = Math.max(0, (c.in || 0) + (start - c.start) * (c.speed || 1));
  c.start = start;
  c.duration = stop - start;
  return true;
}
const snapToFrame = (t, fps) => (t == null ? t : Math.round(t * fps) / fps);

export function normalizeSequence(s, project, warnings, stats) {
  const seq = {
    ...s,
    id: str(s.id) || uid('s'),
    name: str(s.name, 'Sequence'),
    folder: s.folder ? str(s.folder) : null,
    width: Math.max(16, Math.round(num(s.width, 1920))),
    height: Math.max(16, Math.round(num(s.height, 1080))),
    fps: clamp(num(s.fps, 30), 1, 240),
    background: str(s.background, '#000000'),
  };
  let tracks = arr(s.tracks).filter(isObj).map((t) => normTrack(t, 'video'));
  const seen = new Set();
  tracks = tracks.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  const mediaById = mediaMap(project);
  const rawClips = arr(s.clips).filter(isObj);
  // Create tracks that clips reference but that don't exist yet.
  for (const c of rawClips) {
    const tid = str(c.track);
    if (tid && !tracks.some((t) => t.id === tid)) {
      const m = c.media ? mediaById[c.media] : null;
      const kind = c.type === 'audio' || m?.type === 'audio' || /^a/i.test(tid) ? 'audio' : 'video';
      tracks.push(normTrack({ id: tid, kind }, kind));
    }
  }
  if (!tracks.some((t) => t.kind === 'video')) tracks.unshift(normTrack({ id: 'v1', kind: 'video' }, 'video'));
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push(normTrack({ id: 'a1', kind: 'audio' }, 'audio'));
  // keep video tracks before audio tracks, preserving relative order
  tracks = [...tracks.filter((t) => t.kind === 'video'), ...tracks.filter((t) => t.kind === 'audio')];
  seq.tracks = tracks;
  const trackById = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const ctx = { mediaById, trackById, warnings, settings: project.settings };
  const ids = new Set();
  seq.clips = rawClips.map((c) => {
    const n = normalizeClip(c, ctx);
    if (!n.track || !trackById[n.track]) n.track = (n.type === 'audio' ? audioTracks(seq) : videoTracks(seq))[0].id;
    if (ids.has(n.id)) { warnings.push(`duplicate clip id ${n.id} (renamed)`); n.id = uid('c'); }
    ids.add(n.id);
    return n;
  });
  // everything on the timeline sits on whole frames
  let moved = 0;
  for (const c of seq.clips) if (snapClipToFrames(c, seq.fps)) moved++;
  if (moved) {
    warnings.push(`${moved} clip${moved === 1 ? ' was' : 's were'} not on a whole frame at ${seq.fps} fps in "${seq.name}" and ${moved === 1 ? 'was' : 'were'} moved to the nearest frame (start and duration must be multiples of 1/${seq.fps} s)`);
    if (stats) stats.snapped = (stats.snapped || 0) + moved;
  }
  seq.markers = arr(s.markers).filter(isObj).map((m) => ({ ...m, id: str(m.id) || uid('mk'), t: snapToFrame(Math.max(0, num(m.t, 0)), seq.fps), label: str(m.label, ''), color: str(m.color, '#f5a524') }));
  seq.inPoint = s.inPoint == null ? null : snapToFrame(Math.max(0, num(s.inPoint, 0)), seq.fps);
  seq.outPoint = s.outPoint == null ? null : snapToFrame(Math.max(0, num(s.outPoint, 0)), seq.fps);
  // overlap warnings
  for (const t of tracks) {
    const cs = seq.clips.filter((c) => c.track === t.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) {
      if (cs[i].start < clipEnd(cs[i - 1]) - 1e-4) warnings.push(`clips ${cs[i - 1].id} and ${cs[i].id} overlap on track ${t.id}`);
    }
  }
  return seq;
}

export function normalizeMedia(m) {
  const path = str(m.path);
  const name = str(m.name) || path.split(/[\\/]/).pop() || 'Media';
  return {
    ...m,
    id: str(m.id) || uid('m'),
    name,
    path,
    folder: m.folder ? str(m.folder) : null,
    type: ['video', 'audio', 'image'].includes(m.type) ? m.type : guessMediaType(path),
  };
}

export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mxf', 'mts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts'];
export const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg'];
export function guessMediaType(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'video';
}

export function normalizeProject(input) {
  const p = obj(input);
  const warnings = [];
  const out = { ...p, format: FORMAT, name: str(p.name, 'Untitled') };
  out.settings = { defaultScaling: 'fit', stillDuration: 5, transitionDuration: 0.5, ...obj(p.settings) };
  out.settings.stillDuration = Math.max(0.1, num(out.settings.stillDuration, 5));
  out.settings.transitionDuration = Math.max(0, num(out.settings.transitionDuration, 0.5));
  out.folders = arr(p.folders).filter(isObj).map((f) => ({ ...f, id: str(f.id) || uid('f'), name: str(f.name, 'Folder'), parent: f.parent ? str(f.parent) : null }));
  const mediaIds = new Set();
  out.media = arr(p.media).filter(isObj).map(normalizeMedia).filter((m) => {
    if (mediaIds.has(m.id)) { warnings.push(`duplicate media id ${m.id} (dropped)`); return false; }
    mediaIds.add(m.id);
    return true;
  });
  const seqIds = new Set();
  const stats = { snapped: 0 };
  out.sequences = arr(p.sequences).filter(isObj).map((s) => {
    const n = normalizeSequence(s, out, warnings, stats);
    if (seqIds.has(n.id)) { warnings.push(`duplicate sequence id ${n.id} (renamed)`); n.id = uid('s'); }
    seqIds.add(n.id);
    return n;
  });
  if (out.settings.nestAudio !== 1) { addNestAudio(out); out.settings.nestAudio = 1; }
  return { project: out, warnings, snapped: stats.snapped };
}

// ---------------------------------------------------------------- serialisation
// Writes a tidy file: defaults are omitted so project.json stays short and readable.

const round6 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);
function roundDeep(v) {
  if (Array.isArray(v)) return v.map(roundDeep);
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = roundDeep(x); return o; }
  return round6(v);
}
const allDefault = (o, d) => Object.keys(d).every((k) => (o?.[k] ?? d[k]) === d[k]) && Object.keys(o || {}).every((k) => k in d);

function serializeClip(c) {
  const o = { ...c };
  if (!o.label) delete o.label;
  if (o.enabled !== false) delete o.enabled;
  if (!o.link) delete o.link;
  if (!o.name) delete o.name;
  if (o.speed === 1) delete o.speed;
  if (o.type === 'audio') {
    delete o.transform; delete o.crop; delete o.effects; delete o.blend; delete o.lut; delete o.transitionIn; delete o.transitionOut;
    if (!o.fadeIn) delete o.fadeIn;
    if (!o.fadeOut) delete o.fadeOut;
  } else {
    delete o.volume; delete o.fadeIn; delete o.fadeOut;
    if (o.transform) { o.transform = { ...o.transform }; if (!o.transform.flipH) delete o.transform.flipH; if (!o.transform.flipV) delete o.transform.flipV; }
    if (allDefault(o.crop, DEFAULT_CROP)) delete o.crop;
    if (allDefault(o.effects, DEFAULT_EFFECTS)) delete o.effects;
    if (o.blend === 'normal') delete o.blend;
    if (!o.lut) delete o.lut;
    else if (o.lut.intensity === 1) { o.lut = { ...o.lut }; delete o.lut.intensity; }
    if (!o.transitionIn) delete o.transitionIn;
    if (!o.transitionOut) delete o.transitionOut;
  }
  if (o.type !== 'video' && o.type !== 'audio') { delete o.in; delete o.speed; }
  if (o.keyframes) {
    const kf = {};
    for (const [p, list] of Object.entries(o.keyframes)) if (list?.length) kf[p] = list.map((k) => { if (k.ease !== 'linear') return k; const { ease, ...rest } = k; return rest; });
    if (Object.keys(kf).length) o.keyframes = kf; else delete o.keyframes;
  }
  return o;
}
function serializeTrack(t) {
  const o = { ...t };
  for (const k of ['hidden', 'muted', 'locked', 'solo']) if (!o[k]) delete o[k];
  if (o.volume === 1) delete o.volume;
  if (!o.name) delete o.name;
  return o;
}
export function serializeProject(p) {
  const out = { ...p };
  out.sequences = p.sequences.map((s) => {
    const o = { ...s, tracks: s.tracks.map(serializeTrack), clips: s.clips.map(serializeClip) };
    if (o.inPoint == null) delete o.inPoint;
    if (o.outPoint == null) delete o.outPoint;
    if (!o.markers?.length) delete o.markers;
    return o;
  });
  return roundDeep(out);
}

// ---------------------------------------------------------------- reviews

export function normalizeReviews(input) {
  const r = obj(input);
  const versions = arr(r.versions).filter(isObj).map((v, i) => ({
    ...v,
    id: str(v.id) || uid('v'),
    sequence: v.sequence ? str(v.sequence) : null,
    number: num(v.number, i + 1),
    name: str(v.name, `v${i + 1}`),
    file: str(v.file),
    createdAt: str(v.createdAt, new Date(0).toISOString()),
    status: ['in_review', 'changes', 'approved'].includes(v.status) ? v.status : 'in_review',
  }));
  const comments = arr(r.comments).filter(isObj).map((c) => ({
    ...c,
    id: str(c.id) || uid('cm'),
    version: str(c.version),
    t: Math.max(0, num(c.t, 0)),
    tEnd: c.tEnd == null ? null : num(c.tEnd, null),
    text: str(c.text),
    author: str(c.author, 'You'),
    createdAt: str(c.createdAt, new Date(0).toISOString()),
    resolved: bool(c.resolved),
    drawing: arr(c.drawing).filter(isObj),
    replies: arr(c.replies).filter(isObj).map((x) => ({ ...x, id: str(x.id) || uid('r'), author: str(x.author, 'You'), text: str(x.text), createdAt: str(x.createdAt, new Date(0).toISOString()) })),
  }));
  return { ...r, format: REVIEWS_FORMAT, versions, comments };
}

// ---------------------------------------------------------------- new documents

export function makeSequence({ name = 'Sequence 1', width = 1920, height = 1080, fps = 30, background = '#000000', folder = null } = {}) {
  return {
    id: uid('s'), name, folder, width, height, fps, background,
    tracks: [
      { id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'v3', kind: 'video' },
      { id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio' },
    ],
    clips: [], markers: [],
  };
}

export function makeProject(name) {
  const now = new Date().toISOString();
  const seq = makeSequence({ name: 'Main Edit' });
  return normalizeProject({
    format: FORMAT, name, createdAt: now,
    // originalNames: footage names follow the server's rule from the start (server/clipnames.js)
    settings: { defaultScaling: 'fit', stillDuration: 5, transitionDuration: 0.5, originalNames: 1 },
    folders: [], media: [], sequences: [seq],
  }).project;
}

export function makeReviews() {
  return { format: REVIEWS_FORMAT, versions: [], comments: [] };
}

// Compact pretty-printer: small objects/arrays stay on one line so the file reads like a table.
export function stringifyCompact(value, maxLine = 110) {
  const inline = (v) => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (isObj(v)) {
      const e = Object.entries(v).filter(([, x]) => x !== undefined);
      return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
    }
    return JSON.stringify(v) ?? 'null';
  };
  const fmt = (v, indent, prefixLen) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    const one = inline(v);
    if (one.length + indent.length + prefixLen <= maxLine) return one;
    const next = indent + '  ';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return `[\n${v.map((x) => next + fmt(x, next, 0)).join(',\n')}\n${indent}]`;
    }
    const e = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!e.length) return '{}';
    return `{\n${e.map(([k, x]) => `${next}${JSON.stringify(k)}: ${fmt(x, next, k.length + 4)}`).join(',\n')}\n${indent}}`;
  };
  return fmt(value, '', 0) + '\n';
}
