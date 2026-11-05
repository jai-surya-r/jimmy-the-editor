// Timeline chunks: the unit of rendering, caching and pre-rendering.
// A sequence is cut into chunks at edit points (long stretches are subdivided). Each chunk gets a
// fingerprint of everything that affects its pixels, and is rendered to its own video file named after
// that fingerprint. An export stitches chunk files together, so only chunks whose fingerprint changed
// are ever rendered again. Fingerprints describe a chunk's content relative to its own start, so an
// insert or delete earlier on the timeline doesn't invalidate what comes after it.
//
//   <cache>/chunks/<sequenceId>/<specKey>/<fingerprint>.mp4     one chunk
//   <cache>/chunks/<sequenceId>/<specKey>/spec.json             the output settings of that folder
//   <cache>/chunks/<sequenceId>.approved.json                   set when a version was approved (see prerender.js)
//
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha1, safeJoin, readJsonSafe, readJson } from './util.js';
import { TRANSITIONS, clipEnd, isVisualClip, videoTracks, DEFAULT_TRANSFORM, DEFAULT_CROP, DEFAULT_EFFECTS, flattenSequence } from '../public/js/core/model.js';

export const CHUNK_VERSION = 3;
// Chunks that no longer match the timeline are kept this long, so undo and A/B changes stay instant.
export const ORPHAN_GRACE_MS = 30 * 60 * 1000;
const EPS = 1e-6;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// JSON with sorted keys, so the same content always hashes the same.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export const specKey = (spec) => sha1(stable(spec)).slice(0, 10);
export const chunksRoot = (layout) => path.join(layout.cache, 'chunks');
export const chunkDir = (layout, seqId, spec) => path.join(chunksRoot(layout), seqId, specKey(spec));
export const approvedFile = (layout, seqId) => path.join(chunksRoot(layout), `${seqId}.approved.json`);

// Per visible video track (bottom → top): its enabled visual clips in the order the compositor sees them.
function visualLists(seq) {
  const out = [];
  for (const track of videoTracks(seq)) {
    if (track.hidden) continue;
    const list = seq.clips.filter((c) => c.track === track.id && isVisualClip(c) && c.enabled !== false).sort((a, b) => a.start - b.start);
    if (list.length) out.push(list);
  }
  return out;
}

// Cut [startFrame, startFrame + frameCount) into chunks of roughly two seconds that end on an edit
// point where there is one nearby. Each cut depends only on what follows the chunk's own start, so two
// plans fall back in step at the first edit point they share.
export function planChunks(seq, startFrame, frameCount, lists = visualLists(seq)) {
  const fps = seq.fps;
  const end = startFrame + frameCount;
  const MIN = Math.max(1, Math.round(fps)), TARGET = Math.max(1, Math.round(fps * 2)), MAX = Math.max(2, Math.round(fps * 4));
  const cuts = new Set();
  for (const list of lists) for (const c of list) { cuts.add(Math.round(c.start * fps)); cuts.add(Math.round(clipEnd(c) * fps)); }
  const sorted = [...cuts].filter((f) => f > startFrame && f < end).sort((a, b) => a - b);
  const out = [];
  let s = startFrame, ci = 0;
  while (s < end) {
    if (end - s <= MAX) { out.push({ start: s, count: end - s }); break; }
    while (ci < sorted.length && sorted[ci] < s + MIN) ci++;
    let e = s + TARGET, best = Infinity;
    for (let i = ci; i < sorted.length && sorted[i] <= s + MAX; i++) {
      const d = Math.abs(sorted[i] - (s + TARGET));
      if (d < best) { best = d; e = sorted[i]; }
    }
    out.push({ start: s, count: e - s });
    s = e;
  }
  return out;
}

// For one chunk: per track, the index range of clips on screen during it.
function rangesFor(lists, seq, chunk) {
  const tA = chunk.start / seq.fps, tLast = (chunk.start + chunk.count - 1) / seq.fps;
  const out = [];
  for (const list of lists) {
    let i0 = -1, i1 = -1;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.start - EPS <= tLast && clipEnd(c) - EPS > tA) { if (i0 < 0) i0 = i; i1 = i; }
    }
    if (i0 >= 0) out.push({ list, i0, i1 });
  }
  return out;
}

