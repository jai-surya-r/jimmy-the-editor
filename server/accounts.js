// Claude accounts. Each account is a Claude Code profile folder (~/.claude, ~/.claude-work, …): its own
// sign-in, settings and chat history. Accounts are independent — a project uses exactly the one chosen
// for it, and nothing ever switches accounts by itself.
//
// Signing in and out is done by Claude Code's own commands (`claude auth login|logout|status`), run for
// the profile in question. The browser opens Claude's sign-in page; this app never sees the email,
// password or token.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { uid } from '../public/js/core/model.js';
import { addShortcut, removeShortcuts } from './shellprofiles.js';
import { agentPath } from './agents.js';

const isWin = process.platform === 'win32';
// If the editor itself was started from inside a Claude Code session, the sessions it starts must not
// inherit that session's identity (they would think they are its child).
export const SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];
export const DEFAULT_DIR = path.join(os.homedir(), '.claude');
const same = (a, b) => (isWin ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export const isDefaultDir = (dir) => !!dir && same(dir, DEFAULT_DIR);

// Point a child process's environment at a profile. The default profile is selected by leaving
// CLAUDE_CONFIG_DIR unset, exactly like `claude` typed in a plain terminal — naming ~/.claude explicitly
// is not the same thing to Claude Code (it keeps its sign-in and settings under a different key).
// No profile given: the child inherits whatever the server was started with.
export function applyConfigDir(env, configDir) {
  if (!configDir) return env;
  if (isDefaultDir(configDir)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function claudeEnv(configDir) {
  const env = { ...process.env };
  // ~/.local/bin is where Claude Code's installer puts it; included in case PATH wasn't updated
  env.PATH = agentPath(); // the installers' folders too (agents.js), so a fresh install works without a restart
  delete env.Path;
  for (const k of SESSION_VARS) delete env[k];
  return applyConfigDir(env, configDir);
}

// claude may be an .exe or an npm .cmd shim on Windows; the shell finds either.
function runClaude(args, configDir) {
  return spawn(isWin ? `claude ${args.join(' ')}` : 'claude', isWin ? [] : args, { env: claudeEnv(configDir), shell: isWin, windowsHide: true });
}
function killTree(p) {
  if (!p || p.exitCode != null) return;
  try {
    if (isWin && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true });
    else p.kill();
  } catch { /* already gone */ }
}

// ------------------------------------------------------------------ profiles

const looksLikeProfile = (dir) => ['.claude.json', 'projects', 'settings.json', '.credentials.json', 'history.jsonl'].some((f) => fs.existsSync(path.join(dir, f)));

// Profile folders in the home directory. The default one is always listed, first.
export function listProfiles() {
  const home = os.homedir();
  const out = [{ name: 'Default', dir: DEFAULT_DIR, isDefault: true }];
  try {
    for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^\.claude[-_.].+$/.test(ent.name)) continue;
      const dir = path.join(home, ent.name);
      if (looksLikeProfile(dir)) out.push({ name: ent.name.replace(/^\.claude[-_.]/, ''), dir, isDefault: false });
    }
  } catch { /* ignore */ }
  return out;
}
const knownProfile = (dir) => listProfiles().find((p) => same(p.dir, String(dir || ''))) || null;
function needProfile(dir) {
  const p = knownProfile(dir);
  if (!p) throw Object.assign(new Error('Unknown Claude account'), { status: 404 });
  return p;
}

// A new, empty profile folder (~/.claude-<name>). It becomes a real account once someone signs in to it.
// A `claude-<name>` command for it goes into the shell profile (shellprofiles.js), so a terminal can use it too.
export async function addProfile(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!slug) throw Object.assign(new Error('Give the account a short name, like "work" or "personal"'), { status: 400 });
  const dir = path.join(os.homedir(), `.claude-${slug}`);
  if (fs.existsSync(dir) && looksLikeProfile(dir)) throw Object.assign(new Error(`An account called "${slug}" already exists`), { status: 409 });
  await fsp.mkdir(dir, { recursive: true });
  const settings = path.join(dir, 'settings.json');
  if (!fs.existsSync(settings)) await fsp.writeFile(settings, '{}\n');
  statusCache.delete(dir);
  let shortcuts = [];
  try { shortcuts = await addShortcut(slug, dir); } catch (err) { console.warn('[accounts] shell profile:', err.message); }
  return { name: slug, dir, isDefault: false, shortcuts };
}

