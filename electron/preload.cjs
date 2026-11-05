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
});
