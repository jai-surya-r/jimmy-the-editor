// Export › File name: the export dialog shows the name the file will get and lets the person change it; the server
// saves it under that name (Review keeps its version number), never over an existing file, also for audio-only.
//   JIMMY_APP=electron node tests/export-name.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9355;
const OUT = path.join(GOLDEN_DIR, 'renders', 'export-name');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const reviewsFile = path.join(GOLDEN_DIR, 'reviews.json');
const keepReviews = fs.existsSync(reviewsFile) ? fs.readFileSync(reviewsFile) : null;
const projectFile = path.join(GOLDEN_DIR, 'project.json');
const keepProject = fs.existsSync(projectFile) ? fs.readFileSync(projectFile) : null;

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  await api('POST', '/api/settings', { prerender: { enabled: false } });
  const exp = (body) => api('POST', `/api/p/${id}/render`, { sequenceId: 's_cuts', quality: 'draft', range: null, outDir: OUT, wait: true, ...body }).then((r) => r.job);
  const base = (j) => path.basename(j.output || '');

  // ------------------------------------------------------------ the server
  // short exports: In → Out over the first second
  const p = await api('GET', `/api/p/${id}`);
  const doc = structuredClone(p.doc);
  const s = doc.sequences.find((x) => x.id === 's_cuts');
  s.inPoint = 0; s.outPoint = 1;
  await api('PUT', `/api/p/${id}/project`, { doc, baseRev: p.rev, clientId: 'test' });
  await sleep(300);
  const a = await exp({ name: 'Client cut — final', addVersion: true, range: 'inout' });
  ok(a.status === 'done' && base(a) === 'Client cut — final.mp4' && fs.existsSync(a.output), `a typed name is the file's name (${base(a)})`);
  let rv = null;
  for (let i = 0; i < 30 && !rv; i++) { rv = ((await api('GET', `/api/p/${id}`)).reviews?.versions || []).find((v) => (v.file || '').endsWith('Client cut — final.mp4')); if (!rv) await sleep(200); }
  ok(rv && rv.number >= 1, `…and it is still a numbered Review version (v${rv?.number})`);
  const b = await exp({ name: 'Client cut — final.mp4', addVersion: false, range: 'inout' });
  ok(base(b) === 'Client cut — final (2).mp4' && fs.statSync(a.output).size > 0, `the same name again doesn't write over it: ${base(b)}`);
  const c = await exp({ name: 'a/b: c?', addVersion: false, range: 'inout' });
  ok(base(c) === 'a b c.mp4', `characters a file name can't have become spaces (${base(c)})`);
  const d = await exp({ addVersion: false, range: 'inout' });
  ok(/^01 Cuts, speed, sources \d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.mp4$/.test(base(d)), `no name: the default as before (${base(d)})`);
  const au = await api('POST', `/api/p/${id}/render`, { sequenceId: 's_cuts', audio: 'wav16', range: 'inout', outDir: OUT, name: 'Mix for the client', wait: true }).then((r) => r.job);
  ok(base(au) === 'Mix for the client.wav', `audio-only exports take the name too (${base(au)})`);

  // ------------------------------------------------------------ the dialog
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy.activeTab()?.seq).catch(() => false)) break; await sleep(200); }
  await page.call(async (dir) => {
    const t = window.__jimmy.activeTab();
    t.ui.set({ sequenceId: 's_cuts', exportDir: dir, exportFormat: 'h264', exportOpts: null });
    const { ExportDialog } = await import('/js/ui/dialogs.js');
    const { openDialog } = await import('/js/core/notify.js');
    window.__exportDone = null;
    openDialog(ExportDialog, { tab: t }).then((job) => { window.__exportDone = job; });
  }, OUT);
  const field = () => page.call(() => { const i = [...document.querySelectorAll('.modal .field')].find((f) => f.querySelector('span')?.textContent === 'File name'); return i ? { value: i.querySelector('input').value, ext: i.querySelector('.muted')?.textContent, reset: !!i.querySelector('.icon-btn') } : null; });
  let f = null;
  for (let i = 0; i < 30 && !f; i++) { f = await field(); await sleep(100); }
  ok(f && /^01 Cuts, speed, sources v\d+$/.test(f.value) && f.ext === '.mp4', `the dialog shows the name it will get (${f?.value}${f?.ext})`);
  // switching off "Add to Review" changes the default
  await page.call(() => [...document.querySelectorAll('.modal .toggle')].find((t) => /Add to Review/.test(t.textContent))?.click());
  await sleep(150);
  f = await field();
  ok(/^01 Cuts, speed, sources \d{4}-/.test(f.value), `…and follows the settings while not typed in (${f.value})`);
  // typing a name, Enter exports
  await page.call(() => {
    const i = [...document.querySelectorAll('.modal .field')].find((x) => x.querySelector('span')?.textContent === 'File name').querySelector('input');
    i.value = 'Typed in the dialog'; i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
  f = await field();
  ok(f.value === 'Typed in the dialog' && f.reset, 'a typed name stays, with a button back to the default');
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => /^Export (MP4|MOV)$/.test(b.textContent.trim())).click());
  let job = null;
  for (let i = 0; i < 50 && !job; i++) { job = await page.call(() => window.__exportDone); await sleep(100); }
  let file = null;
  for (let i = 0; i < 300 && !file; i++) { file = fs.readdirSync(OUT).find((n) => n === 'Typed in the dialog.mp4'); await sleep(200); }
  ok(!!file, `the export is saved under the typed name (${file})`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  if (keepReviews) fs.writeFileSync(reviewsFile, keepReviews);
  if (keepProject) fs.writeFileSync(projectFile, keepProject);
}
console.log(failed ? `export-name: ${failed} failed` : 'export-name: all checks passed');
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
