// Graph editor helpers: Position as one property (After Effects style), the same ease on every selected
// keyframe, and ease presets.
//
// Position is stored as two keyframe lists (x and y). In the graph editor they are shown as one: a "position"
// list whose value is the distance travelled along the path, so its speed graph is the real speed of the
// layer, as in After Effects. Its eases are kept relative to each segment's average speed (speed / slope),
// which is what makes X and Y move with one shared ease: writing it back gives both the same shape.
import { segmentHandles } from '../core/model.js';

export const PAIRS = [
  { id: 'position', a: 'x', b: 'y' },
  { id: 'belowPosition', a: 'belowX', b: 'belowY' },
];
export const pairOf = (p) => PAIRS.find((x) => x.id === p) || null;

const near = (a, b, tol) => Math.abs(a - b) < tol;

// X and Y can be shown as one when both are animated with keyframes at the same times
export function joinable(clip, pair, fps = 30) {
  const A = clip.keyframes?.[pair.a], B = clip.keyframes?.[pair.b];
  if (!A?.length || !B?.length || A.length !== B.length) return false;
  return A.every((k, i) => near(k.t, B[i].t, 0.5 / fps));
}

// the joined list (each key remembers its x and y as _a / _b)
export function joinPair(clip, pair) {
  const A = clip.keyframes[pair.a], B = clip.keyframes[pair.b];
  const out = [];
  let d = 0;
  for (let i = 0; i < A.length; i++) {
    if (i) d += Math.hypot(A[i].v - A[i - 1].v, B[i].v - B[i - 1].v);
    out.push({ t: A[i].t, v: d, ease: A[i].ease, _a: A[i].v, _b: B[i].v });
  }
  for (let i = 0; i + 1 < A.length; i++) {
    // the ease of this segment comes from the axis that moves more (the other one follows it)
    const dx = A[i + 1].v - A[i].v, dy = B[i + 1].v - B[i].v;
    const ref = Math.abs(dx) >= Math.abs(dy) ? A : B;
    const dt = Math.max(1e-6, A[i + 1].t - A[i].t);
    const slopeRef = (ref[i + 1].v - ref[i].v) / dt, slopeD = (out[i + 1].v - out[i].v) / dt;
    const ratio = (s) => (Math.abs(slopeRef) > 1e-9 ? s / slopeRef : 0);
    out[i].ease = ref[i].ease;
    if (ref[i].out) out[i].out = { speed: ratio(ref[i].out.speed) * slopeD, influence: ref[i].out.influence };
    if (ref[i + 1].in) out[i + 1].in = { speed: ratio(ref[i + 1].in.speed) * slopeD, influence: ref[i + 1].in.influence };
  }
  return out;
}

// write a joined list back to its two properties (same times, same ease relative to each axis' movement)
export function splitPair(clip, pair, list) {
  const mk = (key) => list.map((k) => ({ t: k.t, v: k[key], ease: k.ease }));
  const A = mk('_a'), B = mk('_b');
  for (let i = 0; i + 1 < list.length; i++) {
    const dt = Math.max(1e-6, list[i + 1].t - list[i].t);
    const slopeD = (list[i + 1].v - list[i].v) / dt;
    for (const [L, key] of [[A, '_a'], [B, '_b']]) {
      const slope = (list[i + 1][key] - list[i][key]) / dt;
      const conv = (h) => ({ speed: Math.abs(slopeD) > 1e-9 ? (h.speed / slopeD) * slope : 0, influence: h.influence });
      if (list[i].out) L[i].out = conv(list[i].out);
      if (list[i + 1].in) L[i + 1].in = conv(list[i + 1].in);
    }
  }
  clip.keyframes[pair.a] = A;
  clip.keyframes[pair.b] = B;
}

// Run fn on a clip with its joined pairs in place of their two lists, then write them back.
export function withJoined(clip, joined, fn) {
  const used = joined.filter((pair) => joinable(clip, pair));
  for (const pair of used) clip.keyframes[pair.id] = joinPair(clip, pair);
  try { return fn(clip); } finally {
    for (const pair of used) {
      const list = clip.keyframes[pair.id];
      delete clip.keyframes[pair.id];
      if (list?.length) splitPair(clip, pair, list);
    }
  }
}

