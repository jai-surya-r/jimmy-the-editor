// A project's saved Claude chats, across every Claude account (profile folder) on this computer.
// Claude Code keeps each account's chats in <profile>/projects/<folder>/<id>.jsonl. To continue a chat
// with a different account, its file is copied into that account's folder first (newest copy wins),
// so `--resume <id>` finds it there. The accounts themselves stay separate; only the chat file moves.
import fs from 'node:fs';
import path from 'node:path';
import { listProfiles, DEFAULT_DIR } from './accounts.js';
import { DATA_DIR } from './util.js';

// names given to chats in the history list (session id -> name), shared by every account
const NAMES_FILE = path.join(DATA_DIR, 'chat-names.json');
let names = null;
// the names on disk; null when the file is there but can't be read right now (never taken for "no names")
function readNames() {
  try { return JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) || {}; } catch (err) { return err.code === 'ENOENT' ? {} : null; }
}
export const chatName = (id) => (id && (names ??= readNames())?.[id]) || '';
export function renameChat(id, name) {
  if (!id || !/^[\w-]+$/.test(id)) return;
  const all = readNames(); // what's on disk now, so a stale copy in memory never writes over other names
  if (!all) throw new Error("The chat names file can't be read right now: try again in a moment");
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (clean) all[id] = clean; else delete all[id];
  // written whole and then put in place, so a crash or a full disk can't leave half a file
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${NAMES_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, NAMES_FILE);
  names = all;
}
// a resumed chat that came back with a new session id keeps its name
export function moveChatName(fromId, toId) {
  const name = chatName(fromId);
  if (name && !chatName(toId)) renameChat(toId, name);
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
// the folder a profile uses: the given one, else what the server inherited, else ~/.claude
export const profileDir = (configDir) => path.resolve(configDir || process.env.CLAUDE_CONFIG_DIR || DEFAULT_DIR);
export const historyDir = (configDir, cwd) =>
  path.join(profileDir(configDir), 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

function profiles() {
  const list = listProfiles();
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && !list.some((p) => same(path.resolve(p.dir), path.resolve(env)))) list.push({ name: path.basename(env).replace(/^\.claude[-_.]?/, '') || 'Default', dir: env });
  return list;
}

// the chat's first prompt, as its title (read from the start of the file only; cached per file)
const titles = new Map();
function titleOf(file) {
  if (titles.has(file)) return titles.get(file);
  let title = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type !== 'user' || m.isMeta || !m.message) continue;
      const c = m.message.content;
      // (a linked chat's messages start with a <jimmy-sequence> note: the title is what follows it)
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text' && !/^\s*<jimmy-sequence/.test(b.text))?.text : '';
      if (!text || /^\s*</.test(text)) continue; // slash commands and reminders, not a prompt
      title = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      break;
    }
  } catch { /* unreadable */ }
  if (title) titles.set(file, title);
  return title;
}

// every chat for this folder: { id, title, updatedAt, size, accounts: [names], dir (newest copy's profile) }
export function projectChats(cwd) {
  const byId = new Map();
  for (const p of profiles()) {
    const dir = historyDir(p.dir, cwd);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.size) continue;
      const id = f.slice(0, -6);
      const prev = byId.get(id);
      const entry = prev || { id, accounts: [] };
      entry.accounts.push(p.name);
      if (!prev || st.mtimeMs > prev.updatedAt) Object.assign(entry, { updatedAt: st.mtimeMs, size: st.size, dir: p.dir, file });
      byId.set(id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ file, ...c }) => ({ ...c, name: chatName(c.id), title: chatName(c.id) || titleOf(file) || 'Untitled chat' }));
}

// Make chat `id` resumable with this account: copy the newest copy of it (and its tool-output folder)
// into the account's folder when that copy isn't already there. Returns the id, or null if no such chat.
export function bringChat(configDir, cwd, id) {
  if (!id || !/^[\w-]+$/.test(id)) return null;
  const target = historyDir(configDir, cwd);
  const mine = path.join(target, `${id}.jsonl`);
  let newest = null;
  for (const p of profiles()) {
    const file = path.join(historyDir(p.dir, cwd), `${id}.jsonl`);
    try { const m = fs.statSync(file).mtimeMs; if (!newest || m > newest.m) newest = { file, m }; } catch { /* not here */ }
  }
  if (!newest) return null;
  if (same(path.resolve(newest.file), path.resolve(mine))) return id;
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(newest.file, mine);
  fs.utimesSync(mine, new Date(), new Date(newest.m)); // keeps its place in the list until it's continued
  const extra = newest.file.slice(0, -6); // <id>/ holds large tool outputs the transcript points to
  try { if (fs.statSync(extra).isDirectory()) fs.cpSync(extra, path.join(target, id), { recursive: true }); } catch { /* none */ }
  return id;
}

