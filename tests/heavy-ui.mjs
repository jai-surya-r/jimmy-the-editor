// The editor with a heavy project, measured (Step 84): 119 motion graphics in one folder of 500 files (with a 7 MB
// script some of them load), 99 video clips, a main sequence of 6 nested sequences (about 500 clips), and a long
// Claude chat (the tests/lib/fake-claude.mjs stand-in: no Claude is started). While the graphics render and Claude
// "writes files" into the graphics folder, it plays, steps frames, zooms the timeline and sits idle, and measures
// how long the editor window and the app's main process are held up each time.
//   JIMMY_APP=electron node tests/heavy-ui.mjs [--profile]   (--profile: the page's busiest functions per phase)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, api, WORK, PORT, ROOT } from './lib/server.mjs';
import { FFMPEG } from '../server/ffmpeg.js';

if (process.env.JIMMY_APP !== 'electron' && !process.env.JIMMY_APP_EXE) { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const PROFILE = process.argv.includes('--profile');
const TRACE = process.argv.includes('--trace');
const HOLD = process.argv.includes('--hold') ? Number(process.argv[process.argv.indexOf('--hold') + 1]) : 0; // seconds to keep the app open, set up, before measuring // what the page's frames spend their time on while playing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(150); } };
const DEBUG_PORT = 9377;
const DIR = path.join(WORK, 'heavy-ui');
const PROJ = path.join(DIR, 'project');
fs.rmSync(DIR, { recursive: true, force: true });
const OV = path.join(PROJ, '1_Assets', '4_Overlays');
fs.mkdirSync(OV, { recursive: true });
fs.mkdirSync(path.join(PROJ, '4_Footage'), { recursive: true });

// ------------------------------------------------------------ footage: 12 short 1080p clips with sound
const footage = [];
for (let i = 0; i < 12; i++) {
  const f = path.join(PROJ, '4_Footage', `A${String(i).padStart(3, '0')}.mp4`);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=25:d=20`, '-f', 'lavfi', '-i', `sine=f=${300 + i * 40}:d=20`,
    '-vf', `hue=h=${i * 30}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-b:v', '3M', '-c:a', 'aac', '-shortest', f]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  footage.push(f);
}

// ------------------------------------------------------------ the graphics folder: 119 pages, 340 pictures, scripts
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
for (let i = 0; i < 180; i++) fs.writeFileSync(path.join(OV, `mgt_${i}.png`), png);
for (let i = 0; i < 160; i++) fs.writeFileSync(path.join(OV, `mgh_${i}.jpg`), png);
let big = 'window.MAP=[';
while (big.length < 7_000_000) big += `[${(Math.random() * 1000).toFixed(4)},${(Math.random() * 1000).toFixed(4)}],`;
fs.writeFileSync(path.join(OV, 'mg_map.js'), `${big}0];`);
fs.writeFileSync(path.join(OV, 'mg_lib.js'), 'window.LIB=1;'.repeat(5000));
const media = [];
for (let i = 0; i < 119; i++) {
  const name = `MG_${String(i).padStart(3, '0')}.html`;
  const uses = i % 4 === 0 ? '<script src="mg_map.js"></script>' : '';
  fs.writeFileSync(path.join(OV, name), `<!doctype html><html><head><script src="mg_lib.js"></script>${uses}
<script type="application/json" id="motion">{"duration": 2, "width": 1920, "height": 1080, "fps": 12}</script>
<style>body{margin:0;background:transparent} .t{position:absolute;left:100px;top:${100 + (i % 8) * 100}px;font:bold 80px sans-serif;color:#fff;
animation:m 2s linear forwards} @keyframes m{from{transform:translateX(0)}to{transform:translateX(600px)}}</style></head>
<body><div class="t">Graphic ${i}</div><img src="mgt_${i}.png" style="display:none"></body></html>`);
  media.push({ id: `m_g${i}`, name: `MG ${i}`, type: 'video', motion: { src: `1_Assets/4_Overlays/${name}`, duration: 2, width: 1920, height: 1080, fps: 12 } });
}
for (let i = 0; i < 99; i++) media.push({ id: `m_f${i}`, name: `A${i}`, path: path.relative(PROJ, footage[i % 12]).replace(/\\/g, '/') });

// ------------------------------------------------------------ sequences: 6 nested ones of 50–124 clips, one main
const tracks = [1, 2, 3, 4, 5].map((n) => ({ id: `v${n}`, kind: 'video' })).concat([{ id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio' }]);
const sequences = [];
const counts = [51, 66, 53, 123, 82, 124];
let g = 0;
for (let s = 0; s < 6; s++) {
  const clips = [];
  let t = 0;
  let n = 0;
  while (n < counts[s]) {
    const d = 2 + (n % 5);
    const f = (n * 7 + s) % 99;
    clips.push({ id: `c_${s}_${n++}`, type: 'video', media: `m_f${f}`, track: 'v1', start: t, duration: d, in: (n % 10), volume: 1, transform: { x: 0, y: 0, scale: 1 + (n % 3) * 0.05, rotation: 0, opacity: 1 },
      ...(n % 6 === 0 ? { keyframes: { scale: [{ t: 0, v: 1 }, { t: d, v: 1.2 }] } } : {}) });
    clips.push({ id: `c_${s}_${n++}`, type: 'audio', media: `m_f${f}`, track: 'a1', start: t, duration: d, in: (n % 10), volume: 1 });
    if (n % 3 === 0 && g < 119) clips.push({ id: `c_${s}_${n++}`, type: 'video', media: `m_g${g++}`, track: `v${2 + (n % 3)}`, start: t + 0.5, duration: 2, in: 0 });
    t += d;
  }
  sequences.push({ id: `s_${s}`, name: `Part ${s + 1}`, width: 1920, height: 1080, fps: 23.976, background: '#000000', tracks, clips, dur: t });
}
let at = 0;
const main = { id: 's_main', name: 'Main', width: 1920, height: 1080, fps: 23.976, background: '#000000', tracks,
  clips: sequences.map((s, i) => { const c = { id: `c_n${i}`, type: 'sequence', sequence: s.id, track: 'v1', start: at, duration: s.dur, in: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }; at += s.dur; return c; }) };
for (const s of sequences) delete s.dur;
fs.writeFileSync(path.join(PROJ, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'Heavy', settings: {}, folders: [], media, sequences: [main, ...sequences] }, null, 2));

// `claude` on the PATH is the stand-in
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const fake = path.join(ROOT, 'tests', 'lib', 'fake-claude.mjs');
fs.writeFileSync(path.join(BIN, 'claude.cmd'), `@node "${fake}" %*\r\n`);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
fs.chmodSync(path.join(BIN, 'claude'), 0o755);
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT), FAKE_CLAUDE_LOG: path.join(DIR, 'control.jsonl'), [pathKey]: `${BIN}${path.delimiter}${process.env[pathKey]}` }, visible: true });
let page;
const results = {};
try {
  const { id } = await api('POST', '/api/projects/open', { path: PROJ });
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  await until(() => page.call(() => !!window.__jimmy).catch(() => false));
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  await until(() => page.call(() => !!document.querySelector('.tl-tracks')).catch(() => false), 30000);
  // a long chat in the Claude panel
  await api('POST', `/api/p/${id}/chat/start`, { mode: 'new' });
  await until(async () => (await api('GET', `/api/p/${id}/chat`)).sessionId);
  await api('POST', `/api/p/${id}/chat/send`, { text: 'long' });
  await until(() => page.call(() => document.querySelectorAll('.panel.claude .cc-tool').length >= 150).catch(() => false), 60000);
  await until(async () => !(await api('GET', `/api/p/${id}/chat`)).busy, 30000);
  // the main sequence, and the biggest nested one, open
  await page.call(() => window.__jimmy.activeTab().setSequence('s_5'));
  await sleep(2000);
  console.log(`  ${await page.call(() => document.getElementsByTagName('*').length)} elements on the page`);
  if (HOLD) { console.log(`  holding ${HOLD} s (DevTools port ${DEBUG_PORT})`); await sleep(HOLD * 1000); }

  // Claude "at work": a file written into the graphics folder every 2 s (every write makes the app check its graphics)
  let writes = 0;
  const writer = setInterval(() => { fs.writeFileSync(path.join(OV, `claude_${writes++ % 30}.png`), png); }, 2000);

  const tasks = () => page.call(() => {
    window.__ht = { busy: 0, n: 0, worst: 0 };
    window.__hto?.disconnect();
    window.__hto = new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__ht.busy += e.duration; window.__ht.n++; window.__ht.worst = Math.max(window.__ht.worst, e.duration); } });
    window.__hto.observe({ type: 'longtask' });
  });
  const taskResult = () => page.call(() => ({ busy: Math.round(window.__ht.busy), n: window.__ht.n, worst: Math.round(window.__ht.worst) }));
  // the main process: how late a server answer comes back while this runs
  const lagProbe = () => {
    const r = { worst: 0, all: [] };
    let on = true;
    (async () => { while (on) { const t = r.since = Date.now(); await api('GET', '/api/jobs').catch(() => {}); r.since = 0; const ms = Date.now() - t; r.all.push(ms); r.worst = Math.max(r.worst, ms); await sleep(100); } })();
    return { stop: () => { on = false; if (r.since) { r.all.push(Date.now() - r.since); r.worst = Math.max(r.worst, Date.now() - r.since); } const s = [...r.all].sort((a, b) => a - b); return { worst: r.worst, p95: s[Math.floor(s.length * 0.95)] || 0 }; } };
  };
  if (PROFILE) await page.send('Profiler.enable');
  await page.send('Performance.enable');
  const taskSecs = async () => (await page.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
  const phase = async (name, fn) => {
    await tasks();
    const busy0 = await taskSecs();
    const lag = lagProbe();
    if (PROFILE) { await page.send('Profiler.setSamplingInterval', { interval: 500 }); await page.send('Profiler.start'); }
    const t0 = Date.now();
    const extra = await fn();
    const secs = (Date.now() - t0) / 1000;
    let top = '';
    if (PROFILE) {
      const { profile } = await page.send('Profiler.stop');
      const self = new Map();
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const dt = profile.timeDeltas;
      profile.samples.forEach((sid, i) => {
        const n = byId.get(sid);
        const cf = n.callFrame;
        const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
        self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000);
      });
      top = [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, ms]) => `      ${Math.round(ms)} ms  ${k}`).join('\n');
      const gc = [...self].filter(([k]) => /^\((program|garbage collector)\)/.test(k)).map(([k, ms]) => `${k.split(' ')[0]} ${Math.round(ms)} ms`).join(', ');
      top += `\n      ${gc}`;
    }
    const lt = await taskResult();
    lt.mainPct = Math.round(((await taskSecs()) - busy0) / secs * 100);
    const ml = lag.stop();
    results[name] = { secs, ...lt, serverWorst: ml.worst, serverP95: ml.p95, ...(extra || {}) };
    console.log(`  ${name}: ${secs.toFixed(1)} s · editor's main thread busy ${lt.mainPct}% · long tasks ${lt.busy} ms in ${lt.n} long tasks (worst ${lt.worst} ms) · server answers p95 ${ml.p95} ms, worst ${ml.worst} ms${extra ? ` · ${JSON.stringify(extra)}` : ''}`);
    if (top) console.log(top);
  };
  // (the app may be too busy to answer: that is a result too)
  const motionBusy = async () => {
    const t0 = Date.now();
    try {
      const s = await (await fetch(`http://127.0.0.1:${PORT}/api/p/${id}/motion`, { signal: AbortSignal.timeout(30000) })).json();
      return `${s.items.filter((x) => x.status?.state !== 'ready').length} (answered in ${Date.now() - t0} ms)`;
    } catch { return `? (no answer in ${Math.round((Date.now() - t0) / 1000)} s)`; }
  };
  console.log(`  graphics not rendered yet: ${await motionBusy()}`);

  await phase('idle', () => sleep(8000));
  await phase('play', async () => {
    await page.call(() => window.__jimmy.activeTab().engine.play());
    const t0 = await page.call(() => {
      // count the pictures drawn and the screen's frames (a window the system holds back draws nothing)
      const eng = window.__jimmy.activeTab().engine;
      window.__draws = 0; window.__frames = 0;
      if (eng.drawn) { const d = eng.drawn.bind(eng); eng.drawn = () => { window.__draws++; d(); }; } // (versions before Step 84 have no count)
      const f = () => { window.__frames++; if (window.__frames < 1e6 && !window.__stopFrames) requestAnimationFrame(f); };
      window.__stopFrames = false; requestAnimationFrame(f);
      return window.__jimmy.activeTab().time.get().t;
    });
    if (TRACE) { await sleep(3000); console.log(await trace(page, 4000)); await sleep(3000); } else await sleep(10000);
    const t1 = await page.call(() => window.__jimmy.activeTab().time.get().t);
    await page.call(() => window.__jimmy.activeTab().engine.pause());
    const c = await page.call(() => { window.__stopFrames = true; return { draws: window.__draws, frames: window.__frames }; });
    return { played: Math.round((t1 - t0) * 10) / 10, ...c };
  });
  await phase('step frames', async () => {
    for (let i = 0; i < 30; i++) { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await sleep(120); }
  });
  await phase('zoom timeline', async () => {
    const box = await page.call(() => { const r = document.querySelector('.tl-lane').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; });
    for (let i = 0; i < 25; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -167, modifiers: 1 }); await sleep(60); }
    await sleep(500);
  });
  await phase('idle after zoom', () => sleep(8000));
  await phase('chat streams while playing', async () => {
    await page.call(() => window.__jimmy.activeTab().engine.play());
    await api('POST', `/api/p/${id}/chat/send`, { text: 'stream' });
    await until(() => page.call(() => /word299/.test(document.querySelector('.panel.claude')?.textContent || '')), 30000);
    await page.call(() => window.__jimmy.activeTab().engine.pause());
  });
  clearInterval(writer);
  console.log(`  graphics not rendered yet: ${await motionBusy()} · ${await page.call(() => document.getElementsByTagName('*').length)} elements`);
  fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify(results, null, 2));

  ok(results.idle.mainPct < 25 && results['idle after zoom'].mainPct < 25, `idle, the editor's main thread rests (${results.idle.mainPct}% / ${results['idle after zoom'].mainPct}% busy)`);
  ok(results.play.mainPct < 60, `playing, it has room to spare (${results.play.mainPct}% busy)`);
  ok(results.idle.busy < 1500 && results['idle after zoom'].busy < 1500, `idle, the editor is free (${results.idle.busy} / ${results['idle after zoom'].busy} ms busy in 8 s)`);
  ok(results.play.frames > 300, `the window draws while playing (${results.play.frames} screen frames in 10 s)`);
  ok(results.play.draws >= 200 && results.play.draws <= 300, `one picture per frame of the sequence (${results.play.draws} drawn for about 240 frames)`);
  ok(results.play.played >= 8, `playback keeps time while graphics render (${results.play.played} s in 10 s)`);
  ok(results.play.worst < 250, `no long hold-up while playing (worst ${results.play.worst} ms)`);
  ok(Math.max(...Object.values(results).map((r) => r.serverP95)) < 150, `the app's main process answers quickly throughout (p95 ${Object.values(results).map((r) => r.serverP95).join('/')} ms)`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `heavy-ui: ${failed} failed` : 'heavy-ui: all checks passed');
