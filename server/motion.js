// Motion graphics: HTML/CSS/JS compositions that live in the project as source files and are rendered
// to video. A motion item is an ordinary video media item with a `motion` block:
//   { id, name, type: "video", path: "<render>.mov",
//     motion: { src: "motion/lower-third.html", params: {…}, duration, width, height, fps } }
// The page runs in a headless Chrome/Edge driven over the DevTools protocol. public/motion/runtime.js
// gives it a virtual clock, so every frame is captured at an exact time with a transparent background.
// Frames go to ffmpeg once, producing both the master (ProRes 4444 with alpha, what exports read) and the
// editor's preview proxy (VP9 WebM with alpha). Renders are cached by a hash of the HTML, the files next
// to it, the params and the format, so switching back to an earlier look is instant.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { FFMPEG, perf, withThreads, lowerPriority } from './ffmpeg.js';
import { budget } from './budget.js';
import { perflog } from './perflog.js';
import { sha1, toPosix, safeJoin, uniqueFileName, APP_DIR, exists } from './util.js';
import { findBrowser, spawnBrowser, killBrowser } from './render.js';
import { appHost, openMotionWindow } from './apphost.js';
import { uid } from '../public/js/core/model.js';
import { tempRoot } from './cachedir.js';
import { moveFile } from './layout.js';

const RUNTIME_FILE = path.join(APP_DIR, 'public', 'motion', 'runtime.js');
// Part of every render's cache key: bump it when a runtime change alters how existing pages render.
const RUNTIME_VERSION = 'runtime-2';
const STARTER_FILE = path.join(APP_DIR, 'public', 'motion', 'starter.html');
// Libraries a composition may load from the internet (read-only CDNs). Everything else is blocked.
export const MOTION_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://esm.sh'];
const ASSET_EXT = /\.(html?|css|m?js|json|svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf|mp4|webm|mov|mp3|wav|m4a|ogg|glsl|txt|csv)$/i;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// a folder's listing is reused this long when no watcher reports a change in it
const LISTING_MS = 5000;

// Which of a folder's files a text names: the same answer as testing text.includes(basename) for each one,
// found by looking only where the text has one of the files' extensions (one search per extension, not one
// scan of the whole text per file: a 7 MB script in a folder of 500 files took seconds).
export function mentionedNames(text, byExt) {
  const out = new Set();
  if (!text) return out;
  for (const [ext, names] of byExt) {
    for (let i = text.indexOf(ext); i !== -1; i = text.indexOf(ext, i + 1)) {
      const end = i + ext.length;
      for (const b of names) if (!out.has(b) && end >= b.length && text.startsWith(b, end - b.length)) out.add(b);
    }
  }
  return out;
}
// files (full paths) -> { byExt: Map(ext -> [basename]) } for mentionedNames
export function nameIndex(files) {
  const byExt = new Map();
  const seen = new Set();
  for (const f of files) {
    const b = path.basename(f);
    if (seen.has(b)) continue;
    seen.add(b);
    const ext = path.extname(b);
    if (!ext) continue;
    if (!byExt.has(ext)) byExt.set(ext, []);
    byExt.get(ext).push(b);
  }
  return byExt;
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

// ------------------------------------------------------------------ composition files

// The page may declare its defaults in a JSON block:
//   <script type="application/json" id="motion">{ "duration": 5, "params": { "title": "Hello", "accent": { "type": "color", "default": "#ff3366" } } }</script>
export function readConfigBlock(htmlText) {
  const m = /<script[^>]*\bid\s*=\s*["']motion(?:-config)?["'][^>]*>([\s\S]*?)<\/script>/i.exec(htmlText || '');
  if (!m) return { config: {}, error: null };
  try {
    const c = JSON.parse(m[1]);
    return { config: c && typeof c === 'object' ? c : {}, error: null };
  } catch (err) {
    return { config: {}, error: `The <script id="motion"> block is not valid JSON: ${err.message}` };
  }
}

// Normalise declared params into a schema: [{ key, type, default, label, options, min, max, step }]
export function paramSchema(config) {
  const out = [];
  for (const [key, raw] of Object.entries(config?.params || {})) {
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { default: raw };
    let type = d.type;
    const v = d.default;
    if (!type) {
      if (Array.isArray(d.options)) type = 'select';
      else if (typeof v === 'boolean') type = 'boolean';
      else if (typeof v === 'number') type = 'number';
      else if (typeof v === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) type = 'color';
      else type = 'text';
    }
    out.push({ key, type, default: v ?? (type === 'number' ? 0 : type === 'boolean' ? false : type === 'color' ? '#ffffff' : ''), label: d.label || key, options: d.options, min: d.min, max: d.max, step: d.step, multiline: !!d.multiline || (typeof v === 'string' && v.includes('\n')) });
  }
  return out;
}
export function mergedParams(config, params) {
  const out = {};
  for (const p of paramSchema(config)) out[p.key] = p.default;
  return { ...out, ...(params || {}) };
}

// Insert the runtime (and the render config) at the top of a composition page.
export function injectRuntime(htmlText, cfg) {
  const head = `<script>window.__MOTION_CFG__=${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script>`
    + '<script src="/motion-lib/runtime.js"></script>'
    + '<link rel="icon" href="data:,"><style>html,body{margin:0;background:transparent}</style>';
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(htmlText);
    if (m) return htmlText.slice(0, m.index + m[0].length) + head + htmlText.slice(m.index + m[0].length);
  }
  return head + htmlText;
}

export const encodeCfg = (cfg) => Buffer.from(JSON.stringify(cfg)).toString('base64url');
export function decodeCfg(s) {
  try { return JSON.parse(Buffer.from(String(s || ''), 'base64url').toString('utf8')); } catch { return null; }
}

// ------------------------------------------------------------------ DevTools protocol

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map(); // `${sessionId}|${method}` -> fn
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(`${msg.sessionId || ''}|${msg.method}`)?.(msg.params);
      }
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Browser connection closed'));
      this.pending.clear();
    });
  }
  // a browser that hangs (a frozen page) never answers: no call waits for it forever
  send(method, params = {}, sessionId, ms = 120000) {
    if (this.ws.readyState !== 1) return Promise.reject(new Error('Browser connection closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: the headless browser stopped answering`)); }, ms);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(sessionId, method, fn) { this.handlers.set(`${sessionId || ''}|${method}`, fn); }
  off(sessionId) { for (const k of [...this.handlers.keys()]) if (k.startsWith(`${sessionId}|`)) this.handlers.delete(k); }
}

const STALL_MS = 120000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms))]);