// Claude Code files chats under the folder's path, so one project on two drives (the NAS and a copy on the laptop) has
// two histories. Chats of a folder with the same name elsewhere are copied here, in each account, so they are listed,
// can be continued, and keep their sequence links (healChatLinks). The originals aren't touched; a copy is brought up
// to date only when the original has simply grown since, so a chat continued here is never overwritten.
// Looked at once a minute at most. Returns the other paths found.
const adopting = new Map(); // folder -> { at, p }
export function adoptChats(cwd) {
  const hit = adopting.get(cwd);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  const p = adopt(cwd).catch((err) => { console.warn('[chats] could not bring in chats from other paths:', err.message); return []; });
  adopting.set(cwd, { at: Date.now(), p });
  return p;
}

async function adopt(cwd) {
  const here = path.resolve(cwd);
  const base = path.basename(here);
  const enc = base.replace(/[^a-zA-Z0-9]/g, '-');
  if (enc.replace(/-/g, '').length < 3) return []; // too short a name to tell projects apart
  const others = new Set();
  let copied = 0;
  for (const p of profiles()) {
    const root = path.join(profileDir(p.dir), 'projects');
    const mine = historyDir(p.dir, here);
    const folders = await fs.promises.readdir(root).catch(() => []);
    for (const name of folders) {
      if (!name.endsWith(`-${enc}`)) continue;
      const from = path.join(root, name);
      if (same(from, mine)) continue;
      const files = (await fs.promises.readdir(from).catch(() => [])).filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'));
      for (const f of files) {
        const other = await cwdOf(path.join(from, f));
        // the folder's name in Claude's list can't tell "a b" from "a-b": the chat itself says where it ran
        if (!other || path.basename(other) !== base || same(path.resolve(other), here)) continue;
        others.add(other);
        if (await bringIn(path.join(from, f), path.join(mine, f))) copied++;
      }
    }
  }
  if (copied) console.log(`[chats] ${base}: ${copied} chat${copied === 1 ? '' : 's'} brought in from ${[...others].join(', ')}`);
  return [...others];
}

// the folder a chat ran in, from the first lines of its file
async function cwdOf(file) {
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead));
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; } finally { await fd?.close().catch(() => {}); }
}

async function bringIn(src, dest) {
  const s = await fs.promises.stat(src).catch(() => null);
  if (!s?.size) return false;
  const d = await fs.promises.stat(dest).catch(() => null);
  if (d && !(s.size > d.size && s.mtimeMs > d.mtimeMs && await grewFrom(src, dest, d.size))) return false;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part-${process.pid}`;
  try {
    await fs.promises.copyFile(src, part);
    await fs.promises.utimes(part, new Date(), s.mtime); // keeps its place in the list
    await fs.promises.rename(part, dest);
  } catch (err) { await fs.promises.unlink(part).catch(() => {}); throw err; }
  const extra = src.slice(0, -6); // <id>/ holds large tool outputs the transcript points to
  if ((await fs.promises.stat(extra).catch(() => null))?.isDirectory()) await fs.promises.cp(extra, dest.slice(0, -6), { recursive: true }).catch(() => {});
  return true;
}

// is `dest` (of this size) what `src` was before it grew? Its last 64 KB are compared.
async function grewFrom(src, dest, size) {
  const n = Math.min(size, 64 * 1024), at = size - n;
  const part = async (f) => {
    const fd = await fs.promises.open(f, 'r');
    try { const b = Buffer.alloc(n); await fd.read(b, 0, n, at); return b; } finally { await fd.close(); }
  };
  try { return (await part(src)).equals(await part(dest)); } catch { return false; }
}

// newest chat for this folder from any account, made resumable with this one
export function lastSession(configDir, cwd) {
  return bringChat(configDir, cwd, projectChats(cwd)[0]?.id);
}
