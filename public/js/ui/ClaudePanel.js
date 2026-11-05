// Claude panel: the chat view (default) or the embedded Claude Code terminal, one per project. Terminals live outside Preact so they survive
// tab switches; the panel just re-attaches the xterm element.
import { html, Icon, IconButton, Select, Button } from './common.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useStore, createStore, loadPref, savePref } from '../core/store.js';
import { ClaudeChat, chatSession, startChat, sendChatPrompt, disposeChat } from './ClaudeChat.js';
import { app } from '../core/app.js';
import { get, post } from '../core/api.js';
import { notify } from '../core/notify.js';
import { findSequence } from '../core/model.js';
import { currentSeqId, chatFor, seqForChat, liveState, linkChat } from './chatlinks.js';

const THEME = {
  background: '#0d0f14', foreground: '#e4e7ee', cursor: '#a898ff', cursorAccent: '#0d0f14',
  selectionBackground: 'rgba(124, 92, 255, 0.35)',
  black: '#1b1e26', red: '#ff6b81', green: '#3ddc97', yellow: '#f5c451', blue: '#6ea8ff', magenta: '#c49bff', cyan: '#4fd1e8', white: '#d8dce6',
  brightBlack: '#5c6370', brightRed: '#ff8a9c', brightGreen: '#6ff0b5', brightYellow: '#ffd978', brightBlue: '#94c0ff', brightMagenta: '#d9b8ff', brightCyan: '#7fe3f2', brightWhite: '#ffffff',
};

const sessions = new Map();

function send(s, msg) {
  if (s.ws?.readyState === 1) s.ws.send(JSON.stringify(msg));
}

function getSession(projectId) {
  let s = sessions.get(projectId);
  if (s) return s;
  const el = document.createElement('div');
  el.className = 'term-host';
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace',
    fontSize: 13, lineHeight: 1.12, cursorBlink: true, scrollback: 8000, theme: THEME, allowProposedApi: true,
    convertEol: false, macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  s = { projectId, term, fit, el, ws: null, opened: false, alive: true };
  term.onData((d) => send(s, { t: 'i', d }));
  term.onResize(({ cols, rows }) => send(s, { t: 'r', cols, rows }));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Ctrl+V / Ctrl+Shift+V paste: let the browser fire its paste event (xterm would send ^V instead).
    if (ctrl && key === 'v') return false;
    // Ctrl+Shift+C always copies.
    if (ctrl && e.shiftKey && key === 'c') { if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()); e.preventDefault(); return false; }
    // Ctrl+C copies when text is selected (like Windows Terminal), otherwise interrupts.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    // Shift+Enter inserts a newline in Claude Code's prompt instead of submitting.
    if (e.key === 'Enter' && e.shiftKey) { send(s, { t: 'i', d: '\x1b\r' }); return false; }
    return true;
  });
  // Right-click: copy the selection if there is one, otherwise paste (like Windows Terminal).
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (term.hasSelection()) { navigator.clipboard?.writeText(term.getSelection()); term.clearSelection(); return; }
    try { const txt = await navigator.clipboard.readText(); if (txt) term.paste(txt); } catch { /* clipboard blocked */ }
  });
  connect(s);
  sessions.set(projectId, s);
  return s;
}

