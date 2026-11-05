// Media analysis: probing, thumbnail strips, waveforms and preview proxies.
// Everything derived from a source file is cached under <project>/.cache keyed by path+size+mtime.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { budget } from './budget.js';
import { FFMPEG, probe, run, progressParser, hasAlpha, perf, withThreads, lowerPriority, cpuH264 } from './ffmpeg.js';
import { sha1, readJson, writeFileAtomic, exists as there } from './util.js';
import { getConfig } from './config.js';
import { moveFile } from './layout.js';
import { perflog } from './perflog.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sameValue = (a, b) => a === b || (a && b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

// ------------------------------------------------------------- job queue

class Queue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.items = [];
  }
  // priority: a number, or a function asked each time a job starts (lower runs first; equal ones in order)
  // info: what the job is, for the proxy queue panel ({ kind: 'proxy', projectId, mediaId }); the panel can rush one
  push(fn, priority = 5, info = null) {
    return new Promise((resolve, reject) => {
      this.items.push({ fn, priority, resolve, reject, at: Date.now(), info });
      this.pump();
      this.onChange?.();
    });
  }
  rank(it) { return it.rush ? -1 : typeof it.priority === 'function' ? it.priority() : it.priority; }
  pump() {
    // preview files, thumbnails and waveforms run one at a time while the machine is under pressure
    while (this.running < (this.limit ? this.limit(this.concurrency) : this.concurrency) && this.items.length) {
      if (this.items.length > 1) {
        const ranked = this.items.map((it) => [this.rank(it), it]).sort((a, b) => a[0] - b[0]);
        this.items = ranked.map((x) => x[1]);
      }
      const it = this.items.shift();
      this.running++;
      this.active.add(it);
      this.onChange?.();
      Promise.resolve().then(it.fn).then(it.resolve, it.reject).finally(() => { this.running--; this.active.delete(it); this.onChange?.(); this.pump(); });
    }
  }
  active = new Set();
}

export class MediaService {
  constructor({ onStatus, emitAll = () => {}, projectName = () => '' }) {
    this.onStatus = onStatus; // (projectId, mediaId, status) => void
    this.emitAll = emitAll;
    this.projectName = projectName;
    this.status = new Map(); // projectId -> Map(mediaId -> status)
    this.aborts = new Map(); // projectId -> AbortController (stopProject)
    this.queue = new Queue(perf().jobs);
    // the proxy queue panel follows the queue (at most every 700 ms)
    this.queue.onChange = () => {
      if (this.queueTimer) return;
      this.queueTimer = setTimeout(() => { this.queueTimer = null; this.emitAll({ type: 'proxy-queue', queue: this.proxyQueue() }); }, 700);
    };
    this.queue.limit = (n) => budget.mediaJobs(n);
    // what preview files wait with, for the scheduler; "needed": a proxy the viewer can't show its clip without
    // (ranked under 2 by proxyRank)
    budget.demand.media = () => {
      const q = this.queue;
      if (!q.items.length && !q.running) return null;
      return {
        want: Math.min(8, q.items.length + q.running),
        needed: q.items.some((it) => q.rank(it) < 2),
        waitingSince: q.items.length ? Math.min(...q.items.map((it) => it.at)) : null,
      };
    };
    budget.onChange(() => this.queue.pump());
    this.probeQueue = new Queue(4);
    this.inflight = new Map(); // cacheKey:kind -> promise
  }