// Removes an account from this computer: signed out (Claude Code's own logout, which also clears a Mac keychain
// entry), its `claude-<name>` commands taken out of the shell profiles, and its folder (sign-in, settings, chat
// history) moved to the Recycle Bin / Trash, so a mistake can be undone from there. The default account (~/.claude)
// is Claude Code's own and can only be signed out. Stopping chats that use it is the caller's job (index.js).
export async function removeProfile(dir) {
  const profile = needProfile(dir);
  if (profile.isDefault) throw Object.assign(new Error('The default account can\'t be removed, only signed out'), { status: 400 });
  for (const l of logins.values()) if (l.state === 'waiting' && same(l.dir, profile.dir)) cancelLogin(l.id);
  const status = await accountStatus(profile.dir, { fresh: true });
  if (status.loggedIn) await signOut(profile.dir);
  try { await moveToTrash(profile.dir); } catch (err) {
    throw Object.assign(new Error(`Signed out of ${profile.name}, but its folder couldn't be moved to the ${isWin ? 'Recycle Bin' : 'Trash'}: ${err.message}. Close anything using it (a Claude session in a terminal) and try again.`), { status: 409 });
  }
  statusCache.delete(profile.dir);
  let shortcuts = [];
  try { shortcuts = await removeShortcuts(profile.name, profile.dir); } catch (err) { console.warn('[accounts] shell profile:', err.message); }
  console.log(`[accounts] removed ${profile.name} (${profile.dir})${shortcuts.length ? `; shortcuts taken out of ${shortcuts.join(', ')}` : ''}`);
  return { ...profile, shortcuts };
}

// To the Recycle Bin (Windows) or the Trash (macOS, Linux). JIMMY_TRASH_DIR: a folder to move it to instead (tests).
async function moveToTrash(dir) {
  const unique = (bin) => { let p = path.join(bin, path.basename(dir)); for (let i = 2; fs.existsSync(p); i++) p = path.join(bin, `${path.basename(dir)} ${i}`); return p; };
  if (process.env.JIMMY_TRASH_DIR) {
    await fsp.mkdir(process.env.JIMMY_TRASH_DIR, { recursive: true });
    await fsp.rename(dir, unique(process.env.JIMMY_TRASH_DIR));
    return;
  }
  if (process.versions.electron) {
    const { shell } = await import('electron');
    if (shell?.trashItem) { await shell.trashItem(dir); return; }
  }
  if (isWin) {
    await new Promise((resolve, reject) => {
      const ps = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:JIMMY_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')";
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, JIMMY_TRASH_PATH: dir }, windowsHide: true });
      let err = '';
      const timer = setTimeout(() => killTree(p), 60000); // an error dialog nobody sees must not hold it for ever
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => { clearTimeout(timer); if (code === 0 && !fs.existsSync(dir)) resolve(); else reject(new Error(err.trim().split(/\r?\n/)[0] || `exit code ${code}`)); });
    });
    return;
  }
  const bin = process.platform === 'darwin' ? path.join(os.homedir(), '.Trash') : path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
  await fsp.mkdir(bin, { recursive: true });
  await fsp.rename(dir, unique(bin));
}

// ------------------------------------------------------------------ status

const statusCache = new Map(); // dir -> { at, value }

function readStatus(dir) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = runClaude(['auth', 'status', '--json'], dir); } catch { resolve({ installed: false, loggedIn: false }); return; }
    const timer = setTimeout(() => killTree(p), 15000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.resume();
    p.on('error', () => { clearTimeout(timer); resolve({ installed: false, loggedIn: false }); });
    p.on('close', () => {
      clearTimeout(timer);
      // the command exits with 1 when signed out, but still prints its JSON
      try {
        const j = JSON.parse(out.slice(out.indexOf('{')));
        resolve({ installed: true, loggedIn: !!j.loggedIn, email: j.email || null, org: j.orgName || null, plan: j.subscriptionType || null, method: j.authMethod || null });
      } catch { resolve({ installed: false, loggedIn: false }); }
    });
  });
}

export async function accountStatus(dir, { fresh = false } = {}) {
  const hit = statusCache.get(dir);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.value;
  const value = await readStatus(dir);
  statusCache.set(dir, { at: Date.now(), value });
  return value;
}

