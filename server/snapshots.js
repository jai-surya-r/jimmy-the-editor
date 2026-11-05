// Project snapshots: copies of a project's own files (never footage or renders) in its cache folder, to go back to.
// Each snapshot is one JSON file <cache>/snapshots/<time>--<reason>.json holding project.json, reviews.json and the
// editor's small files (ui.json, chat links) as text.
// Taken: when the project opens, every 10 minutes while it changes, just before a chat's edit lands (if none was
// taken in the last 5 minutes), when asked, and before a restore. An unchanged project makes no new snapshot.
// Kept: the newest 40, then one a day for 30 days.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha1, writeFileAtomic } from './util.js';

// JIMMY_SNAPSHOT_EVERY_MS / JIMMY_SNAPSHOT_GAP_MS: shorter times, for tests
const EVERY = Number(process.env.JIMMY_SNAPSHOT_EVERY_MS) || 10 * 60 * 1000;
const BEFORE_CHAT_GAP = Number(process.env.JIMMY_SNAPSHOT_GAP_MS ?? 5 * 60 * 1000);
const KEEP_NEWEST = 40;
const KEEP_DAYS = 30;
const REASONS = { open: 'Opened', auto: 'While editing', chat: 'Before a chat edit', manual: 'Taken by hand', restore: 'Before a restore' };

const dirOf = (h) => path.join(h.layout.cache, 'snapshots');
// the files a snapshot holds, by the name they are restored under
const filesOf = (h) => ({
  'project.json': h.file,
  'reviews.json': h.reviewsFile,
  'ui.json': path.join(h.layout.files, 'ui.json'),
  'chat-links.json': path.join(h.layout.files, 'chat-links.json'),
  'chat-unlinks.json': path.join(h.layout.files, 'chat-unlinks.json'),
});

const state = new WeakMap(); // handle -> { timer, lastAt, lastHash }
const st = (h) => { if (!state.has(h)) state.set(h, { timer: null, lastAt: 0, lastHash: null }); return state.get(h); };

async function readFiles(h, override = {}) {
  const out = {};
  for (const [name, file] of Object.entries(filesOf(h))) {
    if (override[name] != null) { out[name] = override[name]; continue; }
    try { out[name] = await fsp.readFile(file, 'utf8'); } catch { /* not there */ }
  }
  return out;
}
const hashOf = (files) => sha1(`${files['project.json'] || ''}\u0000${files['reviews.json'] || ''}`);

// Takes a snapshot unless it would be the same as the newest. override: texts to use instead of the files on disk
// (the project as it was just before a chat's edit). Returns its id, or null.
export async function takeSnapshot(h, reason = 'auto', override = {}) {
  if (!h.layout?.cache || h.error) return null;
  const files = await readFiles(h, override);
  if (!files['project.json']) return null;
  const s = st(h);
  const hash = hashOf(files);
  if (s.lastHash == null) s.lastHash = (await listSnapshots(h))[0]?.hash || null;
  if (hash === s.lastHash) { s.lastAt = Date.now(); return null; }
  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, '-')}--${reason}`;
  let summary = {};
  try { const d = JSON.parse(files['project.json']); summary = { sequences: d.sequences?.length || 0, clips: (d.sequences || []).reduce((n, q) => n + (q.clips?.length || 0), 0), media: d.media?.length || 0 }; } catch { /* still keep it */ }
  await fsp.mkdir(dirOf(h), { recursive: true });
  await writeFileAtomic(path.join(dirOf(h), `${id}.json`), JSON.stringify({ format: 'jimmy-snapshot/1', createdAt: now.toISOString(), reason, hash, summary, files }));
  s.lastHash = hash;
  s.lastAt = Date.now();
  prune(h).catch(() => {});
  return id;
}

export async function listSnapshots(h) {
  let names = [];
  try { names = (await fsp.readdir(dirOf(h))).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names.sort().reverse()) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dirOf(h), n), 'utf8'));
      out.push({ id: n.slice(0, -5), createdAt: j.createdAt, reason: j.reason, label: REASONS[j.reason] || j.reason, hash: j.hash, summary: j.summary || {}, files: Object.keys(j.files || {}) });
    } catch { /* a half-written or foreign file */ }
  }
  return out;
}

async function prune(h) {
  const list = await listSnapshots(h);
  const days = new Set();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const [i, s] of list.entries()) {
    if (i < KEEP_NEWEST) continue;
    const t = Date.parse(s.createdAt);
    const day = s.createdAt.slice(0, 10);
    if (t >= cutoff && !days.has(day)) { days.add(day); continue; }
    await fsp.rm(path.join(dirOf(h), `${s.id}.json`), { force: true });
  }
}

// Puts a snapshot back: the current state is snapshotted first, then each file is written through the project
// (so open editors update at once). Returns the snapshot taken before.
export async function restoreSnapshot(h, id) {
  if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('Unknown snapshot'), { status: 404 });
  let snap;
  try { snap = JSON.parse(await fsp.readFile(path.join(dirOf(h), `${id}.json`), 'utf8')); } catch { throw Object.assign(new Error('That snapshot is gone'), { status: 404 }); }
  const before = await takeSnapshot(h, 'restore');
  const files = snap.files || {};
  if (files['project.json']) await h.commit(JSON.parse(files['project.json']), { origin: 'server', force: true });
  if (files['reviews.json']) await h.commitReviews(JSON.parse(files['reviews.json']), { origin: 'server' });
  for (const name of ['ui.json', 'chat-links.json', 'chat-unlinks.json']) {
    if (files[name] != null) await writeFileAtomic(filesOf(h)[name], files[name]);
  }
  st(h).lastHash = null;
  return { before };
}

// a project that is open: a snapshot now (if it changed since the newest), then every 10 minutes while it changes
export function watchSnapshots(h) {
  const s = st(h);
  if (s.timer) return;
  takeSnapshot(h, 'open').catch((e) => console.warn('[snapshots]', e.message));
  s.timer = setInterval(() => takeSnapshot(h, 'auto').catch(() => {}), EVERY);
  s.timer.unref?.();
}
export function unwatchSnapshots(h) {
  const s = state.get(h);
  if (s?.timer) clearInterval(s.timer);
  if (s) s.timer = null;
}
// a chat is about to change the project: keep how it was, unless a snapshot was just taken
export function beforeChatEdit(h, projectText, reviewsText) {
  const s = st(h);
  if (Date.now() - s.lastAt < BEFORE_CHAT_GAP || !projectText) return;
  takeSnapshot(h, 'chat', { 'project.json': projectText, ...(reviewsText != null ? { 'reviews.json': reviewsText } : {}) }).catch(() => {});
}
export const snapshotsDir = dirOf;
export const hasSnapshotDir = (h) => fs.existsSync(dirOf(h));
