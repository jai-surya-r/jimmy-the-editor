// Jimmy server: REST API + WebSockets + static files. Binds to localhost only.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { loadConfig, getConfig, updateConfig } from './config.js';
import { ProjectManager } from './projects.js';
import { MediaService } from './media.js';
import { TerminalManager, listClaudeProfiles } from './terminals.js';
import { projectChats, renameChat, moveChatName, adoptChats } from './chathistory.js';
import { codexSessions } from './codex.js';
import { ChatManager } from './chats.js';
import { chatLinks, linkedSequence, setChatLink, moveChatLink, healChatLinks } from './chatlinks.js';
import { RenderManager } from './render.js';
import { PrerenderManager } from './prerender.js';
import { listSnapshots, takeSnapshot, restoreSnapshot } from './snapshots.js';
import { getTranscript, saveTranscript } from './transcripts.js';
import { audioLag } from './audiosync.js';
import { agentStatus, installAgent, installJob, startCodexLogin, codexLoginState, afterEffectsApp } from './agents.js';
import { listAccounts, addProfile, removeProfile, startLogin, getLogin, sendLoginCode, cancelLogin, cancelAllLogins, signOut } from './accounts.js';
import { MotionService, MOTION_CDNS, injectRuntime, decodeCfg, readConfigBlock, mergedParams, runtimeFile } from './motion.js';
import { parseCodeValues, parseCssVars, applyCodeValues } from './motionparse.js';
import { listKits, createKit, addKitFile, removeKitFile, kitPath, kitLaunch } from './kits.js';
import { projectUsage, appUsage, clearProject, clearApp, trashPath } from './storage.js';
import { systemFontFamilies, systemFontsCss, systemFontFile } from './sysfonts.js';
import { FFMPEG, FFPROBE, probe, run as runProc, CPU_COUNT, USAGE_LEVELS, perf, renderSlots, cpuH264 } from './ffmpeg.js';
import crypto from 'node:crypto';
const sha1Short = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const runFfmpeg = (args) => runProc(FFMPEG, args);
import {
  APP_DIR, DATA_DIR, sendJson, sendText, readJsonBody, serveFile, saveUpload, safeJoin, uniqueFileName, toPosix,
} from './util.js';
import { budget } from './budget.js';
import { detectGpu, gpuInfo, onGpuChange, cleanGpuSettings } from './gpu.js';
import { perflog } from './perflog.js';
import { uid, guessMediaType, sequenceDuration, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT } from '../public/js/core/model.js';

// more file threads than Node's 4 (see electron/main.js); takes effect when the pool starts, at its first use
process.env.UV_THREADPOOL_SIZE ||= '16';
const config = loadConfig();
// 0 = any free port (the Electron app asks for one): the real port is filled in once the server listens
let PORT = config.port;
const PUBLIC = path.join(APP_DIR, 'public');
const NODE_MODULES = path.join(APP_DIR, 'node_modules');
const VENDOR_ALLOW = ['preact', 'htm', '@xterm/xterm', '@xterm/addon-fit'];

if (!FFMPEG || !FFPROBE) {
  console.error('ffmpeg/ffprobe not found. Install ffmpeg and put it on PATH (or set FFMPEG_PATH / FFPROBE_PATH).');
}

// ------------------------------------------------------------------ pub/sub to app clients

const appClients = new Set(); // { ws, id, subs:Set<projectId>, playing, media, busyUntil, battery }
let prerender = null;
// messages to the editor windows, counted by type for the performance recorder (sent per 5 s, bytes)
const sent = new Map();
const count = (type, bytes) => { const s = sent.get(type) || { n: 0, kb: 0 }; s.n++; s.kb += bytes / 1024; sent.set(type, s); };
function emitProject(projectId, msg) {
  const data = JSON.stringify(msg);
  for (const c of appClients) if (c.subs.has(projectId) && c.ws.readyState === 1) { c.ws.send(data); count(msg.type, data.length); }
  if (msg.type !== 'prerender') prerender?.onEvent(projectId, msg);
}
function emitAll(msg) {
  const data = JSON.stringify(msg);
  for (const c of appClients) if (c.ws.readyState === 1) { c.ws.send(data); count(msg.type, data.length); }
}

const media = new MediaService({
  onStatus: (projectId, mediaId, status) => emitProject(projectId, { type: 'mediaStatus', projectId, mediaId, status }),
  emitAll: (msg) => emitAll(msg),
});
const projects = new ProjectManager({ media, emit: emitProject });
const terminals = new TerminalManager({ port: PORT, emit: emitProject });
const chats = new ChatManager({
  port: PORT, emit: emitProject, accountOf: (id) => accountFor(id), agentOf: (id) => agentFor(id),
  linkOf: (id, sessionId) => { const h = projects.handles.get(id); return h ? linkedSequence(h, sessionId) : null; },
  // a chat learned its session id: link it if it was started for a sequence, or carry its link over to the new id
  onSession: async (s, prev) => {
    const h = projects.handles.get(s.projectId);
    if (!h) return;
    try { if (prev) moveChatName(prev, s.sessionId); } catch (err) { console.warn('[chat names]', err.message); }
    try {
      if (s.linkSeq) { const seqId = s.linkSeq; s.linkSeq = null; await setChatLink(h, seqId, s.sessionId); emitLinks(h); }
      else if (prev && await moveChatLink(h, prev, s.sessionId)) emitLinks(h);
    } catch (err) { console.warn('[chat links]', err.message); }
  },
});
function emitLinks(h) {
  emitProject(h.id, { type: 'chat-links', projectId: h.id, links: chatLinks(h) });
  chats.emitLive(h.id);
}
const motion = new MotionService({ media, port: PORT, emitAll });
media.motion = motion;
const renders = new RenderManager({ media, motion, port: PORT, emitAll });
prerender = new PrerenderManager({
  projects, media, renders, emitProject,
  isOpen: (id) => [...appClients].some((c) => c.subs.has(id)),
  // the active tab of an editor window (a window that hasn't said which counts all its open projects)
  isActive: (id) => [...appClients].some((c) => c.subs.has(id) && (c.active === undefined || c.active === id)),
  idleMs: () => ([...appClients].some((c) => c.playing || c.media) ? 0 : Date.now() - (budget.lastInput || 0)),
});
// one budget for motion graphics, exports, pre-rendering and preview files; it backs off under pressure
budget.start();
// the performance recorder (perflog.js): freezes and what was running, in <data>/logs
perflog.activity = () => {
  const chunks = renders.workers.filter((w) => w.task?.kind === 'chunk');
  const live = [...renders.jobs.values()].filter((j) => !['done', 'error', 'canceled'].includes(j.status));
  const act = {
    clients: appClients.size, open: new Set([...appClients].flatMap((c) => [...c.subs])).size,
    playing: [...appClients].some((c) => c.playing || c.media), scrub: [...appClients].some((c) => c.busyUntil > Date.now()),
    exports: live.filter((j) => j.kind === 'video').length, held: live.filter((j) => j.held).length,
    chunks: chunks.length, chunksPaused: chunks.filter((w) => w.paused).length,
    chunksBg: chunks.filter((w) => !w.task.owners.size).length,
    queued: renders.queue.length, workers: renders.workers.length,
    motion: budget.motionRunning(), motionQueued: motion.queue?.length || 0, motionPages: budget.motionRunning() ? budget.motionPages() : 0,
    media: media.queue.running, mediaQueued: media.queue.items.length,
    chats: [...chats.sessions.values()].filter((s) => s?.running).length, claude: chats.working(),
    level: budget.level, slots: budget.capacity(), cpuSlots: budget.chunkSlots('cpu'), gpuSlots: budget.chunkSlots('gpu'),
    ...(budget.plan ? { mode: budget.plan.mode, headroom: budget.plan.headroom, shares: budget.plan.shares } : {}),
    // what went to the editor windows since the last sample, and the most any one window has waiting to be sent
    sent: Object.fromEntries([...sent].map(([k, v]) => [k, `${v.n}/${Math.round(v.kb)}KB`])),
    backlogKB: Math.round(Math.max(0, ...[...appClients].map((c) => c.ws.bufferedAmount || 0)) / 1024),
  };
  sent.clear();
  return act;
};
perflog.wanted = getConfig().perfLog === true; // off by default (perflog.js)
perflog.start(DATA_DIR);
// what the person at the keyboard is doing, for the scheduler (scheduler.js)
budget.userState = () => ({
  playing: [...appClients].some((c) => c.playing || c.media),
  scrubbing: [...appClients].some((c) => c.busyUntil > Date.now()),
});
budget.claudeWorking = () => chats.working();
// graphics hardware for exports: detected in the background (cached until ffmpeg or the hardware changes)
onGpuChange((info) => { emitAll({ type: 'gpu', gpu: info }); prerender.scheduleAll(); });
setTimeout(() => detectGpu().catch(() => {}), 3000);
let onBattery = false;
budget.onChange((info) => {
  updatePrerenderPause();
  media.queue.pump();
  emitAll({ type: 'budget', budget: info });
  // on battery, exports may switch between GPU and CPU (Settings): pre-rendering follows
  if (info.battery !== onBattery) { onBattery = info.battery; prerender.scheduleAll(); }
});
renders.onExport = (projectId) => prerender.schedule(projectId, 500, true); // an export may have rendered chunks too
// The project list changed (created, opened from a folder, deleted): open Home pages reload it.
let projectsTimer = null;
function projectsChanged() {
  clearTimeout(projectsTimer);
  projectsTimer = setTimeout(() => emitAll({ type: 'projects' }), 150);
}

// Pre-rendering gives way to the person at the keyboard: it pauses while any editor window is playing
// or scrubbing, and (if set) while the machine runs on battery.
let pauseTimer = null;
function updatePrerenderPause() {
  clearTimeout(pauseTimer);
  const now = Date.now();
  const cfg = getConfig().prerender || {};
  let until = 0;
  for (const c of appClients) if (c.busyUntil > now) until = Math.max(until, c.busyUntil);
  const active = [...appClients].some((c) => c.playing || c.media) || until > 0;
  const battery = cfg.pauseOnBattery !== false && [...appClients].some((c) => c.battery);
  renders.setBackgroundPaused(active || battery || !budget.backgroundAllowed());
  if (until) pauseTimer = setTimeout(updatePrerenderPause, until - now + 50);
}

// ------------------------------------------------------------------ helpers

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
// Claude account per project (chosen when the project is created, changeable in the Claude panel).
function accountFor(id) {
  const acc = getConfig().projectAccounts || {};
  if (id in acc) return acc[id] || null;
  return getConfig().claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || null;
}
async function setProjectAccount(id, dir) {
  await updateConfig({ projectAccounts: { ...(getConfig().projectAccounts || {}), [id]: dir || null } });
}
// Auto-fix of review comments, per project (Review › Auto-fix). Kept here, not only in the window's storage: the app
// ends with app.exit (and the installer closes it), which can drop the window's last writes, so a switch turned off
// came back on after a restart. null: never set (the window's own setting, or on).
const autofixFor = (id) => (typeof getConfig().projectAutofix?.[id] === 'boolean' ? getConfig().projectAutofix[id] : null);
// Which agent runs in the project's chat and terminal: 'claude' (default) or 'codex'.
const agentFor = (id) => (getConfig().projectAgents?.[id] === 'codex' ? 'codex' : 'claude');
async function setProjectAgent(id, agent) {
  if (agent !== undefined && agent !== agentFor(id)) await updateConfig({ projectAgents: { ...(getConfig().projectAgents || {}), [id]: agent === 'codex' ? 'codex' : 'claude' } });
}
// saved chats for the project's agent (Claude: from every account, see chathistory.js)
const chatCount = (id, dir) => (agentFor(id) === 'codex' ? codexSessions(dir).length : projectChats(dir).length);

