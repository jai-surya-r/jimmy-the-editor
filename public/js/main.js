import { render } from 'preact';
import { html } from 'htm/preact';
import { App } from './ui/App.js';
import { socket } from './core/api.js';
import { restoreTabs, loadServerState, openProject, activate, getTab, activeTab, app } from './core/app.js';
import { initTheme } from './core/theme.js';
import { startPerf, registerStats } from './core/perf.js';
import { firstRun } from './ui/welcome.js';

initTheme();
// the editor's half of the performance recorder: only while the server's is on (off by default, server/perflog.js)
fetch('/api/state').then((r) => r.json()).then((s) => { if (s.perfLog) startPerf(); }).catch(() => {});

socket.connect();
loadServerState();
restoreTabs();
render(html`<${App} />`, document.getElementById('app'));
firstRun(); // a new user: agent setup and the tour (ui/welcome.js)
// for tests that drive the editor (tests/perf-day.mjs)
window.__jimmy = { openProject, activate, getTab, activeTab, app };
// for the performance recorder: each tab's player (video/audio/image elements held) and undo depth
registerStats('tabs', () => app.get().tabs.map(getTab).filter((t) => t?.engine).map((t) => `${t.engine.videos?.size || 0}v/${t.engine.audios?.size || 0}a/${t.engine.images?.size || 0}i/u${t.undoStack?.length || 0}`).join(' '));

// keep the browser from navigating away when a file is dropped outside a drop zone
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
