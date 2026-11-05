// Render worker: runs in a headless browser (or a hidden iframe in the editor) and composites
// export frames with the exact same code as the live viewer. The server runs several of these pages
// side by side; each one renders one chunk of a timeline (or one still) at a time.
import { findSequence, flattenSequence, mediaMap, maxScaleOf, resolveFrame, transformAt, effectsAt } from './core/model.js';
import { composeFrame, OFFLINE } from './core/compositor.js';
import { ensureProjectFonts, prepareFontsForSequence } from './core/fonts.js';
import { prepareLutsForSequence } from './core/lut.js';

const query = new URLSearchParams(location.search);
const kind = query.get('worker') || 'ui';
const workerId = query.get('id') || 'ui';
const statusEl = document.getElementById('status');
const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };

// Source frames are requested this many output frames ahead, so decoding and transfer overlap with compositing.
const LOOKAHEAD = 3;

let ws = null;
let current = null;
let paused = false;
let resumeWaiters = [];
const pending = new Map(); // reqId -> { resolve, job }
let reqSeq = 1;
const imageCache = new Map(); // `${project}:${media}:${key}` -> image (kept across jobs)

function connect() {
  // direct: the app's render pages can decode and encode without sending frames over this socket
  const direct = window.jimmyDirect?.available ? '&direct=1' : '';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/render-worker?kind=${kind}&id=${workerId}${direct}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (current) stop(current);
    if (kind === 'headless') window.close();
    else setTimeout(connect, 2000);
  };
}

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

// End a job's loop wherever it is waiting.
function stop(job) {
  job.canceled = true;
  if (job.direct) window.jimmyDirect.closeAll();
  for (const [id, p] of pending) if (p.job === job) { pending.delete(id); p.resolve(null); }
  const w = job.ackWaiters;
  job.ackWaiters = [];
  w.forEach((fn) => fn());
  wake();
}
function wake() {
  const w = resumeWaiters;
  resumeWaiters = [];
  w.forEach((fn) => fn());
}

function onMessage(e) {
  if (e.data instanceof ArrayBuffer) {
    const id = new DataView(e.data).getUint32(0, true);
    const p = pending.get(id);
    pending.delete(id);
    p?.resolve(e.data);
    return;
  }
  const msg = JSON.parse(e.data);
  if (msg.type === 'job') {
    if (current) stop(current);
    paused = false;
    const job = { jobId: msg.spec.jobId, canceled: false, acked: 0, ackWaiters: [] };
    current = job;
    runJob(msg.spec, job).catch((err) => {
      console.error(err);
      if (!job.canceled) send({ type: 'error', jobId: job.jobId, message: String(err?.message || err) });
    }).finally(() => { if (current === job) { current = null; setStatus('Render worker idle'); } });
  } else if (msg.type === 'ack') {
    if (!current || current.jobId !== msg.jobId) return;
    current.acked = Math.max(current.acked, msg.n);
    const w = current.ackWaiters;
    current.ackWaiters = [];
    w.forEach((fn) => fn());
  } else if (msg.type === 'cancel') {
    if (current && current.jobId === msg.jobId) stop(current);
  } else if (msg.type === 'pause' || msg.type === 'resume') {
    if (!current || current.jobId !== msg.jobId) return;
    paused = msg.type === 'pause';
    if (!paused) wake();
  }
}

function requestFrame(job, req) {
  // direct: the page's own decoder (electron/worker-preload.cjs), from the file the server named
  if (job.direct) return window.jimmyDirect.frame(directReq(job, req), req.index).catch((err) => { if (!job.canceled) throw err; return null; });
  const reqId = reqSeq++;
  return new Promise((resolve) => {
    pending.set(reqId, { resolve, job });
    send({ type: 'decode', jobId: job.jobId, reqId, ...req });
  });
}