async function needProject(id) {
  const h = await projects.get(id);
  if (!h) throw httpError(404, `Unknown project ${id}`);
  return h;
}
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);

async function addMediaFiles(handle, files, folder, folderName) {
  // files: [{ abs, name? }]
  const ids = [];
  const items = [];
  for (const f of files) {
    let meta = null;
    try { meta = await probe(f.abs); } catch (err) { throw httpError(400, `Can't read ${path.basename(f.abs)}: ${err.message}`); }
    const id = uid('m');
    ids.push(id);
    const item = {
      id, name: f.name || path.basename(f.abs), path: handle.relativize(f.abs), folder: folder || null,
      type: meta.type, duration: meta.duration, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo, codec: meta.codec,
    };
    if (meta.type !== 'audio') { item.width = meta.width; item.height = meta.height; }
    if (meta.type === 'video') item.fps = meta.fps;
    if (meta.type === 'video' && meta.timecode) item.timecode = meta.timecode;
    items.push(item);
  }
  const r = await handle.mutate((d) => {
    // "--folder Name" from the CLI: reuse a bin folder with that name or create it
    if (folderName) {
      let f = d.folders.find((x) => x.name.toLowerCase() === folderName.toLowerCase());
      if (!f) { f = { id: uid('f'), name: folderName, parent: null }; d.folders.push(f); }
      for (const it of items) it.folder = f.id;
    }
    d.media.push(...items);
  }, 'import');
  if (r.error) throw httpError(423, r.error);
  return ids;
}

function listDrives() {
  if (process.platform !== 'win32') {
    // Mac: external/network drives are mounted under /Volumes (Linux: /media/<user>, /mnt)
    const roots = process.platform === 'darwin' ? ['/Volumes'] : [path.join('/media', os.userInfo().username), '/mnt'];
    const out = ['/'];
    for (const r of roots) {
      try { for (const n of fs.readdirSync(r)) if (!n.startsWith('.')) out.push(path.join(r, n)); } catch { /* none */ }
    }
    return out;
  }
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const d = `${String.fromCharCode(c)}:\\`;
    try { fs.accessSync(d); out.push(d); } catch { /* none */ }
  }
  return out;
}

// The project's font folder is looked through without holding up the server (on a NAS that can take seconds),
// and the answer is kept for half a minute: the editor asks for it with every project load.
async function projectFontsCss(handle, { fresh = false } = {}) {
  const dir = handle.layout?.fonts || path.join(handle.dir, 'fonts');
  const hit = handle._fonts;
  if (!fresh && hit && hit.dir === dir && Date.now() - hit.at < 30000) return hit.out;
  const files = [];
  const walk = async (d, depth) => {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (depth < 3) await walk(path.join(d, e.name), depth + 1); }
      else if (/\.(ttf|otf|woff2?)$/i.test(e.name)) files.push(path.relative(dir, path.join(d, e.name)).split(path.sep).join('/'));
    }
  };
  await walk(dir, 0);
  const out = {
    families: files.map((f) => path.basename(f, path.extname(f))),
    css: files.map((f) => {
      const fam = path.basename(f, path.extname(f)).replace(/"/g, '');
      return `@font-face { font-family: "${fam}"; src: url("/api/p/${handle.id}/fonts/${encodeURIComponent(f)}"); font-display: block; }`;
    }).join('\n'),
  };
  handle._fonts = { dir, at: Date.now(), out };
  return out;
}

// ------------------------------------------------------------------ routes

const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
};

route('GET', '/api/gpu', async () => gpuInfo());
route('POST', '/api/gpu/detect', async () => { await detectGpu({ force: true }); return gpuInfo(); });
route('POST', '/api/shutdown', async () => { setTimeout(shutdown, 200); return { ok: true }; });
// Closing a project's tab. GET work: what it still has going, so the editor can ask first (others: another
// editor window has it open too, and closing this tab stops nothing). POST close: the project shuts down unless
// another window has it open: exports, proxies, motion graphics, pre-rendering and its Claude chats stop, and
// the server lets go of it (opened again, everything is looked at afresh).
route('GET', '/api/p/:id/work', async (_req, { id }, url) => {
  const client = url.searchParams.get('client');
  return {
    others: [...appClients].some((c) => c.id !== client && c.subs.has(id)),
    exports: [...renders.jobs.values()].filter((j) => j.projectId === id && !['done', 'error', 'canceled'].includes(j.status)).length,
    proxies: media.proxyCount(id),
    graphics: motion.stack().filter((r) => r.projectId === id && r.state !== 'held').length,
    chats: chats.live(id).filter((c) => c.busy || c.tasks).length,
  };
});
route('POST', '/api/p/:id/close', async (req, { id }) => {
  const { client } = await readJsonBody(req);
  for (const c of appClients) if (c.id === client) { c.subs.delete(id); if (c.active === id) c.active = null; }
  if ([...appClients].some((c) => c.subs.has(id))) return { closed: false };
  for (const j of [...renders.jobs.values()]) if (j.projectId === id) renders.cancel(j.id);
  renders.clearBackground(id);
  motion.stopProject(id);
  media.stopProject(id);
  chats.killProject(id);
  terminals.kill(id);
  projects.unload(id);
  prerender.schedule(id, 0); // finds no project: drops what was planned for it
  console.log(`[projects] closed ${id}`);
  return { closed: true };
});
route('POST', '/api/perf', async (req) => { const b = await readJsonBody(req); perflog.fromEditor(b.client, b.items); return { ok: true }; });
route('GET', '/api/state', async () => ({
  perfLog: !!perflog.on,
  app: 'claude-edit', version: '0.1.0', port: PORT, desktop: IN_ELECTRON, projectsRoot: getConfig().projectsRoot,
  afterEffects: afterEffectsApp(), // Adobe After Effects here: the clip menu offers "convert to AE project" only then
  welcome: !process.env.JIMMY_NO_WELCOME, // first-start setup and tour (off in the test runs that don't test them)
  ffmpeg: !!FFMPEG, appDir: toPosix(APP_DIR), platform: process.platform, home: os.homedir(),
  claudeProfiles: listClaudeProfiles(), claudeConfigDir: getConfig().claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || null,
  proxyMode: getConfig().proxy?.mode || 'auto',
  performance: { ...getConfig().performance, usage: perf().usage }, cpuCount: CPU_COUNT,
  prerender: getConfig().prerender, renderSlots: renderSlots().slots, budget: budget.info(), gpu: gpuInfo(), cacheDir: getConfig().cacheDir || null,
  keymap: getConfig().keymap || null,
  exportPresets: getConfig().exportPresets || {},
  scheduler: getConfig().scheduler === 'classic' ? 'classic' : 'smart',
  exactPause: getConfig().exactPause !== false,
}));
route('POST', '/api/settings', async (req) => {
  const body = await readJsonBody(req);
  const patch = {};
  if ('claudeConfigDir' in body) patch.claudeConfigDir = body.claudeConfigDir || null;
  if (body.performance) {
    const p = body.performance;
    patch.performance = {
      usage: USAGE_LEVELS.includes(Number(p.usage)) ? Number(p.usage) : perf().usage,
      threads: 'auto',
      priority: ['normal', 'low', 'idle'].includes(p.priority) ? p.priority : 'low',
      jobs: Math.max(1, Math.min(8, Number(p.jobs) || 2)),
    };
  }
  if (body.proxyMode) patch.proxy = { ...getConfig().proxy, mode: body.proxyMode };
  if (body.prerender) {
    const p = body.prerender;
    patch.prerender = {
      ...getConfig().prerender, enabled: p.enabled !== false, pauseOnBattery: p.pauseOnBattery !== false, light: p.light !== false,
      maxGB: Math.max(1, Math.min(2000, Number(p.maxGB) || 20)),
    };
  }
  if ('cacheDir' in body) {
    const d = body.cacheDir ? path.resolve(String(body.cacheDir)) : null;
    if (d) await fsp.mkdir(d, { recursive: true });
    patch.cacheDir = d;
  }
  if (body.gpu) patch.gpu = cleanGpuSettings(body.gpu);
  if (body.scheduler) patch.scheduler = body.scheduler === 'classic' ? 'classic' : 'smart';
  if ('exactPause' in body) patch.exactPause = !!body.exactPause;
  // keyboard shortcut layouts (public/js/ui/keymap.js checks what's in them; here only the shape and size)
  if (body.keymap && typeof body.keymap === 'object') {
    const presets = {};
    for (const [name, o] of Object.entries(body.keymap.presets || {}).slice(0, 50)) {
      if (!o || typeof o !== 'object') continue;
      presets[String(name).slice(0, 80)] = Object.fromEntries(Object.entries(o).slice(0, 500)
        .filter(([, keys]) => Array.isArray(keys)).map(([id, keys]) => [String(id).slice(0, 60), keys.slice(0, 8).map((k) => String(k).slice(0, 40))]));
    }
    patch.keymap = { preset: String(body.keymap.preset || 'Default').slice(0, 80), presets };
    if (Number.isInteger(body.keymap.v) && body.keymap.v > 0) patch.keymap.v = body.keymap.v; // layout version (keymap.js migrate)
  }
  // Export › Presets: { name: export options } (the dialog checks what's in them; here only the shape and size)
  if (body.exportPresets && typeof body.exportPresets === 'object') {
    patch.exportPresets = Object.fromEntries(Object.entries(body.exportPresets).slice(0, 50)
      .filter(([, o]) => o && typeof o === 'object' && JSON.stringify(o).length < 2000).map(([name, o]) => [String(name).slice(0, 80), o]));
  }
  if (body.projectsRoot) { await fsp.mkdir(body.projectsRoot, { recursive: true }); patch.projectsRoot = path.resolve(body.projectsRoot); }
  await updateConfig(patch);
  if (patch.performance) media.queue.concurrency = patch.performance.jobs;
  if (patch.gpu) emitAll({ type: 'gpu', gpu: gpuInfo() });
  if (patch.performance || patch.prerender || patch.gpu) {
    updatePrerenderPause();
    prerender.scheduleAll();
    prerender.checkCap().catch(() => {});
    renders.pump();
  }
  return { ok: true };
});

route('GET', '/api/projects', async () => ({ projects: await projects.list() }));
route('POST', '/api/projects', async (req) => {
  const body = await readJsonBody(req);
  // Jimmy's template ships with the app (templates/Jimmy's template); config.templateDir can point elsewhere.
  const template = body.useTemplate ? (getConfig().templateDir || path.join(APP_DIR, 'templates', "Jimmy's template")) : null;
  if (template && !fs.existsSync(template)) throw httpError(400, `Jimmy's template was not found at ${template}. Is that drive connected?`);
  const h = await projects.create(body.name || 'Untitled', body.location || null, { template, ip: body.ip || null });
  if (body.account !== undefined) await setProjectAccount(h.id, body.account);
  projectsChanged();
  return { id: h.id };
});
route('POST', '/api/projects/open', async (req) => {
  const body = await readJsonBody(req);
  const known = projects.index.size;
  const h = await projects.openPath(body.path);
  if (projects.index.size !== known) projectsChanged();
  return { id: h.id };
});
route('POST', '/api/projects/find', async (req) => {
  const body = await readJsonBody(req);
  const h = await projects.findByDir(body.dir);
  if (!h) throw httpError(404, 'No project.json found in this folder or its parents');
  return { id: h.id, dir: h.dir };
});
route('DELETE', '/api/projects/:id', async (_req, { id }) => { await projects.forget(id); projectsChanged(); return { ok: true }; });

