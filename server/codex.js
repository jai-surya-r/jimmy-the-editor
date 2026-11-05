// OpenAI Codex as the project's agent, instead of Claude Code. The chat runs one `codex exec --json` per
// message (resuming the same thread), and its events are translated into the same log messages the Claude
// chat produces, so the chat panel renders both. Codex reads AGENTS.md (the same managed block as CLAUDE.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJsonSafe } from './util.js';

const isWin = process.platform === 'win32';
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const same = (a, b) => {
  const n = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  return n(a) === n(b);
};

// The models Codex itself lists (its own cache of the account's models), newest first.
export function codexModels() {
  const cache = readJsonSafe(path.join(codexHome(), 'models_cache.json'), null);
  const list = (cache?.models || []).filter((m) => m.visibility === 'list').slice(0, 4).map((m) => ({
    value: m.slug, displayName: m.display_name || m.slug, description: m.description || '',
    efforts: (m.supported_reasoning_levels || []).map((x) => x.effort || x).filter((e) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)),
  }));
  return [{ value: '', displayName: 'Default', description: 'Your Codex default model', efforts: [] }, ...list];
}

// Saved Codex sessions for this folder, newest first: { id, file }.
export function codexSessions(cwd, limit = 50) {
  const root = path.join(codexHome(), 'sessions');
  const files = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => b.name.localeCompare(a.name))) {
      if (files.length >= 400) return;
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root, 0);
  const out = [];
  for (const file of files) {
    let first = '';
    try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16384); first = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)).split('\n')[0]; fs.closeSync(fd); } catch { continue; }
    const id = /"id":"([^"]+)"/.exec(first)?.[1];
    const dir = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(first)?.[1];
    if (id && dir && same(JSON.parse(`"${dir}"`), cwd)) out.push({ id, file });
    if (out.length >= limit) break;
  }
  return out;
}

// A saved session as chat log messages (what was said, not the steps in between).
export function loadCodexHistory(file) {
  const log = [];
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.includes('"event_msg"')) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const p = m.payload || {};
      if (p.type === 'user_message' && p.message) log.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: p.message }] }, history: true });
      else if (p.type === 'agent_message' && p.message) log.push({ type: 'assistant', message: { id: `h${log.length}`, content: [{ type: 'text', text: p.message }] }, history: true });
    }
  } catch { /* no history */ }
  return log;
}

const SANDBOX = { plan: 'read-only', auto: 'danger-full-access' }; // everything else: workspace-write

// Run one turn: `codex exec [resume <thread>] --json … -` with the prompt on stdin. onEvent gets each JSON event.
export function runCodexTurn({ cwd, env, threadId, model, effort, permissionMode, images = [], prompt, onEvent, onClose }) {
  const sandbox = SANDBOX[permissionMode] || 'workspace-write';
  const args = ['exec'];
  if (threadId) args.push('resume', threadId);
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandbox}`, '-c', 'approval_policy=never',
    // vedit talks to the editor over http://127.0.0.1
    '-c', 'sandbox_workspace_write.network_access=true');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  for (const img of images) args.push('-i', img);
  args.push('-');
  const q = (a) => (isWin ? (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a) : a);
  const proc = spawn(isWin ? `codex ${args.map(q).join(' ')}` : 'codex', isWin ? [] : args, { cwd, env, shell: isWin, windowsHide: true });
  let buf = '', err = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try { onEvent(JSON.parse(line)); } catch { /* not an event */ }
    }
  });
  proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  proc.on('error', (e) => { err += `\n${e.message}`; });
  proc.on('close', (code) => onClose(code, err));
  proc.stdin.on('error', () => {});
  proc.stdin.end(prompt);
  return proc;
}

// One Codex event → chat log messages (Claude stream-json shapes) and usage.
export function codexEventToLog(e) {
  const it = e.item;
  const step = (name, input) => ({ type: 'assistant', message: { id: `cx-${it.id}`, content: [{ type: 'tool_use', id: it.id, name, input }] } });
  const result = (text, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: it.id, content: String(text || '').slice(-20000), is_error: !!isError }] } });
  if (e.type === 'item.started' && it) {
    if (it.type === 'command_execution') return [step('Bash', { command: it.command })];
    return [];
  }
  if (e.type === 'item.completed' && it) {
    switch (it.type) {
      case 'agent_message': return it.text ? [{ type: 'assistant', message: { id: `cx-${it.id}`, content: [{ type: 'text', text: it.text }] } }] : [];
      case 'reasoning': return it.text ? [{ type: 'assistant', message: { id: `cx-${it.id}`, content: [{ type: 'thinking', thinking: it.text }] } }] : [];
      case 'command_execution': return [result(it.aggregated_output, it.exit_code !== 0 && it.exit_code != null)];
      case 'file_change': return [step('ApplyPatch', { files: (it.changes || []).map((c) => `${c.kind} ${c.path}`) }), result(it.status, it.status === 'failed')];
      case 'mcp_tool_call': return [step(`${it.server}.${it.tool}`, it.arguments || {}), result(it.status, it.status === 'failed')];
      case 'web_search': return [step('WebSearch', { query: it.query }), result('done')];
      case 'todo_list': return [step('TodoWrite', { todos: (it.items || []).map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) }), result('')];
      case 'error': return []; // warnings (model metadata, transport fallback); a failed turn reports its own error
      default: return [];
    }
  }
  return [];
}
