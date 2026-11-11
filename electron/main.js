// Jimmy as a desktop app: runs the Jimmy server in a process of its own (electron/server-child.js, Electron's
// utility process) on a free port, bound to 127.0.0.1 as always, and shows the editor in a window of its own.
// This main process only does the window, the system dialogs and the hidden motion-graphic windows (which only it
// can make; the server drives them through messages, server/apphost.js), so nothing the server does holds up the
// editor's clicks, keys and drawing. `npm run app` starts it.
// The browser path (`npm start`, bin/start-mac.sh) doesn't use this file and works as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell, utilityProcess } from 'electron';
import { runWorkerHost } from './worker-host.js';

// Node's file and hashing threads (4 by default): a file on a slow or disconnected network drive holds one for
// seconds, and with all four held every save and read waits. Set before the pool starts (its first use).
process.env.UV_THREADPOOL_SIZE ||= '16';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --hidden: run without showing the editor window (test runs)
const HIDDEN = process.argv.includes('--hidden');

// The app started again as an export render worker (server/apphost.js) does nothing else.
const argValue = (name) => process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const workerUrl = argValue('--jimmy-render-worker');
if (workerUrl) runWorkerHost(workerUrl, argValue('--jimmy-profile'), argValue('--jimmy-parent'), argValue('--jimmy-ffmpeg'));
else {
  setUp();
  // One Jimmy at a time: a second launch hands over to this one (see 'second-instance') and ends.
  if (!app.requestSingleInstanceLock()) app.exit(0);
  else start();
}

// Jimmy's data (settings, chat names, project state) lives in the user-data folder: %APPDATA%\Jimmy - The Editor,
// ~/Library/Application Support/Jimmy - The Editor (the name is package.json's productName). Electron's own
// browser files go into a Chromium subfolder so they don't mix with it. JIMMY_DATA_DIR, when given, wins and becomes
// the whole app's folder (tests: a separate instance with its own single-instance lock).
function setUp() {
  if (process.env.JIMMY_DATA_DIR) app.setPath('userData', path.resolve(process.env.JIMMY_DATA_DIR));
  const userData = app.getPath('userData');
  app.setPath('sessionData', path.join(userData, 'Chromium'));
  process.env.JIMMY_DATA_DIR = userData;
  // Motion graphics render in hidden windows of the app (server/apphost.js): on laptops with two GPUs they draw
  // on the fast one, as the headless browser did (about 2.5x faster per frame).
  app.commandLine.appendSwitch('force_high_performance_gpu');
  // tests drive the editor window over the DevTools protocol (tests/perf-day.mjs); never set in normal use
  if (process.env.JIMMY_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.JIMMY_DEBUG_PORT);
  // tests: V8 flags for the pages (e.g. --prof, a tick log that works even while a page is stuck)
  if (process.env.JIMMY_JS_FLAGS) { app.commandLine.appendSwitch('js-flags', process.env.JIMMY_JS_FLAGS); app.commandLine.appendSwitch('no-sandbox'); }
  // The LGPL ffmpeg the app ships (npm run fetch-ffmpeg → vendor/ffmpeg/<platform>-<arch>); without it (macOS for
  // now) the server finds an installed one as before. FFMPEG_PATH/FFPROBE_PATH given from outside win.
  const vendor = path.join(APP_DIR, 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`);
  const exe = process.platform === 'win32' ? '.exe' : '';
  if (fs.existsSync(path.join(vendor, `ffmpeg${exe}`)) && fs.existsSync(path.join(vendor, `ffprobe${exe}`))) {
    process.env.FFMPEG_PATH ||= path.join(vendor, `ffmpeg${exe}`);
    process.env.FFPROBE_PATH ||= path.join(vendor, `ffprobe${exe}`);
  }
}

// A Mac app opened from Finder gets a bare PATH. Like bin/start-mac.sh: add the usual Homebrew / npm / Claude
// locations and the login shell's PATH, so `claude`, ffmpeg and the user's tools are found by the server and the
// sessions it starts.
function macPath() {
  let login = '';
  try { login = execFileSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no zsh or a slow profile */ }
  const home = os.homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.claude/local`, login, process.env.PATH];
  return [...new Set(dirs.filter(Boolean).join(':').split(':').filter(Boolean))].join(':');
}

// The first launch takes over the browser version's data/ folder next to the app (a copy; the original stays).
function migrateData(dest) {
  const old = path.join(APP_DIR, 'data');
  if (fs.existsSync(path.join(dest, 'config.json')) || !fs.existsSync(path.join(old, 'config.json'))) return;
  const skip = new Set(['server.log', 'server.json', 'install.command']);
  fs.cpSync(old, dest, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && !/\.tmp-/.test(src) });
  // IP kits lived next to the app too; the app keeps them in its data folder (server/kits.js)
  const kits = path.join(APP_DIR, 'kits');
  if (fs.existsSync(kits) && !fs.existsSync(path.join(dest, 'kits'))) fs.cpSync(kits, path.join(dest, 'kits'), { recursive: true });
  console.log(`[app] copied settings from ${old} to ${dest}`);
}

