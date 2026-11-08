// Claude chat sessions: `claude` processes in stream-json mode, rendered by the chat panel (bubbles, tool steps,
// permission cards) instead of a terminal. One chat per project is shown; others keep running in the background
// (chats linked to a sequence always do, and get that sequence's messages without being shown).
// Messages are kept in a log so a reloading client gets the whole conversation back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { APP_DIR, DATA_DIR, readJsonSafe, scriptEnv } from './util.js';
import { agentPath } from './agents.js';
import { applyConfigDir, SESSION_VARS, accountStatus, DEFAULT_DIR } from './accounts.js';
import { getConfig } from './config.js';
import { sessionSettingsFile } from './claudehooks.js';
import { ensureClaudeMd } from './claudemd.js';
import { historyDir, projectChats, bringChat, chatName } from './chathistory.js';
import { codexModels, codexSessions, loadCodexHistory, runCodexTurn, codexEventToLog } from './codex.js';

const isWin = process.platform === 'win32';
const MAX_LOG = 4000;
const MODES = new Set(['default', 'acceptEdits', 'auto', 'plan']);
const ASK_TOOLS = new Set(['AskUserQuestion']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODELS_FILE = path.join(DATA_DIR, 'claude-models.json');
const LIMITS_FILE = path.join(DATA_DIR, 'claude-limits.json');
const accountKey = (configDir) => path.resolve(configDir || path.join(os.homedir(), '.claude')).toLowerCase();
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const NOTE_RE = /^\s*<(jimmy-sequence|task-notification)/; // the sequence note sent with each message to a linked chat; Claude Code's own background notes
// A note about Claude Code's own housekeeping: Claude answers it, nobody needs to hear about that (ClaudeChat.js hides it).
const HOUSEKEEPING_RE = /^\s*<task-notification>[\s\S]*(Monitor expired|didn't finish before the previous session ended)/;
const textOf = (m) => { const c = m.message?.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : ''; };

// How much conversation one reply had to read: everything sent to the model for it (new + cached).
// This is what every further step of the chat costs again, so the panel shows it.
function contextOf(message) {
  const u = message?.usage;
  if (!u || message.model === '<synthetic>') return null;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || null;
}

// Tokens one reply used, for the line under it: input counts everything the model read (new, written to
// the cache, re-read from the cache), cached is the re-read share of that.
function usageOf(u) {
  if (!u) return null;
  const cached = u.cache_read_input_tokens || 0;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached;
  const output = u.output_tokens || 0;
  return input || output ? { input, cached, output } : null;
}
// How long the API keeps this chat cached after a call (Claude Code asks for 1 hour or 5 minutes); null if
// the call didn't say. Past that the next message sends the whole chat again at full price.
function cacheTtlOf(u) {
  const c = u?.cache_creation;
  return c?.ephemeral_1h_input_tokens > 0 ? 3600e3 : c?.ephemeral_5m_input_tokens > 0 ? 300e3 : null;
}
const addUsage = (a, b) => (b ? { input: (a?.input || 0) + b.input, cached: (a?.cached || 0) + b.cached, output: (a?.output || 0) + b.output } : a);

// a saved conversation, as the same user/assistant messages the live stream produces
function loadHistory(configDir, cwd, sessionId) {
  const out = [];
  let context = null, lastCallAt = null, cacheTtl = null;
  // a reply's usage, added up per API call (the file repeats a call's usage on each of its content blocks)
  let calls = new Map();
  const endTurn = () => {
    let total = null;
    for (const u of calls.values()) total = addUsage(total, usageOf(u));
    if (total) out.push({ type: 'result', usage: total, history: true });
    calls = new Map();
  };
  try {
    const lines = fs.readFileSync(path.join(historyDir(configDir, cwd), `${sessionId}.jsonl`), 'utf8').split('\n');
    for (const l of lines) {
      if (!l.trim()) continue;
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.type === 'system' && m.subtype === 'compact_boundary') {
        out.push({ type: 'compacted', preTokens: m.compactMetadata?.preTokens || null, history: true });
        context = m.compactMetadata?.postTokens || null;
        continue;
      }
      if ((m.type === 'user' || m.type === 'assistant') && m.message && !m.isMeta && !m.isSidechain && !m.isCompactSummary) {
        const c = m.message.content;
        if (m.type === 'user' && (typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b.type === 'tool_result')))) endTurn();
        out.push({ type: m.type, message: m.message, history: true });
        if (m.type === 'assistant') {
          context = contextOf(m.message) || context;
          if (m.message.id && m.message.model !== '<synthetic>' && m.message.usage) {
            calls.set(m.message.id, m.message.usage);
            lastCallAt = Date.parse(m.timestamp) || lastCallAt;
            cacheTtl = cacheTtlOf(m.message.usage) || cacheTtl;
          }
        }
      }
    }
    endTurn();
  } catch { /* no history */ }
  return { log: out.slice(-MAX_LOG), context, lastCallAt, cacheTtl };
}