// ---------------------------------------------------------------- one ease for many
// The shape of one side of a segment, relative to the segment's average speed: { ratio, influence }.
export function sideShape(list, i, side) {
  const a = side === 'out' ? list[i] : list[i - 1], b = side === 'out' ? list[i + 1] : list[i];
  if (!a || !b) return null;
  const h = segmentHandles(a, b);
  const slope = (b.v - a.v) / h.dt;
  const s = side === 'out' ? h.out : h.in;
  return { ratio: Math.abs(slope) > 1e-9 ? s.speed / slope : 0, influence: s.influence };
}
// Give one side of key i that shape.
export function setSide(list, i, side, shape) {
  const a = side === 'out' ? list[i] : list[i - 1], b = side === 'out' ? list[i + 1] : list[i];
  if (!a || !b || a.ease === 'hold') return;
  const h = segmentHandles(a, b);
  // keep the other side as it looks now
  a.out = { ...h.out }; b.in = { ...h.in };
  if (a.ease !== 'hold') a.ease = 'linear';
  const slope = (b.v - a.v) / h.dt;
  const v = { speed: shape.ratio * slope, influence: Math.min(1, Math.max(0.01, shape.influence)) };
  if (side === 'out') a.out = v; else b.in = v;
}

// ---------------------------------------------------------------- presets
// Curves as CSS cubic-bezier(x1, y1, x2, y2), from slow-fast-slow to overshoots. These are the standard
// easing curves (Sine, Quad, Cubic, …) that motion presets are built on.
export const PRESETS = [
  { group: 'In-out', items: [
    ['Sine', 0.37, 0, 0.63, 1], ['Quad', 0.45, 0, 0.55, 1], ['Cubic', 0.65, 0, 0.35, 1], ['Quart', 0.76, 0, 0.24, 1],
    ['Quint', 0.83, 0, 0.17, 1], ['Expo', 0.87, 0, 0.13, 1], ['Circ', 0.85, 0, 0.15, 1], ['Back', 0.68, -0.6, 0.32, 1.6],
  ] },
  { group: 'Out (fast start)', items: [
    ['Sine out', 0.61, 1, 0.88, 1], ['Quad out', 0.5, 1, 0.89, 1], ['Cubic out', 0.33, 1, 0.68, 1], ['Quart out', 0.25, 1, 0.5, 1],
    ['Quint out', 0.22, 1, 0.36, 1], ['Expo out', 0.16, 1, 0.3, 1], ['Circ out', 0, 0.55, 0.45, 1], ['Back out', 0.34, 1.56, 0.64, 1],
  ] },
  { group: 'In (slow start)', items: [
    ['Sine in', 0.12, 0, 0.39, 0], ['Quad in', 0.11, 0, 0.5, 0], ['Cubic in', 0.32, 0, 0.67, 0], ['Quart in', 0.5, 0, 0.75, 0],
    ['Quint in', 0.64, 0, 0.78, 0], ['Expo in', 0.7, 0, 0.84, 0], ['Circ in', 0.55, 0, 1, 0.45], ['Back in', 0.36, 0, 0.66, -0.56],
  ] },
  { group: 'Motion design', items: [
    ['Smooth', 0.4, 0, 0.2, 1], ['Snappy', 0.2, 0.9, 0.1, 1], ['Swift out', 0.55, 0, 0.1, 1], ['Gentle', 0.25, 0.1, 0.25, 1],
    ['Anticipate', 0.5, -0.4, 0.4, 1], ['Overshoot', 0.3, 0, 0.2, 1.3],
  ] },
];

// a preset as the two sides of a segment, relative to its average speed
export function presetShape([, x1, y1, x2, y2]) {
  const i1 = Math.min(1, Math.max(0.01, x1)), i2 = Math.min(1, Math.max(0.01, 1 - x2));
  return { out: { ratio: x1 > 1e-6 ? y1 / x1 : 0, influence: i1 }, in: { ratio: 1 - x2 > 1e-6 ? (1 - y2) / (1 - x2) : 0, influence: i2 } };
}

// the segments a preset applies to: the one after a single selected key, or every segment from the first
// selected key of a property to its last
export function presetSegments(clip, sel, fps = 30) {
  const segs = [];
  const by = {};
  for (const s of sel) (by[s.prop] || (by[s.prop] = [])).push(s.t);
  for (const [p, ts] of Object.entries(by)) {
    const list = clip.keyframes?.[p];
    if (!list) continue;
    const idx = ts.map((t) => list.findIndex((k) => near(k.t, t, 0.5 / fps))).filter((i) => i >= 0).sort((a, b) => a - b);
    if (!idx.length) continue;
    const from = idx[0], to = idx.length > 1 ? idx[idx.length - 1] : idx[0] + 1;
    for (let i = from; i < to; i++) if (list[i + 1] && list[i].ease !== 'hold') segs.push({ prop: p, i });
  }
  return segs;
}
export function applyPreset(clip, sel, preset, fps = 30) {
  const sh = presetShape(preset);
  const segs = presetSegments(clip, sel, fps);
  for (const { prop, i } of segs) {
    const list = clip.keyframes[prop];
    setSide(list, i, 'out', sh.out);
    setSide(list, i + 1, 'in', sh.in);
  }
  return segs.length;
}
