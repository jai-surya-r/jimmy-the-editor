// The editor window's link to the desktop app: the system's own file dialog (Windows Explorer / macOS Finder)
// instead of Jimmy's server-side file browser, and the path on disk of a file dragged in from Explorer, so it is
// linked where it is rather than copied into the project. public/js/ui/dialogs.js (pickPath) and the drop handlers
// use these when they are there; the browser version of Jimmy goes on without them.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('jimmyApp', {
  // { title, mode: 'media'|'file'|'folder', startPath, okLabel, exts } -> chosen paths ([] when cancelled)
  pick: (o) => ipcRenderer.invoke('jimmy:pick', o),
  pathOf(file) {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
  // the Browser tab (electron/browser.js): ops 'show' (true/false), 'bounds' ({x,y,width,height}), 'go' (url or
  // search), 'back', 'forward', 'reload', 'stop', 'home', 'state'; onState(fn) hears every change; onShow(fn) is
  // Claude asking for the tab to be shown. Both return a function that stops listening.
  browser: {
    call: (op, arg) => ipcRenderer.invoke('jimmy:browser', op, arg),
    onState(fn) { const h = (_e, st) => fn(st); ipcRenderer.on('jimmy:browser-state', h); return () => ipcRenderer.removeListener('jimmy:browser-state', h); },
    onShow(fn) { const h = () => fn(); ipcRenderer.on('jimmy:browser-show', h); return () => ipcRenderer.removeListener('jimmy:browser-show', h); },
  },
});
