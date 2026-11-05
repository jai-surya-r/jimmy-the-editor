// The chat panel stays quick in a long chat (Step 80): while Claude writes a reply word by word, finished messages
// aren't drawn again, so the editor is not kept busy and its memory doesn't swing. Uses tests/lib/fake-claude.mjs in
// place of `claude` (a chat of 150 replies with Markdown and command output, then 300 streamed words): no Claude is started.
//   JIMMY_APP=electron node tests/chat-speed.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT, ROOT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron' && !process.env.JIMMY_APP_EXE) { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9375;
const DIR = path.join(WORK, 'chat-speed');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// `claude` on the PATH is the stand-in
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const fake = path.join(ROOT, 'tests', 'lib', 'fake-claude.mjs');
fs.writeFileSync(path.join(BIN, 'claude.cmd'), `@node "${fake}" %*\r\n`);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
fs.chmodSync(path.join(BIN, 'claude'), 0o755);
const LOG = path.join(DIR, 'control.jsonl');
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const controls = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(150); } };

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT), FAKE_CLAUDE_LOG: LOG, [pathKey]: `${BIN}${path.delimiter}${process.env[pathKey]}` }, visible: true });
let page;
try {
  const proj = path.join(DIR, 'project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'Chat speed', media: [], folders: [],
    sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 25, background: '#000000', tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }, null, 2));
  const { id } = await api('POST', '/api/projects/open', { path: proj });

  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  await until(() => page.call(() => !!window.__jimmy).catch(() => false));
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  await until(() => page.call(() => !!document.querySelector('.panel.claude')).catch(() => false));
  ok(await page.call(() => !!document.querySelector('.panel.claude')), 'the Claude panel is open');

  await api('POST', `/api/p/${id}/chat/start`, { mode: 'new' });
  await until(async () => (await api('GET', `/api/p/${id}/chat`)).sessionId);
  await api('POST', `/api/p/${id}/chat/send`, { text: 'long' });
  const drawn = await until(() => page.call(() => document.querySelectorAll('.panel.claude .cc-tool').length >= 150), 30000);
  ok(drawn, 'a chat of 150 replies is shown');
  await until(async () => !(await api('GET', `/api/p/${id}/chat`)).busy);
  await sleep(1500);
  // measure the editor while a reply streams in
  await page.call(() => {
    window.__speed = { busy: 0, tasks: 0, heap: [] };
    window.__speedObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__speed.busy += e.duration; window.__speed.tasks++; } });
    window.__speedObs.observe({ type: 'longtask' });
    window.__speedHeap = setInterval(() => window.__speed.heap.push(performance.memory.usedJSHeapSize / 2 ** 20), 200);
  });
  const t0 = Date.now();
  await api('POST', `/api/p/${id}/chat/send`, { text: 'stream' });
  await until(() => page.call(() => /word299/.test(document.querySelector('.panel.claude')?.textContent || '')), 30000);
  const secs = (Date.now() - t0) / 1000;
  const m = await page.call(() => { clearInterval(window.__speedHeap); window.__speedObs.disconnect(); const h = window.__speed.heap; return { busy: Math.round(window.__speed.busy), tasks: window.__speed.tasks, heapMin: Math.round(Math.min(...h)), heapMax: Math.round(Math.max(...h)) }; });
  console.log(`  streaming 300 words took ${secs.toFixed(1)} s: long tasks ${m.tasks} (${m.busy} ms), page memory ${m.heapMin}–${m.heapMax} MB`);
  ok(m.busy < 1000, `the editor is not kept busy while the reply streams (${m.busy} ms of long tasks in ${secs.toFixed(1)} s)`);
  ok(m.heapMax - m.heapMin < 150, `its memory stays steady (${m.heapMin}–${m.heapMax} MB)`);
  ok(await page.call(() => document.querySelectorAll('.panel.claude .cc-tool').length >= 150 && /Step 149/.test(document.querySelector('.panel.claude').textContent)), 'the earlier messages are all still shown');
  await api('POST', `/api/p/${id}/chat/stop`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `chat-speed: ${failed} failed` : 'chat-speed: all checks passed');
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
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
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
  return { send, call, close: () => ws.close() };
}
