// The line on a timeline clip, as in Premiere: it shows one property of the clip over time (Opacity on picture, Volume on
// sound; the name on the clip chooses another). Selection tool: drag the line to change the value (between two keyframes
// it moves that segment), Ctrl/Cmd+click adds a keyframe. Pen tool: click the line to add one, drag a keyframe, drag across
// a clip to select several. Keyframes drag in time and value; Shift keeps one axis, Ctrl/Cmd moves in fine steps; Ctrl/Cmd+
// click turns a keyframe into a curve with handles and back; right-click for the interpolation.
import { html } from './common.js';
import { evalKeyframes, staticValue, isBezierSeg, snapTime, clamp, deepClone, FX_PROPS } from '../core/model.js';
import { setPropAt, setKeyframeInterp, keysAtTimes } from '../core/ops.js';

const LABEL_H = 19;
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const PROPS = {
  opacity: { label: 'Opacity', min: 0, max: 1, text: pct },
  scale: { label: 'Scale', min: 0, max: 4, text: pct },
  rotation: { label: 'Rotation', min: -180, max: 180, text: (v) => `${v.toFixed(1)}°` },
  x: { label: 'Position X', range: 'width', text: (v) => `${v.toFixed(1)} px` },
  y: { label: 'Position Y', range: 'height', text: (v) => `${v.toFixed(1)} px` },
  brightness: { label: 'Brightness', min: -1, max: 1, text: pct },
  contrast: { label: 'Contrast', min: -1, max: 1, text: pct },
  saturation: { label: 'Saturation', min: -1, max: 1, text: pct },
  hue: { label: 'Hue', min: -180, max: 180, text: (v) => `${v.toFixed(1)}°` },
  grayscale: { label: 'Grayscale', min: 0, max: 1, text: pct },
  blur: { label: 'Blur', min: 0, max: 200, text: (v) => `${v.toFixed(1)} px` },
  // a fader: silence at the bottom, +6 dB at the top, the fine range around 0 dB
  volume: { label: 'Volume', fader: true, text: (v) => (v <= 0 ? '-∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`) },
};
const VISUAL = ['opacity', 'scale', 'rotation', 'x', 'y', ...FX_PROPS];

const FADER_TOP = 2;
const span = (d, seq) => (d.range ? [-seq[d.range], seq[d.range]] : [d.min, d.max]);
const posOf = (prop, v, seq) => {
  const d = PROPS[prop];
  if (d.fader) return clamp((Math.max(0, v) / FADER_TOP) ** 0.25, 0, 1);
  const [lo, hi] = span(d, seq);
  return clamp((v - lo) / (hi - lo), 0, 1);
};
const valueOf = (prop, p, seq) => {
  const d = PROPS[prop];
  p = clamp(p, 0, 1);
  if (d.fader) return FADER_TOP * p ** 4;
  const [lo, hi] = span(d, seq);
  return lo + (hi - lo) * p;
};
// the band of the clip the line moves in, under the clip's name
const band = (h) => { const bottom = h - 4; return { top: Math.min(LABEL_H, bottom - 6), bottom }; };
const yOf = (pos, h) => { const b = band(h); return b.bottom - pos * (b.bottom - b.top); };
const posAtY = (y, h) => { const b = band(h); return (b.bottom - y) / (b.bottom - b.top); };

export const propsFor = (clip) => (clip.type === 'audio' ? ['volume'] : VISUAL);
export const propLabel = (prop) => PROPS[prop].label;
export function shownProp(tab, clip) {
  const p = tab.ui.get().lineProp?.[clip.id];
  return p && propsFor(clip).includes(p) ? p : propsFor(clip)[0];
}
export const showProp = (tab, clip, prop) => tab.ui.set({ lineProp: { ...tab.ui.get().lineProp, [clip.id]: prop } });

// The line as [time, value] points: straight where it is straight on screen, sampled where it curves.
function linePoints(clip, prop, pps) {
  const list = clip.keyframes?.[prop] || [];
  const base = staticValue(clip, prop);
  const at = (t) => evalKeyframes(list, t, base);
  const stops = [0, ...list.map((k) => k.t).filter((t) => t > 0 && t < clip.duration), clip.duration];
  const pts = [[0, at(0)]];
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1], stops[i]];
    const n = list.findIndex((k) => k.t >= b - 1e-9);
    const [ka, kb] = n > 0 ? [list[n - 1], list[n]] : [null, null];
    if (ka?.ease === 'hold') pts.push([b, ka.v]);
    else if (ka && (prop === 'volume' || isBezierSeg(ka, kb) || (ka.ease && ka.ease !== 'linear'))) {
      const steps = Math.ceil(clamp(((b - a) * pps) / 4, 2, 64));
      for (let s = 1; s < steps; s++) { const t = a + ((b - a) * s) / steps; pts.push([t, at(t)]); }
    }
    pts.push([b, at(b)]);
  }
  return pts;
}

