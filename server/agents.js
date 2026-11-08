// The coding agents Jimmy works with — Claude Code and OpenAI's Codex — for a new user's first start:
// are they on this computer, is anyone signed in, and a one-click install when one is missing.
//
// Neither agent is shipped inside Jimmy: Claude Code's licence doesn't allow passing it on, and both update
// themselves. When one is missing, Install runs the maker's own installer (Claude Code: Anthropic's official
// install script; Codex: OpenAI's npm package) — only when the user clicks it. Signing in is always the agent's
// own command in the user's browser; Jimmy never sees an email, password or token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const home = os.homedir();

// Where the installers put the commands, in case PATH (of an app started from the Dock / Start menu, or before a
// restart) doesn't have them yet.
export function extraBinDirs() {
  const dirs = [path.join(home, '.local', 'bin')];
  if (isWin) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'));
  }
  return dirs;
}
export function agentPath() {
  const cur = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  return [...cur, ...extraBinDirs().filter((d) => !cur.includes(d))].join(path.delimiter);
}
export function agentEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.Path;
  env.PATH = agentPath();
  return env;
}

// The full path of a command, or null.
export function findCommand(name) {
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of agentPath().split(path.delimiter)) {
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
    }
  }
  return null;
}

function run(cmd, args, timeoutMs = 15000) {
  const shell = isWin && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(shell ? `"${cmd}"` : cmd, args, { env: agentEnv(), encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// { claude: { installed, path, version }, codex: { installed, path, version, loggedIn } }
export function agentStatus() {
  const out = {};
  for (const name of ['claude', 'codex']) {
    const p = process.env.JIMMY_FAKE_AGENTS === 'none' ? null : findCommand(name);
    const info = { installed: !!p, path: p, version: null };
    if (p) {
      const v = run(p, ['--version']);
      info.version = /\d+\.\d+\.\d+[\w.-]*/.exec(v.out)?.[0] || null;
      if (name === 'codex') info.loggedIn = run(p, ['login', 'status']).code === 0;
    }
    out[name] = info;
  }
  return out;
}

// ------------------------------------------------------------------ install (on the user's click)
const jobs = new Map(); // agent → { state: running|done|error, log: [], error }
function installCommand(agent) {
  if (process.env.JIMMY_FAKE_INSTALL) return [process.execPath, ['-e', process.env.JIMMY_FAKE_INSTALL]]; // tests
  if (agent === 'claude') {
    return isWin
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']]
      : ['/bin/bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']];
  }
  const npm = findCommand('npm');
  if (npm) return [npm, ['install', '-g', '@openai/codex']];
  if (!isWin && findCommand('brew')) return [findCommand('brew'), ['install', 'codex']];
  return null;
}
export function installAgent(agent) {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unknown agent');
  const cur = jobs.get(agent);
  if (cur?.state === 'running') return cur;
  const cmd = installCommand(agent);
  if (!cmd) {
    const job = { state: 'error', log: [], error: 'Codex installs with npm, which comes with Node.js. Install Node.js from nodejs.org, then click Install again.' };
    jobs.set(agent, job);
    return job;
  }
  const job = { state: 'running', log: [], error: null, started: Date.now() };
  jobs.set(agent, job);
  const [exe, args] = cmd;
  const shell = isWin && /\.(cmd|bat)$/i.test(exe);
  let p;
  // (the test stand-in runs on the app's own Node: in the desktop app that is Electron run as Node)
  try { p = spawn(shell ? `"${exe}"` : exe, args, { env: agentEnv(process.env.JIMMY_FAKE_INSTALL ? { ELECTRON_RUN_AS_NODE: '1' } : {}), windowsHide: true, shell }); } catch (e) { job.state = 'error'; job.error = e.message; return job; }
  const add = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { job.log.push(l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').slice(0, 300)); if (job.log.length > 200) job.log.shift(); } };
  p.stdout?.on('data', add);
  p.stderr?.on('data', add);
  p.on('error', (e) => { job.state = 'error'; job.error = e.message; });
  p.on('close', (code) => {
    if (job.state !== 'running') return;
    const installed = process.env.JIMMY_FAKE_INSTALL ? code === 0 : !!findCommand(agent);
    job.state = code === 0 && installed ? 'done' : 'error';
    if (job.state === 'error') job.error = code === 0 ? `The installer finished, but the "${agent}" command wasn't found. Restart Jimmy and check again.` : `The installer stopped (code ${code}). The last lines are shown below.`;
  });
  return job;
}
export const installJob = (agent) => jobs.get(agent) || null;

// Codex's own browser sign-in (`codex login`). Claude Code's is in accounts.js.
let codexLogin = null;
export function startCodexLogin() {
  const p = findCommand('codex');
  if (!p) throw new Error('Codex is not installed yet.');
  if (codexLogin?.proc && codexLogin.proc.exitCode == null) return { state: 'running' };
  const shell = isWin && /\.(cmd|bat)$/i.test(p);
  const proc = spawn(shell ? `"${p}"` : p, ['login'], { env: agentEnv(), windowsHide: true, shell });
  codexLogin = { proc, state: 'running', log: [] };
  const add = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) codexLogin.log.push(l.slice(0, 300)); };
  proc.stdout?.on('data', add);
  proc.stderr?.on('data', add);
  proc.on('close', (code) => { codexLogin.state = code === 0 ? 'done' : 'error'; });
  return { state: 'running' };
}
export const codexLoginState = () => (codexLogin ? { state: codexLogin.state, log: codexLogin.log.slice(-6) } : null);

// Adobe After Effects on this computer (newest version), for "convert to AE project": its AfterFX / app path, or null.
// JIMMY_FAKE_AE=none / a path: for tests.
let aeCache = null;
export function afterEffectsApp() {
  if (process.env.JIMMY_FAKE_AE) return process.env.JIMMY_FAKE_AE === 'none' ? null : process.env.JIMMY_FAKE_AE;
  if (aeCache && Date.now() - aeCache.at < 60000) return aeCache.path;
  let found = null;
  try {
    const roots = isWin ? [process.env.ProgramFiles || 'C:\Program Files', process.env.ProgramW6432].filter(Boolean).map((p) => path.join(p, 'Adobe')) : ['/Applications'];
    const vers = [];
    for (const root of roots) {
      for (const n of fs.readdirSync(root, { withFileTypes: true })) {
        if (!n.isDirectory() || !/^Adobe After Effects/i.test(n.name)) continue;
        const exe = isWin ? path.join(root, n.name, 'Support Files', 'AfterFX.exe') : path.join(root, n.name, `${n.name}.app`);
        if (fs.existsSync(exe)) vers.push({ exe, v: Number(/(\d{4})/.exec(n.name)?.[1] || /(\d+(\.\d+)?)/.exec(n.name)?.[1] || 0) });
      }
    }
    found = vers.sort((a, b) => b.v - a.v)[0]?.exe || null;
  } catch { /* no Adobe folder */ }
  aeCache = { at: Date.now(), path: found };
  return found;
}
