#!/usr/bin/env node
// Sums up a performance recorder log (server/perflog.js): where Jimmy froze, what code held it, what was running.
//   node bin/perf-report.mjs [file.jsonl | data folder] [--from HH:MM] [--to HH:MM]
// Without a file: the newest log of the desktop app's data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const from = opt('--from'), to = opt('--to');
let target = args[0];
if (!target) {
  const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');
  target = path.join(base, 'Jimmy - The Editor');
}
if (fs.statSync(target).isDirectory()) {
  const dir = fs.existsSync(path.join(target, 'logs')) ? path.join(target, 'logs') : target;
  const logs = fs.readdirSync(dir).filter((n) => /^perf-.*\.jsonl$/.test(n)).sort();
  if (!logs.length) { console.error(`no perf-*.jsonl in ${dir}`); process.exit(1); }
  target = path.join(dir, logs.at(-1));
}

const hhmm = (t) => new Date(t).toTimeString().slice(0, 8);
const inRange = (t) => {
  const s = hhmm(t).slice(0, 5);
  return (!from || s >= from) && (!to || s <= to);
};
const rows = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && (r.type === 'start' || inRange(r.t)));
const of = (type) => rows.filter((r) => r.type === type);
// the recorder's own profiler read-outs (marked own; older logs: rollWindow on top) aren't Jimmy's freezes
const ownStalls = of('stall').filter((s) => s.own || /^rollWindow /.test(s.inner?.[0] || ''));
const stalls = of('stall').filter((s) => !ownStalls.includes(s)), samples = of('sample'), events = of('event'), ui = of('ui');
const sampleAt = (t) => samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs((best?.t ?? Infinity) - t) ? s : best), null);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const first = rows.find((r) => r.t)?.t, last = [...rows].reverse().find((r) => r.t)?.t;

console.log(`${target}\n${first ? `${hhmm(first)} – ${hhmm(last)}` : 'empty'}  (${((last - first) / 60000 || 0).toFixed(1)} min)`);
const start = of('start').at(-1);
if (start) console.log(`${start.cpuModel} · ${start.cpus} threads · ${(start.ram / 2 ** 30).toFixed(0)} GB · ${start.platform}${start.electron ? ` · Electron ${start.electron}` : ''}`);