export function ClipLine({ clip, prop, seq, w, h, pps, live, selected }) {
  const list = (clip.keyframes?.[prop] || []);
  const px = ([t, v]) => `${(t * pps).toFixed(2)} ${yOf(posOf(prop, v, seq), h).toFixed(2)}`;
  const d = `M${linePoints(clip, prop, pps).map(px).join('L')}`;
  const on = (k) => selected?.some((t) => Math.abs(t - k.t) < 1e-3);
  const handles = [];
  list.forEach((k, i) => {
    if (!on(k)) return;
    const seg = (a, b) => (b.t > a.t ? b.t - a.t : 1e-6);
    if (k.out && list[i + 1]) { const io = k.out.influence * seg(k, list[i + 1]); handles.push({ i, side: 'out', t: k.t + io, v: k.v + k.out.speed * io, k }); }
    if (k.in && list[i - 1]) { const io = k.in.influence * seg(list[i - 1], k); handles.push({ i, side: 'in', t: k.t - io, v: k.v - k.in.speed * io, k }); }
  });
  return html`<svg class="clip-line ${live ? 'is-live' : ''}" width=${Math.max(3, w)} height=${h}>
    <path class="line" d=${d} />
    <path class="hit" data-line="1" d=${d} />
    ${list.map((k, i) => (k.t < -1e-6 || k.t > clip.duration + 1e-6 ? null : html`<g key=${i} class=${`lk ${on(k) ? 'is-on' : ''}`} data-lk=${i} data-t=${k.t}
      transform=${`translate(${(k.t * pps).toFixed(2)} ${yOf(posOf(prop, k.v, seq), h).toFixed(2)})`}><circle r="7" /><path d="M0 -4L4 0L0 4L-4 0Z" /></g>`))}
    ${handles.map((a) => { const [hx, hy] = [a.t * pps, yOf(posOf(prop, a.v, seq), h)]; return html`<g key=${`${a.i}${a.side}`}>
      <line class="lh-arm" x1=${a.k.t * pps} y1=${yOf(posOf(prop, a.k.v, seq), h)} x2=${hx} y2=${hy} />
      <circle class="lh" data-lh=${`${a.i}:${a.side}`} cx=${hx} cy=${hy} r="3.5" /></g>`; })}
  </svg>`;
}

const tipAt = (ev, text) => ({ x: ev.clientX, y: ev.clientY, text });
const setKeys = (c, prop, list) => { c.keyframes = { ...(c.keyframes || {}), [prop]: list }; };
const onWindow = (move, up) => {
  const end = (ev) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); up(ev); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
};
// Shift keeps the drag on one axis; Ctrl/Cmd makes the value move in fine steps.
const drag = (e, ev) => {
  let [dx, dy] = [ev.clientX - e.clientX, ev.clientY - e.clientY];
  if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
  if (ev.ctrlKey || ev.metaKey) dy *= 0.2;
  return [dx, dy];
};

