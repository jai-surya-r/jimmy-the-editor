// The work scheduler: how much of the machine each kind of background work may use right now.
//
// Nothing here starts or stops work itself: exports and pre-rendering (render.js), motion graphics (motion.js) and
// preview files (media.js) keep their own queues and ask the budget (budget.js) how many slots they may fill. The
// budget asks this file, which hands the machine out by a formula:
//
//   headroom  = full slots × you × Claude × pressure
//     you      1    nobody has touched the editor for 20 s (idle: background work may have it all)
//              0.7  editing (a click or a key in the last 20 s)
//              0.35 playing or scrubbing (the preview needs the machine)
//     Claude   0.7  a chat is working (Claude Code and the commands it runs use the machine too), 1 otherwise
//     pressure memory low 0.6, very low 0.25; Jimmy's own thread falling behind 0.7; on battery 0.5
//
//   So the order is: you, then Claude, then the background work below. While you play or scrub, motion graphics
//   wait (unless one was asked for "now"): each frame of a graphic is captured through Jimmy's own thread, which
//   also feeds the preview, and with Claude working that was what made playback and clicks stutter (Step 81).
//   A graphic that is rendering stops between two frames, keeps its pages and progress, and goes on when you stop.
//
//   score(kind) = weight × urgency × age
//     weight   your order: motion graphics 100, exports 80, preview files 60, pre-rendering 20
//     urgency  a graphic asked for "now" ×3; a preview file the viewer is waiting for ×2 (it can't show the clip
//              without it); pre-rendering the sequence on screen ×1.5
//     age      +1 for every 5 minutes the oldest item has waited, at most ×3, so low scores still get their turn
//
// The kinds with work waiting go into a max-heap by score. The best gets what it needs first (its smallest useful
// share), and so on down; what is left is shared out in proportion to score, never more than a kind can use.
// Two rules on top: pre-rendering only gets a share while no export or graphic wants one (it is only a head start
// for them), and preview files get every spare slot when nothing renders.
//
// Slot costs: one export or pre-render chunk (a page with its decoders and encoder) = 1; one page of a motion
// graphic = 0.75 (about one core); one preview-file job = 0.5.

const WEIGHT = { motion: 100, export: 80, media: 60, prerender: 20 };
const COST = { motion: 0.75, export: 1, media: 0.5, prerender: 1 };
const MIN_SHARE = { motion: 1, export: 1, media: 1, prerender: 1 }; // smallest useful share, in items
const AGE_STEP_MS = 5 * 60 * 1000;
export const IDLE_AFTER_MS = 20000;

// A max-heap of { score } (the kinds competing for the machine; a handful, but the order is the point).
export class MaxHeap {
  constructor(items = []) { this.a = []; for (const x of items) this.push(x); }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    a.push(x);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p].score >= a[i].score) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].score > a[m].score) m = l;
        if (r < a.length && a[r].score > a[m].score) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// How much the person at the keyboard leaves for background work (0..1), and why.
export function userFactor({ playing, scrubbing, lastInput }, now = Date.now()) {
  if (playing || scrubbing) return { f: 0.35, mode: playing ? 'playing' : 'scrubbing' };
  if (lastInput && now - lastInput < IDLE_AFTER_MS) return { f: 0.7, mode: 'editing' };
  return { f: 1, mode: 'idle' };
}

export function pressureFactor({ level = 0, lagging = false, battery = false }) {
  let f = level === 2 ? 0.25 : level === 1 ? 0.6 : 1;
  if (lagging) f *= 0.7;
  if (battery) f *= 0.5;
  return f;
}

// Claude working in a chat (how many chats are busy, or have commands running in the background)
export const claudeFactor = (claude) => (claude > 0 ? 0.7 : 1);

// demand: { motion: { want, waitingSince, rush }, export: { want, waitingSince }, media: { want, waitingSince, needed },
//           prerender: { want, waitingSince, focused } }   want = how many items could run at once
// claude: chats working
// returns { headroom, mode, claude, held: [kinds waiting for you], shares: { kind: items allowed }, order, scores }
export function allocate({ slots, user, pressure, demand, claude = 0 }, now = Date.now()) {
  const u = userFactor(user, now);
  const headroom = Math.max(1, slots * u.f * claudeFactor(claude) * pressureFactor(pressure));
  const scores = {};
  const heap = new MaxHeap();
  const held = [];
  for (const kind of Object.keys(WEIGHT)) {
    const d = demand[kind];
    if (!d || !(d.want > 0)) continue;
    // playing or scrubbing: graphics wait for you (one asked for "now" doesn't)
    if (kind === 'motion' && (u.mode === 'playing' || u.mode === 'scrubbing') && !d.rush) { held.push(kind); continue; }
    let urgency = 1;
    if (kind === 'motion' && d.rush) urgency = 3;
    if (kind === 'media' && d.needed) urgency = 2;
    if (kind === 'prerender' && d.focused) urgency = 1.5;
    const age = d.waitingSince ? Math.min(3, 1 + (now - d.waitingSince) / AGE_STEP_MS) : 1;
    const score = WEIGHT[kind] * urgency * age;
    scores[kind] = Math.round(score);
    heap.push({ kind, score, want: d.want });
  }
  const renders = (demand.motion?.want || 0) + (demand.export?.want || 0) > 0;
  const shares = { motion: 0, export: 0, media: 0, prerender: 0 };
  const order = [];
  let left = headroom;
  const ranked = [];
  while (heap.size) {
    const k = heap.pop();
    order.push(k.kind);
    if (k.kind === 'prerender' && renders) continue; // only a head start for exports: never beside them
    ranked.push(k);
  }
  // first pass, best first: each kind's smallest useful share, while the machine has room
  for (const k of ranked) {
    const n = Math.min(k.want, MIN_SHARE[k.kind]);
    const cost = n * COST[k.kind];
    if (cost <= left + 1e-9 || !order.some((x) => shares[x] > 0)) { shares[k.kind] = n; left -= cost; }
  }
  // second pass: the rest in proportion to score, never more than a kind can use (repeat while something is left)
  for (let round = 0; round < 4 && left > 0.25; round++) {
    const open = ranked.filter((k) => shares[k.kind] > 0 && shares[k.kind] < k.want);
    const total = open.reduce((s, k) => s + k.score, 0);
    if (!total) break;
    let used = 0;
    for (const k of open) {
      const extra = Math.min(k.want - shares[k.kind], Math.floor(((left * k.score) / total) / COST[k.kind] + 1e-9));
      shares[k.kind] += extra;
      used += extra * COST[k.kind];
    }
    if (!used) {
      // too little left to split: the best that can still use it takes it
      const k = open.find((x) => COST[x.kind] <= left + 1e-9);
      if (!k) break;
      shares[k.kind] += 1;
      used = COST[k.kind];
    }
    left -= used;
  }
  // preview files: every spare slot when nothing renders (proxies out faster), still within their own limit
  if (!renders && demand.media?.want > shares.media) shares.media = Math.min(demand.media.want, shares.media + Math.floor(Math.max(0, left) / COST.media));
  return { headroom: +headroom.toFixed(2), mode: u.mode, claude: claude > 0, held, shares, order, scores };
}
