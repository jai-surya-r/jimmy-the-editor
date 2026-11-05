import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { perflog } from './perflog.js';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Settings, chat names, per-project state. The desktop app keeps them in its user-data folder (JIMMY_DATA_DIR,
// set by electron/main.js); the browser version in data/ next to the app.
export const DATA_DIR = process.env.JIMMY_DATA_DIR ? path.resolve(process.env.JIMMY_DATA_DIR) : path.join(APP_DIR, 'data');

// For Claude sessions: how the editor's own scripts (vedit, the image-check hook) get a Node to run on. Inside the
// desktop app process.execPath is the app itself, which runs a script as plain Node with ELECTRON_RUN_AS_NODE;
// vedit's launchers use JIMMY_NODE when it's set, so no separate Node install is needed.
export const scriptEnv = () => (process.versions.electron ? { JIMMY_NODE: process.execPath, ELECTRON_RUN_AS_NODE: '1' } : {});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// Stable id for a project folder.
// Stable id for a project folder (same function is used by the CLI).
export function projectIdFor(dir) {
  const norm = path.resolve(dir).replace(/[\\/]+$/, '');
  return sha1(process.platform === 'win32' ? norm.toLowerCase() : norm).slice(0, 12);
}

export const toPosix = (p) => p.split(path.sep).join('/');

// Write via temp file + rename so readers (and Claude) never see a half-written file.
export async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  perflog.io('saveW', Buffer.byteLength(data));
  await fsp.writeFile(tmp, data);
  for (let i = 0; i < 8; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || i === 7) {
        // last resort: write in place
        try { await fsp.writeFile(file, data); } finally { fsp.unlink(tmp).catch(() => {}); }
        return;
      }
      await sleep(40 * (i + 1));
    }
  }
}

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
// For code that can't wait (building a render's audio): the answer for a file is kept for 30 s, so an export
// of many chunks asks the project's drive once per file, not once per chunk.
const seen = new Map(); // file -> { at, ok }
export function existsRecently(file) {
  const hit = seen.get(file);
  if (hit && Date.now() - hit.at < 30000) return hit.ok;
  const ok = fs.existsSync(file);
  if (seen.size > 5000) seen.clear();
  seen.set(file, { at: Date.now(), ok });
  return ok;
}

export function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// The same without holding up the server: for files on a project's drive, which may be a busy NAS.
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

export function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
export function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

export function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream',
};
export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// Small files asked for again and again (thumbnails, waveforms, posters, fonts, a graphic's images) kept in
// memory, so the disk or the NAS they live on isn't read each time. Checked against the file's size and date on
// every request, so an edited file is read again. Least recently used goes first past the cap.
const RAM_MAX_FILE = 4 * 1024 * 1024;
const RAM_MAX_TOTAL = 256 * 1024 * 1024;
const ramFiles = new Map(); // file -> { size, mtimeMs, buf }
let ramBytes = 0;
async function fromRam(file, st) {
  const hit = ramFiles.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    ramFiles.delete(file); ramFiles.set(file, hit); // most recently used
    return hit.buf;
  }
  if (hit) { ramFiles.delete(file); ramBytes -= hit.size; }
  const buf = await fsp.readFile(file);
  if (buf.length !== st.size) return buf; // changed while read: send it, don't keep it
  perflog.io('servedR', buf.length);
  ramFiles.set(file, { size: st.size, mtimeMs: st.mtimeMs, buf });
  ramBytes += buf.length;
  for (const [k, v] of ramFiles) {
    if (ramBytes <= RAM_MAX_TOTAL) break;
    ramFiles.delete(k); ramBytes -= v.size;
  }
  return buf;
}

// Static / media file response with HTTP Range support (needed for <video> seeking).
export async function serveFile(req, res, file, { cache = false, type, ram = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); res.end('Not found'); return; }
  if (!st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
  let buf = null;
  if (ram && st.size <= RAM_MAX_FILE) {
    try { buf = await fromRam(file, st); } catch { res.writeHead(404); res.end('Not found'); return; }
  }
  const size = buf ? buf.length : st.size;
  const headers = {
    'Content-Type': type || mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    if (start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    if (buf) res.end(buf.subarray(start, end + 1)); else pipeFile(res, file, { start, end });
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  if (buf) res.end(buf); else pipeFile(res, file);
}
// Send a file's bytes. The file is closed when the client goes away mid-transfer (a <video> drops its
// request on every seek), not only when it has been read to the end.
function pipeFile(res, file, range) {
  const stream = fs.createReadStream(file, range);
  stream.on('error', () => res.destroy());
  res.on('close', () => { perflog.io('servedR', stream.bytesRead); stream.destroy(); });
  stream.pipe(res);
}

// Write a request body to a file. A cancelled or failed upload leaves no partial file behind.
export async function saveUpload(req, file) {
  try { await pipeline(req, fs.createWriteStream(file)); } catch (err) {
    await fsp.unlink(file).catch(() => {});
    throw err;
  }
}

// Keep a path inside a root folder (prevents ../ escapes).
export function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  const r = path.resolve(root);
  if (p !== r && !p.startsWith(r + path.sep)) return null;
  return p;
}

export function uniqueFileName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'file';
  let candidate = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

export function sanitizeFolderName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Untitled';
}
