// Graph editor maths: Position X and Y shown as one property (After Effects style) and written back unchanged;
// one ease shape for several keyframes; ease presets.
//   node tests/graph-ease.mjs
import { evalKeyframes, speedAt } from '../public/js/core/model.js';
import { PAIRS, joinable, joinPair, splitPair, withJoined, sideShape, setSide, PRESETS, applyPreset } from '../public/js/ui/graphpos.js';

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const close = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const clone = (x) => JSON.parse(JSON.stringify(x));
const pos = PAIRS[0];
const sample = (list, n = 50, T = 2) => Array.from({ length: n + 1 }, (_, i) => evalKeyframes(list, (T * i) / n, 0));

console.log('Position as one');
// moves 300 px right and 400 px down in 2 s with an easy ease, then holds
const clip = { keyframes: {
  x: [{ t: 0, v: 0, ease: 'linear', out: { speed: 0, influence: 1 / 3 } }, { t: 1, v: 300, ease: 'linear', in: { speed: 0, influence: 1 / 3 } }, { t: 2, v: 300 }],
  y: [{ t: 0, v: 0, ease: 'linear', out: { speed: 0, influence: 1 / 3 } }, { t: 1, v: 400, ease: 'linear', in: { speed: 0, influence: 1 / 3 } }, { t: 2, v: 400 }],
  opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }],
} };
ok(joinable(clip, pos), 'X and Y with keyframes at the same times can be one Position');
const P = joinPair(clip, pos);
ok(P.length === 3 && close(P[1].v, 500) && close(P[2].v, 500), `its value is the distance along the path (0 → 500 px): ${P.map((k) => k.v).join(', ')}`);
ok(close(speedAt(P, 0.5), Math.hypot(speedAt(clip.keyframes.x, 0.5), speedAt(clip.keyframes.y, 0.5)), 1e-3), 'its speed graph is the real speed of the layer');
const back = clone(clip);
splitPair(back, pos, joinPair(back, pos));
ok(sample(back.keyframes.x).every((v, i) => close(v, sample(clip.keyframes.x)[i], 1e-6)) && sample(back.keyframes.y).every((v, i) => close(v, sample(clip.keyframes.y)[i], 1e-6)),
  'written back, X and Y move exactly as before');

console.log('One ease drives both');
const c2 = clone(clip);
withJoined(c2, [pos], (c) => { setSide(c.keyframes.position, 0, 'out', { ratio: 0, influence: 0.9 }); });
const nx = sample(c2.keyframes.x, 40, 1).map((v) => v / 300), ny = sample(c2.keyframes.y, 40, 1).map((v) => v / 400);
ok(nx.every((v, i) => close(v, ny[i], 1e-6)), 'a strong ease out on Position: X and Y have the same curve shape');
ok(!c2.keyframes.position && c2.keyframes.x[0].out.influence === 0.9 && c2.keyframes.y[0].out.influence === 0.9, 'X and Y each keep the new ease; no extra property is left behind');
const off = { keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 10 }], y: [{ t: 0, v: 0 }, { t: 0.5, v: 10 }] } };
ok(!joinable(off, pos), 'keyframes at different times: shown as two (Separate dimensions)');

console.log('Same shape for several keyframes');
const list = [{ t: 0, v: 0 }, { t: 1, v: 100 }, { t: 3, v: 0 }, { t: 4, v: 50 }];
setSide(list, 0, 'out', { ratio: 0, influence: 0.75 });
const shape = sideShape(list, 0, 'out');
setSide(list, 2, 'out', shape);
ok(close(sideShape(list, 2, 'out').influence, 0.75) && close(sideShape(list, 2, 'out').ratio, 0), 'another segment gets the same ease (influence 75%, speed 0)');
const norm = (a, b, i, n = 20) => { const t = a.t + ((b.t - a.t) * i) / n; return (evalKeyframes(list, t, 0) - a.v) / (b.v - a.v); };
ok(Array.from({ length: 21 }, (_, i) => close(norm(list[0], list[1], i), norm(list[2], list[3], i), 1e-6)).every(Boolean),
  'the two curves have the same shape although their values and lengths differ');

console.log('Presets');
const all = PRESETS.flatMap((g) => g.items);
ok(all.length >= 25 && all.every((p) => p.length === 5), `${all.length} presets, each a cubic-bezier curve`);
const pc = { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 0 }] } };
const n = applyPreset(pc, [{ prop: 'opacity', t: 0 }], all.find((p) => p[0] === 'Expo out'), 30);
ok(n === 1, 'one key selected: the preset goes on the segment after it');
ok(evalKeyframes(pc.keyframes.opacity, 0.15, 0) > 0.55, `Expo out: most of the change happens early (${evalKeyframes(pc.keyframes.opacity, 0.15, 0).toFixed(2)} at 15%)`);
const bk = { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } };
applyPreset(bk, [{ prop: 'opacity', t: 0 }], all.find((p) => p[0] === 'Back out'), 30);
ok(Math.max(...sample(bk.keyframes.opacity, 60, 1)) > 1.02, 'Back out overshoots past the end value and settles');
const two = { keyframes: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 0 }, { t: 3, v: 1 }] } };
ok(applyPreset(two, [{ prop: 'opacity', t: 0 }, { prop: 'opacity', t: 2 }], all[0], 30) === 2, 'two selected keys: the span between them (2 segments), not past the last');

console.log(failed ? `\ngraph-ease: ${failed} failed` : '\ngraph-ease: all checks passed');
process.exit(failed ? 1 : 0);
