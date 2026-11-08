// Claude chat view: the project's Claude Code session shown like the desktop app's chat —
// message bubbles, collapsible tool steps, permission cards, and a composer with voice typing,
// attachments, timeline context, permission mode and model.
// Sessions live outside Preact (one per project) so they survive tab switches.
import { html, Icon } from './common.js';
import { Component, render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createStore, useStore, loadPref, savePref } from '../core/store.js';
import { get, post } from '../core/api.js';
import { notify } from '../core/notify.js';
import { timecode, clipEnd, trackLabel, findSequence } from '../core/model.js';
import { markdown } from './markdown.js';
import { openAccounts } from './accounts.js';
import { currentSeqId, chatFor, seqForChat, liveState, linkChat } from './chatlinks.js';

// Used until the CLI has reported its own model list (display names + effort levels) once.
export const MODELS = [
  { value: '', displayName: 'Default', description: 'Your account\'s default model', efforts: [] },
  { value: 'opus', displayName: 'Opus', description: 'For complex work and everyday tasks', efforts: [] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Most efficient for simpler tasks', efforts: [] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers', efforts: [] },
];
export const EFFORTS = [
  { value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra high' }, { value: 'max', label: 'Max' },
];
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// "claude-opus-5-5" / "claude-sonnet-4-5-20250929" → "Opus 5.5"
export function prettyModel(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?(?:-\d{8})?/i.exec(id || '');
  if (!m) return id || '';
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// The picker's entries from the CLI list: "default" becomes our '' (no --model flag), extra model ids keep their value.
// Grouped by family (Opus, Sonnet, Haiku…), keeping only each family's two newest versions; `keep` (the
// saved choice) stays listed even if older.
const FAMILY_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];
function modelOptions(list, keep = '') {
  if (!list?.length) return MODELS;
  const all = list.map((x) => {
    const m = { ...x, description: (x.description || '').replace(/\s*·\s*\$.*$/, '') }; // drop the price list
    const resolved = m.resolvedModel ? prettyModel(m.resolvedModel) : '';
    if (m.value === 'default') return { ...m, value: '', displayName: `Default${resolved ? ` · ${resolved}` : ''}` };
    const v = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(m.resolvedModel || m.value);
    // some accounts report just "Opus"; the resolved id gives the exact version ("Opus 5.5")
    return { ...m, displayName: resolved || m.displayName || m.value, family: v ? v[1].toLowerCase() : null, version: v ? +v[2] + (+v[3] || 0) / 10 : 0 };
  });
  const out = all.filter((m) => !m.family); // Default, and non-Claude models (Codex) as listed
  const families = [...new Set(all.filter((m) => m.family).map((m) => m.family))]
    .sort((a, b) => ((FAMILY_ORDER.indexOf(a) + 1) || 9) - ((FAMILY_ORDER.indexOf(b) + 1) || 9));
  for (const f of families) {
    const seen = new Set();
    const mine = all.filter((m) => m.family === f).sort((a, b) => b.version - a.version)
      .filter((m) => { const id = m.resolvedModel || m.value; if (seen.has(id)) return false; seen.add(id); return true; });
    out.push(...mine.filter((m, i) => i < 2 || m.value === keep));
  }
  return out;
}
export const PERMISSION_MODES = [
  { value: 'default', label: 'Ask before edits', short: 'Ask', icon: 'lock' },
  { value: 'acceptEdits', label: 'Auto-accept file edits', short: 'Edits', icon: 'check' },
  { value: 'auto', label: 'Auto — asks only for risky actions', short: 'Auto', icon: 'wand' },
  { value: 'plan', label: 'Plan mode', short: 'Plan', icon: 'layers' },
];

// ------------------------------------------------------------------ session (per project)

const sessions = new Map();

export function chatSession(projectId) {
  let s = sessions.get(projectId);
  if (s) return s;
  s = { projectId, ws: null, alive: true, store: createStore({ info: { running: false }, log: [], stream: null, connected: false }) };
  sessions.set(projectId, s);
  connect(s);
  return s;
}

function connect(s) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat?project=${s.projectId}`);
  s.ws = ws;
  ws.onopen = () => s.store.set({ connected: true });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const st = s.store.get();
    if (m.t === 'reset') s.store.set({ info: m.info, log: m.log || [], stream: null });
    else if (m.t === 'status') s.store.set({ info: m.info });
    else if (m.t === 'msgstart') s.store.set({ stream: { text: '', thinking: '' } });
    else if (m.t === 'delta') {
      const cur = st.stream || { text: '', thinking: '' };
      s.store.set({ stream: m.kind === 'thinking_delta' ? { ...cur, thinking: cur.thinking + m.text } : { ...cur, text: cur.text + m.text } });
    } else if (m.t === 'msg') {
      const patch = { log: [...st.log, m.m] };
      // the finished message replaces the live typing
      if (m.m.type === 'assistant' || m.m.type === 'result') patch.stream = null;
      s.store.set(patch);
    }
  };
  ws.onclose = () => { s.store.set({ connected: false }); if (s.alive) setTimeout(() => connect(s), 1500); };
}

const wsSend = (s, msg) => { if (s.ws?.readyState === 1) { s.ws.send(JSON.stringify(msg)); return true; } return false; };

export function disposeChat(projectId) {
  const s = sessions.get(projectId);
  if (!s) return;
  s.alive = false;
  s.ws?.close();
  sessions.delete(projectId);
}

// mode: 'new', 'continue' (the newest chat) or 'resume' with a sessionId (a chat from the history list);
// linkSequence: a new chat for that sequence (linked once it has started)
export async function startChat(projectId, mode = 'new', sessionId, { linkSequence } = {}) {
  const prefs = loadPref('chat.prefs', {});
  return post(`/api/p/${projectId}/chat/start`, { mode, sessionId, linkSequence, model: prefs.model || '', codexModel: prefs.codexModel || '', effort: prefs.effort || '', permissionMode: prefs.permissionMode || 'default' });
}

// Send a prompt from elsewhere in the editor (starts or continues the chat on the server if needed). With a
// sessionId it goes to that chat (a sequence's linked chat), which works in the background: the panel stays put.
export async function sendChatPrompt(projectId, text, { sessionId, files } = {}) {
  chatSession(projectId);
  const prefs = loadPref('chat.prefs', {});
  await post(`/api/p/${projectId}/chat/send`, { text, files, sessionId: sessionId || undefined, mode: 'continue', model: prefs.model || '', codexModel: prefs.codexModel || '', effort: prefs.effort || '', permissionMode: prefs.permissionMode || 'default' });
}

// Where a message from the editor goes: the chat linked to the sequence you're on (seqId, default the current
// one), else the chat shown in the panel. away: the target isn't the shown chat (it's sent in the background).
export function useChatTarget(tab, seqIdArg) {
  const shown = useStore(chatSession(tab.projectId).store, (s) => s.info);
  useStore(tab.ui, (s) => `${s.mode}|${s.reviewVersion}|${s.sequenceId}`);
  useStore(tab.store, (s) => s.chatLinks);
  useStore(tab.store, (s) => s.chatsLive);
  const doc = useStore(tab.store, (s) => s.doc);
  const seqId = seqIdArg !== undefined ? seqIdArg : currentSeqId(tab);
  const seq = seqId && doc ? findSequence(doc, seqId) : null;
  const codex = (shown?.agent || 'claude') === 'codex';
  const sid = codex ? null : chatFor(tab, seqId);
  const shownSid = shown?.running ? shown.sessionId || null : null;
  const away = !!sid && sid !== shownSid;
  const st = away ? liveState(tab, sid) : { busy: !!(shown?.busy || shown?.compacting) };
  return { seqId, seq, sid, shownSid, away, busy: st.busy, waiting: !!st.waiting, shownSeq: codex ? null : seqForChat(tab, shownSid), codex };
}

// ------------------------------------------------------------------ log → view items

// A note Claude Code gives Claude about its own housekeeping (a watcher timing out, a command lost with an old session).
// Claude answers it because Claude Code asks it to; nobody needs to read that answer.
const HOUSEKEEPING_RE = /^\s*<task-notification>[\s\S]*(Monitor expired|didn't finish before the previous session ended)/;

export function buildItems(log) {
  const items = [];
  let turnOpen = false; // a reply is under way
  let quiet = false; // Claude is answering a housekeeping note
  const results = new Map(); // tool_use_id -> tool_result block
  const answers = new Map(); // permission id -> answer
  const byMsg = new Map();
  for (const m of log) {
    if (m.type === 'user') {
      const content = typeof m.message.content === 'string' ? [{ type: 'text', text: m.message.content }] : m.message.content || [];
      const tr = content.filter((b) => b.type === 'tool_result');
      for (const b of tr) results.set(b.tool_use_id, b);
      if (!tr.length && !m.parent) {
        const note = content.some((b) => b.type === 'text' && HOUSEKEEPING_RE.test(b.text || ''));
        if (note && !turnOpen) quiet = true;
        else if (!note) { quiet = false; turnOpen = true; }
      }
      // (the sequence note a linked chat gets with each message isn't shown)
      const visible = content.filter((b) => (b.type === 'text' && !/^\s*<jimmy-sequence/.test(b.text || '')) || b.type === 'image');
      if (visible.length === 1 && visible[0].text?.trim() === '/compact') continue; // shown as "Conversation compacted" when done
      if (!tr.length && visible.length && !m.parent && !isSystemText(visible)) {
        if (visible.length === 1 && /^\[Request interrupted/.test(visible[0].text || '')) items.push({ kind: 'note', text: 'Interrupted', key: `i${items.length}` });
        else items.push({ kind: 'user', blocks: visible, key: `u${items.length}` });
      }
    } else if (m.type === 'assistant') {
      if (m.parent || m.message.model === '<synthetic>') continue; // sub-agent internals, CLI placeholders
      if (quiet && !(m.message.content || []).some((b) => b.type === 'tool_use')) continue;
      quiet = false;
      turnOpen = true;
      const id = m.message.id;
      let it = id && byMsg.get(id);
      if (!it) { it = { kind: 'assistant', blocks: [], key: id || `a${items.length}` }; items.push(it); if (id) byMsg.set(id, it); }
      for (const b of m.message.content || []) {
        if (b.type === 'tool_use' && it.blocks.some((x) => x.id === b.id)) continue;
        it.blocks.push(b);
      }
    } else if (m.type === 'compacted') items.push({ kind: 'note', text: `Conversation compacted${m.preTokens ? ` (was ${tokens(m.preTokens)} tokens)` : ''}`, key: `c${items.length}` });
    else if (m.type === 'permission') items.push({ kind: 'permission', req: m, key: `p${m.id}` });
    else if (m.type === 'permission-answer') answers.set(m.id, m);
    else if (m.type === 'result') {
      turnOpen = false;
      if (quiet && !m.isError) { quiet = false; continue; }
      quiet = false;
      if (m.usage && !m.isError) items.push({ kind: 'usage', usage: m.usage, key: `t${items.length}` });
      if (!m.isError || !m.error) continue;
      // the CLI often repeats the error as an assistant message; show it once, as an error
      const last = items[items.length - 1];
      if (last?.kind === 'assistant' && last.blocks.length === 1 && last.blocks[0].text?.trim() === m.error.trim()) items.pop();
      items.push({ kind: 'error', text: m.error, auth: AUTH_RE.test(m.error), key: `r${items.length}` });
    }
    else if (m.type === 'ended') {
      // cards left unanswered when the session stopped can't be answered any more
      for (const it of items) if (it.kind === 'permission' && !answers.has(it.req.id)) answers.set(it.req.id, { behavior: 'expired' });
      items.push({ kind: m.error ? 'error' : 'note', text: m.error || 'Session ended.', key: `e${items.length}` });
    }
  }
  return { items, results, answers };
}

const AUTH_RE = /authenticat|oauth|log ?in|credential|api key/i;

// command echoes and local-command output from saved history aren't part of the conversation
const isSystemText = (blocks) => blocks.every((b) => b.type === 'text' && /^\s*(<(command-|local-command|system-reminder|task-notification)|This session is being continued from a previous conversation)/.test(b.text));

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
// exact-ish counts for the per-reply line (small replies would all read "0k")
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ------------------------------------------------------------------ tool steps

const base = (p) => String(p || '').split(/[\\/]/).pop();
const TOOL_META = {
  Read: ['eye', (i) => `Read ${base(i.file_path)}`],
  Write: ['pen', (i) => `Write ${base(i.file_path)}`],
  Edit: ['edit', (i) => `Edit ${base(i.file_path)}`],
  MultiEdit: ['edit', (i) => `Edit ${base(i.file_path)}`],
  NotebookEdit: ['edit', (i) => `Edit ${base(i.notebook_path)}`],
  Bash: ['terminal', (i) => i.description || i.command],
  PowerShell: ['terminal', (i) => i.description || i.command],
  Grep: ['search', (i) => `Search "${i.pattern}"`],
  Glob: ['search', (i) => `Find ${i.pattern}`],
  WebFetch: ['link', (i) => `Fetch ${i.url}`],
  WebSearch: ['search', (i) => `Search the web: ${i.query}`],
  Task: ['sparkle', (i) => i.description || 'Run an agent'],
  Agent: ['sparkle', (i) => i.description || 'Run an agent'],
  TodoWrite: ['checkCircle', () => 'Update to-dos'],
  Skill: ['wand', (i) => `Skill: ${i.skill}`],
  ApplyPatch: ['edit', (i) => `Edit ${(i.files || []).map((x) => base(x.split(' ').slice(1).join(' '))).join(', ')}`], // Codex
};
const toolIcon = (name) => TOOL_META[name]?.[0] || 'wand';
const toolTitle = (name, input) => { try { return TOOL_META[name]?.[1](input || {}) || name; } catch { return name; } };

function resultText(r) {
  if (!r) return '';
  if (typeof r.content === 'string') return r.content;
  return (r.content || []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n');
}

// (each picture's data URL is made once: they are megabytes each)
const imgUrls = new WeakMap();
const resultImages = (r) => (Array.isArray(r?.content) ? r.content : [])
  .filter((b) => b.type === 'image' && b.source?.type === 'base64')
  .map((b) => { let u = imgUrls.get(b); if (!u) { u = `data:${b.source.media_type};base64,${b.source.data}`; imgUrls.set(b, u); } return u; });

// A picture at full size over the whole window (click or Esc closes it). Drawn outside the chat: a chat row is
// contained (content-visibility, so rows out of view cost nothing), and a fixed overlay inside one only covered the row.
export function openLightbox(src) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const close = () => { removeEventListener('keydown', onKey, true); render(null, el); el.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  addEventListener('keydown', onKey, true);
  render(html`<div class="cc-lightbox" onClick=${close}><img src=${src} /></div>`, el);
}

// images Claude looked at (frames, stills, references), shown under the step; click for full size
function ResultImages({ urls }) {
  if (!urls.length) return null;
  return html`<div class="cc-tool-imgs">${urls.map((u) => html`<img src=${u} onClick=${() => openLightbox(u)} title="Click to enlarge" />`)}</div>`;
}

function Diff({ input }) {
  const edits = input.edits || [{ old_string: input.old_string, new_string: input.new_string }];
  return html`<div class="cc-diff">${edits.map((e) => html`<div class="cc-diff-hunk">
    ${String(e.old_string ?? '').split('\n').map((l) => html`<div class="cc-del">- ${l}</div>`)}
    ${String(e.new_string ?? '').split('\n').map((l) => html`<div class="cc-add">+ ${l}</div>`)}
  </div>`)}</div>`;
}

function ToolDetail({ name, input }) {
  if (name === 'Edit' || name === 'MultiEdit') return html`<${Diff} input=${input} />`;
  if (name === 'Bash' || name === 'PowerShell') return html`<pre class="cc-pre">${input.command}</pre>`;
  if (name === 'Write') return html`<pre class="cc-pre">${String(input.content || '').slice(0, 4000)}</pre>`;
  return html`<pre class="cc-pre">${JSON.stringify(input, null, 2).slice(0, 4000)}</pre>`;
}

function Todos({ input }) {
  return html`<ul class="cc-todos">${(input.todos || []).map((t) => html`<li class=${`is-${t.status}`}>
    <${Icon} name=${t.status === 'completed' ? 'checkCircle' : 'circle'} size=${13} /><span>${t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span></li>`)}</ul>`;
}

function ToolStep({ block, result, live, onStop }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const err = result?.is_error;
  const state = !result ? (live ? 'running' : 'stopped') : err ? 'error' : 'done';
  if (block.name === 'TodoWrite') return html`<div class="cc-tool cc-tool-todos"><${Todos} input=${block.input || {}} /></div>`;
  const out = resultText(result);
  const imgs = resultImages(result);
  const head = html`<button class="cc-tool-head" onClick=${() => setOpen(!open)}>
      <span class="cc-tool-icon">${state === 'running' ? html`<span class="cc-spin"></span>` : html`<${Icon} name=${toolIcon(block.name)} size=${13} />`}</span>
      <span class="cc-tool-title">${toolTitle(block.name, block.input)}</span>
      ${err ? html`<span class="cc-tool-badge">${/^Exit code 137\b[\s\S]*\[killed\]/.test(out) ? 'stopped' : 'failed'}</span>` : null}
      <${Icon} name=${open ? 'up' : 'down'} size=${12} class="cc-tool-caret" />
    </button>`;
  // a running command Claude Code can stop on its own (onStop is given once it has made a task of it)
  const stop = state === 'running' && onStop;
  return html`<div class=${`cc-tool is-${state} ${open ? 'is-open' : ''}`}>
    ${stop ? html`<div class="cc-tool-headrow">${head}<button class="cc-tool-stop" disabled=${stopping} title="Stop just this command. Claude is told it was stopped and carries on"
      onClick=${() => { setStopping(true); onStop(); }}><i></i>${stopping ? 'Stopping…' : 'Stop'}</button></div>` : head}
    ${open ? html`<div class="cc-tool-body">
      <${ToolDetail} name=${block.name} input=${block.input || {}} />
      ${out ? html`<div class="cc-tool-out-label">${err ? 'Error' : 'Result'}</div><pre class=${`cc-pre ${err ? 'is-error' : ''}`}>${out.length > 6000 ? `${out.slice(0, 6000)}\n…` : out}</pre>` : null}
    </div>` : null}
    <${ResultImages} urls=${imgs} />
  </div>`;
}

// elapsed time of the current turn, ticking every second
function Working({ since, label }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  const s = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
  const time = s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  return html`<div class="cc-working"><span class="cc-dots"><i></i><i></i><i></i></span>${label}<span class="cc-working-time">${time} · Esc to stop</span></div>`;
}

// A command Claude left running in the background: the reply may have ended, but Claude carries on when it
// finishes. Shows how long it has run, the last line it printed and, when that line has one, a percentage.
function BackgroundTask({ task, onStop }) {
  const [stopping, setStopping] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  const s = Math.max(0, Math.floor((Date.now() - task.since) / 1000));
  const time = s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  return html`<div class="cc-task" title="Claude goes on by itself when this finishes">
    <div class="cc-working"><span class="cc-spin"></span>Running in the background: ${task.desc || 'a command'}<span class="cc-working-time">${time}${task.pct != null ? ` · ${Math.round(task.pct * 100)}%` : ''}</span>
      ${onStop && task.id ? html`<button class="cc-tool-stop" disabled=${stopping} title="Stop this command. Claude is told it was stopped" onClick=${() => { setStopping(true); onStop(); }}><i></i>${stopping ? 'Stopping…' : 'Stop'}</button>` : null}</div>
    ${task.pct != null ? html`<div class="cc-task-bar"><i style=${{ width: `${task.pct * 100}%` }}></i></div>` : null}
    ${task.last ? html`<div class="cc-task-out">${task.last}</div>` : null}
  </div>`;
}

// the account's usage windows (from Claude Code's rate-limit reports)
const WINDOW_LABELS = { five_hour: 'Session', seven_day: 'Week', seven_day_opus: 'Week (Opus)', seven_day_sonnet: 'Week (Sonnet)' };
export function Limits({ limits }) {
  const w = limits?.unifiedWindows;
  if (!w) return null;
  const fmt = (sec) => {
    const d = new Date(sec * 1000);
    const mins = Math.max(1, Math.round((d - Date.now()) / 60000));
    return mins < 24 * 60 ? `resets in ${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}` : `resets ${d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  };
  // Ultra plans have no 5-hour session limit, only the week (a window without a reset time isn't a limit either)
  const ultra = /ultra/i.test(limits.plan || '');
  const shown = Object.entries(w).filter(([k, v]) => !(k === 'five_hour' && (ultra || !v.resetsAt)) && (!v.resetsAt || v.resetsAt * 1000 > Date.now()));
  const short = (sec) => { const mins = Math.max(1, Math.round((sec * 1000 - Date.now()) / 60000)); return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`; };
  // Claude Code reports "allowed_warning" once a window passes a threshold (75%, 90%…): close to the limit, still
  // working. Only "rejected" means the limit is reached and Claude stops until the reset.
  const hit = limits.status === 'rejected';
  const near = !hit && limits.status === 'allowed_warning';
  const which = { five_hour: '5-hour session', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' }[limits.rateLimitType] || 'usage';
  return html`<div class="cc-limits">${shown.map(([k, v]) => {
    const pct = Math.round((v.utilization || 0) * 100);
    return html`<div class=${`cc-limit ${pct >= 90 ? 'is-high' : pct >= 70 ? 'is-mid' : ''}`} title=${`${WINDOW_LABELS[k] || k}: ${pct}% used, ${fmt(v.resetsAt)}`}>
      <span>${WINDOW_LABELS[k] || k}</span><span class="cc-limit-bar"><i style=${{ width: `${Math.min(100, pct)}%` }}></i></span><span>${pct}%</span>
      ${k === 'five_hour' && v.resetsAt ? html`<span class="cc-limit-reset">resets in ${short(v.resetsAt)}</span>` : null}</div>`;
  })}${hit ? html`<div class="cc-limit is-high">${which[0].toUpperCase()}${which.slice(1)} limit reached · ${fmt(limits.resetsAt)}</div>`
    : near ? html`<div class="cc-limit is-mid" title=${`Close to the ${which} limit: Claude keeps working, this is an early warning. ${fmt(limits.resetsAt)}`}>Near limit</div>` : null}</div>`;
}

// How long the conversation is. Claude re-reads all of it on every step, so a long chat uses the
// account's limit faster. Compacting pays off when the cache is cold (the next message re-sends everything at full
// price anyway): offered from COLD_WARN. While the cache is warm, re-reading costs about a tenth and compacting would
// throw that away: offered only from WARM_WARN. The bar is scaled to CONTEXT_HIGH.
const COLD_WARN = 150000, WARM_WARN = 500000, CONTEXT_HIGH = 700000;
export function Context({ info, busy, running, onCompact, onNew }) {
  // the cache countdown moves on its own: redraw every 30 s
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const n = info?.context;
  if (!n) return null;
  const win = info.contextWindow ? ` of ${tokens(info.contextWindow)}` : '';
  const tip = `This chat is ${tokens(n)} tokens long${win}. Claude re-reads the whole chat on every step, so each step now uses about that much of your usage limit. Compact replaces the chat with a short summary; New chat starts fresh.`;
  // Cache: after each step the API keeps the chat cached for a while (1 hour for Claude Code), and re-reading a
  // cached chat costs about a tenth. Once that runs out, the next message sends the whole chat again at full price.
  const ttl = info.cacheTtl || 3600e3;
  const left = info.lastCallAt ? info.lastCallAt + ttl - Date.now() : null;
  const warm = busy || (left != null && left > 0);
  const mins = left > 0 ? Math.max(1, Math.round(left / 60000)) : 0;
  const cacheTip = warm
    ? `Cache warm: Claude re-reads this chat at about a tenth of the normal cost. It stays warm for ${Math.round(ttl / 60000)} min after each step${busy ? '' : ` (about ${mins} min left)`}.`
    : `Cache cold: it's been over ${Math.round(ttl / 60000)} min since the last step, so your next message sends the whole chat (about ${tokens(n)} tokens) again at full price. Compact or start a new chat if you're moving on to something else.`;
  const cold = !warm && info.lastCallAt && n >= COLD_WARN;
  const level = n >= CONTEXT_HIGH ? 'is-high' : n >= (warm ? WARM_WARN : COLD_WARN) ? 'is-mid' : '';
  const actions = html`
      <button class="link-btn" disabled=${busy || !running} title=${!running ? 'The chat has ended: start a new one' : busy ? 'Wait for Claude to finish, or press Esc' : 'Replace the chat with a short summary and keep going'} onClick=${onCompact}>Compact</button>
      <button class="link-btn" title="Start a fresh chat for the next task" onClick=${onNew}>New chat</button>`;
  return html`<div class="cc-limits cc-context">
    <div class=${`cc-limit ${level}`} title=${tip}>
      <span>Chat size</span><span class="cc-limit-bar"><i style=${{ width: `${Math.min(100, (n / CONTEXT_HIGH) * 100)}%` }}></i></span><span>${tokens(n)}</span></div>
    ${info.lastCallAt || busy ? html`<div class=${`cc-limit cc-cache ${warm ? 'is-warm' : 'is-cold'}`} title=${cacheTip}>
      <i class="cc-cache-dot"></i><span>${warm ? `Cache warm${busy ? '' : ` · ${mins < 60 ? `${mins}m` : '1h'} left`}` : 'Cache cold'}</span></div>` : null}
    ${cold ? html`<div class="cc-context-msg" title=${cacheTip}>Next message re-sends all ${tokens(n)} at full price.${actions}</div>`
      : level ? html`<div class="cc-context-msg" title=${tip}>${level === 'is-high' ? 'Very long chat: every step is expensive.' : 'Long chat: steps are getting expensive.'}${actions}</div>` : null}
  </div>`;
}

function Thinking({ text, live }) {
  const [open, setOpen] = useState(false);
  if (!text && !live) return null;
  return html`<div class=${`cc-think ${open ? 'is-open' : ''}`}>
    <button class="cc-think-head" onClick=${() => setOpen(!open)}>
      ${live ? html`<span class="cc-spin"></span>` : html`<${Icon} name="sparkle" size=${12} />`}<span>${live ? 'Thinking…' : 'Thought process'}</span>
      ${text ? html`<${Icon} name=${open ? 'up' : 'down'} size=${12} />` : null}
    </button>
    ${open && text ? html`<div class="cc-think-body">${text}</div>` : null}
  </div>`;
}

// each text is turned into HTML once (the panel redraws on every streamed word)
const mdCache = new Map();
function markdownOnce(text) {
  let h = mdCache.get(text);
  if (h == null) {
    h = markdown(text);
    if (mdCache.size > 400) mdCache.delete(mdCache.keys().next().value);
    mdCache.set(text, h);
  }
  return h;
}
const Markdown = ({ text }) => html`<div class="cc-md" dangerouslySetInnerHTML=${{ __html: markdownOnce(text) }}></div>`;
const sameBlocks = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------------------------------------------ permission cards

function QuestionCard({ req, onAnswer }) {
  const qs = req.input?.questions || [];
  const [picked, setPicked] = useState({});
  const [other, setOther] = useState({});
  const toggle = (q, label) => setPicked((p) => {
    const cur = p[q.question] || [];
    return { ...p, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  });
  const ready = qs.every((q) => (picked[q.question] || []).length || (other[q.question] || '').trim());
  const submit = () => {
    const answers = {};
    for (const q of qs) answers[q.question] = (other[q.question] || '').trim() || (picked[q.question] || []).join(', ');
    onAnswer({ behavior: 'allow', updatedInput: { ...req.input, answers } });
  };
  return html`<div class="cc-card cc-question">
    ${qs.map((q) => html`<div class="cc-q">
      <div class="cc-q-head">${q.header ? html`<span class="cc-chip">${q.header}</span>` : null}<b>${q.question}</b></div>
      <div class="cc-q-opts">${q.options.map((o) => html`<button class=${`cc-opt ${(picked[q.question] || []).includes(o.label) ? 'is-on' : ''}`} onClick=${() => toggle(q, o.label)}>
        <span class="cc-opt-label">${o.label}</span>${o.description ? html`<span class="cc-opt-desc">${o.description}</span>` : null}
      </button>`)}
      <input class="cc-other" placeholder="Other…" value=${other[q.question] || ''} onInput=${(e) => setOther({ ...other, [q.question]: e.target.value })} /></div>
    </div>`)}
    <div class="cc-card-actions">
      <button class="cc-btn" onClick=${() => onAnswer({ behavior: 'deny', message: 'The user skipped the question.' })}>Skip</button>
      <button class="cc-btn is-primary" disabled=${!ready} onClick=${submit}>Submit</button>
    </div>
  </div>`;
}

function PermissionCard({ req, answer, onAnswer }) {
  if (answer?.behavior === 'expired') return html`<div class="cc-perm-done"><${Icon} name="clock" size=${12} /> Not answered: ${toolTitle(req.tool, req.input)}</div>`;
  if (answer) {
    return html`<div class=${`cc-perm-done is-${answer.behavior}`}><${Icon} name=${answer.behavior === 'allow' ? 'check' : 'x'} size=${12} />
      ${req.tool === 'AskUserQuestion' ? (answer.behavior === 'allow' ? 'Answered' : 'Skipped') : `${answer.behavior === 'allow' ? (answer.always ? 'Always allowed' : 'Allowed') : 'Denied'}: ${toolTitle(req.tool, req.input)}`}</div>`;
  }
  if (req.tool === 'AskUserQuestion') return html`<${QuestionCard} req=${req} onAnswer=${onAnswer} />`;
  if (req.tool === 'ExitPlanMode') {
    return html`<div class="cc-card cc-plan">
      <div class="cc-card-title"><${Icon} name="layers" size=${14} /> Claude's plan</div>
      <${Markdown} text=${req.input?.plan || ''} />
      <div class="cc-card-actions">
        <button class="cc-btn" onClick=${() => onAnswer({ behavior: 'deny', message: 'The user wants to keep planning. Ask what to change.' })}>Keep planning</button>
        <button class="cc-btn is-primary" onClick=${() => onAnswer({ behavior: 'allow' })}>Approve plan</button>
      </div>
    </div>`;
  }
  const canAlways = req.suggestions?.length > 0;
  return html`<div class="cc-card cc-perm">
    <div class="cc-card-title"><${Icon} name=${toolIcon(req.tool)} size=${14} /> Allow Claude to ${verb(req.tool)}?</div>
    <div class="cc-perm-what">${toolTitle(req.tool, req.input)}</div>
    <div class="cc-perm-detail"><${ToolDetail} name=${req.tool} input=${req.input || {}} /></div>
    <div class="cc-card-actions">
      <button class="cc-btn is-danger" onClick=${() => onAnswer({ behavior: 'deny' })}>Deny</button>
      <div class="spacer"></div>
      ${canAlways ? html`<button class="cc-btn" title="Don't ask again for this kind of action in this chat" onClick=${() => onAnswer({ behavior: 'allow', always: true })}>Always allow</button>` : null}
      <button class="cc-btn is-primary" onClick=${() => onAnswer({ behavior: 'allow' })}>Allow</button>
    </div>
  </div>`;
}

const verb = (tool) => ({ Write: 'create this file', Edit: 'edit this file', MultiEdit: 'edit this file', NotebookEdit: 'edit this notebook',
  Bash: 'run this command', PowerShell: 'run this command', WebFetch: 'fetch this page', WebSearch: 'search the web' }[tool] || `use ${tool}`);

// ------------------------------------------------------------------ messages

// Finished messages draw once. The panel redraws on every streamed word, and drawing every earlier message again
// each time (Markdown, tool outputs, pasted screenshots as data URLs) kept a long chat's editor busy and its memory
// swinging by a gigabyte (Step 80).
class UserBubble extends Component {
  shouldComponentUpdate(n) { return !sameBlocks(this.props.blocks, n.blocks); }
  render({ blocks }) { return userBubble(blocks); }
}
function userBubble(blocks) {
  return html`<div class="cc-row is-user"><div class="cc-bubble">
    ${blocks.filter((b) => b.type === 'image').map((b) => (b.source?.type === 'base64' && b.source.data
      ? html`<img class="cc-img" src=${`data:${b.source.media_type};base64,${b.source.data}`} />`
      : html`<span class="cc-img-chip"><${Icon} name="image" size=${13} /> Image</span>`))}
    ${blocks.filter((b) => b.type === 'text').map((b) => html`<div class="cc-user-text">${b.text}</div>`)}
  </div></div>`;
}

class AssistantTurn extends Component {
  shouldComponentUpdate(n) {
    const p = this.props;
    if (n.live || p.live) return true; // the reply being written
    if (!sameBlocks(p.item.blocks, n.item.blocks)) return true;
    return n.item.blocks.some((b) => b.type === 'tool_use' && p.results.get(b.id) !== n.results.get(b.id));
  }
  render(props) { return assistantTurn(props); }
}
function assistantTurn({ item, results, live, shells, onStop }) {
  return html`<div class="cc-row is-assistant">
    ${item.blocks.map((b) => {
      if (b.type === 'text') return b.text?.trim() ? html`<${Markdown} text=${b.text} />` : null;
      if (b.type === 'thinking') return b.thinking ? html`<${Thinking} text=${b.thinking} />` : null;
      if (b.type === 'tool_use') return html`<${ToolStep} block=${b} result=${results.get(b.id)} live=${live} onStop=${live && shells?.includes(b.id) ? () => onStop(b.id) : null} />`;
      return null;
    })}
  </div>`;
}

// ------------------------------------------------------------------ composer helpers

function timelineContext(tab) {
  const seq = tab.seq;
  if (!seq) return '';
  const t = tab.time.get().t;
  const media = tab.mediaById || {};
  const lines = [`[Timeline] Sequence "${seq.name}" (${seq.width}×${seq.height} @ ${seq.fps}fps), playhead at ${timecode(t, seq.fps)} (${t.toFixed(2)}s).`];
  const sel = seq.clips.filter((c) => tab.selection.includes(c.id));
  if (sel.length) {
    lines.push(`Selected clip${sel.length > 1 ? 's' : ''}:`);
    for (const c of sel.slice(0, 20)) {
      const tr = seq.tracks.find((x) => x.id === c.track);
      const what = c.media ? `"${media[c.media]?.name || c.media}"` : c.type === 'text' ? `text "${String(c.text || '').slice(0, 40)}"` : c.type;
      lines.push(`- ${c.id}: ${c.type} ${what} on ${tr ? trackLabel(seq, tr) : c.track}, ${c.start.toFixed(2)}s–${clipEnd(c).toFixed(2)}s`);
    }
    if (sel.length > 20) lines.push(`- …and ${sel.length - 20} more`);
  }
  return lines.join('\n');
}

const readFile = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, data: String(r.result).split(',')[1] || '', url: f.type.startsWith('image/') ? r.result : null });
  r.onerror = rej;
  r.readAsDataURL(f);
});

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function useVoice(onText) {
  const [on, setOn] = useState(false);
  const rec = useRef(null);
  const stop = () => { try { rec.current?.stop(); } catch { /* not started */ } };
  // stop without the last words: after sending, a late result must not put the text back in the box
  const cancel = () => { const r = rec.current; if (!r) return; r.onresult = null; try { r.abort(); } catch { /* not started */ } };
  const start = (baseText) => {
    if (!SpeechRec) { notify('Voice typing needs Microsoft Edge or Google Chrome.', 'error'); return; }
    const r = new SpeechRec();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    let finalText = '';
    const sep = baseText && !/\s$/.test(baseText) ? ' ' : '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      onText(baseText + sep + (finalText + interim).replace(/^\s+/, ''));
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') notify('Microphone access was blocked. Allow it in the browser’s site settings.', 'error');
      else if (e.error === 'network') notify('Voice typing needs an internet connection.', 'error');
    };
    r.onend = () => { setOn(false); rec.current = null; };
    rec.current = r;
    r.start();
    setOn(true);
  };
  useEffect(() => stop, []);
  return { on, start, stop, cancel, supported: !!SpeechRec };
}

// ------------------------------------------------------------------ chat view

// Above the message box: where what you type goes. The sequence's own chat (sent in the background, the panel
// stays on the chat you're reading), this chat, or this chat because the sequence has none yet.
function ChatTarget({ tab, target }) {
  const { seq, sid, away, shownSid, shownSeq, codex } = target;
  if (codex || !seq) return null;
  const pid = tab.projectId;
  const show = () => startChat(pid, 'resume', sid).catch((err) => notify(err.message, 'error'));
  const newFor = () => startChat(pid, 'new', null, { linkSequence: seq.id }).catch((err) => notify(err.message, 'error'));
  if (away) {
    const state = target.waiting ? ' · needs your answer' : target.busy ? ' · working…' : '';
    return html`<div class="cc-target is-away" title="Messages go to the chat linked to the sequence you're on. It works in the background; this panel stays on the chat you're reading.">
      <${Icon} name="send" size=${12} /><span>To the <b>${seq.name}</b> chat${state}</span>
      <div class="spacer"></div><button class="link-btn" onClick=${show}>Show it</button></div>`;
  }
  if (sid) return html`<div class="cc-target"><${Icon} name="link" size=${12} /><span>This chat works on <b>${seq.name}</b></span></div>`;
  return html`<div class="cc-target is-none">
    <span><b>${seq.name}</b> has no chat${shownSeq ? html`: this goes to the <b>${shownSeq.name}</b> chat` : ''}</span>
    <div class="spacer"></div>
    ${shownSid && !shownSeq ? html`<button class="link-btn" title=${`Messages and review comments for "${seq.name}" will come to this chat`} onClick=${() => linkChat(tab, seq.id, shownSid)}>Link to this chat</button>` : null}
    <button class="link-btn" title=${`Start a chat that works on "${seq.name}" (shown here)`} onClick=${newFor}>New chat for it</button>
  </div>`;
}

const SUGGESTIONS = [
  'Give me a quick summary of this project and its sequences',
  'Remove the silences from the selected clip',
  'Add captions to the main sequence',
  'Make a 30-second cut for Instagram Reels',
];

export function ClaudeChat({ tab, chatsCount, onNew, onContinue, onHistory }) {
  const pid = tab.projectId;
  const s = chatSession(pid);
  const st = useStore(s.store, (x) => x);
  const { info, log, stream } = st;
  const running = !!info?.running;
  // a turn (or a compaction) is running: new prompts wait until it ends or the editor presses Stop
  const busy = !!info?.busy || !!info?.compacting;
  const { items, results, answers } = useMemo(() => buildItems(log), [log]);
  const scroller = useRef(null);
  const stick = useRef(true);
  const [text, setText] = useState(() => loadPref(`chat.draft.${pid}`, ''));
  const [files, setFiles] = useState([]);
  const [drag, setDrag] = useState(false);
  const [menu, setMenuRaw] = useState(null);
  const [fam, setFam] = useState(null); // model family opened in the model menu
  const setMenu = (v) => { setMenuRaw(v); setFam(null); };
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const codex = info?.agent === 'codex';
  const who = codex ? 'Codex' : 'Claude';
  const savedPrefs = loadPref('chat.prefs', {});
  // Codex keeps its own model choice
  const prefs = codex ? { ...savedPrefs, model: savedPrefs.codexModel || '' } : savedPrefs;
  const mode = info?.permissionMode || prefs.permissionMode || 'default';
  const voice = useVoice((t) => setText(t));
  const pendingPerm = items.some((it) => it.kind === 'permission' && !answers.has(it.req.id));
  // the chat linked to the sequence you're on gets what you type; this panel stays on the chat you're reading
  const target = useChatTarget(tab);

  useEffect(() => { savePref(`chat.draft.${pid}`, text); }, [text, pid]);
  // keep pinned to the bottom unless the user scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
  }, [text]);

  const onScroll = () => {
    const el = scroller.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const addFiles = async (list) => {
    const arr = [...list].slice(0, 10);
    const big = arr.find((f) => f.size > 20 * 1024 * 1024);
    if (big) { notify(`${big.name} is larger than 20 MB`, 'error'); return; }
    const read = await Promise.all(arr.map(readFile));
    setFiles((f) => [...f, ...read]);
  };

  const submit = async () => {
    const body = text.trim();
    if (!body && !files.length) return;
    if (body === '/clear' || body === '/new') { if (voice.on) voice.cancel(); setText(''); onNew(); return; }
    if (target.away) {
      // to the sequence's own chat, in the background
      const name = target.seq?.name || 'sequence';
      if (target.busy) { notify(`The "${name}" chat is still working: send this when it finishes`); return; }
      if (voice.on) voice.cancel();
      const sent = files.map(({ name: n, type, data }) => ({ name: n, type, data }));
      setText('');
      setFiles([]);
      try {
        await sendChatPrompt(pid, body, { sessionId: target.sid, files: sent });
        notify(`Sent to the "${name}" chat`, 'claude');
      } catch (err) { notify(err.message, 'error'); setText(body); }
      return;
    }
    if (busy) { notify(`${who} is still working: send this when it finishes, or press Stop`); return; }
    if (voice.on) voice.cancel();
    const payload = { t: 'send', text: body, files: files.map(({ name, type, data }) => ({ name, type, data })) };
    setText('');
    setFiles([]);
    stick.current = true;
    try {
      if (!running) await startChat(pid, 'new');
      // the socket may still be reconnecting right after a start; fall back to HTTP
      if (!wsSend(s, payload)) await post(`/api/p/${pid}/chat/send`, payload);
    } catch (err) { notify(err.message, 'error'); setText(body); }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape' && busy) { e.preventDefault(); wsSend(s, { t: 'interrupt' }); }
  };

  const setMode = (v) => {
    savePref('chat.prefs', { ...loadPref('chat.prefs', {}), permissionMode: v });
    if (running) wsSend(s, { t: 'mode', mode: v });
    else s.store.set({ info: { ...info, permissionMode: v } });
    setMenu(null);
  };
  const setModel = (v) => {
    savePref('chat.prefs', { ...loadPref('chat.prefs', {}), [codex ? 'codexModel' : 'model']: v });
    if (running) wsSend(s, { t: 'model', model: v });
    else s.store.set({ info: { ...info } });
  };
  const setEffort = (v) => {
    savePref('chat.prefs', { ...loadPref('chat.prefs', {}), effort: v });
    if (running) wsSend(s, { t: 'effort', effort: v });
    else s.store.set({ info: { ...info } });
  };

  const insertContext = () => {
    const ctx = timelineContext(tab);
    if (!ctx) { notify('Open a sequence first', 'info'); return; }
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${ctx}\n` : `${ctx}\n\n`));
    taRef.current?.focus();
  };

  const onPaste = (e) => {
    const imgs = [...(e.clipboardData?.files || [])];
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  };

  const onListClick = (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    navigator.clipboard?.writeText(btn.closest('.md-code').querySelector('code').textContent);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  };

  const modeInfo = PERMISSION_MODES.find((m) => m.value === mode) || PERMISSION_MODES[0];
  const models = modelOptions(info.models, prefs.model || '');
  // while a chat runs, show the model it actually uses (the CLI reports e.g. claude-haiku-5-5)
  const live = running && info.model;
  const pref = models.find((m) => m.value === (prefs.model || ''));
  const modelInfo = pref && (!live || live === pref.value || live === pref.resolvedModel) ? pref
    : models.find((m) => m.value === live) || models.find((m) => m.value && m.resolvedModel === live)
    || (live ? { value: live, displayName: prettyModel(live), efforts: [] } : models[0]);
  const exactId = (running && info.model) || modelInfo.resolvedModel || '';
  const effortList = modelInfo.efforts?.length ? modelInfo.efforts : ALL_EFFORTS;
  const effort = (running ? info.effort : prefs.effort) || '';
  const effortLabel = EFFORTS.find((e) => e.value === effort)?.label;
  const modelRow = (m) => html`<button class=${m === modelInfo ? 'is-on' : ''} onClick=${() => setModel(m.value)} title=${m.resolvedModel || m.value}>
    <span class="cc-model-text"><span>${m.displayName}</span>${m.description ? html`<small>${m.description}</small>` : null}</span>${m === modelInfo ? html`<${Icon} name="check" size=${13} />` : null}</button>`;
  const lastAssistant = [...items].reverse().find((it) => it.kind === 'assistant');
  const showWorking = busy && !pendingPerm;
  // a command Claude is waiting on right now (its step has no result yet): named in the working line
  const waitingOn = busy && lastAssistant?.blocks?.findLast((b) => b.type === 'tool_use' && !results.has(b.id));
  const runningTool = waitingOn ? String(toolTitle(waitingOn.name, waitingOn.input)).split('\n')[0].slice(0, 90) : null;
  const empty = !items.length && !stream;

  return html`<div class=${`cc ${drag ? 'is-drag' : ''}`}
    onDragOver=${(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
    onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
    onDrop=${(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); e.stopPropagation(); setDrag(false); addFiles(e.dataTransfer.files); } }}>
    <div class="cc-scroll" ref=${scroller} onScroll=${onScroll} onClick=${onListClick}>
      ${empty ? html`<div class="cc-empty">
        <div class="cc-empty-mark"><${Icon} name="sparkle" size=${26} /></div>
        <h3>What should we edit?</h3>
        <p>${who} can cut, arrange, caption and render this project. You see every change on the timeline live.</p>
        ${chatsCount > 0 && !running ? html`<button class="cc-continue" onClick=${onContinue}><${Icon} name="refresh" size=${14} /> Continue last chat</button>` : null}
        ${chatsCount > 1 && !codex ? html`<button class="link-btn" onClick=${onHistory}>All chats for this project (${chatsCount})</button>` : null}
        <div class="cc-suggest">${SUGGESTIONS.map((q) => html`<button onClick=${() => { setText(q); taRef.current?.focus(); }}>${q}</button>`)}</div>
      </div>` : html`<div class="cc-list">
        ${items.map((it) => {
          if (it.kind === 'user') return html`<${UserBubble} key=${it.key} blocks=${it.blocks} />`;
          if (it.kind === 'assistant') return html`<${AssistantTurn} key=${it.key} item=${it} results=${results} live=${busy && it === lastAssistant} shells=${info?.shells} onStop=${(toolUseId) => wsSend(s, { t: 'stopTask', toolUseId })} />`;
          if (it.kind === 'permission') return html`<div class="cc-row is-assistant" key=${it.key}><${PermissionCard} req=${it.req} answer=${answers.get(it.req.id)} onAnswer=${(r) => wsSend(s, { t: 'perm', id: it.req.id, r })} /></div>`;
          if (it.kind === 'error') return html`<div class="cc-row" key=${it.key}><div class="cc-error"><${Icon} name="alert" size=${14} /><div>
            <div>${it.text}</div>
            ${it.auth && codex ? html`<div class="cc-error-hint">Open the Terminal view and click "Sign in to Codex", then start a new chat here.</div>`
              : it.auth ? html`<div class="cc-error-hint">This Claude account needs to sign in again.
              <button class="link-btn" onClick=${async () => { const r = await get(`/api/p/${tab.projectId}/terminal`).catch(() => null); openAccounts({ signIn: r?.configDir || null }); }}>Sign in…</button>
              Then start a new chat here (or pick a different account in the panel header).</div>` : null}
          </div></div></div>`;
          if (it.kind === 'usage') {
            const u = it.usage;
            const tip = `Tokens this reply used, over all its steps.
Input: ${u.input.toLocaleString()} (${u.cached.toLocaleString()} re-read from the cache, ${(u.input - u.cached).toLocaleString()} new)
Output: ${u.output.toLocaleString()} (Claude's writing and thinking)`;
            return html`<div class="cc-row is-assistant" key=${it.key}><div class="cc-usage" title=${tip}>Input ${count(u.input)}${u.cached ? ` (${count(u.cached)} cached)` : ''} · Output ${count(u.output)}</div></div>`;
          }
          return html`<div class="cc-row" key=${it.key}><div class="cc-note">${it.text}</div></div>`;
        })}
        ${stream ? html`<div class="cc-row is-assistant">
          ${stream.thinking && !stream.text ? html`<${Thinking} text=${stream.thinking} live=${true} />` : null}
          ${stream.text ? html`<${Markdown} text=${stream.text} />` : null}
        </div>` : null}
        ${showWorking ? html`<div class="cc-row is-assistant"><${Working} since=${info.turnStart} label=${info.compacting ? 'Compacting the conversation…' : stream && !stream.text ? 'Thinking…' : stream ? 'Writing…' : runningTool ? `Running: ${runningTool}…` : 'Working…'} /></div>` : null}
        ${(info?.tasks || []).map((t) => html`<div class="cc-row is-assistant"><${BackgroundTask} task=${t} onStop=${codex ? null : () => wsSend(s, { t: 'stopTask', taskId: t.id })} /></div>`)}
      </div>`}
    </div>

    <div class="cc-composer-wrap">
      <${ChatTarget} tab=${tab} target=${target} />
      <div class=${`cc-composer ${voice.on ? 'is-listening' : ''} ${target.away ? 'is-away' : ''}`}>
        ${files.length ? html`<div class="cc-files">${files.map((f, i) => html`<div class="cc-file" title=${f.name}>
          ${f.url ? html`<img src=${f.url} />` : html`<${Icon} name="link" size=${13} />`}<span>${f.name}</span>
          <button title="Remove" onClick=${() => setFiles(files.filter((_, j) => j !== i))}><${Icon} name="x" size=${11} /></button></div>`)}</div>` : null}
        <textarea ref=${taRef} class="cc-input" rows="1" value=${text} placeholder=${voice.on ? 'Listening… speak now'
          : target.away ? (target.busy ? `The "${target.seq?.name}" chat is working: send when it finishes` : `Message the "${target.seq?.name}" chat…`)
          : busy ? `${who} is working: you can type, and send when it finishes (Esc to stop)` : running ? `Reply to ${who}…` : `Ask ${who} to edit…`}
          onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
        <div class="cc-bar">
          <button class="cc-icon" title="Attach images or files" onClick=${() => fileRef.current?.click()}><${Icon} name="plus" size=${16} /></button>
          <input type="file" multiple hidden ref=${fileRef} onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <button class="cc-icon" title="Insert timeline context (sequence, playhead, selected clips)" onClick=${insertContext}><${Icon} name="film" size=${15} /></button>
          <div class="cc-pop-wrap">
            <button class=${`cc-pill is-${mode}`} title="Permission mode" onClick=${() => setMenu(menu === 'mode' ? null : 'mode')}><${Icon} name=${modeInfo.icon} size=${12} />${modeInfo.short}<${Icon} name="down" size=${11} /></button>
            ${menu === 'mode' ? html`<div class="cc-pop" onMouseLeave=${() => setMenu(null)}>${PERMISSION_MODES.map((m) => html`<button class=${m.value === mode ? 'is-on' : ''} onClick=${() => setMode(m.value)}>
              <${Icon} name=${m.icon} size=${13} /><span>${m.label}</span>${m.value === mode ? html`<${Icon} name="check" size=${13} />` : null}</button>`)}</div>` : null}
          </div>
          <div class="spacer"></div>
          <div class="cc-pop-wrap">
            <button class="cc-pill is-model" title=${`Model${exactId ? `: ${exactId}` : ''}${effort ? ` · effort ${effortLabel}` : ''}`} onClick=${() => setMenu(menu === 'model' ? null : 'model')}>
              ${modelInfo.value === '' && exactId ? prettyModel(exactId) : modelInfo.displayName}${effort ? html`<span class="cc-pill-sub">${effortLabel}</span>` : null}<${Icon} name="down" size=${11} /></button>
            ${menu === 'model' ? html`<div class="cc-pop is-right cc-model-pop" onMouseLeave=${() => setMenu(null)}>
              <div class="cc-pop-title">Model</div>
              ${models.filter((m) => !m.family).map(modelRow)}
              ${[...new Set(models.filter((m) => m.family).map((m) => m.family))].map((f) => {
                // one line per family (Opus, Fable…); click it to see its versions
                const list = models.filter((m) => m.family === f);
                const open = fam === f;
                return html`<button class=${`cc-fam ${list.includes(modelInfo) ? 'is-on' : ''}`} onClick=${() => setFam(open ? null : f)}>
                  <span class="cc-model-text"><span>${f[0].toUpperCase()}${f.slice(1)}</span><small>${list.map((m) => m.displayName).join(' · ')}</small></span>
                  <${Icon} name=${open ? 'down' : 'chevronRight'} size=${12} /></button>
                  ${open ? html`<div class="cc-fam-list">${list.map(modelRow)}</div>` : null}`;
              })}
              <div class="cc-pop-title">Effort <span class="muted">· how hard ${who} thinks</span></div>
              <div class="cc-effort">${EFFORTS.filter((e) => !e.value || effortList.includes(e.value)).map((e) => html`<button class=${e.value === effort ? 'is-on' : ''} onClick=${() => setEffort(e.value)}>${e.label}</button>`)}</div>
              ${exactId ? html`<div class="cc-pop-foot"><code>${exactId}</code></div>` : null}
            </div>` : null}
          </div>
          <button class=${`cc-icon cc-mic ${voice.on ? 'is-on' : ''}`} disabled=${!voice.supported} title=${voice.supported ? (voice.on ? 'Stop voice typing' : 'Voice typing') : 'Voice typing needs Edge or Chrome'}
            onClick=${() => (voice.on ? voice.stop() : voice.start(text))}><${Icon} name="mic" size=${16} /></button>
          ${busy && !target.away
            ? html`<button class="cc-send is-stop" title="Stop (Esc)" onClick=${() => wsSend(s, { t: 'interrupt' })}><span class="cc-stop-sq"></span></button>`
            : html`<button class="cc-send" title=${target.away ? `Send to the "${target.seq?.name}" chat (Enter)` : 'Send (Enter)'} disabled=${(!text.trim() && !files.length) || (target.away && target.busy)} onClick=${submit}><${Icon} name="arrowUp" size=${16} /></button>`}
        </div>
      </div>
      <${Context} info=${info} busy=${busy} running=${running} onNew=${onNew} onCompact=${() => { stick.current = true; wsSend(s, { t: 'send', text: '/compact' }); }} />
      <${Limits} limits=${info.limits} />
      <div class="cc-hint">${st.connected ? html`Enter to send · Shift+Enter for a new line${busy ? ' · Esc to stop' : ''}` : 'Reconnecting…'}</div>
    </div>
    ${drag ? html`<div class="cc-drop"><${Icon} name="upload" size=${22} />Drop images or files to attach</div>` : null}
  </div>`;
}
