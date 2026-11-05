// Where a project keeps its files. Folders that follow Jimmy's template
// (1_Assets, 2_Audio, 3_Exports, 4_Footage, 5_Projects) get no extra folders at all: exports, uploads
// and fonts go into the template's own folders, and the editor's cache and UI state live in the app's
// data folder instead of the project.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, projectIdFor } from './util.js';
import { cacheRoot } from './cachedir.js';

const TEMPLATE_FOLDERS = ['1_Assets', '2_Audio', '3_Exports', '4_Footage', '5_Projects'];

// a project laid out by Jimmy's template (also those made before it had this name)
export function isTemplateProject(dir, F = syncFs) {
  return TEMPLATE_FOLDERS.every((d) => F.exists(path.join(dir, d)));
}

export function layoutFor(dir) {
  const L = defaultLayout(dir);
  const root = cacheRoot();
  if (!root) return L;
  const cache = path.join(root, 'projects', projectIdFor(dir));
  return { ...L, cache, ensure: L.ensure.filter((d) => d !== L.cache) };
}

// the cache's place inside the project (or the app's data folder), used when no cache folder is set.
// Looking at the project's folders takes a while on a busy NAS, and it is asked for often (each project, each
// cache check): the answer is kept for a minute.
const known = new Map(); // dir -> { at, L }
export function defaultLayout(dir) {
  const hit = known.get(dir);
  if (hit) {
    // an older answer is used while a new one is read in the background (no wait on a slow drive)
    if (Date.now() - hit.at >= 60000 && !hit.refreshing) { hit.refreshing = true; warmLayout(dir, { fresh: true }).catch(() => { hit.refreshing = false; }); }
    return hit.L;
  }
  const L = lookLayout(dir);
  known.set(dir, { at: Date.now(), L });
  return L;
}
// The same answer read without blocking: the folders lookLayout asks about are read asynchronously first (it is run
// again until it asks for nothing new). Projects are warmed this way when listed and opened.
export async function warmLayout(dir, { fresh = false } = {}) {
  const hit = known.get(dir);
  if (hit && !fresh && Date.now() - hit.at < 60000) return hit.L;
  const ex = new Map();
  const ls = new Map();
  for (let i = 0; i < 6; i++) {
    const want = [];
    const F = {
      exists: (p) => (ex.has(p) ? ex.get(p) : (want.push(['e', p]), true)),
      folders: (p) => (ls.has(p) ? ls.get(p) : (want.push(['l', p]), [])),
    };
    const L = lookLayout(dir, F);
    if (!want.length) { known.set(dir, { at: Date.now(), L }); return L; }
    await Promise.all(want.map(async ([k, p]) => {
      if (k === 'e') ex.set(p, await fs.promises.access(p).then(() => true, () => false));
      else ls.set(p, await fs.promises.readdir(p, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name), () => []));
    }));
  }
  return defaultLayout(dir);
}
function lookLayout(dir, F = syncFs) {
  if (isTemplateProject(dir, F)) {
    const state = path.join(DATA_DIR, 'state', projectIdFor(dir));
    const files = path.join(dir, '5_Projects', 'Jimmy Files');
    return {
      template: true,
      renders: premiereExports(dir, F),
      upload: (type) => path.join(dir, ...({ video: ['4_Footage', 'B_Roll'], audio: ['2_Audio', '2_Music'], image: ['1_Assets', '1_Stock_Photos'] }[type] || ['1_Assets'])),
      fonts: path.join(dir, '1_Assets'),
      refs: path.join(dir, '1_Assets', '5_Screenshot'),
      motion: path.join(dir, '1_Assets', '4_Overlays'), // motion-graphic HTML sources (no new folders in Jimmy's template)
      motionRenders: afterEffectsExports(dir, F), // rendered motion graphics stay in the project, with the After Effects renders
      proxyFile: (abs, ext) => rollProxy(dir, abs, ext),
      files, // the editor's own files for this project: UI state, chat links, review rounds
      legacy: { motionRenders: path.join(state, 'motion-renders'), files: state }, // where earlier versions kept them
      state,
      cache: path.join(state, 'cache'),
      ensure: [state, files],
    };
  }
  return {
    template: false,
    renders: path.join(dir, 'renders'),
    upload: () => path.join(dir, 'media'),
    fonts: path.join(dir, 'fonts'),
    refs: path.join(dir, 'media'),
    motion: path.join(dir, 'motion'),
    motionRenders: path.join(dir, 'motion', 'renders'),
    state: path.join(dir, '.claude-edit'),
    files: path.join(dir, '.claude-edit'),
    cache: path.join(dir, '.cache'),
    ensure: ['media', 'renders', 'fonts', '.claude-edit', '.cache'].map((d) => path.join(dir, d)),
  };
}

