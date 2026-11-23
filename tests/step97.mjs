// Step 97: a project shared between computers.
//   • chats: links to chats made on another computer don't lock a sequence: it shows as "fresh" (a new chat starts
//     for it here), linking a chat here keeps the other computer's link in the file, unlinking by hand sticks
//   • missing media: a project whose footage paths are from elsewhere (another drive, a Mac path on Windows) lists
//     it; locating one file puts the others back (the same change of folder, or by name close by)
//   • Review: the comment being typed survives a trip to Edit; Review follows the sequence open in Edit
//   JIMMY_APP=electron node tests/step97.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, PORT, GOLDEN_DIR, WORK, ROOT } from './lib/server.mjs';
import { layoutFor } from '../server/layout.js';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9366;
const FILES = layoutFor(GOLDEN_DIR).files;
const LINKS = path.join(FILES, 'chat-links.json');
const UNLINKS = path.join(FILES, 'chat-unlinks.json');
const backup = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
const restore = (f, b) => { if (b) fs.writeFileSync(f, b); else fs.rmSync(f, { force: true }); };
const keep = { links: backup(LINKS), unlinks: backup(UNLINKS), reviews: backup(path.join(GOLDEN_DIR, 'reviews.json')) };

// a scratch project whose footage was linked on "another computer"
const RP = path.join(WORK, 'relink-project');
const NEW = path.join(WORK, 'relink-media', 'New Drive');
fs.rmSync(RP, { recursive: true, force: true });
fs.rmSync(path.join(WORK, 'relink-media'), { recursive: true, force: true });
for (const f of ['Shoot/Day1/a.mp4', 'Shoot/Day1/b.mp4', 'Shoot/Day2/c.mp4', 'Shoot/d.mp4']) {
  fs.mkdirSync(path.dirname(path.join(NEW, f)), { recursive: true });
  fs.writeFileSync(path.join(NEW, f), 'not really a video');
}
fs.mkdirSync(RP, { recursive: true });
const other = process.platform === 'win32' ? '/Volumes/Media/Shoot/Day2/c.mp4' : 'D:\\Media\\Shoot\\Day2\\c.mp4';
fs.writeFileSync(path.join(RP, 'project.json'), JSON.stringify({
  name: 'Relink test',
  media: [
    { id: 'm_a', name: 'a.mp4', type: 'video', path: 'Z:/Old Drive/Shoot/Day1/a.mp4' },
    { id: 'm_b', name: 'b.mp4', type: 'video', path: 'Z:/Old Drive/Shoot/Day1/b.mp4' },
    { id: 'm_c', name: 'c.mp4', type: 'video', path: other },
    { id: 'm_d', name: 'd.mp4', type: 'video', path: 'Z:/Somewhere else/d.mp4' },
  ],
  sequences: [],
}, null, 1));

// chat links from "another computer" in the golden project
fs.mkdirSync(FILES, { recursive: true });
fs.writeFileSync(LINKS, JSON.stringify({ s_cuts: 'elsewhere-aaa', s_xform: ['elsewhere-bbb'] }));
fs.rmSync(UNLINKS, { force: true });