  projectStatus(projectId) {
    let m = this.status.get(projectId);
    if (!m) { m = new Map(); this.status.set(projectId, m); }
    return m;
  }
  statusObject(projectId) {
    return Object.fromEntries(this.projectStatus(projectId));
  }
  get(projectId, mediaId) {
    return this.projectStatus(projectId).get(mediaId) || null;
  }
  set(projectId, mediaId, patch) {
    const m = this.projectStatus(projectId);
    const prev = m.get(mediaId);
    // nothing new (a file that is still offline, looked at again): no message, so nothing downstream re-plans
    if (prev && Object.keys(patch).every((k) => sameValue(prev[k], patch[k]))) return prev;
    const next = { ...(prev || {}), ...patch };
    m.set(mediaId, next);
    this.onStatus(projectId, mediaId, next);
    if (next.key && (next.proxy === 'running' || next.proxy === 'ready' || next.proxy === 'error') && ('proxy' in patch || 'proxyProgress' in patch)) this.shareProxy(projectId, mediaId, next);
    if ('proxyProgress' in patch) this.queue.onChange?.(); // the proxy queue panel shows progress
    return next;
  }
  // One file has one proxy job, however many media items use it (the same clip imported twice, or in two projects):
  // the items that didn't start the job follow the one that did.
  shareProxy(projectId, mediaId, from) {
    const fields = { proxy: from.proxy, proxyProgress: from.proxyProgress, proxyPath: from.proxyPath, ...(from.proxy === 'error' ? { error: from.error } : {}) };
    for (const [pid, m] of this.status) {
      for (const [mid, st] of m) {
        if (st.key !== from.key || (pid === projectId && mid === mediaId)) continue;
        if (Object.keys(fields).every((k) => sameValue(st[k], fields[k]))) continue;
        const next = { ...st, ...fields };
        m.set(mid, next);
        this.onStatus(pid, mid, next);
      }
    }
  }

  cacheDir(handle) {
    return handle.layout?.cache || path.join(handle.dir, '.cache');
  }
  cacheFile(handle, key, suffix) {
    return path.join(this.cacheDir(handle), `${key}.${suffix}`);
  }

  // A/B-roll footage of a template project has its proxy in that roll's Proxies folder (layout.js), the rest in the
  // cache. A proxy next to the footage is out of date once the footage is newer (replaced by another take).
  async findProxy(handle, abs, key, ext, mtimeMs) {
    const f = handle.layout?.proxyFile?.(abs, ext);
    const st = f && (await fsp.stat(f).catch(() => null));
    if (st && st.mtimeMs >= mtimeMs - 2000) return f;
    const c = this.cacheFile(handle, key, `proxy.${ext}`);
    return !f && (await there(c)) ? c : null;
  }

