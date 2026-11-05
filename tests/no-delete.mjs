// Jimmy never deletes a project's files: Home only takes a project off the list (and it comes back when opened),
// removing a version from Review leaves the video where it is, and there is no delete-project route. In the desktop
// app, files dropped from Explorer are linked where they are (not copied), and the system's file dialog is there.
//   JIMMY_APP=electron node tests/no-delete.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9341;

const SRC = path.join(WORK, 'no-delete-src');
fs.rmSync(SRC, { recursive: true, force: true });
fs.mkdirSync(SRC, { recursive: true });
const { FFMPEG } = await import('../server/ffmpeg.js');
const clip = path.join(SRC, 'dropped clip.mp4');
spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-pix_fmt', 'yuv420p', clip]);

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) } });
try {
  const { id } = await api('POST', '/api/projects', { name: `No delete ${Date.now()}` });
  const dir = (await api('GET', '/api/projects')).projects.find((p) => p.id === id).dir;

  // ------------------------------------------------------------ the server
  const del = await fetch(`http://127.0.0.1:${PORT}/api/projects/${id}/delete`, { method: 'POST', body: '{}' });
  ok(del.status === 404, `there is no delete-project route (${del.status})`);
  fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
  fs.copyFileSync(clip, path.join(dir, 'renders', 'v1.mp4'));
  fs.copyFileSync(clip, path.join(dir, 'renders', 'other.mp4'));
  const { versionId } = await api('POST', `/api/p/${id}/exports/add`, { path: 'renders/v1.mp4' });
  const r = await api('POST', `/api/p/${id}/versions/delete`, { ids: [versionId], paths: ['renders/other.mp4'] });
  ok(r.removed === 1, 'the version leaves Review');
  ok(fs.existsSync(path.join(dir, 'renders', 'v1.mp4')) && fs.existsSync(path.join(dir, 'renders', 'other.mp4')), '…and no video file is deleted');

  await api('DELETE', `/api/projects/${id}`);
  ok(!(await api('GET', '/api/projects')).projects.some((p) => p.id === id), 'Remove from list takes a project in the projects folder off the list');
  ok(fs.existsSync(path.join(dir, 'project.json')), '…its folder stays');
  await api('POST', '/api/projects/open', { path: dir });
  ok((await api('GET', '/api/projects')).projects.some((p) => p.id === id), '…and opening it brings it back');

  // ------------------------------------------------------------ the editor window
  const page = await connectPage();
  ok(await page.call(() => typeof window.jimmyApp?.pick === 'function' && typeof window.jimmyApp?.pathOf === 'function'), 'the editor has the system file dialog and file paths');
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  await sleep(1500);
  const box = await page.call(() => { const r = document.querySelector('.bin-list')?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  ok(!!box, 'the bin is showing');
  const before = new Set(walk(dir));
  const data = { items: [], files: [clip], dragOperationsMask: 1 | 16 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
  let media = [];
  for (let i = 0; i < 50 && !media.length; i++) { await sleep(200); media = (await api('GET', `/api/p/${id}`)).doc.media; }
  ok(media.length === 1, `the dropped file is in the bin (${media.length})`);
  const added = walk(dir).filter((f) => !before.has(f) && /\.mp4$/i.test(f) && !/[\\/]\.(cache|claude-edit)[\\/]/.test(f));
  ok(!added.length, `nothing was copied into the project (${added.join(', ') || 'no new files'})`);
  const st = (await api('GET', `/api/p/${id}`)).doc.media[0];
  ok(st && path.resolve(dir, st.path) === path.resolve(clip), `the media points at the file where it is (${st?.path})`);
  page.close();
} finally {
  await srv.stop();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
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
  // a window macOS hasn't made active gets no DevTools input (GitHub's Macs): bring it forward, act as focused
  await send('Page.bringToFront').catch(() => {});
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return { send, call, close: () => ws.close() };
}