process.exit(failed ? 1 : 0);

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
  const listeners = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method) { listeners.get(msg.method)?.(msg.params); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++seq; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const call = async (fn, ...a) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await send('Page.bringToFront').catch(() => {});
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return { send, call, on: (m, fn) => listeners.set(m, fn), close: () => ws.close() };
}

// a trace of the page's main thread: time by event, and what JavaScript made the browser redo styles and layout
async function trace(page, ms) {
  const events = [];
  page.on('Tracing.dataCollected', (p) => events.push(...p.value));
  const done = new Promise((r) => page.on('Tracing.tracingComplete', r));
  await page.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking', 'blink', 'cc'] } });
  await sleep(ms);
  await page.send('Tracing.end');
  await done;
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && events.some((x) => x.pid === e.pid && x.name === 'FunctionCall'));
  const mine = events.filter((e) => main && e.pid === main.pid && e.tid === main.tid);
  const by = new Map();
  for (const e of mine) if (e.ph === 'X' && e.dur) { const k = e.name; const a = by.get(k) || { ms: 0, n: 0 }; a.ms += e.dur / 1000; a.n++; by.set(k, a); }
  const lines = [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, 18).map(([k, a]) => `      ${Math.round(a.ms)} ms  ${k} ×${a.n}`);
  const counts = (name, f) => { const v = mine.filter((e) => e.name === name).map(f).filter((x) => x != null); return v.length ? `${name}: avg ${Math.round(v.reduce((s, x) => s + x, 0) / v.length)}, max ${Math.max(...v)} (${v.length})` : ''; };
  lines.push('      ' + counts('UpdateLayoutTree', (e) => e.args?.elementCount));
  lines.push('      ' + counts('Layout', (e) => e.args?.beginData?.dirtyObjects) + ' dirty of ' + (mine.find((e) => e.name === 'Layout' && e.args?.beginData)?.args.beginData.totalObjects || '?'));
  const cause = new Map();
  for (const e of mine) {
    if (!/^(ScheduleStyleRecalculation|InvalidateLayout|StyleRecalcInvalidationTracking|LayoutInvalidationTracking|StyleInvalidatorInvalidationTracking)$/.test(e.name)) continue;
    const st = e.args?.data?.stackTrace || e.args?.data?.stack_trace || e.args?.beginData?.stackTrace;
    const f = st?.[0];
    const k = `${e.name}: ${f ? `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber}` : (e.args?.data?.reason || '') + ' ' + (e.args?.data?.nodeName || '')}`;
    cause.set(k, (cause.get(k) || 0) + 1);
  }
  lines.push(...[...cause].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `      ×${n}  ${k}`));
  return lines.join('\n');
}