  // Called whenever the project's media list may have changed. Probes new/changed files,
  // patches missing metadata into the project and schedules thumbnails/waveforms/proxies.
  async sync(handle, { force = false } = {}) {
    const doc = handle.doc;
    if (!doc) return;
    this.motion?.check(handle); // motion graphics re-render when their source or params change
    const sig = JSON.stringify(doc.media.map((m) => [m.id, m.path, m.duration == null]));
    if (!force && handle._mediaSig === sig) return;
    handle._mediaSig = sig;
    await fsp.mkdir(this.cacheDir(handle), { recursive: true });
    const statusMap = this.projectStatus(handle.id);
    const known = new Set(doc.media.map((m) => m.id));
    for (const id of [...statusMap.keys()]) if (!known.has(id)) statusMap.delete(id);

    const patches = {};
    await Promise.all(doc.media.map(async (item) => {
      const abs = handle.resolve(item.path);
      let st = null;
      try { st = abs ? await fsp.stat(abs) : null; } catch { st = null; }
      if (!st || !st.isFile()) {
        this.set(handle.id, item.id, { exists: false, key: null, abs });
        return;
      }
      const key = sha1(`${abs}|${st.size}|${st.mtimeMs}`).slice(0, 16);
      const prev = statusMap.get(item.id);
      if (!force && prev && prev.key === key && prev.exists && prev.probed && !prev.error) {
        if (item.duration == null && prev.meta) patches[item.id] = metaFields(prev.meta);
        return;
      }
      this.set(handle.id, item.id, { exists: true, key, abs, probed: false, error: null });
      let meta = await readJson(this.cacheFile(handle, key, 'meta.json'));
      // probed before start timecodes were read (Step 62): probe again, once
      if (meta && meta.type === 'video' && !('timecode' in meta)) meta = null;
      if (!meta) {
        try {
          meta = await this.probeQueue.push(() => probe(abs), 0);
          await writeFileAtomic(this.cacheFile(handle, key, 'meta.json'), JSON.stringify(meta));
        } catch (err) {
          this.set(handle.id, item.id, { probed: true, error: `Could not read media: ${err.message}` });
          return;
        }
      }
      const needs = needsMetaPatch(item, meta);
      if (needs) patches[item.id] = metaFields(meta);
      const proxyMode = getConfig().proxy?.mode || 'auto';
      // Unplayable formats always need a proxy; "auto" also proxies very large video for smooth scrubbing.
      const wantProxy = !meta.browserOk
        || (proxyMode === 'always' && meta.type === 'video')
        || (proxyMode === 'auto' && meta.type === 'video' && meta.width * meta.height > 2560 * 1600);
      const proxyExt = proxyExtFor(meta);
      const proxyPath = await this.findProxy(handle, abs, key, proxyExt, st.mtimeMs);
      const proxyReady = !!proxyPath;
      const thumbsMeta = await readJson(this.cacheFile(handle, key, 'thumbs.json'));
      this.set(handle.id, item.id, {
        probed: true, meta, browserOk: meta.browserOk,
        proxy: proxyReady ? 'ready' : wantProxy ? 'queued' : 'none', proxyProgress: proxyReady ? 1 : 0, proxyExt, proxyPath,
        thumbs: thumbsMeta || null,
        poster: await there(this.cacheFile(handle, key, 'poster.jpg')),
        wave: await there(this.cacheFile(handle, key, 'wave.bin')),
      });
      this.schedule(handle, item.id, { wantProxy: wantProxy && !proxyReady });
    }));
    const ids = Object.keys(patches);
    if (ids.length) {
      await handle.mutate((d) => {
        for (const m of d.media) {
          if (!patches[m.id]) continue;
          Object.assign(m, patches[m.id]);
          if (!patches[m.id].timecode) delete m.timecode; // the file has none (any more)
        }
      }, 'server');
    }
  }

  schedule(handle, mediaId, { wantProxy }) {
    const st = this.get(handle.id, mediaId);
    if (!st?.meta) return;
    const { meta, key, abs } = st;
    if ((meta.type === 'video' || meta.type === 'image') && !st.poster) {
      this.once(`${key}:poster`, () => this.queue.push(() => this.makePoster(handle, mediaId, abs, key, meta), 1, { kind: 'poster', handle }));
    }
    if (meta.type === 'video' && !st.thumbs) {
      this.once(`${key}:thumbs`, () => this.queue.push(() => this.makeThumbs(handle, mediaId, abs, key, meta), 2, { kind: 'thumbs', handle }));
    }
    if (meta.hasAudio && meta.type !== 'image' && !st.wave) {
      this.once(`${key}:wave`, () => this.queue.push(() => this.makeWave(handle, mediaId, abs, key, meta), 3, { kind: 'wave', handle }));
    }
    if (wantProxy) this.requestProxy(handle, mediaId);
  }

  requestProxy(handle, mediaId) {
    const st = this.get(handle.id, mediaId);
    if (!st?.meta || st.proxy === 'ready' || st.proxy === 'running') return;
    this.set(handle.id, mediaId, { proxy: 'queued' });
    this.once(`${st.key}:proxy`, () => this.queue.push(() => this.makeProxy(handle, mediaId, st.abs, st.key, st.meta), () => this.proxyRank(handle, mediaId),
      { kind: 'proxy', handle, mediaId, key: `${handle.id}:${mediaId}` }));
  }

