// Selecting a gap on the timeline (Premiere's way): clicking the empty stretch between two clips selects that gap on
// that track only, shown as a white box (nothing shows before); Delete ripple-deletes it, moving every unlocked track
// left so the sequence stays in sync; a clip on another track inside the gap stops it, with a message; Esc and a
// drag don't select it; Undo brings it back. Real mouse and keys in the desktop app.
//   JIMMY_APP=electron node tests/gap-select.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, WORK, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9361;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'gap-select');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  await openGolden(); // makes the test media (the tone for the audio track)
  const solid = (id, track, start, duration, color) => ({ id, type: 'solid', track, start, duration, color });
  const doc = {
    format: 'claude-edit/1', name: 'Gaps', settings: { originalNames: 1 }, folders: [],
    media: [{ id: 'm_tone', path: path.join(GOLDEN_DIR, 'media', 'tone.wav').replace(/\\/g, '/') }],
    sequences: [{
      id: 's1', name: 'Gaps', width: 1920, height: 1080, fps: 30,
      tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'v3', kind: 'video', locked: true }, { id: 'a1', kind: 'audio' }],
      clips: [
        solid('c_a', 'v1', 0, 2, '#e04040'), solid('c_b', 'v1', 4, 2, '#40a0e0'),
        solid('c_c', 'v2', 6, 1, '#40e080'),
        solid('c_e', 'v3', 5, 1, '#e0c040'),
        { id: 'c_d', type: 'audio', track: 'a1', media: 'm_tone', start: 4, duration: 2, in: 0, volume: 1 },
      ],
    }],
  };
  fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(doc, null, 2));
  const { id } = await api('POST', '/api/projects/open', { path: DIR });

  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('[data-lane="v1"]')).catch(() => false)) break; await sleep(200); }
  await page.call(() => { const t = window.__jimmy.activeTab(); t.ui.set({ pps: 80, scrollX: 0, tool: 'select' }); });
  await sleep(300);
  const shot = async (name) => { if (!SHOTS) return; const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };

  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  // on a small screen (GitHub's Macs: 1024×642) the timeline shows a track or two: the lane is scrolled into view first
  const at = (track, t) => page.call((tr, tt) => { const el = document.querySelector(`[data-lane="${tr}"]`); el.scrollIntoView({ block: 'nearest' }); const lane = el.getBoundingClientRect(); const ui = window.__jimmy.activeTab().ui.get(); return [lane.left + tt * ui.pps - ui.scrollX, lane.top + lane.height / 2]; }, track, t);
  const click = async (track, t) => { const [x, y] = await at(track, t); await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(200); };
  const key = async (k, code, vk, mods = 0) => { await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(300); };
  const box = () => page.call(() => { const b = document.querySelector('.tl-gap-sel'); if (!b) return null; const lane = b.closest('[data-lane]'); const ui = window.__jimmy.activeTab().ui.get(); return { track: lane.dataset.lane, start: (parseFloat(b.style.left) + ui.scrollX) / ui.pps, end: (parseFloat(b.style.left) + ui.scrollX + parseFloat(b.style.width)) / ui.pps, border: getComputedStyle(b).borderTopColor }; });
  const starts = () => page.call(() => Object.fromEntries(window.__jimmy.activeTab().seq.clips.map((c) => [c.id, +c.start.toFixed(3)])));

  ok(!(await box()), 'no box on any gap before one is selected');
  await click('v1', 3);
  let b = await box();
  ok(b && b.track === 'v1' && Math.abs(b.start - 2) < 0.02 && Math.abs(b.end - 4) < 0.02, `clicking the gap selects it on V1 only (${b ? `${b.track} ${b.start.toFixed(2)}–${b.end.toFixed(2)} s` : 'nothing'})`);
  ok(b?.border === 'rgb(255, 255, 255)', `…shown as a white box (${b?.border})`);
  await shot('gap-selected.png');
  await key('Delete', 'Delete', 46);
  let s = await starts();
  ok(s.c_b === 2, `Delete closes it: the clip after it on V1 moves to 2 s (${s.c_b})`);
  ok(s.c_c === 4 && s.c_d === 2, `…and every other unlocked track moves with it: V2 6 → ${s.c_c} s, A1 4 → ${s.c_d} s`);
  ok(s.c_e === 5 && s.c_a === 0, 'a locked track stays, and clips before the gap stay');
  ok(!(await box()), 'the box is gone');
  await key('z', 'KeyZ', 90, 2);
  s = await starts();
  ok(s.c_b === 4 && s.c_c === 6 && s.c_d === 4, 'Undo puts everything back');

  // Backspace does it too
  await click('v1', 2.5);
  await key('Backspace', 'Backspace', 8);
  ok((await starts()).c_b === 2, 'Backspace closes a selected gap too');
  await key('z', 'KeyZ', 90, 2);

  // a clip on another track inside the gap stops it
  await page.call(() => window.__jimmy.activeTab().apply('Add', (d, ds) => { ds.clips.push({ id: 'c_f', type: 'solid', track: 'v2', start: 2.5, duration: 1, color: '#ffffff', transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }); }));
  await sleep(300);
  await click('v1', 3.8);
  await key('Delete', 'Delete', 46);
  s = await starts();
  const toast = await page.call(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));
  ok(s.c_b === 4 && s.c_c === 6, 'with a clip on V2 inside the gap nothing moves');
  ok(/Can't close this gap: V2 has a clip/.test(toast), `…and it says why (${toast.slice(0, 90)})`);
  await page.call(() => window.__jimmy.activeTab().apply('Remove', (d, ds) => { ds.clips = ds.clips.filter((c) => c.id !== 'c_f'); }));
  await sleep(300);

  // Esc, a drag, a click after the last clip, a clip click
  await click('v1', 3);
  ok(!!(await box()), 'selected again');
  await key('Escape', 'Escape', 27);
  ok(!(await box()), 'Esc lets go of it');
  const [x0, y0] = await at('v1', 2.3), [x1] = await at('v1', 3.7);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= 5; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 5, y: y0, button: 'left', buttons: 1 });
  await mouse('mouseReleased', x1, y0);
  await sleep(200);
  ok(!(await box()), 'dragging across it draws a selection box instead, no gap');
  await click('v1', 8);
  ok(!(await box()), 'the empty end of a track is not a gap');
  await click('v1', 3);
  await click('v1', 1);
  ok(!(await box()) && (await page.call(() => window.__jimmy.activeTab().ui.get().selection.includes('c_a'))), 'clicking a clip selects the clip and drops the gap');
  // a locked track's gaps can't be selected
  await page.call(() => window.__jimmy.activeTab().apply('Lock', (d, ds) => { ds.tracks.find((t) => t.id === 'v1').locked = true; }));
  await sleep(200);
  await click('v1', 3);
  ok(!(await box()), 'a gap on a locked track can\'t be selected');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `gap-select: ${failed} failed` : 'gap-select: all checks passed');
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
