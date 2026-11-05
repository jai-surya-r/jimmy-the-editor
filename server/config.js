import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, DATA_DIR, readJsonSafe, writeFileAtomic } from './util.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  port: 4377,
  // the desktop app's own folder is read-only once installed: its projects live in its data folder
  projectsRoot: process.env.JIMMY_DATA_DIR ? path.join(DATA_DIR, 'projects') : path.join(APP_DIR, 'projects'),
  recent: [], // absolute paths of projects opened from outside projectsRoot
  hiddenProjects: [], // ids of projects in projectsRoot taken off the Home list (Remove from list); the folders stay
  proxy: { mode: 'auto' }, // auto | always | never
  performance: { usage: 70, threads: 'auto', priority: 'low', jobs: 2 }, // usage: 25 | 50 | 70 | 100 (% of the machine); priority: normal | low | idle
  // Background pre-rendering of timeline chunks (server/prerender.js). maxGB caps the chunk cache across all projects.
  prerender: { enabled: true, quality: 'high', maxGB: 20, pauseOnBattery: true, light: true },
};

let config = null;
// The port in config.json. CLAUDE_EDIT_PORT overrides it for this run only and is never written back
// (the launchers and the CLI read the port from the file).
let filePort = DEFAULTS.port;
let saving = Promise.resolve();

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const saved = readJsonSafe(CONFIG_FILE, {}) || {};
  config = { ...DEFAULTS, ...saved, proxy: { ...DEFAULTS.proxy, ...(saved.proxy || {}) }, performance: { ...DEFAULTS.performance, ...(saved.performance || {}) }, prerender: { ...DEFAULTS.prerender, ...(saved.prerender || {}) } };
  filePort = config.port;
  if (process.env.CLAUDE_EDIT_PORT) config.port = Number(process.env.CLAUDE_EDIT_PORT);
  fs.mkdirSync(config.projectsRoot, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) saveConfig().catch((e) => console.warn('[config]', e.message));
  return config;
}

export function getConfig() {
  return config || loadConfig();
}

// Saves run one after another, so two changes made at the same moment can't land in the wrong order.
export function saveConfig() {
  const run = saving.then(() => writeFileAtomic(CONFIG_FILE, JSON.stringify({ ...config, port: filePort }, null, 2) + '\n'));
  saving = run.catch(() => {});
  return run;
}

export async function updateConfig(patch) {
  if ('port' in patch) filePort = patch.port;
  Object.assign(config, patch);
  await saveConfig();
  return config;
}