// Settings › Storage: what the app has cached, per project and app-wide, and clearing it.
route('GET', '/api/storage', async () => {
  const list = await projects.list();
  const out = [];
  for (const p of list) out.push({ id: p.id, name: p.name, dir: p.dir, ...(await projectUsage(p.dir)) });
  return { projects: out, app: await appUsage() };
});
route('POST', '/api/storage/clear', async (req) => {
  const { items = [] } = await readJsonBody(req);
  for (const it of items) {
    if (it.project) {
      const dir = await projects.dirFor(it.project);
      if (!dir) continue;
      const h = projects.handles.get(it.project) || null;
      await clearProject(dir, it.kind, h);
      if (it.kind === 'chunks') prerender.cleared(it.project);
      if (it.kind === 'cache' && h) { media.status.delete(it.project); await media.sync(h, { force: true }).catch(() => {}); }
    } else await clearApp(it.kind);
  }
  return { ok: true };
});

// where this project keeps After Effects projects (relative to its folder), for "convert to AE project"
route('GET', '/api/p/:id/ae-folder', async (_req, { id }) => { const h = await needProject(id); return { rel: toPosix(path.relative(h.dir, h.layout.afterEffects)), template: !!h.layout.template, app: afterEffectsApp() }; });
route('GET', '/api/p/:id', async (_req, { id }) => {
  const h = await needProject(id);
  prerender.open(h);
  if (!h._linksHealed) {
    h._linksHealed = true;
    healChatLinks(h).then((added) => added && emitLinks(h)).catch((err) => console.warn('[chat links]', err.message));
  }
  return { ...h.snapshot(), terminal: terminals.info(id), chat: chats.info(id), fonts: (await projectFontsCss(h)).families, prerender: prerender.info(id),
    chatLinks: chatLinks(h), chatsLive: chats.live(id) };
});
route('PUT', '/api/p/:id/project', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const r = await h.commit(body.doc, { origin: body.clientId || 'client', baseRev: body.baseRev ?? null, force: !!body.force });
  if (r.conflict) return { status: 409, body: { conflict: true, rev: r.rev, doc: r.doc } };
  if (r.error) return { status: 423, body: r };
  return r;
});
route('PUT', '/api/p/:id/reviews', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const r = await h.commitReviews(body.doc, { origin: body.clientId || 'client', baseRev: body.baseRev ?? null });
  if (r.conflict) return { status: 409, body: { conflict: true, rev: r.rev, doc: r.doc } };
  return r;
});
route('POST', '/api/p/:id/focus', async (req, { id }) => {
  const h = await needProject(id);
  const before = h.focus?.sequenceId;
  h.setFocus(await readJsonBody(req));
  if (h.focus.sequenceId !== before) prerender.schedule(id, 1500, true); // switched sequence: pre-render that one
  return { ok: true };
});
route('GET', '/api/p/:id/focus', async (_req, { id }) => ({ focus: (await needProject(id)).focus }));
route('POST', '/api/p/:id/reveal', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  let target = body.path ? h.resolve(body.path) : h.dir;
  // a file that's gone: open the nearest folder that's still there
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  const select = !!body.path && !!fs.statSync(target, { throwIfNoEntry: false })?.isFile();
  // explorer wants /select,"<path>" with only the path quoted: Node quoting the whole argument (any path with a
  // space) makes it open Documents instead
  if (process.platform === 'win32') execFile('explorer.exe', select ? [`/select,"${target}"`] : [target], select ? { windowsVerbatimArguments: true } : {}, () => {});
  else if (process.platform === 'darwin') execFile('open', select ? ['-R', target] : [target], () => {});
  else execFile('xdg-open', [select ? path.dirname(target) : target], () => {});
  return { ok: true };
});

// media
route('POST', '/api/p/:id/upload', async (req, { id }, url) => {
  const h = await needProject(id);
  const name = url.searchParams.get('name') || 'upload';
  const folder = url.searchParams.get('folder') || null;
  const dir = h.layout.upload(guessMediaType(name));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, uniqueFileName(dir, path.basename(name)));
  await saveUpload(req, file);
  try {
    const ids = await addMediaFiles(h, [{ abs: file, name: path.basename(name) }], folder);
    return { ids };
  } catch (err) {
    fsp.unlink(file).catch(() => {});
    throw err;
  }
});
// Reference files attached to review comments (pasted screenshots, dropped images, any file).
route('POST', '/api/p/:id/refs/upload', async (req, { id }, url) => {
  const h = await needProject(id);
  const name = path.basename(url.searchParams.get('name') || `reference-${Date.now()}.png`);
  const dir = h.layout.refs;
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, uniqueFileName(dir, name));
  await saveUpload(req, file);
  return { path: h.relativize(file), name: path.basename(file) };
});
route('POST', '/api/p/:id/media/link', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const paths = (body.paths || []).map((p) => path.resolve(String(p)));
  const files = [];
  for (const p of paths) {
    const st = await fsp.stat(p).catch(() => null);
    if (!st) throw httpError(404, `Not found: ${p}`);
    if (st.isDirectory()) {
      for (const f of (await fsp.readdir(p)).sort()) {
        if (MEDIA_EXT.has(path.extname(f).slice(1).toLowerCase())) files.push(path.join(p, f));
      }
    } else files.push(p);
  }
  const finalFiles = [];
  for (const f of files) {
    if (body.copy) {
      const dir = h.layout.upload(guessMediaType(f));
      await fsp.mkdir(dir, { recursive: true });
      const dest = path.join(dir, uniqueFileName(dir, path.basename(f)));
      await fsp.copyFile(f, dest);
      finalFiles.push({ abs: dest, name: path.basename(f) });
    } else finalFiles.push({ abs: f });
  }
  return { ids: await addMediaFiles(h, finalFiles, body.folder || null, body.folderName || null) };
});
route('POST', '/api/p/:id/media/:mid/proxy', async (_req, { id, mid }) => {
  const h = await needProject(id);
  media.requestProxy(h, mid);
  return { ok: true };
});
route('POST', '/api/p/:id/media/refresh', async (req, { id }) => {
  const h = await needProject(id);
  const quick = (await readJsonBody(req).catch(() => ({})))?.quick;
  // quick: look at the files again (a drive that came back) and re-read only offline or failed ones
  if (quick) h._mediaSig = null;
  await media.sync(h, { force: !quick });
  return { ok: true };
});
route('GET', '/api/probe', async (_req, _p, url) => probe(url.searchParams.get('path')));
// Saved transcripts (server/transcripts.js), by footage file: read one, keep one. Used by `vedit transcript`.
const footageFile = async (p) => {
  const abs = path.resolve(String(p || ''));
  try { if ((await fsp.stat(abs)).isFile()) return abs; } catch { /* below */ }
  throw httpError(404, `No such file: ${abs}`);
};
route('GET', '/api/transcript', async (_req, _p, url) => getTranscript(await footageFile(url.searchParams.get('path')), { full: url.searchParams.has('full') }));
route('POST', '/api/transcript', async (req) => { const b = await readJsonBody(req); return saveTranscript(await footageFile(b.path), b.transcript ?? b.text, { by: b.by || null }); });
route('GET', '/api/p/:id/media/:mid/transcript', async (_req, { id, mid }) => {
  const h = await needProject(id);
  const m = h.doc.media.find((x) => x.id === mid);
  if (!m?.path) throw httpError(404, 'No such media');
  try { return await getTranscript(await footageFile(h.resolve(m.path))); } catch { return { exists: false, offline: true }; }
});

// Replace footage (Premiere-style): checks a candidate file against the media item it would replace.
// The swap itself is done by the editor (undoable): only media.path changes, so every clip keeps
// its start, duration, in point, speed and cuts — the new file is simply read at the same source times.
route('POST', '/api/p/:id/media/:mid/replace-check', async (req, { id, mid }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const item = h.doc?.media.find((m) => m.id === mid);
  if (!item) throw httpError(404, 'Media item not found');
  const file = path.resolve(String(body.path || ''));
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw httpError(404, `File not found: ${file}`);
  const errors = [], warnings = [];
  let meta;
  try { meta = await probe(file); } catch (err) { throw httpError(400, `Can't read this file as media: ${err.message}`); }
  const old = { type: item.type, width: item.width, height: item.height, fps: item.fps, duration: item.duration, hasAudio: item.hasAudio };
  // what the timeline actually needs from the source
  let need = 0, clips = 0, audioClips = 0;
  for (const s of h.doc.sequences) for (const c of s.clips) {
    if (c.media !== mid) continue;
    clips++;
    if (c.type === 'audio') audioClips++;
    if (c.type === 'video' || c.type === 'audio') need = Math.max(need, (c.in || 0) + c.duration * (c.speed || 1));
  }
  if (file === h.resolve(item.path)) errors.push('That is the file already used by this item.');
  if (meta.type !== item.type) errors.push(`Type mismatch: the original is ${item.type}, the new file is ${meta.type}.`);
  if (item.type !== 'audio' && meta.type === item.type) {
    if (item.width && (meta.width !== item.width || meta.height !== item.height)) warnings.push(`Frame size differs: ${item.width}×${item.height} → ${meta.width}×${meta.height}. Clips keep their scale, so framing will change.`);
  }
  if (item.type === 'video' && meta.type === 'video' && item.fps && meta.fps && Math.abs(item.fps - meta.fps) > 0.01) {
    warnings.push(`Frame rate differs: ${item.fps} → ${meta.fps} fps. Cuts are kept in seconds, so they may land on different frames.`);
  }
  if (meta.type !== 'image' && need > 0 && meta.duration + 1e-3 < need) {
    errors.push(`Too short: the timeline uses this source up to ${need.toFixed(3)}s but the new file is ${meta.duration.toFixed(3)}s long.`);
  } else if (meta.type !== 'image' && item.duration && Math.abs(meta.duration - item.duration) > 0.05) {
    warnings.push(`Duration differs: ${item.duration.toFixed(3)}s → ${meta.duration.toFixed(3)}s (every used range is still covered).`);
  }
  if (audioClips && !meta.hasAudio) warnings.push(`The new file has no audio — ${audioClips} audio clip${audioClips > 1 ? 's' : ''} using this item will be silent.`);
  return { ok: !errors.length, errors, warnings, old, meta, path: h.relativize(file), name: path.basename(file), clips, need };
});