const directReq = (job, r) => ({ ...job.direct.files[r.mediaId], key: r.key, srcStart: r.srcStart, speed: r.speed, fps: job.direct.fps, w: r.w, h: r.h, crop: r.crop, threads: job.direct.threads, priority: job.direct.priority });

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(OFFLINE);
    img.src = url;
  });
}
async function cachedImage(projectId, mid, state) {
  if (!state?.previewReady) return OFFLINE;
  const k = `${projectId}:${mid}:${state.key || ''}:${state.previewReady}`;
  let p = imageCache.get(k);
  if (!p) {
    p = loadImage(`/media/${projectId}/${mid}/preview?k=${encodeURIComponent(state.key || '')}`);
    imageCache.set(k, p);
    if (imageCache.size > 80) imageCache.delete(imageCache.keys().next().value);
  }
  const img = await p;
  if (img === OFFLINE) imageCache.delete(k);
  return img;
}

function closeStream(job, key) {
  if (job.direct) window.jimmyDirect.close(key);
  else send({ type: 'closeStream', jobId: job.jobId, key });
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// The source frame a clip shows at sequence time t. The small bias keeps a clip that starts exactly half a frame
// off the grid from landing on either side of the rounding point from one frame to the next (which would repeat
// one source frame and skip another).
const frameIndex = (seq, c, t) => Math.max(0, Math.round((t - c.start) * seq.fps + 1e-4));

// The part of a video layer's picture (media px: [x0, y0, x1, y1]) that lands inside the frame: the frame's
// corners taken back through the layer's placement (as compositor.js drawLayer places it), widened for blur.
function visibleBox(l, tr, m, seq) {
  const c = l.clip;
  const w = m.width || seq.width, h = m.height || seq.height;
  const s = tr.scale * (l.scale || 1);
  if (!(Math.abs(s) > 1e-6)) return [0, 0, 0, 0];
  const sx = s * (c.transform?.flipH ? -1 : 1), sy = s * (c.transform?.flipV ? -1 : 1);
  const rad = (tr.rotation * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = seq.width / 2 + tr.x + (l.dx || 0), cy = seq.height / 2 + tr.y + (l.dy || 0);
  const pad = (3 * Math.max(0, effectsAt(c, l.localT).blur || 0) + 2) / Math.abs(s);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [X, Y] of [[0, 0], [seq.width, 0], [0, seq.height], [seq.width, seq.height]]) {
    const dx = X - cx, dy = Y - cy;
    const u = (dx * cos + dy * sin) / sx + w / 2, v = (-dx * sin + dy * cos) / sy + h / 2;
    x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v);
  }
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w, x1 + pad), Math.min(h, y1 + pad)];
}

