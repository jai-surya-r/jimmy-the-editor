// Embedded Claude Code terminals: one PTY per project, running in the project folder.
// Sessions outlive browser reloads; output is buffered so a reattaching client gets the scrollback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The terminal's native part (node-pty ships one package per processor). If it can't load, the editor still starts
// and only the terminal says why: a missing package once stopped the whole Intel Mac app at launch.
let pty = null;
let ptyError = null;
try { pty = (await import('@lydell/node-pty')).default; } catch (err) { ptyError = err; console.warn('[terminal] not available:', String(err.message).split('\n')[0]); }
import { APP_DIR, sleep, scriptEnv } from './util.js';
import { applyConfigDir, SESSION_VARS } from './accounts.js';
import { sessionSettingsFile } from './claudehooks.js';
import { lastSession } from './chathistory.js';
import { codexSessions } from './codex.js';
import { ensureClaudeMd } from './claudemd.js';

const MAX_BUFFER = 600_000;
const isWin = process.platform === 'win32';

export function listClaudeProfiles() {
  const home = os.homedir();
  const out = [];
  try {
    for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^\.claude([-_.].+)?$/.test(ent.name)) continue;
      const dir = path.join(home, ent.name);
      const looksLikeConfig = ['projects', 'settings.json', '.credentials.json', 'history.jsonl'].some((f) => fs.existsSync(path.join(dir, f)));
      if (looksLikeConfig) out.push({ name: ent.name === '.claude' ? 'Default (.claude)' : ent.name, dir });
    }
  } catch { /* ignore */ }
  return out;
}

export class TerminalManager {
  constructor({ port, emit }) {
    this.port = port;
    this.emit = emit; // (projectId, msg) for status broadcasts to app clients
    this.sessions = new Map();
    this.waiting = new Map();
  }

  info(projectId) {
    const s = this.sessions.get(projectId);
    if (!s) return { running: false, exists: false };
    return { exists: true, running: s.running, agent: s.agent, mode: s.mode, startedAt: s.startedAt, exitCode: s.exitCode, configDir: s.configDir };
  }

  start(projectId, cwd, { mode = 'new', cols = 100, rows = 30, configDir, kit = null, agent = 'claude' } = {}) {
    this.kill(projectId);
    const q = (s) => (isWin ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, "'\\''")}'`);
    let cmd;
    if (mode === 'shell') cmd = null;
    else if (agent === 'codex') {
      ensureClaudeMd(cwd, 'AGENTS.md').catch(() => {});
      // vedit talks to the editor over http://127.0.0.1, which Codex's sandbox blocks by default
      const base = 'codex -c sandbox_workspace_write.network_access=true';
      const last = codexSessions(cwd, 1)[0];
      cmd = mode === 'login' ? 'codex login' : mode === 'resume' ? `codex resume -c sandbox_workspace_write.network_access=true`
        : mode === 'continue' && last ? `codex resume ${last.id} -c sandbox_workspace_write.network_access=true` : base;
    } else {
      // --continue skips chats made in the Chat view (they're "sdk" sessions), so name the newest one
      const last = mode === 'continue' ? lastSession(configDir || process.env.CLAUDE_CONFIG_DIR, cwd) : null;
      cmd = mode === 'resume' ? 'claude --resume' : last ? `claude --resume ${last}` : mode === 'continue' ? 'claude --continue' : 'claude';
      // IP kit: load its skills as a session-only plugin and add the "use this IP's skills" note.
      if (kit) cmd += ` --plugin-dir ${q(kit.pluginDir)} --append-system-prompt-file ${q(kit.promptFile)}`;
      cmd += ` --settings ${q(sessionSettingsFile())}`;
    }
    const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const args = isWin
      ? (cmd ? ['-NoLogo', '-NoExit', '-Command', cmd] : ['-NoLogo'])
      : (cmd ? ['-l', '-c', `${cmd}; exec ${shell} -l`] : ['-l']);
    const binDir = path.join(APP_DIR, 'bin');
    const env = {
      ...process.env,
      CLAUDE_EDIT_URL: `http://127.0.0.1:${this.port}`,
      CLAUDE_EDIT_PROJECT: projectId,
      ...scriptEnv(),
      // ~/.local/bin is where Claude Code's installer puts it; included in case PATH wasn't updated
      PATH: [binDir, process.env.PATH || process.env.Path || '', path.join(os.homedir(), '.local', 'bin')].join(path.delimiter),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    delete env.Path; // Windows env is case-insensitive; avoid two PATH entries
    // If the editor itself was started from inside a Claude Code session, don't let the embedded
    // sessions inherit that session's identity (they would think they are its child).
    for (const k of SESSION_VARS) delete env[k];
    applyConfigDir(env, configDir);
    if (!pty) throw Object.assign(new Error(`The terminal isn't available on this computer (${String(ptyError?.message || 'node-pty missing').split('\n')[0]})`), { status: 500 });
    const p = pty.spawn(shell, args, { name: 'xterm-256color', cols: Math.max(20, cols | 0), rows: Math.max(5, rows | 0), cwd, env, useConpty: true });
    const s = { projectId, pty: p, buffer: '', clients: new Set(), mode, agent, configDir: configDir || process.env.CLAUDE_CONFIG_DIR || null, startedAt: Date.now(), running: true, exitCode: null };
    p.onData((d) => {
      s.lastOutput = Date.now();
      s.buffer += d;
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
      for (const ws of s.clients) send(ws, { t: 'o', d });
    });
    p.onExit(({ exitCode }) => {
      s.running = false;
      s.exitCode = exitCode;
      for (const ws of s.clients) send(ws, { t: 'exit', code: exitCode });
      this.emit(projectId, { type: 'terminal', projectId, info: this.info(projectId) });
    });
    this.sessions.set(projectId, s);
    this.emit(projectId, { type: 'terminal', projectId, info: this.info(projectId) });
    const waiting = this.waiting.get(projectId);
    this.waiting.delete(projectId);
    for (const ws of waiting || []) if (ws.readyState === 1) this.attach(projectId, ws);
    return this.info(projectId);
  }