// LUTs: list .cube files the editor can offer, and serve one by path.
const LUT_EXT = /\.cube$/i;
function findLuts(dir, depth, out, skip = new Set()) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && out.length < 2000) findLuts(p, depth - 1, out, skip); }
    else if (LUT_EXT.test(e.name)) out.push(p);
  }
  return out;
}
function adobeLutDirs() {
  const dirs = [];
  const scan = (root, sub) => { try { for (const n of fs.readdirSync(root)) if (/premiere|after effects|media encoder/i.test(n)) dirs.push(path.join(root, n, ...sub)); } catch { /* none */ } };
  if (process.platform === 'win32') {
    scan('C:\\Program Files\\Adobe', ['Lumetri', 'LUTs']);
    dirs.push('C:\\Program Files\\Adobe\\Common\\LUTs', path.join(process.env.APPDATA || '', 'Adobe', 'Common', 'LUTs'));
  } else if (process.platform === 'darwin') {
    try { for (const n of fs.readdirSync('/Applications')) if (/premiere/i.test(n)) dirs.push(path.join('/Applications', n, `${n}.app`, 'Contents', 'Lumetri', 'LUTs')); } catch { /* none */ }
    dirs.push('/Library/Application Support/Adobe/Common/LUTs', path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'Common', 'LUTs'));
  }
  return dirs.filter((d) => fs.existsSync(d));
}
route('GET', '/api/luts', async (_req, _p, url) => {
  const groups = [];
  const add = (name, files, base) => { if (files.length) groups.push({ name, luts: files.sort().map((f) => ({ path: f, name: path.basename(f).replace(LUT_EXT, ''), sub: base ? path.relative(base, path.dirname(f)) : '' })) }); };
  const pid = url.searchParams.get('project');
  const h = pid ? await projects.get(pid).catch(() => null) : null;
  const recent = (getConfig().recentLuts || []).filter((f) => fs.existsSync(f));
  add('Recently used', recent, null);
  if (h) add('In this project', findLuts(h.dir, 5, [], new Set(['node_modules', '.cache', '.claude-edit'])), h.dir);
  const appLuts = path.join(APP_DIR, 'luts');
  add('Jimmy LUTs folder', findLuts(appLuts, 4, []), appLuts);
  // Premiere and Media Encoder ship the same LUTs: list each file name once, Premiere first
  const seenAdobe = new Set();
  const adobe = adobeLutDirs().sort((a, b) => /premiere/i.test(b) - /premiere/i.test(a) || b.localeCompare(a));
  for (const d of adobe) add(`Adobe · ${path.basename(path.dirname(d)) === 'Lumetri' ? path.basename(path.dirname(path.dirname(d))) : 'Common'}`, findLuts(d, 3, []).filter((f) => {
    const k = path.relative(d, f).toLowerCase();
    return seenAdobe.has(k) ? false : (seenAdobe.add(k), true);
  }), d);
  return { groups, appLuts };
});
route('POST', '/api/luts/recent', async (req) => {
  const p = String((await readJsonBody(req)).path || '');
  if (!LUT_EXT.test(p)) return { ok: false };
  await updateConfig({ recentLuts: [p, ...(getConfig().recentLuts || []).filter((x) => x !== p)].slice(0, 12) });
  return { ok: true };
});
route('GET', '/api/lut', async (req, _p, url, res) => {
  let file = String(url.searchParams.get('path') || '');
  if (!path.isAbsolute(file)) {
    const h = await projects.get(url.searchParams.get('project') || '').catch(() => null);
    file = h ? safeJoin(h.dir, file) : null;
  }
  if (!file || !LUT_EXT.test(file)) throw httpError(400, 'Only .cube LUT files can be loaded');
  if (!fs.existsSync(file)) throw httpError(404, `LUT not found: ${file}`);
  await serveFile(req, res, file, { type: 'text/plain; charset=utf-8' });
  return undefined;
});

// files inside the project (renders etc.)
route('GET', '/api/p/:id/file', async (req, { id }, url, res) => {
  const h = await needProject(id);
  const rel = url.searchParams.get('path') || '';
  // Absolute paths are allowed only for review versions exported to a folder outside the project.
  const isVersion = (h.reviews?.versions || []).some((v) => v.file === rel);
  const file = path.isAbsolute(rel) ? (isVersion ? rel : null) : safeJoin(h.dir, rel);
  if (!file) throw httpError(403, 'Path outside project');
  await serveFile(req, res, file);
  return undefined;
});
// Lower-resolution copies of review versions (Frame.io-style quality switch). Made once with ffmpeg,
// cached by file+size+mtime+height in the project's cache folder. POST prepares, GET streams.
const reviewProxyJobs = new Map();
async function reviewProxy(h, rel, height) {
  const isVersion = (h.reviews?.versions || []).some((v) => v.file === rel);
  const file = path.isAbsolute(rel) ? (isVersion ? rel : null) : safeJoin(h.dir, rel);
  if (!file) throw httpError(403, 'Path outside project');
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw httpError(404, 'Version file not found');
  const H = [360, 540, 720, 1080].includes(height) ? height : 720;
  const dir = h.layout?.cache || path.join(h.dir, '.cache');
  const out = path.join(dir, `review-${sha1Short(`${file}|${st.size}|${st.mtimeMs}`)}-${H}.mp4`);
  if (fs.existsSync(out)) return out;
  if (!reviewProxyJobs.has(out)) {
    const tmp = out.replace(/\.mp4$/, '.tmp.mp4');
    // the short side becomes H (so "720p" means 720×1280 for a vertical video)
    const vf = `scale='if(gt(iw,ih),-2,min(${H},iw))':'if(gt(iw,ih),min(${H},ih),-2)':flags=bicubic,format=yuv420p`;
    const job = fsp.mkdir(dir, { recursive: true })
      .then(() => runFfmpeg(['-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, ...cpuH264(24, 'veryfast', Math.round(H * 16 / 9), H), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]))
      .then(() => fsp.rename(tmp, out))
      .finally(() => reviewProxyJobs.delete(out));
    reviewProxyJobs.set(out, job);
  }
  await reviewProxyJobs.get(out);
  return out;
}
route('POST', '/api/p/:id/review-proxy', async (req, { id }) => {
  const body = await readJsonBody(req);
  await reviewProxy(await needProject(id), String(body.path || ''), Number(body.height));
  return { ok: true };
});
route('GET', '/api/p/:id/review-proxy', async (req, { id }, url, res) => {
  const f = await reviewProxy(await needProject(id), url.searchParams.get('path') || '', Number(url.searchParams.get('h')));
  await serveFile(req, res, f, { type: 'video/mp4' });
  return undefined;
});

route('GET', '/api/sysfonts', async () => ({ families: await systemFontFamilies() }));
route('GET', '/api/sysfonts.css', async (_req, _p, _u, res) => {
  sendText(res, 200, await systemFontsCss(), 'text/css; charset=utf-8');
  return undefined;
});
route('GET', '/api/sysfont/:fid', async (req, { fid }, _u, res) => {
  const f = await systemFontFile(fid);
  if (!f) throw httpError(404, 'No such font');
  await serveFile(req, res, f.file, { type: f.type });
  return undefined;
});
route('GET', '/api/p/:id/fonts.css', async (_req, { id }, _u, res) => {
  const h = await needProject(id);
  sendText(res, 200, (await projectFontsCss(h, { fresh: true })).css, 'text/css; charset=utf-8');
  return undefined;
});
route('GET', '/api/p/:id/fonts/:file', async (req, { id, file }, _u, res) => {
  const h = await needProject(id);
  const f = safeJoin(h.layout?.fonts || path.join(h.dir, 'fonts'), file);
  if (!f) throw httpError(403, 'Bad path');
  await serveFile(req, res, f, { cache: true, ram: true });
  return undefined;
});

// exported videos on disk (renders/ and any top-level *export* folder, e.g. 3_Exports)
async function findExports(dir) {
  const out = [];
  const walk = async (d, depth) => {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    // a folder's files are asked about together (a NAS answers them side by side), its folders one by one
    await Promise.all(ents.filter((e) => !e.isDirectory() && /\.(mp4|mov|m4v|webm|mkv)$/i.test(e.name)).map(async (e) => {
      const p = path.join(d, e.name);
      const st = await fsp.stat(p).catch(() => null);
      if (st) out.push({ path: toPosix(path.relative(dir, p)), name: e.name, size: st.size, mtime: st.mtime.toISOString() });
    }));
    for (const e of ents) if (e.isDirectory() && depth < 5 && !e.name.startsWith('.')) await walk(path.join(d, e.name), depth + 1);
  };
  let top = [];
  try { top = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* none */ }
  for (const e of top) if (e.isDirectory() && (e.name === 'renders' || /export/i.test(e.name))) await walk(path.join(dir, e.name), 0);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}
// The Review tab asks every few seconds, and on a busy NAS one look through the export folders can take longer
// than that: callers share the look that is under way, and its answer is used for 15 s (fresh: look again,
// after an export or a delete).
const exportLooks = new Map(); // project dir -> { at, files: Promise }
function exportsOf(dir, { fresh = false } = {}) {
  const hit = exportLooks.get(dir);
  if (hit && (hit.busy || (!fresh && Date.now() - hit.at < 15000))) return hit.files;
  const look = { at: Date.now(), busy: true, files: null };
  look.files = findExports(dir).finally(() => { look.busy = false; look.at = Date.now(); });
  exportLooks.set(dir, look);
  return look.files;
}
// Folders an export can be saved to: the project's default plus every folder in its export area.
route('GET', '/api/p/:id/export-folders', async (_req, { id }) => {
  const h = await needProject(id);
  const def = h.relativize(h.layout.renders);
  const root = h.layout.template ? path.join(h.dir, '3_Exports') : h.layout.renders;
  const out = [];
  const walk = async (d, depth) => {
    out.push(h.relativize(d));
    if (depth >= 3) return;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(d, e.name), depth + 1);
  };
  await walk(root, 0);
  if (!out.includes(def)) out.unshift(def);
  return { default: def, folders: out };
});
route('GET', '/api/p/:id/exports', async (_req, { id }, url) => {
  const h = await needProject(id);
  const used = new Set((h.reviews?.versions || []).map((v) => v.file));
  // rendered motion graphics share the After Effects exports folder of a template project: they aren't exports
  const motion = h.relativize(h.layout.motionRenders);
  const found = (await exportsOf(h.dir, { fresh: url.searchParams.has('fresh') })).filter((f) => !(path.posix.dirname(f.path) === motion && /-\w+-[0-9a-f]{12}\.mov$/.test(f.name)));
  return { files: found.map((f) => ({ ...f, versionId: (h.reviews?.versions || []).find((v) => v.file === f.path)?.id || null, inReview: used.has(f.path) })) };
});
route('POST', '/api/p/:id/exports/add', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const file = safeJoin(h.dir, String(body.path || ''));
  if (!file) throw httpError(403, 'Path outside project');
  const existing = (h.reviews?.versions || []).find((v) => v.file === body.path);
  if (existing) return { versionId: existing.id };
  const meta = await probe(file);
  const seq = h.doc.sequences.find((s) => s.id === body.sequence) || h.doc.sequences[0];
  const versionId = uid('v');
  await h.mutateReviews((r) => {
    const n = r.versions.filter((v) => v.sequence === seq?.id).reduce((m, v) => Math.max(m, v.number || 0), 0) + 1;
    r.versions.push({
      id: versionId, sequence: seq?.id || null, sequenceName: seq?.name || '', number: n, name: `v${n}`,
      file: body.path, createdAt: new Date().toISOString(), status: 'in_review',
      duration: meta.duration, start: 0, width: meta.width, height: meta.height, fps: meta.fps || seq?.fps || 30,
      quality: 'imported', sourceName: path.basename(file),
    });
  });
  return { versionId };
});

// Timeline review rounds: a version with no video. The Review tab plays the live timeline for it, and its
// comments sit on the sequence's timecodes. Starting a round saves a copy of the sequence (and the media it
// uses) so the editor can go back to how it looked; nothing is rendered.
const roundFile = (h, vid) => path.join(h.layout.files, 'review-rounds', `${String(vid).replace(/[^\w-]/g, '')}.json`);
// Synchronize… › Audio (server/audiosync.js): for each pair of media, how far the other's sound is from the reference's.
route('POST', '/api/p/:id/audio-sync', async (req, { id }) => {
  const h = await needProject(id);
  const { pairs } = await readJsonBody(req);
  const abs = (mid) => { const m = h.doc.media.find((x) => x.id === mid); if (!m?.path) throw new Error('no such media'); if (m.hasAudio === false) throw new Error(`${m.name} has no sound`); return h.resolve(m.path); };
  const results = [];
  for (const p of (pairs || []).slice(0, 32)) {
    try { results.push({ ref: p.ref, other: p.other, ...(await audioLag(abs(p.ref), abs(p.other))) }); } catch (err) { results.push({ ref: p.ref, other: p.other, error: err.message }); }
  }
  return { results };
});
// Project snapshots (server/snapshots.js): list, take one now, restore one.
route('GET', '/api/p/:id/snapshots', async (_req, { id }) => ({ snapshots: (await listSnapshots(await needProject(id))).map(({ hash, ...s }) => s) }));
route('POST', '/api/p/:id/snapshots', async (_req, { id }) => { const sid = await takeSnapshot(await needProject(id), 'manual'); return { id: sid, unchanged: !sid }; });
route('POST', '/api/p/:id/snapshots/:sid/restore', async (_req, { id, sid }) => restoreSnapshot(await needProject(id), sid));
route('POST', '/api/p/:id/rounds', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const seq = h.doc.sequences.find((s) => s.id === body.sequence) || h.doc.sequences[0];
  if (!seq) throw httpError(400, 'No sequence to review');
  // ensure: the Review tab opening a sequence's timeline; reuse its latest round instead of starting another
  const cur = body.ensure && (h.reviews?.versions || []).filter((v) => v.kind === 'timeline' && v.sequence === seq.id).sort((a, b) => b.number - a.number)[0];
  if (cur) return { versionId: cur.id };
  const versionId = uid('v');
  const used = new Set(seq.clips.map((c) => c.media).filter(Boolean));
  const snap = { sequence: seq, media: h.doc.media.filter((m) => used.has(m.id)), savedAt: new Date().toISOString() };
  await fsp.mkdir(path.dirname(roundFile(h, versionId)), { recursive: true });
  await fsp.writeFile(roundFile(h, versionId), JSON.stringify(snap));
  await h.mutateReviews((r) => {
    const n = r.versions.filter((v) => v.sequence === seq.id).reduce((m, v) => Math.max(m, v.number || 0), 0) + 1;
    r.versions.push({
      id: versionId, kind: 'timeline', sequence: seq.id, sequenceName: seq.name, number: n, name: `v${n}`,
      file: '', createdAt: new Date().toISOString(), status: 'in_review',
      duration: sequenceDuration(seq), start: 0, width: seq.width, height: seq.height, fps: seq.fps || 30, quality: 'timeline',
    });
  });
  return { versionId };
});
route('GET', '/api/p/:id/rounds/:vid', async (_req, { id, vid }) => {
  const h = await needProject(id);
  try { return JSON.parse(await fsp.readFile(roundFile(h, vid), 'utf8')); } catch { throw httpError(404, 'This round has no saved copy of the timeline'); }
});

