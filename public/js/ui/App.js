// App shell: top bar with project tabs, the active tab's workspace, global shortcuts and overlays.
import { html, Icon, IconButton, Button, Segmented, usePanelSize, Resizer, DialogHost, MenuHost, Toasts, timeAgo } from './common.js';
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { app, getTab, activeTab, activate, closeTab, newHomeTab } from '../core/app.js';
import { overlays, openDialog, notify } from '../core/notify.js';
import { get, post, clientId } from '../core/api.js';
import { Home } from './Home.js';
import { Bin } from './Bin.js';
import { Viewer } from './Viewer.js';
import { Timeline, handleTimelineKey } from './Timeline.js';
import { Inspector } from './Inspector.js';
import { GraphEditor } from './GraphEditor.js';
import { ClaudePanel, disposeTerminal, sendToClaude } from './ClaudePanel.js';
import { ReviewMode } from './Review.js';
import { ExportDialog, SettingsDialog, GpuAskDialog, confirmDialog } from './dialogs.js';
import { openShortcuts } from './shortcuts.js';
import { commandOf, shortcutLabel } from './keymap.js';
import { MotionMode } from './MotionMode.js';
import { startAutoFix } from './autofix.js';

export function App() {
  const tabs = useStore(app, (s) => s.tabs);
  const activeId = useStore(app, (s) => s.activeId);
  const renderHost = useStore(app, (s) => s.renderHost);
  const tab = getTab(activeId);
  const projectName = useStore(tab?.store, (s) => s.doc?.name);
  useEffect(() => { document.title = projectName ? `${projectName} · Jimmy - The Editor` : 'Jimmy - The Editor'; }, [projectName]);
  // a GPU that helps was found and nobody was asked yet: ask once
  const gpuAsk = useStore(app, (s) => s.server?.gpu?.ask);
  useEffect(() => { if (gpuAsk && !overlays.get().dialog) openDialog(GpuAskDialog, { device: gpuAsk }); }, [gpuAsk?.id]);

  useEffect(() => {
    // which command a key runs comes from the keyboard layout (keymap.js, edited in Keyboard Shortcuts)
    const onKey = (e) => {
      const t = activeTab();
      const mode = t?.ui.get().mode;
      const cmd = commandOf(e, mode === 'edit' ? 'edit' : null);
      // Premiere's Ctrl+Alt+K; works on the home screen too
      if (cmd === 'app.shortcuts' && !overlays.get().dialog) { e.preventDefault(); openShortcuts(); return; }
      if (!t?.projectId || t.store.get().status !== 'ready') return;
      if (overlays.get().dialog || overlays.get().menu) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"], .xterm')) return;
      if (cmd === 'app.undo') { e.preventDefault(); t.undo(); return; }
      if (cmd === 'app.redo') { e.preventDefault(); t.redo(); return; }
      if (cmd === 'app.export') { e.preventDefault(); openDialog(ExportDialog, { tab: t }); return; }
      if (cmd === 'app.claude') { e.preventDefault(); t.ui.set({ claudeOpen: !t.ui.get().claudeOpen }); return; }
      if (mode !== 'edit' || !cmd) return;
      const eng = t.engine;
      if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) e.target.blur();
      const second = Math.round(t.seq?.fps || 30);
      const play = {
        'play.toggle': () => eng.toggle(),
        'play.left': () => eng.shuttle(-1),
        'play.stop': () => eng.shuttle(0),
        'play.right': () => eng.shuttle(1),
        'play.prevFrame': () => eng.step(-1),
        'play.nextFrame': () => eng.step(1),
        'play.prevSecond': () => eng.step(-second),
        'play.nextSecond': () => eng.step(second),
        'play.start': () => { eng.pause(); eng.seek(0); },
        'play.end': () => { eng.pause(); eng.seek(1e9); },
      }[cmd];
      if (play) { e.preventDefault(); play(); return; }
      if (handleTimelineKey(t, e, cmd)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return html`<div class="app">
    <${TopBar} tabs=${tabs} activeId=${activeId} tab=${tab} />
    <main class="app-main">
      ${tab ? (tab.projectId ? html`<${Workspace} key=${tab.id} tab=${tab} />` : html`<${Home} key=${tab.id} />`) : null}
    </main>
    <${DialogHost} />
    <${MenuHost} />
    <${Toasts} />
    ${renderHost ? html`<iframe class="render-host" src="/render.html?worker=ui" title="render worker"></iframe>` : null}
  </div>`;
}

// ------------------------------------------------------------------ top bar

function TopBar({ tabs, activeId, tab }) {
  const connected = useStore(app, (s) => s.connected);
  return html`<header class="topbar">
    <div class="brand" title="Jimmy - The Editor">
      <img class="brand-mark" src="/icon.svg" alt="" />
      <span class="brand-name">Jimmy <span class="brand-sub">The Editor</span></span>
    </div>
    <nav class="tabs">
      ${tabs.map((id) => html`<${TabButton} key=${id} id=${id} active=${id === activeId} />`)}
      <button class="tab-new" title="New tab" onClick=${() => newHomeTab()}><${Icon} name="plus" size=${15} /></button>
    </nav>
    <div class="topbar-right">
      ${!connected ? html`<span class="conn-badge" title="Reconnecting to the Jimmy server…"><span class="spinner spinner-xs"></span>Offline</span>` : null}
      ${tab?.projectId ? html`<${TabControls} tab=${tab} />` : null}
      <${ProxyQueueButton} />
      <${MotionStackButton} />
      <${JobsButton} />
      <${IconButton} icon="keyboard" title="Keyboard shortcuts" kbd=${shortcutLabel('app.shortcuts')} onClick=${() => openShortcuts()} />
      <${IconButton} icon="sliders" title="Settings" onClick=${() => openDialog(SettingsDialog, {})} />
    </div>
  </header>`;
}

function TabButton({ id, active }) {
  const tab = getTab(id);
  const name = useStore(tab.store, (s) => s.doc?.name || (s.status === 'home' ? 'Home' : s.status === 'loading' ? 'Loading…' : 'Project'));
  const claudeAt = useStore(tab.store, (s) => s.claudeAt);
  const running = useStore(tab.store, (s) => !!s.terminal?.running || !!s.chat?.running);
  const err = useStore(tab.store, (s) => !!s.projectError);
  // Closing a project shuts it down: what it still has running (exports, proxies, motion graphics, a Claude reply)
  // is listed first and stops only if the person says so. Pre-rendering just stops. A project another window
  // also has open keeps going.
  const close = async (e) => {
    e.stopPropagation();
    const pid = tab.projectId;
    if (!pid) { closeTab(id); return; }
    const w = await get(`/api/p/${pid}/work?client=${encodeURIComponent(clientId)}`).catch(() => null);
    const items = !w || w.others ? [] : [
      w.exports && `${w.exports} export${w.exports > 1 ? 's' : ''}`,
      w.proxies && `${w.proxies} proxy file${w.proxies > 1 ? 's' : ''}`,
      w.graphics && `${w.graphics} motion graphic${w.graphics > 1 ? 's' : ''}`,
      w.chats && `Claude working on ${w.chats > 1 ? `${w.chats} replies` : 'a reply'}`,
    ].filter(Boolean);
    const several = items.length > 1 || w.exports + w.proxies + w.graphics + w.chats > 1;
    if (items.length && !(await confirmDialog(`Close ${name}?`, `Still running for this project: ${items.join(', ')}. Closing the project stops ${several ? 'them' : 'it'}.`, 'Stop and close'))) return;
    for (let i = 0; i < 30 && tab.saving; i++) await new Promise((r) => setTimeout(r, 100)); // a save on its way finishes first
    disposeTerminal(pid);
    closeTab(id);
    post(`/api/p/${pid}/close`, { client: clientId }).catch(() => {});
  };
  return html`<div class="tab ${active ? 'is-active' : ''}" role="tab" onClick=${() => activate(id)} onAuxClick=${(e) => { if (e.button === 1) close(e); }}
    title=${tab.projectId ? `${name}${running ? ' · Claude running' : ''}` : 'Home'}>
    ${tab.projectId
      ? html`<span key=${claudeAt} class="tab-dot ${running ? 'is-live' : ''} ${err ? 'is-error' : ''} ${claudeAt && Date.now() - claudeAt < 3000 ? 'is-pulse' : ''}"></span>`
      : html`<${Icon} name="home" size=${13} />`}
    <span class="tab-name">${name}</span>
    <button class="tab-close" title="Close the project (stops its exports, proxies and Claude chats; asks first if any are running)" onClick=${close}><${Icon} name="x" size=${12} /></button>
  </div>`;
}

function TabControls({ tab }) {
  const mode = useStore(tab.ui, (s) => s.mode);
  const claudeOpen = useStore(tab.ui, (s) => s.claudeOpen);
  const ready = useStore(tab.store, (s) => s.status === 'ready');
  const openComments = useStore(tab.store, (s) => (s.reviews?.comments || []).filter((c) => !c.resolved).length);
  if (!ready) return null;
  return html`
    <${Segmented} class="mode-switch" value=${mode} onChange=${(m) => {
        tab.engine.pause();
        // opening Motion with a motion-graphic clip selected edits that graphic
        const clip = m === 'motion' && tab.seq?.clips.find((c) => tab.ui.get().selection?.includes(c.id) && tab.mediaById[c.media]?.motion);
        tab.ui.set({ mode: m, ...(clip ? { motionMedia: clip.media } : {}) });
      }}
      options=${[{ value: 'edit', label: 'Edit', icon: 'scissors' }, { value: 'motion', label: 'Motion', icon: 'wand' }, { value: 'review', label: 'Review', icon: 'message', badge: openComments || null, title: openComments ? `Review · ${openComments} open comment${openComments === 1 ? '' : 's'}` : 'Review' }]} />
    <${Button} kind="primary" icon="download" title=${`Export (${shortcutLabel('app.export')})`} onClick=${() => openDialog(ExportDialog, { tab })}>Export</${Button}>
    <${IconButton} icon="sparkle" title="Claude panel" kbd=${shortcutLabel('app.claude')} active=${claudeOpen} onClick=${() => tab.ui.set({ claudeOpen: !claudeOpen })} />`;
}

// The proxy queue: preview files being made for footage, then the ones waiting, in the order they start. Proxies the
// viewer needs (footage it can't play) come first by themselves; "Make now" moves one to the front. The line under
// the title says how much of the machine background work gets now (server/scheduler.js).
const SCHED_MODE = { idle: 'you are away: background work gets the whole machine', editing: 'you are editing: background work gets about 70%', playing: 'playing: background work gets about a third', scrubbing: 'scrubbing: background work gets about a third' };
function ProxyQueueButton() {
  const queue = useStore(app, (s) => s.proxyQueue) || [];
  const budget = useStore(app, (s) => s.server?.budget);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!e.target.closest('.jobs')) setOpen(null); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { if (!queue.length) setOpen(null); }, [queue.length]);
  if (!queue.length) return null;
  const running = queue.filter((x) => x.state === 'running');
  const waiting = queue.filter((x) => x.state !== 'running');
  const rush = (key) => post('/api/proxies/rush', { key }).catch((e) => notify(e.message, 'error'));
  const toggle = (e) => {
    if (open) { setOpen(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setOpen({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  const row = (x, i) => html`<div class="job-row stack-row" key=${x.key}>
    <div class="job-top">
      <div class="job-names"><b>${x.name}</b><span class="job-project"><${Icon} name="folder" size=${11} />${x.project}</span></div>
      <span class="job-status is-${x.state === 'running' ? 'rendering' : 'queued'}">${x.state === 'running' ? `${Math.round(x.progress * 100)}%` : `#${i + 1}`}${x.needed ? ' · needed to play' : ''}${x.rush ? ' · next' : ''}</span>
    </div>
    ${x.state === 'running' ? html`<div class="progress"><div style=${{ width: `${Math.round(x.progress * 100)}%` }}></div></div>` : null}
    ${x.state !== 'running' && !x.rush ? html`<div class="job-actions"><div class="spacer"></div>
      <button class="link-btn" title="Make this proxy next" onClick=${() => rush(x.key)}>Make now</button></div>` : null}
  </div>`;
  return html`<div class="jobs">
    <button class="icon-btn with-label jobs-btn ${running.length ? 'is-busy' : ''}" onClick=${toggle} title="Proxy queue: preview files being made">
      ${running.length ? html`<span class="spinner spinner-xs"></span>` : html`<${Icon} name="film" size=${15} />`}
      <span>${queue.length} prox${queue.length > 1 ? 'ies' : 'y'}</span>
    </button>
    ${open ? html`<div class="jobs-pop" style=${{ top: `${open.top}px`, right: `${open.right}px` }}>
      <div class="jobs-pop-head"><b>Proxy queue</b><div class="spacer"></div>
        <${IconButton} icon="x" size=${14} title="Close (Esc)" onClick=${() => setOpen(null)} /></div>
      ${budget?.mode ? html`<div class="stack-label">${SCHED_MODE[budget.mode] || ''}${budget.shares ? ` · ${budget.shares.media || 0} at once now` : ''}</div>` : null}
      ${running.map((x) => row(x, -1))}
      ${waiting.length ? html`<div class="stack-label">Waiting: the footage the viewer needs first, then in timeline order.</div>` : null}
      ${waiting.map((x, i) => row(x, i))}
    </div>` : null}
  </div>`;
}

// The motion graphics render stack: what renders now and what waits, in order. Drag to reorder;
// "Render now" pauses a running graphic (it keeps its progress) until this one is done.
function MotionStackButton() {
  const stack = useStore(app, (s) => s.motionStack) || [];
  const [open, setOpen] = useState(null);
  const [drag, setDrag] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!e.target.closest('.jobs')) setOpen(null); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => { if (!stack.length) setOpen(null); }, [stack.length]);
  if (!stack.length) return null;
  const rendering = stack.filter((x) => x.state === 'rendering');
  const waiting = stack.filter((x) => x.state !== 'rendering');
  const order = (keys) => post('/api/motion/stack/order', { keys }).catch((e) => notify(e.message, 'error'));
  const move = (key, to) => {
    const keys = waiting.map((x) => x.key).filter((k) => k !== key);
    keys.splice(Math.max(0, Math.min(keys.length, to)), 0, key);
    order(keys);
  };
  const rush = (key) => post('/api/motion/stack/rush', { key }).catch((e) => notify(e.message, 'error'));
  const hold = (key, paused) => post('/api/motion/stack/pause', { key, paused }).catch((e) => notify(e.message, 'error'));
  const toggle = (e) => {
    if (open) { setOpen(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setOpen({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  const row = (x, i) => html`<div class="job-row stack-row ${drag === x.key ? 'is-drag' : ''}" key=${x.key}
      draggable=${x.state !== 'rendering'}
      onDragStart=${(e) => { setDrag(x.key); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd=${() => setDrag(null)}
      onDragOver=${(e) => { if (drag && x.state !== 'rendering') e.preventDefault(); }}
      onDrop=${(e) => { e.preventDefault(); if (drag && drag !== x.key) move(drag, i); setDrag(null); }}>
    <div class="job-top">
      ${x.state !== 'rendering' ? html`<span class="stack-grip" title="Drag to change the order"><${Icon} name="grip" size=${12} /></span>` : null}
      <div class="job-names"><b>${x.name}</b><span class="job-project"><${Icon} name="folder" size=${11} />${x.project}</span></div>
      <span class="job-status is-${x.state}">${x.state === 'rendering' ? `${Math.round(x.progress * 100)}%` : x.state === 'held' ? `paused by you${x.progress ? ` · ${Math.round(x.progress * 100)}%` : ''}` : x.state === 'paused' ? `paused · ${Math.round(x.progress * 100)}%` : `#${i + 1}`}${x.afterExport ? ' · after the export' : ''}${x.rush ? ' · now' : ''}</span>
    </div>
    ${x.state !== 'queued' && (x.state !== 'held' || x.progress) ? html`<div class="progress"><div style=${{ width: `${Math.round(x.progress * 100)}%` }}></div></div>` : null}
    ${x.state === 'rendering' ? html`<div class="job-actions"><div class="spacer"></div><button class="link-btn" onClick=${() => hold(x.key, true)}>Pause</button></div>` : null}
    ${x.state !== 'rendering' ? html`<div class="job-actions"><div class="spacer"></div>
      ${x.state === 'held' ? html`<button class="link-btn" onClick=${() => hold(x.key, false)}>Resume</button>` : html`<button class="link-btn" title="Skip this one until you resume it" onClick=${() => hold(x.key, true)}>Pause</button>`}
      ${i > 0 ? html`<${IconButton} icon="up" size=${12} title="Move up" onClick=${() => move(x.key, i - 1)} />` : null}
      ${i < waiting.length - 1 ? html`<${IconButton} icon="down" size=${12} title="Move down" onClick=${() => move(x.key, i + 1)} />` : null}
      <button class="link-btn" title="Render this one next, pausing a running graphic if needed" onClick=${() => rush(x.key)}>Render now</button>
    </div>` : null}
  </div>`;
  return html`<div class="jobs">
    <button class="icon-btn with-label jobs-btn ${rendering.length ? 'is-busy' : ''}" onClick=${toggle} title="Motion graphics render stack">
      ${rendering.length ? html`<span class="spinner spinner-xs"></span>` : html`<${Icon} name="sparkle" size=${15} />`}
      <span>${stack.length} graphic${stack.length > 1 ? 's' : ''}${stack.every((x) => x.state === 'held') ? ' · paused' : ''}</span>
    </button>
    ${open ? html`<div class="jobs-pop" style=${{ top: `${open.top}px`, right: `${open.right}px` }}>
      <div class="jobs-pop-head"><b>Graphics render stack</b><div class="spacer"></div>
        ${stack.some((x) => x.state !== 'held') ? html`<button class="link-btn" title="Pause every graphic in the stack (each keeps its progress)" onClick=${() => post('/api/motion/stack/pause-all', { paused: true }).catch((e) => notify(e.message, 'error'))}>Pause all</button>` : null}
        ${stack.some((x) => x.state === 'held') ? html`<button class="link-btn" onClick=${() => post('/api/motion/stack/pause-all', { paused: false }).catch((e) => notify(e.message, 'error'))}>Resume all</button>` : null}
        <${IconButton} icon="x" size=${14} title="Close (Esc)" onClick=${() => setOpen(null)} /></div>
      ${rendering.map((x) => row(x, -1))}
      ${waiting.length ? html`<div class="stack-label">Waiting, first in first out. Drag to reorder.</div>` : null}
      ${waiting.map((x, i) => row(x, i))}
    </div>` : null}
  </div>`;
}

function JobsButton() {
  const jobs = useStore(app, (s) => s.jobs);
  const budget = useStore(app, (s) => s.server?.budget);
  const easing = budget && (budget.level > 0 || budget.slots < budget.full)
    ? `Renders are running gently: ${budget.level ? budget.reason : 'on battery'}. Full speed returns by itself.` : null;
  const [open, setOpen] = useState(null); // fixed position of the panel while open
  const list = Object.values(jobs).filter((j) => j.kind === 'video' || j.kind === 'audio').sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  const active = list.filter((j) => !['done', 'error', 'canceled'].includes(j.status));
  // the button shows the export being rendered now (the one that started first), not the newest, which may still
  // be waiting its turn at 0%
  const working = active.filter((j) => !j.paused && j.status !== 'queued' && !j.waiting);
  const current = (working.length ? working : active).reduce((a, b) => (b.createdAt < a.createdAt ? b : a), active[0] || {});
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!e.target.closest('.jobs')) setOpen(null); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  if (!list.length) return null;
  const showVersion = (j) => {
    const t = [...(app.get().tabs.map(getTab))].find((x) => x?.projectId === j.projectId);
    if (t) { activate(t.id); t.ui.set({ mode: 'review', reviewVersion: j.versionId }); }
    setOpen(null);
  };
  // The panel is position:fixed so it floats above everything (the top bar clips, the Claude panel overlaps).
  const toggle = (e) => {
    if (open) { setOpen(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setOpen({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  return html`<div class="jobs">
    <button class="icon-btn with-label jobs-btn ${active.length ? 'is-busy' : ''}" onClick=${toggle} title="Exports">
      ${active.length ? html`<span class="spinner spinner-xs"></span>` : html`<${Icon} name="download" size=${15} />`}
      <span>${active.length ? `${Math.round((current.progress || 0) * 100)}%${active.length > 1 ? ` · ${active.length} exports` : ''}${active.every((j) => j.paused) ? ' · paused' : ''}` : 'Exports'}</span>
    </button>
    ${open ? html`<div class="jobs-pop" style=${{ top: `${open.top}px`, right: `${open.right}px` }}>
      <div class="jobs-pop-head"><b>Exports</b><div class="spacer"></div>
        ${active.some((j) => !j.paused && j.status !== 'encoding') ? html`<button class="link-btn" title="Pause every export (rendered parts are kept)" onClick=${() => post('/api/jobs/pause-all', { paused: true }).catch((e) => notify(e.message, 'error'))}>Pause all</button>` : null}
        ${active.some((j) => j.paused) ? html`<button class="link-btn" onClick=${() => post('/api/jobs/pause-all', { paused: false }).catch((e) => notify(e.message, 'error'))}>Resume all</button>` : null}
        <${IconButton} icon="x" size=${14} title="Close (Esc)" onClick=${() => setOpen(null)} /></div>
      ${easing && active.length ? html`<div class="jobs-easing"><${Icon} name="alert" size=${12} />${easing}</div>` : null}
      ${list.map((j) => html`<div class="job-row">
        <div class="job-top"><div class="job-names"><b>${j.label}</b>${j.projectName ? html`<span class="job-project"><${Icon} name="folder" size=${11} />${j.projectName}</span>` : null}</div><span class="job-status is-${j.paused ? 'paused' : j.status}">${j.paused && !['done', 'error', 'canceled', 'encoding'].includes(j.status) ? `paused · ${Math.round(j.progress * 100)}%` : j.status === 'running' && j.waiting ? `${j.waiting === 'export' ? 'after the export ahead' : 'after the graphic rendering'}${j.progress ? ` · ${Math.round(j.progress * 100)}%` : ''}` : j.status === 'running' ? `${Math.round(j.progress * 100)}%${j.eta != null ? ` · ${j.eta}s left` : ''}` : j.status === 'motion' ? 'rendering motion graphics' : j.status === 'encoding' && j.converting ? `converting to ${j.converting.fps} fps · ${Math.round(j.converting.progress * 100)}%` : j.status}</span></div>
        ${!['done', 'error', 'canceled'].includes(j.status) ? html`<div class="progress"><div style=${{ width: `${Math.round((j.progress || 0) * 100)}%` }}></div></div>` : null}
        ${j.error ? html`<div class="job-error">${j.error}</div>` : null}
        <div class="job-actions">
          <span class="muted">${timeAgo(j.createdAt)}${j.engine ? ` · ${j.engine}` : ''}</span><div class="spacer"></div>
          ${j.status === 'done' && j.versionId ? html`<button class="link-btn" onClick=${() => showVersion(j)}>Review</button>` : null}
          ${j.status === 'done' ? html`<button class="link-btn" onClick=${() => post(`/api/p/${j.projectId}/reveal`, { path: j.outputRel })}>Show file</button>` : null}
          ${j.kind !== 'audio' && !['done', 'error', 'canceled', 'encoding'].includes(j.status) ? html`<button class="link-btn" onClick=${() => post(`/api/jobs/${j.id}/pause`, { paused: !j.paused })}>${j.paused ? 'Resume' : 'Pause'}</button>` : null}
          ${!['done', 'error', 'canceled'].includes(j.status) ? html`<button class="link-btn danger" onClick=${() => post(`/api/jobs/${j.id}/cancel`)}>Cancel</button>` : null}
        </div>
      </div>`)}
    </div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ per-tab workspace

function Workspace({ tab }) {
  const status = useStore(tab.store, (s) => s.status);
  const loadError = useStore(tab.store, (s) => s.loadError);
  const projectError = useStore(tab.store, (s) => s.projectError);
  const mode = useStore(tab.ui, (s) => s.mode);
  const claudeOpen = useStore(tab.ui, (s) => s.claudeOpen);
  const [claudeW, startClaude] = usePanelSize('claude', 500, 320, 1100);
  useEffect(() => { if (tab.projectId && status !== 'loading' && status !== 'error') startAutoFix(tab); }, [tab, status]); // timeline comments → Claude

  if (status === 'loading') return html`<div class="loading-screen"><span class="spinner"></span>Opening project…</div>`;
  if (status === 'error') return html`<div class="loading-screen error">Couldn't open this project: ${loadError}</div>`;

  return html`<div class="workspace">
    <div class="work-main">
      ${projectError ? html`<div class="banner banner-error">
        <${Icon} name="alert" size=${15} />
        <span><b>project.json can't be read</b> — ${projectError}. Editing is paused so nothing gets overwritten.</span>
        <div class="spacer"></div>
        <${Button} kind="claude" icon="sparkle" onClick=${() => sendToClaude(tab, `project.json in this folder has a JSON syntax error (${projectError}). Please fix it so Jimmy can load it again.`)}>Ask Claude to fix</${Button}>
        <${Button} kind="ghost" onClick=${() => tab.restoreLastGood()} title="Overwrite project.json with the last version the editor loaded">Restore last good version</${Button}>
      </div>` : null}
      ${mode === 'review' ? html`<${ReviewMode} tab=${tab} />` : mode === 'motion' ? html`<${MotionMode} tab=${tab} />` : html`<${EditMode} tab=${tab} />`}
    </div>
    ${claudeOpen
      ? html`<${Resizer} onPointerDown=${(e) => startClaude(e, -1)} /><div class="claude-dock" style=${{ width: `${claudeW}px` }}><${ClaudePanel} tab=${tab} /></div>`
      : html`<button class="claude-rail" title="Show Claude (Ctrl+J)" onClick=${() => tab.ui.set({ claudeOpen: true })}><${Icon} name="sparkle" size=${16} /><span>Claude</span></button>`}
  </div>`;
}

function EditMode({ tab }) {
  const [binW, startBin] = usePanelSize('bin', 290, 190, 620);
  const [inspW, startInsp] = usePanelSize('insp', 316, 250, 620);
  const [topH, startTop] = usePanelSize('top', 470, 180, 1400);
  const graph = useStore(tab.ui, (s) => s.graph);
  return html`<div class="edit">
    <div class="edit-top" style=${{ height: `${topH}px` }}>
      <div class="col" style=${{ width: `${binW}px` }}><${Bin} tab=${tab} /></div>
      <${Resizer} onPointerDown=${(e) => startBin(e, 1)} />
      <div class="col col-grow"><${Viewer} tab=${tab} /></div>
      <${Resizer} onPointerDown=${(e) => startInsp(e, -1)} />
      <div class="col" style=${{ width: `${inspW}px` }}><${Inspector} tab=${tab} /></div>
    </div>
    <${Resizer} axis="y" onPointerDown=${(e) => startTop(e, 1, 'y')} />
    <div class="edit-bottom"><${Timeline} tab=${tab} /></div>
    ${graph ? html`<${GraphEditor} tab=${tab} />` : null}
  </div>`;
}