  // The proxy queue panel: proxies being made, then the waiting ones in the order they will start.
  proxyQueue() {
    const row = (it, state) => {
      const { handle, mediaId, key } = it.info;
      const item = handle.doc?.media.find((m) => m.id === mediaId);
      const st = this.get(handle.id, mediaId);
      return {
        key, projectId: handle.id, mediaId, state, rush: !!it.rush,
        name: item?.name || path.basename(st?.abs || mediaId), project: handle.doc?.name || path.basename(handle.dir),
        progress: st?.proxyProgress || 0,
        needed: st?.browserOk === false, // the viewer can't show the clip until this exists
      };
    };
    const q = this.queue;
    const waiting = q.items.filter((it) => it.info?.kind === 'proxy').map((it) => [q.rank(it), it]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return [...[...q.active].filter((it) => it.info?.kind === 'proxy').map((it) => row(it, 'running')), ...waiting.map((it) => row(it, 'queued'))];
  }
  // "Make now": to the front of the queue (it starts at the next free slot)
  rushProxy(key) {
    const it = this.queue.items.find((x) => x.info?.key === key);
    if (!it) return false;
    it.rush = true;
    this.queue.pump();
    this.queue.onChange();
    return true;
  }

  // The viewer can't show a clip the browser can't play until its proxy exists, so those come before
  // thumbnails and waveforms: the sequence on screen first, in timeline order, then the other sequences in
  // turn. Optional proxies (big but playable video, for smoother scrubbing) come last.
  proxyRank(handle, mediaId) {
    if (this.get(handle.id, mediaId)?.browserOk !== false) return 6;
    const seqs = handle.doc?.sequences || [];
    const focus = handle.focus?.sequenceId;
    const ordered = [...seqs.filter((s) => s.id === focus), ...seqs.filter((s) => s.id !== focus)];
    for (let i = 0; i < ordered.length; i++) {
      let first = Infinity;
      for (const c of ordered[i].clips) if (c.media === mediaId && c.start < first) first = c.start;
      if (first < Infinity) return 1.5 + Math.min(i, 49) / 100 + Math.min(first, 99999) / 1e7;
    }
    return 4.5; // not on a timeline yet
  }

  // A proxy the viewer is waiting for (a format the browser can't play) is queued or being made.
  proxiesPending(projectId) {
    for (const st of this.projectStatus(projectId).values()) {
      if (st.browserOk === false && st.proxy !== 'ready' && this.inflight.has(`${st.key}:proxy`)) return true;
    }
    return false;
  }

  // The project was closed: its waiting jobs leave the queue, the running ones are stopped (their ffmpeg ended,
  // a half-made proxy deleted), and its status goes, so it is looked at afresh when opened again.
  stopProject(projectId) {
    const mine = (it) => it.info?.handle?.id === projectId;
    const q = this.queue;
    const dropped = q.items.filter(mine);
    q.items = q.items.filter((it) => !mine(it));
    for (const it of dropped) it.resolve();
    this.aborts.get(projectId)?.abort();
    this.aborts.delete(projectId);
    this.status.delete(projectId);
    q.onChange?.();
  }
  // proxies of a project waiting or being made (closing it asks first)
  proxyCount(projectId) {
    const q = this.queue;
    return [...q.active, ...q.items].filter((it) => it.info?.kind === 'proxy' && it.info.handle.id === projectId).length;
  }
  // ends a project's ffmpeg runs when it is closed
  signal(projectId) {
    let c = this.aborts.get(projectId);
    if (!c) this.aborts.set(projectId, (c = new AbortController()));
    return c.signal;
  }

  once(k, fn) {
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = Promise.resolve().then(fn).catch((err) => console.warn(`[media] ${k}: ${err.message}`)).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  async makePoster(handle, mediaId, abs, key, meta) {
    const out = this.cacheFile(handle, key, 'poster.jpg');
    const args = ['-v', 'error', '-y'];
    if (meta.type === 'video') args.push('-ss', String(Math.min(1, (meta.duration || 0) * 0.1)));
    args.push('-i', abs, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '4', out);
    await run(FFMPEG, args, { signal: this.signal(handle.id) });
    this.set(handle.id, mediaId, { poster: true });
  }

  async makeThumbs(handle, mediaId, abs, key, meta) {
    const dur = meta.duration || 1;
    const count = clamp(Math.round(dur / 1.5), 6, 150);
    const th = 90;
    const aspect = meta.width && meta.height ? meta.width / meta.height : 16 / 9;
    const tw = Math.max(16, Math.round((th * aspect) / 2) * 2);
    const out = this.cacheFile(handle, key, 'thumbs.jpg');
    const args = ['-v', 'error', '-y'];
    if (dur > 90) args.push('-skip_frame', 'nokey');
    args.push('-i', abs, '-an', '-sn', '-vf', `fps=${count}/${dur},scale=${tw}:${th},tile=${count}x1`, '-frames:v', '1', '-q:v', '5', out);
    await run(FFMPEG, args, { signal: this.signal(handle.id) });
    const info = { count, interval: dur / count, w: tw, h: th };
    await writeFileAtomic(this.cacheFile(handle, key, 'thumbs.json'), JSON.stringify(info));
    this.set(handle.id, mediaId, { thumbs: info });
  }

  // Peak envelope: 100 values per second, 0..255, mono.
  async makeWave(handle, mediaId, abs, key) {
    const rate = 8000, perSec = 100, bucket = rate / perSec;
    const out = this.cacheFile(handle, key, 'wave.bin');
    const peaks = [];
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, withThreads(['-v', 'error', '-i', abs, '-vn', '-sn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']), { windowsHide: true });
      lowerPriority(p);
      const signal = this.signal(handle.id);
      if (signal.aborted) p.kill('SIGKILL'); else signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
      let carry = Buffer.alloc(0);
      let count = 0, peak = 0;
      p.stdout.on('data', (chunk) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const n = buf.length >> 1;
        for (let i = 0; i < n; i++) {
          const v = Math.abs(buf.readInt16LE(i * 2));
          if (v > peak) peak = v;
          if (++count >= bucket) { peaks.push(peak); peak = 0; count = 0; }
        }
        carry = buf.length & 1 ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
      });
      p.stderr.resume();
      p.on('error', reject);
      p.on('close', (code) => { if (count) peaks.push(peak); code === 0 ? resolve() : reject(new Error(`waveform ffmpeg exited ${code}`)); });
    });
    const bytes = Buffer.alloc(peaks.length);
    for (let i = 0; i < peaks.length; i++) bytes[i] = Math.min(255, Math.round(Math.sqrt(peaks[i] / 32768) * 255));
    await writeFileAtomic(out, bytes);
    this.set(handle.id, mediaId, { wave: true });
  }

  async makeProxy(handle, mediaId, abs, key, meta) {
    const ext = proxyExtFor(meta);
    const cached = this.cacheFile(handle, key, `proxy.${ext}`);
    let out = handle.layout?.proxyFile?.(abs, ext) || cached;
    if (out !== cached) {
      try { await fsp.mkdir(path.dirname(out), { recursive: true }); } catch { out = cached; } // a read-only footage drive
    }
    if (out !== cached && fs.existsSync(cached)) {
      // made into the cache by an earlier version: move it next to the footage instead of encoding again
      try { await moveFile(cached, out); } catch { out = cached; }
      this.set(handle.id, mediaId, { proxy: 'ready', proxyProgress: 1, proxyPath: out });
      return;
    }
    const tmp = out === cached ? this.cacheFile(handle, key, `proxy.tmp.${ext}`) : out.replace(/(\.\w+)$/, '.tmp$1');
    this.set(handle.id, mediaId, { proxy: 'running', proxyProgress: 0 });
    let args;
    if (meta.type === 'video' && ext === 'webm') {
      // transparent source: VP9 keeps the alpha channel (an H.264 proxy would turn it black)
      const gop = Math.max(1, Math.round((meta.fps || 30) / 3));
      args = ['-v', 'error', '-y', '-i', abs, '-map', '0:v:0', '-map', '0:a:0?', '-sn',
        '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuva420p",
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
        '-g', String(gop), '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1',
        '-c:a', 'libopus', '-b:a', '160k', '-ac', '2', '-progress', 'pipe:2', '-nostats', tmp];
    } else if (meta.type === 'video') {
      // short GOP (~1/3 s) so scrubbing a proxy seeks almost instantly
      const gop = Math.max(1, Math.round((meta.fps || 30) / 3));
      args = ['-v', 'error', '-y', '-i', abs, '-map', '0:v:0', '-map', '0:a:0?', '-sn',
        '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
        ...cpuH264(22, 'veryfast', 1280, 720), '-g', String(gop), '-keyint_min', String(gop),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:2', '-nostats', tmp];
    } else if (meta.type === 'audio') {
      args = ['-v', 'error', '-y', '-i', abs, '-vn', '-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:2', '-nostats', tmp];
    } else {
      args = ['-v', 'error', '-y', '-i', abs, '-frames:v', '1', tmp];
    }
    let last = 0;
    const onProg = progressParser(meta.duration || 0, (p) => {
      if (p - last > 0.02) { last = p; this.set(handle.id, mediaId, { proxyProgress: p }); }
    });
    const signal = this.signal(handle.id);
    try {
      await run(FFMPEG, args, { onStderr: onProg, signal });
      await fsp.rename(tmp, out);
      fsp.stat(out).then((s) => perflog.io('proxyW', s.size), () => {});
      this.set(handle.id, mediaId, { proxy: 'ready', proxyProgress: 1, proxyPath: out });
    } catch (err) {
      fsp.unlink(tmp).catch(() => {});
      if (signal.aborted) return; // the project was closed
      this.set(handle.id, mediaId, { proxy: 'error', error: `Proxy failed: ${err.message}` });
    }
  }

  // Copy known probe results onto a document (used when a client saves a doc that predates a fill).
  fillMeta(handle, doc) {
    const statuses = this.projectStatus(handle.id);
    for (const item of doc.media) {
      const st = statuses.get(item.id);
      if (st?.meta && st.abs === handle.resolve(item.path) && needsMetaPatch(item, st.meta)) Object.assign(item, metaFields(st.meta));
    }
  }

  // File to stream to the browser for preview playback.
  previewFile(handle, mediaId) {
    const st = this.get(handle.id, mediaId);
    if (!st || !st.exists) return null;
    if (st.proxy === 'ready') return st.proxyPath || this.cacheFile(handle, st.key, `proxy.${st.proxyExt}`);
    return st.abs;
  }
}

function proxyExtFor(meta) {
  return meta.type === 'video' ? (hasAlpha(meta.pixFmt) ? 'webm' : 'mp4') : meta.type === 'audio' ? 'm4a' : 'png';
}
function metaFields(meta) {
  const f = { type: meta.type, duration: meta.duration, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo, codec: meta.codec };
  if (meta.type !== 'audio') { f.width = meta.width; f.height = meta.height; }
  if (meta.type === 'video') f.fps = meta.fps;
  if (meta.type === 'video' && meta.timecode) f.timecode = meta.timecode; // start timecode, for XML exports
  if (meta.type !== 'image' && meta.sampleRate) f.sampleRate = meta.sampleRate;
  return f;
}
function needsMetaPatch(item, meta) {
  const f = metaFields(meta);
  return (item.timecode && !f.timecode) || Object.entries(f).some(([k, v]) => item[k] !== v && !(typeof v === 'number' && typeof item[k] === 'number' && Math.abs(v - item[k]) < 1e-3));
}