export class ChatManager {
  constructor({ port, emit, accountOf, agentOf, linkOf, onSession }) {
    this.accountOf = accountOf || (() => null);
    this.agentOf = agentOf || (() => 'claude');
    // the sequence a chat is linked to ({ id, name } or null), and a hook for when a chat learns its session id
    this.linkOf = linkOf || (() => null);
    this.onSession = onSession || (() => {});
    this.port = port;
    this.emit = emit;
    this.sessions = new Map(); // projectId -> the chat shown in the panel
    // Chats switched away from while still working keep running here (projectId -> Set). They say when they finish
    // (or need an answer), and switching back to one shows it as it is. Idle ones end after a while; their file stays.
    this.background = new Map();
    this.clients = new Map(); // projectId -> Set<ws>
    // The CLI's model list (display names, effort levels) from the last session's initialize reply,
    // kept on disk so the picker shows real names before a chat is started.
    this.models = readJsonSafe(MODELS_FILE, null);
    // last usage-limit report per Claude account (config dir), from the CLI's rate_limit_event
    this.limits = readJsonSafe(LIMITS_FILE, {}) || {};
  }

  limitsFor(configDir) { return this.limits[accountKey(configDir)] || null; }

  info(projectId) {
    const s = this.sessions.get(projectId);
    const agent = s?.agent || this.agentOf(projectId);
    const models = agent === 'codex' ? this.codexModels() : null;
    if (!s) return { running: false, agent, models: models || this.models, limits: agent === 'codex' ? null : this.limitsFor(this.accountOf(projectId)) };
    if (agent === 'codex') return { running: s.running, agent, busy: s.busy, turnStart: s.busy ? s.turnStart : null, model: s.model, effort: s.effort, permissionMode: s.permissionMode, sessionId: s.sessionId, startedAt: s.startedAt, models };
    return { running: s.running, agent, busy: s.busy, turnStart: s.busy ? s.turnStart : null, tasks: this.tasksInfo(s), shells: [...(s.shells?.keys() || [])], limits: this.limitsFor(s.configDir), model: s.model, effort: s.effort, permissionMode: s.permissionMode, sessionId: s.sessionId, startedAt: s.startedAt, models: s.models || this.models,
      context: s.context, contextWindow: s.contextWindow, compacting: !!s.compacting, lastCallAt: s.lastCallAt, cacheTtl: s.cacheTtl };
  }

  // Codex's model list, re-read at most once a minute
  codexModels() {
    if (!this._cx || Date.now() - this._cx.at > 60e3) this._cx = { at: Date.now(), list: codexModels() };
    return this._cx.list;
  }

  start(projectId, cwd, { mode = 'new', sessionId, model = '', effort = '', permissionMode = 'default', configDir, kit, agent = 'claude' } = {}) {
    // the chat to open: a picked one, or the newest for 'continue' (from any account)
    const want = agent === 'codex' ? null : mode === 'resume' ? sessionId : mode === 'continue' ? projectChats(cwd)[0]?.id : null;
    const live = want ? [...(this.background.get(projectId) || [])].find((b) => b.sessionId === want) : null;
    const cur = this.sessions.get(projectId);
    if (cur && want && cur.sessionId === want && cur.running && (!configDir || cur.configDir === configDir)) return this.info(projectId);
    this.park(projectId);
    // a chat still live in the background comes back as it is (one busy on another account too; an idle one reopens)
    if (live && (!configDir || live.configDir === configDir || live.busy)) return this.show(live);
    if (live) this.stop(live);
    if (agent === 'codex') return this.startCodex(projectId, cwd, { mode, model, effort, permissionMode });
    // continue the newest chat, or a picked one, from whichever account it was made with
    const resumeId = want ? bringChat(configDir, cwd, want) : null;
    const s = this.spawn(projectId, cwd, { resumeId, model, effort, permissionMode, configDir, kit });
    this.sessions.set(projectId, s);
    this.broadcast(projectId, { t: 'reset', info: this.info(projectId), log: s.log });
    this.status(s);
    return this.info(projectId);
  }

  // Start a saved chat without showing it (a linked chat a message or review comment is meant for): it
  // works in the background while the panel keeps the chat being read. Null if there's no such chat.
  startBackground(projectId, cwd, { sessionId, model = '', effort = '', permissionMode = 'default', configDir, kit } = {}) {
    const resumeId = bringChat(configDir, cwd, sessionId);
    if (!resumeId) return null;
    const s = this.spawn(projectId, cwd, { resumeId, model, effort, permissionMode, configDir, kit });
    if (!this.background.has(projectId)) this.background.set(projectId, new Set());
    this.background.get(projectId).add(s);
    this.emitLive(projectId);
    return s;
  }