// The sequence reduced to what a chunk needs (its clips plus their neighbours, which transitions may
// blend with). This is what the render worker gets, so long timelines don't slow every chunk down.
function prunedSequence(seq, ranges) {
  const clips = [];
  for (const { list, i0, i1 } of ranges) clips.push(...list.slice(Math.max(0, i0 - 1), i1 + 2));
  return { ...seq, clips, markers: [] };
}

// What a clip contributes to the frames of one chunk, described so that the same pictures always give
// the same description wherever the clip sits on the timeline: by the source time it shows at the
// chunk's start and the part of the chunk it covers, not by its position. Things that depend on the
// clip's own clock (keyframes, transitions) are included only when they are in play during this chunk,
// so trimming a clip's head or tail doesn't touch the chunks in its middle.
function describe(c, win, info, asOutgoing = false) {
  const { id, name, link, track, media, start, duration, in: inPoint, keyframes, transitionIn, transitionOut, ...rest } = c;
  const end = start + duration;
  const d = { ...rest };
  if (media) d.m = info.media[media] || 'missing';
  if (c.lut?.path) d.lutFile = info.luts[c.lut.path] || 'missing';
  if (c.type === 'video') d.src = r6((inPoint || 0) + (win.t0 - start) * (c.speed || 1));
  const local = r6(win.t0 - start); // the clip's own clock at the chunk's start
  if (keyframes && Object.keys(keyframes).length) { d.keyframes = keyframes; d.local = local; }
  if (asOutgoing) return d; // the outgoing clip of a transition just keeps playing: its own edges don't matter
  d.from = r6(Math.max(win.t0, start) - win.t0);
  d.to = r6(Math.min(win.t1, end) - win.t0);
  const tin = transitionIn, tout = transitionOut;
  if (tin && tin.duration > 0 && TRANSITIONS[tin.type] && start + Math.min(tin.duration, duration) > win.t0 - EPS) {
    d.tin = tin; d.local = local; d.length = duration;
  }
  if (tout && tout.duration > 0 && TRANSITIONS[tout.type] && end - Math.min(tout.duration, duration) < win.tLast + EPS) {
    d.tout = tout; d.endsAt = r6(end - win.t0); d.length = duration;
  }
  return d;
}

function fingerprint(seq, spec, chunk, ranges, info) {
  const fps = seq.fps;
  const win = { t0: chunk.start / fps, t1: (chunk.start + chunk.count) / fps, tLast: (chunk.start + chunk.count - 1) / fps };
  const tol = 0.5 / (fps || 30);
  const tracks = [];
  for (const { list, i0, i1 } of ranges) {
    const row = [];
    for (let i = i0; i <= i1; i++) {
      const c = list[i];
      const d = describe(c, win, info);
      // a two-clip transition blends with the clip that ends where this one starts
      if (d.tin && TRANSITIONS[d.tin.type].pair) {
        const prev = i > 0 && Math.abs(clipEnd(list[i - 1]) - c.start) <= tol ? list[i - 1] : null;
        d.prev = prev ? describe(prev, win, info, true) : null;
      }
      // the first half of a dip belongs to the next clip's transition
      const next = i < list.length - 1 && Math.abs(clipEnd(c) - list[i + 1].start) <= tol ? list[i + 1] : null;
      const nin = next?.transitionIn;
      if (nin && nin.duration > 0 && TRANSITIONS[nin.type]?.center) {
        const half = Math.min(nin.duration, next.duration) / 2;
        if (next.start - half < win.tLast + EPS) d.dip = { at: r6(next.start - win.t0), half: r6(half), type: nin.type };
      }
      row.push(d);
    }
    tracks.push(row);
  }
  return sha1(stable({ v: CHUNK_VERSION, spec, frames: chunk.count, w: seq.width, h: seq.height, fps, bg: seq.background, tracks })).slice(0, 20);
}

