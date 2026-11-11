// A new user's first start, in the desktop app with a fresh data folder and (pretend) no agents on the computer:
//   • the setup window opens by itself: Claude Code and Codex both "Not installed", Install runs the installer
//     (a stand-in here, JIMMY_FAKE_INSTALL) and says when it is done
//   • closing it starts the home tour, which points at the real parts of the screen and steps with Next / Back
//   • nothing opens again on the next start (no nagging)
//   • the editor tour starts the first time a project is open; Settings › Getting started runs the tour and the setup again
//   JIMMY_APP=electron node tests/welcome.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; return c; };
const DEBUG_PORT = 9366;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'welcome');
const DATA = path.join(WORK, 'welcome-data'); // a brand-new user's data folder
fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ gpu: { asked: true } }));
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'First project', settings: { originalNames: 1, nestAudio: 1 }, folders: [], media: [],
  sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'v1', kind: 'video' }], clips: [{ id: 'c1', type: 'text', track: 'v1', start: 0, duration: 3, text: 'Hello' }] }] }, null, 2));
const env = { JIMMY_NO_WELCOME: '', JIMMY_FAKE_AGENTS: 'none', JIMMY_DATA_DIR: DATA, JIMMY_DEBUG_PORT: String(DEBUG_PORT),
  JIMMY_FAKE_INSTALL: "console.log('Downloading Claude Code…'); setTimeout(() => console.log('Claude Code installed'), 900)" };

let srv = await startServer({ env, visible: true });
let page;
const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };
const until = async (fn, ms = 15000, ...a) => { for (let i = 0; i < ms / 100; i++) { const v = await page.call(fn, ...a).catch(() => null); if (v) return v; await sleep(100); } return null; };
const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const click = async (pt) => { await mouse('mouseMoved', pt[0], pt[1]); await mouse('mousePressed', pt[0], pt[1]); await mouse('mouseReleased', pt[0], pt[1]); await sleep(300); };
const button = (text, scope = 'body') => until((t, s) => { const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === t && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, 8000, text, scope);
try {
  page = await connectPage();
  console.log('First start');
  ok(await until(() => !!document.querySelector('.setup-dialog'), 20000), 'the setup window opens by itself');
  const states = await until(() => { const s = [...document.querySelectorAll('.setup-card')].map((c) => `${c.dataset.agent}: ${c.querySelector('.setup-state').textContent}`); return s.length === 2 && !s.some((x) => /Checking/.test(x)) && s; });
  ok(states && states.every((s) => /Not installed/.test(s)), `with no agent on the computer both say so: ${JSON.stringify(states)}`);
  await shot('1-setup.png');
  await click(await button('Install Claude Code'));
  ok(await until(() => /Installing/.test(document.querySelector('[data-agent="claude"]')?.textContent || ''), 5000), 'Install Claude Code runs the installer and shows its progress');
  ok(await until(() => /Installed\./.test(document.querySelector('[data-agent="claude"]')?.textContent || ''), 15000), 'and says when it has finished');
  await click(await button('Not now'));
  ok(await until(() => !document.querySelector('.setup-dialog')), 'Not now closes it');

  console.log('The home tour');
  ok(await until(() => /Welcome to Jimmy/.test(document.querySelector('.tour-card')?.textContent || '')), 'the tour starts after it');
  await click(await button('Next', '.tour-card'));
  const spot = await until(() => { const s = document.querySelector('.tour-spot')?.getBoundingClientRect(); const t = document.querySelector('.home-create')?.getBoundingClientRect(); return s && t && Math.abs(s.left + 6 - t.left) < 2 && Math.abs(s.top + 6 - t.top) < 2 && document.querySelector('.tour-card h3').textContent; });
  ok(spot === 'Start a project', `step 2 highlights the New project buttons ("${spot}")`);
  ok(await page.call(() => /Can't:/.test(document.querySelector('.tour-card').textContent)), 'and says what it can\'t do');
  await shot('2-tour-home.png');
  await click(await button('Back', '.tour-card'));
  ok(await page.call(() => /Welcome to Jimmy/.test(document.querySelector('.tour-card').textContent)), 'Back goes to the previous step');
  for (let i = 0; i < 6 && (await page.call(() => !!document.querySelector('.tour-card'))); i++) await click(await button(i < 4 ? 'Next' : 'Done', '.tour-card') || await button('Done', '.tour-card'));
  ok(await until(() => !document.querySelector('.tour')), 'Done ends the tour');

  console.log('The next start');
  await page.call(() => { location.reload(); return true; });
  await sleep(4000);
  ok(await page.call(() => !document.querySelector('.setup-dialog') && !document.querySelector('.tour')), 'nothing opens by itself any more');
  // the window's storage gone (the desktop app used to start on a new port each time, and lost it): the server remembers
  await page.call(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('jimmy.')) localStorage.removeItem(k); location.reload(); return true; });
  await sleep(4000);
  ok(await page.call(() => !document.querySelector('.setup-dialog') && !document.querySelector('.tour')), 'not even when the window has forgotten everything (the server keeps what was seen)');
  ok(JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).seen?.home === true, 'config.json keeps the tour as seen');

  console.log('The editor tour');
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((p) => { window.__jimmy.openProject(p); return true; }, id);
  ok(await until(() => /Three workspaces/.test(document.querySelector('.tour-card')?.textContent || ''), 20000), 'opening a project the first time starts the editor tour');
  const steps = [];
  for (let i = 0; i < 9 && (await page.call(() => !!document.querySelector('.tour-card'))); i++) {
    steps.push(await page.call(() => ({ title: document.querySelector('.tour-card h3').textContent, spot: !!document.querySelector('.tour-spot') })));
    if (i === 5) await shot('3-tour-claude.png');
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(300);
  }
  const pointed = steps.filter((s) => s.spot).map((s) => s.title);
  ok(steps.length === 9 && pointed.length >= 7, `its steps point at the parts they explain (${pointed.join(', ')}); the → key steps through`);
  ok(await until(() => !document.querySelector('.tour')), 'the last step ends it');

  console.log('Settings › Getting started');
  await click(await until(() => { const b = document.querySelector('.topbar-right [title="Settings"]'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
  await click(await button('Show the tour'));
  ok(await until(() => /Three workspaces/.test(document.querySelector('.tour-card')?.textContent || '')), 'Show the tour runs it again');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  ok(await until(() => !document.querySelector('.tour')), 'Esc closes it');
  await click(await until(() => { const b = document.querySelector('.topbar-right [title="Settings"]'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
  await click(await button('Claude Code & Codex setup…'));
  ok(await until(() => !!document.querySelector('.setup-dialog')), 'and the agent setup opens from there too');
} finally {
  page?.close();
  await srv.stop();
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(failed ? `\nwelcome: ${failed} failed` : '\nwelcome: all checks passed');
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
  ws.onmessage = (e) => { const msg = JSON.parse(e.data); const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); };
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