const folders = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; /* none yet */ }
};
const syncFs = { exists: (p) => fs.existsSync(p), folders };

// Exports' folder in the project's own spelling. A project with the template's spelling beside another one has the
// second because Jimmy made the first next to it, so the other spelling is the project's.
function premiereExports(dir, F = syncFs) {
  const root = path.join(dir, '3_Exports');
  const STD = '3_Premier_Pro_Exports';
  const found = F.folders(root).filter((n) => /^(\d+[ _]?)?premie?re?[ _]?pro[ _]?exports?$/i.test(n));
  const pro = found.find((n) => n !== STD) || found[0] || STD;
  const qc = F.folders(path.join(root, pro)).find((n) => /^(\d+[ _]?)?internal[ _]?qc$/i.test(n)) || '1_Internal_QC';
  return path.join(root, pro, qc);
}

// The template's After Effects exports folder (spelled with spaces or underscores); 1_After_Effects_Exports if it has none.
function afterEffectsExports(dir, F = syncFs) {
  const root = path.join(dir, '3_Exports');
  const names = F.folders(root);
  return path.join(root, names.find((n) => /^(\d+[ _]?)?after[ _]?effects[ _]?exports?$/i.test(n)) || '1_After_Effects_Exports');
}

// Footage in 4_Footage/A_Roll or B_Roll (any spelling) gets its proxy in that roll's Proxies folder, in the same
// subfolders (cards often repeat file names): A_Roll/Day 1/C0001.MP4 → A_Roll/Proxies/Day 1/C0001_proxy.mp4.
// Other media: null (the cache).
function rollProxy(dir, abs, ext) {
  const rel = path.relative(path.join(dir, '4_Footage'), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [roll, ...rest] = rel.split(path.sep);
  if (!rest.length || !/^[ab][ _-]?roll$/i.test(roll) || /^proxies$/i.test(rest[0])) return null;
  const name = rest.pop();
  return path.join(dir, '4_Footage', roll, 'Proxies', ...rest, `${path.parse(name).name}_proxy.${ext}`);
}

// Earlier versions kept the UI state, chat links and review rounds in the app's data folder: move them into the
// project the first time it opens (a file already in the project wins).
export async function adoptLegacyFiles(L) {
  if (!L.legacy) return;
  const names = ['ui.json', 'chat-links.json'];
  for (const n of await fs.promises.readdir(path.join(L.legacy.files, 'review-rounds')).catch(() => [])) names.push(path.join('review-rounds', n));
  for (const n of names) await moveFile(path.join(L.legacy.files, n), path.join(L.files, n)).catch(() => {});
}

// Move a file, also across drives; nothing happens when the source is missing or the target exists.
export async function moveFile(from, to) {
  const there = (p) => fs.promises.access(p).then(() => true, () => false);
  if (!(await there(from)) || (await there(to))) return false;
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const part = `${to}.part`;
  try {
    await fs.promises.copyFile(from, part);
    await fs.promises.rename(part, to);
  } catch (err) {
    await fs.promises.unlink(part).catch(() => {});
    throw err;
  }
  await fs.promises.unlink(from).catch(() => {});
  return true;
}