  spawn(projectId, cwd, { resumeId, model, effort, permissionMode, configDir, kit }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
    if (model) args.push('--model', model);
    if (EFFORTS.has(effort)) args.push('--effort', effort);
    // always explicit, so a defaultMode in the user's Claude settings doesn't override the panel's choice
    args.push('--permission-mode', MODES.has(permissionMode) ? permissionMode : 'default');
    if (resumeId) args.push('--resume', resumeId);
    // the editor's own CLI never needs a permission prompt
    args.push('--allowedTools', 'Bash(vedit:*)', 'Bash(vedit *)');
    if (kit) args.push('--plugin-dir', kit.pluginDir, '--append-system-prompt-file', kit.promptFile);
    args.push('--settings', sessionSettingsFile());

    const binDir = path.join(APP_DIR, 'bin');
    // lets vedit ask which chat it runs in (and so which sequence it works on)
    const key = randomUUID();
    const env = {
      ...process.env,
      CLAUDE_EDIT_URL: `http://127.0.0.1:${this.port}`,
      CLAUDE_EDIT_PROJECT: projectId,
      CLAUDE_EDIT_CHAT: key,
      ...scriptEnv(),
      // ~/.local/bin is where Claude Code's installer puts it; included in case PATH wasn't updated (or not yet seen)
      PATH: [binDir, agentPath()].join(path.delimiter),
    };
    delete env.Path;
    for (const k of SESSION_VARS) delete env[k];
    applyConfigDir(env, configDir);
    // The account's claude.ai connectors (Drive, Docs, image generators…) aren't used for editing, but their tools
    // and instructions would be sent with every step of the chat. MCP servers set up in Claude Code itself
    // (user or project settings) still load. "chatConnectors": true in data/config.json brings them back.
    if (!getConfig().chatConnectors) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';

    // claude may be an .exe or an npm .cmd shim on Windows; the shell finds either. Args are quoted for cmd.
    const q = (a) => (isWin ? (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a) : a);
    const proc = spawn(isWin ? `claude ${args.map(q).join(' ')}` : 'claude', isWin ? [] : args, { cwd, env, shell: isWin, windowsHide: true });

    const history = resumeId ? loadHistory(configDir, cwd, resumeId) : { log: [], context: null, lastCallAt: null, cacheTtl: null };
    const s = {
      key, projectId, cwd, proc, configDir, running: true, busy: false, model, effort: EFFORTS.has(effort) ? effort : '', permissionMode,
      sessionId: resumeId, startedAt: Date.now(), log: history.log,
      // tokens the last reply read (the size of the conversation), and the model's limit once the CLI reports it
      context: history.context, contextWindow: null, compacting: false,
      // when the model was last called for this chat, and how long the API keeps it cached after that
      lastCallAt: history.lastCallAt, cacheTtl: history.cacheTtl,
      pending: new Map(), buf: '', err: '',
    };

    proc.stdin.on('error', () => {}); // a write racing the CLI's exit
    proc.stdout.on('data', (d) => {
      if (s.dead) return; // stopped: drop what the old process still says
      s.buf += d;
      let i;
      while ((i = s.buf.indexOf('\n')) >= 0) {
        const line = s.buf.slice(0, i).trim();
        s.buf = s.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        this.onMessage(s, m);
      }
    });
    proc.stderr.on('data', (d) => { s.err = (s.err + d).slice(-4000); });
    proc.on('error', (e) => { s.err += `\n${e.message}`; });
    proc.on('close', (code) => {
      if (s.dead) return;
      s.running = false;
      s.busy = false;
      s.pending.clear();
      s.tasks?.clear();
      this.watchTasks(s);
      const msg = code && s.err.trim() ? s.err.trim().split('\n').slice(-6).join('\n') : null;
      this.push(s, { type: 'ended', code, error: code ? msg || `Claude exited (code ${code}). Is Claude Code installed and signed in? Run "claude" once in a terminal.` : null });
      this.status(s);
    });

    s.initId = randomUUID();
    this.write(s, { type: 'control_request', request_id: s.initId, request: { subtype: 'initialize' } });
    return s;
  }

  // Codex: no long-running process; each message runs one `codex exec` turn on the same thread.
  startCodex(projectId, cwd, { mode, model, effort, permissionMode }) {
    const last = mode === 'continue' ? codexSessions(cwd, 1)[0] : null;
    ensureClaudeMd(cwd, 'AGENTS.md').catch(() => {});
    const s = {
      agent: 'codex', projectId, cwd, proc: null, configDir: null, running: true, busy: false, model: model || '',
      effort: EFFORTS.has(effort) ? effort : '', permissionMode, sessionId: last?.id || null, startedAt: Date.now(),
      log: last ? loadCodexHistory(last.file).slice(-MAX_LOG) : [], context: null, pending: new Map(),
    };
    this.sessions.set(projectId, s);
    this.broadcast(projectId, { t: 'reset', info: this.info(projectId), log: s.log });
    this.status(s);
    return this.info(projectId);
  }