function start() {
  // Any free port unless one was asked for (tests use CLAUDE_EDIT_PORT=4455). Run-only: config.json keeps its port.
  if (!process.env.CLAUDE_EDIT_PORT) process.env.CLAUDE_EDIT_PORT = '0';
  if (process.platform === 'darwin') process.env.PATH = macPath();

  let server = null;
  let win = null;
  let quitting = false; // the person already agreed to quit (or nothing was running)
  let asking = false; // the "Quit anyway?" question is on screen

  // http(s) links leave the app for the default browser; anything else (file:, javascript:, …) goes nowhere
  const openOutside = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  };

  // Closing the window while an export or a motion graphic renders would lose it: ask first.
  async function confirmClose(e) {
    if (quitting || !server) return;
    e.preventDefault();
    if (asking) return; // closed again while the question is open: one question is enough
    asking = true;
    const { exports, graphics } = await server.busyWork().catch(() => ({ exports: 0, graphics: 0 }));
    if (!exports && !graphics) { asking = false; quitting = true; win?.close(); return; }
    const what = [exports && `${exports} export${exports > 1 ? 's' : ''}`, graphics && `${graphics} motion graphic${graphics > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Keep working', 'Quit anyway'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Jimmy - The Editor', message: `${what[0].toUpperCase()}${what.slice(1)} ${exports + graphics > 1 ? 'are' : 'is'} still running. Quit anyway?`,
      detail: `Quitting stops ${exports + graphics > 1 ? 'them' : 'it'} now and the unfinished work is lost.`,
    }).finally(() => { asking = false; });
    if (response === 1) { quitting = true; win?.close(); }
  }

  // White tile on a dark taskbar, black on a light one. Windows sets the taskbar's theme apart from the apps' theme.
  function taskbarIcon() {
    let light = !nativeTheme.shouldUseDarkColors;
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        light = /0x1\s*$/m.test(out);
      } catch { /* an older Windows without the setting */ }
    }
    return path.join(APP_DIR, 'public', light ? 'icon-black.png' : 'icon.png');
  }
  function showTaskbarIcon() {
    if (process.platform === 'darwin') app.dock?.setIcon(taskbarIcon());
    else if (win && !win.isDestroyed()) win.setIcon(taskbarIcon());
  }

  function createWindow(url) {
    win = new BrowserWindow({
      width: 1600, height: 960, minWidth: 900, minHeight: 600,
      title: 'Jimmy - The Editor', backgroundColor: '#000000', show: false, icon: taskbarIcon(),
      // backgroundThrottling off: a minimized or covered window (Windows counts both as hidden) would otherwise have
      // its timers slowed to once a minute after 5 min, and the editor fall minutes behind the server's messages
      // (saves, job progress) while exports run in the background
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload: path.join(APP_DIR, 'electron', 'preload.cjs') },
    });
    win.removeMenu();
    if (!HIDDEN) win.once('ready-to-show', () => win.show());
    // new windows (target=_blank, window.open) open in the browser; the editor itself never navigates away
    win.webContents.setWindowOpenHandler(({ url: to }) => { openOutside(to); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, to) => {
      if (new URL(to).origin !== new URL(url).origin) { e.preventDefault(); openOutside(to); }
    });
    win.on('close', confirmClose);
    // The editor's page process ending (a crash, out of memory) would leave a dead window: write down why (the
    // performance log too) and load the editor again; open tabs come back as they were (restoreTabs).
    win.webContents.on('render-process-gone', (_e, d) => {
      console.warn(`[app] the editor page stopped (${d.reason}, exit ${d.exitCode}); reloading it`);
      server.perflog?.event('editorGone', { reason: d.reason, exitCode: d.exitCode });
      if (d.reason !== 'clean-exit') setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 1000);
    });
    win.webContents.on('unresponsive', () => server.perflog?.event('editorUnresponsive', {}));
    win.webContents.on('responsive', () => server.perflog?.event('editorResponsive', {}));
    // Closing the editor window ends the app (on a Mac too: Jimmy has nothing to show without it), and with it
    // the server, its Claude sessions and the hidden render windows.
    win.on('closed', () => { win = null; server.shutdown(); });
    win.loadURL(url);
  }

  // The system's file dialog for the editor (electron/preload.cjs): the chosen paths, [] when cancelled.
  ipcMain.handle('jimmy:pick', async (e, o = {}) => {
    if (!win || e.sender !== win.webContents) return [];
    const mode = o.mode || 'media';
    const props = mode === 'folder' ? ['openDirectory', 'createDirectory', 'promptToCreate'] : mode === 'file' ? ['openFile'] : ['openFile', 'multiSelections'];
    const exts = Array.isArray(o.exts) ? o.exts.map(String) : null;
    const filters = mode === 'folder' || !exts?.length ? [] : [{ name: mode === 'media' ? 'Media' : exts.map((x) => `.${x}`).join(', '), extensions: exts }, { name: 'All files', extensions: ['*'] }];
    let defaultPath = typeof o.startPath === 'string' && o.startPath ? o.startPath : undefined;
    if (defaultPath && !fs.existsSync(defaultPath)) defaultPath = undefined;
    const r = await dialog.showOpenDialog(win, { title: o.title ? String(o.title) : undefined, buttonLabel: o.okLabel ? String(o.okLabel) : undefined, defaultPath, properties: props, filters });
    return r.canceled ? [] : r.filePaths;
  });

  // A second launch: bring this window forward instead.
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    try { migrateData(process.env.JIMMY_DATA_DIR); } catch (err) { console.warn('[app] could not copy the old settings:', err.message); }
    // the server reads JIMMY_DATA_DIR (and the rest of the environment) when it is first imported
    server = await startServer();
    // Settings › Quit Jimmy (and the end of shutdown below) end the app through Electron
    server.onExit(() => {
      // app.exit skips Chromium's own shutdown: write the window's storage (settings) out first
      try { session.defaultSession.flushStorageData(); } catch { /* nothing to write */ }
      setTimeout(() => app.exit(0), 200);
    });
    const { url } = await server.ready;
    createWindow(url);
    showTaskbarIcon();
    nativeTheme.on('updated', showTaskbarIcon);
  }).catch((err) => {
    console.error('[app] did not start:', err);
    dialog.showErrorBox('Jimmy did not start', String(err?.stack || err));
    app.exit(1);
  });

  // The server in its own process. The object stands in for the server module the app used to import:
  // ready (the editor's URL), busyWork(), shutdown(), onExit(), perflog.event().
  async function startServer() {
    const { openMotionWindowHere } = await import('../server/apphost.js');
    const child = utilityProcess.fork(path.join(APP_DIR, 'electron', 'server-child.js'), [], {
      serviceName: 'Jimmy server', stdio: 'inherit',
      env: { ...process.env, JIMMY_SERVER_CHILD: '1', JIMMY_APP_EXE: process.execPath, JIMMY_APP_DEV: process.defaultApp ? '1' : '' },
    });
    let exitFn = () => {};
    let ended = false;
    let readyFn, failFn;
    const ready = new Promise((res, rej) => { readyFn = res; failFn = rej; });
    const busy = new Map();
    let n = 0;
    const pages = new Map(); // motion pages the server opened here
    let pageId = 0;
    const answer = (m, result, error) => { if (!ended) child.postMessage({ t: 'reply', n: m.n, result, error }); };
    const asks = {
      'page.open': async ({ width, height }) => {
        const id = ++pageId;
        pages.set(id, await openMotionWindowHere(width, height, (method, params) => { if (!ended) child.postMessage({ t: 'pageEvent', id, method, params }); }));
        return { id };
      },
      'page.send': ({ id, method, params, ms }) => {
        const p = pages.get(id);
        if (!p) throw new Error('The page was closed');
        return p.send(method, params, ms);
      },
      trash: async ({ dir }) => { await shell.trashItem(dir); return true; },
    };
    child.on('message', (m) => {
      if (m?.t === 'ready') readyFn({ url: m.url });
      else if (m?.t === 'failed') failFn(new Error(m.error));
      else if (m?.t === 'exit') exitFn();
      else if (m?.t === 'busy') { busy.get(m.n)?.(m.work); busy.delete(m.n); }
      else if (m?.t === 'ask') {
        const fn = asks[m.op];
        if (!fn) { answer(m, null, `unknown request ${m.op}`); return; }
        Promise.resolve().then(() => fn(m.args || {})).then((r) => answer(m, r), (err) => answer(m, null, err?.message || String(err)));
      } else if (m?.t === 'tell' && m.op === 'page.close') { pages.get(m.args?.id)?.close(); pages.delete(m.args?.id); }
    });
    // the server process ending on its own (a crash): nothing works without it
    child.on('exit', (code) => {
      ended = true;
      for (const p of pages.values()) p.close();
      pages.clear();
      failFn(new Error(`the server stopped (exit ${code})`));
      if (quitting) return;
      console.error(`[app] the server process stopped (exit ${code})`);
      if (code !== 0) dialog.showErrorBox('Jimmy stopped', `Jimmy's server stopped unexpectedly (exit ${code}). Open Jimmy again to go on; your projects are saved as you work.`);
      app.exit(code || 1);
    });
    return {
      ready,
      onExit: (fn) => { exitFn = fn; },
      busyWork: () => new Promise((res, rej) => {
        if (ended) { res({ exports: 0, graphics: 0 }); return; }
        const i = ++n;
        busy.set(i, res);
        child.postMessage({ t: 'busy', n: i });
        setTimeout(() => { if (busy.delete(i)) rej(new Error('no answer')); }, 3000);
      }),
      shutdown: () => { quitting = true; if (!ended) child.postMessage({ t: 'shutdown' }); else exitFn(); },
      perflog: { event: (kind, data) => { if (!ended) child.postMessage({ t: 'perfEvent', kind, data }); } },
    };
  }

  // The hidden render windows don't keep the app alive on their own: the editor window's 'closed' ends it.
  app.on('window-all-closed', () => { if (!win) app.quit(); });
}
