// App-level state: open tabs, render jobs, server info, clipboard.
import { createStore, loadPref, savePref } from './store.js';
import { socket, get } from './api.js';
import { Tab } from './tab.js';
import { notify } from './notify.js';

export const app = createStore({ tabs: [], activeId: null, jobs: {}, connected: false, server: null, renderHost: false });
export const clipboard = { clips: [] };

const tabMap = new Map();
let seq = 1;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export function getTab(id) { return tabMap.get(id) || null; }
export function activeTab() { return tabMap.get(app.get().activeId) || null; }

function persistTabs() {
  const { tabs, activeId } = app.get();
  savePref('tabs', tabs.map((id) => ({ id, projectId: tabMap.get(id)?.projectId || null })));
  savePref('activeTab', activeId);
}

export function createTab(projectId, { activate = true, id } = {}) {
  const tab = new Tab(id || newId(), projectId);
  tabMap.set(tab.id, tab);
  app.set((s) => ({ ...s, tabs: [...s.tabs, tab.id], activeId: activate ? tab.id : s.activeId }));
  tab.load();
  persistTabs();
  return tab;
}

export function activate(id) {
  const prev = activeTab();
  if (prev && prev.id !== id) prev.engine.pause();
  app.set({ activeId: id });
  persistTabs();
}

// Open a project: focus an existing tab for it, or turn the current home tab into it, or add a tab.
export function openProject(projectId) {
  for (const [id, t] of tabMap) {
    if (t.projectId !== projectId) continue;
    if (t.store.get().status === 'error') t.load(); // restored before the server knew this project: it does now
    activate(id);
    return t;
  }
  const cur = activeTab();
  if (cur && !cur.projectId) {
    const idx = app.get().tabs.indexOf(cur.id);
    cur.dispose();
    tabMap.delete(cur.id);
    const tab = new Tab(newId(), projectId);
    tabMap.set(tab.id, tab);
    app.set((s) => {
      const tabs = [...s.tabs];
      tabs[idx] = tab.id;
      return { ...s, tabs, activeId: tab.id };
    });
    tab.load();
    persistTabs();
    return tab;
  }
  return createTab(projectId);
}

export function newHomeTab() {
  return createTab(null);
}

export function closeTab(id) {
  const tab = tabMap.get(id);
  if (!tab) return;
  tab.dispose();
  tabMap.delete(id);
  app.set((s) => {
    const i = s.tabs.indexOf(id);
    const tabs = s.tabs.filter((x) => x !== id);
    const activeId = s.activeId === id ? tabs[Math.min(i, tabs.length - 1)] || null : s.activeId;
    return { ...s, tabs, activeId };
  });
  if (!app.get().tabs.length) newHomeTab();
  persistTabs();
}

export function restoreTabs() {
  const saved = loadPref('tabs', []);
  const active = loadPref('activeTab', null);
  for (const t of saved) createTab(t.projectId, { activate: false, id: t.id });
  if (!app.get().tabs.length) newHomeTab();
  activate(app.get().tabs.includes(active) ? active : app.get().tabs[0]);
}

export async function loadServerState() {
  try { app.set({ server: await get('/api/state') }); } catch { /* offline */ }
  try { app.set({ motionStack: (await get('/api/motion/stack')).stack }); } catch { /* older server */ }
  try { app.set({ proxyQueue: (await get('/api/proxies')).queue }); } catch { /* older server */ }
}