// That box in decoded pixels ([x, y, w, h], with a margin for smoothing), or null when it is most of the picture.
function cropBox(box, fx, fy, w, h) {
  if (!box) return null;
  let x0 = Math.max(0, Math.floor(box[0] * fx) - 2), y0 = Math.max(0, Math.floor(box[1] * fy) - 2);
  let x1 = Math.min(w, Math.ceil(box[2] * fx) + 2), y1 = Math.min(h, Math.ceil(box[3] * fy) + 2);
  if (x1 - x0 < 2) { x1 = Math.min(w, x0 + 2); x0 = x1 - 2; }
  if (y1 - y0 < 2) { y1 = Math.min(h, y0 + 2); y0 = y1 - 2; }
  if ((x1 - x0) * (y1 - y0) > 0.85 * w * h) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

async function runJob(spec, job) {
  const project = spec.project;
  job.direct = spec.direct && window.jimmyDirect?.available ? spec.direct : null;
  if (job.direct) await window.jimmyDirect.openOutput(job.direct.port);
  const seq = flattenSequence(project, findSequence(project, spec.sequenceId)); // nested sequences render their contents
  const mediaById = mediaMap(project);
  setStatus(`Rendering ${seq.name}…`);

  await ensureProjectFonts(spec.projectId);
  await prepareFontsForSequence(seq);
  await prepareLutsForSequence(spec.projectId, seq);

  const images = new Map();
  await Promise.all([...new Set(seq.clips.filter((c) => c.type === 'image').map((c) => c.media))].map(async (mid) => {
    images.set(mid, await cachedImage(spec.projectId, mid, spec.media[mid]));
  }));
  if (job.canceled) return;

  const canvas = document.createElement('canvas');
  canvas.width = spec.width;
  canvas.height = spec.height;
  // opaque canvas: the frame is always filled with the background, and readback skips un-premultiplying.
  // Transparent exports (ProRes 4444) keep the alpha channel instead.
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: !!spec.transparent });
  const scale = spec.scale;
  const open = new Set();
  const perf = { decode: 0, compose: 0, read: 0, wait: 0, frames: 0 };
  const lap = (k, t0) => { const t = performance.now(); perf[k] += t - t0; return t; };

  // One pass over the job's frames first. For every video clip: the part of its picture that is ever on screen
  // (only that part is sent here: a punch-in on 4K footage shows about 1080p worth of it, a quarter of the pixels)
  // and the first and last frame it is needed for. It is decoded at the largest size the clip is ever drawn (as the
  // preview does), so a zoom looks the same whichever chunk it falls in.
  const plan = new Map(); // clip id -> { box, first, last, index, w, h, crop }
  for (let i = 0; i < spec.frameCount; i++) {
    const t = (spec.startFrame + i) / seq.fps;
    for (const tr of resolveFrame(seq, t)) {
      for (const l of tr.layers) {
        const c = l.clip;
        const m = mediaById[c.media];
        if (c.type !== 'video' || !m || !spec.media[c.media]?.exists) continue;
        let p = plan.get(c.id);
        if (!p) plan.set(c.id, p = { box: null, first: i, index: frameIndex(seq, c, t) });
        p.last = i;
        // a clip inside a nested sequence is drawn into the nest's own picture (the inner sequence's size × scale,
        // compositor.js), which is then moved as one layer: what it shows of the clip is what lands in that picture
        const frameOf = tr.track.nest ? { width: tr.track.nest.width, height: tr.track.nest.height } : seq;
        const b = visibleBox(l, transformAt(c, l.localT), m, frameOf);
        p.box = p.box ? [Math.min(p.box[0], b[0]), Math.min(p.box[1], b[1]), Math.max(p.box[2], b[2]), Math.max(p.box[3], b[3])] : b;
      }
    }
  }
  for (const [id, p] of plan) {
    const c = seq.clips.find((x) => x.id === id);
    const m = mediaById[c.media];
    const mw = m.width || seq.width, mh = m.height || seq.height;
    const factor = Math.min(1, maxScaleOf(c) * scale);
    p.w = even(mw * factor);
    p.h = even(mh * factor);
    p.crop = cropBox(p.box, p.w / mw, p.h / mh, p.w, p.h);
  }
  // Decoders take a moment to start (and seek): start every clip's now, so the later ones are ready when needed.
  if (spec.kind !== 'still') {
    for (const [id, p] of plan) {
      const c = seq.clips.find((x) => x.id === id);
      open.add(id);
      const req = { key: id, mediaId: c.media, srcStart: c.in || 0, speed: c.speed || 1, w: p.w, h: p.h, crop: p.crop, index: p.index };
      if (job.direct) window.jimmyDirect.prefetch(directReq(job, req), p.index);
      else send({ type: 'decode', jobId: job.jobId, reqId: 0, prefetch: true, ...req });
    }
  }

  // Fetch (decode + transfer) the source frames for output frame i. Requests go out ahead of time,
  // so the next frames are in flight while frame i is composited, read back and encoded.
  const prepare = (i) => {
    const t = (spec.startFrame + i) / seq.fps;
    const frame = resolveFrame(seq, t);
    const sources = new Map();
    const used = new Set();
    const reqs = [];
    for (const tr of frame) {
      for (const l of tr.layers) {
        const c = l.clip;
        if (c.type === 'image') sources.set(l, images.get(c.media) || OFFLINE);
        if (c.type !== 'video') continue;
        const p = plan.get(c.id);
        if (!p) { sources.set(l, OFFLINE); continue; }
        const { w, h, crop } = p;
        const [bw, bh] = crop ? [crop[2], crop[3]] : [w, h];
        used.add(c.id);
        open.add(c.id);
        reqs.push(requestFrame(job, { key: c.id, mediaId: c.media, srcStart: c.in || 0, speed: c.speed || 1, w, h, crop, index: frameIndex(seq, c, t) })
          .then(async (buf) => {
            if (!buf) return;
            const img = new ImageData(new Uint8ClampedArray(buf, 4, bw * bh * 4), bw, bh);
            const bmp = await createImageBitmap(img);
            // the compositor draws it where that part sits in the whole picture
            if (crop) bmp.region = { x: crop[0], y: crop[1], w: bw, h: bh, fw: w, fh: h };
            sources.set(l, bmp);
          }));
      }
    }
    return { t, frame, sources, used, ready: Promise.all(reqs) };
  };

  const ahead = [];
  let nextIndex = 0;
  const fill = () => { while (ahead.length < LOOKAHEAD && nextIndex < spec.frameCount) ahead.push(prepare(nextIndex++)); };
  fill();
  for (let i = 0; i < spec.frameCount; i++) {
    while (paused && !job.canceled) await new Promise((r) => resumeWaiters.push(r));
    if (job.canceled) return;
    if (spec.testFreeze && i === 10) for (;;); // tests/chunk-stall.mjs: a page that freezes without disconnecting
    const cur = ahead.shift();
    let tp = performance.now();
    await cur.ready;
    if (job.canceled) return;
    tp = lap('decode', tp);
    if (spec.kind !== 'still') fill();
    const { t, frame, sources } = cur;
    for (const key of [...open]) {
      if (!((plan.get(key)?.last ?? -1) >= i || cur.used.has(key) || ahead.some((a) => a.used.has(key)))) { closeStream(job, key); open.delete(key); }
    }
    const env = { seq, mediaById, t, scale, frame, projectId: spec.projectId, transparent: !!spec.transparent, getSource: (l) => sources.get(l) || null };
    composeFrame(ctx, env);
    for (const v of sources.values()) if (v && v !== OFFLINE && typeof v.close === 'function') v.close();

    if (spec.kind === 'still') {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const png = await blob.arrayBuffer();
      if (job.canceled) return;
      send({ type: 'frame', jobId: job.jobId });
      ws.send(png);
      return;
    }
    tp = lap('compose', tp);
    const data = ctx.getImageData(0, 0, spec.width, spec.height).data;
    tp = lap('read', tp);
    if (job.direct) {
      await window.jimmyDirect.write(data.buffer);
      if (job.canceled) return;
      job.acked = i + 1;
      if (i % 5 === 4 || i + 1 === spec.frameCount) send({ type: 'progress', jobId: job.jobId, n: i + 1 });
    } else {
      while (i + 1 - job.acked > 3 && !job.canceled) await new Promise((r) => job.ackWaiters.push(r));
      if (job.canceled) return;
      send({ type: 'frame', jobId: job.jobId });
      ws.send(data.buffer);
    }
    lap('wait', tp);
    perf.frames++;
    if (i % 30 === 0) setStatus(`Rendering ${seq.name}: frame ${i + 1}/${spec.frameCount}`);
  }
  while (job.acked < spec.frameCount && !job.canceled) await new Promise((r) => job.ackWaiters.push(r));
  if (job.canceled) return;
  for (const key of open) closeStream(job, key);
  if (job.direct) await window.jimmyDirect.endOutput();
  if (job.canceled) return;
  send({ type: 'done', jobId: job.jobId, perf });
}

connect();