function dragKeys(tab, e, clip, prop, { idx, add, lockTime, label, rect, setTip, onClick }) {
  const seq = tab.seq;
  const { fps } = seq;
  const { pps } = tab.ui.get();
  const list = deepClone(clip.keyframes?.[prop] || []);
  if (add) { list.push(add); list.sort((a, b) => a.t - b.t); idx = [list.indexOf(add)]; }
  const picked = new Set(idx);
  const bandH = band(rect.height);
  let times = idx.map((i) => list[i].t);
  const apply = (dt, dp) => tab.preview((d, ds) => {
    const c = ds.clips.find((x) => x.id === clip.id);
    if (c) setKeys(c, prop, list.map((k, i) => (picked.has(i) ? { ...k, t: k.t + dt, v: dp ? valueOf(prop, posOf(prop, k.v, seq) + dp, seq) : k.v } : k)));
  });
  const select = () => tab.ui.set({ kfSel: { clipId: clip.id, times, prop } });
  tab.begin();
  if (add) apply(0, 0);
  select();
  // how far the picked keys can go before they reach a neighbour or the end of the clip
  let lo = -Infinity, hi = Infinity;
  for (const i of idx) {
    const prev = list[i - 1], next = list[i + 1];
    lo = Math.max(lo, prev && !picked.has(i - 1) ? prev.t + 1 / fps - list[i].t : -list[i].t);
    hi = Math.min(hi, next && !picked.has(i + 1) ? next.t - 1 / fps - list[i].t : clip.duration - list[i].t);
  }
  const lead = list[idx[0]];
  let moved = !!add;
  onWindow((ev) => {
    const [dx, dy] = drag(e, ev);
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    let t = lockTime ? lead.t : lead.t + dx / pps;
    if (!lockTime) {
      t = snapTime(t, fps);
      const local = tab.time.get().t - clip.start;
      if (tab.ui.get().snap && Math.abs(t - local) * pps < 6) t = local;
    }
    const dt = clamp(t - lead.t, lo, hi);
    const dp = dy / -(bandH.bottom - bandH.top);
    apply(dt, dp);
    times = idx.map((i) => list[i].t + dt);
    setTip(tipAt(ev, `${PROPS[prop].text(valueOf(prop, posOf(prop, lead.v, seq) + dp, seq))}`));
  }, () => {
    setTip(null);
    if (moved) { tab.end(label); select(); } else { tab.end(''); onClick?.(); }
  });
}

function dragStatic(tab, e, clip, prop, { rect, setTip }) {
  const seq = tab.seq;
  const v0 = staticValue(clip, prop);
  const b = band(rect.height);
  let moved = false;
  onWindow((ev) => {
    const [dx, dy] = drag(e, ev);
    if (!moved && Math.abs(dy) < 3 && Math.abs(dx) < 3) return;
    if (!moved) { moved = true; tab.begin(); }
    const v = valueOf(prop, posOf(prop, v0, seq) + dy / -(b.bottom - b.top), seq);
    tab.preview((d, ds) => { const c = ds.clips.find((x) => x.id === clip.id); if (c) setPropAt(c, prop, v, 0, seq.fps); });
    setTip(tipAt(ev, PROPS[prop].text(v)));
  }, () => { setTip(null); if (moved) tab.end(PROPS[prop].label); });
}

function dragHandle(tab, e, clip, prop, i, side, { rect, setTip }) {
  const seq = tab.seq;
  const { pps } = tab.ui.get();
  const list = deepClone(clip.keyframes[prop]);
  const k = list[i];
  const other = list[side === 'out' ? i + 1 : i - 1];
  const dur = Math.abs(other.t - k.t);
  let moved = false;
  onWindow((ev) => {
    moved = true;
    const t = (ev.clientX - rect.left) / pps;
    const v = valueOf(prop, posAtY(ev.clientY - rect.top, rect.height), seq);
    const io = clamp(side === 'out' ? t - k.t : k.t - t, 0.002 * dur, dur);
    const handle = { speed: (side === 'out' ? v - k.v : k.v - v) / io, influence: io / dur };
    tab.begin();
    tab.preview((d, ds) => {
      const c = ds.clips.find((x) => x.id === clip.id);
      if (c) setKeys(c, prop, list.map((x, n) => (n === i ? { ...x, [side]: handle } : x)));
    });
    setTip(tipAt(ev, PROPS[prop].text(v)));
  }, () => { setTip(null); if (moved) tab.end('Keyframe curve'); });
}

