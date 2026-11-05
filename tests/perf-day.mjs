// Replays an editing day on real projects in the desktop app (port 4455, its own data folder) and measures how the
// app answers while the background work piles up: 5 projects open in tabs, pre-rendering on, edits
// every few seconds, then draft exports while editing goes on.
//   JIMMY_APP=electron node tests/perf-day.mjs "<folder of test copies of real projects>" [--minutes 30] [--exports 2] [--keep-cache] [--light on|off]
// Writes tests/.work/perf-day/result.json; the app's own recorder log is in tests/.work/app-data/logs
// (`node bin/perf-report.mjs tests/.work/app-data`). Use copies of projects: exports and edits are written to them.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const flag = (k) => { const i = args.indexOf(k); if (i >= 0) args.splice(i, 1); return i >= 0; };
const MINUTES = Number(opt('--minutes', 30));
const EXPORTS = Number(opt('--exports', 2));
const KEEP = flag('--keep-cache');
const LIGHT = opt('--light', 'on') !== 'off'; // Settings › lighter pre-rendering
const root = args[0];
if (!root || !fs.existsSync(root)) { console.error('usage: node tests/perf-day.mjs <folder of project copies>'); process.exit(1); }
if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron (the desktop app is what freezes)'); process.exit(1); }

const OUT = path.join(WORK, 'perf-day');
const DATA = path.join(WORK, 'app-data');
const CACHE = path.join(path.dirname(path.resolve(root)), 'Jimmy test cache');
const DEBUG_PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const clock = () => `${((Date.now() - t0) / 60000).toFixed(1).padStart(5)} min`;
const log = (...a) => console.log(clock(), ...a);

// a cold start like a working day: no chunks, no settings from earlier runs (the user's render settings)
fs.mkdirSync(OUT, { recursive: true });
if (!KEEP) { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(CACHE, { recursive: true, force: true }); }
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
const own = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'Jimmy - The Editor', 'config.json'), 'utf8')); } catch { return {}; } })();
const pick = (k, d) => (k in own ? own[k] : d);
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  port: PORT, projectsRoot: path.join(WORK, 'projects'), cacheDir: CACHE,
  performance: pick('performance', { usage: 70, threads: 'auto', priority: 'low', jobs: 2 }),
  prerender: { ...pick('prerender', { enabled: true, quality: 'high', maxGB: 20, pauseOnBattery: true }), on: {}, light: LIGHT },
  gpu: pick('gpu', undefined),
}, null, 2));

