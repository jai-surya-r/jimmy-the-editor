// Review › Comments › Clear resolved: every resolved comment of the version on screen goes at once (after one
// question); open comments and other versions' comments stay.
//   JIMMY_APP=electron node tests/review-clear.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9365;
const REVIEWS = path.join(GOLDEN_DIR, 'reviews.json');
const keep = fs.existsSync(REVIEWS) ? fs.readFileSync(REVIEWS) : null;

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  const { versionId } = await api('POST', `/api/p/${id}/rounds`, { sequence: 's_cuts' });
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy.activeTab()?.store.get().reviews).catch(() => false)) break; await sleep(200); }
  // three resolved and two open notes on this round, one resolved note on another version
  await page.call((vid) => {
    const t = window.__jimmy.activeTab();
    const note = (id, version, ts, resolved) => ({ id, version, t: ts, tEnd: null, text: `note ${id}`, author: 'You', createdAt: new Date().toISOString(), resolved, replies: [], drawing: [], refs: [] });
    t.updateReviews((r) => { r.comments.push(note('cm_r1', vid, 1, true), note('cm_r2', vid, 2, true), note('cm_r3', vid, 3, true), note('cm_o1', vid, 4, false), note('cm_o2', vid, 5, false), note('cm_x', 'v_other', 1, true)); });
    t.ui.set({ mode: 'review', reviewVersion: vid });
  }, versionId);
  for (let i = 0; i < 50; i++) { if (await page.call(() => !!document.querySelector('.comment-clear')).catch(() => false)) break; await sleep(200); }

  const btn = await page.call(() => document.querySelector('.comment-clear')?.textContent.trim());
  ok(btn === 'Clear done (3)', `the comments panel offers to clear the resolved ones (${btn})`);
  await page.call(() => document.querySelector('.comment-clear').click());
  await sleep(300);
  const q = await page.call(() => document.querySelector('.modal')?.textContent || '');
  ok(/Clear 3 resolved comments\?/.test(q) && /Open comments stay/.test(q), 'it asks once, saying what goes');
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Cancel').click());
  await sleep(300);
  ok((await page.call(() => window.__jimmy.activeTab().store.get().reviews.comments.filter((c) => /^cm_r/.test(c.id)).length)) === 3, 'Cancel keeps them');
  await page.call(() => document.querySelector('.comment-clear').click());
  await sleep(300);
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Clear resolved').click());
  await sleep(600);
  const left = await page.call(() => window.__jimmy.activeTab().store.get().reviews.comments.filter((c) => /^cm_/.test(c.id)).map((c) => c.id).sort());
  ok(JSON.stringify(left) === '["cm_o1","cm_o2","cm_x"]', `the resolved ones go; open ones and another version's stay (${left})`);
  ok(await page.call(() => !document.querySelector('.comment-clear') && document.querySelectorAll('.comment').length === 2), 'the list shows the two open notes and the button is gone');
  let saved = null;
  for (let i = 0; i < 20; i++) { saved = JSON.parse(fs.readFileSync(REVIEWS, 'utf8')).comments.filter((c) => /^cm_/.test(c.id)).map((c) => c.id).sort(); if (saved.length === 3) break; await sleep(200); }
  ok(JSON.stringify(saved) === '["cm_o1","cm_o2","cm_x"]', 'reviews.json is saved that way');
  // searching marks what it found (any case), in the note and its replies (Step 83)
  await page.call(() => window.__jimmy.activeTab().updateReviews((r) => { r.comments.find((c) => c.id === 'cm_o2').replies.push({ id: 'r_x', author: 'Claude', text: 'Changed the O2 title', createdAt: new Date().toISOString() }); }));
  await sleep(300);
  await page.call(() => { const i = document.querySelector('.comment-search'); i.value = 'O2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  const hl = await page.call(() => ({ n: document.querySelectorAll('.comment').length, marks: [...document.querySelectorAll('.comment mark.hl')].map((m) => m.textContent) }));
  ok(hl.n === 1 && JSON.stringify(hl.marks) === '["o2","O2"]', `a search shows the matching note with the words marked, in the note and its reply (${hl.n} shown, marks ${JSON.stringify(hl.marks)})`);
  await page.call(() => { const i = document.querySelector('.comment-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  ok(await page.call(() => !document.querySelector('mark.hl') && document.querySelectorAll('.comment').length === 2), 'clearing the search removes the marks');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  if (keep) fs.writeFileSync(REVIEWS, keep);
}
console.log(failed ? `review-clear: ${failed} failed` : 'review-clear: all checks passed');
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
