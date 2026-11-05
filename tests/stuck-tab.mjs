// A tab restored for a project the server no longer knows shows an error; opening that project again has to bring it
// back, live, without closing the tab.
//   JIMMY_APP=electron node tests/stuck-tab.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9349;
const DIR = path.join(WORK, 'stuck-tab');
const CONFIG = path.join(WORK, 'app-data', 'config.json');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const doc = (name) => JSON.stringify({ format: 'claude-edit/1', name, settings: {}, folders: [], media: [], sequences: [{ id: 's1', name: 'Seq', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }, null, 2);
fs.writeFileSync(path.join(DIR, 'project.json'), doc('First'));

const env = { env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true };
let srv = await startServer(env);
let page;
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  page = await connectPage();
  await page.call((p) => { localStorage.setItem('ce.tabs', JSON.stringify([{ id: 'stuck1', projectId: p }])); localStorage.setItem('ce.activeTab', '"stuck1"'); }, id);
  await sleep(300);
  page.close();
  await srv.stop();

  // the server forgets the project, as a reset recent list does
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.recent = (cfg.recent || []).filter((r) => path.resolve(r) !== path.resolve(DIR));
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

  srv = await startServer(env);
  page = await connectPage();
  const status = () => page.call(() => { const t = window.__jimmy.activeTab(); const s = t?.store.get(); return { status: s?.status, err: s?.loadError, name: s?.doc?.name, tabs: window.__jimmy.app.get().tabs.length }; });
  for (let i = 0; i < 50; i++) { if ((await status()).status === 'error') break; await sleep(100); }
  const before = await status();
  ok(before.status === 'error' && /Unknown project/.test(before.err || ''), `the restored tab can't load (${before.err})`);

  await api('POST', '/api/projects/open', { path: DIR });
  await page.call((p) => { window.__jimmy.openProject(p); }, id);
  for (let i = 0; i < 50; i++) { if ((await status()).status === 'ready') break; await sleep(100); }
  const after = await status();
  ok(after.status === 'ready' && after.name === 'First', `opening the project again recovers it (${after.status}, ${after.name})`);
  ok(after.tabs === 1, 'in the same tab');

  fs.writeFileSync(path.join(DIR, 'project.json'), doc('Second'));
  for (let i = 0; i < 60; i++) { if ((await status()).name === 'Second') break; await sleep(100); }
  ok((await status()).name === 'Second', 'and it follows the project live');
} finally {
  page?.close();
  await srv.stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log(failed ? `stuck-tab: ${failed} failed` : 'stuck-tab: all checks passed');
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
  return { send, call, close: () => ws.close() };
}
