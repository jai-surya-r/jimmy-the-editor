// Disk usage of things the app can safely throw away: media caches (thumbnails, waveforms, proxies,
// review proxies), Claude chat attachments, old draft exports, and app-level caches. Used by Settings ›
// Storage. Deleting projects and IP kits sends the folder to the Recycle Bin where the OS has one.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, readJsonSafe } from './util.js';
import { layoutFor, defaultLayout } from './layout.js';
import { tempRoot, systemTemp } from './cachedir.js';
import { chunksRoot } from './chunks.js';

export async function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = async (d) => {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { const st = await fsp.stat(p).catch(() => null); if (st) { bytes += st.size; files++; } }
    }
  };
  await walk(dir);
  return { bytes, files };
}

// Send a folder or file to the Recycle Bin (Windows) / Trash (macOS); elsewhere delete it.
export function trashPath(target) {
  if (!fs.existsSync(target)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err) => (err ? reject(new Error(`Could not delete ${target}: ${err.message}`)) : resolve());
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; $fs = [Microsoft.VisualBasic.FileIO.FileSystem]; if (Test-Path -LiteralPath $env:CE_TRASH -PathType Leaf) { $fs::DeleteFile($env:CE_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { $fs::DeleteDirectory($env:CE_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin') }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, CE_TRASH: target }, windowsHide: true }, done);
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`], (err) => (err ? fsp.rm(target, { recursive: true, force: true }).then(() => resolve(), reject) : resolve()));
    } else fsp.rm(target, { recursive: true, force: true }).then(() => resolve(), done);
  });
}

const reviewsOf = (dir) => readJsonSafe(path.join(dir, 'reviews.json'), null);

// Draft versions other than the newest draft of each sequence.
function oldDrafts(reviews) {
  const drafts = (reviews?.versions || []).filter((v) => v.quality === 'draft');
  const newest = new Map();
  for (const v of drafts) if (!newest.has(v.sequence) || String(v.createdAt) > String(newest.get(v.sequence).createdAt)) newest.set(v.sequence, v);
  return drafts.filter((v) => newest.get(v.sequence) !== v);
}
const versionFile = (dir, v) => (path.isAbsolute(v.file) ? v.file : path.join(dir, v.file));

export async function projectUsage(dir) {
  const L = layoutFor(dir);
  // pre-rendered timeline chunks live inside the cache folder but are listed (and cleared) on their own
  const chunks = await dirSize(chunksRoot(L));
  const all = await dirSize(L.cache);
  const cache = { bytes: all.bytes - chunks.bytes, files: all.files - chunks.files };
  // a cache left in its old place after Settings › Cache folder moved it
  const old = defaultLayout(dir).cache;
  if (old !== L.cache) { const o = await dirSize(old); cache.bytes += o.bytes; cache.files += o.files; }
  const attachments = await dirSize(path.join(dir, '.attachments'));
  let draftBytes = 0;
  const drafts = oldDrafts(reviewsOf(dir));
  for (const v of drafts) draftBytes += (await fsp.stat(versionFile(dir, v)).catch(() => null))?.size || 0;
  return { cache, chunks, attachments, drafts: { bytes: draftBytes, files: drafts.length } };
}

// The app's temp files (render worker profiles, motion proxies, ffmpeg lists, shrunk image checks), in the
// cache folder's temp and in the system temp folder (where they went before a cache folder was set).
async function tempEntries() {
  const out = [];
  for (const d of [...new Set([tempRoot(), systemTemp()])]) {
    for (const n of await fsp.readdir(d).catch(() => [])) if (n.startsWith('claude-edit-')) out.push(path.join(d, n));
  }
  return out;
}

export async function appUsage() {
  const size = async (f) => (await fsp.stat(path.join(DATA_DIR, f)).catch(() => null))?.size || 0;
  const temp = { bytes: 0, files: 0 };
  for (const p of await tempEntries()) {
    const st = await fsp.stat(p).catch(() => null);
    if (!st) continue;
    const u = st.isDirectory() ? await dirSize(p) : { bytes: st.size, files: 1 };
    temp.bytes += u.bytes; temp.files += u.files;
  }
  return {
    temp,
    log: { bytes: await size('server.log'), files: 1 },
    fonts: { bytes: await size('sysfonts.json'), files: 1 },
  };
}

// kind: cache | chunks | attachments | drafts. `handle` is the open project (if any) so live state stays in sync.
export async function clearProject(dir, kind, handle) {
  const L = layoutFor(dir);
  if (kind === 'cache') {
    for (const n of await fsp.readdir(L.cache).catch(() => [])) if (n !== 'chunks') await fsp.rm(path.join(L.cache, n), { recursive: true, force: true }).catch(() => {});
    const old = defaultLayout(dir).cache;
    if (old !== L.cache) await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
  } else if (kind === 'chunks') await fsp.rm(chunksRoot(L), { recursive: true, force: true }).catch(() => {});
  else if (kind === 'attachments') await fsp.rm(path.join(dir, '.attachments'), { recursive: true, force: true });
  else if (kind === 'drafts') {
    const ids = new Set(oldDrafts(handle?.reviews || reviewsOf(dir)).map((v) => v.id));
    if (!ids.size) return;
    const files = (handle?.reviews || reviewsOf(dir)).versions.filter((v) => ids.has(v.id)).map((v) => versionFile(dir, v));
    if (handle) {
      await handle.mutateReviews((r) => { r.versions = r.versions.filter((v) => !ids.has(v.id)); r.comments = (r.comments || []).filter((c) => !ids.has(c.version)); });
    } else {
      const r = reviewsOf(dir);
      r.versions = r.versions.filter((v) => !ids.has(v.id));
      r.comments = (r.comments || []).filter((c) => !ids.has(c.version));
      await fsp.writeFile(path.join(dir, 'reviews.json'), JSON.stringify(r, null, 2) + '\n');
    }
    for (const f of files) await fsp.unlink(f).catch(() => {});
  } else throw Object.assign(new Error(`Unknown cache kind: ${kind}`), { status: 400 });
}

export async function clearApp(kind) {
  if (kind === 'temp') { for (const p of await tempEntries()) await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); } // files in use stay
  else if (kind === 'log') await fsp.writeFile(path.join(DATA_DIR, 'server.log'), '').catch(() => {});
  else if (kind === 'fonts') await fsp.unlink(path.join(DATA_DIR, 'sysfonts.json')).catch(() => {});
  else throw Object.assign(new Error(`Unknown cache kind: ${kind}`), { status: 400 });
}