// Remove review versions (and their comments) from Review. Jimmy never deletes a project's files: the exported
// videos stay where they are.
route('POST', '/api/p/:id/versions/delete', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const ids = new Set((body.ids || []).map(String));
  const gone = (h.reviews?.versions || []).filter((v) => ids.has(v.id));
  if (gone.length) await h.mutateReviews((r) => { r.versions = r.versions.filter((v) => !ids.has(v.id)); r.comments = r.comments.filter((c) => !ids.has(c.version)); });
  for (const v of gone) if (v.kind === 'timeline') fs.rm(roundFile(h, v.id), { force: true }, () => {});
  return { removed: gone.length };
});

// render / still / jobs
route('POST', '/api/p/:id/render', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  // "auto" (what `vedit render` asks for): full quality when most of the sequence is already pre-rendered,
  // so the export is mostly a stitch; a quicker-encoded draft otherwise.
  if (body.quality === 'auto') {
    const seq = h.doc.sequences.find((s) => s.id === body.sequenceId) || h.doc.sequences[0];
    const ready = seq && getConfig().prerender?.enabled !== false ? await prerender.coverage(h, seq).catch(() => 0) : 0;
    body.quality = ready >= 0.6 ? (getConfig().prerender?.quality || 'high') : 'draft';
  } else if (body.quality === 'draft' && !body.audio && getConfig().prerender?.enabled !== false && (getConfig().prerender?.quality || 'high') !== 'draft') {
    // a draft of a sequence that is mostly pre-rendered already: its chunks are at the pre-render quality, which a
    // draft can't reuse (other encoder settings), so the export would render everything again. Stitching them is
    // quicker and better: the export takes the pre-render quality.
    const seq = h.doc.sequences.find((s) => s.id === body.sequenceId) || h.doc.sequences[0];
    const ready = seq && (!body.format || body.format === 'h264') && !(+body.scale < 1) && !body.rate && !body.container ? await prerender.coverage(h, seq).catch(() => 0) : 0;
    if (ready >= 0.5) body.quality = getConfig().prerender?.quality || 'high';
  }
  const job = await renders.create(h, body.audio ? 'audio' : 'video', body); // audio: an audio-only export in that format
  if (body.wait) { await job.done; }
  return { job: renders.publicJob(job) };
});
route('POST', '/api/p/:id/still', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const job = await renders.create(h, 'still', body);
  await job.done;
  const pj = renders.publicJob(job);
  if (pj.status !== 'done') return { status: 500, body: { error: pj.error || 'Render failed', job: pj } };
  return { job: pj, path: job.output };
});
// The frame the Viewer shows on pause, rendered the way an export renders it (public/js/ui/exactframe.js).
route('POST', '/api/p/:id/exact-frame', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const out = path.join(h.layout.state, 'frames', `exact-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const job = await renders.create(h, 'still', { sequenceId: body.sequenceId, time: body.time, maxSide: body.maxSide, out, quiet: true });
  await job.done;
  renders.jobs.delete(job.id);
  try {
    if (job.status !== 'done') return { status: 500, body: { error: job.error || 'Render failed' } };
    return { png: (await fsp.readFile(out)).toString('base64') };
  } finally { fsp.unlink(out).catch(() => {}); }
});
route('GET', '/api/jobs', async () => ({ jobs: renders.list() }));
// The motion graphics render stack (all projects). Reordering and "render now" are for the editor; renders
// Claude starts simply join the back of the stack.
route('GET', '/api/motion/stack', async () => ({ stack: motion.stack() }));
route('POST', '/api/motion/stack/order', async (req) => {
  const body = await readJsonBody(req);
  motion.reorder((body.keys || []).map(String));
  return { stack: motion.stack() };
});
route('POST', '/api/motion/stack/pause', async (req) => {
  const body = await readJsonBody(req);
  if (!motion.hold(String(body.key || ''), body.paused !== false)) throw httpError(404, 'That graphic is not in the render stack.');
  return { stack: motion.stack() };
});
route('POST', '/api/motion/stack/pause-all', async (req) => {
  motion.holdAll((await readJsonBody(req)).paused !== false);
  return { stack: motion.stack() };
});
route('POST', '/api/motion/stack/rush', async (req) => {
  const body = await readJsonBody(req);
  if (!motion.rush(String(body.key || ''))) throw httpError(404, 'That graphic is not waiting to render.');
  return { stack: motion.stack() };
});
route('GET', '/api/proxies', async () => ({ queue: media.proxyQueue() }));
route('POST', '/api/proxies/rush', async (req) => {
  const body = await readJsonBody(req);
  if (!media.rushProxy(String(body.key || ''))) throw httpError(404, 'That proxy is not waiting.');
  return { queue: media.proxyQueue() };
});
route('GET', '/api/p/:id/prerender', async (_req, { id }) => { await needProject(id); return prerender.info(id); });
// turn pre-rendering on or off for one sequence: { sequenceId, on }
route('POST', '/api/p/:id/prerender', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  if (!h.doc.sequences.some((s) => s.id === body.sequenceId)) throw httpError(404, 'No such sequence');
  await prerender.choose(id, body.sequenceId, !!body.on);
  prerender.emitStatus(id, true);
  return prerender.info(id);
});
route('POST', '/api/jobs/:jid/cancel', async (_req, { jid }) => ({ ok: renders.cancel(jid) }));
route('POST', '/api/jobs/pause-all', async (req) => ({ count: renders.holdAll((await readJsonBody(req)).paused !== false) }));
route('POST', '/api/jobs/:jid/pause', async (req, { jid }) => ({ ok: renders.hold(jid, (await readJsonBody(req)).paused !== false) }));

// terminal control
route('POST', '/api/p/:id/terminal/start', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  if (body.configDir !== undefined) await setProjectAccount(id, body.configDir);
  await setProjectAgent(id, body.agent);
  const configDir = accountFor(id);
  const kit = await kitLaunch(h.doc?.ip).catch(() => null);
  return terminals.start(id, h.dir, { mode: body.mode, cols: body.cols, rows: body.rows, configDir, kit, agent: agentFor(id) });
});
route('POST', '/api/p/:id/terminal/stop', async (_req, { id }) => { terminals.kill(id); return { ok: true }; });
route('POST', '/api/p/:id/terminal/send', async (req, { id }) => {
  const body = await readJsonBody(req);
  const ok = await terminals.sendPrompt(id, body.text || '');
  if (!ok) throw httpError(409, 'Claude is not running in this project. Open the Claude panel and start it first.');
  return { ok };
});
route('GET', '/api/p/:id/terminal', async (_req, { id }) => {
  const h = await needProject(id);
  const configDir = accountFor(id) || path.join(os.homedir(), '.claude');
  return { ...terminals.info(id), chats: chatCount(id, h.dir), configDir, agent: agentFor(id) };
});
route('GET', '/api/p/:id/autofix', async (_req, { id }) => ({ on: autofixFor(id) }));
route('POST', '/api/p/:id/autofix', async (req, { id }) => {
  const body = await readJsonBody(req);
  await updateConfig({ projectAutofix: { ...(getConfig().projectAutofix || {}), [id]: !!body.on } });
  return { on: autofixFor(id) };
});
route('POST', '/api/p/:id/account', async (req, { id }) => {
  const body = await readJsonBody(req);
  if (body.configDir !== undefined) await setProjectAccount(id, body.configDir);
  await setProjectAgent(id, body.agent);
  return { ok: true, configDir: accountFor(id), agent: agentFor(id) };
});

// chat (Claude Code in stream-json mode, shown as a chat window)
route('POST', '/api/p/:id/chat/start', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const kit = await kitLaunch(h.doc?.ip).catch(() => null);
  await setProjectAgent(id, body.agent);
  const info = chats.start(id, h.dir, { mode: body.mode, sessionId: body.sessionId, model: agentFor(id) === 'codex' ? body.codexModel : body.model, effort: body.effort, permissionMode: body.permissionMode, configDir: accountFor(id), kit, agent: agentFor(id) });
  // "New chat for this sequence": linked as soon as the chat has an id (after its first message)
  const s = chats.sessions.get(id);
  if (body.linkSequence && s && agentFor(id) !== 'codex' && h.doc?.sequences.some((x) => x.id === body.linkSequence)) {
    if (s.sessionId) { await setChatLink(h, body.linkSequence, s.sessionId); emitLinks(h); } else s.linkSeq = body.linkSequence;
  }
  return info;
});
route('POST', '/api/p/:id/chat/stop', async (_req, { id }) => { chats.kill(id); return { ok: true }; });
route('POST', '/api/p/:id/chat/send', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  // to a chat that isn't the one shown (a sequence's linked chat): it works in the background, the panel stays
  if (body.sessionId && agentFor(id) !== 'codex' && !(chats.info(id).running && chats.info(id).sessionId === body.sessionId)) {
    let s = chats.find(id, body.sessionId);
    if (!s) {
      const kit = await kitLaunch(h.doc?.ip).catch(() => null);
      s = chats.startBackground(id, h.dir, { sessionId: body.sessionId, model: body.model, effort: body.effort, permissionMode: body.permissionMode, configDir: accountFor(id), kit });
      if (!s) throw httpError(404, "That sequence's chat wasn't found: link the sequence to another chat.");
    }
    const name = linkedSequence(h, body.sessionId)?.name;
    if (s.busy || s.compacting) throw httpError(409, `${name ? `The "${name}" chat` : 'That chat'} is still working: send this when it finishes.`);
    if (!chats.sendTo(s, body.text || '', body.files)) throw httpError(409, 'Nothing to send.');
    chats.emitLive(id);
    return { ok: true, sessionId: body.sessionId };
  }
  // prompts sent from elsewhere in the editor (review comments, "Ask Claude to fix") start a chat if needed
  if (!chats.info(id).running) {
    const kit = await kitLaunch(h.doc?.ip).catch(() => null);
    chats.start(id, h.dir, { mode: body.mode || 'continue', model: agentFor(id) === 'codex' ? body.codexModel : body.model, effort: body.effort, permissionMode: body.permissionMode, configDir: accountFor(id), kit, agent: agentFor(id) });
  }
  const cur = chats.info(id);
  if (cur.busy || cur.compacting) throw httpError(409, 'Claude is still working: wait for it to finish, or press Stop.');
  if (!chats.send(id, body.text || '', body.files)) throw httpError(409, 'Nothing to send.');
  return { ok: true };
});
// the project's Claude chats from every account, newest first (picking one continues it with the project's account)
route('GET', '/api/p/:id/chats', async (_req, { id }) => {
  const h = await needProject(id);
  await adoptChats(h.dir);
  return { chats: projectChats(h.dir).slice(0, 200), current: chats.info(id).sessionId || null, live: chats.live(id) };
});
// sequence -> chat links: { links: { seqId: sessionId } }; POST { sequenceId, sessionId } (sessionId null unlinks)
route('GET', '/api/p/:id/chat-links', async (_req, { id }) => ({ links: chatLinks(await needProject(id)) }));
route('POST', '/api/p/:id/chat-links', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  if (!h.doc?.sequences.some((s) => s.id === body.sequenceId)) throw httpError(404, 'No such sequence');
  if (body.sessionId != null && !/^[\w-]+$/.test(body.sessionId)) throw httpError(400, 'Bad chat id');
  await setChatLink(h, body.sequenceId, body.sessionId || null);
  emitLinks(h);
  return { links: chatLinks(h) };
});
// for vedit inside a chat: which chat it runs in and the sequence that chat works on; POST links it to one
route('GET', '/api/chat-self', async (_req, _p, url) => {
  const s = chats.byKey(url.searchParams.get('key'));
  const h = s && projects.handles.get(s.projectId);
  if (!h) return { chat: null };
  const seq = linkedSequence(h, s.sessionId) || (s.linkSeq && h.doc?.sequences.find((x) => x.id === s.linkSeq)) || null;
  return { chat: { projectId: s.projectId, sessionId: s.sessionId, dir: h.dir }, sequence: seq ? { id: seq.id, name: seq.name } : null };
});
route('POST', '/api/chat-self/link', async (req) => {
  const body = await readJsonBody(req);
  const s = chats.byKey(body.key);
  const h = s && projects.handles.get(s.projectId);
  if (!h) throw httpError(404, 'This command only works inside a Jimmy chat.');
  const cur = linkedSequence(h, s.sessionId);
  if (body.sequence == null) {
    if (cur) { await setChatLink(h, cur.id, null); emitLinks(h); }
    s.linkSeq = null;
    return { sequence: null };
  }
  const want = String(body.sequence).toLowerCase();
  const seq = h.doc?.sequences.find((x) => x.id === body.sequence) || h.doc?.sequences.find((x) => x.name.toLowerCase() === want);
  if (!seq) throw httpError(404, `No sequence "${body.sequence}" in project.json (save the new sequence first).`);
  if (s.sessionId) { await setChatLink(h, seq.id, s.sessionId); emitLinks(h); } else s.linkSeq = seq.id;
  return { sequence: { id: seq.id, name: seq.name } };
});
route('POST', '/api/p/:id/chats/:sid/name', async (req, { sid }) => {
  renameChat(sid, (await readJsonBody(req)).name);
  return { ok: true };
});
route('GET', '/api/p/:id/chat', async (_req, { id }) => {
  const h = await needProject(id);
  return { ...chats.info(id), chats: chatCount(id, h.dir), agent: agentFor(id) };
});

// Claude accounts (profile folders): status, add, sign in, sign out. See server/accounts.js.
// the coding agents: installed? signed in? (first start); install / Codex sign-in on the user's click
route('GET', '/api/agents', async () => ({ agents: agentStatus(), accounts: process.env.JIMMY_FAKE_AGENTS === 'none' ? [] : await listAccounts({ fresh: true }) }));
route('POST', '/api/agents/install', async (req) => ({ job: installAgent(String((await readJsonBody(req)).agent || '')) }));
route('GET', '/api/agents/install/:agent', async (_req, { agent }) => ({ job: installJob(agent) }));
route('POST', '/api/agents/codex/login', async () => startCodexLogin());
route('GET', '/api/agents/codex/login', async () => ({ login: codexLoginState() }));
route('GET', '/api/accounts', async (_req, _p, url) => ({ accounts: await listAccounts({ fresh: url.searchParams.has('fresh') }) }));
route('POST', '/api/accounts', async (req) => ({ account: await addProfile((await readJsonBody(req)).name) }));
route('POST', '/api/accounts/login', async (req) => ({ login: startLogin((await readJsonBody(req)).dir) }));
route('GET', '/api/accounts/login/:lid', async (_req, { lid }) => ({ login: getLogin(lid) }));
route('POST', '/api/accounts/login/:lid/code', async (req, { lid }) => ({ login: sendLoginCode(lid, (await readJsonBody(req)).code) }));
route('POST', '/api/accounts/login/:lid/cancel', async (_req, { lid }) => { cancelLogin(lid); return { ok: true }; });
route('POST', '/api/accounts/logout', async (req) => ({ account: await signOut((await readJsonBody(req)).dir) }));
// Remove an account from this computer (accounts.js removeProfile). Chats and terminals on it end first (their files
// are in its folder); projects that used it go back to the default account.
route('POST', '/api/accounts/remove', async (req) => {
  const { dir } = await readJsonBody(req);
  if (!dir) throw httpError(400, 'Which account?');
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
  const sameDir = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() === norm(dir).toLowerCase() : norm(p) === norm(dir));
  const stopped = chats.killAccount(sameDir) + terminals.killAccount(sameDir);
  if (stopped) await new Promise((r) => setTimeout(r, 1000)); // let them exit and close their files
  const account = await removeProfile(dir);
  const cfg = getConfig();
  const projectAccounts = { ...(cfg.projectAccounts || {}) };
  let moved = 0;
  for (const [id, d] of Object.entries(projectAccounts)) if (d && sameDir(d)) { projectAccounts[id] = null; moved++; }
  await updateConfig({ projectAccounts, ...(cfg.claudeConfigDir && sameDir(cfg.claudeConfigDir) ? { claudeConfigDir: null } : {}) });
  return { account, stopped, projects: moved };
});

// IP kits
route('GET', '/api/kits', async () => ({ kits: await listKits() }));
route('POST', '/api/kits', async (req) => ({ kit: await createKit((await readJsonBody(req)).name) }));
route('POST', '/api/kits/:kid/upload', async (req, { kid }, url) => ({ name: await addKitFile(kid, url.searchParams.get('part'), url.searchParams.get('name'), req) }));
route('POST', '/api/kits/:kid/remove', async (req, { kid }) => {
  const body = await readJsonBody(req);
  await removeKitFile(kid, body.part, body.name);
  return { ok: true };
});
route('POST', '/api/kits/:kid/delete', async (_req, { kid }) => {
  await trashPath(kitPath(kid));
  return { ok: true };
});
route('POST', '/api/kits/:kid/reveal', async (_req, { kid }) => {
  const target = kitPath(kid);
  if (process.platform === 'win32') execFile('explorer.exe', [target], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], () => {});
  return { ok: true };
});
route('GET', '/api/kits/:kid/file', async (req, { kid }, url, res) => {
  await serveFile(req, res, kitPath(kid, url.searchParams.get('part'), url.searchParams.get('name')));
  return undefined;
});

// filesystem browser (for linking media in place and opening project folders)
route('GET', '/api/fs/list', async (_req, _p, url) => {
  let dir = url.searchParams.get('path');
  if (!dir) {
    const home = os.homedir();
    const places = [
      { name: 'Desktop', path: path.join(home, 'Desktop') }, { name: 'Downloads', path: path.join(home, 'Downloads') },
      { name: 'Videos', path: path.join(home, 'Videos') }, { name: 'Movies', path: path.join(home, 'Movies') }, { name: 'Documents', path: path.join(home, 'Documents') },
      { name: 'Pictures', path: path.join(home, 'Pictures') }, { name: 'Music', path: path.join(home, 'Music') },
      { name: 'Home', path: home },
    ].filter((p) => fs.existsSync(p.path));
    return { path: null, parent: null, places, drives: listDrives(), entries: [] };
  }
  dir = path.resolve(dir);
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = (await fsp.stat(full)).isDirectory(); } catch { continue; } }
    const ext = path.extname(e.name).slice(1).toLowerCase();
    const item = { name: e.name, path: full, dir: isDir };
    if (!isDir) {
      item.ext = ext;
      item.kind = MEDIA_EXT.has(ext) ? guessMediaType(e.name) : null;
      try { const st = await fsp.stat(full); item.size = st.size; item.mtime = st.mtimeMs; } catch { /* ignore */ }
    }
    item.isProject = isDir && fs.existsSync(path.join(full, 'project.json'));
    entries.push(item);
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
  const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
  return { path: dir, parent, entries, isProject: fs.existsSync(path.join(dir, 'project.json')), drives: listDrives() };
});

route('POST', '/api/fs/mkdir', async (req) => {
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  if (!body.path || !name || /[\\/:*?"<>|]/.test(name) || /^\.+$/.test(name)) throw Object.assign(new Error('Invalid folder name'), { status: 400 });
  const full = path.join(path.resolve(body.path), name);
  if (fs.existsSync(full)) throw Object.assign(new Error('A file or folder with that name already exists'), { status: 409 });
  await fsp.mkdir(full);
  return { path: full };
});

// motion graphics (HTML compositions rendered to video; see server/motion.js)
function motionItem(h, mid) {
  const item = h.doc?.media.find((m) => m.id === mid);
  if (!item) throw httpError(404, `No media item ${mid}`);
  if (!item.motion?.src) throw httpError(400, `${item.name} is not a motion graphic`);
  return item;
}
async function motionInfo(h, item) {
  const d = await motion.describe(h, item);
  return {
    id: item.id, name: item.name, src: item.motion.src, path: item.path, spec: d.spec, schema: d.schema, params: d.params,
    configError: d.configError, missing: d.missing, status: media.get(h.id, item.id)?.motion || null,
    waiting: motion.queueInfo(h, item.id),
    previewUrl: motion.pageUrl(h, item.motion.src, { mode: 'preview', params: d.params, ...d.spec }),
  };
}
// Put a clip of a motion item on a sequence: on the given track, or on the lowest video track above
// everything already playing at that time (a new track on top if needed).
function placeMotionClip(doc, item, { sequenceId, track, start } = {}) {
  const seq = (sequenceId && doc.sequences.find((s) => s.id === sequenceId || s.name.toLowerCase() === String(sequenceId).toLowerCase())) || doc.sequences[0];
  if (!seq) throw httpError(400, 'Project has no sequences');
  const at = Math.max(0, Number(start) || 0);
  const end = at + item.duration;
  const vids = seq.tracks.filter((t) => t.kind === 'video');
  const busy = (t) => seq.clips.some((c) => c.track === t.id && c.start < end - 1e-6 && c.start + c.duration > at + 1e-6);
  let tr = track ? vids.find((t) => t.id === track) : null;
  if (track && !tr) throw httpError(400, `No video track "${track}" in ${seq.name}`);
  if (tr && busy(tr)) throw httpError(409, `Track ${tr.id} already has a clip between ${at}s and ${end}s`);
  if (!tr) {
    let top = -1;
    vids.forEach((t, i) => { if (busy(t)) top = i; });
    tr = vids.slice(top + 1).find((t) => !busy(t));
  }
  if (!tr) {
    let n = vids.length + 1;
    while (seq.tracks.some((t) => t.id === `v${n}`)) n++;
    tr = { id: `v${n}`, kind: 'video' };
    seq.tracks.splice(seq.tracks.lastIndexOf(vids[vids.length - 1]) + 1, 0, tr);
  }
  const clip = { id: uid('c'), type: 'video', track: tr.id, media: item.id, start: at, duration: item.duration, in: 0 };
  seq.clips.push(clip);
  return { clipId: clip.id, sequenceId: seq.id, track: tr.id };
}
function binFolder(d, folderName) {
  if (!folderName) return null;
  let f = d.folders.find((x) => x.name.toLowerCase() === String(folderName).toLowerCase());
  if (!f) { f = { id: uid('f'), name: String(folderName), parent: null }; d.folders.push(f); }
  return f.id;
}
route('GET', '/api/p/:id/motion', async (_req, { id }) => {
  const h = await needProject(id);
  if (h.doc.media.some((m) => m.motion?.src && !media.get(h.id, m.id)?.motion?.state)) await motion.checkNow(h).catch(() => {});
  const items = [];
  for (const m of h.doc.media) if (m.motion?.src) items.push(await motionInfo(h, m));
  return { items, folder: h.relativize(motion.motionDir(h)) };
});
route('POST', '/api/p/:id/motion', async (req, { id }) => {
  const h = await needProject(id);
  const body = await readJsonBody(req);
  const src = body.starter ? await motion.starter(h, body.name) : body.src;
  if (!src) throw httpError(400, 'Give the composition file (src) or starter: true');
  const item = await motion.newItem(h, { ...body, src });
  let placed = null;
  const r = await h.mutate((d) => {
    item.folder = body.folder || binFolder(d, body.folderName) || null;
    d.media.push(item);
    if (body.place) placed = placeMotionClip(d, item, body.place === true ? {} : body.place);
  }, 'import');
  if (r.error) throw httpError(423, r.error);
  motion.check(h);
  return { id: item.id, src: item.motion.src, ...(placed || {}) };
});
route('GET', '/api/p/:id/motion/:mid', async (_req, { id, mid }) => {
  const h = await needProject(id);
  return motionInfo(h, motionItem(h, mid));
});
// What the Motion tab can edit in the composition's own code: simple constants and CSS variables.
route('GET', '/api/p/:id/motion/:mid/inspect', async (_req, { id, mid }) => {
  const h = await needProject(id);
  const item = motionItem(h, mid);
  let text = '';
  try { text = await fsp.readFile(h.resolve(item.motion.src), 'utf8'); } catch { /* missing */ }
  return { consts: parseCodeValues(text).map(({ start, end, ...c }) => c), vars: parseCssVars(text) };
});
route('POST', '/api/p/:id/motion/:mid/set', async (req, { id, mid }) => {
  const h = await needProject(id);
  motionItem(h, mid);
  const body = await readJsonBody(req);
  const r = await h.mutate((d) => {
    const m = d.media.find((x) => x.id === mid);
    const mo = m.motion;
    if (body.params && typeof body.params === 'object') mo.params = body.replace ? { ...body.params } : { ...(mo.params || {}), ...body.params };
    for (const k of ['duration', 'width', 'height', 'fps']) if (body[k] != null && Number.isFinite(Number(body[k]))) mo[k] = Number(body[k]);
    if (body.src) mo.src = String(body.src);
    if (body.name) m.name = String(body.name);
  }, 'import');
  if (r.error) throw httpError(423, r.error);
  return motionInfo(h, motionItem(h, mid));
});
route('POST', '/api/p/:id/motion/:mid/render', async (req, { id, mid }) => {
  const h = await needProject(id);
  motionItem(h, mid);
  const body = await readJsonBody(req);
  await motion.checkNow(h, { force: body.force ? [mid] : [] });
  if (body.wait) await motion.settle(h, [mid]);
  return motionInfo(h, motionItem(h, mid));
});
route('POST', '/api/p/:id/motion/:mid/frame', async (req, { id, mid }) => {
  const h = await needProject(id);
  const item = motionItem(h, mid);
  const body = await readJsonBody(req);
  const times = (Array.isArray(body.times) ? body.times : [body.time ?? 0]).map(Number).filter(Number.isFinite).slice(0, 24);
  const outDir = body.outDir ? path.resolve(h.dir, String(body.outDir)) : path.join(h.layout.state, 'frames');
  return motion.frames(h, item, times.length ? times : [0], outDir, { scale: body.scale, maxSide: body.maxSide, params: body.params });
});
route('POST', '/api/p/:id/motion/:mid/batch', async (req, { id, mid }) => {
  const h = await needProject(id);
  const src = motionItem(h, mid);
  const body = await readJsonBody(req);
  const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r) => r && typeof r === 'object').slice(0, 500);
  if (!rows.length) throw httpError(400, 'No rows');
  const ids = [];
  const r = await h.mutate((d) => {
    const folder = binFolder(d, body.folderName || `${src.name} (batch)`);
    rows.forEach((row, i) => {
      const { name, ...params } = row;
      const item = JSON.parse(JSON.stringify(d.media.find((m) => m.id === mid)));
      item.id = uid('m');
      item.name = String(name || `${src.name} ${i + 1}`);
      item.folder = folder;
      item.motion.params = { ...(item.motion.params || {}), ...params };
      item.path = item.path.replace(/[^/\\]+$/, `pending-${item.id}.mov`);
      d.media.push(item);
      ids.push(item.id);
    });
  }, 'import');
  if (r.error) throw httpError(423, r.error);
  motion.check(h);
  return { ids };
});
// open a composition in a code editor (VS Code when installed, otherwise the system's text editor)
route('POST', '/api/p/:id/open-source', async (req, { id }) => {
  const h = await needProject(id);
  const file = safeJoin(h.dir, String((await readJsonBody(req)).path || ''));
  if (!file || !fs.existsSync(file)) throw httpError(404, 'File not found');
  if (process.platform === 'win32') {
    execFile('where', ['code'], (err) => {
      if (!err) execFile('cmd', ['/c', 'code', file], { windowsHide: true }, () => {});
      else execFile('notepad.exe', [file], () => {});
    });
  } else if (process.platform === 'darwin') execFile('open', ['-t', file], () => {});
  else execFile('xdg-open', [file], () => {});
  return { ok: true };
});

// ------------------------------------------------------------------ media streaming (outside the JSON router)

async function serveMedia(req, res, url) {
  // /media/:projectId/:mediaId/:kind
  const [, , pid, mid, kind] = url.pathname.split('/');
  const h = await projects.get(pid);
  if (!h) { res.writeHead(404); res.end(); return; }
  const st = media.get(pid, mid);
  if (!st || !st.exists) { res.writeHead(404); res.end('Media offline'); return; }
  const cf = (suffix) => media.cacheFile(h, st.key, suffix);
  switch (kind) {
    case 'file': return serveFile(req, res, st.abs);
    case 'preview': {
      const f = media.previewFile(h, mid);
      if (!f) { res.writeHead(404); res.end(); return; }
      if (st.proxy !== 'ready' && st.browserOk === false) { res.writeHead(409); res.end('Proxy not ready'); return; }
      return serveFile(req, res, f);
    }
    case 'poster': return serveFile(req, res, cf('poster.jpg'), { cache: true, ram: true });
    case 'thumbs': return serveFile(req, res, cf('thumbs.jpg'), { cache: true, ram: true });
    case 'wave': return serveFile(req, res, cf('wave.bin'), { cache: true, ram: true, type: 'application/octet-stream' });
    default: res.writeHead(404); res.end();
  }
}

// Composition pages and their assets: /motion/<projectId>/<path inside the project>. HTML pages requested
// with ?cfg= get the motion runtime injected. They may load only project files and a few public CDNs.
const MOTION_HIDDEN = new Set(['project.json', 'reviews.json', 'claude.md']);
async function serveMotion(req, res, url) {
  const parts = url.pathname.split('/');
  if (parts[1] === 'motion-lib') {
    if (parts[2] !== 'runtime.js') { res.writeHead(404); res.end(); return; }
    if (req.headers.origin === 'null') res.setHeader('Access-Control-Allow-Origin', '*');
    return serveFile(req, res, runtimeFile(), { ram: true });
  }
  const h = await projects.get(parts[2]).catch(() => null);
  if (!h) { res.writeHead(404); res.end(); return; }
  const rel = parts.slice(3).map((p) => decodeURIComponent(p)).join('/');
  const file = safeJoin(h.dir, rel);
  if (!file || MOTION_HIDDEN.has(path.basename(file).toLowerCase())) { res.writeHead(403); res.end(); return; }
  if (req.headers.origin === 'null') res.setHeader('Access-Control-Allow-Origin', '*');
  if (/\.html?$/i.test(file) && url.searchParams.has('cfg')) {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { res.writeHead(404); res.end('Composition not found'); return; }
    const cfg = decodeCfg(url.searchParams.get('cfg')) || {};
    if (!cfg.params) cfg.params = mergedParams(readConfigBlock(text).config, {});
    // Motion tab: the user's code values, and where added image layers load from
    text = applyCodeValues(text, cfg.edit?.consts);
    cfg.base = `/motion/${h.id}/`;
    const self = `http://127.0.0.1:${PORT} http://localhost:${PORT}`;
    const allow = `'self' ${self} data: blob: ${MOTION_CDNS.join(' ')}`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src ${allow} 'unsafe-inline' 'unsafe-eval'; connect-src ${allow}; frame-ancestors ${self}`,
    });
    res.end(injectRuntime(text, cfg));
    return;
  }
  // composition assets (logos, images, fonts) are loaded again by every graphic page: kept in memory
  return serveFile(req, res, file, { ram: true });
}

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith('/vendor/')) {
    const rel = p.slice('/vendor/'.length);
    if (!VENDOR_ALLOW.some((pkg) => rel.startsWith(pkg + '/'))) { res.writeHead(404); res.end(); return; }
    const file = safeJoin(NODE_MODULES, rel);
    return file ? serveFile(req, res, file, { cache: true }) : (res.writeHead(404), res.end());
  }
  if (p === '/' || p === '') p = '/index.html';
  const file = safeJoin(PUBLIC, p.slice(1));
  if (!file) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file)) {
    // SPA fallback for app routes
    if (!path.extname(p)) return serveFile(req, res, path.join(PUBLIC, 'index.html'));
    res.writeHead(404); res.end('Not found'); return;
  }
  return serveFile(req, res, file);
}

// The API can type into Claude Code, so only this app's own pages (and local tools like the CLI,
// which send no Origin) may call it. The Host check blocks DNS-rebinding.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
function isTrusted(req) {
  if (req.headers.host && !LOCAL_HOST.test(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL_ORIGIN.test(origin);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { res.writeHead(400); res.end('Bad request'); return; }
  const motionPath = url.pathname.startsWith('/motion/') || url.pathname.startsWith('/motion-lib/');
  // composition previews run in a sandboxed iframe (origin "null"): they may read their own files, nothing else
  const sandboxed = motionPath && req.method === 'GET' && req.headers.origin === 'null' && (!req.headers.host || LOCAL_HOST.test(req.headers.host));
  if (!isTrusted(req) && !sandboxed) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const out = await r.fn(req, params, url, res);
        if (out === undefined) return; // handler streamed its own response
        if (out && typeof out.status === 'number' && out.body) return sendJson(res, out.status, out.body);
        return sendJson(res, 200, out);
      }
      return sendJson(res, 404, { error: `No route ${req.method} ${url.pathname}` });
    }
    if (url.pathname.startsWith('/media/')) return await serveMedia(req, res, url);
    if (motionPath) return await serveMotion(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.destroy();
    if (!err.status || err.status >= 500) console.error(`[http] ${req.method} ${url.pathname}:`, err);
  }
});

// ------------------------------------------------------------------ websockets

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (!isTrusted(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {}); // e.g. a frame over the size limit: the socket closes, the server carries on
    if (url.pathname === '/ws') onAppSocket(ws);
    else if (url.pathname === '/ws/term') onTermSocket(ws, url.searchParams.get('project'));
    else if (url.pathname === '/ws/chat') onChatSocket(ws, url.searchParams.get('project'));
    else if (url.pathname === '/ws/render-worker') renders.attachWorker(ws, url.searchParams.get('kind') || 'ui', url.searchParams.get('id') || 'ui', url.searchParams.get('direct') === '1');
    else ws.close();
  });
});

// A socket message handler: parses the JSON message and keeps a failure while handling it (a full disk
// while saving a chat attachment, a malformed message) from taking the server down.
const socketHandler = (fn) => (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  try { fn(msg); } catch (err) { console.warn('[ws]', err.message); }
};

function onAppSocket(ws) {
  const client = { ws, id: null, subs: new Set(), playing: false, media: false, busyUntil: 0, battery: false };
  appClients.add(client);
  ws.on('message', socketHandler((msg) => {
    if (msg.type === 'hello') client.id = msg.clientId;
    else if (msg.type === 'subscribe') { client.subs.add(msg.projectId); prerender.schedule(msg.projectId, 2500, true); }
    else if (msg.type === 'unsubscribe') { client.subs.delete(msg.projectId); prerender.schedule(msg.projectId, 1000); }
    else if (msg.type === 'activity') {
      const wasPlaying = client.playing, wasMedia = client.media, wasScrub = client.busyUntil > Date.now();
      // { playing } on timeline play/pause, { media } for the review player, { scrub: true } while the playhead
      // is dragged, { battery } when the power source changes
      if ('playing' in msg) client.playing = !!msg.playing;
      if ('media' in msg) client.media = !!msg.media;
      if (msg.scrub) client.busyUntil = Date.now() + 2500;
      if (msg.input) budget.noteInput();
      if ('battery' in msg) client.battery = !!msg.battery;
      // play, pause or scrub: graphics wait or go on right away (not at the next second's sample)
      if (('playing' in msg && !!msg.playing !== wasPlaying) || ('media' in msg && !!msg.media !== wasMedia) || (msg.scrub && !wasScrub)) budget.replan();
      if ('active' in msg && msg.active !== client.active) {
        // switched tabs: pre-rendering follows (lighter pre-rendering: only the active tab's project)
        const before = client.active;
        client.active = msg.active || null;
        if (before) prerender.schedule(before, 500);
        if (client.active) prerender.schedule(client.active, 1500);
      }
      if (msg.lag) budget.reportLag(); // the preview dropped frames while playing
      budget.setBattery([...appClients].some((c) => c.battery));
      updatePrerenderPause();
    }
  }));
  ws.on('close', () => {
    appClients.delete(client);
    budget.setBattery([...appClients].some((c) => c.battery));
    updatePrerenderPause();
    for (const id of client.subs) prerender.schedule(id, 1000);
    scheduleAutoQuit();
  });
  ws.send(JSON.stringify({ type: 'jobs', jobs: renders.list() }));
  clearTimeout(autoQuitTimer);
}

// Work that would be lost by quitting now: exports (and stills) not finished, motion graphics rendering or
// waiting their turn (held ones are paused on purpose and don't count).
export function busyWork() {
  const exports = renders.list().filter((j) => !['done', 'error', 'canceled'].includes(j.status)).length;
  const graphics = motion.stack().filter((r) => r.state !== 'held').length;
  return { exports, graphics };
}

// The server lives exactly as long as the editor: when the last editor window closes it quits
// (after a short grace period so a page reload doesn't kill it). An export still running finishes first.
// --stay (or config.stayRunning) keeps it running for debugging. Inside the Electron app the app's own
// window decides instead (electron/main.js).
const IN_ELECTRON = !!process.versions.electron;
const AUTO_QUIT = !IN_ELECTRON && !process.argv.includes('--stay') && !getConfig().stayRunning;
let autoQuitTimer = null;
function scheduleAutoQuit(delay = 8000) {
  if (!AUTO_QUIT) return;
  clearTimeout(autoQuitTimer);
  autoQuitTimer = setTimeout(() => {
    if (appClients.size) return;
    if (renders.list().some((j) => !['done', 'error', 'canceled'].includes(j.status))) { scheduleAutoQuit(5000); return; }
    console.log('[app] last editor window closed — shutting down');
    shutdown();
  }, delay);
}
// started but no window ever connected (e.g. the browser failed to open)
scheduleAutoQuit(90000);

function onTermSocket(ws, projectId) {
  if (!projectId) { ws.close(); return; }
  terminals.attach(projectId, ws);
  ws.on('message', socketHandler((msg) => {
    if (msg.t === 'i') terminals.input(projectId, msg.d);
    else if (msg.t === 'r') terminals.resize(projectId, msg.cols, msg.rows);
  }));
}

function onChatSocket(ws, projectId) {
  if (!projectId) { ws.close(); return; }
  chats.attach(projectId, ws);
  ws.on('message', socketHandler((msg) => {
    if (msg.t === 'send') chats.send(projectId, msg.text, msg.files);
    else if (msg.t === 'perm') chats.respond(projectId, msg.id, msg.r || {});
    else if (msg.t === 'interrupt') chats.control(projectId, { subtype: 'interrupt' });
    else if (msg.t === 'stopTask') chats.stopTask(projectId, { toolUseId: msg.toolUseId, taskId: msg.taskId }); // one command
    else if (msg.t === 'mode') chats.control(projectId, { subtype: 'set_permission_mode', mode: msg.mode });
    else if (msg.t === 'model') chats.control(projectId, { subtype: 'set_model', model: msg.model || undefined });
    // effort changes apply to the running session (null = back to the account's default)
    else if (msg.t === 'effort') chats.control(projectId, { subtype: 'apply_flag_settings', settings: { effortLevel: msg.effort || null } });
  }));
}

// ------------------------------------------------------------------ start

// The Electron app (electron/main.js) imports this module and waits for `ready` to learn the port.
const SERVER_FILE = path.join(DATA_DIR, 'server.json');
let markReady;
export const ready = new Promise((resolve) => { markReady = resolve; });
export { shutdown, perflog };

server.listen(PORT, '127.0.0.1', () => {
  if (!PORT) {
    // run-only, like CLAUDE_EDIT_PORT: config.json keeps its saved port
    PORT = config.port = server.address().port;
    terminals.port = chats.port = renders.port = PORT;
    motion.setPort(PORT);
  }
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  Jimmy - The Editor is running → ${url}\n  Projects folder: ${getConfig().projectsRoot}\n`);
  // where vedit (bin/vedit.mjs) finds the running app; removed again on a clean shutdown
  try { fs.writeFileSync(SERVER_FILE, JSON.stringify({ port: PORT, pid: process.pid }) + '\n'); } catch (err) { console.warn('[app] server.json:', err.message); }
  if (process.argv.includes('--open')) openAppWindow(url);
  markReady({ port: PORT, url });
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use — Jimmy is probably already running at http://127.0.0.1:${PORT}`);
    if (process.argv.includes('--open')) openAppWindow(`http://127.0.0.1:${PORT}`);
    setTimeout(() => process.exit(0), 300);
  } else throw err;
});