  // Clients may connect before a session exists; they are attached as soon as one starts.
  attach(projectId, ws) {
    const s = this.sessions.get(projectId);
    if (!s) {
      if (!this.waiting.has(projectId)) this.waiting.set(projectId, new Set());
      this.waiting.get(projectId).add(ws);
      ws.on('close', () => this.waiting.get(projectId)?.delete(ws));
      return false;
    }
    s.clients.add(ws);
    send(ws, { t: 'reset' });
    if (s.buffer) send(ws, { t: 'o', d: s.buffer });
    if (!s.running) send(ws, { t: 'exit', code: s.exitCode });
    ws.on('close', () => s.clients.delete(ws));
    return true;
  }

  input(projectId, data) {
    const s = this.sessions.get(projectId);
    if (s?.running) s.pty.write(data);
  }

  resize(projectId, cols, rows) {
    const s = this.sessions.get(projectId);
    if (s?.running && cols > 0 && rows > 0) {
      try { s.pty.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch { /* ignore */ }
    }
  }

  // Type a prompt into the running Claude session and submit it.
  async sendPrompt(projectId, text) {
    const s = this.sessions.get(projectId);
    if (!s?.running) return false;
    // A session that just started needs a moment before Claude's prompt accepts input:
    // wait until its output has been quiet for 1.5s (at most ~20s after start).
    while (Date.now() - s.startedAt < 20000) {
      const quiet = Date.now() - (s.lastOutput || s.startedAt);
      if (Date.now() - s.startedAt > 2500 && quiet > 1500) break;
      await sleep(200);
    }
    if (!s.running || this.sessions.get(projectId) !== s) return false; // stopped or restarted while waiting
    const oneLine = String(text).replace(/\r?\n+/g, ' ').trim();
    s.pty.write(oneLine);
    await sleep(350);
    s.pty.write('\r');
    return true;
  }

  kill(projectId) {
    const s = this.sessions.get(projectId);
    if (!s) return;
    try { s.pty.kill(); } catch { /* ignore */ }
    this.sessions.delete(projectId);
    // keep connected clients around so a restarted session reattaches to them
    for (const ws of s.clients) {
      send(ws, { t: 'exit', code: null });
      if (!this.waiting.has(projectId)) this.waiting.set(projectId, new Set());
      this.waiting.get(projectId).add(ws);
    }
    // the dying process reports its exit a little later: by then these sockets belong to the next session
    s.clients.clear();
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  // an account is being removed: end the terminals running on it (sameDir compares folders). Returns how many.
  killAccount(sameDir) {
    let n = 0;
    for (const [id, s] of [...this.sessions]) if (s.configDir && sameDir(s.configDir)) { this.kill(id); n++; }
    return n;
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
