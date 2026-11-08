// A Jimmy server for tests: port 4455, TEMP/TMP in a scratch folder, data/config.json backed up and restored.
// Never touches an everyday Jimmy on the default port 4377.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORK = path.join(ROOT, 'tests', '.work');
export const GOLDEN_DIR = path.join(WORK, 'golden');
export const PORT = 4455;
const BASE = `http://127.0.0.1:${PORT}`;
const CONFIG = path.join(ROOT, 'data', 'config.json');
// JIMMY_APP=electron: run the desktop app (window hidden, its own data folder under tests/.work) instead of
// plain `node server/index.js`. JIMMY_APP_EXE=<the app's program>: the same, with an installed app (a built
// installer or dmg) instead of this folder's Electron.
export const APP_EXE = process.env.JIMMY_APP_EXE || null;
export const APP = process.env.JIMMY_APP === 'electron' || !!APP_EXE;

export async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${d.error || r.statusText}`);
  return d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answering() {
  try { return await api('GET', '/api/state'); } catch { return null; }
}

// Starts the server and returns { stop() }. Fails if something else already holds the port.
export async function startServer({ env = {}, log = path.join(WORK, 'server.log'), visible = false } = {}) {
  if (await answering()) throw new Error(`port ${PORT} is already in use: stop that test server first`);
  const tmp = path.join(WORK, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const backup = path.join(WORK, 'config.json.bak');
  const hadConfig = fs.existsSync(CONFIG);
  if (hadConfig) fs.copyFileSync(CONFIG, backup);
  if (APP) {
    // A new data folder would greet the tests with "Use the graphics card for exports?" (asked once when a GPU that
    // helps is found), which takes keys and drops until answered: answer it as a person would, "Keep CPU".
    const dataDir = env.JIMMY_DATA_DIR || path.join(WORK, 'app-data');
    const cfgFile = path.join(dataDir, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* new */ }
    if (!cfg.gpu?.asked) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, gpu: { ...(cfg.gpu || {}), asked: true } }, null, 2));
    }
  }
  const out = fs.openSync(log, 'w');
  // --stay: no editor window ever connects, so without it the server auto-quits between test steps
  const [exe, args] = APP_EXE ? [APP_EXE, visible ? [] : ['--hidden']] : APP ? [createRequire(import.meta.url)('electron'), ['.', ...(visible ? [] : ['--hidden'])]] : [process.execPath, ['server/index.js', '--stay']];
  const proc = spawn(exe, args, {
    cwd: ROOT, stdio: ['ignore', out, out],
    env: { ...process.env, CLAUDE_EDIT_PORT: String(PORT), TEMP: tmp, TMP: tmp, TMPDIR: tmp, JIMMY_NO_WELCOME: '1', ...(APP ? { JIMMY_DATA_DIR: path.join(WORK, 'app-data') } : {}), ...env },
  });
  let exited = false;
  proc.on('exit', (code, sig) => { exited = true; try { fs.writeSync(out, `\n[test harness] the app exited (code ${code}, signal ${sig})\n`); } catch { /* closed */ } });
  proc.on('error', (err) => { exited = true; try { fs.writeSync(out, `\n[test harness] the app could not start: ${err.message}\n`); } catch { /* closed */ } });
  const stop = async () => {
    if (!exited && APP) {
      // the app quits cleanly (and takes its hidden render windows along) when asked to
      await api('POST', '/api/shutdown').catch(() => {});
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    }
    if (!exited) {
      proc.kill();
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
      if (!exited && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
    }
    fs.closeSync(out);
    if (hadConfig) fs.copyFileSync(backup, CONFIG);
  };
  // JIMMY_START_SECONDS: longer for a first start under Rosetta, which translates the whole app first
  for (let i = 0; i < 2 * Number(process.env.JIMMY_START_SECONDS || 30); i++) {
    if (exited) break;
    const st = await answering();
    if (st) {
      if (!APP_EXE && path.resolve(st.appDir) !== path.resolve(ROOT)) { await stop(); throw new Error(`port ${PORT} answered from another app folder (${st.appDir})`); }
      return { stop, log };
    }
    await sleep(500);
  }
  await stop();
  throw new Error(`the test server did not start (see ${log})`);
}

// Makes sure the golden project exists (runs make-media), opens it and waits until every media item is
// probed and the motion graphics have rendered. Returns { id, doc }.
export async function openGolden({ timeoutMs = 300000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'make-media.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-media failed:\n${r.stderr || r.stdout}`);
  const { id } = await api('POST', '/api/projects/open', { path: GOLDEN_DIR });
  const until = Date.now() + timeoutMs;
  for (;;) {
    const p = await api('GET', `/api/p/${id}`);
    if (p.error) throw new Error(`golden project.json: ${p.error}`);
    const doc = p.doc;
    const probed = doc.media.filter((m) => !m.motion).every((m) => m.duration != null);
    const motionDone = doc.media.filter((m) => m.motion).every((m) => m.path && fs.existsSync(path.join(GOLDEN_DIR, m.path)));
    if (probed && motionDone) return { id, doc, warnings: p.warnings || [] };
    if (Date.now() > until) throw new Error('timed out waiting for media probing / motion renders');
    await sleep(1000);
  }
}