  codexTurn(s, text, files) {
    let body = String(text || '');
    if (body.trim() === '/compact' || s.busy) return false; // Codex compacts on its own; one turn at a time
    const images = [];
    const saved = [];
    for (const f of files || []) {
      const dir = path.join(s.cwd, '.attachments');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(f.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
      const file = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      (IMAGE_TYPES.has(f.type) ? images : saved).push(file);
    }
    if (saved.length) body += `${body ? '\n\n' : ''}Attached file${saved.length > 1 ? 's' : ''}: ${saved.map((p) => `\`${path.relative(s.cwd, p)}\``).join(', ')}`;
    if (!body && !images.length) return false;
    s.busy = true;
    s.turnStart = Date.now();
    this.push(s, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: body || '(image)' }] }, local: true });
    const env = { ...process.env, CLAUDE_EDIT_URL: `http://127.0.0.1:${this.port}`, CLAUDE_EDIT_PROJECT: s.projectId, ...scriptEnv(),
      PATH: [path.join(APP_DIR, 'bin'), process.env.PATH || process.env.Path || ''].join(path.delimiter) };
    delete env.Path;
    for (const k of SESSION_VARS) delete env[k];
    let ended = false, lastError = '';
    s.proc = runCodexTurn({
      cwd: s.cwd, env, threadId: s.sessionId, model: s.model, effort: s.effort, permissionMode: s.permissionMode, images, prompt: body || 'See the attached image.',
      onEvent: (e) => {
        if (s.dead) return;
        if (e.type === 'thread.started' && e.thread_id) { s.sessionId = e.thread_id; this.status(s); return; }
        if (e.type === 'turn.completed') {
          const u = e.usage || {};
          ended = true;
          this.push(s, { type: 'result', usage: { input: u.input_tokens || 0, cached: u.cached_input_tokens || 0, output: u.output_tokens || 0 } });
          return;
        }
        // "error" events are often warnings (unknown model metadata, retries); only a failed turn ends it
        if (e.type === 'error') {
          lastError = e.message || lastError;
          // not signed in: Codex would keep retrying for a while; stop now and say so
          if (/401 Unauthorized|Missing bearer/i.test(lastError) && s.proc) { ended = true; killTree(s.proc); this.push(s, { type: 'result', isError: true, error: 'Codex is not signed in (OpenAI login).' }); }
          return;
        }
        if (e.type === 'turn.failed') { ended = true; this.push(s, { type: 'result', isError: true, error: e.error?.message || lastError || 'Codex failed' }); return; }
        for (const m of codexEventToLog(e)) this.push(s, m);
      },
      onClose: (code, err) => {
        if (s.dead) return;
        s.proc = null;
        s.busy = false;
        if (!ended && !s.interrupted) {
          err = `${lastError}\n${err}`;
          const signIn = /not logged in|log ?in|sign in|401|unauthori[sz]ed/i.test(err);
          this.push(s, { type: 'result', isError: true, error: signIn ? 'Codex is not signed in (OpenAI login).'
            : err.trim().split('\n').slice(-6).join('\n') || `Codex exited (code ${code}). Is the Codex CLI installed? Run "codex" once in a terminal.` });
        }
        s.interrupted = false;
        this.status(s);
        if (ended) this.notice(s, 'done');
      },
    });
    this.status(s);
    return true;
  }

  // Claude started a turn by itself (a background command it was waiting for finished): the panel shows it working
  wake(s) {
    if (s.busy) return;
    s.busy = true;
    s.turnStart = Date.now();
    this.status(s);
  }

  // Commands Claude runs in the background (its Bash tool's run_in_background, or a long one it moved there): the
  // reply can end while they run and Claude goes on when they finish. The panel shows them as still running, with
  // the last line they printed (read from the output file Claude Code names). s.tasks: id -> { desc, since, file, last }
  trackTasks(s, m) {
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    s.tasks ||= new Map();
    s.taskCalls ||= new Map(); // tool_use id -> description, until its result says which task it became
    let changed = false;
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'Bash') s.taskCalls.set(b.id, b.input?.description || String(b.input?.command || '').slice(0, 80));
      if (b.type === 'tool_result' && s.taskCalls.has(b.tool_use_id)) {
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '';
        const bg = /running in background with ID: (\w+)(?:[\s\S]*?written to: (.+?\.output))?/.exec(text);
        if (bg) { s.tasks.set(bg[1], { desc: s.taskCalls.get(b.tool_use_id), since: Date.now(), file: bg[2] || null, last: '' }); changed = true; }
        s.taskCalls.delete(b.tool_use_id);
      }
      // stopped by Claude (KillShell / TaskStop)
      const stopped = b.type === 'tool_use' && /^(KillShell|KillBash|TaskStop)$/.test(b.name) && (b.input?.shell_id || b.input?.task_id || b.input?.bash_id);
      if (stopped && s.tasks.delete(stopped)) changed = true;
    }
    if (changed) this.watchTasks(s);
    return changed;
  }
  // the command finished. Claude Code says so with a task_notification event and keeps a list of what still runs
  // (background_tasks_changed); a task-notification in a message's text is the older way.
  endTasks(s, m, raw) {
    if (!s.tasks?.size) return false;
    let changed = false;
    const end = (id) => { if (s.tasks.delete(id)) changed = true; };
    if (m.type === 'system' && m.subtype === 'task_notification' && m.status !== 'running') end(m.task_id);
    if (m.type === 'system' && m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
      const live = new Set(m.tasks.map((t) => t.task_id));
      for (const id of [...s.tasks.keys()]) if (!live.has(id)) end(id);
    }
    if (raw.includes('<task-id>')) for (const t of raw.matchAll(/<task-id>(\w+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/g)) if (t[2] !== 'running') end(t[1]);
    if (changed) this.watchTasks(s);
    return changed;
  }
  // while tasks run, their output files are looked at every 2 s for the last line (and a percentage, when one shows)
  watchTasks(s) {
    clearInterval(s.taskTimer);
    s.taskTimer = null;
    if (!s.tasks?.size || !s.running) return;
    s.taskTimer = setInterval(async () => {
      let changed = false;
      for (const t of s.tasks.values()) {
        if (!t.file) continue;
        const last = await tailLine(t.file);
        if (last !== t.last) { t.last = last; changed = true; }
      }
      if (changed) this.status(s);
    }, 2000);
    s.taskTimer.unref?.();
  }
  tasksInfo(s) {
    return [...(s.tasks?.entries() || [])].map(([id, t]) => ({ id, desc: t.desc, since: t.since, last: t.last, pct: percentOf(t.last) }));
  }
  // Shell commands that can be stopped on their own (the small Stop on a running command in the panel). Claude Code
  // makes a task of a command a few seconds after it starts (task_started, with the tool_use id); stop_task ends
  // just that command: Claude gets "[killed]" as its result and carries on. s.shells: tool_use id -> task id
  trackShells(s, m) {
    s.shells ||= new Map();
    if (m.subtype === 'task_started' && m.tool_use_id && m.task_id && /bash|shell|powershell/i.test(m.task_type || '')) { s.shells.set(m.tool_use_id, m.task_id); return true; }
    const ended = (m.subtype === 'task_notification' && m.status !== 'running') || (m.subtype === 'task_updated' && m.patch?.status && m.patch.status !== 'running');
    if (!ended) return false;
    for (const [k, v] of s.shells) if (v === m.task_id) { s.shells.delete(k); return true; }
    return false;
  }
  // { toolUseId } (a command Claude waits for) or { taskId } (one running in the background)
  stopTask(projectId, { toolUseId, taskId } = {}) {
    const s = this.sessions.get(projectId);
    if (!s?.running || s.agent === 'codex') return false;
    const id = taskId && s.tasks?.has(taskId) ? taskId : s.shells?.get(toolUseId);
    if (!id) return false;
    this.write(s, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'stop_task', task_id: id } });
    return true;
  }

  onMessage(s, m) {
    if (m.type !== 'stream_event' && m.type !== 'result') {
      const raw = JSON.stringify(m);
      if (this.endTasks(s, m, raw) | (m.type === 'system' && this.trackShells(s, m))) this.status(s);
    }
    if (m.type === 'stream_event') {
      // live typing only; the finished assistant message follows and is what gets logged
      const e = m.event;
      if (e.type === 'content_block_delta' && (e.delta?.type === 'text_delta' || e.delta?.type === 'thinking_delta')) {
        if (this.shown(s)) this.broadcast(s.projectId, { t: 'delta', index: e.index, kind: e.delta.type, text: e.delta.text ?? e.delta.thinking ?? '' });
      } else if (e.type === 'message_start' && this.shown(s)) this.broadcast(s.projectId, { t: 'msgstart', id: e.message?.id });
      return;
    }
    if (m.type === 'control_response') {
      const r = m.response;
      if (r?.request_id === s.initId && r.subtype === 'success' && Array.isArray(r.response?.models)) {
        s.models = r.response.models.map((x) => ({ value: x.value, resolvedModel: x.resolvedModel, displayName: x.displayName, description: x.description, efforts: x.supportsEffort ? x.supportedEffortLevels || [] : [] }));
        this.models = s.models;
        fs.promises.writeFile(MODELS_FILE, JSON.stringify(s.models)).catch(() => {});
        this.status(s);
      }
      return;
    }
    if (m.type === 'control_request') {
      if (m.request?.subtype === 'can_use_tool') {
        const req = { type: 'permission', id: m.request_id, tool: m.request.tool_name, input: m.request.input,
          description: m.request.description, suggestions: m.request.permission_suggestions, toolUseId: m.request.tool_use_id };
        // Auto: never ask. Claude Code's own auto mode still sends some actions here (and isn't available on
        // every account), so approve them all; questions meant for the user still show.
        if (s.permissionMode === 'auto' && !ASK_TOOLS.has(req.tool)) {
          this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: req.input } } });
          return;
        }
        s.pending.set(m.request_id, req);
        this.push(s, req);
        if (!this.shown(s)) this.notice(s, 'ask');
      } else {
        this.write(s, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not supported' } });
      }
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      const prev = s.sessionId;
      s.sessionId = m.session_id;
      if (s.sessionId && s.sessionId !== prev) this.onSession(s, prev);
      if (m.model) s.model = m.model;
      if (m.permissionMode && s.permissionMode !== 'auto') s.permissionMode = m.permissionMode;
      this.status(s);
      return;
    }
    if (m.type === 'rate_limit_event' && m.rate_limit_info) {
      const key = accountKey(s.configDir);
      const rec = { ...m.rate_limit_info, at: Date.now(), plan: this.limits[key]?.plan || null };
      this.limits[key] = rec;
      fs.promises.writeFile(LIMITS_FILE, JSON.stringify(this.limits)).catch(() => {});
      // the plan decides which windows exist (Pro / Max: a 5-hour session and a week; Ultra: the week only)
      accountStatus(s.configDir || DEFAULT_DIR).then((st) => {
        if (!st?.plan || this.limits[key] !== rec || rec.plan === st.plan) return;
        rec.plan = st.plan;
        fs.promises.writeFile(LIMITS_FILE, JSON.stringify(this.limits)).catch(() => {});
        this.status(s);
      }).catch(() => {});
      this.status(s);
      return;
    }
    if (m.type === 'system' && m.subtype === 'status') {
      s.compacting = m.status === 'compacting';
      this.status(s);
      return;
    }
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      const meta = m.compact_metadata || m.compactMetadata || {};
      const pre = meta.pre_tokens || meta.preTokens || s.context || null;
      s.context = meta.post_tokens || meta.postTokens || null; // otherwise the next reply reports the new size
      s.compacting = false;
      s.lastCallAt = Date.now();
      this.push(s, { type: 'compacted', preTokens: pre });
      this.status(s);
      return;
    }
    if (m.type === 'result') {
      const quiet = s.quiet && !s.busy; // (a message from the user during it makes this an ordinary turn)
      s.busy = false;
      s.compacting = false;
      const win = Math.max(0, ...Object.values(m.modelUsage || {}).map((u) => u?.contextWindow || 0));
      if (win) s.contextWindow = win;
      this.push(s, { type: 'result', subtype: m.subtype, isError: m.is_error, durationMs: m.duration_ms, usage: usageOf(m.usage), error: m.is_error ? m.result : null });
      this.status(s);
      if (!quiet || m.is_error) this.notice(s, m.is_error ? 'error' : 'done');
      s.quiet = false;
      return;
    }
    if (m.type === 'user' || m.type === 'assistant') {
      if (m.isCompactSummary || m.isSynthetic) return; // the summary Claude keeps after compacting isn't a chat message
      if (m.type === 'user' && !m.parent_tool_use_id && !s.busy && HOUSEKEEPING_RE.test(textOf(m))) s.quiet = true;
      if (m.type === 'assistant' && m.message?.content?.some?.((b) => b.type === 'tool_use')) s.quiet = false;
      if (m.type === 'assistant' && !m.parent_tool_use_id && !s.quiet) this.wake(s);
      if (!m.parent_tool_use_id && this.trackTasks(s, m)) this.status(s);
      this.push(s, { type: m.type, message: m.message, parent: m.parent_tool_use_id || null });
      if (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.usage && m.message.model !== '<synthetic>') {
        s.lastCallAt = Date.now(); // the panel learns it with the next status (at the latest when the reply ends)
        s.cacheTtl = cacheTtlOf(m.message.usage) || s.cacheTtl;
      }
      const c = m.type === 'assistant' && !m.parent_tool_use_id ? contextOf(m.message) : null;
      if (c && c !== s.context) { s.context = c; this.status(s); }
    }
  }

  push(s, m) {
    s.log.push(m);
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    if (this.shown(s)) this.broadcast(s.projectId, { t: 'msg', m });
  }

  status(s) {
    if (!this.shown(s)) { this.emitLive(s.projectId); return; }
    this.broadcast(s.projectId, { t: 'status', info: this.info(s.projectId) });
    this.emit(s.projectId, { type: 'chat', projectId: s.projectId, info: this.info(s.projectId) });
  }

  shown(s) { return this.sessions.get(s.projectId) === s; }

  // chats working (a reply under way, or commands left running in the background): the scheduler gives Claude its
  // place right after the person at the keyboard (budget.js, scheduler.js)
  working() {
    let n = 0;
    for (const s of [...this.sessions.values(), ...[...this.background.values()].flatMap((x) => [...x])]) if (s?.running && (s.busy || s.compacting || s.tasks?.size)) n++;
    return n;
  }

  // A turn ended (or a question waits) in a chat: the editor shows a message with a way to open that chat.
  notice(s, kind) {
    const users = s.log.filter((m) => m.type === 'user');
    const said = (b) => b.type === 'text' && !NOTE_RE.test(b.text || '');
    const first = users.find((m) => typeof m.message?.content === 'string' || m.message?.content?.some?.(said))?.message.content;
    const text = typeof first === 'string' ? first : Array.isArray(first) ? first.find(said)?.text : '';
    this.emit(s.projectId, { type: 'chat-notice', projectId: s.projectId, kind, sessionId: s.sessionId, shown: this.shown(s),
      sequence: this.linkOf(s.projectId, s.sessionId)?.name || null,
      title: chatName(s.sessionId) || String(text || 'Chat').replace(/\s+/g, ' ').trim().slice(0, 60) });
    if (!this.shown(s) && kind !== 'ask') this.idleLater(s);
    this.emitLive(s.projectId);
  }

  // the project's running chats, for the history list: [{ sessionId, busy, waiting, shown }]
  live(projectId) {
    const cur = this.sessions.get(projectId);
    return [cur, ...(this.background.get(projectId) || [])].filter((x) => x?.running && x.sessionId)
      .map((x) => ({ sessionId: x.sessionId, busy: !!x.busy, tasks: x.tasks?.size || 0, compacting: !!x.compacting, waiting: x.pending.size > 0, shown: x === cur, context: x.context || null, turnStart: x.busy ? x.turnStart : null }));
  }
  emitLive(projectId) { this.emit(projectId, { type: 'chats-live', projectId, live: this.live(projectId) }); }

  // a running chat of this project (shown or in the background)
  find(projectId, sessionId) {
    if (!sessionId) return null;
    return [this.sessions.get(projectId), ...(this.background.get(projectId) || [])].find((x) => x?.running && x.sessionId === sessionId) || null;
  }
  // the chat a vedit command runs in (vedit gets the key from the chat's environment)
  byKey(key) {
    if (!key) return null;
    for (const s of this.sessions.values()) if (s.key === key) return s;
    for (const set of this.background.values()) for (const s of set) if (s.key === key) return s;
    return null;
  }
  linked(s) { return !!(s.sessionId && this.linkOf(s.projectId, s.sessionId)); }

  // Move the shown chat out of the panel: one that is working (or waiting for an answer), or linked to a
  // sequence, carries on in the background; an idle one just ends (its conversation is saved and can be
  // continued any time).
  park(projectId) {
    const s = this.sessions.get(projectId);
    if (!s) return;
    this.sessions.delete(projectId);
    if (s.running && (s.busy || s.pending.size || this.linked(s))) {
      if (!this.background.has(projectId)) this.background.set(projectId, new Set());
      this.background.get(projectId).add(s);
    } else this.stop(s);
  }

  // bring a background chat back into the panel
  show(s) {
    clearTimeout(s.idleTimer);
    this.background.get(s.projectId)?.delete(s);
    this.sessions.set(s.projectId, s);
    this.broadcast(s.projectId, { t: 'reset', info: this.info(s.projectId), log: s.log });
    this.status(s);
    this.emitLive(s.projectId);
    return this.info(s.projectId);
  }

  // a finished background chat stays ready for a while (switching back is instant), then ends; one linked to
  // a sequence stays while the project is open
  idleLater(s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => { if (!this.shown(s) && !s.busy && !s.pending.size && !s.tasks?.size && !this.linked(s)) this.stop(s); }, 15 * 60e3);
  }

  stop(s) {
    s.dead = true;
    s.running = false;
    clearTimeout(s.idleTimer);
    clearInterval(s.taskTimer);
    this.background.get(s.projectId)?.delete(s);
    if (s.proc) killTree(s.proc);
  }

  write(s, obj) {
    if (s.running && s.proc.stdin.writable) s.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  // text plus attachments ({ name, type, data: base64 }); images go to Claude inline, other files are
  // saved into the project's .attachments folder and referenced by path.
  send(projectId, text, files = []) {
    return this.sendTo(this.sessions.get(projectId), text, files);
  }

  // send to one chat, shown or not
  sendTo(s, text, files = []) {
    if (!s?.running) return false;
    // one turn at a time: the CLI would queue a prompt sent mid-turn and run it right after a Stop
    if (s.busy || s.compacting) return false;
    if (s.agent === 'codex') return this.codexTurn(s, text, files);
    const content = [];
    const saved = [];
    for (const f of files || []) {
      if (IMAGE_TYPES.has(f.type)) { content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } }); continue; }
      const dir = path.join(s.cwd, '.attachments');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(f.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
      const file = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      saved.push(path.relative(s.cwd, file));
    }
    let body = String(text || '');
    if (saved.length) body += `${body ? '\n\n' : ''}Attached file${saved.length > 1 ? 's' : ''}: ${saved.map((p) => `\`${p}\``).join(', ')}`;
    if (body) content.push({ type: 'text', text: body });
    if (!content.length) return false;
    // a chat linked to a sequence is reminded on every message which one it works on (the panel hides the note)
    const seq = this.linkOf(s.projectId, s.sessionId);
    if (seq && !/^\s*\//.test(body)) {
      content.unshift({ type: 'text', text: `<jimmy-sequence id="${seq.id}" name="${String(seq.name).replace(/"/g, "'")}">This chat works only on sequence "${seq.name}" (${seq.id}). Change only that sequence in project.json and leave every other sequence exactly as it is: other chats are editing them.</jimmy-sequence>` });
    }
    const message = { role: 'user', content };
    if (!s.busy) s.turnStart = Date.now();
    s.busy = true;
    this.write(s, { type: 'user', message });
    this.push(s, { type: 'user', message, local: true });
    this.status(s);
    return true;
  }

  // answer a permission card: { behavior: 'allow'|'deny', updatedInput?, always?, message? }
  respond(projectId, id, r) {
    const s = this.sessions.get(projectId);
    const req = s?.pending.get(id);
    if (!req) return;
    s.pending.delete(id);
    const response = r.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: r.updatedInput || req.input, ...(r.always && req.suggestions?.length ? { updatedPermissions: req.suggestions } : {}) }
      : { behavior: 'deny', message: r.message || 'The user denied this action.', ...(r.interrupt ? { interrupt: true } : {}) };
    this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    this.push(s, { type: 'permission-answer', id, behavior: r.behavior, always: !!r.always });
  }

  control(projectId, request) {
    const s = this.sessions.get(projectId);
    if (!s?.running) return;
    if (s.agent === 'codex') {
      // settings apply from the next message; stopping kills the running turn
      if (request.subtype === 'set_permission_mode') s.permissionMode = request.mode;
      if (request.subtype === 'set_model') s.model = request.model || '';
      if (request.subtype === 'apply_flag_settings' && 'effortLevel' in (request.settings || {})) s.effort = request.settings.effortLevel || '';
      if (request.subtype === 'interrupt' && s.proc) { s.interrupted = true; killTree(s.proc); this.push(s, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }); }
      this.status(s);
      return;
    }
    if (request.subtype === 'set_permission_mode') {
      s.permissionMode = request.mode;
      // switching to Auto answers whatever is already waiting
      if (request.mode === 'auto') for (const [id, req] of [...s.pending]) if (!ASK_TOOLS.has(req.tool)) this.respond(projectId, id, { behavior: 'allow' });
    }
    if (request.subtype === 'set_model') s.model = request.model;
    if (request.subtype === 'apply_flag_settings' && 'effortLevel' in (request.settings || {})) s.effort = request.settings.effortLevel || '';
    if (request.subtype === 'interrupt') {
      for (const id of [...s.pending.keys()]) this.respond(projectId, id, { behavior: 'deny', message: 'Interrupted by the user.' });
    }
    this.write(s, { type: 'control_request', request_id: randomUUID(), request });
    this.status(s);
  }

  attach(projectId, ws) {
    if (!this.clients.has(projectId)) this.clients.set(projectId, new Set());
    this.clients.get(projectId).add(ws);
    ws.on('close', () => this.clients.get(projectId)?.delete(ws));
    const s = this.sessions.get(projectId);
    send(ws, { t: 'reset', info: this.info(projectId), log: s ? s.log : [] });
  }

  broadcast(projectId, msg) {
    for (const ws of this.clients.get(projectId) || []) send(ws, msg);
  }

  // end the shown chat (background ones keep going)
  kill(projectId) {
    const s = this.sessions.get(projectId);
    if (!s) return;
    this.sessions.delete(projectId);
    this.stop(s);
    this.broadcast(projectId, { t: 'reset', info: this.info(projectId), log: [] });
    this.emitLive(projectId);
  }

  // the project is going away: its background chats too
  killProject(projectId) {
    this.kill(projectId);
    for (const s of [...(this.background.get(projectId) || [])]) this.stop(s);
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
    for (const set of this.background.values()) for (const s of [...set]) this.stop(s);
  }

  // an account is being removed: end every chat running on it (sameDir compares folders). Returns how many.
  killAccount(sameDir) {
    let n = 0;
    for (const [id, s] of [...this.sessions]) if (s.configDir && sameDir(s.configDir)) { this.kill(id); n++; }
    for (const set of this.background.values()) for (const s of [...set]) if (s.configDir && sameDir(s.configDir)) { this.stop(s); n++; }
    return n;
  }
}

// the last line a background command printed (from the end of its output file; progress bars redraw with \r)
async function tailLine(file) {
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const n = Math.min(size, 4096);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, size - n);
      const lines = buf.toString('utf8').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      return (lines.at(-1) || '').slice(0, 200);
    } finally { await fh.close(); }
  } catch { return ''; }
}
// a percentage in a progress line ("45%", "45.2 %"), 0..1
function percentOf(line) {
  const m = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(line || '');
  const v = m ? Number(m[1]) : NaN;
  return v >= 0 && v <= 100 ? v / 100 : null;
}

function killTree(proc) {
  try {
    if (isWin && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true });
    else proc.kill();
  } catch { /* already gone */ }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