// A chunk that is one camera clip as it is: one clip on screen, at normal speed, with no transform, crop, colour,
// LUT, blend, keyframes or transitions. It already plays smoothly from its preview proxy, so pre-rendering it
// only saves time at export: prerender.js leaves these for when the editor is idle.
const neutral = (o, d) => !o || Object.keys(d).every((k) => (o[k] ?? d[k]) === d[k]);
function isPlain(ranges, mediaItems) {
  if (ranges.length !== 1 || ranges[0].i0 !== ranges[0].i1) return false;
  const c = ranges[0].list[ranges[0].i0];
  return c.type === 'video' && (c.speed ?? 1) === 1 && !c.lut && (c.blend || 'normal') === 'normal'
    && !c.transitionIn && !c.transitionOut && !(c.keyframes && Object.keys(c.keyframes).length)
    && neutral(c.transform, DEFAULT_TRANSFORM) && !c.transform?.flipH && !c.transform?.flipV
    && neutral(c.crop, DEFAULT_CROP) && neutral(c.effects, DEFAULT_EFFECTS)
    && !mediaItems.some((m) => m.motion);
}

// ---------------------------------------------------------------- source files

const statCache = new Map(); // abs -> { at, sig }
async function fileSig(abs) {
  if (!abs) return null;
  const hit = statCache.get(abs);
  if (hit && Date.now() - hit.at < 3000) return hit.sig;
  const st = await fsp.stat(abs).catch(() => null);
  const sig = st?.isFile() ? `${st.size}|${st.mtimeMs}` : null;
  statCache.set(abs, { at: Date.now(), sig });
  if (statCache.size > 5000) statCache.clear();
  return sig;
}

// What the fingerprints need to know about the files a sequence uses, read fresh from disk so a file
// replaced under the same name is noticed. `ready` is false while a source can't be rendered properly
// yet (offline, still being probed, a motion graphic still rendering): such chunks are not pre-rendered.
async function sourceInfo(handle, doc, seq, media) {
  const info = { media: {}, luts: {}, ready: {}, worker: {} };
  const items = new Map(doc.media.map((m) => [m.id, m]));
  const ids = new Set(), luts = new Set();
  for (const c of seq.clips) {
    if (!isVisualClip(c) || c.enabled === false) continue;
    if (c.media) ids.add(c.media);
    if (c.lut?.path) luts.add(c.lut.path);
  }
  await Promise.all([...ids].map(async (id) => {
    const m = items.get(id);
    if (!m) { info.ready[id] = false; return; }
    const st = media.get(handle.id, id);
    const sig = await fileSig(handle.resolve(m.path));
    const previewReady = !!sig && !!st?.exists && (st.browserOk !== false || st.proxy === 'ready');
    info.media[id] = { sig, w: m.width || 0, h: m.height || 0, preview: m.type === 'image' ? `${previewReady}|${st?.proxy === 'ready'}` : undefined };
    info.worker[id] = { exists: !!sig, previewReady, key: st?.key || sig || '' };
    info.ready[id] = !!sig && !!st?.probed && !st.error && (m.type === 'audio' || !!m.width) && (m.type !== 'image' || previewReady)
      && (!m.motion || st.motion?.state === 'ready');
  }));
  await Promise.all([...luts].map(async (p) => {
    info.luts[p] = await fileSig(path.isAbsolute(p) ? p : safeJoin(handle.dir, p));
  }));
  return info;
}

// ---------------------------------------------------------------- planning

// The chunks of a frame range of a sequence for one output spec:
//   [{ start, count, fp, file, ready, seq (pruned, for the worker), media (states of the files it uses) }]
export async function planSequence({ handle, doc, seq, spec, media, startFrame, frameCount }) {
  seq = flattenSequence(doc, seq); // nested sequences render their contents, so their chunks follow their changes too
  const lists = visualLists(seq);
  const info = await sourceInfo(handle, doc, seq, media);
  const dir = chunkDir(handle.layout, seq.id, spec);
  const chunks = [];
  let slice = performance.now();
  for (const chunk of planChunks(seq, startFrame, frameCount, lists)) {
    // a long sequence is planned in slices, so the server (and the desktop app's window) never waits on it for long
    if (performance.now() - slice > 12) { await new Promise((r) => setImmediate(r)); slice = performance.now(); }
    const ranges = rangesFor(lists, seq, chunk);
    const pruned = prunedSequence(seq, ranges);
    const used = [...new Set(pruned.clips.map((c) => c.media).filter(Boolean))];
    const mediaItems = used.map((id) => doc.media.find((m) => m.id === id)).filter(Boolean);
    const fp = fingerprint(seq, spec, chunk, ranges, info);
    chunks.push({
      ...chunk, fp, file: path.join(dir, `${fp}.${spec.ext}`), seq: pruned,
      ready: used.every((id) => info.ready[id]),
      plain: isPlain(ranges, mediaItems),
      media: Object.fromEntries(used.map((id) => [id, info.worker[id] || { exists: false, previewReady: false, key: '' }])),
      mediaItems,
    });
  }
  return { dir, chunks };
}

