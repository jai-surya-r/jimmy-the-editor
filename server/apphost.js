// Inside the desktop app, export render workers and motion-graphic pages run on the app's own Chromium (workers
// as separate app processes, motion pages in offscreen windows), so exports and motion renders work without Chrome
// or Edge installed. Plain `node server/index.js` (and the app started with JIMMY_SYSTEM_BROWSER=1) keeps using an
// installed Chrome/Edge (render.js findBrowser).
import { APP_DIR } from './util.js';

const electron = process.versions.electron && process.env.JIMMY_SYSTEM_BROWSER !== '1' ? await import('electron') : null;
export const appHost = !!electron;

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
  return [process.execPath, [...(process.defaultApp ? [APP_DIR] : []), `--jimmy-render-worker=${url}`, `--jimmy-profile=${profile}`, `--jimmy-parent=${process.pid}`, ...(ffmpeg ? [`--jimmy-ffmpeg=${ffmpeg}`] : [])]];
}

// A motion-graphic page driven over the DevTools protocol through Electron's webContents.debugger: send() and
// on() mirror what motion.js does over a browser's DevTools connection; close() ends the page.
export async function openMotionWindow(width, height) {
  const win = motionWindow(width, height);
  await win.loadURL('about:blank');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const handlers = new Map();
  dbg.on('message', (_e, method, params) => handlers.get(method)?.(params));
  // a hung page never answers: no call waits for it forever
  const send = (method, params = {}, ms = 120000) => new Promise((resolve, reject) => {
    if (win.isDestroyed()) { reject(new Error('The page was closed')); return; }
    const timer = setTimeout(() => reject(new Error(`${method}: the page stopped answering`)), ms);
    dbg.sendCommand(method, params).then(resolve, (err) => reject(new Error(`${method}: ${err.message}`))).finally(() => clearTimeout(timer));
  });
  return {
    send,
    on: (method, fn) => handlers.set(method, fn),
    close: () => { handlers.clear(); if (!win.isDestroyed()) win.destroy(); },
  };
}