class MotionBrowser {
  constructor(port, index = 0) {
    this.port = port;
    this.index = index;
    this.proc = null;
    this.cdp = null;
    this.starting = null;
    this.idle = null;
    this.users = 0;
  }
  async ensure() {
    clearTimeout(this.idle);
    if (this.cdp && this.cdp.ws.readyState === 1) return this.cdp;
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch() {
    const exe = findBrowser();
    if (!exe) throw new Error('Motion graphics need Google Chrome or Microsoft Edge installed.');
    const profile = path.join(tempRoot(), `claude-edit-motion-profile-${this.port}${this.index ? `-${this.index}` : ''}`); // per port and browser: never shared
    await fsp.mkdir(profile, { recursive: true });
    const portFile = path.join(profile, 'DevToolsActivePort');
    await fsp.unlink(portFile).catch(() => {});
    const args = [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--force-device-scale-factor=1', '--enable-unsafe-swiftshader',
      // laptops with two GPUs: draw on the fast one (NVIDIA/AMD), not the integrated one (about 2.5x faster per frame)
      '--force_high_performance_gpu',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ];
    const proc = spawnBrowser(exe, args);
    lowerPriority(proc);
    this.proc = proc;
    proc.on('error', () => {}); // could not be started: reported below as "exited right after starting"
    proc.on('exit', () => { if (this.proc === proc) { this.proc = null; this.cdp = null; } });
    let text = null;
    for (let i = 0; i < 150 && !text; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (proc.exitCode != null) throw new Error('The headless browser for motion graphics exited right after starting.');
      try { text = await fsp.readFile(portFile, 'utf8'); } catch { /* not yet */ }
      if (text && text.split('\n').length < 2) text = null;
    }
    if (!text) { this.kill(); throw new Error('The headless browser for motion graphics did not start.'); }
    const [port, wsPath] = text.split('\n').map((s) => s.trim());
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('close', () => { if (this.cdp?.ws === ws) this.cdp = null; });
    this.cdp = new Cdp(ws);
    return this.cdp;
  }
  release() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.users) this.kill(); }, 3 * 60 * 1000);
  }
  kill(sync = false) {
    const p = this.proc;
    this.proc = null;
    try { this.cdp?.ws.close(); } catch { /* ignore */ }
    this.cdp = null;
    killBrowser(p, sync);
  }

  // A page sized to the composition, transparent, with network access limited to the composition's own
  // folder and the allowed CDNs (it can't reach the editor's API or anything else on the internet).
  // Inside the desktop app the page is a hidden window of the app (apphost.js) instead of a browser tab.
  async openPage(width, height) {
    this.users++;
    let page;
    try {
      if (appHost) {
        const host = await openMotionWindow(width, height);
        page = { host, s: (m, p) => host.send(m, p), on: (m, fn) => host.on(m, fn) };
      } else {
        const cdp = await this.ensure();
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', width, height, newWindow: true });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        page = { cdp, targetId, sessionId, s: (m, p) => cdp.send(m, p, sessionId), on: (m, fn) => cdp.on(sessionId, m, fn) };
      }
    } catch (err) {
      this.users = Math.max(0, this.users - 1); // a page that never opened is not in use (the browser may idle out)
      throw err;
    }
    Object.assign(page, { logs: [], owner: this });
    const { s, on } = page;
    // page URLs → project-relative paths, without the render config query
    const tidy = (m) => String(m).replace(/https?:\/\/(127\.0\.0\.1|localhost):\d+\/motion\/[0-9a-f]+\//g, '').replace(/\?cfg=[\w-]+/g, '');
    const log = (m) => { if (page.logs.length < 30) page.logs.push(tidy(m)); };
    on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      log(`Uncaught ${String(d?.exception?.description || d?.text || 'error').split('\n')[0]}${d?.url ? ` (${d.url.split('/').pop()}:${d.lineNumber + 1})` : ''}`);
    });
    on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning') return;
      const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      log(`console.${p.type}: ${text}`);
    });
    on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') log(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
    });
    const origin = `http://127.0.0.1:${this.port}`;
    on('Fetch.requestPaused', (p) => {
      const u = p.request.url;
      const ok = u.startsWith(`${origin}/motion/`) || u.startsWith(`${origin}/motion-lib/`) || MOTION_CDNS.some((c) => u.startsWith(`${c}/`));
      if (ok) s('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      else {
        log(`Blocked request: ${u} (only files in the project and ${MOTION_CDNS.map((c) => c.replace('https://', '')).join(', ')} can be loaded)`);
        s('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    on('Page.loadEventFired', () => page.onLoad?.());
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Log.enable').catch(() => {});
    await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await s('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    return page;
  }
  async closePage(page) {
    this.users = Math.max(0, this.users - 1);
    if (page.host) page.host.close();
    else {
      page.cdp.off(page.sessionId);
      await page.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
    if (!this.users) this.release();
  }
}

// Several headless browsers, one page each where possible. Pages in one browser share its single GPU (SwiftShader)
// process, which draws and PNG-encodes every screenshot one at a time: four pages in one browser ran at about the
// speed of one, with the CPU nearly idle. Separate browsers capture side by side.
const MAX_BROWSERS = 6;
class MotionBrowsers {
  constructor(port) {
    this.list = Array.from({ length: MAX_BROWSERS }, (_, i) => new MotionBrowser(port, i));
  }
  openPage(width, height) {
    const b = this.list.reduce((a, x) => (x.users < a.users ? x : a), this.list[0]);
    return b.openPage(width, height);
  }
  closePage(page) {
    return page.owner.closePage(page);
  }
  kill(sync = false) {
    for (const b of this.list) b.kill(sync);
  }
}

async function evaluate(page, expression, ms = 30000) {
  const r = await withTimeout(page.s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), ms, 'The composition');
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'Script error');
  }
  return r.result?.value;
}

async function loadComposition(page, url) {
  const loaded = new Promise((resolve) => { page.onLoad = resolve; });
  const nav = await page.s('Page.navigate', { url });
  if (nav.errorText) throw new Error(`Could not open the composition: ${nav.errorText}`);
  await withTimeout(loaded, 30000, 'Loading the composition');
  const ok = await evaluate(page, '!!window.__motion', 5000);
  if (!ok) throw new Error('The motion runtime did not load (is the file an HTML page?)');
  return evaluate(page, 'window.__motion.ready()', 60000);
}

async function capture(page, clip, ms = 60000) {
  const r = await withTimeout(page.s('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true, ...(clip ? { clip } : {}) }), ms, 'Capturing a frame');
  return Buffer.from(r.data, 'base64');
}

// ------------------------------------------------------------------ service

export class MotionService {
  constructor({ media, port, emitAll }) {
    this.media = media;
    this.emitAll = emitAll || (() => {});
    this.port = port;
    this.browser = new MotionBrowsers(port);
    this.queue = []; // render jobs waiting
    // The render stack: this.queue is its order (first in, first out: Claude's renders join at the back). The
    // editor can reorder it, or ask for one graphic "now": that pauses a running render (it keeps its progress
    // and waits at the front) until the urgent one is done. A paused job stays in `running` and in the queue.
    this.running = new Set(); // render jobs started (one at a time; one paused for an urgent one stays here too)
    this.order = 0;
    budget.motionRunning = () => [...this.running].filter((j) => !j.paused).length;
    // the budget changed (the machine is under pressure, or calm again): pages re-check what they may use
    budget.onChange(() => { for (const j of this.running) j.wake?.(); this.pump(); });
    // an export on the CPU and a graphic take turns: whoever asked first goes first
    budget.motionWaitingSince = () => this.queue.find((j) => !j.held)?.since ?? null;
    budget.onWork(() => this.pump());
    // what graphics wait with, for the scheduler: as many pages as the machine has room for while one renders
    budget.demand.motion = () => {
      const head = this.queue.find((j) => !j.held);
      const active = [...this.running].filter((j) => !j.paused);
      if (!head && !active.length) return null;
      return { want: Math.max(1, Math.floor((budget.capacity() * 4) / 3)), waitingSince: head?.since ?? null, rush: [head, ...active].some((j) => j?.rush) };
    };
    this.jobs = new Map(); // `${projectId}:${mediaId}` -> job (queued or running)
    this.timers = new Map();
    this.watchers = new Map();
    this.listings = new Map(); // folder -> { at, gen, files, byExt } (signature's walk, shared by every composition in it)
    this.listingGen = 0;
    this.textNames = new Map(); // css/js file -> { key, gen, names } (the file names it mentions)
  }

  // the server asked for any free port and now knows which one it got (before any browser starts)
  setPort(port) {
    this.port = port;
    for (const b of this.browser.list) b.port = port;
  }

  motionDir(handle) {
    return handle.layout.motion || path.join(handle.dir, 'motion');
  }
  rendersDir(handle) {
    return handle.layout.motionRenders || path.join(this.motionDir(handle), 'renders');
  }
  status(handle, mid) {
    return this.media.get(handle.id, mid)?.motion || null;
  }
  setStatus(handle, mid, patch) {
    const prev = this.media.get(handle.id, mid)?.motion || {};
    this.media.set(handle.id, mid, { motion: { ...prev, ...patch } });
    if (this.jobs.has(`${handle.id}:${mid}`) || 'state' in patch) this.stackChanged(!('state' in patch));
  }

  // ------------------------------------------------------------ render stack

  stack() {
    const row = (j, state) => {
      const item = j.handle.doc?.media.find((m) => m.id === j.mediaId);
      return {
        key: j.key, projectId: j.handle.id, mediaId: j.mediaId, state, rush: !!j.rush,
        name: item?.name || j.mediaId, project: j.handle.doc?.name || path.basename(j.handle.dir),
        progress: this.status(j.handle, j.mediaId)?.progress || 0,
      };
    };
    // nothing renders because an export on the CPU has its turn: the next one says so
    const since = budget.exportWaitingSince();
    const head = this.queue.find((j) => !j.held);
    const afterExport = budget.motionMayStart() === null && head && !head.rush && ![...this.running].some((j) => !j.paused) && (budget.cpuExportBusy() || (since != null && since < head.since));
    return [
      ...[...this.running].filter((j) => !j.paused).map((j) => row(j, 'rendering')),
      ...this.queue.map((j) => ({ ...row(j, j.held ? 'held' : j.paused ? 'paused' : 'queued'), ...(afterExport && j === head ? { afterExport: true } : {}) })),
    ];
  }
  // tell the editors (progress alone at most every 700 ms)
  stackChanged(progressOnly = false) {
    if (progressOnly) { if (this.stackTimer) return; this.stackTimer = setTimeout(() => { this.stackTimer = null; this.emitAll({ type: 'motion-stack', stack: this.stack() }); }, 700); return; }
    clearTimeout(this.stackTimer);
    this.stackTimer = null;
    this.emitAll({ type: 'motion-stack', stack: this.stack() });
  }
  // New order for the waiting renders (keys; any not listed keep their order after them).
  reorder(keys) {
    const pos = new Map(keys.map((k, i) => [k, i]));
    const at = (j) => (pos.has(j.key) ? pos.get(j.key) : keys.length + this.queue.indexOf(j));
    this.queue.sort((a, b) => at(a) - at(b));
    this.stackChanged();
    this.pump();
  }
  // "Render now" (the editor only): to the front, and a running render steps aside if there is no free slot.
  rush(key) {
    const job = this.jobs.get(key);
    if (!job || (this.running.has(job) && !job.paused)) return !!job;
    job.rush = true;
    job.held = false;
    this.queue = [job, ...this.queue.filter((j) => j !== job)];
    this.stackChanged();
    this.pump();
    return true;
  }

  // URL the editor/headless browser loads for a motion item (or an explicit config).
  pageUrl(handle, src, cfg) {
    return `/motion/${handle.id}/${toPosix(src).split('/').map(encodeURIComponent).join('/')}?cfg=${encodeCfg(cfg)}`;
  }

  async describe(handle, item) {
    const file = handle.resolve(item.motion?.src);
    let text = null;
    try { text = await fsp.readFile(file, 'utf8'); } catch { /* missing */ }
    const { config, error } = readConfigBlock(text || '');
    const mo = item.motion || {};
    const seq = handle.doc?.sequences[0];
    const spec = {
      width: Math.round(clamp(num(mo.width, num(config.width, seq?.width || 1920)), 16, 8192)),
      height: Math.round(clamp(num(mo.height, num(config.height, seq?.height || 1080)), 16, 8192)),
      fps: clamp(num(mo.fps, num(config.fps, seq?.fps || 30)), 1, 120),
      duration: clamp(num(mo.duration, num(config.duration, 5)), 1 / 30, 600),
    };
    spec.width = Math.round(spec.width / 2) * 2;
    spec.height = Math.round(spec.height / 2) * 2;
    return { file, text, config, configError: error, schema: paramSchema(config), params: mergedParams(config, mo.params), spec, edit: mo.edit || null, missing: text == null };
  }

  // Hash of everything that changes the rendered pixels: the page, its params and format, and the local
  // files it references (directly, or from a referenced .css/.js) — not every file that happens to sit
  // next to it, so editing one composition doesn't re-render the others in the same folder.
  async signature(d) {
    const parts = [d.text, JSON.stringify(d.params), JSON.stringify(d.spec), ...(d.edit ? [JSON.stringify(d.edit)] : []), RUNTIME_VERSION, 'v1'];
    const dir = path.dirname(d.file);
    const listing = await this.listing(dir);
    const files = listing.files.filter((f) => f !== d.file);
    // the names the texts read so far mention (a file counts when any of them names it)
    const named = new Set();
    const read = (names) => { for (const b of names) named.add(b); };
    read(mentionedNames(d.text, listing.byExt));
    read(mentionedNames(JSON.stringify(d.params), listing.byExt));
    const refs = new Set();
    for (let pass = 0; pass < 2; pass++) {
      for (const f of files) {
        if (refs.has(f) || !named.has(path.basename(f))) continue;
        refs.add(f);
        if (/\.(css|m?js)$/i.test(f)) read(await this.namesIn(f, listing));
      }
    }
    for (const f of [...refs].sort()) {
      try { const st = await fsp.stat(f); parts.push(`${path.relative(dir, f)}|${st.size}|${st.mtimeMs}`); } catch { /* gone */ }
    }
    return sha1(parts.join('\n')).slice(0, 12);
  }

  // The asset files under a composition's folder (two levels down, renders and hidden folders left out),
  // walked once and shared by every composition there until the folder changes.
  async listing(dir) {
    const c = this.listings.get(dir);
    if (c && Date.now() - c.at < LISTING_MS) return c.ready;
    const files = [];
    const walk = async (p, depth) => {
      let ents = [];
      try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name === 'renders' || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const f = path.join(p, e.name);
        if (e.isDirectory()) { if (depth < 2 && files.length < 2000) await walk(f, depth + 1); }
        else if (ASSET_EXT.test(e.name)) files.push(f);
      }
    };
    const entry = { at: Date.now(), gen: ++this.listingGen };
    entry.ready = walk(dir, 0).then(() => Object.assign(entry, { files, byExt: nameIndex(files) }));
    this.listings.set(dir, entry);
    return entry.ready;
  }
  // a file in the folder changed: the next signature walks it again
  forgetListing(dir) {
    for (const k of this.listings.keys()) if (k === dir || k.startsWith(dir + path.sep) || dir.startsWith(k + path.sep)) this.listings.delete(k);
  }
  // the file names a css/js file mentions, read again only when the file or the folder's listing changed
  async namesIn(f, listing) {
    let st = null;
    try { st = await fsp.stat(f); } catch { return new Set(); }
    const key = `${st.size}|${st.mtimeMs}`;
    const c = this.textNames.get(f);
    if (c && c.key === key && c.gen === listing.gen) return c.names;
    let text = '';
    try { text = await fsp.readFile(f, 'utf8'); } catch { return new Set(); }
    const names = mentionedNames(text, listing.byExt);
    this.textNames.set(f, { key, gen: listing.gen, names });
    if (this.textNames.size > 500) this.textNames.delete(this.textNames.keys().next().value);
    return names;
  }

  renderFile(handle, item, sig) {
    const base = path.basename(item.motion.src, path.extname(item.motion.src)).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'motion';
    return path.join(this.rendersDir(handle), `${base}-${item.id.replace(/^m_/, '')}-${sig}.mov`);
  }

  // Called after every project change: re-render motion items whose source, params or format changed.
  check(handle) {
    if (!handle.doc?.media.some((m) => m.motion)) return;
    this.watch(handle);
    clearTimeout(this.timers.get(handle.id));
    this.timers.set(handle.id, setTimeout(() => this.checkNow(handle).catch((e) => console.warn('[motion] check:', e.message)), 250));
  }

  async checkNow(handle, { force = [] } = {}) {
    const patches = {};
    for (const item of handle.doc?.media || []) {
      if (!item.motion?.src) continue;
      const d = await this.describe(handle, item);
      if (d.missing) {
        this.setStatus(handle, item.id, { state: 'error', error: `Composition file not found: ${item.motion.src}`, schema: [], progress: 0 });
        continue;
      }
      const sig = await this.signature(d);
      const file = this.renderFile(handle, item, sig);
      const rel = handle.relativize(file);
      const st = this.status(handle, item.id);
      if (!st?.schema || st.sig !== sig) this.setStatus(handle, item.id, { schema: d.schema, params: d.params, spec: d.spec, configError: d.configError, src: item.motion.src });
      const forced = force.includes(item.id);
      // rendered by an earlier version into the app's data folder: move it into the project instead of rendering again
      const legacy = handle.layout.legacy?.motionRenders;
      if (!forced && legacy) await moveFile(path.join(legacy, path.basename(file)), file).catch((e) => console.warn('[motion] move render:', e.message));
      if (!forced && (await exists(file))) {
        // cached render: point the item at it
        if (item.path !== rel) patches[item.id] = { path: rel, ...metaFor(d.spec) };
        const job = this.jobs.get(`${handle.id}:${item.id}`);
        if (job && job.sig !== sig) this.cancelJob(job);
        if (st?.state !== 'ready' || st.sig !== sig) this.setStatus(handle, item.id, { state: 'ready', progress: 1, error: null, sig, logs: st?.sig === sig ? st.logs : [] });
        continue;
      }
      const job = this.jobs.get(`${handle.id}:${item.id}`);
      if (job && job.sig === sig && !forced) continue; // already on it
      const at = !job ? -1 : this.running.has(job) && !job.paused ? 0 : this.queue.indexOf(job);
      if (job) this.cancelJob(job);
      this.enqueue(handle, item, d, sig, file, { at, rush: job?.rush, held: job?.held, since: job?.since });
    }
    const ids = Object.keys(patches);
    if (ids.length) await handle.mutate((doc) => { for (const m of doc.media) if (patches[m.id]) Object.assign(m, patches[m.id]); }, 'server');
  }

  // at: place in the stack (a render redone after an edit keeps the place of the one it replaces)
  enqueue(handle, item, d, sig, file, { at = -1, rush = false, held = false, since = Date.now() } = {}) {
    let resolveDone;
    const job = { key: `${handle.id}:${item.id}`, handle, mediaId: item.id, sig, file, d, canceled: false, rush: !!rush, held: !!held, since, done: new Promise((r) => { resolveDone = r; }) };
    job.resolveDone = resolveDone;
    this.jobs.set(job.key, job);
    if (at >= 0) this.queue.splice(Math.min(at, this.queue.length), 0, job); else this.queue.push(job);
    this.setStatus(handle, item.id, { state: 'queued', progress: 0, error: null, sig, paused: !!held, held: !!held });
    this.pump();
    return job;
  }
  // The project was closed: its graphics stop rendering and leave the stack (opened again, they are checked anew).
  stopProject(projectId) {
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
    for (const job of [...this.jobs.values()]) if (job.handle.id === projectId) this.cancelJob(job);
  }
  cancelJob(job) {
    job.canceled = true;
    this.queue = this.queue.filter((j) => j !== job);
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    this.stackChanged();
    job.encoder?.kill('SIGKILL');
    job.wake?.();
    job.abort?.();
    job.resolveDone({ canceled: true });
  }

  // What a waiting item is waiting for (shown by `vedit motion render` and the editor).
  queueInfo(handle, mediaId) {
    const job = this.jobs.get(`${handle.id}:${mediaId}`);
    const cur = [...this.running].find((j) => !j.paused);
    if (!job || !cur || this.running.has(job)) return null;
    const item = cur.handle.doc?.media.find((m) => m.id === cur.mediaId);
    return {
      position: this.queue.indexOf(job) + 1,
      current: { name: item?.name || cur.mediaId, project: cur.handle.doc?.name || path.basename(cur.handle.dir), progress: this.status(cur.handle, cur.mediaId)?.progress || 0 },
    };
  }

  // Pause by hand (the editor): a running render stops where it is and waits in its place; a waiting one is
  // skipped. Either keeps its progress and goes on when resumed.
  hold(key, on) {
    const job = this.jobs.get(key);
    if (!job) return false;
    job.held = !!on;
    if (on) {
      if (this.running.has(job) && !job.paused) {
        job.paused = true;
        this.queue.unshift(job);
        job.wake?.();
      }
      this.setStatus(job.handle, job.mediaId, { state: 'queued', paused: true, held: true });
    } else this.setStatus(job.handle, job.mediaId, { held: false, paused: !!job.paused });
    this.pump();
    budget.workChanged();
    return true;
  }

  // Pause or resume the whole stack (waiting ones first, so nothing starts in between).
  holdAll(on) {
    const jobs = [...this.jobs.values()].filter((j) => !j.held !== !on);
    jobs.sort((a, b) => (this.running.has(a) && !a.paused) - (this.running.has(b) && !b.paused) || this.queue.indexOf(a) - this.queue.indexOf(b));
    for (const j of jobs) this.hold(j.key, on);
    return jobs.length;
  }

  pump() {
    const active = () => [...this.running].filter((j) => !j.paused);
    for (;;) {
      const at = this.queue.findIndex((j) => !j.held); // paused by hand: skipped until resumed
      const next = this.queue[at];
      if (!next) break;
      // while an urgent render runs, nothing else starts or resumes: it gets the machine to itself
      if (!next.rush && active().some((j) => j.rush)) break;
      // an export on the CPU has the machine, or asked for it first: wait for it (an urgent render doesn't, the
      // export pauses for it)
      const exportSince = budget.exportWaitingSince();
      const may = budget.motionMayStart(); // smart scheduling: graphics outrank exports (null: classic turn-taking)
      if (may === false && !next.rush) break;
      if (may === null && !next.rush && (budget.cpuExportBusy() || (exportSince != null && exportSince < next.since))) break;
      if (active().length >= budget.motionJobs()) {
        // an urgent render waits: the newest running one that isn't urgent pauses and waits right behind it
        const victim = next.rush ? active().filter((j) => !j.rush).pop() : null;
        if (!victim) break;
        victim.paused = true;
        this.queue.splice(at + 1, 0, victim);
        this.setStatus(victim.handle, victim.mediaId, { state: 'queued', paused: true });
        victim.wake?.();
      }
      this.queue.splice(at, 1);
      if (next.paused) { next.paused = false; this.setStatus(next.handle, next.mediaId, { state: 'rendering', paused: false, held: false }); next.wake?.(); } else this.runJob(next);
      budget.workChanged();
    }
    this.stackChanged();
  }

  async runJob(job) {
    this.running.add(job);
    const t0 = Date.now();
    perflog.event('motionStart', { item: job.mediaId, rush: !!job.rush });
    try {
      await this.render(job);
      perflog.event('motionDone', { item: job.mediaId, secs: Math.round((Date.now() - t0) / 1000), canceled: !!job.canceled });
    } catch (err) {
      perflog.event('motionDone', { item: job.mediaId, secs: Math.round((Date.now() - t0) / 1000), error: err.message });
      if (!job.canceled) {
        console.warn('[motion] render failed:', err.message);
        if (job.rush) this.emitAll({ type: 'motion-ready', projectId: job.handle.id, mediaId: job.mediaId, error: err.message });
        this.setStatus(job.handle, job.mediaId, { state: 'error', error: err.message, progress: 0, logs: job.logs || [] });
      }
    } finally {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      job.resolveDone({ canceled: job.canceled });
      this.running.delete(job);
      setImmediate(() => this.pump());
      budget.workChanged();
    }
  }

  // Wait until the motion items a sequence uses are rendered (exports call this first).
  async settle(handle, mediaIds) {
    await this.checkNow(handle).catch(() => {});
    for (let waited = false; ; waited = true) {
      // a render that was superseded while we waited (the composition was edited) has a successor: wait for that too
      const waits = mediaIds.map((id) => this.jobs.get(`${handle.id}:${id}`)?.done).filter(Boolean);
      if (!waits.length) return waited;
      await Promise.all(waits);
    }
  }

  async render(job) {
    const { handle, d } = job;
    const { width, height, fps, duration } = d.spec;
    const frames = Math.max(1, Math.round(duration * fps));
    await fsp.mkdir(path.dirname(job.file), { recursive: true });
    this.setStatus(handle, job.mediaId, { state: 'rendering', progress: 0, error: null });
    const t0 = Date.now();

    // master + preview proxy from the same frames, in one ffmpeg run
    const tmpMaster = job.file.replace(/\.mov$/, '.part.mov');
    const tmpProxy = path.join(tempRoot(), `claude-edit-motion-${process.pid}-${Date.now()}.webm`);
    // unfinished files left by a render of this item that was stopped (server closed, crash)
    const tag = `-${job.mediaId.replace(/^m_/, '')}-`;
    for (const n of await fsp.readdir(path.dirname(job.file)).catch(() => [])) {
      if (n.includes(tag) && n.endsWith('.part.mov')) await fsp.unlink(path.join(path.dirname(job.file), n)).catch(() => {});
    }
    const gop = Math.max(1, Math.round(fps / 3));
    const threads = Math.max(1, Math.floor(perf().threads / Math.max(1, this.running.size))); // shared with renders alongside
    const args = withThreads([
      '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0',
      // ProRes 4444 at about the size After Effects writes: quantiser 4 and 8-bit alpha (ffmpeg's defaults spent
      // twice the bits, 16-bit alpha, for no visible difference; 49–63 dB to them on real renders)
      '-map', '0:v', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '8', '-q:v', '4', '-vendor', 'apl0', '-threads', String(threads), '-f', 'mov', tmpMaster,
      '-map', '0:v', '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuva420p",
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
      '-g', String(gop), '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', '-f', 'webm', tmpProxy,
    ], threads);
    const enc = spawn(FFMPEG, args, { windowsHide: true });
    lowerPriority(enc);
    job.encoder = enc;
    let encErr = '';
    enc.stderr.on('data', (x) => { encErr = (encErr + x).slice(-4000); });
    enc.stdin.on('error', () => {});
    let encClosed = false;
    const encExit = new Promise((resolve) => {
      enc.on('close', (code) => { encClosed = true; resolve(code); });
      enc.on('error', (err) => { encClosed = true; encErr += `\n${err.message}`; resolve(-1); }); // ffmpeg could not be started
    });
    // resolves when ffmpeg has taken the frame, or is gone (killed by a cancel, or failed): a write to a dead
    // encoder never drains, and waiting for it would hold the whole render queue
    const write = (buf) => new Promise((resolve) => {
      if (encClosed || enc.stdin.destroyed || enc.stdin.write(buf)) { resolve(); return; }
      const done = () => { enc.stdin.off('drain', done); enc.off('close', done); resolve(); };
      enc.stdin.once('drain', done);
      enc.once('close', done);
    });

    // Several pages render one-second blocks (each takes the next block free); frames are written to ffmpeg in
    // order. How many pages work at once follows the budget: under pressure the extra pages stop and close
    // (freeing their memory), and open again once the machine is calm. One page always keeps going (unless paused).
    const pageCount = clamp(Math.round(perf().threads / 3), 1, Math.min(MAX_BROWSERS, Math.ceil(frames / Math.max(1, Math.round(fps)))));
    const block = Math.max(1, Math.round(fps));
    const blocks = Math.ceil(frames / block);
    const url = `http://127.0.0.1:${this.port}${this.pageUrl(handle, job.handle.relativize(d.file), { mode: 'render', params: d.params, ...d.spec, edit: d.edit })}`;
    const results = new Map(); // frame -> png
    let nextOut = 0;
    let written = 0;
    let waiters = [];
    const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
    job.wake = wake;
    // a page that hangs (a composition that never finishes loading, a capture that never returns) must not hold the
    // render forever: a stall or a cancel lets go of it at once (one graphic renders at a time, the rest wait on it)
    let abort;
    const aborted = new Promise((r) => { abort = r; });
    job.abort = abort;
    const pages = new Set();
    let nextBlock = 0;
    const allowed = () => (job.paused ? 0 : Math.min(pageCount, budget.motionPages()));
    const closePage = async (p) => {
      if (!pages.delete(p)) return;
      job.logs.push(...p.logs);
      await withTimeout(this.browser.closePage(p), 10000, 'Closing a page').catch(() => {});
    };
    const timing = { load: 0, seek: 0, capture: 0, write: 0 };
    job.logs = [];
    let failure = null;
    // ffmpeg stopping before the last frame ends the render with its error instead of leaving it waiting
    enc.on('close', () => {
      if (!job.canceled && nextOut < frames) failure = failure || new Error(`Encoding stopped early: ${encErr.trim().split('\n').slice(-2).join(' | ') || 'ffmpeg exited'}`);
      wake();
    });
    // nothing captured or written for two minutes: give up with a clear error rather than sit in the queue
    let lastStep = Date.now();
    // (also when a page already failed: another page may be the one that hangs)
    const watchdog = setInterval(() => {
      if (job.paused) lastStep = Date.now(); // stepped aside for an urgent render: not stuck
      if (Date.now() - lastStep < STALL_MS || job.canceled) return;
      failure = failure || new Error(`The render stopped making progress at frame ${nextOut} of ${frames} and was stopped. Run it again; if it repeats, check the composition for something that never finishes loading.`);
      // a page that froze takes its browser with it: those start afresh for the next render
      for (const p of pages) p.owner.kill();
      enc.kill('SIGKILL');
      wake();
      abort();
    }, 5000);
    // A page works on one range of frames at a time: a range handed back by a page that stopped part-way, else
    // the next block. While more pages work than the budget allows (or the render is paused), a page stops
    // between two frames, hands the rest of its range back and closes; it starts again once there is room.
    const pending = []; // [from, to) frame ranges handed back
    const more = () => pending.length > 0 || nextBlock < blocks;
    let working = 0;
    const worker = async () => {
      let page = null;
      try {
        for (;;) {
          if (job.canceled || failure || !more()) return;
          if (working >= allowed()) {
            if (page) { const p = page; page = null; await closePage(p); }
            await new Promise((r) => { waiters.push(r); setTimeout(r, 1000); });
            continue;
          }
          let range = pending.shift();
          if (!range) {
            const b = nextBlock++;
            if (b >= blocks) return;
            range = [b * block, Math.min(frames, (b + 1) * block)];
          }
          working++;
          try {
            if (!page) {
              const to = Date.now();
              page = await this.browser.openPage(width, height);
              timing.open = Math.max(timing.open || 0, Date.now() - to);
              pages.add(page);
              const tl = Date.now();
              await loadComposition(page, url);
              timing.load += Date.now() - tl;
            }
            for (let f = range[0]; f < range[1]; f++) {
              // don't race too far ahead of the writer (bounds memory)
              while (f - nextOut > block * (pageCount + 1) && !job.canceled && !failure) await new Promise((r) => waiters.push(r));
              if (job.canceled || failure) return;
              if (working > allowed()) { // over the budget, or paused: the rest goes back for later
                pending.push([f, range[1]]);
                pending.sort((a, b) => a[0] - b[0]);
                break;
              }
              // you are playing or scrubbing: wait here (pages and progress kept), unless it was asked for "now"
              while (budget.motionHeld() && !job.rush && !job.canceled && !failure) {
                lastStep = Date.now();
                await new Promise((r) => { waiters.push(r); setTimeout(r, 250); });
              }
              if (job.canceled || failure) return;
              let tp = Date.now();
              await evaluate(page, `window.__motion.seek(${f / fps})`);
              timing.seek += Date.now() - tp; tp = Date.now();
              // a screenshot that never comes back (seen with pages full of video) is asked for again
              let png = null;
              for (let attempt = 0; !png; attempt++) {
                try { png = await capture(page, null, 20000); } catch (err) {
                  if (attempt >= 2 || job.canceled || failure) throw err;
                  timing.retries = (timing.retries || 0) + 1;
                  await evaluate(page, `window.__motion.seek(${f / fps})`);
                }
              }
              results.set(f, png);
              timing.capture += Date.now() - tp;
              lastStep = Date.now();
              wake();
            }
          } finally {
            working--;
            wake();
          }
        }
      } catch (err) {
        // a page that stopped answering froze its browser: that one starts afresh for the next render
        if (page && /stopped answering|timed out/.test(err.message)) page.owner.kill();
        throw err;
      } finally {
        if (page) await closePage(page);
      }
    };
    const writer = async () => {
      while (nextOut < frames && !job.canceled && !failure) {
        if (!results.has(nextOut)) { await new Promise((r) => waiters.push(r)); continue; }
        const buf = results.get(nextOut);
        results.delete(nextOut);
        const tw = Date.now();
        await write(buf);
        timing.write += Date.now() - tw;
        nextOut++;
        written++;
        lastStep = Date.now();
        wake();
        if (written % 10 === 0 || written === frames) this.setStatus(handle, job.mediaId, { state: job.paused ? 'queued' : 'rendering', progress: Math.min(0.99, written / frames) });
      }
    };
    try {
      await Promise.race([
        Promise.all([
          // one page failing ends the render now, without waiting for the other pages (one may hang)
          ...Array.from({ length: pageCount }, () => worker().catch((err) => { failure = failure || err; wake(); abort(); })),
          writer(),
        ]),
        aborted,
      ]);
    } finally {
      clearInterval(watchdog);
      job.wake = null;
      job.abort = null;
      await Promise.all([...pages].map(closePage));
    }
    enc.stdin.end();
    const tf = Date.now();
    const code = await encExit;
    timing.flush = Date.now() - tf;
    if (job.canceled) { fsp.unlink(tmpMaster).catch(() => {}); fsp.unlink(tmpProxy).catch(() => {}); return; }
    if (failure) { fsp.unlink(tmpMaster).catch(() => {}); fsp.unlink(tmpProxy).catch(() => {}); throw failure; }
    if (code !== 0) {
      fsp.unlink(tmpMaster).catch(() => {});
      fsp.unlink(tmpProxy).catch(() => {});
      throw new Error(`Encoding failed: ${encErr.trim().split('\n').slice(-2).join(' | ')}`);
    }

    await fsp.rename(tmpMaster, job.file);
    // drop the proxy straight into the media cache, keyed like MediaService keys the master
    try {
      const st = await fsp.stat(job.file);
      const key = sha1(`${job.file}|${st.size}|${st.mtimeMs}`).slice(0, 16);
      await fsp.mkdir(this.media.cacheDir(handle), { recursive: true });
      await fsp.copyFile(tmpProxy, this.media.cacheFile(handle, key, 'proxy.webm'));
    } catch (err) { console.warn('[motion] proxy:', err.message); }
    fsp.unlink(tmpProxy).catch(() => {});

    const logs = [...new Set(job.logs)].slice(0, 20);
    this.setStatus(handle, job.mediaId, { state: 'ready', progress: 1, error: null, sig: job.sig, logs, renderMs: Date.now() - t0 });
    if (job.rush) this.emitAll({ type: 'motion-ready', projectId: handle.id, mediaId: job.mediaId }); // asked for "now": tell the editor
    const rel = handle.relativize(job.file);
    await handle.mutate((doc) => { const m = doc.media.find((x) => x.id === job.mediaId); if (m) Object.assign(m, { path: rel, ...metaFor(d.spec) }); }, 'server');
    this.cleanup(handle, job.mediaId, job.file).catch(() => {});
    console.log(`[motion] rendered ${path.basename(job.file)}: ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s (${pageCount} page${pageCount > 1 ? 's' : ''}; ms load ${timing.load} seek ${timing.seek} capture ${timing.capture} encoder-wait ${timing.write} open ${timing.open} flush ${timing.flush}${timing.retries ? ` capture-retries ${timing.retries}` : ''})`);
  }

  // Keep the current render of an item and the one before it (so undoing the last change is instant), delete older ones.
  async cleanup(handle, mediaId, keep) {
    const dir = this.rendersDir(handle);
    const tag = `-${mediaId.replace(/^m_/, '')}-`;
    const files = [];
    for (const n of await fsp.readdir(dir).catch(() => [])) {
      if (!n.includes(tag) || !/-[0-9a-f]{12}\.mov$/.test(n)) continue; // only Jimmy's renders (the folder may be shared)
      const f = path.join(dir, n);
      const st = await fsp.stat(f).catch(() => null);
      if (st) files.push({ f, t: st.mtimeMs });
    }
    files.sort((a, b) => b.t - a.t);
    const used = new Set((handle.doc?.media || []).map((m) => handle.resolve(m.path)));
    for (const { f } of files.slice(2)) if (f !== keep && !used.has(f)) await fsp.unlink(f).catch(() => {});
  }

  // Render single frames to PNG (transparent) — for Claude to look at a composition.
  async frames(handle, item, times, outDir, opts = {}) {
    const d = await this.describe(handle, item);
    if (d.missing) throw new Error(`Composition file not found: ${item.motion.src}`);
    if (opts.params) d.params = { ...d.params, ...opts.params };
    const fit = num(opts.maxSide, 0) > 0 ? opts.maxSide / Math.max(d.spec.width, d.spec.height) : 1;
    const scale = clamp(num(opts.scale, fit), 0.1, 1);
    const page = await this.browser.openPage(d.spec.width, d.spec.height);
    const out = [];
    try {
      await loadComposition(page, `http://127.0.0.1:${this.port}${this.pageUrl(handle, handle.relativize(d.file), { mode: 'render', params: d.params, ...d.spec, edit: d.edit })}`);
      await fsp.mkdir(outDir, { recursive: true });
      for (const t of times) {
        const tt = clamp(num(t, 0), 0, d.spec.duration);
        await evaluate(page, `window.__motion.seek(${tt})`);
        const png = await capture(page, scale < 1 ? { x: 0, y: 0, width: d.spec.width, height: d.spec.height, scale } : null);
        const file = path.join(outDir, `motion-${item.id}-${tt.toFixed(2)}s${opts.maxSide ? '' : '.full'}.png`);
        await fsp.writeFile(file, png);
        out.push({ t: tt, path: file });
      }
      const errs = await evaluate(page, 'window.__motion.errors()', 5000).catch(() => []);
      return { frames: out, logs: [...new Set([...page.logs, ...(errs || [])])].slice(0, 20), spec: d.spec, params: d.params };
    } finally {
      await this.browser.closePage(page);
    }
  }

  // Re-check when files in the motion folder change (Claude or the user editing the HTML/CSS/assets).
  watch(handle) {
    // called on every check: folders and files are added as items appear (a composition made later, a new folder)
    let entry = this.watchers.get(handle.id);
    if (!entry) this.watchers.set(handle.id, entry = { dirs: new Map(), rootFiles: new Set() });
    const dirs = new Set([this.motionDir(handle)]);
    for (const m of handle.doc?.media || []) if (m.motion?.src) dirs.add(path.dirname(handle.resolve(m.motion.src)));
    for (const d of dirs) {
      if (entry.dirs.has(d) || !fs.existsSync(d) || path.resolve(d) === path.resolve(handle.dir)) continue;
      try {
        let real = d;
        try { real = fs.realpathSync.native(d); } catch { /* keep */ }
        const w = fs.watch(real, { persistent: false, recursive: true }, (_e, name) => {
          if (!name || String(name).split(/[\\/]/)[0] === 'renders' || !ASSET_EXT.test(String(name))) return;
          this.forgetListing(d);
          this.check(handle);
        });
        w.on('error', () => {});
        entry.dirs.set(d, w);
      } catch { /* not watchable */ }
    }
    // the composition may also sit directly in the project root: poll those few files
    const rootFiles = (handle.doc?.media || []).filter((m) => m.motion?.src && path.resolve(path.dirname(handle.resolve(m.motion.src))) === path.resolve(handle.dir)).map((m) => handle.resolve(m.motion.src));
    for (const f of rootFiles) {
      if (entry.rootFiles.has(f)) continue;
      fs.watchFile(f, { interval: 1500, persistent: false }, () => this.check(handle));
      entry.rootFiles.add(f);
    }
  }
  unwatch(handle) {
    const w = this.watchers.get(handle.id);
    if (!w) return;
    for (const x of w.dirs.values()) x.close();
    for (const f of w.rootFiles) fs.unwatchFile(f);
    this.watchers.delete(handle.id);
  }

  // ---------------------------------------------------------------- creating items

  // Copy a composition from outside the project into its motion folder (the folder's assets come along
  // when the file sits in its own folder).
  async adopt(handle, src) {
    const abs = path.resolve(handle.dir, String(src || ''));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) throw Object.assign(new Error(`File not found: ${abs}`), { status: 404 });
    if (!/\.html?$/i.test(abs)) throw Object.assign(new Error('A motion graphic must be an .html file'), { status: 400 });
    if (safeJoin(handle.dir, path.relative(handle.dir, abs))) return abs; // already inside the project
    const dir = this.motionDir(handle);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, uniqueFileName(dir, path.basename(abs)));
    await fsp.copyFile(abs, dest);
    // the local files it loads come along (same relative paths), so the copy renders and stays editable
    // after the original folder (often a temp folder) is gone; files already in the project are kept
    for (const ref of localRefs(await fsp.readFile(abs, 'utf8'))) {
      const from = path.join(path.dirname(abs), ref), to = path.join(dir, ref);
      if (!(await fsp.stat(from).catch(() => null))?.isFile() || fs.existsSync(to)) continue;
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to).catch(() => {});
    }
    return dest;
  }

  async starter(handle, name) {
    const dir = this.motionDir(handle);
    await fsp.mkdir(dir, { recursive: true });
    const base = String(name || 'Motion').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Motion';
    const dest = path.join(dir, uniqueFileName(dir, `${base}.html`));
    await fsp.copyFile(STARTER_FILE, dest);
    return dest;
  }

  async newItem(handle, { src, name, params, duration, width, height, fps, folder }) {
    const abs = await this.adopt(handle, src);
    const rel = handle.relativize(abs);
    const { config } = readConfigBlock(await fsp.readFile(abs, 'utf8'));
    const seq = handle.doc?.sequences[0];
    const motion = { src: rel };
    if (params && typeof params === 'object' && Object.keys(params).length) motion.params = params;
    const spec = {
      duration: num(duration, num(config.duration, 5)),
      width: num(width, num(config.width, seq?.width || 1920)),
      height: num(height, num(config.height, seq?.height || 1080)),
      fps: num(fps, num(config.fps, seq?.fps || 30)),
    };
    Object.assign(motion, spec);
    const id = uid('m');
    const item = {
      id, name: name || config.name || path.basename(abs, path.extname(abs)), folder: folder || null, motion,
      path: handle.relativize(path.join(this.rendersDir(handle), `${path.basename(abs, path.extname(abs))}-pending.mov`)),
      ...metaFor(spec),
    };
    return item;
  }

  shutdown() {
    for (const j of [...this.jobs.values()]) this.cancelJob(j);
    this.browser.kill(true);
  }
}

// Relative local files a page refers to: src/href/poster attributes, CSS url(), JS imports and fetches.
// URLs, data: and absolute paths are skipped, and so is anything outside the page's folder (..).
function localRefs(html) {
  const out = new Set();
  const re = /(?:\b(?:src|href|poster)\s*=\s*["']|url\(\s*["']?|\bfrom\s*["']|\bimport\s*\(\s*["']|\bfetch\s*\(\s*["'])([^"')\s]+)/gi;
  for (const m of html.matchAll(re)) {
    let ref; try { ref = decodeURI(m[1].split(/[?#]/)[0] || ''); } catch { continue; }
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(ref)) continue;
    const norm = path.normalize(ref);
    if (norm.startsWith('..') || path.isAbsolute(norm)) continue;
    out.add(norm);
  }
  return [...out];
}

function metaFor(spec) {
  return { type: 'video', duration: spec.duration, width: spec.width, height: spec.height, fps: spec.fps, hasAudio: false, hasVideo: true };
}

export function runtimeFile() { return RUNTIME_FILE; }
