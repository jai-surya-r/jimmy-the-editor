// The scheduler's formula (server/scheduler.js), on its own: `node tests/scheduler.mjs`.
import assert from 'node:assert/strict';
import { allocate, MaxHeap } from '../server/scheduler.js';

const now = 1_000_000_000;
const idle = { lastInput: now - 60000 };
const editing = { lastInput: now - 2000 };
const calm = { level: 0 };
const run = (o) => allocate({ slots: 6, user: idle, pressure: calm, ...o }, now);

// the heap gives the best first
const h = new MaxHeap([{ score: 3 }, { score: 9 }, { score: 1 }, { score: 7 }, { score: 5 }]);
assert.deepEqual([h.pop(), h.pop(), h.pop(), h.pop(), h.pop()].map((x) => x.score), [9, 7, 5, 3, 1]);

// your order when everything waits: graphics, exports, preview files; pre-rendering held while they render
let a = run({ demand: { motion: { want: 8 }, export: { want: 4 }, media: { want: 4 }, prerender: { want: 4 } } });
assert.deepEqual(a.order, ['motion', 'export', 'media', 'prerender']);
assert.equal(a.shares.prerender, 0, 'pre-rendering waits while exports or graphics render');
assert.ok(a.shares.motion >= a.shares.export && a.shares.export >= 1, JSON.stringify(a));

// alone, pre-rendering gets the machine; with an export waiting it gets nothing
assert.equal(run({ demand: { prerender: { want: 4 } } }).shares.prerender, 4);
assert.equal(run({ demand: { prerender: { want: 4 }, export: { want: 2 } } }).shares.prerender, 0);

// a preview file the viewer needs outranks an export
a = run({ demand: { export: { want: 4 }, media: { want: 2, needed: true } } });
assert.equal(a.order[0], 'media');

// preview files get the spare slots when nothing renders
assert.equal(run({ demand: { media: { want: 6 } } }).shares.media, 6);

// a long wait lifts a low score (ageing), up to 3×
a = run({ demand: { media: { want: 2, waitingSince: now - 15 * 60000 }, export: { want: 2 } } });
assert.equal(a.order[0], 'media', JSON.stringify(a.scores));

// the person at the keyboard: editing and playing leave less, never nothing
const busy = { motion: { want: 8 }, export: { want: 4 } };
const hIdle = run({ demand: busy }).headroom;
const hEdit = allocate({ slots: 6, user: editing, pressure: calm, demand: busy }, now).headroom;
const hPlay = allocate({ slots: 6, user: { playing: true }, pressure: calm, demand: busy }, now).headroom;
assert.ok(hIdle > hEdit && hEdit > hPlay && hPlay >= 1, `${hIdle} ${hEdit} ${hPlay}`);
// memory pressure squeezes it further; something still runs
a = allocate({ slots: 6, user: { playing: true }, pressure: { level: 2 }, demand: busy }, now);
assert.ok(a.shares.motion + a.shares.export >= 1, JSON.stringify(a));

// a small machine (2 slots) still gives the top kind its share
a = allocate({ slots: 2, user: editing, pressure: calm, demand: { motion: { want: 4 }, export: { want: 2 }, media: { want: 2 } } }, now);
assert.ok(a.shares.motion >= 1, JSON.stringify(a));
// Claude comes right after you: a working chat leaves less for the background (Step 81)
const withClaude = allocate({ slots: 6, user: editing, pressure: calm, demand: busy, claude: 1 }, now);
assert.ok(withClaude.headroom < hEdit && withClaude.claude, `${withClaude.headroom} < ${hEdit}`);
assert.ok(allocate({ slots: 6, user: idle, pressure: calm, demand: busy, claude: 2 }, now).headroom < hIdle);
// playing or scrubbing: graphics wait (exports keep going); one asked for "now" doesn't
a = allocate({ slots: 6, user: { playing: true }, pressure: calm, demand: busy, claude: 1 }, now);
assert.equal(a.shares.motion, 0, JSON.stringify(a));
assert.deepEqual(a.held, ['motion']);
assert.ok(a.shares.export >= 1, JSON.stringify(a));
a = allocate({ slots: 6, user: { scrubbing: true }, pressure: calm, demand: { motion: { want: 8 } } }, now);
assert.equal(a.shares.motion, 0, 'nothing else waiting: still held');
a = allocate({ slots: 6, user: { playing: true }, pressure: calm, demand: { motion: { want: 8, rush: true } } }, now);
assert.ok(a.shares.motion >= 1 && !a.held.length, 'a graphic asked for "now" renders while playing');
// editing: graphics render as before (fewer pages while Claude works)
a = allocate({ slots: 6, user: editing, pressure: calm, demand: { motion: { want: 8 } }, claude: 1 }, now);
const b = allocate({ slots: 6, user: editing, pressure: calm, demand: { motion: { want: 8 } } }, now);
assert.ok(a.shares.motion >= 1 && a.shares.motion < b.shares.motion, `${a.shares.motion} < ${b.shares.motion}`);
console.log('scheduler: ok');