socket.on((msg) => {
  if (msg.projectId) for (const t of tabMap.values()) if (t.projectId === msg.projectId) t.handleMessage(msg);
  if (msg.type === 'job') {
    const prev = app.get().jobs[msg.job.id];
    app.set((s) => ({ ...s, jobs: { ...s.jobs, [msg.job.id]: msg.job } }));
    if ((msg.job.kind === 'video' || msg.job.kind === 'audio') && prev?.status !== msg.job.status) {
      if (msg.job.status === 'done') {
        const job = msg.job;
        notify(`Export finished: ${job.outputRel}`, 'success', job.versionId ? {
          timeout: 8000,
          action: { label: 'Review', run: () => {
            const t = [...tabMap.values()].find((x) => x.projectId === job.projectId);
            if (!t) return;
            activate(t.id);
            t.engine.pause();
            t.ui.set({ mode: 'review', reviewVersion: job.versionId });
          } },
        } : {});
      }
      else if (msg.job.status === 'error') notify(`Export failed: ${msg.job.error}`, 'error');
    }
  } else if (msg.type === 'jobs') {
    app.set((s) => ({ ...s, jobs: Object.fromEntries(msg.jobs.map((j) => [j.id, j])) }));
  } else if (msg.type === 'projectDeleted') {
    for (const [id, t] of [...tabMap]) if (t.projectId === msg.projectId) closeTab(id);
  } else if (msg.type === 'budget') {
    const was = app.get().server?.budget?.level || 0;
    app.set((s) => ({ ...s, server: { ...s.server, budget: msg.budget } }));
    if (msg.budget.level === 2 && was < 2) notify(`Renders slowed down: ${msg.budget.reason}. They pick up again when it frees up.`, 'info', { timeout: 8000 });
  } else if (msg.type === 'gpu') {
    const was = app.get().server?.gpu?.failed;
    app.set((s) => ({ ...s, server: { ...s.server, gpu: msg.gpu } }));
    if (msg.gpu.failed && !was) notify(`The ${msg.gpu.failed.device} GPU failed during an export, so exports use the CPU until Jimmy restarts.`, 'error', { timeout: 10000 });
  } else if (msg.type === 'motion-stack') {
    app.set({ motionStack: msg.stack });
  } else if (msg.type === 'proxy-queue') {
    app.set({ proxyQueue: msg.queue });
  } else if (msg.type === 'motion-ready') {
    // a graphic asked for "now" is done (or failed): say so, with a way to it
    const t = [...tabMap.values()].find((x) => x.projectId === msg.projectId);
    const name = t?.mediaById[msg.mediaId]?.name || 'The graphic';
    if (msg.error) notify(`${name} failed to render: ${msg.error}`, 'error');
    else notify(`${name} is rendered`, 'success', t ? { timeout: 10000, action: { label: 'Show', run: () => { activate(t.id); t.ui.set({ binSelection: [msg.mediaId] }); } } } : {});
  } else if (msg.type === 'needWorker') {
    // no headless browser available on this machine: host the render worker in this page
    app.set({ renderHost: true });
  }
});
// Power source and review playback, for the same "stay out of the way" rule as the timeline playhead.
let onBattery = null;
navigator.getBattery?.().then((b) => {
  const report = () => { onBattery = !b.charging; socket.send({ type: 'activity', battery: onBattery }); };
  b.addEventListener('chargingchange', report);
  report();
}).catch(() => {});
const playingMedia = new Set(); // <video>/<audio> elements on the page (review player, source preview)
const reportMedia = (e, on) => {
  const before = playingMedia.size;
  if (on) playingMedia.add(e.target); else playingMedia.delete(e.target);
  if (!before !== !playingMedia.size) socket.send({ type: 'activity', media: playingMedia.size > 0 });
};
document.addEventListener('play', (e) => {
  reportMedia(e, true);
  // a player taken off the page while playing (leaving Review, closing the preview) pauses without the
  // event ever reaching the document, so listen on the element as well
  e.target.addEventListener('pause', (ev) => reportMedia(ev, false), { once: true });
}, true);
for (const ev of ['pause', 'ended', 'emptied']) document.addEventListener(ev, (e) => reportMedia(e, false), true);
// Someone is working in the editor (clicks, keys, wheel): background work leaves more room for a while
// (server/scheduler.js). At most one message every 3 s.
let inputSent = 0;
const reportInput = () => { const now = Date.now(); if (now - inputSent > 3000) { inputSent = now; socket.send({ type: 'activity', input: true }); } };
for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, reportInput, { capture: true, passive: true });
// The project in the active tab: pre-rendering follows it (server/prerender.js, lighter pre-rendering). A home tab
// can turn into a project without the active tab changing, so this also looks every 2 s (it only sends changes).
let activeSent;
const reportActive = () => {
  const p = activeTab()?.projectId || null;
  if (p !== activeSent && app.get().connected) { activeSent = p; socket.send({ type: 'activity', active: p }); }
};
app.subscribe(reportActive);
setInterval(reportActive, 2000);
socket.onStatus((connected) => {
  if (connected) activeSent = undefined;
  if (connected && onBattery != null) socket.send({ type: 'activity', battery: onBattery });
  if (connected && playingMedia.size) socket.send({ type: 'activity', media: true });
  app.set({ connected });
  reportActive();
  if (connected) for (const t of tabMap.values()) if (t.projectId && t.store.get().status === 'ready') t.refresh().catch(() => {});
});