function connect(s) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?project=${s.projectId}`);
  s.ws = ws;
  ws.onopen = () => { if (s.opened) send(s, { t: 'r', cols: s.term.cols, rows: s.term.rows }); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'o') s.term.write(m.d);
    else if (m.t === 'reset') s.term.reset();
    else if (m.t === 'exit') s.term.write('\r\n\x1b[2m— session ended —\x1b[0m\r\n');
  };
  ws.onclose = () => { if (s.alive) setTimeout(() => connect(s), 1500); };
}

export function disposeTerminal(projectId) {
  disposeChat(projectId);
  const s = sessions.get(projectId);
  if (!s) return;
  s.alive = false;
  s.ws?.close();
  s.term.dispose();
  sessions.delete(projectId);
}

function fitSoon(s) {
  requestAnimationFrame(() => {
    if (!s.opened || !s.el.isConnected || !s.el.clientWidth) return;
    try { s.fit.fit(); } catch { /* not visible */ }
  });
}

export async function startClaude(tab, mode, configDir) {
  const s = getSession(tab.projectId);
  const dims = s.opened ? s.fit.proposeDimensions() : null;
  const body = { mode, cols: dims?.cols || 100, rows: dims?.rows || 30 };
  if (configDir !== undefined) body.configDir = configDir;
  const info = await post(`/api/p/${tab.projectId}/terminal/start`, body);
  tab.store.set({ terminal: info });
  setTimeout(() => s.term.focus(), 50);
  return info;
}

// Is the chat a prompt would go to in the middle of a turn? Nothing new is sent to it until the turn ends or is
// stopped. seqId: the sequence it's about (its linked chat), default the one the editor is on.
export function useClaudeBusy(tab, seqId) {
  const shownBusy = useStore(chatSession(tab.projectId).store, (s) => !!(s.info?.busy || s.info?.compacting));
  const shownSid = useStore(chatSession(tab.projectId).store, (s) => (s.info?.running ? s.info.sessionId : null));
  useStore(tab.store, (s) => s.chatsLive);
  useStore(tab.store, (s) => s.chatLinks);
  useStore(tab.ui, (s) => `${s.mode}|${s.reviewVersion}|${s.sequenceId}`);
  const sid = chatFor(tab, seqId !== undefined ? seqId : currentSeqId(tab));
  return sid && sid !== shownSid ? liveState(tab, sid).busy : shownBusy;
}

// Send a prompt into this project's Claude session: to the chat linked to the sequence it's about (seqId,
// default the one the editor is on), in the background, else to the chat shown in the panel (or the terminal
// view, when Claude runs there). Returns false if it wasn't sent.
export async function sendToClaude(tab, text, seqId) {
  const seq = seqId !== undefined ? seqId : currentSeqId(tab);
  const sid = chatFor(tab, seq);
  const shown = chatSession(tab.projectId).store.get().info;
  if (sid && shown?.agent !== 'codex' && !(shown?.running && shown.sessionId === sid)) {
    const name = findSequence(tab.doc, seq)?.name || 'sequence';
    if (liveState(tab, sid).busy) { notify(`The "${name}" chat is still working: wait for it to finish`, 'error'); return false; }
    try {
      await sendChatPrompt(tab.projectId, text, { sessionId: sid });
      notify(`Sent to the "${name}" chat`, 'claude');
      return true;
    } catch (err) {
      notify(err.message, 'error');
      return false;
    }
  }
  tab.ui.set({ claudeOpen: true });
  if (viewStore.get().view === 'terminal') {
    const t = await get(`/api/p/${tab.projectId}/terminal`).catch(() => ({ chats: 0 }));
    if (t.running && t.mode !== 'shell') {
      tab.store.set({ terminal: t });
      try { await post(`/api/p/${tab.projectId}/terminal/send`, { text }); notify('Sent to Claude', 'claude'); } catch (err) { notify(err.message, 'error'); }
      return;
    }
    setView('chat');
  }
  const info = chatSession(tab.projectId).store.get().info;
  if (info?.busy || info?.compacting) { notify('Claude is still working: wait for it to finish, or press Stop', 'error'); return false; }
  try {
    await sendChatPrompt(tab.projectId, text);
    notify('Sent to Claude', 'claude');
    return true;
  } catch (err) {
    notify(err.message, 'error');
    return false;
  }
}

const viewStore = createStore({ view: loadPref('claude.view', 'chat') });
function setView(view) { savePref('claude.view', view); viewStore.set({ view }); }

export function ClaudePanel({ tab }) {
  const view = useStore(viewStore, (s) => s.view);
  const terminal = useStore(tab.store, (s) => s.terminal);
  const chat = useStore(chatSession(tab.projectId).store, (s) => s.info);
  const dir = useStore(tab.store, (s) => s.dir);
  const server = useStore(app, (s) => s.server);
  const [info, setInfo] = useState(null);
  const pid = tab.projectId;
  const termRunning = !!terminal?.running;
  const chatRunning = !!chat?.running;

  useEffect(() => {
    let alive = true;
    get(`/api/p/${pid}/terminal`).then((r) => alive && setInfo(r)).catch(() => {});
    return () => { alive = false; };
  }, [pid, termRunning, chatRunning]);

  const [history, setHistory] = useState(false);
  // the open chat's name, shown under the header (re-read when a reply ends: a new chat is named from its first message)
  const sid = chatRunning ? chat?.sessionId : null;
  const [chatTitle, setChatTitle] = useState(null);
  const [naming, setNaming] = useState(null);
  const loadTitle = () => (sid ? get(`/api/p/${pid}/chats`).then((r) => setChatTitle((r.chats || []).find((c) => c.id === sid)?.title || null)).catch(() => {}) : setChatTitle(null));
  useEffect(() => { setNaming(null); loadTitle(); }, [pid, sid, !!chat?.busy, history]);
  const saveTitle = async () => {
    const name = naming;
    setNaming(null);
    if (name == null || !sid) return;
    await post(`/api/p/${pid}/chats/${sid}/name`, { name }).catch((err) => notify(err.message, 'error'));
    loadTitle();
  };
  const bgBusy = (useStore(tab.store, (s) => s.chatsLive) || []).filter((c) => !c.shown && (c.busy || c.waiting)).length;
  const setProfile = async (v) => {
    // Each project remembers its own Claude account.
    await post(`/api/p/${pid}/account`, { configDir: v || null });
    setInfo(await get(`/api/p/${pid}/terminal`));
    // A chat that is open but idle moves to the new account right away (the same conversation, if it has one).
    if (chatRunning && !chat?.busy) {
      const name = (profiles.find((p) => p.dir === v)?.name || 'the default account').replace(/^\.claude[-_.]/, '');
      await chatStart(chat.sessionId ? 'resume' : 'new', chat.sessionId);
      notify(chat.sessionId ? `This chat continues on ${name}` : `New chat on ${name}`, 'claude');
    } else if (chatRunning) notify('Claude is replying. The new account starts with your next chat.', 'info');
    else if (termRunning) notify('Start a new chat in the terminal to use the new account', 'info');
  };
  const chatStart = async (mode, sessionId) => {
    try { await startChat(pid, mode, sessionId); } catch (err) { notify(err.message, 'error'); }
  };
  // Claude or Codex, saved per project; a running session keeps its agent until a new chat starts
  const agent = info?.agent || chat?.agent || 'claude';
  const setAgent = async (v) => {
    await post(`/api/p/${pid}/account`, { agent: v });
    setInfo(await get(`/api/p/${pid}/terminal`));
    if (chatRunning || termRunning) notify(`Start a new chat to switch to ${v === 'codex' ? 'Codex' : 'Claude'}`, 'info');
    else chatSession(pid).store.set({ info: await get(`/api/p/${pid}/chat`) });
  };
  const profiles = server?.claudeProfiles || [];
  const folder = dir ? dir.split(/[\\/]/).pop() : '';
  const running = view === 'chat' ? chatRunning : termRunning;

  return html`<aside class="panel claude">
    <header class="panel-head claude-head">
      <span class="claude-mark"><${Icon} name="sparkle" size=${15} /></span>
      <${Select} class="select-sm claude-agent" title="Which AI runs this project's chat and terminal" value=${agent} onChange=${setAgent}
        options=${[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]} />
      <span class="status-dot ${running ? 'is-on' : ''}" title=${running ? 'Session running' : 'No session'}></span>
      <div class="claude-view" role="tablist">
        <button class=${view === 'chat' ? 'is-on' : ''} onClick=${() => setView('chat')} title="Chat view">Chat</button>
        <button class=${view === 'terminal' ? 'is-on' : ''} onClick=${() => setView('terminal')} title=${agent === 'codex' ? 'Terminal view (Codex CLI)' : 'Terminal view (Claude Code CLI)'}>Terminal</button>
      </div>
      <div class="spacer"></div>
      ${view === 'chat' ? html`
        ${profiles.length > 1 && agent !== 'codex' ? html`<${Select} class="select-sm claude-acct" title="Claude account for this project" value=${info?.configDir || ''} onChange=${setProfile}
          options=${[{ value: '', label: 'Default account' }, ...profiles.map((p) => ({ value: p.dir, label: p.name }))]} />` : null}
        ${agent !== 'codex' ? html`<span class="cc-hist-btn">
          <${IconButton} icon="clock" title=${bgBusy ? `All chats for this project (${bgBusy} working in the background)` : 'All chats for this project (from every account)'} active=${history} onClick=${() => setHistory(!history)} />
          ${bgBusy ? html`<i class="cc-hist-dot"></i>` : null}</span>` : null}
        <${IconButton} icon="plus" title="New chat" onClick=${() => chatStart('new')} />
        ${chatRunning ? html`<${IconButton} icon="x" title="End this chat session" onClick=${() => post(`/api/p/${pid}/chat/stop`)} />` : null}` : null}
    </header>
    ${view === 'chat' && chatRunning && agent !== 'codex' ? html`<div class="claude-chat-title">
      ${naming != null ? html`<input class="input" value=${naming} placeholder=${chatTitle || 'Chat name'} ref=${focusOnce}
          onInput=${(e) => setNaming(e.currentTarget.value)} onBlur=${saveTitle}
          onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />`
        : html`<span class="claude-chat-name" title=${chatTitle || ''} onDblClick=${() => sid && setNaming(chatTitle || '')}>${chatTitle || (sid ? 'Chat' : 'New chat')}</span>
          ${sid ? html`<${IconButton} icon="pen" size=${12} title="Rename this chat" onClick=${() => setNaming(chatTitle || '')} />` : null}
          ${sid ? html`<${ChatSequencePicker} tab=${tab} sid=${sid} />` : null}`}
    </div>` : null}
    ${view === 'chat' && agent !== 'codex' ? html`<${LinkedChats} tab=${tab} shownSid=${sid} onOpen=${(id) => chatStart('resume', id)} />` : null}
    ${view === 'chat'
      ? html`<div class="claude-body is-chat"><${ClaudeChat} key=${pid} tab=${tab} chatsCount=${info?.chats || 0}
          onNew=${() => chatStart('new')} onContinue=${() => chatStart('continue')} onHistory=${() => setHistory(true)} /></div>`
      : html`<${TerminalView} tab=${tab} info=${info} agent=${agent} folder=${folder} dir=${dir} profiles=${profiles} setProfile=${setProfile} />`}
    ${history && view === 'chat' ? html`<${ChatHistory} tab=${tab} pid=${pid} current=${chatRunning ? chat?.sessionId : null}
      onPick=${(id) => { setHistory(false); if (id !== chat?.sessionId || !chatRunning) chatStart('resume', id); }} onClose=${() => setHistory(false)} />` : null}
  </aside>`;
}

// Which sequence the open chat works on: its messages and review comments then come to it.
function ChatSequencePicker({ tab, sid }) {
  const doc = useStore(tab.store, (s) => s.doc);
  useStore(tab.store, (s) => s.chatLinks);
  const cur = seqForChat(tab, sid);
  const set = (v) => (v ? linkChat(tab, v, sid) : cur && linkChat(tab, cur.id, null));
  return html`<${Select} class="select-xs claude-chat-seq" value=${cur?.id || ''} onChange=${set}
    title="The sequence this chat works on: messages and review comments about it come to this chat, even while you read another"
    options=${[{ value: '', label: 'No sequence' }, ...(doc?.sequences || []).map((s) => ({ value: s.id, label: s.name }))]} />`;
}

// The chats linked to sequences, with what each is doing. Clicking one shows it (a running chat comes back at
// once); the rest keep working in the background.
function LinkedChats({ tab, shownSid, onOpen }) {
  const links = useStore(tab.store, (s) => s.chatLinks) || {};
  const doc = useStore(tab.store, (s) => s.doc);
  const shownInfo = useStore(chatSession(tab.projectId).store, (s) => s.info);
  useStore(tab.store, (s) => s.chatsLive);
  const rows = Object.entries(links).map(([seqId, sid]) => ({ seq: doc && findSequence(doc, seqId), sid })).filter((r) => r.seq);
  if (!rows.length) return null;
  return html`<div class="claude-linked">${rows.map(({ seq, sid }) => {
    const shown = sid === shownSid;
    const st = shown ? { live: true, busy: !!(shownInfo?.busy || shownInfo?.compacting), waiting: false } : liveState(tab, sid);
    const what = st.waiting ? 'needs your answer' : st.busy ? 'working' : st.live ? 'ready' : 'not started yet (starts with its next message)';
    return html`<button key=${sid} class=${`claude-linked-chip ${shown ? 'is-on' : ''} ${st.busy ? 'is-busy' : ''} ${st.waiting ? 'is-ask' : ''}`}
      title=${`${seq.name}: ${what}${shown ? ' · shown' : ' · click to show'}`} onClick=${() => !shown && onOpen(sid)}>
      <i class="claude-linked-dot"></i>${seq.name}</button>`;
  })}</div>`;
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};

// Every saved chat for this project, whichever Claude account it was made with. Picking one continues it
// with the project's current account (the server copies the chat over when needed).
const focusOnce = (el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus(); el.select(); } };

// Chats keep working in the background when another one is opened; the list shows which are still going.
function ChatHistory({ tab, pid, current, onPick, onClose }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // { id, name }
  const live = useStore(tab.store, (s) => s.chatsLive) || [];
  const load = () => get(`/api/p/${pid}/chats`).then((r) => { setList(r.chats || []); tab.store.set({ chatsLive: r.live || [] }); }).catch(() => setList([]));
  useEffect(() => { load(); }, [pid]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (editing ? setEditing(null) : onClose()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);
  const saveName = async () => {
    const e = editing;
    setEditing(null);
    if (!e) return;
    await post(`/api/p/${pid}/chats/${e.id}/name`, { name: e.name }).catch((err) => notify(err.message, 'error'));
    load();
  };
  const shown = (list || []).filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  const state = (c) => {
    const l = live.find((x) => x.sessionId === c.id);
    return !l ? null : l.waiting ? 'Needs your answer' : l.busy ? 'Working…' : l.shown ? null : 'Ready';
  };
  return html`<div class="cc-hist" onMouseDown=${(e) => e.stopPropagation()}>
    <div class="cc-hist-head">
      <input class="input" placeholder="Search chats" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} autoFocus />
      <${IconButton} icon="x" title="Close" onClick=${onClose} />
    </div>
    <div class="cc-hist-list">
      ${list === null ? html`<div class="cc-hist-note">Loading…</div>`
        : !shown.length ? html`<div class="cc-hist-note">${list.length ? 'No chat matches.' : 'No saved chats for this project yet.'}</div>`
        : shown.map((c) => editing?.id === c.id ? html`<div key=${c.id} class="cc-hist-row is-edit">
            <input class="input" value=${editing.name} placeholder=${c.name ? '' : c.title} ref=${focusOnce}
              onInput=${(e) => setEditing({ id: c.id, name: e.currentTarget.value })}
              onKeyDown=${(e) => { if (e.key === 'Enter') saveName(); e.stopPropagation(); if (e.key === 'Escape') setEditing(null); }} onBlur=${saveName} />
          </div>` : html`<div key=${c.id} class=${`cc-hist-row ${c.id === current ? 'is-on' : ''}`} onClick=${() => onPick(c.id)} title=${c.title}>
            <div class="cc-hist-main">
              <span class="cc-hist-title">${c.title}</span>
              <small>${ago(c.updatedAt)} · ${c.accounts.join(', ')}${c.id === current ? ' · open now' : ''}</small>
            </div>
            ${state(c) ? html`<span class=${`cc-hist-state ${state(c) === 'Working…' ? 'is-busy' : ''}`}>${state(c)}</span>` : null}
            <${IconButton} icon="pen" size=${13} title="Rename this chat" onClick=${(e) => { e.stopPropagation(); setEditing({ id: c.id, name: c.name || '' }); }} />
          </div>`)}
    </div>
    <div class="cc-hist-note">Chats keep working when you switch to another. Picking one continues it with this project's account.</div>
  </div>`;
}

function TerminalView({ tab, info, agent, folder, dir, profiles, setProfile }) {
  const terminal = useStore(tab.store, (s) => s.terminal);
  const hostRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const running = !!terminal?.running;
  const pid = tab.projectId;

  useLayoutEffect(() => {
    const s = getSession(pid);
    hostRef.current.appendChild(s.el);
    if (!s.opened) { s.term.open(s.el); s.opened = true; }
    fitSoon(s);
    const ro = new ResizeObserver(() => fitSoon(s));
    ro.observe(hostRef.current);
    const onWin = () => fitSoon(s);
    window.addEventListener('resize', onWin);
    return () => { ro.disconnect(); window.removeEventListener('resize', onWin); s.el.remove(); };
  }, [pid]);

  const start = async (mode) => {
    setBusy(true);
    // the account comes from Settings / the picker below (saved server-side); don't resend it here
    try { await startClaude(tab, mode); } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); }
  };
  const stop = async () => { await post(`/api/p/${pid}/terminal/stop`); tab.store.set({ terminal: { running: false, exists: false } }); };

  return html`<div class="claude-body">
      ${running ? html`<div class="term-tools">
        <${IconButton} icon="plus" title="New chat (restarts the session)" onClick=${() => start('new')} />
        <${IconButton} icon="clock" title="Pick a past chat" onClick=${() => start('resume')} />
        <${IconButton} icon="x" title="Stop session" onClick=${stop} />
      </div>` : null}
      <div class="term-wrap" ref=${hostRef} onClick=${() => sessions.get(pid)?.term.focus()}></div>
      ${!running ? html`<div class="claude-start">
        <div class="claude-start-card">
          <div class="claude-start-icon"><${Icon} name="terminal" size=${22} /></div>
          <h3>${agent === 'codex' ? 'Codex terminal' : 'Claude Code terminal'}</h3>
          <p>Runs <code>${agent === 'codex' ? 'codex' : 'claude'}</code> in <code title=${dir}>${folder}</code>. The Chat view does the same in a friendlier window.</p>
          <div class="claude-start-btns">
            ${info?.chats > 0 ? html`<${Button} kind="primary" icon="refresh" disabled=${busy} onClick=${() => start('continue')}>Continue last chat</${Button}>` : null}
            <${Button} kind=${info?.chats > 0 ? 'default' : 'primary'} icon="plus" disabled=${busy} onClick=${() => start('new')}>New chat</${Button}>
            ${info?.chats > 0 ? html`<${Button} icon="clock" disabled=${busy} onClick=${() => start('resume')}>Pick a past chat (${info.chats})</${Button}>` : null}
            <${Button} kind="ghost" icon="terminal" disabled=${busy} onClick=${() => start('shell')}>Plain terminal</${Button}>
          </div>
          ${profiles.length > 1 && agent !== 'codex' ? html`<label class="claude-profile"><span>Account</span>
            <${Select} class="select-sm" value=${info?.configDir || ''} onChange=${setProfile}
              options=${[{ value: '', label: 'Default environment' }, ...profiles.map((p) => ({ value: p.dir, label: p.name }))]} />
          </label>` : null}
          ${agent === 'codex' ? html`<button class="link-btn" disabled=${busy} onClick=${() => start('login')}>Sign in to Codex (ChatGPT account)…</button>` : null}
        </div>
      </div>` : null}
    </div>`;
}
