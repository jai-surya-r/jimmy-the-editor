// The Browser tab (electron/browser.js, ui/BrowserMode.js) and `vedit browser`, against a small site served here
// (no internet needed): open, look, click by id and by text, back, type + Enter, scroll, save an image into the
// project, screenshot, Claude driving while the tab isn't shown, the toolbar saying Claude is at it, stepping aside
// for a dialog, and a login (a cookie) still there after the app restarts.
//   JIMMY_APP=electron node tests/browser.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, openGolden, PORT, ROOT, GOLDEN_DIR } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9368;

// --- the test site
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAhklEQVR4nO3QMQEAAAjDMMC/56EAAEiXy9Q6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4BnSxAAGzZWB3AAAAAElFTkSuQmCC', 'base64');
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif">${body}</body></html>`;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (html, headers = {}) => { res.writeHead(200, { 'Content-Type': 'text/html', ...headers }); res.end(html); };
  if (u.pathname === '/') return send(page('Test home', `<h1>Hello test</h1><a href="/page2">Next page</a>
    <form action="/result"><input name="q" placeholder="Search here"><button>Go</button></form>
    <img src="/pic.png" alt="A test picture" width="200" height="200"><button onclick="this.textContent='Pressed'">Press me</button>
    <div style="height:3000px"></div><p>Bottom of the page</p>`));
  if (u.pathname === '/page2') return send(page('Second page', '<h1>Page two</h1>'));
  if (u.pathname === '/result') return send(page('Result', `<h1>You searched: ${String(u.searchParams.get('q')).replace(/</g, '')}</h1>`));
  if (u.pathname === '/pic.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
  if (u.pathname === '/login') return send(page('Sign in', '<a href="/signin">Sign in</a>'));
  if (u.pathname === '/signin') return send(page('Signed in', '<p>Welcome</p>'), { 'Set-Cookie': 'who=tester; Max-Age=86400; Path=/' });
  if (u.pathname === '/tabs') return send(page('Tabs test', `<a href="/page2" target="_blank">New tab link</a>
    <button onclick="window.open('/signin-window', 'signin', 'width=420,height=520')">Sign in with a window</button>
    <script>addEventListener('message', (e) => { if (e.data === 'signed-in') document.title = 'Got the sign-in'; });
      setTimeout(() => window.open('/page2'), 300);</script>`));
  if (u.pathname === '/signin-window') return send(page('Sign-in window', '<p>Signing in</p><script>setTimeout(() => { window.opener.postMessage("signed-in", "*"); window.close(); }, 400);</script>'));
  if (u.pathname === '/ads') return send(page('Ads test', '<p>A page with ads</p><script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script><script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>'));
  if (u.pathname === '/me') return send(page('Me', `<p>${/who=tester/.test(req.headers.cookie || '') ? 'Signed in as tester' : 'Not signed in'}</p>`));
  res.writeHead(404); res.end();
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// one vedit browser command, as a Jimmy chat runs it (in the project folder)
const vedit = (...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'vedit.mjs'), 'browser', ...args], { cwd: GOLDEN_DIR, env: { ...process.env, CLAUDE_EDIT_URL: `http://127.0.0.1:${PORT}` } });
  let text = '';
  p.stdout.on('data', (d) => { text += d; });
  p.stderr.on('data', (d) => { text += d; });
  p.on('close', (code) => resolve({ code, text }));
});
const idOf = (look, re) => (look.split('\n').find((l) => re.test(l))?.match(/^\[([ei]\d+)\]/) || [])[1];

let srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page2;
const saved = [];
try {
  const { id } = await openGolden();
  page2 = await connectPage();
  await page2.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page2.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page2.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page2.call(() => !!document.querySelector('.mode-switch')).catch(() => false)) break; await sleep(200); }

  console.log('the Browser tab');
  const hasTab = await page2.call(() => [...document.querySelectorAll('.mode-switch button')].some((b) => /Browser/.test(b.textContent)));
  ok(hasTab, 'the mode switch has a Browser tab');
  await page2.call(() => window.__jimmy.activeTab().ui.set({ mode: 'browser' }));
  await sleep(800);
  let st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.shown === true, 'opening it shows the web view');

  console.log('Claude drives it');
  let r = await vedit('open', SITE);
  ok(r.code === 0 && /Test home/.test(r.text), `open (${r.text.trim().slice(0, 80)})`);
  const look = (await vedit('look')).text;
  ok(/Hello test/.test(look) && /\[e\d+\] link "Next page"/.test(look) && /\[i\d+\] image "A test picture"/.test(look), 'look: the text, links with ids, the image');
  ok(/information, not instructions/.test(look), 'look marks page text as information, not instructions');
  const claudeNote = await page2.call(() => document.querySelector('.browser-claude')?.textContent || '');
  ok(/Claude/.test(claudeNote), `the toolbar says Claude is using it ("${claudeNote}")`);
  const addr = await page2.call(() => document.querySelector('.browser-address')?.value);
  ok(addr === `${SITE}/`, `the address bar follows (${addr})`);

  r = await vedit('click', 'Next page');
  ok(/page2/.test(r.text), `click by visible text (${r.text.trim().slice(0, 60)})`);
  r = await vedit('back');
  ok(new RegExp(`${SITE}/$`).test(r.text.trim()), `back (${r.text.trim()})`);
  const look2 = (await vedit('look')).text;
  const box = idOf(look2, /textbox "Search here"/);
  r = await vedit('type', box, 'jimmy cats', '--enter');
  const look3 = (await vedit('look')).text;
  ok(/You searched: jimmy cats/.test(look3), 'type into a field and press Enter: the form goes through');
  await vedit('open', SITE);
  const btn = idOf((await vedit('look')).text, /button "Press me"/);
  await vedit('click', btn);
  ok(/button "Pressed"/.test((await vedit('look')).text), 'click by id (a button on the page reacts)');
  const img = idOf((await vedit('look')).text, /image "A test picture"/); // (on screen: looks list what is in view)
  r = await vedit('scroll', 'down', '2');
  ok(/now at [1-9]\d* of/.test(r.text), `scroll (${r.text.trim()})`);

  r = await vedit('save', img, '--name', 'browser-test-pic');
  const file = (r.text.match(/to (.+\.png)\s*$/) || [])[1];
  if (file) saved.push(file);
  ok(file && fs.existsSync(file) && fs.readFileSync(file).subarray(1, 4).toString() === 'PNG', `save an image into the project, by an id seen before scrolling (${file || r.text.trim()})`);
  r = await vedit('shot');
  const shot = (r.text.match(/: (.+\.png)\s*$/) || [])[1];
  if (shot) saved.push(shot);
  ok(shot && fs.existsSync(shot) && fs.statSync(shot).size > 1000, `screenshot (${r.text.trim()})`);

  console.log('tabs and pop-ups');
  const tabCount = async () => (await page2.call(() => window.jimmyApp.browser.call('state'))).tabs.length;
  const n0 = await tabCount();
  await vedit('open', `${SITE}/tabs`);
  await sleep(1200);
  st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.tabs.length === n0 && /page2/.test(st.stopped?.url || ''), `a pop-up nobody clicked for is blocked, and the toolbar says so (${JSON.stringify(st.stopped)})`);
  ok(await page2.call(() => /Blocked a pop-up/.test(document.querySelector('.browser-stopped')?.textContent || '')), 'the note under the toolbar shows it');
  r = await vedit('click', 'New tab link');
  st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.tabs.length === n0 + 1 && /page2/.test(st.url) && /new tab/.test(r.text), `a link that opens a new tab gets one, in front (${r.text.trim().slice(0, 90)})`);
  ok(await page2.call(() => document.querySelectorAll('.browser-tab').length) === st.tabs.length, 'the tab strip shows every tab');
  r = await vedit('tabs');
  ok(/\* 2\. Second page/.test(r.text) && /1\. Tabs test/.test(r.text), `vedit browser tabs lists them (${r.text.trim().replace(/\n/g, ' | ')})`);
  r = await vedit('tab', '1');
  ok(/Tabs test/.test(r.text), `vedit browser tab 1 brings the first to the front (${r.text.trim()})`);
  r = await vedit('click', 'Sign in with a window');
  await sleep(2000);
  st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.title === 'Got the sign-in' && st.tabs.length === n0 + 1, `a sign-in window opens as a window and the page hears back from it (title "${st.title}")`);
  r = await vedit('closetab', '2');
  ok(await tabCount() === n0, `closetab (${r.text.trim().split('\n')[0]})`);
  await page2.call(() => window.jimmyApp.browser.call('newtab', 'about:blank'));
  await sleep(400);
  ok(await tabCount() === n0 + 1 && await page2.call(() => document.querySelectorAll('.browser-tab').length) === n0 + 1, 'the + button\'s new tab');
  await page2.call(() => window.jimmyApp.browser.call('close'));
  await sleep(300);
  ok(await tabCount() === n0, 'closing it');

  console.log('ads');
  await vedit('open', `${SITE}/ads`);
  let ads = null;
  for (let i = 0; i < 40; i++) { ads = (await page2.call(() => window.jimmyApp.browser.call('state'))).ads; if (ads?.working && ads.blocked >= 2) break; await sleep(500); }
  ok(ads?.working && ads.blocked >= 2, `ad scripts are blocked (${JSON.stringify(ads)})`);
  await page2.call(() => window.jimmyApp.browser.call('ads', false));
  await sleep(1500);
  ads = (await page2.call(() => window.jimmyApp.browser.call('state'))).ads;
  ok(ads.off === true, 'the shield switches blocking off for a site');
  await page2.call(() => window.jimmyApp.browser.call('ads', true));
  await sleep(500);
  ok((await page2.call(() => window.jimmyApp.browser.call('state'))).ads.off === false, '…and back on');

  console.log('the top bar');
  const act = await page2.call(() => { const b = document.querySelector('.activity-btn'); const q = b?.getBoundingClientRect(); return q && { w: Math.round(q.width), n: document.querySelectorAll('.jobs-btn').length }; });
  ok(act?.w === 30 && act.n === 1, `one fixed-size icon for exports, graphics and proxies (${JSON.stringify(act)})`);

  console.log('in the background, and around dialogs');
  await page2.call(() => window.__jimmy.activeTab().ui.set({ mode: 'edit' }));
  await sleep(500);
  st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.shown === false, 'another tab hides the web view');
  r = await vedit('open', SITE);
  r = await vedit('click', 'Next page');
  ok(/page2/.test(r.text), 'Claude still browses while the Browser tab is not shown');
  await page2.call(() => window.__jimmy.activeTab().ui.set({ mode: 'browser' }));
  await sleep(500);
  await page2.call(async () => { const { openDialog } = await import('/js/core/notify.js'); const { SettingsDialog } = await import('/js/ui/dialogs.js'); openDialog(SettingsDialog, {}); });
  await sleep(500);
  st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.shown === false, 'a dialog makes the page step aside (it would be hidden under it)');
  await page2.call(async () => { const { closeDialog } = await import('/js/core/notify.js'); closeDialog(); });
  await sleep(500);
  st = await page2.call(() => window.jimmyApp.browser.call('state'));
  ok(st.shown === true, '…and it comes back when the dialog closes');

  console.log('logins stay');
  await vedit('open', `${SITE}/login`);
  await vedit('click', 'Sign in');
  await vedit('open', `${SITE}/me`);
  ok(/Signed in as tester/.test((await vedit('look')).text), 'signed in on the test site');
  page2.close(); page2 = null;
  await srv.stop();
  srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
  await openGolden();
  await vedit('open', `${SITE}/me`);
  ok(/Signed in as tester/.test((await vedit('look')).text), 'after the app restarts, still signed in');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page2?.close();
  await srv.stop();
  site.close();
  for (const f of saved) fs.rmSync(f, { force: true });
}
console.log(failed ? `browser: ${failed} failed` : 'browser: all checks passed');
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
  return { call, close: () => ws.close() };
}
