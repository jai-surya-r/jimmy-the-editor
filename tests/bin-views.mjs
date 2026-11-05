// The project bin's List, Tiles and Gallery views: the grid views show one folder at a time with a path bar, a video
// tile scrubs through the clip under the mouse (from the thumbnail strip) and goes back to its poster, folders open
// with a double-click, selection and the view choice are kept.
//   JIMMY_APP=electron node tests/bin-views.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9359;
const SHOTS = process.argv[2];
const PROJECT = path.join(GOLDEN_DIR, 'project.json');
const keep = fs.existsSync(PROJECT) ? fs.readFileSync(PROJECT) : null;

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  // a folder holding one clip, so the grid has something to open
  const p = await api('GET', `/api/p/${id}`);
  const doc = structuredClone(p.doc);
  doc.folders.push({ id: 'f_testroll', name: 'B-Roll', parent: null });
  const moved = doc.media.find((m) => m.type === 'video' && !m.motion && /23976/.test(m.path));
  moved.folder = 'f_testroll';
  await api('PUT', `/api/p/${id}/project`, { doc, baseRev: p.rev, clientId: 'test' });
  // wait until thumbnail strips exist for the videos
  for (let i = 0; i < 100; i++) { const st = (await api('GET', `/api/p/${id}`)).mediaStatus || {}; if (Object.values(st).some((s) => s.thumbs)) break; await sleep(300); }

  page = await connectPage();
  await page.call((pid) => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); localStorage.removeItem(`ce.binView.${pid}`); location.reload(); }, id);
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.bin-row')).catch(() => false)) break; await sleep(200); }
  await sleep(800);
  const shot = async (name) => { if (!SHOTS) return; const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };
  const view = (title) => page.call((t) => document.querySelector(`.bin-views [title^="${t}"]`).click(), title);
  const tiles = () => page.call(() => [...document.querySelectorAll('.bin-tile')].map((t) => ({ id: t.dataset.bin, name: t.querySelector('.bin-tile-name')?.textContent })));

  // ------------------------------------------------------------ the views
  ok(await page.call(() => document.querySelectorAll('.bin-views .icon-btn').length === 3 && document.querySelector('.bin-views [title="List"]').classList.contains('is-active')), 'three view buttons, List on to begin with');
  const listCount = await page.call(() => document.querySelectorAll('.bin-row').length);
  await view('Gallery');
  await sleep(300);
  let t = await tiles();
  const rootCount = await page.call((mid) => { const d = window.__jimmy.activeTab().doc; return d.folders.filter((f) => !f.parent).length + d.sequences.filter((s) => !s.folder).length + d.media.filter((m) => !m.folder).length; }, moved.id);
  ok(t.length === rootCount && !t.some((x) => x.id === moved.id), `Gallery shows the project root as tiles (${t.length}), not what is inside folders`);
  ok(t[0]?.name === 'B-Roll', 'folders come first');
  ok(await page.call(() => document.querySelector('.bin-list').classList.contains('is-gallery') && !!document.querySelector('.bin-crumbs')), 'with the path bar');
  await shot('bin-gallery.png');

  // scrubbing a video tile
  const vid = await page.call(() => { const t = [...document.querySelectorAll('.bin-tile')].find((x) => x.querySelector('.bin-tile-scrub')); return t?.dataset.bin; });
  ok(!!vid, 'a video tile has a scrub line ready');
  const at = (frac) => page.call((v, f) => {
    const pic = document.querySelector(`.bin-tile[data-bin="${v}"] .bin-tile-pic`);
    pic.scrollIntoView({ block: 'center' });
    const r = pic.getBoundingClientRect();
    pic.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * f, clientY: r.top + r.height / 2 }));
    const fr = pic.querySelector('.bin-tile-frame'); const s = pic.querySelector('.bin-tile-scrub');
    return { bg: fr.style.backgroundImage, pos: fr.style.backgroundPosition, line: !s.hidden, left: s.style.left, t: s.dataset.t };
  }, vid, frac);
  const a = await at(0.2), b = await at(0.8);
  ok(/thumbs/.test(a.bg) && a.line && a.t, `moving over it shows the thumbnail strip, a line and the time (${a.t} at ${a.left})`);
  ok(a.pos !== b.pos && parseFloat(b.pos) > parseFloat(a.pos) && b.t !== a.t, `further right is later in the clip (${a.pos} → ${b.pos}, ${a.t} → ${b.t})`);
  await shot('bin-scrub.png');
  const left = await page.call((v) => { const pic = document.querySelector(`.bin-tile[data-bin="${v}"] .bin-tile-pic`); pic.dispatchEvent(new PointerEvent('pointerleave')); const fr = pic.querySelector('.bin-tile-frame'); return { bg: fr.style.backgroundImage, line: !pic.querySelector('.bin-tile-scrub').hidden }; }, vid);
  ok(/poster/.test(left.bg) && !left.line, 'leaving it goes back to the poster');

  // selection, folders, path bar
  await page.call((v) => document.querySelector(`.bin-tile[data-bin="${v}"]`).click(), vid);
  ok(await page.call((v) => document.querySelector(`.bin-tile[data-bin="${v}"]`).classList.contains('is-selected') && window.__jimmy.activeTab().ui.get().binSelection.includes(v), vid), 'clicking a tile selects it');
  await page.call(() => document.querySelector('.bin-tile[data-bin="f_testroll"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(200);
  t = await tiles();
  ok(t.length === 1 && t[0].id === moved.id, `double-clicking a folder opens it (${t.map((x) => x.name)})`);
  ok(await page.call(() => [...document.querySelectorAll('.bin-crumb')].map((b) => b.textContent).join(' / ') === 'Project / B-Roll'), 'the path bar says Project / B-Roll');
  await page.call(() => document.querySelector('.bin-crumb').click());
  await sleep(200);
  ok((await tiles()).length === rootCount, 'Project in the path bar goes back up');

  // Tiles view and back to List; the choice is kept
  await view('Tiles');
  await sleep(200);
  ok(await page.call(() => document.querySelector('.bin-list').classList.contains('is-tiles') && document.querySelector('.bin-tile').getBoundingClientRect().width < 150), 'Tiles shows smaller tiles');
  await shot('bin-tiles.png');
  await page.call(() => location.reload());
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.bin-tile, .bin-row')).catch(() => false)) break; await sleep(200); }
  await sleep(500);
  ok(await page.call(() => !!document.querySelector('.bin-list.is-tiles')), 'the view is remembered for the project');
  await view('List');
  await sleep(200);
  ok(await page.call(() => document.querySelectorAll('.bin-row').length) === listCount, 'List is as it was');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  if (keep) fs.writeFileSync(PROJECT, keep);
}
console.log(failed ? `bin-views: ${failed} failed` : 'bin-views: all checks passed');
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