export async function listAccounts({ fresh = false } = {}) {
  const profiles = listProfiles();
  const statuses = await Promise.all(profiles.map((p) => accountStatus(p.dir, { fresh })));
  return profiles.map((p, i) => ({ ...p, ...statuses[i] }));
}

export async function signOut(dir) {
  const profile = needProfile(dir);
  await new Promise((resolve) => {
    const p = runClaude(['auth', 'logout'], profile.dir);
    const timer = setTimeout(() => killTree(p), 20000);
    p.stdout.resume();
    p.stderr.resume();
    p.on('error', () => { clearTimeout(timer); resolve(); });
    p.on('close', () => { clearTimeout(timer); resolve(); });
  });
  return { ...profile, ...(await accountStatus(profile.dir, { fresh: true })) };
}

// ------------------------------------------------------------------ sign-in

const logins = new Map(); // id -> { id, dir, proc, state: waiting | done | error | canceled, url, wantsCode, message, account }
const publicLogin = (l) => ({ id: l.id, dir: l.dir, state: l.state, url: l.url, wantsCode: l.wantsCode, message: l.message, account: l.account || null });

// Runs `claude auth login` for a profile. Claude Code opens the sign-in page in the browser and finishes
// by itself once the user approves; some setups show a code to paste back instead (sendLoginCode).
export function startLogin(dir) {
  const profile = needProfile(dir);
  for (const l of logins.values()) if (l.state === 'waiting' && same(l.dir, profile.dir)) cancelLogin(l.id); // one at a time per account
  const l = { id: uid('login'), dir: profile.dir, state: 'waiting', url: null, wantsCode: false, message: null, out: '' };
  logins.set(l.id, l);
  let proc;
  try { proc = runClaude(['auth', 'login'], profile.dir); } catch (err) { l.state = 'error'; l.message = err.message; return publicLogin(l); }
  l.proc = proc;
  const onText = (d) => {
    l.out = (l.out + d).slice(-8000);
    const m = /https:\/\/\S+/.exec(l.out);
    if (m && !l.url) l.url = m[0];
    if (/paste code/i.test(l.out)) l.wantsCode = true;
  };
  proc.stdout.on('data', onText);
  proc.stderr.on('data', onText);
  proc.stdin.on('error', () => {});
  const finish = async (code, err) => {
    clearTimeout(l.timer);
    if (l.state !== 'waiting') return;
    const status = await accountStatus(profile.dir, { fresh: true });
    l.account = { ...profile, ...status };
    if (status.loggedIn && !err) { l.state = 'done'; return; }
    l.state = 'error';
    const last = l.out.replace(/https:\/\/\S+/g, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/paste code|opening browser|browser didn't open/i.test(s)).pop();
    l.message = err?.code === 'ENOENT' || !status.installed ? 'Claude Code is not installed (the "claude" command was not found). Run the installer first.'
      : last || `Sign-in did not finish (exit code ${code}).`;
  };
  proc.on('error', (err) => finish(-1, err));
  proc.on('close', (code) => finish(code));
  l.timer = setTimeout(() => { if (l.state === 'waiting') { l.state = 'error'; l.message = 'Sign-in timed out. Try again.'; killTree(proc); } }, 10 * 60 * 1000);
  // forget finished attempts after a while
  setTimeout(() => logins.delete(l.id), 30 * 60 * 1000).unref?.();
  return publicLogin(l);
}

export function getLogin(id) {
  const l = logins.get(id);
  if (!l) throw Object.assign(new Error('That sign-in is no longer running'), { status: 404 });
  return publicLogin(l);
}

export function sendLoginCode(id, code) {
  const l = logins.get(id);
  const text = String(code || '').trim();
  if (!l || l.state !== 'waiting' || !text) throw Object.assign(new Error('That sign-in is no longer waiting for a code'), { status: 409 });
  l.proc.stdin.write(`${text}\n`);
  return publicLogin(l);
}

export function cancelLogin(id) {
  const l = logins.get(id);
  if (!l) return;
  if (l.state === 'waiting') { l.state = 'canceled'; clearTimeout(l.timer); killTree(l.proc); }
}

export function cancelAllLogins() {
  for (const l of logins.values()) cancelLogin(l.id);
}