// On a Mac the editor window gets a browser instance of its own (own profile and Dock icon). Started inside the
// user's everyday Chrome it would restore their tabs, be quit by Cmd+Q with the rest of their browsing, and
// (when Chrome wasn't running yet) live as a child of this server.
const MAC_EDITOR_PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude Edit', 'Editor Window');

// Open as a chromeless app window (Edge/Chrome --app), falling back to the default browser.
function openAppWindow(url) {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    // `open -n` starts it through macOS, detached from this server; when that instance is already running
    // the new process hands the window over to it and exits. Apps are tried by name too, so macOS finds them
    // wherever they are installed; the default browser (a plain tab) is the last resort.
    const names = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
    const apps = [
      ...names.flatMap((n) => [`/Applications/${n}.app`, path.join(home, 'Applications', `${n}.app`)]).filter((p) => fs.existsSync(p)),
      ...names,
    ];
    const args = ['--args', `--user-data-dir=${MAC_EDITOR_PROFILE}`, '--no-first-run', '--no-default-browser-check',
      '--use-mock-keychain', '--password-store=basic', `--app=${url}`, '--window-size=1600,960'];
    const tryNext = (i) => {
      if (i >= apps.length) { execFile('open', [url], () => {}); return; }
      execFile('open', ['-na', apps[i], ...args], (err) => { if (err) tryNext(i + 1); });
    };
    tryNext(0);
    return;
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    path.join(home, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  // --app gives the editor its own window without browser tabs/toolbars
  if (exe) execFile(exe, [`--app=${url}`, '--window-size=1600,960'], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

// The Mac editor instance would otherwise stay in the Dock with no windows after the server quits.
// Its pid comes from the profile's lock ("host-pid"); a stale lock is ignored unless that pid really is that instance.
function closeMacEditorBrowser() {
  if (process.platform !== 'darwin') return;
  try {
    const pid = Number(fs.readlinkSync(path.join(MAC_EDITOR_PROFILE, 'SingletonLock')).split('-').pop());
    if (!(pid > 0)) return;
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 });
    if (cmd.includes(MAC_EDITOR_PROFILE)) process.kill(pid, 'SIGTERM');
  } catch { /* not running */ }
}

function shutdown() {
  // Closing terminals can block on Windows (the console host waits for output nobody reads any more), which
  // left a dead server holding the port. Something outside this process makes sure it ends either way.
  try {
    // On Windows a small Node child does it: not detached, so it shares this server's hidden console (a detached
    // `cmd` opened a console window of its own) and ends with the server when the server exits normally.
    // (ELECTRON_RUN_AS_NODE: inside the Electron app process.execPath is the app itself, not Node)
    if (process.platform === 'win32') spawn(process.execPath, ['-e', `setTimeout(() => { try { process.kill(${process.pid}); } catch {} }, 3000)`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
    else spawn('sh', ['-c', `sleep 3; kill -9 ${process.pid}`], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* exits normally below */ }
  cancelAllLogins();
  terminals.killAll();
  chats.killAll();
  renders.shutdown();
  motion.shutdown();
  closeMacEditorBrowser();
  try { if (JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_FILE); } catch { /* not ours, or gone */ }
  exitApp();
}
// The Electron app ends through Electron (app.exit), not process.exit
let exitApp = () => process.exit(0);
export function onExit(fn) { exitApp = fn; }
if (!IN_ELECTRON) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
