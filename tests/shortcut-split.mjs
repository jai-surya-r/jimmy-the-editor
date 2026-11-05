// A layout that put a single key (W, for example) on "Cut" (to the clipboard) meant it to slice clips: on first load
// the key moves to "Add edit", Cut gets Ctrl+X back, and the layout is saved at the new version so it happens once.
// Then, in the real desktop app: W slices the clips under the playhead (or only the selected one), Ctrl+X still cuts
// to the clipboard, and a single key put on Cut after the change stays there.
//   JIMMY_APP=electron node tests/shortcut-split.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, WORK, PORT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9351;
const CONFIG = path.join(WORK, 'app-data', 'config.json');
const PROJECT = path.join(GOLDEN_DIR, 'project.json');

// such a layout as saved before this change (no version)
const OWNER = { preset: 'Custom', presets: { Custom: { 'tl.trimNext': ['E'], 'ed.cut': ['W'] } } };
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
const cfg0 = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg0, keymap: OWNER }, null, 2));
const keep = fs.existsSync(PROJECT) ? fs.readFileSync(PROJECT) : null;

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((p) => { window.__jimmy.openProject(p); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.tl-row')).catch(() => false)) break; await sleep(200); }
  await sleep(500);

  // ------------------------------------------------------------ the saved layout
  let saved = null;
  for (let i = 0; i < 30; i++) { saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).keymap; if (saved?.v) break; await sleep(200); }
  const c = saved?.presets?.Custom || {};
  ok(saved?.v === 2, `the layout was saved at version 2 (${saved?.v})`);
  ok(JSON.stringify(c['tl.split']) === '["Ctrl+K","W"]', `W is on Add edit, next to Ctrl+K (${JSON.stringify(c['tl.split'])})`);
  ok(!('ed.cut' in c), 'Cut is back on its own Ctrl+X');
  ok(JSON.stringify(c['tl.trimNext']) === '["E"]', 'the rest of the layout is kept (E: ripple trim next)');
  ok(saved?.preset === 'Custom', 'the user\'s layout stays the chosen one');

  // ------------------------------------------------------------ W slices at the playhead
  const key = async (k, mods = 0) => {
    const code = /^[A-Z]$/.test(k) ? `Key${k}` : k;
    const vk = /^[A-Z]$/.test(k) ? k.charCodeAt(0) : 0;
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: mods ? k.toLowerCase() : k.toLowerCase(), code, windowsVirtualKeyCode: vk, modifiers: mods });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.toLowerCase(), code, windowsVirtualKeyCode: vk, modifiers: mods });
    await sleep(250);
  };
  const state = () => page.call(() => { const t = window.__jimmy.activeTab(); return { n: t.seq.clips.length, seq: t.seq.id, t: t.time.get().t, under: t.seq.clips.filter((c) => c.start < t.time.get().t - 1e-6 && c.start + c.duration > t.time.get().t + 1e-6).map((c) => c.id) }; });
  const focusTimeline = () => page.call(() => { document.activeElement?.blur?.(); document.querySelector('.tl-tracks')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  await page.call(() => { const t = window.__jimmy.activeTab(); t.select([]); t.engine.seek(1.5); });
  await sleep(300);
  await focusTimeline();
  const a = await state();
  ok(a.under.length >= 1, `the playhead (${a.t.toFixed(2)} s) is over ${a.under.length} clip(s)`);
  await page.call(() => { window.__keys = []; window.addEventListener('keydown', (e) => window.__keys.push(e.code), { capture: true }); });
  await key('W');
  const b = await state();
  console.log(`  info  the page got keys ${JSON.stringify(await page.call(() => window.__keys))}, has focus ${await page.call(() => document.hasFocus())}`);
  if (b.n === a.n) {
    // what is on screen when a key does nothing
    console.log(`  info  on screen: ${JSON.stringify(await page.call(() => ({ dialog: document.querySelector('.modal')?.textContent?.slice(0, 300) || null, active: document.activeElement?.tagName + '.' + (document.activeElement?.className || ''), overlays: [...document.querySelectorAll('.modal-backdrop, .toast, .banner, [role=dialog]')].map((e) => e.className).slice(0, 5), tab: !!window.__jimmy.activeTab()?.seq })))}`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(WORK, 'suite'), { recursive: true });
    fs.writeFileSync(path.join(WORK, 'suite', 'shortcut-split-screen.png'), Buffer.from(data, 'base64'));
  }
  ok(b.n === a.n + a.under.length, `W with nothing selected slices every clip under the playhead (${a.n} to ${b.n} clips)`);
  const cutAt = await page.call((t) => window.__jimmy.activeTab().seq.clips.some((c) => Math.abs(c.start - t) < 1e-3), a.t);
  ok(cutAt, '…exactly at the playhead');
  await key('Z', 2); // Ctrl+Z
  ok((await state()).n === a.n, 'Undo puts it back');

  // only the selected clip
  await page.call((ids) => window.__jimmy.activeTab().select([ids[0]]), a.under);
  await key('W');
  ok((await state()).n === a.n + 1, 'with a clip selected, W slices only that clip');
  await key('Z', 2);

  // Ctrl+X is the clipboard cut again
  await page.call((ids) => window.__jimmy.activeTab().select([ids[0]]), a.under);
  await key('X', 2);
  const x = await state();
  ok(x.n === a.n - 1 && !x.under.includes(a.under[0]), 'Ctrl+X still cuts the selected clip to the clipboard');
  await key('Z', 2);
  await page.call(() => window.__jimmy.activeTab().select([]));

  // ------------------------------------------------------------ a later, deliberate choice is kept
  await api('POST', '/api/settings', { keymap: { preset: 'Custom', v: 2, presets: { Custom: { 'tl.trimNext': ['E'], 'tl.split': ['Ctrl+K', 'W'], 'ed.cut': ['X'] } } } });
  await page.call(() => location.reload());
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.tl-row')).catch(() => false)) break; await sleep(200); }
  await sleep(800);
  const later = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).keymap;
  ok(JSON.stringify(later.presets.Custom['ed.cut']) === '["X"]', 'a single key put on Cut at the new version stays there');
  await page.call((ids) => window.__jimmy.activeTab().select([ids[0]]), a.under);
  await focusTimeline();
  const y0 = await state();
  await key('X');
  ok((await state()).n === y0.n - 1, '…and works as Cut');
  await key('Z', 2);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  if (keep) fs.writeFileSync(PROJECT, keep);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  delete cfg.keymap;
  if (cfg0.keymap) cfg.keymap = cfg0.keymap;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}
console.log(failed ? `shortcut-split: ${failed} failed` : 'shortcut-split: all checks passed');
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
