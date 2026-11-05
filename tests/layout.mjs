// Layout at different window sizes (Step 83): with several project tabs, notices, exports (one done, with its Review
// link) and the Review page, no control is cut off and nothing overlaps. Checks every button, select, input and
// chip on screen against the window and the panels that clip it, and the children of the bars (top bar, transport,
// Review header and controls, comment tools, notices, export rows) against each other. Screenshots of each size go to
// tests/.work/layout/.
//   JIMMY_APP=electron node tests/layout.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, PORT, WORK, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(150); } };
const DEBUG_PORT = 9377;
const OUT = path.join(WORK, 'layout');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.LAYOUT_SIZES || '1920x1080,1440x900,1280x720,1100x700,960x640').split(',').map((s) => s.split('x').map(Number));
const REVIEWS = path.join(GOLDEN_DIR, 'reviews.json');
const keep = fs.existsSync(REVIEWS) ? fs.readFileSync(REVIEWS) : null;

// what is cut off or overlapping on screen now
function problems() {
  const out = [];
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}${(el.textContent || el.title || el.value || '').trim() ? ` "${(el.textContent || el.title || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 24)}"` : ''}`;
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; } return true; };
  // controls outside the window or their clipping panel (a scrolling panel is fine: it can be scrolled to)
  for (const el of document.querySelectorAll('button, select, input:not([type=file]), textarea, .chip, .tc, .toast, .seg button')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    let clip = { l: 0, t: 0, r: innerWidth, b: innerHeight }, scrolls = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      const ox = s.overflowX, oy = s.overflowY;
      if (/auto|scroll/.test(ox) || /auto|scroll/.test(oy)) { scrolls = true; break; }
      if (/hidden|clip/.test(ox) || /hidden|clip/.test(oy)) { const q = p.getBoundingClientRect(); clip = { l: Math.max(clip.l, q.left), t: Math.max(clip.t, q.top), r: Math.min(clip.r, q.right), b: Math.min(clip.b, q.bottom) }; }
      if (s.position === 'fixed') break;
    }
    if (scrolls) continue;
    const cut = Math.max(clip.l - r.left, r.right - clip.r, clip.t - r.top, r.bottom - clip.b);
    if (cut > 2) out.push(`cut off by ${Math.round(cut)}px: ${name(el)}`);
  }
  // children of a bar overlapping each other
  const bars = '.topbar, .topbar-right, .transport, .transport-buttons, .transport-right, .rv-controls, .review-head, .comment-tools, .composer-meta, .toast, .job-top, .job-actions, .panel-head, .mon-zoom, .viewer .panel-head, .tl-toolbar';
  for (const bar of document.querySelectorAll(bars)) {
    if (!shown(bar)) continue;
    const kids = [...bar.children].filter(shown).filter((k) => getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed');
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) out.push(`overlap in ${name(bar).slice(0, 30)}: ${name(kids[i])} × ${name(kids[j])}`);
    }
  }
  // sideways scrolling inside the comments list means something in a comment runs past the panel
  const cl = document.querySelector('.comment-list');
  if (cl && shown(cl) && cl.scrollWidth > cl.clientWidth + 2) out.push(`the comments list scrolls sideways (${cl.scrollWidth} > ${cl.clientWidth})`);
  // the zoom bars keep room to drag
  for (const zt of document.querySelectorAll('.mon-zoom-track')) if (shown(zt) && zt.getBoundingClientRect().width < 60) out.push(`zoom bar squeezed to ${Math.round(zt.getBoundingClientRect().width)}px`);
  // panels covering each other (one squeezed under another)
  const panels = [...document.querySelectorAll('.panel, .review-center, .claude-dock, .claude-rail')].filter(shown);
  for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
    const A = panels[i], B = panels[j];
    if (A.contains(B) || B.contains(A)) continue;
    const a = A.getBoundingClientRect(), b = B.getBoundingClientRect();
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 2 && h > 2) out.push(`panels overlap: ${name(A).slice(0, 30)} × ${name(B).slice(0, 30)}`);
  }
  // fields in the Inspector cut off at its right edge (it scrolls up and down, not sideways)
  const insp = document.querySelector('.panel.inspector');
  if (insp && shown(insp)) {
    const ir = insp.getBoundingClientRect();
    for (const el of insp.querySelectorAll('input, select, button')) if (shown(el) && el.getBoundingClientRect().right > ir.right + 1) { out.push(`cut off at the Inspector's edge: ${name(el)}`); break; }
  }
  return [...new Set(out)];
}

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  const { versionId } = await api('POST', `/api/p/${id}/rounds`, { sequence: 's_cuts' });
  // three more projects, with long names, for several tabs
  const others = [];
  for (const n of ['Second project with a rather long name', 'Third', 'Fourth project']) {
    const dir = path.join(OUT, n.replace(/\W+/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: n, media: [], folders: [], sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 25, background: '#000000', tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }));
    others.push((await api('POST', '/api/projects/open', { path: dir })).id);
  }
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  await until(() => page.call(() => !!window.__jimmy).catch(() => false));
  for (const pid of [...others, id]) { await page.call((p) => { window.__jimmy.openProject(p); }, pid); await sleep(400); }
  await until(() => page.call(() => !!window.__jimmy.activeTab()?.store.get().reviews).catch(() => false));
  await page.call(() => { window.__jimmy.activeTab().setSequence('s_cuts'); });
  // exports: one running, two done (with a Review link), and comments to review
  await page.call(async (pid, vid) => {
    const { app } = await import('/js/core/app.js');
    const now = Date.now();
    const job = (jid, o) => ({ id: jid, kind: 'video', projectId: pid, projectName: 'Golden test project', label: '01 Cuts, speed, sources v37 (draft export of the whole thing)', createdAt: now - 60000, progress: 1, engine: 'classic', ...o });
    app.set({ jobs: { j1: job('j1', { status: 'running', progress: 0.42, eta: 37, createdAt: now }), j2: job('j2', { status: 'done', versionId: vid }), j3: job('j3', { status: 'done', versionId: vid, label: 'Short' }) } });
    const t = window.__jimmy.activeTab();
    const note = (cid, ts, resolved) => ({ id: cid, version: vid, t: ts, tEnd: null, text: `a note with some words ${cid}`, author: 'You', createdAt: new Date().toISOString(), resolved, replies: [], drawing: [], refs: [] });
    t.updateReviews((r) => { r.comments.push(note('lc1', 1, true), note('lc2', 2, true), note('lc3', 3, false), note('lc4', 4, false)); });
  }, id, versionId);
  const toasts = () => page.call(async () => {
    const { notify } = await import('/js/core/notify.js');
    notify('The "Second project with a rather long name — main sequence" chat finished', 'claude', { action: { label: 'Open', run: () => {} }, timeout: 600000 });
    notify('Chat "Make a 30-second cut for Instagram Reels with captions" needs your answer', 'claude', { action: { label: 'Open', run: () => {} }, timeout: 600000 });
  });
  await toasts();
  const shot = async (n) => fs.writeFileSync(path.join(OUT, `${n}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  for (const [w, h] of SIZES) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    // Edit
    await page.call(() => { window.__jimmy.activeTab().ui.set({ mode: 'edit', claudeOpen: true }); });
    await sleep(700);
    let p = await page.call(problems);
    await shot(`${w}x${h}-edit`);
    ok(!p.length, `${w}×${h} Edit, Claude panel open: ${p.length ? p.join(' | ') : 'nothing cut off or overlapping'}`);
    // the exports list, opened
    await page.call(() => { document.querySelector('.jobs-btn')?.click(); });
    await sleep(300);
    p = await page.call(problems);
    const pop = await page.call(() => { const r = document.querySelector('.jobs-pop')?.getBoundingClientRect(); const rv = [...document.querySelectorAll('.jobs-pop .link-btn')].filter((b) => b.textContent === 'Review').map((b) => b.getBoundingClientRect()); return r && { in: r.left >= 0 && r.right <= innerWidth + 1, reviews: rv.every((x) => x.left >= r.left && x.right <= r.right + 1) && rv.length === 2 }; });
    await shot(`${w}x${h}-exports`);
    ok(pop?.in && pop.reviews && !p.length, `${w}×${h} exports list: inside the window, both Review links inside it${p.length ? `; ${p.join(' | ')}` : ''}`);
    await page.call(() => { document.querySelector('.jobs-btn')?.click(); });
    // Review
    await page.call((vid) => { window.__jimmy.activeTab().ui.set({ mode: 'review', reviewVersion: vid }); }, versionId);
    await sleep(900);
    p = await page.call(problems);
    await shot(`${w}x${h}-review`);
    ok(!p.length, `${w}×${h} Review: ${p.length ? p.join(' | ') : 'nothing cut off or overlapping'}`);
    const clear = await page.call(() => { const b = document.querySelector('.comment-clear'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() }; });
    ok(clear && clear.h <= 26 && clear.w <= 130, `${w}×${h} the Clear resolved button is compact (${clear ? `${clear.w}×${clear.h} "${clear.text}"` : 'missing'})`);
    await page.call(() => { window.__jimmy.activeTab().ui.set({ claudeOpen: false }); });
    await sleep(500);
    p = await page.call(problems);
    ok(!p.length, `${w}×${h} Review, Claude panel closed: ${p.length ? p.join(' | ') : 'nothing cut off or overlapping'}`);
  }
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  if (keep) fs.writeFileSync(REVIEWS, keep);
}
console.log(failed ? `layout: ${failed} failed` : 'layout: all checks passed');
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
