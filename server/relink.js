// Footage that can't be found where project.json says (a project made on Windows opened on a Mac or the other way
// round, a drive with another letter, a folder moved), and putting it back the way Premiere Pro's "Link Media"
// does: the person finds one file, the change of folder it shows is tried on every other missing file, and what
// is still missing is looked for by name around the file they found.
import fs from 'node:fs';
import path from 'node:path';

const segs = (p) => String(p || '').split(/[\\/]+/).filter(Boolean);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
// a path written on the other system: "D:\Footage\a.mov" on a Mac, "/Users/me/a.mov" on Windows
const foreign = (p) => (process.platform === 'win32' ? /^\/(?!\/)/.test(p) : /^([a-zA-Z]:[\\/]|\\\\)/.test(p));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// media items with a file to find (footage, audio, stills; not motion graphics, text or nested sequences)
const withFile = (doc) => (doc?.media || []).filter((m) => m.path && !m.motion);

// where a media item's file should be on this computer (null when the path is from the other system)
function located(h, m) {
  if (foreign(m.path)) return null;
  const abs = h.resolve(m.path);
  return abs && isFile(abs) ? abs : null;
}

// The missing files: [{ id, name, path }]
export function missingMedia(h) {
  return withFile(h.doc).filter((m) => !located(h, m)).map((m) => ({ id: m.id, name: m.name || segs(m.path).pop(), path: m.path, foreign: foreign(m.path) }));
}

// a file with this name under dir (a few levels down, a limited number of folders), or null
function findByName(dir, name, depth = 4, budget = { n: 4000 }) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && same(e.name, name)) return path.join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || --budget.n < 0) continue;
    const hit = findByName(path.join(dir, e.name), name, depth - 1, budget);
    if (hit) return hit;
  }
  return null;
}

// The person found media item `mediaId` at `file`. Returns { doc, linked: [ids] } with every file that could be put
// back (the doc is a new copy: the caller commits it), or throws.
export function relinkMedia(h, mediaId, file) {
  const doc = JSON.parse(JSON.stringify(h.doc));
  const item = doc.media.find((m) => m.id === mediaId);
  if (!item) throw Object.assign(new Error('No such media item'), { status: 404 });
  const abs = path.resolve(String(file || ''));
  if (!isFile(abs)) throw Object.assign(new Error(`No such file: ${abs}`), { status: 400 });
  // the change of folder: the old and new paths without the end they share ("D:\Shoot\A" -> "/Volumes/X/Shoot/A")
  const was = segs(item.path), now = segs(abs);
  let k = 0;
  while (k < was.length - 1 && k < now.length - 1 && same(was[was.length - 1 - k], now[now.length - 1 - k])) k++;
  const from = was.slice(0, was.length - k), to = now.slice(0, now.length - k);
  // what goes before the first folder name: '/' on a Mac, '\\' for a network share, nothing before 'C:'
  const root = abs.startsWith('\\\\') ? '\\\\' : abs.startsWith('/') ? '/' : '';
  const linked = [];
  const set = (m, p) => { m.path = h.relativize(p); linked.push(m.id); };
  set(item, abs);
  const pending = withFile(doc).filter((m) => m !== item && !located(h, m));
  for (const m of pending) {
    const s = segs(m.path);
    if (s.length <= from.length || !from.every((x, i) => same(x, s[i]))) continue;
    const p = root + [...to, ...s.slice(from.length)].join(path.sep);
    if (isFile(p)) set(m, p);
  }
  // the rest: by name, in the folder of the file found and below (and the one above it)
  const near = [path.dirname(abs), path.dirname(path.dirname(abs))];
  for (const m of pending) {
    if (linked.includes(m.id)) continue;
    const name = segs(m.path).pop();
    for (const dir of near) {
      const hit = name && findByName(dir, name);
      if (hit) { set(m, hit); break; }
    }
  }
  return { doc, linked };
}