// `claude` on the PATH is the stand-in (tests/lib/fake-claude.mjs): no Claude is started
const BIN = path.join(WORK, 'step97-bin');
fs.mkdirSync(BIN, { recursive: true });
const fake = path.join(ROOT, 'tests', 'lib', 'fake-claude.mjs');
fs.writeFileSync(path.join(BIN, 'claude.cmd'), `@node "${fake}" %*
`);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh
exec node "${fake}" "$@"
`);
fs.chmodSync(path.join(BIN, 'claude'), 0o755);
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT), [pathKey]: `${BIN}${path.delimiter}${process.env[pathKey]}` }, visible: true });
let page;
try {
  const { id } = await openGolden();

  console.log('chats from another computer');
  let r = await api('GET', `/api/p/${id}/chat-links`);
  ok(!Object.keys(r.links).length, `no link points at a chat this computer doesn't have (${JSON.stringify(r.links)})`);
  ok(r.fresh.includes('s_cuts') && r.fresh.includes('s_xform'), `both sequences get a fresh chat here (${r.fresh})`);
  r = await api('POST', `/api/p/${id}/chat-links`, { sequenceId: 's_cuts', sessionId: 'here-111' });
  ok(r.links.s_cuts === 'here-111' && !r.fresh.includes('s_cuts') && r.fresh.includes('s_xform'), 'linking a chat here: that sequence uses it, the other stays fresh');
  let file = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
  ok(JSON.stringify(file.s_cuts) === '["elsewhere-aaa","here-111"]' && file.s_xform === 'elsewhere-bbb', `the file keeps the other computer's links (${JSON.stringify(file)})`);
  r = await api('POST', `/api/p/${id}/chat-links`, { sequenceId: 's_cuts', sessionId: null });
  file = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
  ok(file.s_cuts === 'elsewhere-aaa' && !r.links.s_cuts && !r.fresh.includes('s_cuts'), 'unlinking here leaves the other computer\'s link and no fresh chat (unlinked by hand)');

  // a message for the fresh sequence starts a new chat for it here, which is linked once it has an id
  r = await api('POST', `/api/p/${id}/chat/send`, { freshSequence: 's_xform', text: 'hello from the other computer' });
  ok(r.ok, 'a message for the fresh sequence is taken');
  let links = {};
  for (let i = 0; i < 50 && !links.s_xform; i++) { links = (await api('GET', `/api/p/${id}/chat-links`)).links; await sleep(200); }
  file = JSON.parse(fs.readFileSync(LINKS, 'utf8'));
  ok(links.s_xform === 'fake-session-0001' && JSON.stringify(file.s_xform) === '["elsewhere-bbb","fake-session-0001"]', `its new chat is linked to it, next to the other computer's (${JSON.stringify(file.s_xform)})`);

  console.log('missing media');
  const rp = await api('POST', '/api/projects/open', { path: RP });
  let m = await api('GET', `/api/p/${rp.id}/missing`);
  ok(m.missing.length === 4, `all four files are missing (${m.missing.length})`);
  ok(m.missing.find((x) => x.id === 'm_c')?.foreign === true, 'the path from the other system is marked as such');
  const res = await api('POST', `/api/p/${rp.id}/relink`, { mediaId: 'm_a', path: path.join(NEW, 'Shoot', 'Day1', 'a.mp4') });
  ok(res.linked.length === 4 && !res.missing.length, `locating one file finds the other three (${res.linked.join(', ')}; still missing ${res.missing.length})`);
  let p = {};
  for (let i = 0; i < 30; i++) {
    p = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(RP, 'project.json'), 'utf8')).media.map((x) => [x.id, x.path]));
    if (!p.m_b.startsWith('Z:')) break;
    await sleep(200);
  }
  const want = (f) => path.join(NEW, f).replace(/\\/g, '/');
  ok(p.m_b === want('Shoot/Day1/b.mp4'), `b: the same change of folder (${p.m_b})`);
  ok(p.m_c === want('Shoot/Day2/c.mp4') && p.m_d === want('Shoot/d.mp4'), `c and d: found by name close by (${p.m_c}, ${p.m_d})`);

  console.log('Review');
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy.activeTab()?.store.get().reviews).catch(() => false)) break; await sleep(200); }
  await page.call(() => document.querySelector('.modal-backdrop') && document.querySelector('.modal .icon-btn')?.click());
  const { versionId } = await api('POST', `/api/p/${id}/rounds`, { sequence: 's_cuts' });
  await page.call((vid) => { const t = window.__jimmy.activeTab(); t.setSequence('s_cuts'); t.ui.set({ mode: 'review', reviewVersion: vid }); }, versionId);
  for (let i = 0; i < 50; i++) { if (await page.call(() => !!document.querySelector('.composer textarea')).catch(() => false)) break; await sleep(200); }
  await page.call(() => { const ta = document.querySelector('.composer textarea'); ta.value = 'half a thought'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  await page.call(() => window.__jimmy.activeTab().ui.set({ mode: 'edit' }));
  await sleep(400);
  ok(await page.call(() => !document.querySelector('.composer textarea')), 'Edit is showing (the comment box is gone)');
  await page.call(() => window.__jimmy.activeTab().ui.set({ mode: 'review' }));
  await sleep(600);
  ok((await page.call(() => document.querySelector('.composer textarea')?.value)) === 'half a thought', 'back in Review, the typed comment is still there');
  // another sequence in Edit: Review shows that one, the text stays
  await page.call(() => { const t = window.__jimmy.activeTab(); t.ui.set({ mode: 'edit' }); t.setSequence('s_xform'); });
  await sleep(400);
  await page.call(() => window.__jimmy.activeTab().ui.set({ mode: 'review' }));
  for (let i = 0; i < 30; i++) { if (await page.call(() => !!document.querySelector('.composer textarea')).catch(() => false)) break; await sleep(200); }
  await sleep(400);
  const st = await page.call(() => { const t = window.__jimmy.activeTab(); const v = t.store.get().reviews.versions.find((x) => x.id === t.ui.get().reviewVersion); return { picked: t.ui.get().reviewVersion, cur: document.querySelector('.version-card.is-active')?.closest('.version-seq, .version-group, [class*=version]')?.textContent || '', seq: t.ui.get().sequenceId, vseq: v?.sequence || null, text: document.querySelector('.composer textarea')?.value }; });
  ok(st.picked === null && st.seq === 's_xform', `Review follows Edit to "02 Transforms" (the s_cuts version picked before gives way: ${st.picked})`);
  ok(st.text === 'half a thought', 'the typed comment is still there on the other sequence');
  // picking a version of another sequence in Review opens that sequence in Edit too
  await page.call((vid) => { const t = window.__jimmy.activeTab(); t.ui.set({ reviewVersion: null }); }, versionId);
  const clicked = await page.call(() => {
    const groups = [...document.querySelectorAll('.version-seq')];
    const g = groups.find((x) => /01 Cuts/.test(x.textContent));
    if (!g) return 'no group';
    if (!g.nextElementSibling?.classList.contains('version-drafts')) g.click();
    return 'ok';
  });
  await sleep(300);
  const picked = await page.call(() => {
    const g = [...document.querySelectorAll('.version-group')].find((x) => /01 Cuts/.test(x.querySelector('.version-seq')?.textContent || ''));
    const round = g && [...g.querySelectorAll('.version-drafts .version-card')].find((c) => c.querySelector('.status-pill'));
    round?.click();
    return !!round;
  });
  await sleep(500);
  const after = await page.call(() => window.__jimmy.activeTab().ui.get().sequenceId);
  ok(clicked === 'ok' && picked && after === 's_cuts', `picking a "01 Cuts" version in Review opens that sequence in Edit too (${after})`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  restore(LINKS, keep.links);
  restore(UNLINKS, keep.unlinks);
  if (keep.reviews) fs.writeFileSync(path.join(GOLDEN_DIR, 'reviews.json'), keep.reviews);
}
console.log(failed ? `step97: ${failed} failed` : 'step97: all checks passed');
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
  return { call, close: () => ws.close() };
}
