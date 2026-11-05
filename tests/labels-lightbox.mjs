// Clip label colours (right-click › Label, as in Premiere) and the chat's full-size picture, in the desktop app:
// a label colours the clip and its linked partner, is saved, undoes, and None takes it back to the type's colour;
// a picture Claude looked at opens over the whole window (not inside its chat row), and click or Esc closes it.
//   JIMMY_APP=electron node tests/labels-lightbox.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, WORK, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9363;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'labels-lightbox');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  await openGolden(); // makes the test media
  const doc = {
    format: 'claude-edit/1', name: 'Labels', settings: { originalNames: 1, nestAudio: 1 }, folders: [],
    media: [{ id: 'm_tone', path: path.join(GOLDEN_DIR, 'media', 'tone.wav').replace(/\\/g, '/') }],
    sequences: [{
      id: 's1', name: 'Labels', width: 1920, height: 1080, fps: 30,
      tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
      clips: [
        { id: 'c_s', type: 'solid', track: 'v1', start: 0, duration: 3, color: '#e04040', link: 'l1' },
        { id: 'c_a', type: 'audio', track: 'a1', media: 'm_tone', start: 0, duration: 3, in: 0, volume: 1, link: 'l1' },
        { id: 'c_t', type: 'text', track: 'v1', start: 4, duration: 2, text: 'Title' },
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
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('[data-clip="c_s"]')).catch(() => false)) break; await sleep(200); }
  await page.call(() => { const t = window.__jimmy.activeTab(); t.ui.set({ pps: 80, scrollX: 0, tool: 'select' }); });
  await sleep(300);
  const shot = async (name) => { if (!SHOTS) return; const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const centre = (sel) => page.call((s) => { const el = document.querySelector(s); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.left + Math.min(40, r.width / 2), r.top + r.height / 2]; }, sel);
  const colour = (cid) => page.call((c) => getComputedStyle(document.querySelector(`[data-clip="${c}"]`)).getPropertyValue('--c').trim(), cid);
  const labels = () => page.call(() => Object.fromEntries(window.__jimmy.activeTab().seq.clips.map((c) => [c.id, c.label || null])));
  const key = async (k, code, vk, mods = 0) => { await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(250); };
  // right-click a clip, hover "Label", click a colour in the submenu (real mouse)
  const pickLabel = async (cid, name) => {
    const [x, y] = await centre(`[data-clip="${cid}"]`);
    await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(300);
    const item = (label) => page.call((l) => { const el = [...document.querySelectorAll('.menu-item')].find((m) => m.querySelector('.menu-label')?.textContent === l); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; }, label);
    const lab = await item('Label');
    if (!lab) return false;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lab[0], y: lab[1] });
    await sleep(250);
    const c = await item(name);
    if (!c) return false;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c[0], y: c[1] });
    await mouse('mousePressed', c[0], c[1]); await mouse('mouseReleased', c[0], c[1]);
    await sleep(400);
    return true;
  };

  const before = await colour('c_s');
  ok(await pickLabel('c_s', 'Rose'), 'right-click › Label › Rose is there');
  await shot('label-rose.png');
  let L = await labels();
  ok(L.c_s === 'rose' && L.c_a === 'rose' && L.c_t === null, `the clip and its linked sound get the label, nothing else (${JSON.stringify(L)})`);
  ok((await colour('c_s')) === '#f45b8e' && (await colour('c_a')) === '#f45b8e', `both are drawn in it (${await colour('c_s')}, was ${before})`);
  for (let i = 0; i < 20; i++) { const s = JSON.parse(fs.readFileSync(path.join(DIR, 'project.json'), 'utf8')); if (s.sequences[0].clips.find((c) => c.id === 'c_s').label === 'rose') break; await sleep(200); }
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'project.json'), 'utf8')).sequences[0].clips;
  ok(saved.find((c) => c.id === 'c_s').label === 'rose' && !('label' in saved.find((c) => c.id === 'c_t')), 'saved in project.json (only where set)');
  await key('z', 'KeyZ', 90, 2);
  ok((await labels()).c_s === null && (await colour('c_s')) === before, 'Undo takes it off');
  await key('z', 'KeyZ', 90, 10); // Ctrl+Shift+Z
  ok((await labels()).c_s === 'rose', 'Redo puts it back');
  ok(await pickLabel('c_t', 'Mango'), 'another clip, another colour');
  ok((await labels()).c_t === 'mango' && (await colour('c_t')) === '#f89d33', 'the title is mango');
  ok(await pickLabel('c_s', 'None (by type)'), 'None (by type) is offered');
  L = await labels();
  ok(L.c_s === null && L.c_a === null && (await colour('c_s')) === before, `None takes the clip back to its type's colour (${await colour('c_s')})`);
  ok((await page.call(() => [...document.querySelectorAll('.menu-swatch')].length)) === 0, 'the menu has closed');

  // the full-size picture: over the whole window, from inside a contained chat row
  const lb = await page.call(async () => {
    const { openLightbox } = await import('/js/ui/ClaudeChat.js');
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; // a frame, as Claude's are
    const g = c.getContext('2d'); g.fillStyle = '#3080ff'; g.fillRect(0, 0, 1920, 1080);
    openLightbox(c.toDataURL());
    await new Promise((r) => setTimeout(r, 200));
    const box = document.querySelector('.cc-lightbox');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), W: innerWidth, H: innerHeight, inBody: box.parentElement?.parentElement === document.body, img: Math.round(box.querySelector('img').getBoundingClientRect().width) };
  });
  ok(lb && lb.w === lb.W && lb.h === lb.H, `the picture opens over the whole window (${lb ? `${lb.w}×${lb.h} of ${lb.W}×${lb.H}` : 'not shown'})`);
  ok(lb?.inBody, '…outside the chat, so no chat row can contain it');
  ok(lb?.img >= Math.min(1920, lb?.W * 0.9), `…and is shown big, up to 92 % of the window (${lb?.img} px wide)`);
  await shot('lightbox.png');
  await key('Escape', 'Escape', 27);
  ok(!(await page.call(() => !!document.querySelector('.cc-lightbox'))), 'Esc closes it');
  await page.call(async () => { const { openLightbox } = await import('/js/ui/ClaudeChat.js'); openLightbox('data:image/gif;base64,R0lGODlhAQABAAAAACw='); });
  await sleep(200);
  const [cx, cy] = await page.call(() => [innerWidth / 2, 20]);
  await mouse('mousePressed', cx, cy); await mouse('mouseReleased', cx, cy);
  await sleep(200);
  ok(!(await page.call(() => !!document.querySelector('.cc-lightbox'))), 'a click closes it');

  // the logo: the app's marks use the new icon
  const mark = await page.call(() => { const m = document.querySelector('.brand-mark'); return m ? { src: m.getAttribute('src'), w: m.naturalWidth } : null; });
  ok(mark && /icon\.svg$/.test(mark.src) && mark.w > 0, `the logo mark loads (${mark?.src}, ${mark?.w} px)`);
  const svg = await (await fetch(`http://127.0.0.1:${PORT}/icon.svg`)).text();
  ok(/id="character"/.test(svg) && !/<title>/.test(svg), 'icon.svg is the new logo, without its title');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `labels-lightbox: ${failed} failed` : 'labels-lightbox: all checks passed');
process.exit(failed ? 1 : 0);

async function connectPage() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`) && !/render\.html|motion/.test(t.url)); } catch { /* not up yet */ }
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
