// The system file dialog from end to end, on Windows: the desktop app is clicked through its real screens and the
// real Explorer dialog is answered through UI Automation. What is chosen has to reach the form that asked for it
// (and Cancel has to leave that form as it was).
//   JIMMY_APP=electron node tests/file-dialog.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron' || process.platform !== 'win32') { console.error('run on Windows with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9343;

const BASE = path.join(WORK, 'file dialog');
fs.rmSync(BASE, { recursive: true, force: true });
const LOCATION = path.join(BASE, 'New location');
const EXPORTS = path.join(BASE, 'Export here');
const CACHE = path.join(BASE, 'Cache here');
const PLAIN = path.join(BASE, 'Plain folder');
for (const d of [LOCATION, EXPORTS, CACHE, PLAIN]) fs.mkdirSync(d, { recursive: true });
const { FFMPEG } = await import('../server/ffmpeg.js');
const clip = path.join(BASE, 'picked clip.mp4');
spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-pix_fmt', 'yuv420p', clip]);
const htmlFile = path.join(BASE, 'lower third.html');
fs.writeFileSync(htmlFile, '<!doctype html><title>t</title><body></body>');

// Waits for the dialog with this title, then puts `choose` in its name box and presses OK (no `choose`: Cancel).
function answer(title, choose) {
  const ps = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$byName = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $env:PICK_TITLE)