function toggleCurve(tab, clip, prop, t) {
  const { fps } = tab.seq;
  tab.apply('Keyframe curve', (d, ds) => {
    const c = ds.clips.find((x) => x.id === clip.id);
    const k = c?.keyframes?.[prop]?.find((x) => Math.abs(x.t - t) < 1e-3);
    if (!k) return false;
    setKeyframeInterp(c, keysAtTimes(c, [t], fps).filter((x) => x.prop === prop), k.in || k.out ? 'linear' : 'easy', fps);
    return undefined;
  });
  tab.ui.set({ kfSel: { clipId: clip.id, times: [t], prop } });
}

// A press with the Selection or Pen tool. Returns true when the line took it, 'marquee' for the Pen on the clip's body.
export function lineDown(tab, e, clip, { setTip, locked, selectClip }) {
  const pen = tab.ui.get().tool === 'pen';
  const fine = e.ctrlKey || e.metaKey;
  const kfEl = e.target.closest('[data-lk]');
  const hEl = e.target.closest('[data-lh]');
  const lineEl = e.target.closest('[data-line]');
  if (!pen && !kfEl && !hEl && !lineEl) return false;
  if (!tab.ui.get().selection.includes(clip.id)) selectClip();
  if (locked) return true;
  const prop = shownProp(tab, clip);
  const seq = tab.seq;
  const rect = e.target.closest('[data-clip]').getBoundingClientRect();
  const list = clip.keyframes?.[prop] || [];
  const ctx = { rect, setTip };
  if (hEl) {
    const [i, side] = hEl.dataset.lh.split(':');
    dragHandle(tab, e, clip, prop, Number(i), side, ctx);
    return true;
  }
  if (kfEl) {
    const i = Number(kfEl.dataset.lk);
    const { t } = list[i];
    if (fine) { toggleCurve(tab, clip, prop, t); return true; }
    const sel = tab.ui.get().kfSel;
    const prev = sel?.clipId === clip.id && sel.prop === prop ? sel.times : [];
    const has = prev.some((x) => Math.abs(x - t) < 1e-3);
    // Shift adds to the selection; a Shift+click without a drag on a selected keyframe takes it out again
    const times = e.shiftKey ? (has ? prev : [...prev, t]) : has ? prev : [t];
    const onClick = e.shiftKey && has ? () => { const rest = prev.filter((x) => Math.abs(x - t) >= 1e-3); tab.ui.set({ kfSel: rest.length ? { clipId: clip.id, times: rest, prop } : null }); } : null;
    tab.ui.set({ kfSel: { clipId: clip.id, times, prop } });
    const idx = list.map((k, n) => (times.some((x) => Math.abs(x - k.t) < 1e-3) ? n : -1)).filter((n) => n >= 0);
    dragKeys(tab, e, clip, prop, { idx, onClick, label: idx.length > 1 ? 'Move keyframes' : 'Move keyframe', ...ctx });
    return true;
  }
  if (!lineEl) return 'marquee';
  const t = clamp(snapTime((e.clientX - rect.left) / tab.ui.get().pps, seq.fps), 0, clip.duration);
  if (pen || fine) {
    const v = evalKeyframes(list, t, staticValue(clip, prop));
    dragKeys(tab, e, clip, prop, { add: { t, v, ease: 'linear' }, label: 'Add keyframe', ...ctx });
    return true;
  }
  if (!list.length) { dragStatic(tab, e, clip, prop, ctx); return true; }
  // the segment under the cursor; past either end, the keyframe at that end
  const after = list.findIndex((k) => k.t > t);
  const idx = after < 0 ? [list.length - 1] : after === 0 ? [0] : [after - 1, after];
  dragKeys(tab, e, clip, prop, { idx, lockTime: true, label: 'Move line', ...ctx });
  return true;
}