const server = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) } });
const result = { started: new Date(t0).toISOString(), settings: { prerender: pick('prerender')?.quality, light: LIGHT }, pings: [], edits: [], phases: [], exports: [] };
let stopping = false;
try {
  // ------------------------------------------------------------ the editor window, over DevTools
  const page = await connectPage();
  log('editor window connected');

  // ------------------------------------------------------------ the server's answer time, all along
  (async () => {
    while (!stopping) {
      const a = Date.now();
      try { await api('GET', '/api/jobs'); } catch { /* counted as slow anyway */ }
      result.pings.push([a - t0, Date.now() - a]);
      await sleep(250);
    }
  })();

  const phase = (name) => { result.phases.push([Date.now() - t0, name]); log(`== ${name}`); };
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'project.json'))).map((d) => path.join(root, d.name)).slice(0, 5);
  phase(`opening ${dirs.length} projects`);
  const ids = [];
  for (const d of dirs) {
    const { id } = await api('POST', '/api/projects/open', { path: d });
    ids.push(id);
    const doc = (await api('GET', `/api/p/${id}`)).doc;
    for (const s of doc.sequences) await api('POST', `/api/p/${id}/prerender`, { sequenceId: s.id, on: true });
    await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
    log(`  opened ${path.basename(d)}`);
    await sleep(5000);
  }

  // an edit as a click makes one: nudge a title 1 px, and time it until the server has saved it
  let flip = 1;
  const edit = async () => {
    flip = -flip;
    const ms = await page.call(async (d) => {
      window.dispatchEvent(new PointerEvent('pointerdown')); // a person at the keyboard (the scheduler's "editing")
      const tab = window.__jimmy.activeTab();
      if (!tab?.doc) return null;
      const a = performance.now();
      const ok = tab.apply('perf test', (doc, seq) => {
        const texts = seq?.clips.filter((c) => c.type === 'text') || [];
        if (!texts.length) return false;
        const c = texts[Math.floor(Math.random() * texts.length)];
        c.transform = { ...(c.transform || {}), y: (c.transform?.y || 0) + d };
        return undefined;
      });
      if (!ok) return null;
      while (tab.saving || tab.savePending) await new Promise((r) => setTimeout(r, 10));
      return performance.now() - a;
    }, flip).catch((err) => (err.hung ? 30000 : null));
    if (ms === 30000) {
      result.hangs = (result.hangs || 0) + 1;
      log('  the editor window did not answer in 30 s');
      if (result.hangs <= 2) for (const s of await page.stack()) log(`    stuck in:\n      ${s}`);
    }
    if (ms != null) result.edits.push([Date.now() - t0, Math.round(ms)]);
    return ms;
  };
  let tabIdx = 0;
  const nextTab = () => page.call((pid) => { window.dispatchEvent(new PointerEvent('pointerdown')); window.__jimmy.openProject(pid); }, ids[tabIdx++ % ids.length]).catch(() => {});

  const until = (ms) => Date.now() - t0 < ms;
  const end = MINUTES * 60000;
  phase('first drafts: tabs open, background work starts (4 min)');
  for (let i = 0; i < 24 && until(end); i++) { if (i % 4 === 0) await nextTab(); await sleep(10000); }

  phase('editing: an edit every 4 s, a tab switch every 40 s (4 min)');
  const editPhase = async (ms) => {
    const stop = Date.now() + ms;
    for (let i = 0; Date.now() < stop && until(end); i++) {
      if (i % 10 === 0) await nextTab();
      const e = await edit();
      if (i % 5 === 0) log(`  edit ${e == null ? '-' : `${Math.round(e)} ms`}, server ${result.pings.at(-1)?.[1]} ms`);
      await sleep(4000);
    }
  };
  await editPhase(4 * 60000);

  phase(`draft exports of ${EXPORTS} projects while editing goes on`);
  const jobs = [];
  for (const id of ids.slice(0, EXPORTS)) {
    const doc = (await api('GET', `/api/p/${id}`)).doc;
    const { job } = await api('POST', `/api/p/${id}/render`, { sequenceId: doc.sequences[0].id, quality: 'draft', format: 'h264' });
    jobs.push(job.id);
    log(`  export ${job.label}`);
  }
  const exportsDone = async () => {
    const list = (await api('GET', '/api/jobs')).jobs || [];
    return jobs.every((j) => ['done', 'error', 'canceled'].includes(list.find((x) => x.id === j)?.status));
  };
  while (until(end) && !(await exportsDone())) {
    await editPhase(60000);
    const list = (await api('GET', '/api/jobs')).jobs || [];
    log(`  exports: ${jobs.map((j) => { const x = list.find((y) => y.id === j); return x ? `${x.status} ${Math.round((x.progress || 0) * 100)}%` : '?'; }).join(' · ')}`);
  }
  const list = (await api('GET', '/api/jobs')).jobs || [];
  result.exports = jobs.map((j) => list.find((x) => x.id === j)).map((x) => x && { label: x.label, status: x.status, secs: x.finishedAt ? Math.round((x.finishedAt - x.createdAt) / 1000) : null, progress: x.progress, error: x.error });
  phase('idle (1 min)');
  await sleep(60000);
} finally {
  stopping = true;
  await sleep(300);
  summarize();
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result));
  await server.stop();
  process.exit(0); // the DevTools socket and the ping loop would keep Node running
}

