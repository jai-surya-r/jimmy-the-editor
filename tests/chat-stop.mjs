// Stopping one shell command from the chat panel (Step 79): a running command shows a small Stop; pressing it asks
// Claude Code to stop just that command (stop_task), Claude is told and carries on, and the chat keeps going. Same
// for a command running in the background. Uses tests/lib/fake-claude.mjs in place of `claude`: no Claude is started.
//   JIMMY_APP=electron node tests/chat-stop.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT, ROOT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron' && !process.env.JIMMY_APP_EXE) { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9374;
const DIR = path.join(WORK, 'chat-stop');
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
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'Chat stop', media: [], folders: [],
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
  // a command Claude waits for
  await api('POST', `/api/p/${id}/chat/send`, { text: 'please run it fg' });
  const shown = await until(() => page.call(() => !!document.querySelector('.cc-tool.is-running .cc-tool-stop')));
  ok(shown, 'a running command shows a Stop button');
  const head = await page.call(() => document.querySelector('.cc-tool.is-running')?.textContent || '');
  ok(/Run the long job/.test(head), `…on that command's step (${head.trim().slice(0, 40)})`);
  ok(await page.call(() => !!document.querySelector('.cc-working')), 'the reply is still working (the whole-reply Stop is still there too)');
  if (shown) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, 'running.png'), Buffer.from(shot.data, 'base64'));
    await page.call(() => document.querySelector('.cc-tool.is-running .cc-tool-stop').click());
  }
  const stop1 = await until(() => controls().find((r) => r.subtype === 'stop_task'));
  ok(stop1?.task_id === 'tfg1', `pressing it asks Claude Code to stop just that command (stop_task ${stop1?.task_id})`);
  ok(!controls().some((r) => r.subtype === 'interrupt'), '…without interrupting the reply');
  const after = await until(() => page.call(() => /carried on without it/.test(document.querySelector('.panel.claude')?.textContent || '') && !document.querySelector('.cc-tool-stop')));
  ok(after, 'Claude is told and carries on; the button is gone');
  const badge = await page.call(() => document.querySelector('.cc-tool.is-error .cc-tool-badge')?.textContent);
  ok(badge === 'stopped', `the step says it was stopped (${badge})`);
  const info1 = await api('GET', `/api/p/${id}/chat`);
  ok(info1.running && !info1.busy && !(info1.shells || []).length, 'the chat is still running and idle, nothing left to stop');

  // a command in the background
  await api('POST', `/api/p/${id}/chat/send`, { text: 'now bg please' });
  const bg = await until(() => page.call(() => !!document.querySelector('.cc-task .cc-tool-stop')));
  ok(bg, 'a background command shows a Stop button too');
  if (bg) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, 'background.png'), Buffer.from(shot.data, 'base64'));
    await page.call(() => document.querySelector('.cc-task .cc-tool-stop').click());
  }
  const stop2 = await until(() => controls().filter((r) => r.subtype === 'stop_task')[1]);
  ok(stop2?.task_id === 'tbg1', `…which stops that one (stop_task ${stop2?.task_id})`);
  ok(await until(() => page.call(() => !document.querySelector('.cc-task'))), 'and it leaves the list');
  ok((await api('GET', `/api/p/${id}/chat`)).running, 'the chat is still running');
  await api('POST', `/api/p/${id}/chat/stop`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `chat-stop: ${failed} failed` : 'chat-stop: all checks passed');
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
