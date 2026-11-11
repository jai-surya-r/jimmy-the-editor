// Inside the desktop app, export render workers and motion-graphic pages run on the app's own Chromium (workers
// as separate app processes, motion pages in offscreen windows), so exports and motion renders work without Chrome
// or Edge installed. Plain `node server/index.js` (and the app started with JIMMY_SYSTEM_BROWSER=1) keeps using an
// installed Chrome/Edge (render.js findBrowser).
//
// The app runs this server in a process of its own (electron/server-child.js), apart from the app's main process,
// which only handles the editor window: work here never holds up clicks, keys and drawing in the editor. Windows
// can only be made in the main process, so there a motion page is opened, driven and closed through messages to
// it (electron/main.js serves them with openMotionWindowHere below).
import { APP_DIR } from './util.js';

const CHILD = process.env.JIMMY_SERVER_CHILD === '1' && process.parentPort ? process.parentPort : null;
const electron = !CHILD && process.versions.electron && process.env.JIMMY_SYSTEM_BROWSER !== '1' ? await import('electron') : null;
export const appHost = !!electron || (!!CHILD && process.env.JIMMY_SYSTEM_BROWSER !== '1');

// ---------------------------------------------------------------- messages to the main process (server child)
let nextId = 0;
const waiting = new Map(); // request id -> { resolve, reject, timer }
const pageEvents = new Map(); // motion page id -> Map(method -> handler)
if (CHILD) {
  CHILD.on('message', (e) => {
    const m = e.data;
    if (m?.t === 'reply') {
      const w = waiting.get(m.n);
      if (!w) return;
      waiting.delete(m.n);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
    } else if (m?.t === 'pageEvent') pageEvents.get(m.id)?.get(m.method)?.(m.params);
  });
}
// ask the main process to do something; ms: give up after this long (a main process that never answers)
export function askMain(op, args = {}, ms = 130000) {
  if (!CHILD) return Promise.reject(new Error('not in the app'));
  return new Promise((resolve, reject) => {
    const n = ++nextId;
    const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`${op}: the app did not answer`)); }, ms);
    waiting.set(n, { resolve, reject, timer });
    CHILD.postMessage({ t: 'ask', n, op, args });
  });
}
export const tellMain = (op, args = {}) => CHILD?.postMessage({ t: 'tell', op, args });
export const inServerChild = !!CHILD;

// Rendered offscreen: never shown, yet it paints (a merely hidden window runs its scripts but has no surface to
// screenshot), transparent where the page is, animation frames up to 240 a second. Own session: the pages share
// no cookies or storage with the editor window.
function motionWindow(width, height) {
  const win = new electron.BrowserWindow({
    show: false, width, height, useContentSize: true, enableLargerThanScreen: true, transparent: true, frame: false, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: 'jimmy-motion' },
  });
  win.webContents.setFrameRate(240);
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

// A render worker: the app started again as a process of its own with the GPU off (electron/worker-host.js),
// like the headless Chrome/Edge it replaces, so render.js manages it the same way (spawnBrowser/killBrowser).
// In development the app is `electron <folder>`, so the folder comes first; a packaged app is just its binary.
// ffmpeg: given, its render page reads and writes frames itself (electron/worker-preload.cjs).
export function workerHostCommand(url, profile, ffmpeg) {
  const exe = process.env.JIMMY_APP_EXE || process.execPath;
  const devFolder = CHILD ? process.env.JIMMY_APP_DEV === '1' : process.defaultApp;
  return [exe, [...(devFolder ? [APP_DIR] : []), `--jimmy-render-worker=${url}`, `--jimmy-profile=${profile}`, `--jimmy-parent=${process.pid}`, ...(ffmpeg ? [`--jimmy-ffmpeg=${ffmpeg}`] : [])]];
}

// In the main process: a motion page driven over the DevTools protocol through Electron's webContents.debugger.
// onEvent(method, params) gets every protocol event of the page.
export async function openMotionWindowHere(width, height, onEvent) {
  const win = motionWindow(width, height);
  await win.loadURL('about:blank');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  dbg.on('message', (_e, method, params) => onEvent(method, params));
  // a hung page never answers: no call waits for it forever
  const send = (method, params = {}, ms = 120000) => new Promise((resolve, reject) => {
    if (win.isDestroyed()) { reject(new Error('The page was closed')); return; }
    const timer = setTimeout(() => reject(new Error(`${method}: the page stopped answering`)), ms);
    dbg.sendCommand(method, params).then(resolve, (err) => reject(new Error(`${method}: ${err.message}`))).finally(() => clearTimeout(timer));
  });
  return { send, close: () => { if (!win.isDestroyed()) win.destroy(); } };
}

// A motion-graphic page: send() and on() mirror what motion.js does over a browser's DevTools connection; close()
// ends the page. In the server child the page lives in the main process and is reached through messages.
export async function openMotionWindow(width, height) {
  const handlers = new Map();
  if (!CHILD) {
    const page = await openMotionWindowHere(width, height, (method, params) => handlers.get(method)?.(params));
    return { send: page.send, on: (method, fn) => handlers.set(method, fn), close: () => { handlers.clear(); page.close(); } };
  }
  const { id } = await askMain('page.open', { width, height }, 60000);
  pageEvents.set(id, handlers);
  return {
    send: (method, params = {}, ms = 120000) => askMain('page.send', { id, method, params, ms }, ms + 10000),
    on: (method, fn) => handlers.set(method, fn),
    close: () => { handlers.clear(); pageEvents.delete(id); tellMain('page.close', { id }); },
  };
}

// To the system's Recycle Bin / Trash through Electron (the main process in the app); false when not available.
export async function trashWithApp(dir) {
  if (CHILD) { await askMain('trash', { dir }, 60000); return true; }
  if (!process.versions.electron) return false;
  const { shell } = await import('electron');
  if (shell?.trashItem) { await shell.trashItem(dir); return true; }
  return false;
}