export async function writeSpec(dir, spec) {
  const file = path.join(dir, 'spec.json');
  await fsp.mkdir(dir, { recursive: true });
  if (!readJsonSafe(file)) await fsp.writeFile(file, JSON.stringify(spec));
}

// Mark a chunk as just used (the cleanup rules below go by last use).
export function touch(file, minAgeMs = 10 * 60 * 1000) {
  fsp.stat(file).then((st) => {
    if (Date.now() - st.mtimeMs > minAgeMs) { const now = new Date(); return fsp.utimes(file, now, now); }
    return null;
  }).catch(() => {});
}

// ---------------------------------------------------------------- cleanup

const isChunkFile = (name) => !name.endsWith('.json');

// Remove chunks that no longer match the timeline (after the grace period), leftovers of interrupted
// renders, and everything that belongs to sequences that no longer exist.
export async function sweepOutdated(handle, media) {
  const root = chunksRoot(handle.layout);
  const doc = handle.doc;
  if (!doc) return 0;
  let removed = 0;
  const now = Date.now();
  for (const ent of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const seqId = ent.isDirectory() ? ent.name : ent.name.replace(/\.approved\.json$/, '');
    const seq = doc.sequences.find((s) => s.id === seqId);
    if (!seq) { await fsp.rm(path.join(root, ent.name), { recursive: true, force: true }).catch(() => {}); continue; }
    if (!ent.isDirectory()) continue;
    for (const sd of await fsp.readdir(path.join(root, seqId), { withFileTypes: true }).catch(() => [])) {
      const dir = path.join(root, seqId, sd.name);
      const spec = sd.isDirectory() ? await readJson(path.join(dir, 'spec.json')) : null;
      const age = now - ((await fsp.stat(dir).catch(() => null))?.mtimeMs ?? now);
      if (!spec) { if (!sd.isDirectory() || age > ORPHAN_GRACE_MS) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); continue; }
      const frames = Math.round(seq.clips.reduce((d, c) => Math.max(d, clipEnd(c)), 0) * seq.fps);
      const keep = new Set();
      if (frames > 0) {
        for (const c of (await planSequence({ handle, doc, seq, spec, media, startFrame: 0, frameCount: frames })).chunks) keep.add(c.fp);
      }
      let left = 0;
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        if (!isChunkFile(name)) continue;
        const file = path.join(dir, name);
        const st = await fsp.stat(file).catch(() => null);
        if (!st) continue;
        const partial = name.includes('.part.');
        const stale = partial ? now - st.mtimeMs > 60 * 60 * 1000 : !keep.has(name.replace(/\.\w+$/, '')) && now - st.mtimeMs > ORPHAN_GRACE_MS;
        if (stale) { await fsp.unlink(file).catch(() => {}); removed++; } else left++;
      }
      // nothing in it: remove it, unless it was only just set up and its first chunks are still rendering
      if (!left && age > ORPHAN_GRACE_MS) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return removed;
}

async function chunkFiles(root, out) {
  for (const ent of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) await chunkFiles(p, out);
    else if (isChunkFile(ent.name)) { const st = await fsp.stat(p).catch(() => null); if (st) out.push({ file: p, size: st.size, used: st.mtimeMs }); }
  }
  return out;
}

// Keep the chunk caches of all the given projects under maxBytes together: least recently used go first.
export async function enforceCap(layouts, maxBytes) {
  const files = [];
  for (const L of layouts) await chunkFiles(chunksRoot(L), files);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= maxBytes) return { total, removed: 0 };
  files.sort((a, b) => a.used - b.used);
  let removed = 0;
  for (const f of files) {
    if (total <= maxBytes * 0.9) break;
    await fsp.unlink(f.file).catch(() => {});
    total -= f.size;
    removed++;
  }
  return { total, removed };
}

export async function clearSequence(layout, seqId) {
  await fsp.rm(path.join(chunksRoot(layout), seqId), { recursive: true, force: true }).catch(() => {});
}
