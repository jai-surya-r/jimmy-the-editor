// A render worker process: the app started again with --jimmy-render-worker=<url>. It shows the editor's
// render.html in a hidden window of the app's own Chromium with the GPU off and software WebGL, the way the headless
// Chrome/Edge it replaces ran (--disable-gpu, SwiftShader), so exports come out the same pixel for pixel.
// The server (server/apphost.js) starts it and ends it; it has no window, menu or data of its own.
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

// ffmpeg: the binary the server uses; the page reads its frames itself through electron/worker-preload.cjs.
export function runWorkerHost(url, profile, parent, ffmpeg) {
  // only the editor's own server, never anything else
  if (!/^http:\/\/127\.0\.0\.1:\d+\/render\.html\?/.test(url)) { app.exit(2); return; }
  if (profile) app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.on('window-all-closed', () => app.quit());
  // the app that started it is gone (it crashed or was killed): nothing is left to render for
  const ppid = Number(parent);
  if (ppid > 0) setInterval(() => { try { process.kill(ppid, 0); } catch (e) { if (e.code !== 'EPERM') app.exit(0); } }, 3000).unref();
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 800,
      // not sandboxed: the preload starts ffmpeg; the page itself still has no Node (context isolation)
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
        ...(ffmpeg ? { sandbox: false, preload: path.join(import.meta.dirname, 'worker-preload.cjs'), additionalArguments: [`--jimmy-ffmpeg=${ffmpeg}`] } : { sandbox: true }),
      },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('render-process-gone', () => app.exit(1));
    win.loadURL(url).catch(() => app.exit(1));
  });
}
