// The black-and-white themes and the timeline in the real desktop app: only Dark and Light, the tools down the left, the
// level meter showing real playback, Ctrl+wheel track height and Alt+wheel zoom, and the line on a clip with the Pen tool, by real mouse.
//   JIMMY_APP=electron node tests/timeline-ui.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9345;
const SHOTS = process.argv[2];

const PROJECT = path.join(GOLDEN_DIR, 'project.json');
const keep = fs.existsSync(PROJECT) ? fs.readFileSync(PROJECT) : null; // this test edits the project
const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  page = await connectPage();
  const shot = async (name) => {
    if (!SHOTS) return;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  };
  const reset = () => page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); localStorage.setItem('ce.theme', '"sunset"'); for (const k of Object.keys(localStorage)) if (k.startsWith('ce.trackHeights')) localStorage.removeItem(k); location.reload(); });
  await reset();
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }

  // ------------------------------------------------------------ themes
  const vars = () => page.call(() => { const c = getComputedStyle(document.documentElement); return [c.getPropertyValue('--bg').trim(), c.getPropertyValue('--accent').trim(), document.documentElement.dataset.theme]; });
  const [bg, accent, theme] = await vars();
  ok(theme === 'dark' && bg === '#000000' && accent === '#ffffff', `a removed theme falls back to black and white Dark (${theme}, ${bg}, ${accent})`);

  await page.call((p) => { window.__jimmy.openProject(p); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.tl-row')).catch(() => false)) break; await sleep(200); }

  // ------------------------------------------------------------ layout
  const layout = await page.call(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
    const btns = [...document.querySelectorAll('.tl-tools .icon-btn')].map((b) => b.getBoundingClientRect());
    return { tools: r('.tl-tools'), main: r('.tl-main'), meter: r('.audio-meter'), count: btns.length, sameX: btns.every((b) => b.left === btns[0].left), down: btns.every((b, i) => !i || b.top > btns[i - 1].top), inBar: !!document.querySelector('.tl-toolbar [title^="Razor tool"]'), acc: getComputedStyle(document.querySelector('.timeline')).getPropertyValue('--accent').trim() };
  });
  ok(layout.count === 12 && layout.sameX && layout.down, `all ${layout.count} tools stand in one column`);
  ok(layout.tools.right <= layout.main.left + 1 && layout.main.right <= layout.meter.left + 1, 'tools left, timeline in the middle, meter right');
  ok(!layout.inBar, 'the tools left the top bar');
  ok(layout.acc === '#7c5cff', 'the timeline keeps its colour');
  await page.call(() => document.querySelector('.tl-tools [title^="Razor tool"]').click());
  await sleep(100);
  ok(await page.call(() => window.__jimmy.activeTab().ui.get().tool === 'razor'), 'a tool in the column still switches the tool');
  const laneCursor = await page.call(() => getComputedStyle(document.querySelector('.tl-lane')).cursor);
  const shortCursor = laneCursor.replace(/url\("data:[^"]*"\)/g, 'url(…)');
  ok(/image-set\(url\(…\) 1(x|dppx), url\(…\) 2(x|dppx)\)/.test(shortCursor) && /crosshair$/.test(shortCursor), `the Razor tool has its own cursor over the tracks, with a 2x image for scaled screens (${shortCursor})`);
  await page.call(() => document.querySelector('.tl-tools [title^="Selection tool"]').click());
  await sleep(100);
  ok(await page.call(() => !document.querySelector('.volume, .meter') && !document.querySelector('.tl-size')), 'no volume slider or small meter in the playback panel, no size buttons');
  const activeBg = await page.call(() => getComputedStyle(document.querySelector('.tl-toolbar [title^="Snapping"]')).backgroundColor);
  ok(!/124, 92, 255/.test(activeBg), `the snap highlight is grey (${activeBg})`);

  // ------------------------------------------------------------ track height
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
  const left = { button: 'left', buttons: 1, clickCount: 1 };
  const press = async (x, y, mods = 0) => { await mouse('mouseMoved', x, y, { modifiers: mods }); await mouse('mousePressed', x, y, { ...left, modifiers: mods }); };
  const release = (x, y, mods = 0) => mouse('mouseReleased', x, y, { ...left, modifiers: mods });
  const dragTo = async (x0, y0, x1, y1, mods = 0) => {
    await press(x0, y0, mods);
    for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 5, y0 + ((y1 - y0) * i) / 5, { ...left, button: 'left', modifiers: mods });
    await release(x1, y1, mods);
    await sleep(120);
  };
  const click = async (x, y, mods = 0) => { await press(x, y, mods); await release(x, y, mods); await sleep(120); };
  const heights = () => page.call(() => Object.fromEntries([...document.querySelectorAll('[data-row]')].map((r) => [r.dataset.row, [r.getBoundingClientRect().height, r.querySelector('canvas')?.getBoundingClientRect().height]])));
  const rowBox = (kind) => page.call((k) => { const r = document.querySelector(`.tl-row-${k}`).getBoundingClientRect(); return [Math.min(r.left + 400, r.right - 30), r.top + r.height / 2, r.left + 40]; }, kind);
  const cdpWheel = async (x, y, deltaY, mods) => { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods }); await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: mods }); };
  // the same wheel event made inside the page (where the DevTools input route delivers none: GitHub's Macs)
  let wheelInfo = null;
  const domWheel = async (x, y, deltaY, mods) => {
    const r = await page.call((a) => {
      const row = [...document.querySelectorAll('[data-row]')].find((e) => { const b = e.getBoundingClientRect(); return a.y >= b.top && a.y < b.bottom; });
      const hit = document.elementFromPoint(a.x, a.y);
      const el = (row && row.contains(hit) ? hit : row) || hit;
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: a.x, clientY: a.y, deltaY: a.deltaY, deltaMode: 0, altKey: !!(a.mods & 1), ctrlKey: !!(a.mods & 2), metaKey: !!(a.mods & 4), shiftKey: !!(a.mods & 8) });
      el.dispatchEvent(ev);
      return { target: String(el?.className || el?.tagName), row: row?.dataset.row || null, prevented: ev.defaultPrevented, size: [innerWidth, innerHeight] };
    }, { x, y, deltaY, mods });
    if (!wheelInfo) { wheelInfo = r; console.log(`  info  first in-page wheel: ${JSON.stringify(r)}`); }
  };
  let rawWheel = cdpWheel;
  // a wheel with Ctrl in its modifiers is what a pinch sends too: a person's Ctrl+wheel also presses the key (Step 72)
  const ctrlKeyEvent = async (type) => {
    if (rawWheel === cdpWheel) await page.send('Input.dispatchKeyEvent', { type: type === 'down' ? 'rawKeyDown' : 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: type === 'down' ? 2 : 0 });
    else await page.call((d) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key: 'Control', code: 'ControlLeft', ctrlKey: d, bubbles: true })), type === 'down');
  };
  const wheel = async (x, y, deltaY, mods) => {
    if (mods & 2) await ctrlKeyEvent('down');
    await rawWheel(x, y, deltaY, mods);
    if (mods & 2) await ctrlKeyEvent('up');
  };
  const pinch = (x, y, deltaY) => rawWheel(x, y, deltaY, 2); // ctrlKey set, no key held
  const ALT = 1, CTRL_KEY = 2, META = 4; // CDP modifier bits
  const IS_MAC = process.platform === 'darwin';
  // the height key is Ctrl, Cmd on a Mac (like every Ctrl shortcut)
  const CTRL = IS_MAC ? META : CTRL_KEY;
  let mouseOk = true;
  {
    await page.call(() => { window.__wheels = []; window.__moves = 0; window.addEventListener('mousemove', () => { window.__moves++; }, { capture: true }); window.addEventListener('wheel', (e) => window.__wheels.push({ ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, dy: e.deltaY }), { capture: true }); });
    const [x, y] = await rowBox('audio');
    await cdpWheel(x, y, -120, 0); await sleep(150);
    const got = await page.call(() => window.__wheels.length);
    mouseOk = !process.env.JIMMY_TEST_NO_MOUSE && await page.call(() => window.__moves > 0); // JIMMY_TEST_NO_MOUSE: act as on GitHub's Macs
    await cdpWheel(x, y, 120, 0); await sleep(150);
    if (!mouseOk) console.log('  info  DevTools mouse input reaches no page here: the line and Pen checks are skipped');
    if (!got || process.env.JIMMY_TEST_DOM_WHEEL) { rawWheel = domWheel; console.log('  info  DevTools wheel input reaches no page here: the wheel checks send the events inside the page'); }
  }
  const h0 = await heights();
  const ids = Object.keys(h0);
  const audioId = await page.call(() => document.querySelector('.tl-row-audio').dataset.row);
  const [ax, ay, headX] = await rowBox('audio');
  await wheel(ax, ay, -120, CTRL); await sleep(150);
  const h1 = await heights();
  ok(h1[audioId][0] === Math.round(h0[audioId][0] * 1.1), `Ctrl+wheel up over a track makes it 10% taller (${h0[audioId][0]} to ${h1[audioId][0]})`);
  ok(ids.filter((i) => i !== audioId).every((i) => h1[i][0] === h0[i][0]), '…and no other track moves');
  ok(Math.abs(h1[audioId][1] - h1[audioId][0]) < 2, '…and its lane is drawn at the new height');
  await wheel(headX, ay, -120, CTRL); await sleep(150);
  ok((await heights())[audioId][0] > h1[audioId][0], '…also over the track header');
  await wheel(ax, ay, 120, CTRL); await wheel(ax, ay, 120, CTRL); await sleep(150);
  ok((await heights())[audioId][0] === h0[audioId][0], 'Ctrl+wheel down brings it back');
  for (let i = 0; i < 40; i++) await wheel(ax, ay, 120, CTRL);
  await sleep(200);
  const least = (await heights())[audioId][0];
  ok(least >= 32 && least < h0[audioId][0], `it stops at a usable height (${least})`);
  await shot('track-small.png');
  for (let i = 0; i < 12; i++) await wheel(ax, ay, -120, CTRL);
  await sleep(200);
  ok(Object.values(await page.call(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('ce.trackHeights')))))).length === 1, 'the height is remembered per track');
  const pps = () => page.call(() => window.__jimmy.activeTab().ui.get().pps);
  const p0 = await pps();
  await wheel(ax, ay, -120, ALT); await sleep(150);
  const p1 = await pps();
  const hz = (await heights())[audioId][0];
  ok(p1 > p0 * 1.1, `Alt+wheel up zooms the timeline in (${p0.toFixed(1)} to ${p1.toFixed(1)} px/s)`);
  await wheel(ax, ay, 120, ALT); await sleep(150);
  ok(Math.abs((await pps()) - p0) < 0.01 && (await heights())[audioId][0] === hz, 'Alt+wheel down zooms back out, and no track changes height');
  await wheel(ax, ay, -120, CTRL); await sleep(150);
  ok(Math.abs((await pps()) - p0) < 0.01, 'Ctrl+wheel leaves the zoom alone');
  // a trackpad pinch (Ctrl on the wheel event, no Ctrl key held) zooms instead, and no track changes height
  const hp = (await heights())[audioId][0];
  await pinch(ax, ay, -8); await pinch(ax, ay, -8); await pinch(ax, ay, -8); await sleep(150);
  const pz = await pps();
  ok(pz > p0 * 1.1 && (await heights())[audioId][0] === hp, `a trackpad pinch out zooms in (${p0.toFixed(1)} to ${pz.toFixed(1)} px/s), track heights unchanged`);
  await pinch(ax, ay, 8); await pinch(ax, ay, 8); await pinch(ax, ay, 8); await sleep(150);
  ok(Math.abs((await pps()) - p0) < 0.5, 'pinching in zooms back out');
  await wheel(ax, ay, 120, CTRL); await sleep(150);

  // ------------------------------------------------------------ the line on a clip
  // dragged and clicked with the DevTools mouse: skipped, and said so, where that mouse reaches no page (GitHub's Macs)
  if (!mouseOk) console.log('  skip  the line on a clip and the Pen tool (no DevTools mouse input here)');
  else {
  const doc = (sel) => page.call((s) => { const t = window.__jimmy.activeTab(); const c = t.seq.clips.find((x) => (s.type ? x.type === s.type : x.id === s.id)); return { id: c.id, volume: c.volume, opacity: c.transform?.opacity, scale: c.transform?.scale, kf: c.keyframes || {} }; }, sel);
  const box = (id) => page.call((i) => {
    const el = document.querySelector(`[data-clip="${i}"]`);
    const r = el.getBoundingClientRect();
    const l = el.querySelector('.clip-line .line');
    const b = l.getBoundingClientRect();
    const keys = [...el.querySelectorAll('[data-lk]')].map((k) => { const q = k.getBoundingClientRect(); return [(q.left + q.right) / 2, (q.top + q.bottom) / 2]; });
    return { left: r.left, top: r.top, w: r.width, h: r.height, lineY: b.top + b.height / 2, keys, handles: [...el.querySelectorAll('[data-lh]')].length };
  }, id);
  const tool = (t) => page.call((x) => document.querySelector(`.tl-tools [title^="${x}"]`).click(), t);
  const audio = await doc({ type: 'audio' });
  const A = audio.id;
  let b = await box(A);
  ok(Math.abs(b.lineY - (b.top + b.h)) < b.h && b.lineY > b.top + 17, 'an audio clip shows its volume line under the name');
  await dragTo(b.left + 300, b.lineY, b.left + 300, b.lineY + 8);
  let c = await doc({ id: A });
  ok(c.volume < 1 && !c.kf.volume?.length, `Selection tool: dragging the line sets the clip's volume (${c.volume.toFixed(3)})`);
  await page.call(() => window.__jimmy.activeTab().undo());
  await sleep(150);
  ok((await doc({ id: A })).volume === audio.volume, 'Undo takes it back');
  await tool('Pen tool');
  await sleep(100);
  b = await box(A);
  for (const x of [200, 340, 480]) await click(b.left + x, b.lineY);
  c = await doc({ id: A });
  ok(c.kf.volume?.length === 3, `Pen tool: clicking the line adds keyframes (${c.kf.volume?.length})`);
  ok(c.kf.volume.every((k) => Math.abs(k.v - c.volume) < 1e-6), '…at the value of the line');
  b = await box(A);
  await shot('line-keys.png');
  const [k0, k1, k2] = c.kf.volume;
  await dragTo(b.keys[1][0], b.keys[1][1], b.keys[1][0] + 30, b.keys[1][1] + 10);
  c = await doc({ id: A });
  ok(c.kf.volume[1].v < k1.v && c.kf.volume[1].t > k1.t, `dragging a keyframe moves it in time and value (${c.kf.volume[1].t.toFixed(2)}s, ${c.kf.volume[1].v.toFixed(3)})`);
  ok(c.kf.volume[0].t === k0.t && c.kf.volume[2].t === k2.t, '…and leaves the others');
  b = await box(A);
  const before2 = c.kf.volume[1];
  await dragTo(b.keys[1][0], b.keys[1][1], b.keys[1][0] + 40, b.keys[1][1] + 6, 8);
  c = await doc({ id: A });
  ok(c.kf.volume[1].v === before2.v && c.kf.volume[1].t > before2.t, 'Shift keeps the drag on one axis');
  await dragTo(b.left + 20 > 0 ? (await box(A)).keys[2][0] : 0, (await box(A)).keys[2][1], (await box(A)).keys[1][0] - 60, (await box(A)).keys[2][1]);
  c = await doc({ id: A });
  ok(c.kf.volume[2].t > c.kf.volume[1].t, 'a keyframe stops at its neighbour');
  await tool('Selection tool');
  await sleep(100);
  b = await box(A);
  const midX = (b.keys[0][0] + b.keys[1][0]) / 2;
  const segY = await page.call((id, x) => {
    const el = document.querySelector(`[data-clip="${id}"] .clip-line .line`);
    const r = el.getBoundingClientRect();
    let best = 0, gap = 1e9;
    const n = el.getTotalLength();
    for (let i = 0; i < n; i += 2) { const p = el.getPointAtLength(i); const d = Math.abs(p.x + r.left - el.getBBox().x - x); if (d < gap) { gap = d; best = p.y; } }
    return best + el.ownerSVGElement.getBoundingClientRect().top;
  }, A, midX);
  const v0 = c.kf.volume.map((k) => k.v), t0 = c.kf.volume.map((k) => k.t);
  await dragTo(midX, segY, midX, segY + 6);
  c = await doc({ id: A });
  ok(c.kf.volume[0].v < v0[0] && c.kf.volume[1].v < v0[1] && c.kf.volume[2].v === v0[2], 'Selection tool: dragging between two keyframes moves that segment');
  ok(c.kf.volume[0].t === t0[0] && c.kf.volume[1].t === t0[1], '…in value only');
  b = await box(A);
  await click(b.left + 620, b.lineY > 0 ? (await box(A)).keys[2][1] : 0, 2);
  c = await doc({ id: A });
  ok(c.kf.volume.length === 4, 'Ctrl+click on the line adds a keyframe with the Selection tool');
  b = await box(A);
  await click(b.keys[1][0], b.keys[1][1], 2);
  c = await doc({ id: A });
  ok(!!(c.kf.volume[1].in || c.kf.volume[1].out), 'Ctrl+click on a keyframe makes it a curve');
  ok(await page.call(() => !document.querySelector('.menu')), '…without a right-click menu (on a Mac, Ctrl+click is also a right-click)');
  await click(b.keys[1][0], b.keys[1][1]);
  b = await box(A);
  ok(b.handles === 2, `…with ${b.handles} handles when selected`);
  await shot('line-curve.png');
  const hp = await page.call((id) => { const r = document.querySelector(`[data-clip="${id}"] [data-lh$=":out"]`).getBoundingClientRect(); return [(r.left + r.right) / 2, (r.top + r.bottom) / 2]; }, A);
  const out0 = c.kf.volume[1].out;
  // what is under the handle (the Mac run once missed it: this says why)
  const under = await page.call((x, y) => { const el = document.elementFromPoint(x, y); const t = window.__jimmy.activeTab(); return { el: `${el?.tagName}.${el?.getAttribute('class') || ''}${el?.dataset?.lh ? ` lh=${el.dataset.lh}` : ''}`, kfSel: t.ui.get().kfSel, tool: t.ui.get().tool, tracks: document.querySelector('.tl-tracks')?.className, view: [innerWidth, innerHeight] }; }, hp[0], hp[1]);
  await dragTo(hp[0], hp[1], hp[0] + 14, hp[1] - 8);
  c = await doc({ id: A });
  const reshaped = c.kf.volume[1].out.speed !== out0.speed;
  if (!reshaped) console.log(`  info  under the handle before the drag: ${JSON.stringify(under)}`);
  ok(reshaped, `dragging a handle reshapes the curve (${JSON.stringify(out0)} to ${JSON.stringify(c.kf.volume[1].out)}, at ${hp})`);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await sleep(200);
  c = await doc({ id: A });
  ok(c.kf.volume.length === 3, 'Delete removes the selected keyframe, not the clip');
  ok(await page.call((id) => { const t = window.__jimmy.activeTab(); return t.seq.clips.some((x) => x.id === id); }, A), '…the clip stays');
  const gain = await page.call(async (id) => {
    const { audioGainAt } = await import('/js/core/model.js');
    const t = window.__jimmy.activeTab(), cl = t.seq.clips.find((x) => x.id === id);
    return cl.keyframes.volume.map((k) => [audioGainAt(cl, cl.start + k.t), k.v]);
  }, A);
  ok(gain.every(([g, v]) => Math.abs(g - v) < 1e-9), 'playback uses the keyframes');

  // a picture clip: opacity first, the name on the clip chooses another property
  const V = (await page.call(() => { const t = window.__jimmy.activeTab(); const c = t.seq.clips.filter((x) => x.type === 'video' && !t.ui.get().selection.includes(x.id)).sort((p, q) => q.duration - p.duration)[0]; return c.id; }));
  b = await box(V);
  const before3 = (await doc({ id: V })).opacity ?? 1;
  await dragTo(b.left + b.w / 2, b.lineY, b.left + b.w / 2, b.lineY + 8);
  c = await doc({ id: V });
  ok(c.opacity < before3, `a video clip's line is its opacity (${c.opacity.toFixed(2)})`);
  await page.call((id) => document.querySelector(`[data-clip="${id}"] .clip-prop`).click(), V);
  await sleep(150);
  await page.call(() => [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('Scale')).click());
  await sleep(150);
  ok(await page.call((id) => document.querySelector(`[data-clip="${id}"] .clip-prop`).textContent === 'Scale', V), 'the name on the clip switches the line to another property');
  await tool('Pen tool');
  await sleep(100);
  b = await box(V);
  await click(b.left + b.w / 2, b.lineY);
  c = await doc({ id: V });
  ok(c.kf.scale?.length === 1 && !c.kf.opacity?.length, 'the Pen then keyframes that property');
  await tool('Selection tool');
  await sleep(100);
  }

  // Settings opens, without the removed engines; the preview still draws
  const settings = await page.call(async () => {
    const { SettingsDialog } = await import('/js/ui/dialogs.js');
    const { openDialog } = await import('/js/core/notify.js');
    openDialog(SettingsDialog, {});
    await new Promise((r) => setTimeout(r, 600));
    const text = document.querySelector('.modal')?.textContent || '';
    return { open: text.length > 100, engines: /Render engine|Preview engine/.test(text) };
  });
  ok(settings.open && !settings.engines, 'Settings opens, with no render or preview engine choice');
  await shot('settings.png');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  ok(await page.call(() => { const c = document.querySelector('.viewer-canvas'); const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return !!c.width && d[3] === 255 && !document.querySelector('.viewer-canvas-gl'); }), 'the preview draws with the classic compositor alone');

  // the exact frame on pause
  const exact = () => page.call(() => { const i = document.querySelector('.viewer-exact'); return { on: i.classList.contains('is-on'), w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src')?.length || 0 }; });
  const waitExact = async (want, tries = 80) => { for (let i = 0; i < tries; i++) { if ((await exact()).on === want) return true; await sleep(100); } return false; };
  await page.call(() => { window.__jimmy.activeTab().engine.seek(1.5); });
  const tExact = Date.now();
  const firstExact = await waitExact(true, 300); // the first one may start a render worker
  ok(firstExact, `paused, the preview shows the exact frame (${((Date.now() - tExact) / 1000).toFixed(1)} s)`);
  const size = await exact();
  const fit = await page.call(() => { const c = document.querySelector('.viewer-canvas'); return [c.width, c.height]; });
  // stills are made at 10% of the sequence at least (192x108 for 1080p), for a preview smaller than that too
  const seqWH = await page.call(() => { const s = window.__jimmy.activeTab().seq; return [s.width, s.height]; });
  const want = fit[0] >= 192 ? fit : [192, Math.round(192 * seqWH[1] / seqWH[0])];
  ok(Math.abs(size.w - want[0]) <= 1 && Math.abs(size.h - want[1]) <= 1, `…at the preview's size (${size.w}x${size.h}, preview ${fit[0]}x${fit[1]})`);
  const shown = await page.call(async () => {
    const t = window.__jimmy.activeTab(), s = t.seq;
    const r = await (await fetch(`/api/p/${t.projectId}/exact-frame`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sequenceId: s.id, time: Math.round(t.engine.t * s.fps) / s.fps, maxSide: 3840 }) })).json();
    return { len: r.png?.length || 0, jobs: (await (await fetch('/api/jobs')).json()).jobs.filter((j) => j.kind === 'still' && /Frame/.test(j.label)).length };
  });
  ok(shown.len > 1000, 'the server renders it on request');
  await page.call(() => { window.__jimmy.activeTab().engine.seek(2.5); });
  ok(await waitExact(false), 'moving the playhead hides it at once');
  ok(await waitExact(true), '…and the new frame comes back');
  await page.call(() => { const t = window.__jimmy.activeTab(); t.engine.toggle(); });
  ok(await waitExact(false), 'playing hides it');
  await page.call(() => { const t = window.__jimmy.activeTab(); t.engine.pause(); });
  ok(await waitExact(true), 'pausing brings it back');
  await page.call(() => { const t = window.__jimmy.activeTab(); t.apply('Rename', (d, ds) => { ds.name = `${ds.name} `; }); });
  ok(await waitExact(false), 'an edit hides it, so it can never be stale');
  ok(await waitExact(true), '…and it comes back after the save');
  await page.call(async () => { await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exactPause: false }) }); window.__jimmy.app.set({ server: await (await fetch('/api/state')).json() }); });
  ok(await waitExact(false), 'the setting turns it off');
  await page.call(() => { window.__jimmy.activeTab().engine.seek(3.5); });
  await sleep(1200);
  ok(!(await exact()).on, '…and it stays off');
  await page.call(async () => { await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exactPause: true }) }); window.__jimmy.app.set({ server: await (await fetch('/api/state')).json() }); });

  // the chat: Claude Code's notes stay out of it
  const chat = await page.call(async () => {
    const { buildItems } = await import('/js/ui/ClaudeChat.js');
    const note = '<task-notification>\n<task-id>x</task-id>\n<event>[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>';
    const done = '<task-notification>\n<task-id>y</task-id>\n<status>completed</status>\n</task-notification>';
    const u = (content) => ({ type: 'user', message: { content } });
    const a = (id, content) => ({ type: 'assistant', message: { id, content } });
    const kinds = (log) => (buildItems(log).items || buildItems(log)).map((i) => i.kind).join();
    return {
      quiet: kinds([u('hello'), a('1', [{ type: 'text', text: 'hi' }]), { type: 'result' }, u(note), a('2', [{ type: 'text', text: 'Nothing needed.' }]), { type: 'result', usage: { input: 1 } }]),
      done: kinds([u(done), a('3', [{ type: 'text', text: 'It finished.' }]), { type: 'result' }]),
      work: kinds([u(note), a('4', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]), { type: 'result' }]),
    };
  });
  ok(chat.quiet === 'user,assistant', `a housekeeping note and Claude's answer don't show (${chat.quiet})`);
  ok(chat.done === 'assistant', `a finished-command note doesn't show, Claude's reply does (${chat.done})`);
  ok(chat.work === 'assistant', `real work after a note shows (${chat.work})`);

  // ------------------------------------------------------------ meter
  const read = () => page.call(() => {
    const cv = document.querySelector('.audio-meter canvas');
    const c = cv.getContext('2d');
    const d = window.devicePixelRatio || 1;
    const lit = (x) => {
      const { data } = c.getImageData(x * d, 0, 1, cv.height);
      let green = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) { if (data[i + 3] && data[i + 1] > 150 && data[i + 1] > data[i] + 40) green++; if (data[i + 3] && Math.max(data[i], data[i + 1], data[i + 2]) > 90) n++; }
      return [n, green];
    };
    return [lit(12), lit(26)];
  });
  // the audio this machine has (GitHub's Macs are virtual: maybe no sound device, so the clock may not run)
  const audioInfo = await page.call(async () => { const { actx } = (await import('/js/core/playback.js')).audioGraph(); const t0 = actx.currentTime; await new Promise((r) => setTimeout(r, 500)); return { state: actx.state, rate: actx.sampleRate, clockRan: +(actx.currentTime - t0).toFixed(3), latency: actx.baseLatency }; });
  console.log(`  info  audio here: ${JSON.stringify(audioInfo)}`);
  const idle = await read();
  ok(idle[0][1] === 0 && idle[1][1] === 0, 'nothing lit while stopped');
  const rect = await page.call(() => { const r = document.querySelector('.play-btn').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  if (mouseOk) for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect[0], y: rect[1], button: 'left', clickCount: 1 });
  else await page.call(() => document.querySelector('.play-btn').click()); // no DevTools mouse here: press Play in the page
  let best = [0, 0], bothColoured = false;
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    const v = await read();
    best = [Math.max(best[0], v[0][1]), Math.max(best[1], v[1][1])];
    if (v[0][1] && v[1][1]) bothColoured = true;
  }
  ok(bothColoured, `real playback lights both bars green (${best.join(', ')} px)`);
  await shot('playing-dark.png');
  const before = await page.call(async () => { const t = window.__jimmy.activeTab(); return t.engine.playing; });
  const silenced = await page.call(async () => {
    const g = (await import('/js/core/playback.js')).audioGraph();
    const was = g.master.gain.value;
    g.master.gain.value = 0;
    await new Promise((r) => setTimeout(r, 300));
    const buf = new Float32Array(g.meters[0].fftSize);
    let peak = 0;
    for (let i = 0; i < 15; i++) { g.meters[0].getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); await new Promise((r) => setTimeout(r, 60)); }
    g.master.gain.value = was;
    return peak;
  });
  ok(before && silenced > 0.001, `turning the monitor volume down leaves the meter reading (${silenced.toFixed(3)})`);
  await page.call(() => window.__jimmy.activeTab().engine.pause());
  await sleep(3500);
  const rest = await read();
  ok(rest[0][1] === 0 && rest[1][1] === 0, 'after stopping the bars fall back');

  // ------------------------------------------------------------ light
  await page.call(async () => { (await import('/js/core/theme.js')).applyTheme('light'); });
  await sleep(300);
  const [lbg, lac] = await vars();
  ok(lbg === '#ececec' && lac === '#000000', `Light is white and black (${lbg}, ${lac})`);
  ok(await page.call(() => getComputedStyle(document.querySelector('.timeline')).getPropertyValue('--accent').trim() === '#6a4cf0'), '…and the timeline keeps its colour');
  await shot('project-light.png');
  await page.call(async () => { (await import('/js/core/theme.js')).applyTheme('dark'); });
  await sleep(200);
  await shot('project-dark.png');
  const themes = await page.call(async () => (await import('/js/core/theme.js')).THEMES.map((t) => t.id).join());
  ok(themes === 'dark,light', `only two themes (${themes})`);
} finally {
  page?.close();
  await srv.stop();
  if (keep) fs.writeFileSync(PROJECT, keep);
}
console.log(failed ? `timeline-ui: ${failed} failed` : 'timeline-ui: all checks passed');
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
  // a window macOS hasn't made active gets no DevTools input (GitHub's Macs): bring it forward, act as focused
  await send('Page.bringToFront').catch(() => {});
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return { send, call, close: () => ws.close() };
}