// ------------------------------------------------------------ freezes
const frozen = sum(stalls.map((s) => s.ms));
console.log(`\n== Freezes of the app's main thread (≥50 ms): ${stalls.length}, ${(frozen / 1000).toFixed(1)} s in all${ownStalls.length ? `  (left out: ${ownStalls.length} of the recorder's own, ${(sum(ownStalls.map((s) => s.ms)) / 1000).toFixed(1)} s)` : ''}`);
for (const [lo, hi] of [[50, 200], [200, 1000], [1000, 5000], [5000, Infinity]]) {
  const n = stalls.filter((s) => s.ms >= lo && s.ms < hi);
  if (n.length) console.log(`  ${String(lo).padStart(5)}–${hi === Infinity ? '   ' : String(hi).padEnd(5)} ms: ${String(n.length).padStart(5)}  (${(sum(n.map((s) => s.ms)) / 1000).toFixed(1)} s)`);
}
const blame = new Map();
for (const s of stalls) {
  const total = s.samples || 0;
  for (const e of s.inner || []) {
    const m = /^(.*) ×(\d+)$/.exec(e);
    if (m && total) blame.set(m[1], (blame.get(m[1]) || 0) + (s.ms * Number(m[2])) / total);
  }
}
console.log('\n  Where the frozen time went (the app function nearest the top of the stack, ms shared by samples):');
for (const [f, ms] of [...blame].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${(ms / 1000).toFixed(1).padStart(7)} s  ${f}`);

console.log('\n  Longest freezes:');
for (const s of [...stalls].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
  const a = sampleAt(s.t)?.act || {};
  console.log(`  ${hhmm(s.t)} ${String(s.ms).padStart(6)} ms  [${actLine(a)}]`);
  if (s.inner?.length) console.log(`             inner: ${s.inner.slice(0, 4).join(' · ')}`);
  if (s.leaf?.length) console.log(`             top:   ${s.leaf.slice(0, 3).join(' · ')}`);
}

// ------------------------------------------------------------ per minute
console.log('\n== Per minute: frozen s · slowest freeze · machine CPU % · main thread cores · free GB · what ran');
const minutes = new Map();
for (const r of [...stalls, ...samples]) {
  const k = hhmm(r.t).slice(0, 5);
  const m = minutes.get(k) || { frozen: 0, worst: 0, cpu: [], main: [], free: [], act: null };
  if (r.type === 'stall') { m.frozen += r.ms; m.worst = Math.max(m.worst, r.ms); } else { m.cpu.push(r.cpuAll); m.main.push(r.cpuMain); m.free.push(r.freeMB); m.act = r.act; }
  minutes.set(k, m);
}
const avg = (a) => (a.length ? sum(a) / a.length : NaN);
for (const [k, m] of [...minutes].sort()) {
  console.log(`  ${k}  ${(m.frozen / 1000).toFixed(1).padStart(5)} s ${String(m.worst).padStart(6)} ms  cpu ${String(Math.round(avg(m.cpu))).padStart(3)}%  main ${avg(m.main).toFixed(2)}  free ${(avg(m.free) / 1024).toFixed(1)}  ${m.act ? actLine(m.act) : ''}`);
}

// ------------------------------------------------------------ disk
// samples' io: MB/s; the machine's (r, w local disks; nasR, nasW network shares; rw on macOS) and the app's own
const ioSamples = samples.filter((s) => s.io && Object.keys(s.io).length);
if (ioSamples.length) {
  const secs = 5;
  const keys = [...new Set(ioSamples.flatMap((s) => Object.keys(s.io)))];
  const label = { r: 'disk read', w: 'disk written', rw: 'disk read+written', nasR: 'network share read', nasW: 'network share written', chunkW: 'pre-render/export chunks written', proxyW: 'proxies written', exportW: 'exports written', saveW: 'project/settings saves', servedR: 'files read for the editor' };
  console.log('\n== Disk traffic (GB in all · average MB/s · busiest 5 s in MB/s)');
  for (const k of keys) {
    const v = ioSamples.map((s) => s.io[k] || 0);
    console.log(`  ${(label[k] || k).padEnd(34)} ${(sum(v) * secs / 1024).toFixed(2).padStart(7)} GB  ${avg(v).toFixed(1).padStart(6)}  ${Math.max(...v).toFixed(1).padStart(7)}`);
  }
  const busy = ioSamples.filter((s) => (s.io.r || 0) + (s.io.w || 0) + (s.io.rw || 0) > 1).length;
  console.log(`  disk busier than 1 MB/s in ${Math.round((busy / ioSamples.length) * 100)}% of the time`);
}

// ------------------------------------------------------------ work
const ex =events.filter((e) => e.kind === 'export');
if (ex.length || events.some((e) => e.kind === 'exportStart')) {
  console.log('\n== Exports');
  for (const e of events.filter((x) => x.kind === 'exportStart' || x.kind === 'export')) {
    console.log(`  ${hhmm(e.t)} ${e.kind === 'exportStart' ? 'start ' : e.status.padEnd(6)} ${e.label}${e.kind === 'export' ? `  ${e.secs}s, ${e.frames} frames, ${e.reused || 0} chunks reused${e.error ? `  ${e.error}` : ''}` : `  (${e.quality}, ${e.engine})`}`);
  }
}
const chunks = events.filter((e) => e.kind === 'chunk');
if (chunks.length) {
  console.log('\n== Chunks rendered');
  const groups = new Map();
  for (const c of chunks) { const k = `${c.engine}${c.bg ? ' pre-render' : ' export'}`; (groups.get(k) || groups.set(k, []).get(k)).push(c); }
  for (const [k, list] of groups) console.log(`  ${k.padEnd(22)} ${String(list.length).padStart(4)}  avg ${avg(list.map((c) => c.secs || 0)).toFixed(1)} s, ${avg(list.map((c) => c.frames)).toFixed(0)} frames`);
}
const fb = events.filter((e) => e.kind === 'engineFallback');
if (fb.length) {
  console.log(`\n== Engine fallbacks: ${fb.length}`);
  const why = new Map();
  for (const f of fb) why.set(f.why, (why.get(f.why) || 0) + 1);
  for (const [w, n] of why) console.log(`  ${n}× ${w}`);
}
const mo = events.filter((e) => e.kind === 'motionDone');
if (mo.length) console.log(`\n== Motion graphics: ${mo.length} renders, avg ${avg(mo.map((m) => m.secs)).toFixed(0)} s, ${mo.filter((m) => m.error).length} failed`);

// ------------------------------------------------------------ the editor
if (ui.length) {
  console.log('\n== In the editor window');
  const kinds = new Map();
  for (const u of ui) (kinds.get(u.kind) || kinds.set(u.kind, []).get(u.kind)).push(u);
  for (const [k, list] of kinds) console.log(`  ${k.padEnd(10)} ${String(list.length).padStart(5)}  avg ${Math.round(avg(list.map((u) => u.ms)))} ms, worst ${Math.max(...list.map((u) => u.ms))} ms`);
  const slow = ui.filter((u) => u.kind === 'fetch');
  const byUrl = new Map();
  for (const u of slow) { const k = u.what.replace(/\/p\/[^/]+/, '/p/:id').replace(/\/(job|run|m|s)_\w+/g, '/:x'); (byUrl.get(k) || byUrl.set(k, []).get(k)).push(u.ms); }
  if (byUrl.size) console.log('  Slow requests (≥300 ms):');
  for (const [k, list] of [...byUrl].sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 12)) console.log(`    ${String(list.length).padStart(4)}×  avg ${String(Math.round(avg(list))).padStart(5)} ms  worst ${String(Math.round(Math.max(...list))).padStart(6)}  ${k}`);
  const clicks = ui.filter((u) => /click|key|pointer|mouse/.test(u.kind)).sort((a, b) => b.ms - a.ms).slice(0, 8);
  if (clicks.length) console.log('  Slowest clicks / keys:');
  for (const c of clicks) console.log(`    ${hhmm(c.t)} ${String(c.ms).padStart(6)} ms  ${c.kind} ${c.what}`);
}

function actLine(a) {
  const parts = [];
  if (a.open != null) parts.push(`${a.open} open`);
  if (a.playing) parts.push('playing');
  if (a.scrub) parts.push('scrubbing');
  if (a.exports) parts.push(`${a.exports} export${a.exports > 1 ? 's' : ''}`);
  if (a.chunks) parts.push(`${a.chunks} chunks${a.engine ? ` (${a.engine} engine)` : ''}${a.chunksPaused ? `, ${a.chunksPaused} paused` : ''}${a.chunksBg ? `, ${a.chunksBg} pre-render` : ''}`);
  if (a.queued) parts.push(`${a.queued} queued`);
  if (a.motion) parts.push(`graphic ×${a.motionPages} pages`);
  if (a.motionQueued) parts.push(`${a.motionQueued} graphics waiting`);
  if (a.media || a.mediaQueued) parts.push(`media ${a.media}+${a.mediaQueued}`);
  if (a.chats) parts.push(`${a.chats} chats`);
  if (a.level) parts.push(`budget L${a.level}`);
  return parts.join(', ');
}
