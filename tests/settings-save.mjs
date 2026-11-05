// Settings take effect only on Save: a theme being tried out goes back on Cancel, other choices and the cache folder
// aren't saved until Save, and unsaved choices survive a trip to Keyboard shortcuts and back.
//   JIMMY_APP=electron node tests/settings-save.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9357;
const CACHE = path.join(WORK, 'settings-save-cache');
fs.mkdirSync(CACHE, { recursive: true });

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
const before = await api('GET', '/api/state');
try {
  await api('POST', '/api/settings', { proxyMode: 'auto', cacheDir: CACHE });
  page = await connectPage();
  await page.call(() => { localStorage.setItem('ce.theme', '"dark"'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }

  const open = () => page.call(async () => { const { SettingsDialog } = await import('/js/ui/dialogs.js'); const { openDialog } = await import('/js/core/notify.js'); openDialog(SettingsDialog, {}); });
  const waitModal = async (title) => { for (let i = 0; i < 40; i++) { if (await page.call((t) => document.querySelector('.modal-head h2')?.textContent === t, title)) return true; await sleep(100); } return false; };
  const button = (label) => page.call((l) => { const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === l); b?.click(); return !!b; }, label);
  const segment = (field, label) => page.call((f, l) => { const fl = [...document.querySelectorAll('.modal .field')].find((x) => x.querySelector('span')?.textContent === f); const b = [...fl.querySelectorAll('.segmented button')].find((x) => x.textContent.trim() === l); b?.click(); return !!b; }, field, label);
  const theme = () => page.call(() => [document.documentElement.dataset.theme, JSON.parse(localStorage.getItem('ce.theme'))]);
  const state = () => api('GET', '/api/state');

  // ------------------------------------------------------------ Cancel changes nothing
  await open(); ok(await waitModal('Settings'), 'Settings opens');
  await page.call(() => [...document.querySelectorAll('.theme-card')].find((b) => b.textContent.includes('Light')).click());
  await sleep(150);
  let th = await theme();
  ok(th[0] === 'light' && th[1] === 'dark', `a theme card shows the theme at once but doesn't keep it (${th})`);
  ok(await segment('Preview proxies', 'Always'), 'a setting is changed (Preview proxies: Always)');
  await page.call(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === 'Reset')?.click());
  await sleep(150);
  ok(await page.call(() => /Not set/.test(document.querySelector('.modal .codebox')?.textContent || '')), 'Reset shows the cache folder as not set');
  ok((await state()).proxyMode === 'auto' && (await state()).cacheDir === CACHE, '…but nothing is saved yet');
  await button('Cancel');
  await sleep(300);
  th = await theme();
  ok(th[0] === 'dark' && th[1] === 'dark', `Cancel puts the saved theme back (${th})`);
  const s1 = await state();
  ok(s1.proxyMode === 'auto' && s1.cacheDir === CACHE, 'Cancel leaves the settings and the cache folder as they were');

  // the window's X does the same
  await open(); await waitModal('Settings');
  await page.call(() => [...document.querySelectorAll('.theme-card')].find((b) => b.textContent.includes('Light')).click());
  await page.call(() => document.querySelector('.modal-head .icon-btn').click());
  await sleep(300);
  ok((await theme())[0] === 'dark', 'closing with X puts it back too');

  // ------------------------------------------------------------ unsaved choices survive a side trip
  await open(); await waitModal('Settings');
  await page.call(() => [...document.querySelectorAll('.theme-card')].find((b) => b.textContent.includes('Light')).click());
  await segment('Preview proxies', 'Always');
  await button('Keyboard shortcuts…');
  ok(await waitModal('Keyboard Shortcuts'), 'Keyboard shortcuts opens from Settings');
  ok((await theme())[0] === 'light', '…the theme being tried stays on meanwhile');
  await button('Cancel');
  ok(await waitModal('Settings'), 'Settings comes back afterwards');
  ok(await page.call(() => document.querySelector('.theme-card.is-on')?.textContent.includes('Light')), '…with the theme still chosen');
  ok(await page.call(() => [...document.querySelectorAll('.modal .field')].find((x) => x.querySelector('span')?.textContent === 'Preview proxies').querySelector('button.is-active')?.textContent.trim() === 'Always'), '…and the unsaved Always still chosen');
  ok((await state()).proxyMode === 'auto', '…still not saved');

  // ------------------------------------------------------------ Save keeps it all
  await page.call(() => [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.trim() === 'Reset')?.click());
  await sleep(100);
  await button('Save');
  await sleep(600);
  th = await theme();
  const s2 = await state();
  ok(th[0] === 'light' && th[1] === 'light', `Save keeps the theme (${th})`);
  ok(s2.proxyMode === 'always', 'Save saves the settings');
  ok(!s2.cacheDir, 'Save clears the cache folder that was reset');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await api('POST', '/api/settings', { proxyMode: before.proxyMode || 'auto', cacheDir: before.cacheDir || null }).catch(() => {});
  await page?.call(() => localStorage.setItem('ce.theme', '"dark"')).catch(() => {});
  page?.close();
  await srv.stop();
}
console.log(failed ? `settings-save: ${failed} failed` : 'settings-save: all checks passed');
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