function summarize() {
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
  const bounds = [...result.phases.map((p) => p[0]), Infinity];
  console.log('\nphase                                                     server answer p50/p95/max ms   edit→saved p50/p95/max ms');
  result.phases.forEach(([at, name], i) => {
    const inPh = (a) => a.filter(([t]) => t >= at && t < bounds[i + 1]).map((x) => x[1]);
    const p = inPh(result.pings), e = inPh(result.edits);
    console.log(`${name.slice(0, 56).padEnd(57)} ${`${pct(p, 50)}/${pct(p, 95)}/${pct(p, 100)}`.padEnd(30)} ${e.length ? `${pct(e, 50)}/${pct(e, 95)}/${pct(e, 100)}` : '-'}`);
  });
  for (const x of result.exports) if (x) console.log(`export ${x.label}: ${x.status} ${x.secs ?? '-'} s ${x.error || ''}`);
}

async function connectPage() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`) && !/render\.html|motion/.test(t.url)); } catch { /* not yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the editor window did not show up on the DevTools port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const scripts = new Map();
  let onPaused = null;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Debugger.scriptParsed') scripts.set(msg.params.scriptId, msg.params.url);
    if (msg.method === 'Debugger.paused') onPaused?.(msg.params);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  // a window that doesn't answer in 30 s counts as hung (the call fails; an edit then counts 30 s)
  const call = async (fn, ...a) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true }),
      sleep(30000).then(() => { throw Object.assign(new Error('the editor window did not answer in 30 s'), { hung: true }); }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  // the debugger on from the start: a page stuck later can then still be paused to see where it is
  await send('Debugger.enable');
  // allocations sampled all along (every 1 MB on average): when the page's memory runs away, what is allocating
  await send('HeapProfiler.enable');
  await send('HeapProfiler.startSampling', { samplingInterval: 1 << 20 });
  let dumped = 0;
  (async () => {
    for (;;) {
      await sleep(3000);
      const r = await Promise.race([send('Runtime.evaluate', { expression: 'performance.memory.usedJSHeapSize', returnByValue: true }), sleep(5000).then(() => null)]);
      const used = r?.result?.value;
      if (!(used > 1.5 * 2 ** 30) || dumped >= 2) continue;
      dumped++;
      const prof = await Promise.race([send('HeapProfiler.getSamplingProfile'), sleep(20000).then(() => null)]);
      if (!prof?.profile) { console.log(`  JS heap ${Math.round(used / 2 ** 20)} MB: no allocation profile (page busy)`); continue; }
      // self size by stack (the top 4 frames), biggest first
      const totals = new Map();
      const walk = (n, stack) => {
        const f = n.callFrame;
        const here = [`${f.functionName || '(anon)'} ${(f.url || '').replace(/^https?:\/\/[^/]+/, '')}:${f.lineNumber + 1}`, ...stack].slice(0, 4);
        if (n.selfSize) totals.set(here.join(' < '), (totals.get(here.join(' < ')) || 0) + n.selfSize);
        for (const c of n.children || []) walk(c, here);
      };
      walk(prof.profile.head, []);
      fs.writeFileSync(path.join(OUT, `heap-${dumped}.json`), JSON.stringify(prof.profile));
      console.log(`  JS heap ${Math.round(used / 2 ** 20)} MB, allocated by:`);
      for (const [k, b] of [...totals].sort((a, b2) => b2[1] - a[1]).slice(0, 12)) console.log(`    ${String(Math.round(b / 2 ** 20)).padStart(6)} MB  ${k}`);
    }
  })();
  // where the page's script is now: a few samples, each its top frames
  const stack = async (samples = 5) => {
    const out = [];
    for (let i = 0; i < samples; i++) {
      const got = new Promise((r) => { onPaused = r; setTimeout(() => r(null), 10000); });
      ws.send(JSON.stringify({ id: ++seq, method: 'Debugger.pause' }));
      const p = await got;
      onPaused = null;
      if (!p) { out.push('(no pause: not in script)'); continue; }
      out.push(p.callFrames.slice(0, 12).map((f) => `${f.functionName || '(anon)'} ${(scripts.get(f.location.scriptId) || f.url || '').replace(/^https?:\/\/[^/]+/, '')}:${f.location.lineNumber + 1}`).join('\n      '));
      ws.send(JSON.stringify({ id: ++seq, method: 'Debugger.resume' }));
      await sleep(500);
    }
    return out;
  };
  return { call, stack };
}
