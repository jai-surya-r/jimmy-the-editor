// Step 82, in the desktop app: auto-fix stays off after a restart; a pinch zooms the timeline (also after a missed
// Ctrl key-up) while Ctrl + mouse wheel still sets track heights; the exact frame stays on while stepping frames;
// the Program monitor and the Review player have a zoomable time bar; the Review comment box's top edge resizes it.
//   JIMMY_APP=electron node tests/step82.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, PORT, WORK, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(100); } };
const DEBUG_PORT = 9376;
const REVIEWS = path.join(GOLDEN_DIR, 'reviews.json');
const keep = fs.existsSync(REVIEWS) ? fs.readFileSync(REVIEWS) : null;

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  const { versionId } = await api('POST', `/api/p/${id}/rounds`, { sequence: 's_cuts' });
  await api('POST', `/api/p/${id}/autofix`, { on: true }); // (a run before turned it off: the app keeps that)
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); localStorage.removeItem('ce.review.composerH'); location.reload(); });
  await sleep(1500);
  await until(() => page.call(() => !!window.__jimmy).catch(() => false));
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  await until(() => page.call(() => !!window.__jimmy.activeTab()?.store.get().reviews).catch(() => false));
  await page.call(() => window.__jimmy.activeTab().setSequence('s_cuts'));
  await sleep(800);
  const mouse = async (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  // GitHub's Macs deliver no DevTools mouse input: there (or with JIMMY_INPAGE_INPUT=1) the drag is pointer events sent in the page
  const IN_PAGE = process.platform === 'darwin' || process.env.JIMMY_INPAGE_INPUT === '1';
  const drag = async (x0, y0, x1, y1) => {
    if (IN_PAGE) {
      await page.call((a) => { const el = document.elementFromPoint(a[0], a[1]); const o = (x, y, b) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: b, pointerId: 1, pointerType: 'mouse', isPrimary: true }); el.dispatchEvent(new PointerEvent('pointerdown', o(a[0], a[1], 1))); for (let i = 1; i <= 6; i++) el.dispatchEvent(new PointerEvent('pointermove', o(a[0] + ((a[2] - a[0]) * i) / 6, a[1] + ((a[3] - a[1]) * i) / 6, 1))); el.dispatchEvent(new PointerEvent('pointerup', o(a[2], a[3], 0))); }, [x0, y0, x1, y1]);
      await sleep(200);
      return;
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 }); await mouse('mousePressed', x0, y0); for (let i = 1; i <= 6; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 6, y: y0 + ((y1 - y0) * i) / 6, button: 'left', buttons: 1 }); await mouse('mouseReleased', x1, y1); await sleep(200);
  };
  const rect = (sel) => page.call((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, sel);

  // ------------------------------------------------------------ 2. pinch and Ctrl + wheel on the timeline
  const wheel = (o) => page.call((opt) => {
    const lane = document.querySelector('.tl-lane');
    const r = lane.getBoundingClientRect();
    lane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, deltaMode: 0, ...opt }));
    const t = window.__jimmy.activeTab();
    return { pps: t.ui.get().pps, heights: localStorage.getItem(`ce.trackHeights.${t.projectId}`) || '{}' };
  }, o);
  const s0 = await wheel({ deltaY: 0.0001, deltaX: 0 });
  let s1 = await wheel({ ctrlKey: true, deltaY: -4.37 }); // a pinch: Ctrl not held
  ok(s1.pps > s0.pps && s1.heights === s0.heights, `a pinch zooms the timeline (${Math.round(s0.pps)} → ${Math.round(s1.pps)} px/s), track heights stay`);
  // Ctrl pressed, its key-up lost (focus elsewhere): the mouse says it is up again
  await page.call(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true })); window.dispatchEvent(new PointerEvent('pointermove', { ctrlKey: false })); });
  let s2 = await wheel({ ctrlKey: true, deltaY: 3.21 });
  ok(s2.pps < s1.pps && s2.heights === s0.heights, 'after a missed Ctrl key-up, a pinch still zooms (not track heights)');
  // even with Ctrl held, a pinch's small fractional steps zoom
  await page.call(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true })); window.dispatchEvent(new PointerEvent('pointermove', { ctrlKey: true })); });
  const s3 = await wheel({ ctrlKey: true, deltaY: -2.6 });
  ok(s3.pps > s2.pps && s3.heights === s0.heights, 'with Ctrl held, a pinch (fractional steps) still zooms');
  // Ctrl + a mouse wheel notch: the track's height, as before
  const s4 = await wheel({ ctrlKey: true, deltaY: -166.66667 });
  ok(s4.heights !== s0.heights && Math.abs(s4.pps - s3.pps) < 1e-6, `Ctrl + mouse wheel still sets the track height (${s4.heights})`);
  await page.call(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false })));

  // ------------------------------------------------------------ 4a. the Program monitor's time bar
  ok(await page.call(() => !!document.querySelector('.panel.viewer .mon-bar .mon-ruler') && document.querySelector('.panel.viewer .mon-zoom-info b')?.textContent === 'Fit'), 'the Program monitor has a time ruler and a zoom bar (Fit)');
  const pz = await page.call(() => {
    const bar = document.querySelector('.panel.viewer .mon-ruler');
    const r = bar.getBoundingClientRect();
    for (let i = 0; i < 4; i++) bar.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, altKey: true, deltaY: -100, clientX: r.x + r.width / 2, clientY: r.y + 10 }));
    return null;
  });
  void pz;
  await sleep(200);
  const pInfo = await page.call(() => document.querySelector('.panel.viewer .mon-zoom-info').textContent.trim());
  ok(/^2\.4×/.test(pInfo), `Alt + wheel zooms it around the cursor (${pInfo})`);
  fs.writeFileSync(path.join(WORK, 'step82-program.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // click on the ruler: the playhead goes there
  const pr = await rect('.panel.viewer .mon-ruler');
  await drag(pr.x + pr.w * 0.25, pr.y + 15, pr.x + pr.w * 0.25, pr.y + 15);
  const pt = await page.call(() => { const t = window.__jimmy.activeTab(); return { t: t.engine.t, info: document.querySelector('.panel.viewer .mon-zoom-info').textContent }; });
  const [, a, b] = /([\d:]+) – ([\d:]+)/.exec(pt.info) || [];
  const fps = await page.call(() => window.__jimmy.activeTab().seq.fps);
  const tc = (s) => { const p = s.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / fps; };
  const want = a ? tc(a) + (tc(b) - tc(a)) * 0.25 : -1;
  ok(Math.abs(pt.t - want) < 0.2, `a click on the ruler moves the playhead within the stretch in view (${pt.t.toFixed(2)} s, expected ${want.toFixed(2)})`);
  // drag the zoom bar's right end left: more zoom
  const endB = await rect('.panel.viewer .mon-zoom-end.is-b');
  const hitB = await page.call((x, y) => document.elementFromPoint(x, y)?.className, endB.x + 5, endB.y + 5);
  await drag(endB.x + 5, endB.y + 5, endB.x - 40, endB.y + 5);
  const pInfo2 = await page.call(() => document.querySelector('.panel.viewer .mon-zoom-info b').textContent);
  ok(parseFloat(pInfo2) > 2.4, `dragging the zoom bar's end zooms in further (${pInfo2}; under the pointer: ${hitB})`);
  await page.call(() => document.querySelector('.panel.viewer .mon-zoom-track').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(150);
  ok(await page.call(() => document.querySelector('.panel.viewer .mon-zoom-info b').textContent === 'Fit'), 'double-clicking the zoom bar shows the whole length again');

  // ------------------------------------------------------------ 5. the exact frame stays on while stepping
  const exactOn = () => page.call(() => !!document.querySelector('.viewer-exact.is-on'));
  await page.call(() => { const t = window.__jimmy.activeTab(); t.engine.pause(); t.engine.seek(2); });
  const firstOn = await until(exactOn, 30000);
  ok(firstOn, 'the exact frame shows on pause');
  if (firstOn) {
    const src0 = await page.call(() => document.querySelector('.viewer-exact').src.length + ':' + document.querySelector('.viewer-exact').src.slice(-40));
    // (once more if something else changed the picture meanwhile, e.g. a save echoed back: that hides it, rightly)
    const stepWatch = () => page.call(async () => {
      const el = document.querySelector('.viewer-exact');
      const before = el.src;
      // the exact frames the server sends back from now on (the next frame can look just like this one)
      let came = 0;
      const of = window.fetch;
      window.fetch = async (...a) => { const r = await of(...a); if (String(a[0]).includes('/exact-frame')) r.clone().text().then(() => { came++; }); return r; };
      window.__jimmy.activeTab().engine.step(1);
      let offs = 0, n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 30000) { // (GitHub's Macs render an exact frame in seconds)
        await new Promise((r) => requestAnimationFrame(r));
        n++;
        if (!el.classList.contains('is-on')) offs++;
        if (came && el.classList.contains('is-on')) { await new Promise((r) => setTimeout(r, 300)); if (!el.classList.contains('is-on')) offs++; break; }
      }
      window.fetch = of;
      return { offs, n, changed: came > 0 && el.classList.contains('is-on'), same: el.src === before, ms: Math.round(performance.now() - t0) };
    });
    let watch = await stepWatch();
    if (watch.offs) { await until(exactOn, 30000); await sleep(500); watch = await stepWatch(); }
    ok(watch.offs === 0, `stepping one frame keeps the exact frame on: never off in ${watch.n} frames (${watch.ms} ms)`);
    ok(watch.changed, `…and the next frame's exact render takes its place${watch.same ? ' (the same picture: those two frames look alike)' : ''}`);
    void src0;
    // quick steps: the live preview follows them, the exact frame comes back after
    const quick = await page.call(async () => {
      const el = document.querySelector('.viewer-exact');
      const eng = window.__jimmy.activeTab().engine;
      // the second step on the very next frame: the first one's exact render can't be back yet
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      eng.step(1); await frame(); await frame(); eng.step(1); await frame(); await frame();
      return el.classList.contains('is-on');
    });
    ok(!quick, 'quick steps in a row hide it (the live preview follows)');
    ok(await until(exactOn, 30000), '…and it comes back once they stop');
    await page.call(() => window.__jimmy.activeTab().engine.toggle());
    await sleep(300);
    ok(!(await exactOn()), 'playing hides it');
    await page.call(() => window.__jimmy.activeTab().engine.pause());
  }

  // ------------------------------------------------------------ Review: time bar, comment box, auto-fix
  await page.call((vid) => {
    const t = window.__jimmy.activeTab();
    const note = (cid, ts) => ({ id: cid, version: vid, t: ts, tEnd: null, text: `note ${cid}`, author: 'You', createdAt: new Date().toISOString(), resolved: false, replies: [], drawing: [], refs: [] });
    t.updateReviews((r) => { r.comments.push(note('cm_a', 0.5), note('cm_b', 6)); });
    t.ui.set({ mode: 'review', reviewVersion: vid });
  }, versionId);
  await until(() => page.call(() => !!document.querySelector('.rv-monbar .mon-ruler')), 10000);
  ok(await page.call(() => document.querySelector('.rv-monbar .mon-zoom-info b')?.textContent === 'Fit' && document.querySelectorAll('.rv-mark').length === 2), 'the Review player has the time ruler and zoom bar, both comments on the seeker');
  await page.call(() => {
    const bar = document.querySelector('.rv-monbar .rv-scrub');
    const r = bar.getBoundingClientRect();
    for (let i = 0; i < 6; i++) bar.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -40.5, clientX: r.x + 2, clientY: r.y + 10 }));
  });
  await sleep(200);
  const rInfo = await page.call(() => ({ info: document.querySelector('.rv-monbar .mon-zoom-info').textContent.trim(), marks: document.querySelectorAll('.rv-mark').length }));
  ok(/×/.test(rInfo.info) && rInfo.marks === 1 && /1 comment in view/.test(rInfo.info), `a pinch on the seeker zooms it, like the timeline (${rInfo.info}); comments outside the view are left off`);
  const sr = await rect('.rv-monbar .rv-scrub');
  await drag(sr.x + sr.w / 2, sr.y + 20, sr.x + sr.w / 2, sr.y + 20);
  const rs = await page.call(() => ({ t: window.__jimmy.activeTab().engine.t, info: document.querySelector('.rv-monbar .mon-zoom-info').textContent }));
  const [, ra, rb] = /([\d:]+) – ([\d:]+)/.exec(rs.info) || [];
  const rWant = ra ? (tc(ra) + tc(rb)) / 2 : -1;
  ok(Math.abs(rs.t - rWant) < 0.15, `a click on the zoomed seeker goes to that time in the stretch in view (${rs.t.toFixed(2)} s, expected ${rWant.toFixed(2)})`);

  // 3. the comment box's height
  const ta0 = await rect('.composer textarea');
  const g = await rect('.composer-grip');
  const hitG = await page.call((x, y) => document.elementFromPoint(x, y)?.className, g.x + g.w / 2, g.y + 4);
  await drag(g.x + g.w / 2, g.y + 4, g.x + g.w / 2, g.y + 4 - 120);
  const ta1 = await rect('.composer textarea');
  ok(ta1.h > ta0.h + 100, `dragging the comment box's top edge makes it taller (${Math.round(ta0.h)} → ${Math.round(ta1.h)} px; under the pointer: ${hitG})`);
  ok(await page.call(() => Number(localStorage.getItem('ce.review.composerH')) > 100), '…and it is remembered');
  fs.writeFileSync(path.join(WORK, 'step82-review.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // 1. auto-fix: off stays off, even if the window's own storage lost it
  await until(() => page.call(() => !!document.querySelector('.chip.autofix')), 5000);
  const label0 = await page.call(() => document.querySelector('.chip.autofix').textContent.trim());
  await page.call(() => document.querySelector('.chip.autofix').click());
  await sleep(500);
  const label1 = await page.call(() => document.querySelector('.chip.autofix').textContent.trim());
  ok(label0 !== 'Auto-fix off' && label1 === 'Auto-fix off', `the switch turns auto-fix off (${label0} → ${label1})`);
  ok((await api('GET', `/api/p/${id}/autofix`)).on === false, 'the server keeps it');
  const cfg = JSON.parse(fs.readFileSync(path.join(WORK, 'app-data', 'config.json'), 'utf8'));
  ok(cfg.projectAutofix?.[id] === false, "…in the app's config.json (so it survives a restart)");
  await page.call((pid) => { localStorage.removeItem(`ce.autofix.${pid}`); localStorage.setItem('ce.tabs', '[]'); location.reload(); }, id);
  await sleep(1500);
  await until(() => page.call(() => !!window.__jimmy).catch(() => false));
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  await until(() => page.call(() => !!window.__jimmy.activeTab()?.store.get().reviews).catch(() => false));
  const af = await until(() => page.call(async () => { const m = await import('/js/ui/autofix.js'); const st = m.autoFixStore(window.__jimmy.activeTab().projectId).get(); return st.loaded && st; }), 8000);
  ok(af && af.on === false, 'after a reload with the window\'s setting gone, auto-fix is still off');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  if (keep) fs.writeFileSync(REVIEWS, keep);
}
console.log(failed ? `step82: ${failed} failed` : 'step82: all checks passed');
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