$id = { param($v) New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $v) }
function Find { foreach ($t in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) { $d = $t.FindFirst('Children', $byName); if ($d) { return $d } }; return $root.FindFirst('Children', $byName) }
$w = $null
for ($i = 0; $i -lt 100 -and -not $w; $i++) { $w = Find; if (-not $w) { Start-Sleep -Milliseconds 150 } }
if (-not $w) { 'no dialog'; exit 1 }
Start-Sleep -Milliseconds 500
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);' -Name U -Namespace W
$h = [IntPtr]$w.Current.NativeWindowHandle
if ($env:PICK_PATH) {
  # the name box of the dialog; sent to it directly, so nothing depends on the keyboard or on which window is in front
  $e = $null
  foreach ($x in $w.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) { if (@('1148', '1152') -contains $x.Current.AutomationId -and $x.Current.ClassName -eq 'Edit') { $e = $x } }
  if (-not $e) { 'no name box'; exit 1 }
  [W.U]::SendMessage([IntPtr]$e.Current.NativeWindowHandle, 0x0C, [IntPtr]::Zero, $env:PICK_PATH) | Out-Null
  Start-Sleep -Milliseconds 200
  for ($i = 0; $i -lt 8 -and (Find); $i++) { [W.U]::PostMessage($h, 0x111, [IntPtr]1, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 600 }
} else {
  [W.U]::PostMessage($h, 0x111, [IntPtr]2, [IntPtr]::Zero) | Out-Null
}
for ($i = 0; $i -lt 30 -and (Find); $i++) { Start-Sleep -Milliseconds 100 }
if (Find) { 'still open'; exit 1 }
'answered'`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: { ...process.env, PICK_TITLE: title, PICK_PATH: choose || '' } });
  if (!/answered/.test(r.stdout)) throw new Error(`could not answer "${title}": ${r.stdout}${r.stderr}`);
}

// with the window showing, as it is in use
const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
try {
  const page = await connectPage();
  const click = async (text, title) => {
    for (let i = 0; i < 50; i++) {
      const done = await page.call((t, tt) => {
        const b = [...document.querySelectorAll('button')].filter((x) => (tt ? x.title.startsWith(tt) : x.textContent.trim() === t)).pop();
        if (!b) return false;
        b.click();
        return true;
      }, text, title);
      if (done) return true;
      await sleep(200);
    }
    throw new Error(`no "${text || title}" button`);
  };
  const typeName = (v) => page.call((val) => {
    const i = document.querySelector('input[placeholder^="e.g. Rohith"]');
    i.value = val;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const locationShown = () => page.call(() => document.querySelector('input[placeholder^="Browse to choose"]')?.value);
  const hasText = (t) => page.call((x) => document.body.innerHTML.includes(x), t);
  const idle = () => sleep(600);

  // ------------------------------------------------------------ New project
  // no tabs left over from the last run
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  ok(await click('New project'), 'New project opens');
  await idle();
  await typeName('Dialog test');
  await click('Browse…');
  answer('Where should the project folder go?', null);
  await idle();
  ok((await locationShown()) === '', 'Cancel leaves the location empty');
  ok(await page.call(() => document.querySelector('input[placeholder^="e.g. Rohith"]')?.value === 'Dialog test'), '…and the name is still there');

  await click('Browse…');
  answer('Where should the project folder go?', LOCATION);
  await idle();
  ok((await locationShown()) === LOCATION, `the chosen location shows in the form (${await locationShown()})`);
  ok(await page.call(() => document.querySelector('input[placeholder^="e.g. Rohith"]')?.value === 'Dialog test'), '…the name is still there');
  ok(await hasText(path.join(LOCATION, 'Dialog test')), '…and the form says where the project will go');

  await click('Browse…');
  answer('Where should the project folder go?', PLAIN);
  await idle();
  ok((await locationShown()) === PLAIN, 'choosing again replaces the location');
  await click('Browse…');
  answer('Where should the project folder go?', LOCATION);
  await idle();
  await click('Create project');
  let id = null;
  for (let i = 0; i < 50 && !id; i++) { await sleep(200); id = (await api('GET', '/api/projects')).projects.find((p) => path.resolve(p.dir) === path.join(LOCATION, 'Dialog test'))?.id; }
  ok(fs.existsSync(path.join(LOCATION, 'Dialog test', 'project.json')), 'Create makes the project at that location');
  ok(!!id, '…and opens it');
  await sleep(1500);

  // ------------------------------------------------------------ Import
  await click(null, 'Import from disk');
  answer('Import media', clip);
  let media = [];
  for (let i = 0; i < 50 && !media.length; i++) { await sleep(200); media = (await api('GET', `/api/p/${id}`)).doc.media; }
  ok(media.length === 1 && path.resolve(LOCATION, 'Dialog test', media[0].path) === clip, `the picked file is linked where it is (${media[0]?.path})`);

  // ------------------------------------------------------------ New motion graphic, from an HTML file
  await click(null, 'New motion graphic');
  await idle();
  await click('An HTML file');
  await idle();
  await click('Browse…');
  answer('Choose an HTML composition', htmlFile);
  await idle();
  ok(await page.call((f) => [...document.querySelectorAll('input')].some((i) => i.value === f), htmlFile), 'the chosen HTML file shows in New motion graphic');
  ok(await page.call(() => [...document.querySelectorAll('input')].some((i) => i.value === 'lower third')), '…and names it');
  await click('Cancel');
  await idle();

  // ------------------------------------------------------------ Export folder
  await click('Export');
  await idle();
  await click('Browse…');
  answer('Export to folder', EXPORTS);
  await idle();
  ok(await hasText(EXPORTS), 'the chosen export folder shows in the Export dialog');
  await click('Cancel');
  await idle();

  // ------------------------------------------------------------ Cache folder
  const cacheBefore = (await api('GET', '/api/state')).cacheDir || null;
  await click(null, 'Settings');
  await idle();
  await click('Choose…');
  answer('Cache folder', CACHE);
  await sleep(1200);
  ok(await hasText(CACHE), 'the chosen cache folder shows in Settings');
  ok(((await api('GET', '/api/state')).cacheDir || null) === cacheBefore, '…and is not saved before Save (Step 66)');
  await click('Save');
  await sleep(600);
  ok((await api('GET', '/api/state')).cacheDir === CACHE, '…Save saves it');
  await api('POST', '/api/settings', { cacheDir: null });
  await idle();

  // ------------------------------------------------------------ Open a folder as a project
  await click(null, 'New tab');
  await idle();
  await click('Open folder…');
  answer('Open a project folder', PLAIN);
  let opened = false;
  for (let i = 0; i < 50 && !opened; i++) { await sleep(200); opened = (await api('GET', '/api/projects')).projects.some((p) => path.resolve(p.dir) === PLAIN); }
  ok(opened, 'a folder chosen with Open folder opens as a project');
  page.close();
} finally {
  await srv.stop();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
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
  return { send, call, close: () => ws.close() };
}
