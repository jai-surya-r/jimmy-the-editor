// Project snapshots: taken on opening, before a chat's edit, by hand; never twice the same; holding only the
// project's own files, in its cache; restored through the window (the current state kept first); thinned to the
// newest 40 plus one a day.
//   JIMMY_APP=electron node tests/snapshots.mjs [folder for a screenshot]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9367;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'snapshots');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'project.json');
const project = (name) => ({ format: 'claude-edit/1', name: 'Snapshots', settings: { originalNames: 1 }, folders: [], media: [{ id: 'm_big', path: 'D:/Shoot/huge-take.mov', type: 'video' }],
  sequences: [{ id: 's1', name, width: 1920, height: 1080, fps: 30, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] });
fs.writeFileSync(FILE, JSON.stringify(project('First cut'), null, 2));
const seqName = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).sequences[0].name;

// a chat's edit snapshots at once in this test (no 5-minute gap)
const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT), JIMMY_SNAPSHOT_GAP_MS: '0' }, visible: true });
let page;
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  const list = async () => (await api('GET', `/api/p/${id}/snapshots`)).snapshots;
  let s = [];
  for (let i = 0; i < 30; i++) { s = await list(); if (s.length) break; await sleep(200); }
  ok(s.length === 1 && s[0].reason === 'open' && s[0].summary.sequences === 1, `opening the project takes one (${s.map((x) => x.label)})`);
  const again = await api('POST', `/api/p/${id}/snapshots`, {});
  ok(again.unchanged && (await list()).length === 1, 'taking one by hand with nothing changed makes no copy');

  // where it is and what it holds
  const st = await api('GET', '/api/state');
  const cacheBase = st.cacheDir ? path.join(st.cacheDir, 'projects') : DIR;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/[\\/]snapshots[\\/][^\\/]+--[a-z]+\.json$/.test(p)) files.push(p); } };
  walk(cacheBase);
  const one = files.length ? JSON.parse(fs.readFileSync(files[0], 'utf8')) : {};
  ok(files.length === 1 && /[\\/]\.cache[\\/]snapshots[\\/]|[\\/]projects[\\/][^\\/]+[\\/]snapshots[\\/]/.test(files[0]), `it is in the project's cache (${path.relative(WORK, files[0] || '')})`);
  ok(JSON.stringify(Object.keys(one.files || {}).sort()) === '["project.json","reviews.json"]' && fs.statSync(files[0]).size < 20000, `it holds only the project's own files, not footage (${Object.keys(one.files || {})}, ${fs.statSync(files[0]).size} bytes)`);

  // an edit in the editor, then a chat edits project.json: the state just before the chat's edit is kept
  const p0 = await api('GET', `/api/p/${id}`);
  const d0 = structuredClone(p0.doc); d0.sequences[0].name = 'Edited by hand';
  await api('PUT', `/api/p/${id}/project`, { doc: d0, baseRev: p0.rev, clientId: 'test' });
  await sleep(500);
  fs.writeFileSync(FILE, JSON.stringify(project('Claude cut'), null, 2));
  for (let i = 0; i < 40; i++) { s = await list(); if (s.length === 2) break; await sleep(200); }
  const kept = s[0] ? JSON.parse(fs.readFileSync(path.join(path.dirname(files[0]), `${s[0].id}.json`), 'utf8')).files['project.json'] : '';
  ok(/Edited by hand/.test(kept), 'it holds the project as it was just before the chat edit');
  ok(s.length === 2 && s[0].reason === 'chat', `a chat's edit makes one first (${s.map((x) => x.label).join(', ')})`);
  ok(seqName() === 'Claude cut', 'the edit itself goes through');

  // the window: restore the first one
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.bin')).catch(() => false)) break; await sleep(200); }
  await page.call(async () => { const { openSnapshots } = await import('/js/ui/snapshots.js'); openSnapshots(window.__jimmy.activeTab()); });
  let rows = [];
  for (let i = 0; i < 30; i++) { rows = await page.call(() => [...document.querySelectorAll('.snapshot-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim())); if (rows.length) break; await sleep(150); }
  ok(rows.length === 2 && /Before a chat edit/.test(rows[0]) && /Opened/.test(rows[1]), `the window lists them, newest first (${rows.map((r) => r.slice(0, 40))})`);
  if (SHOTS) { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, 'snapshots.png'), Buffer.from(data, 'base64')); }
  await page.call(() => document.querySelectorAll('.snapshot-row button')[1].click());
  await sleep(300);
  ok(await page.call(() => /Restore this snapshot\?/.test(document.querySelector('.modal')?.textContent || '')), 'Restore asks first');
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Restore').click());
  for (let i = 0; i < 30; i++) { if (seqName() === 'First cut') break; await sleep(200); }
  ok(seqName() === 'First cut', 'the project is back as it was when it opened');
  ok(await page.call(() => window.__jimmy.activeTab().seq?.name === 'First cut'), '…and the editor shows it at once');
  s = await list();
  ok(s[0].reason === 'restore', `the state before the restore was kept (${s[0].label})`);
  // …so the restore can be undone the same way
  await api('POST', `/api/p/${id}/snapshots/${encodeURIComponent(s[0].id)}/restore`, {});
  for (let i = 0; i < 30; i++) { if (seqName() === 'Claude cut') break; await sleep(200); }
  ok(seqName() === 'Claude cut', 'restoring that one brings the later state back');

  // thinning: many changes in a day keep the newest 40 and the day's first beyond them
  const p = await api('GET', `/api/p/${id}`);
  let rev = p.rev;
  for (let i = 0; i < 45; i++) {
    const d = structuredClone(p.doc);
    d.sequences[0].name = `Version ${i}`;
    const r = await api('PUT', `/api/p/${id}/project`, { doc: d, baseRev: rev, clientId: 'test', force: true });
    rev = r.rev ?? rev;
    await sleep(60);
    await api('POST', `/api/p/${id}/snapshots`, {});
  }
  await sleep(800);
  s = await list();
  ok(s.length <= 41 && s.length >= 40, `after 45 more, ${s.length} are kept (the newest 40, plus the day's first beyond them)`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `snapshots: ${failed} failed` : 'snapshots: all checks passed');
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
