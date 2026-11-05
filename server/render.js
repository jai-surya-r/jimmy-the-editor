// Export pipeline.
//   ffmpeg (decode, exact frames, any codec) ──raw RGBA──▶ render worker page (the same compositor
//   as the live preview, running in headless Chrome/Edge) ──composited RGBA──▶ ffmpeg (encode)
// The timeline is rendered in chunks (server/chunks.js): several worker pages render different chunks
// side by side, each chunk is kept as its own file, and an export stitches the chunk files together and
// mixes the audio. Chunks that are already on disk — from an earlier export or from background
// pre-rendering (server/prerender.js) — are reused as they are.
// Stills (vedit frame) have a worker page of their own, so they never wait behind an export.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { FFMPEG, FFPROBE, perf, renderSlots, withThreads, lowerPriority, HAS_X264, HEVC_CPU, cpuH264, cpuH264Rate, cpuHevc } from './ffmpeg.js';
import { planSequence, writeSpec, touch } from './chunks.js';
import { DecodeStream } from './decodestream.js';
import { sanitizeFolderName, toPosix, existsRecently } from './util.js';
import { getConfig } from './config.js';
import { tempRoot } from './cachedir.js';
import { budget } from './budget.js';
import { perflog } from './perflog.js';
import { engineFor, encoderArgs, decodePlan, gpuFailed } from './gpu.js';
import { appHost, workerHostCommand } from './apphost.js';
import {
  fpsRational, findSequence, flattenSequence, sequenceDuration, mediaMap, audibleTracks, uid, timecode, isBezierSeg, segmentValue,
} from '../public/js/core/model.js';

// Output formats. ProRes 4444 + alpha keeps the alpha channel: the sequence background is left transparent.
// profile: prores_ks's (0 Proxy, 1 LT, 2 422, 3 HQ, 4 4444). H.264 and H.265 may also go in a .mov (Export › Container).
export const FORMATS = {
  h264: { ext: 'mp4', label: 'H.264', codec: 'h264' },
  hevc: { ext: 'mp4', label: 'H.265 (HEVC)', codec: 'hevc' },
  prores: { ext: 'mov', label: 'ProRes 422 HQ', codec: 'prores', profile: 3 },
  prores422: { ext: 'mov', label: 'ProRes 422', codec: 'prores', profile: 2 },
  proreslt: { ext: 'mov', label: 'ProRes 422 LT', codec: 'prores', profile: 1 },
  proresproxy: { ext: 'mov', label: 'ProRes 422 Proxy', codec: 'prores', profile: 0 },
  prores4444o: { ext: 'mov', label: 'ProRes 4444', codec: 'prores', profile: 4 },
  prores4444: { ext: 'mov', label: 'ProRes 4444 + alpha', codec: 'prores', profile: 4, alpha: true },
};
// Frame rates an export may be converted to (Export › Frame rate); anything else keeps the sequence's
export const EXPORT_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

// An export's file name as typed (Export › File name): without the extension if that was typed too, made safe for
// every file system. Empty: the caller's default name.
function outputBase(name, ext) {
  const n = String(name || '').trim();
  const bare = n.toLowerCase().endsWith(`.${ext}`) ? n.slice(0, -ext.length - 1).trim() : n;
  return bare ? sanitizeFolderName(bare) : '';
}
const QUALITY = {
  high: { crf: 17, preset: 'medium', abitrate: '256k' },
  standard: { crf: 20, preset: 'fast', abitrate: '192k' },
  draft: { crf: 26, preset: 'veryfast', abitrate: '128k' },
};

export function findBrowser() {
  if (process.env.JIMMY_NO_SYSTEM_BROWSER === '1') return null; // tests: act as if none were installed
  const env = process.env.CLAUDE_EDIT_BROWSER;
  const candidates = [
    env,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ...['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].flatMap((n) => [`/Applications/${n}.app/Contents/MacOS/${n}`, path.join(os.homedir(), 'Applications', `${n}.app/Contents/MacOS/${n}`)]),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Headless browsers run beside the user's own Chrome: keep them off the macOS Keychain (otherwise each new
// profile can ask to use "Chrome Safe Storage"), and away from background services, updates and crash reporting.
const QUIET_BROWSER_FLAGS = [
  '--use-mock-keychain', '--password-store=basic', '--no-service-autorun', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-breakpad', '--disable-crash-reporter',
];
// Off Windows the browser gets its own process group, so killBrowser also ends its helper processes
// (GPU, renderers, crash handler) instead of leaving them behind.
export function spawnBrowser(exe, args) {
  return spawn(exe, [...QUIET_BROWSER_FLAGS, ...args], { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
}
// sync: the server is exiting (on Windows a taskkill started in the background would end with it, browsers left running)
// tree: a page that froze doesn't end with its browser (and keeps a processor core and its ffmpeg): take everything.
export function killBrowser(p, sync = false, tree = false) {
  if (!p || p.exitCode != null) return;
  // the desktop app's own worker (apphost.js): Chromium ends its helper processes along with it, and it would end
  // by itself once the app is gone, so no blocking taskkill of the tree
  if (p.appWorker && !tree) { try { p.kill(); } catch { /* already gone */ } return; }
  if (process.platform === 'win32') {
    const args = ['/PID', String(p.pid), '/T', '/F'];
    // the whole tree (helpers too); then the browser itself directly, in case taskkill could not reach it
    const direct = () => { try { if (p.exitCode == null) p.kill(); } catch { /* already gone */ } };
    if (sync) { try { execFileSync('taskkill', args, { stdio: 'ignore', timeout: 4000, windowsHide: true }); } catch { /* reported below */ } direct(); } else execFile('taskkill', args, { windowsHide: true }, direct);
    return;
  }
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
}

// ------------------------------------------------------------------ decode streams: server/decodestream.js

// A port nobody listens on, for an encoder to listen on
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// ------------------------------------------------------------------ audio mix graph

function atempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-6) return '';
  const parts = [];
  let s = speed;
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  while (s > 2) { parts.push(2); s /= 2; }
  parts.push(s);
  return parts.map((x) => `,atempo=${x.toFixed(6)}`).join('');
}

const EASE_EXPR = {
  linear: (p) => p,
  easeIn: (p) => `pow(${p},3)`,
  easeOut: (p) => `(1-pow(1-${p},3))`,
  easeInOut: (p) => `if(lt(${p},0.5),4*pow(${p},3),1-pow(-2*${p}+2,3)/2)`,
  hold: () => '0',
};
// Bezier (graph-editor) segments become short straight pieces: ffmpeg expressions can't solve the curve.
function flattenBezier(kfs) {
  const out = [];
  for (let i = 0; i < kfs.length; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (!b || !isBezierSeg(a, b)) { out.push({ t: a.t, v: a.v, ease: a.ease }); continue; }
    const n = 12;
    for (let j = 0; j < n; j++) {
      const t = a.t + ((b.t - a.t) * j) / n;
      out.push({ t, v: segmentValue(a, b, t), ease: 'linear' });
    }
  }
  return out;
}
function keyframeExpr(kfs, T, fallback) {
  if (!kfs?.length) return String(fallback);
  kfs = flattenBezier(kfs);
  let expr = String(kfs[kfs.length - 1].v);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    const p = `((${T}-${a.t})/${Math.max(1e-6, b.t - a.t)})`;
    const seg = `(${a.v}+(${b.v - a.v})*${(EASE_EXPR[a.ease] || EASE_EXPR.linear)(p)})`;
    expr = `if(lt(${T},${b.t}),${seg},${expr})`;
  }
  return `if(lt(${T},${kfs[0].t}),${kfs[0].v},${expr})`;
}

// A clip's gain at local time T (an ffmpeg expression): volume, keyframes and fades, times those of the nested
// audio clips it plays through (model.js flattenSequence: clip.gains, each placed on the same timeline).
function gainExpr(c, T) {
  let g = keyframeExpr(c.keyframes?.volume, T, c.volume ?? 1);
  if (c.fadeIn > 0) g += `*min(1,max(0,${T}/${c.fadeIn}))`;
  if (c.fadeOut > 0) g += `*min(1,max(0,(${c.duration}-${T})/${c.fadeOut}))`;
  for (const p of c.gains || []) {
    const d = c.start - p.start;
    g += `*${gainExpr(p, `(${T}${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(6)})`)}`;
  }
  return g;
}

// One long filter graph with every clip as an input. Exports use mixAudio; this stays as tests/audio-export.mjs's reference.
export function buildAudioGraph(handle, seq, t0, t1, inputOffset) {
  const mediaById = mediaMap(handle.doc);
  const tracks = audibleTracks(seq);
  const trackById = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const total = Math.max(0.001, t1 - t0);
  const inputs = [];
  const parts = [`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(6)}[abase]`];
  const labels = ['[abase]'];
  let n = 0;
  for (const c of seq.clips) {
    if (c.type !== 'audio' || c.enabled === false || !trackById[c.track]) continue;
    const media = mediaById[c.media];
    const file = media && handle.resolve(media.path);
    if (!file || !existsRecently(file) || media.hasAudio === false) continue;
    const a = Math.max(c.start, t0), b = Math.min(c.start + c.duration, t1);
    if (b - a < 1e-3) continue;
    const localStart = a - c.start;
    const speed = c.speed || 1;
    const srcStart = (c.in || 0) + localStart * speed;
    const srcDur = (b - a) * speed;
    const idx = inputOffset + n;
    inputs.push('-ss', srcStart.toFixed(6), '-t', (srcDur + 0.1).toFixed(6), '-i', file);
    const T = `(t+${localStart.toFixed(6)})`;
    const gain = `${trackById[c.track].volume}*${gainExpr(c, T)}`;
    parts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS${atempoChain(speed)},atrim=0:${(b - a).toFixed(6)},volume='${gain}':eval=frame,adelay=${Math.round((a - t0) * 1000)}:all=1[a${n}]`);
    labels.push(`[a${n}]`);
    n++;
  }
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0:dropout_transition=0[aout]`);
  return { inputs, graph: parts.join(';\n') };
}

// Every export's audio mix, whatever the number of clips (each clip cut with "-ss … -i", as buildAudioGraph does),
// built for speed:
// - clips that don't overlap play one after another in a "lane" (with silence between them), so the final mix adds
//   a few lanes instead of one full-length stream per clip; positions are whole samples from the start, so nothing
//   drifts however many clips a lane has;
// - each lane is cut into batches of clips that ffmpeg mixes side by side, one per CPU core, into temporary
//   32-bit float WAVs (a batch also keeps its command line well under Windows' 32K limit), the sources' video
//   streams skipped;
// - a last pass lays the batches out on the timeline and encodes the chosen format.
export const AUDIO_FORMATS = {
  wav24: { ext: 'wav', mux: 'wav', label: 'WAV 24-bit', codec: ['-c:a', 'pcm_s24le'] },
  wav16: { ext: 'wav', mux: 'wav', label: 'WAV 16-bit', codec: ['-c:a', 'pcm_s16le'] },
  flac: { ext: 'flac', mux: 'flac', label: 'FLAC', codec: ['-c:a', 'flac', '-compression_level', '1', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] },
  mp3: { ext: 'mp3', mux: 'mp3', label: 'MP3 320k', codec: ['-c:a', 'libmp3lame', '-b:a', '320k'] },
  aac: { ext: 'm4a', mux: 'ipod', label: 'AAC 256k', codec: ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'] },
};
const MIX_RATE = 48000;
const BATCH_CLIPS = 40; // clips per batch, at most
const BATCH_CHARS = 20000; // command-line characters per batch, at most

// a file name inside a filter script, escaped twice: for the option (\ : ') and then for the graph (\ ' [ ] , ;)
const filterPath = (f) => toPosix(f).replace(/[\\:']/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&');

// The clips of [t0, t1] in lanes and batches. Sample positions count from t0.
export function planAudioMix(handle, seq, t0, t1) {
  const mediaById = mediaMap(handle.doc);
  const trackById = Object.fromEntries(audibleTracks(seq).map((t) => [t.id, t]));
  const S = (t) => Math.round((t - t0) * MIX_RATE);
  const items = [];
  for (const c of seq.clips) {
    if (c.type !== 'audio' || c.enabled === false || !trackById[c.track]) continue;
    const media = mediaById[c.media];
    const file = media && handle.resolve(media.path);
    if (!file || !existsRecently(file) || media.hasAudio === false) continue;
    const a = Math.max(c.start, t0), b = Math.min(c.start + c.duration, t1);
    if (S(b) - S(a) < 1) continue;
    items.push({ c, file, a, b, from: S(a), to: S(b), gain: trackById[c.track].volume });
  }
  items.sort((x, y) => x.from - y.from);
  const lanes = [];
  for (const it of items) {
    const lane = lanes.find((l) => l.end <= it.from) || lanes[lanes.push({ end: 0, items: [] }) - 1];
    lane.items.push(it);
    lane.end = it.to;
  }
  const batches = [];
  lanes.forEach((lane, li) => {
    let cur = null;
    for (const it of lane.items) {
      const chars = it.file.length + 60;
      if (!cur || cur.items.length >= BATCH_CLIPS || cur.chars + chars > BATCH_CHARS) batches.push(cur = { lane: li, items: [], chars: 0 });
      cur.items.push(it);
      cur.chars += chars;
    }
  });
  for (const bt of batches) { bt.from = bt.items[0].from; bt.to = bt.items[bt.items.length - 1].to; }
  return { total: Math.max(1, S(t1)), lanes: lanes.length, clips: items.length, batches };
}

// One batch: its clips in a row, silence between them, from the batch's first sample to its last.
export function batchArgs(bt, out) {
  const inputs = [];
  const parts = [];
  const segs = [];
  let pos = bt.from;
  bt.items.forEach(({ c, file, a, b, from, to, gain: trackGain }, n) => {
    if (from > pos) { parts.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=end_sample=${from - pos}[g${n}]`); segs.push(`[g${n}]`); }
    const len = to - from;
    const localStart = a - c.start;
    const speed = c.speed || 1;
    inputs.push('-vn', '-sn', '-dn', '-ss', ((c.in || 0) + localStart * speed).toFixed(6), '-t', ((b - a) * speed + 0.1).toFixed(6), '-i', file);
    const T = `(t+${localStart.toFixed(6)})`;
    const gain = `${trackGain}*${gainExpr(c, T)}`;
    // padded, then cut to the exact length: a source that ends early doesn't pull the next clip forward
    parts.push(`[${n}:a]aformat=sample_rates=${MIX_RATE}:channel_layouts=stereo,asetpts=PTS-STARTPTS${atempoChain(speed)},apad=whole_len=${len},atrim=end_sample=${len},volume='${gain}':eval=frame[c${n}]`);
    segs.push(`[c${n}]`);
    pos = to;
  });
  parts.push(segs.length > 1 ? `${segs.join('')}concat=n=${segs.length}:v=0:a=1[aout]` : `${segs[0]}anull[aout]`);
  return { inputs, graph: parts.join(';\n'), out };
}

// The last pass: every lane's batches (WAV files, read from their start, so no seeking) in place, mixed.
export function finalMixGraph(plan, files) {
  const parts = [];
  const lanes = [];
  for (let li = 0; li < plan.lanes; li++) {
    const segs = [];
    let pos = 0;
    plan.batches.forEach((bt, bi) => {
      if (bt.lane !== li) return;
      if (bt.from > pos) { parts.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=end_sample=${bt.from - pos}[g${bi}]`); segs.push(`[g${bi}]`); }
      parts.push(`amovie=${filterPath(files[bi])},atrim=end_sample=${bt.to - bt.from}[b${bi}]`);
      segs.push(`[b${bi}]`);
      pos = bt.to;
    });
    parts.push(segs.length > 1 ? `${segs.join('')}concat=n=${segs.length}:v=0:a=1[l${li}]` : `${segs[0]}anull[l${li}]`);
    lanes.push(`[l${li}]`);
  }
  const T = plan.total;
  if (!lanes.length) parts.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=end_sample=${T}[aout]`);
  else if (lanes.length === 1) parts.push(`[l0]apad=whole_len=${T},atrim=end_sample=${T}[aout]`);
  else parts.push(`anullsrc=r=${MIX_RATE}:cl=stereo,atrim=end_sample=${T}[abase]`, `[abase]${lanes.join('')}amix=inputs=${lanes.length + 1}:duration=first:normalize=0:dropout_transition=0[aout]`);
  return parts.join(';\n');
}

// Runs the whole mix into `out` (format: AUDIO_FORMATS key, or { codec, mux } for a raw stream).
// onProgress(0..1); returns { kill } through `ctl` so a cancel can stop every ffmpeg.
export async function mixAudio(handle, seq, t0, t1, out, fmt, { tmpBase, onProgress = () => {}, ctl = {} } = {}) {
  const plan = planAudioMix(handle, seq, t0, t1);
  const procs = new Set();
  ctl.kill = () => { ctl.killed = true; for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
  const ffmpeg = (args, onOut) => new Promise((resolve, reject) => {
    if (ctl.killed) { reject(new Error('canceled')); return; }
    const p = spawn(FFMPEG, args, { windowsHide: true });
    procs.add(p);
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    if (onOut) p.stdout.on('data', onOut);
    p.on('error', (e) => { procs.delete(p); reject(e); });
    p.on('close', (code) => { procs.delete(p); code === 0 ? resolve() : reject(new Error(ctl.killed ? 'canceled' : err.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`)); });
  });
  const temps = [];
  const work = plan.batches.reduce((s, b) => s + (b.to - b.from), 0) || 1;
  let done = 0;
  const share = plan.batches.length ? 0.85 : 0; // the batches are most of the work
  try {
    const files = plan.batches.map((_, i) => `${tmpBase}-b${i}.wav`);
    temps.push(...files);
    let next = 0;
    const lane = async () => {
      while (next < plan.batches.length) {
        const i = next++;
        const bt = plan.batches[i];
        const { inputs, graph } = batchArgs(bt, files[i]);
        const gf = `${files[i]}.filter`;
        temps.push(gf);
        await fsp.writeFile(gf, graph);
        await ffmpeg(['-v', 'error', '-y', '-threads', '1', ...inputs, '-/filter_complex', gf, '-map', '[aout]', '-c:a', 'pcm_f32le', '-f', 'wav', files[i]]);
        done += bt.to - bt.from;
        onProgress((done / work) * share);
      }
    };
    const width = Math.max(1, Math.min(plan.batches.length, os.cpus().length, 12));
    await Promise.all(Array.from({ length: width }, lane));
    const gf = `${tmpBase}-mix.filter`;
    temps.push(gf);
    await fsp.writeFile(gf, finalMixGraph(plan, files));
    let buf = '';
    await ffmpeg(['-v', 'error', '-y', '-/filter_complex', gf, '-map', '[aout]', '-ar', String(MIX_RATE), ...fmt.codec, '-progress', 'pipe:1', '-nostats', '-f', fmt.mux, out], (d) => {
      buf = (buf + d).slice(-400);
      const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop();
      if (m) onProgress(share + (1 - share) * Math.min(1, +m[1] / 1e6 / (plan.total / MIX_RATE)));
    });
    return plan;
  } finally {
    for (const f of temps) fsp.unlink(f).catch(() => {});
  }
}

// Export options beyond format, quality and size, checked: rate and container go into the chunk spec (outputSpec);
// fps (a frame rate to convert to) and audioOut ({ codec: aac | pcm16 | pcm24 | none, kbps, rate }) apply when the
// chunks are joined (stitch). Browsers play only H.264 MP4s, so only those can become review versions.
function exportExtras(opts, seq, format) {
  const fmt = FORMATS[format];
  const lossy = fmt.codec !== 'prores';
  const container = lossy && opts.container === 'mov' ? 'mov' : null;
  const fps = EXPORT_RATES.find((r) => Math.abs(r - +opts.fps) < 0.001 && Math.abs(r - seq.fps) > 0.001) || null;
  let audioOut = null;
  const a = opts.audioOut;
  if (a && typeof a === 'object') {
    const mp4 = lossy && !container;
    let codec = ['aac', 'pcm16', 'pcm24', 'none'].includes(a.codec) ? a.codec : 'aac';
    if (mp4 && codec.startsWith('pcm')) codec = 'aac'; // MP4 can't hold PCM
    audioOut = { codec, kbps: [128, 192, 256, 320].includes(+a.kbps) ? +a.kbps : 256, rate: +a.rate === 44100 ? 44100 : 48000 };
  }
  const mbps = +opts.rate?.mbps;
  return {
    rate: lossy && mbps > 0 ? { mbps: Math.min(500, Math.max(0.1, mbps)), cbr: !!opts.rate.cbr } : null,
    container, fps, audioOut,
    addVersion: format === 'h264' && !container ? opts.addVersion : false,
  };
}

// What a chunk file is: frame size, codec and encoder settings. Chunks made with different specs never mix.
// rate: { mbps, cbr } (Export › Bitrate, H.264 / H.265) instead of the quality's; container: 'mov' puts them in a .mov.
export function outputSpec(seq, { quality, format, scale, rate, container }) {
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const fmt = FORMATS[format] || FORMATS.h264;
  const q = QUALITY[quality] || QUALITY.high;
  const lossy = fmt.codec !== 'prores';
  const spec = {
    format: FORMATS[format] ? format : 'h264', ext: lossy && container === 'mov' ? 'mov' : fmt.ext, transparent: !!fmt.alpha,
    width: even(seq.width * scale), height: even(seq.height * scale),
    crf: lossy ? q.crf : null, preset: lossy ? q.preset : null,
    // OpenH264 chunks get their own cache key (x264 specs stay exactly as before): the two never get stitched together
    ...(fmt.codec === 'h264' && !HAS_X264 ? { cpuEnc: 'openh264' } : {}),
    ...(fmt.codec === 'hevc' && HEVC_CPU !== 'x265' ? { cpuEnc: HEVC_CPU || 'none' } : {}),
  };
  const mbps = +rate?.mbps;
  if (lossy && mbps > 0) spec.rate = { kbps: Math.round(Math.min(500, Math.max(0.1, mbps)) * 1000), cbr: !!rate.cbr };
  // GPU (Settings > Hardware acceleration): CPU-only specs stay exactly as before, so their caches stay valid
  const eng = engineFor(QUALITY[quality] ? quality : 'high', spec.format, spec);
  if (eng.enc) Object.assign(spec, { enc: eng.enc, quality: QUALITY[quality] ? quality : 'high' });
  if (eng.dec) spec.dec = eng.dec;
  return spec;
}
export const poolOf = (spec) => (spec?.enc ? 'gpu' : 'cpu');

function videoCodecArgs(spec) {
  const gpu = encoderArgs(spec);
  if (gpu) {
    return [
      '-vf', `scale=out_color_matrix=bt709:out_range=tv,format=${gpu.pix}`, ...gpu.args,
      ...(spec.format === 'hevc' ? ['-tag:v', 'hvc1'] : []), // so QuickTime and Apple devices play it
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ];
  }
  const fmt = FORMATS[spec.format] || FORMATS.h264;
  const pixFmt = fmt.codec !== 'prores' ? 'yuv420p' : fmt.profile < 4 ? 'yuv422p10le' : fmt.alpha ? 'yuva444p10le' : 'yuv444p10le';
  const codec = {
    h264: () => [...(spec.rate ? cpuH264Rate(spec.preset, spec.rate) : cpuH264(spec.crf, spec.preset, spec.width, spec.height)), '-pix_fmt', 'yuv420p'],
    hevc: () => [...cpuHevc(spec.crf, spec.preset, spec.rate), '-pix_fmt', 'yuv420p'],
    prores: () => ['-c:v', 'prores_ks', '-profile:v', fmt.alpha ? '4444' : String(fmt.profile), '-pix_fmt', pixFmt, '-vendor', 'apl0', ...(fmt.alpha ? ['-alpha_bits', '16'] : [])],
  }[fmt.codec]();
  return [
    '-vf', `scale=out_color_matrix=bt709:out_range=tv,format=${pixFmt}`, ...codec,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  ];
}

const FINISHED = ['done', 'error', 'canceled'];
// A classic chunk whose page makes no progress for this long is stopped and rendered again (tests shorten it). Generous:
// a heavy frame can take many seconds, and pages report every 5 frames. JIMMY_TEST_FREEZE_CHUNK=once|always freezes the
// page of the first chunk (tests/chunk-stall.mjs).
const CHUNK_STALL_MS = Number(process.env.JIMMY_CHUNK_STALL_MS) || 180000;
const WORKER_LOST = 'Render worker disconnected';
const TEST_FREEZE_CHUNK = process.env.JIMMY_TEST_FREEZE_CHUNK || '';

// ------------------------------------------------------------------ manager

export class RenderManager {
  constructor({ media, motion, port, emitAll }) {
    this.media = media;
    this.motion = motion;
    this.port = port;
    this.emitAll = emitAll;
    this.launchHold = {}; // role -> time until which no new worker is started (the last one died while starting)
    this.jobs = new Map(); // exports and stills, as shown in the editor's job list
    this.tasks = new Map(); // key -> task: one chunk (key = its file) or one still, queued or running
    this.queue = [];
    this.order = 0;
    this.workers = []; // { id, role: chunk | still | any, kind: headless | ui, proc, ws, task, streams, paused }
    this.bgPaused = false;
    this.idleTimer = null;
    // exports encoding on the CPU take a slot from graphics; ones on the GPU barely touch the CPU
    const cpuExport = (t) => t?.kind === 'chunk' && t.owners.size && !t.spec?.enc;
    budget.exportsActive = () => this.workers.some((w) => cpuExport(w.task)) || this.queue.some(cpuExport);
    budget.onChange(() => this.pump());
    // One export at a time. On the CPU it takes turns with the graphics (whoever asked first goes first); on the
    // GPU it runs beside them.
    const onCpu = (j) => j && poolOf(j.spec) === 'cpu';
    budget.cpuExportBusy = () => { const cur = this.currentExport(); return onCpu(cur) && !!cur.started; };
    budget.exportWaitingSince = () => { const cur = this.currentExport(); return onCpu(cur) && !cur.started ? cur.createdAt : null; };
    budget.onWork(() => this.pump());
    // what exports and pre-rendering wait with, for the scheduler: chunks queued or rendering (a pool holds 4 at most)
    const chunkDemand = (bg) => {
      let want = 0, since = null;
      for (const t of [...this.queue, ...this.workers.map((w) => w.task)]) {
        if (t?.kind !== 'chunk') continue;
        const exp = this.live(t);
        if (bg ? exp.length || !t.bg : !exp.length) continue;
        want++;
        for (const j of exp) since = since == null ? j.createdAt : Math.min(since, j.createdAt);
      }
      return want ? { want: Math.min(want, 8), waitingSince: since } : null;
    };
    budget.demand.export = () => chunkDemand(false);
    budget.demand.prerender = () => chunkDemand(true);
  }

  publicJob(j) {
    return {
      id: j.id, projectId: j.projectId, kind: j.kind, status: j.status, progress: j.progress, eta: j.eta,
      sequenceId: j.sequenceId, sequenceName: j.sequenceName, output: j.output, outputRel: j.outputRel,
      error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt, versionId: j.versionId, label: j.label,
      projectName: j.handle?.doc?.name || (j.handle?.dir ? path.basename(j.handle.dir) : ''),
      quality: j.opts.quality, format: j.opts.format, frames: j.frameCount, reused: j.reused || 0, paused: !!j.held, engine: j.engine || null,
      waiting: j.waiting || null, converting: j.converting || null,
    };
  }
  list() {
    return [...this.jobs.values()].map((j) => this.publicJob(j)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  }
  update(j, patch) {
    Object.assign(j, patch);
    if (j.opts?.quiet) return; // the Viewer's exact frames aren't jobs anyone asked for
    this.emitAll({ type: 'job', job: this.publicJob(j) });
  }

  // opts: { sequenceId, quality, scale, range: [a,b] | 'inout' | null, name, addVersion, time (stills), out,
  //         maxSide (stills: longest side in px, used when no scale is given) }
  async create(handle, kind, opts = {}) {
    const doc = handle.doc;
    // nested sequences render (and their sound plays) as their contents
    const seq = flattenSequence(doc, findSequence(doc, opts.sequenceId) || doc.sequences[0]);
    if (!seq) throw Object.assign(new Error('Project has no sequences'), { status: 400 });
    const fps = seq.fps;
    let t0 = 0, t1 = sequenceDuration(seq);
    if (Array.isArray(opts.range)) { t0 = Math.max(0, +opts.range[0] || 0); t1 = Math.min(t1, +opts.range[1] || t1); }
    else if (opts.range === 'inout' && seq.inPoint != null && seq.outPoint != null && seq.outPoint > seq.inPoint) { t0 = seq.inPoint; t1 = seq.outPoint; }
    if (kind !== 'still' && t1 - t0 < 1 / fps) throw Object.assign(new Error('Nothing to render: the sequence is empty'), { status: 400 });
    if (kind === 'audio') return this.createAudio(handle, seq, t0, t1, opts);
    const quality = QUALITY[opts.quality] ? opts.quality : 'high';
    const format = FORMATS[opts.format] ? opts.format : 'h264';
    const fit = kind === 'still' && +opts.maxSide > 0 ? +opts.maxSide / Math.max(seq.width, seq.height) : 0;
    // a video export may also be made bigger than its sequence (Export › Resolution), up to 8K
    const maxScale = kind === 'video' ? Math.min(4, 8192 / Math.max(seq.width, seq.height)) : 1;
    let scale = Math.max(0.1, Math.min(maxScale, +opts.scale || fit || 1));
    // a draft is the size asked for (Export › Resolution, the sequence's by default): it differs from High in its
    // bitrate and encoder speed (QUALITY.draft, gpu.js draft settings), not its size
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    const job = {
      id: uid('job'), projectId: handle.id, kind, status: 'queued', progress: 0, eta: null,
      sequenceId: seq.id, sequenceName: seq.name, createdAt: Date.now(),
      // browsers can't play ProRes, so those exports don't become review versions
      opts: { ...opts, quality, scale, format, ...exportExtras(opts, seq, format) },
      startFrame: Math.round(t0 * fps), frameCount: kind === 'still' ? 1 : Math.max(1, Math.round((t1 - t0) * fps)),
      width: kind === 'still' ? Math.max(1, Math.round(seq.width * scale)) : even(seq.width * scale),
      height: kind === 'still' ? Math.max(1, Math.round(seq.height * scale)) : even(seq.height * scale),
      t0, t1, label: kind === 'still' ? `Frame ${timecode(+opts.time || 0, fps)}` : `${seq.name}${quality === 'draft' ? ' (draft)' : ''}${format !== 'h264' ? ` · ${FORMATS[format].label}` : ''}`,
      handle, doc: JSON.parse(JSON.stringify(doc)), // snapshot: later edits don't affect a running export
      tasks: [], reused: 0,
    };
    if (kind === 'still') job.startFrame = Math.round((+opts.time || 0) * fps);
    job.done = new Promise((resolve) => { job.resolveDone = resolve; });
    this.jobs.set(job.id, job);
    this.update(job, {});
    if (!opts.quiet) perflog.event('exportStart', { id: job.id, kind, label: job.label, quality, format, frames: job.frameCount });
    if (kind === 'still') this.queueStill(job);
    else this.runExport(job);
    return job;
  }

  // opts.audio: a key of AUDIO_FORMATS. Starts right away: it needs no render slots, only one ffmpeg.
  createAudio(handle, seq, t0, t1, opts) {
    const audio = AUDIO_FORMATS[opts.audio] ? opts.audio : 'aac';
    const job = {
      id: uid('job'), projectId: handle.id, kind: 'audio', status: 'running', progress: 0, eta: null,
      sequenceId: seq.id, sequenceName: seq.name, createdAt: Date.now(), startedAt: Date.now(),
      opts: { ...opts, audio, format: audio, quality: null, addVersion: false },
      startFrame: Math.round(t0 * seq.fps), frameCount: Math.max(1, Math.round((t1 - t0) * seq.fps)),
      t0, t1, label: `${seq.name} · ${AUDIO_FORMATS[audio].label}`, engine: 'audio only',
      handle, doc: JSON.parse(JSON.stringify(handle.doc)), tasks: [], reused: 0,
    };
    job.done = new Promise((resolve) => { job.resolveDone = resolve; });
    this.jobs.set(job.id, job);
    this.update(job, {});
    this.runAudio(job, seq).catch((err) => this.finish(job, { status: 'error', error: err.message }));
    return job;
  }

  async runAudio(job, seq) {
    const handle = job.handle;
    const fmt = AUDIO_FORMATS[job.opts.audio];
    const dir = job.opts.outDir ? handle.resolve(String(job.opts.outDir)) : handle.layout.renders;
    await fsp.mkdir(dir, { recursive: true });
    const live = [...this.jobs.values()].filter((j) => j !== job && !FINISHED.includes(j.status));
    const base = outputBase(job.opts.name, fmt.ext) || sanitizeFolderName(`${seq.name} audio`);
    let file = path.join(dir, `${base}.${fmt.ext}`);
    for (let i = 2; fs.existsSync(file) || live.some((j) => j.output === file); i++) file = path.join(dir, `${base} (${i}).${fmt.ext}`);
    job.output = file;
    job.outputRel = handle.relativize(file);
    job.tmpOutput = file.replace(/\.(\w+)$/, '.part.$1');
    const h = { doc: job.doc, resolve: (p) => handle.resolve(p) };
    const ctl = {};
    job.encoder = { get exitCode() { return null; }, kill: () => ctl.kill?.() }; // cancel() stops every ffmpeg of the mix
    let plan;
    try {
      plan = await mixAudio(h, seq, job.t0, job.t1, job.tmpOutput, fmt, {
        tmpBase: path.join(tempRoot(), `claude-edit-${job.id}`), ctl,
        onProgress: (p) => {
          p = Math.min(0.99, p);
          if (p - job.progress < 0.01) return;
          const elapsed = (Date.now() - job.startedAt) / 1000;
          this.update(job, { progress: p, eta: elapsed > 1 ? Math.round((elapsed / p) * (1 - p)) : null });
        },
      });
    } catch (err) {
      if (job.canceled) return;
      throw new Error(`Audio export failed: ${err.message}`);
    }
    if (job.canceled) return;
    await fsp.rename(job.tmpOutput, job.output).catch((err) => { throw new Error(`Could not save output: ${err.message}`); });
    const secs = (Date.now() - job.startedAt) / 1000;
    console.log(`[render] ${seq.name}: audio only (${fmt.label}), ${(job.t1 - job.t0).toFixed(1)}s of timeline, ${plan.clips} clip(s) in ${plan.lanes} lane(s), ${plan.batches.length} batch(es), in ${secs.toFixed(2)}s`);
    this.finish(job, { status: 'done', progress: 1 });
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || FINISHED.includes(j.status)) return false;
    j.canceled = true;
    for (const t of j.tasks) this.release(t, j);
    if (j.encoder && j.encoder.exitCode == null) { try { j.encoder.kill('SIGKILL'); } catch { /* ignore */ } }
    this.finish(j, { status: 'canceled' });
    this.pump();
    return true;
  }

  // Pause an export by hand: its chunks stop (the ones rendering go back in the queue, so other exports can use
  // the slots) and it waits until resumed. Chunks already rendered are kept.
  hold(id, on) {
    const j = this.jobs.get(id);
    if (!j || FINISHED.includes(j.status)) return false;
    j.held = !!on;
    if (on) j.eta = null;
    this.update(j, {});
    this.pump();
    budget.workChanged();
    return true;
  }
  holdAll(on) {
    const jobs = [...this.jobs.values()].filter((j) => j.kind === 'video' && !FINISHED.includes(j.status) && !j.held !== !on);
    for (const j of jobs) this.hold(j.id, on);
    return jobs.length;
  }
  live(t) { return [...t.owners].filter((j) => !j.held); }

  // ---------------------------------------------------------------- tasks

  // Ask for a chunk to be rendered. `owner` is the export waiting for it; `bg` marks background
  // pre-rendering ({ projectId, seqId }). A chunk wanted by both is rendered once, at export priority.
  requestChunk(handle, fps, spec, chunk, { owner = null, bg = null } = {}) {
    let t = this.tasks.get(chunk.file);
    if (!t) {
      t = {
        key: chunk.file, kind: 'chunk', state: 'queued', order: this.order++, attempts: 0, received: 0, owners: new Set(), bg: null,
        handle, fps, spec, chunk, out: chunk.file,
      };
      t.done = new Promise((resolve) => { t.resolve = resolve; });
      this.tasks.set(t.key, t);
      this.queue.push(t);
    }
    if (bg) t.bg = bg;
    if (owner) {
      t.owners.add(owner);
      if (t.worker?.paused) this.setPaused(t.worker, false);
    }
    return t;
  }

  // An export no longer needs this chunk (canceled). Pre-rendering may still want it.
  release(t, owner) {
    t.owners.delete(owner);
    if (!t.owners.size && t.bg && t.worker && this.bgPaused) this.setPaused(t.worker, true); // pre-rendering's now
    if (t.owners.size || t.bg || !this.tasks.has(t.key)) return;
    this.drop(t, 'Canceled');
  }

  drop(t, reason) {
    if (this.tasks.get(t.key) !== t) return;
    if (t.state === 'running') this.stopRun(t);
    this.queue = this.queue.filter((x) => x !== t);
    this.tasks.delete(t.key);
    t.resolve({ ok: false, error: reason, dropped: true });
  }

  // Replace the chunks queued for background pre-rendering of one sequence. Chunks that are no longer
  // wanted are dropped (unless an export is waiting for them too).
  setBackground(projectId, seqId, wanted) {
    const keep = new Set(wanted.map((x) => x.chunk.file));
    for (const t of [...this.tasks.values()]) {
      if (t.kind !== 'chunk' || !t.bg || t.bg.projectId !== projectId || t.bg.seqId !== seqId || keep.has(t.key)) continue;
      t.bg = null;
      if (!t.owners.size) this.drop(t, 'Outdated');
    }
    const out = [];
    for (const x of wanted) {
      const t = this.requestChunk(x.handle, x.fps, x.spec, x.chunk, { bg: { projectId, seqId } });
      t.order = this.order++; // newest plan order wins (nearest the playhead first)
      out.push(t);
    }
    this.pump();
    return out;
  }
  clearBackground(projectId) {
    for (const t of [...this.tasks.values()]) {
      if (t.kind !== 'chunk' || !t.bg || (projectId && t.bg.projectId !== projectId)) continue;
      t.bg = null;
      if (!t.owners.size) this.drop(t, 'Outdated');
    }
  }

  // Pre-rendering stops while someone is playing or scrubbing (or on battery); exports are never paused.
  setBackgroundPaused(v) {
    if (this.bgPaused === !!v) return;
    this.bgPaused = !!v;
    for (const w of this.workers) if (w.task?.kind === 'chunk' && !w.task.owners.size) this.setPaused(w, this.bgPaused);
    if (!this.bgPaused) this.pump();
  }
  setPaused(w, v) {
    if (!w.task || w.paused === v) return;
    w.paused = v;
    this.send(w, { type: v ? 'pause' : 'resume', jobId: w.task.runId });
  }

  queueStill(job) {
    const t = { key: job.id, kind: 'still', state: 'queued', order: this.order++, attempts: 0, received: 0, owners: new Set([job]), bg: null, handle: job.handle, job };
    t.done = new Promise((resolve) => { t.resolve = resolve; });
    job.tasks.push(t);
    this.tasks.set(t.key, t);
    this.queue.push(t);
    t.done.then((r) => this.finish(job, r.ok ? { status: 'done', progress: 1 } : { status: job.canceled ? 'canceled' : 'error', error: r.error }));
    this.pump();
  }

  // ---------------------------------------------------------------- scheduling

  runningPool(pool) {
    return this.workers.filter((w) => w.task?.kind === 'chunk' && poolOf(w.task.spec) === pool).length;
  }
  running(role) {
    return this.workers.filter((w) => w.task && (role === 'still' ? w.task.kind === 'still' : w.task.kind === 'chunk')).length;
  }
  idleWorker(role) {
    return this.workers.find((w) => w.ws?.readyState === 1 && !w.task && (w.role === role || w.role === 'any')) || null;
  }

  // The export whose turn it is: one at a time, at full speed (quicker than several sharing the machine). The one
  // already rendering keeps going, otherwise the oldest; exports paused by hand step aside.
  currentExport() {
    let cur = null;
    for (const j of this.jobs.values()) {
      if (j.kind !== 'video' || j.held || FINISHED.includes(j.status) || !j.tasks.some((t) => this.tasks.get(t.key) === t)) continue;
      if (!cur || (!!j.started !== !!cur.started ? j.started : j.createdAt < cur.createdAt)) cur = j;
    }
    return cur;
  }

  // Next chunk to start: the current export's, in order; then pre-rendering, only while no export or graphic
  // is rendering (and it isn't paused).
  nextChunk() {
    const cur = this.currentExport();
    // an export on the CPU that hasn't started waits for a graphic that asked first (the graphic has the CPU)
    const since = budget.motionWaitingSince();
    if (!budget.plan && cur && poolOf(cur.spec) === 'cpu' && !cur.started && since != null && since < cur.createdAt) return null;
    let best = null, bg = null;
    for (const t of this.queue) {
      if (t.kind !== 'chunk') continue;
      const owners = this.live(t);
      if (!owners.length) { if ((!t.owners.size || t.bg) && (!bg || t.order < bg.order)) bg = t; continue; }
      if (owners.includes(cur) && (!best || t.order < best.order)) best = t;
    }
    return best || (cur || this.bgPaused || !budget.backgroundAllowed() || budget.motionRunning() ? null : bg);
  }

  // What a running export is waiting for, if none of its chunks is rendering: another export, or a graphic.
  waitingFor(j) {
    if (j.held || this.workers.some((w) => w.task?.owners.has(j) && !w.paused)) return null;
    const cur = this.currentExport();
    if (cur && cur !== j) return 'export';
    return poolOf(j.spec) === 'cpu' && budget.motionRunning() && !budget.chunkSlots('cpu') ? 'motion' : null;
  }

  // Keep the chunks rendering within the budget. When it shrinks (the machine is under pressure), the export
  // chunks over it pause; when memory is low they go back in the queue and their browsers close, since only
  // that frees memory (pre-rendering goes first, and idle browsers close too). When it grows, they resume.
  balance() {
    for (const pool of ['cpu', 'gpu']) this.balancePool(pool);
  }
  balancePool(pool) {
    const limit = budget.chunkSlots(pool);
    const memory = budget.level === 2;
    const mine = (t) => poolOf(t.spec) === pool;
    // chunks of exports paused by hand go back in the queue (pre-rendering may still take them)
    for (const w of this.workers) {
      const t = w.task;
      if (t?.kind === 'chunk' && mine(t) && t.owners.size && !this.live(t).length && !t.finishing && !(t.bg && !this.bgPaused && budget.backgroundAllowed())) this.requeue(t);
    }
    // pre-rendering steps aside while a graphic renders
    for (const w of this.workers) if (w.task?.kind === 'chunk' && mine(w.task) && !this.live(w.task).length && !w.task.finishing) this.setPaused(w, this.bgPaused || budget.motionRunning() > 0);
    const work = this.workers.filter((w) => w.task?.kind === 'chunk' && mine(w.task) && this.live(w.task).length && !w.task.finishing)
      .sort((a, b) => a.task.order - b.task.order); // the oldest keep going
    const drop = [];
    work.forEach((w, i) => {
      if (i < limit) { if (w.paused) this.setPaused(w, false); } else if (memory) drop.push(w); else this.setPaused(w, true);
    });
    if (!memory) return;
    for (const w of this.workers) if (w.task?.kind === 'chunk' && mine(w.task) && !this.live(w.task).length && !w.task.finishing) drop.push(w);
    for (const w of drop) this.requeue(w.task);
    // idle browsers hold memory too: keep only the ones about to take queued work (the other pool's is its call)
    const next = this.nextChunk();
    let spare = !next ? 0 : poolOf(next.spec) === pool ? Math.max(0, limit - this.runningPool(pool)) : Infinity;
    for (const w of this.workers.filter((x) => x.kind === 'headless' && x.ws && !x.task)) {
      if (w.role === 'still' ? this.queue.some((t) => t.kind === 'still') : spare-- > 0) continue;
      this.workerGone(w);
    }
  }

  pump() {
    clearTimeout(this.idleTimer);
    this.balance();
    for (const t of this.queue.filter((x) => x.kind === 'still')) {
      const w = this.idleWorker('still');
      if (!w) { this.wantWorker('still'); break; }
      this.run(w, t);
    }
    for (;;) {
      const t = this.nextChunk();
      if (!t) break;
      const pool = poolOf(t.spec);
      const slots = budget.chunkSlots(pool);
      const busy = this.runningPool(pool);
      const w = busy < slots ? this.idleWorker('chunk') : null;
      if (w) { this.run(w, t); continue; }
      if (busy >= slots || !this.canLaunch('chunk')) {
        // an export is waiting and every slot is taken: it takes over one that is pre-rendering
        const victim = this.live(t).length ? this.workers.find((x) => x.task?.kind === 'chunk' && !this.live(x.task).length && !x.task.finishing) : null;
        if (victim) { this.requeue(victim.task); continue; }
        if (!busy && slots && !this.workers.some((x) => x.role !== 'still')) this.wantWorker('chunk');
        break;
      }
      this.wantWorker('chunk');
      break;
    }
    if (!this.queue.length && !this.workers.some((w) => w.task)) this.scheduleIdleShutdown();
  }

  // ---------------------------------------------------------------- worker lifecycle

  canLaunch(role) {
    if (!appHost && !findBrowser()) return false;
    if (role === 'still') return !this.workers.some((w) => w.role === 'still');
    return this.workers.filter((w) => w.role === 'chunk').length < Math.max(budget.chunkSlots('cpu'), budget.chunkSlots('gpu'));
  }

  wantWorker(role) {
    if (this.workers.some((w) => !w.ws && (w.role === role || w.role === 'any'))) return; // one is starting
    const exe = appHost ? null : findBrowser();
    if (!appHost && !exe) {
      // no headless browser available: ask an open editor tab to host one worker in a hidden iframe
      if (this.workers.some((w) => w.kind === 'ui')) return;
      this.emitAll({ type: 'needWorker' });
      clearTimeout(this.uiTimer);
      this.uiTimer = setTimeout(() => {
        if (!this.workers.some((w) => w.ws?.readyState === 1)) this.failQueued('The render worker did not start. Keep the editor open in a browser tab and try again.');
      }, 30000);
      return;
    }
    if (!this.canLaunch(role) || Date.now() < (this.launchHold[role] || 0)) return;
    let id = 's';
    if (role === 'chunk') { let n = 1; while (this.workers.some((w) => w.id === `c${n}`)) n++; id = `c${n}`; }
    const url = `http://127.0.0.1:${this.port}/render.html?worker=headless&id=${id}`;
    // per port, so two instances of the app (e.g. a test server) never share a browser profile
    const profile = path.join(tempRoot(), `claude-edit-render-profile-${this.port}-${id}`);
    const args = [
      '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
      '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1280,800', url,
    ];
    const w = { id, role, kind: 'headless', proc: null, ws: null, task: null, streams: new Map(), paused: false };
    // the desktop app runs the page in a process of its own (apphost.js); otherwise a headless Chrome/Edge
    const proc = appHost ? spawnBrowser(...workerHostCommand(url, profile, FFMPEG)) : spawnBrowser(exe, args);
    proc.appWorker = appHost;
    lowerPriority(proc); // Chromium's child processes inherit the priority class
    w.proc = proc;
    // A browser that dies before its page connects would be started again at once, for ever, while the
    // queue waits: hold off for a while, and tell whoever is waiting if no other worker can take the work.
    const died = () => {
      if (!this.workers.includes(w)) return;
      if (!w.ws) {
        this.launchHold[role] = Date.now() + 20000;
        setTimeout(() => this.pump(), 20500);
        if (!this.workers.some((x) => x.ws?.readyState === 1 && (x.role === role || x.role === 'any'))) this.failQueued('The render worker did not start. Is Chrome or Edge installed?', role);
      }
      this.workerGone(w);
    };
    proc.on('error', (err) => { console.warn('[render] browser failed:', err.message); died(); });
    proc.on('exit', died);
    w.timer = setTimeout(() => {
      if (w.ws) return;
      this.workerGone(w);
      if (!this.workers.some((x) => x.ws?.readyState === 1 && (x.role === role || x.role === 'any'))) {
        this.failQueued('The render worker did not start. Is Chrome or Edge installed?', role);
      }
    }, 30000);
    this.workers.push(w);
  }

  // direct: the page can read and write frames itself (the app's own render pages: electron/worker-preload.cjs)
  attachWorker(ws, kind, id, direct = false) {
    let w;
    if (kind === 'headless') {
      w = this.workers.find((x) => x.id === id && !x.ws);
      if (!w) { ws.close(); return; } // a page left over from an earlier run
    } else {
      if (this.workers.some((x) => x.kind === 'headless')) { ws.close(); return; } // prefer the headless workers
      for (const old of this.workers.filter((x) => x.kind === 'ui')) this.workerGone(old);
      w = { id: 'ui', role: 'any', kind: 'ui', proc: null, ws: null, task: null, streams: new Map(), paused: false };
      this.workers.push(w);
    }
    clearTimeout(w.timer);
    w.ws = ws;
    w.direct = !!direct && kind === 'headless' && process.env.JIMMY_DIRECT_FRAMES !== '0';
    ws.on('message', (data, isBinary) => this.onWorkerMessage(w, data, isBinary));
    ws.on('close', () => this.workerGone(w));
    this.pump();
  }

  workerGone(w, why = WORKER_LOST) {
    if (!this.workers.includes(w)) return;
    this.workers = this.workers.filter((x) => x !== w);
    clearTimeout(w.timer);
    for (const s of w.streams.values()) s.kill();
    w.streams.clear();
    try { w.ws?.close(); } catch { /* ignore */ }
    killBrowser(w.proc, false, why !== WORKER_LOST);
    const t = w.task;
    w.task = null;
    if (t) {
      t.worker = null;
      this.endRun(t);
      if (t.attempts < 2) { t.state = 'queued'; this.queue.push(t); } else this.settle(t, { ok: false, error: why });
    }
    this.pump();
  }

  failQueued(error, role) {
    for (const t of [...this.queue]) {
      if (role && (role === 'still') !== (t.kind === 'still')) continue;
      this.queue = this.queue.filter((x) => x !== t);
      this.settle(t, { ok: false, error });
    }
  }

  scheduleIdleShutdown() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queue.length || this.workers.some((w) => w.task)) return;
      for (const w of [...this.workers]) this.workerGone(w);
    }, 10 * 60 * 1000);
  }

  send(w, obj) {
    if (w.ws?.readyState === 1) w.ws.send(JSON.stringify(obj));
  }

  // ---------------------------------------------------------------- running a task

  run(w, t) {
    this.queue = this.queue.filter((x) => x !== t);
    t.state = 'running';
    t.attempts++;
    t.received = 0;
    t.runId = uid('run');
    t.startedAt = Date.now();
    t.worker = w;
    w.task = t;
    w.paused = false;
    w.frameFor = null;
    if (t.kind === 'still') return this.runStill(w, t);
    for (const j of this.live(t)) if (!j.started) { j.started = true; budget.workChanged(); }

    const { spec, chunk } = t;
    const threads = spec.enc ? Math.min(4, renderSlots().threads) : renderSlots().threads; // a GPU encoder only needs the colour conversion
    t.decodeThreads = Math.max(1, Math.min(4, Math.round(renderSlots().threads / 2)));
    t.tmp = t.out.replace(/\.(\w+)$/, `.${t.runId}.part.$1`);
    try {
      const dir = path.dirname(t.out);
      fs.mkdirSync(dir, { recursive: true });
      // the folder may have been cleared since it was planned: without its spec.json it counts as leftovers
      const specFile = path.join(dir, 'spec.json');
      if (!fs.existsSync(specFile)) fs.writeFileSync(specFile, JSON.stringify(spec));
    } catch { /* reported by the encoder */ }
    // the app's render pages write their frames straight to the encoder, which listens on a local port for them
    // (electron/worker-preload.cjs); other pages send them here over their WebSocket and they go to its stdin
    if (w.direct) {
      const runId = t.runId;
      freePort().then((port) => { if (t.runId === runId && t.worker === w) this.startChunk(w, t, threads, port); }, (err) => this.fail(t, err.message));
      return undefined;
    }
    return this.startChunk(w, t, threads, null);
  }

  // The watchdog of a classic chunk: a page that froze without disconnecting would otherwise hold its slot for ever.
  // Its browser is closed and the chunk goes back in the queue, once; a second freeze ends the export with a reason.
  watchChunk(w, t) {
    const runId = t.runId;
    let seen = -1, at = Date.now();
    const timer = setInterval(() => {
      if (t.runId !== runId || t.state !== 'running' || w.task !== t || t.finishing) { clearInterval(timer); return; }
      if (w.paused || t.received !== seen) { seen = t.received; at = Date.now(); return; }
      if (Date.now() - at < CHUNK_STALL_MS) return;
      clearInterval(timer);
      const secs = Math.round(CHUNK_STALL_MS / 1000);
      console.warn(`[render] a chunk made no progress for ${secs} s at frame ${t.received} of ${t.chunk.count}; stopping it (attempt ${t.attempts})`);
      perflog.event('chunkStalled', { frame: t.received, frames: t.chunk.count, attempt: t.attempts });
      this.workerGone(w, `Part of the export stopped making progress for ${secs} s, twice, at frame ${t.chunk.start + t.received}. Try exporting again; if it stops at the same place, look at what is on the timeline there.`);
    }, Math.min(1000, CHUNK_STALL_MS / 4));
    timer.unref?.();
  }

  startChunk(w, t, threads, port) {
    const { spec, chunk } = t;
    const args = [
      '-v', 'error', '-y', ...(port ? ['-nostdin'] : []),
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${spec.width}x${spec.height}`, '-framerate', fpsRational(t.fps),
      '-i', port ? `tcp://127.0.0.1:${port}?listen=1&listen_timeout=60000` : 'pipe:0',
      ...videoCodecArgs(spec), '-an', '-f', spec.ext === 'mp4' ? 'mp4' : 'mov', t.tmp,
    ];
    const enc = spawn(FFMPEG, withThreads(args, threads), { windowsHide: true });
    lowerPriority(enc);
    t.encoder = enc;
    t.encErr = '';
    enc.stderr.on('data', (d) => { t.encErr = (t.encErr + d).slice(-8000); });
    enc.stdin.on('error', () => {});
    const runId = t.runId;
    t.encoderExit = new Promise((resolve) => { enc.on('close', (code) => resolve(code)); enc.on('error', () => resolve(-1)); });
    t.encoderExit.then((code) => {
      if (code !== 0 && t.runId === runId && t.state === 'running' && !t.finishing) {
        this.fail(t, `Encoder failed: ${t.encErr.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`}`);
      }
    });
    this.send(w, {
      type: 'job',
      spec: {
        jobId: t.runId, kind: 'video', projectId: t.handle.id, sequenceId: chunk.seq.id,
        project: { media: chunk.mediaItems, sequences: [chunk.seq] },
        startFrame: chunk.start, frameCount: chunk.count, width: spec.width, height: spec.height,
        scale: spec.width / chunk.seq.width, media: chunk.media, transparent: spec.transparent,
        ...(port ? { direct: this.directSpec(t, port) } : {}),
        ...(chunk.start === 0 && (TEST_FREEZE_CHUNK === 'always' || (TEST_FREEZE_CHUNK === 'once' && t.attempts === 1)) ? { testFreeze: true } : {}),
      },
    });
    this.watchChunk(w, t);
    if (this.bgPaused && !t.owners.size) this.setPaused(w, true);
    return undefined;
  }

  // What a render page needs to decode a chunk's clips itself and write to its encoder: each video file with its
  // GPU decoding plan, the decoder threads and priority, and the encoder's port.
  directSpec(t, port) {
    const files = {};
    for (const item of t.chunk.mediaItems || []) {
      if (item.type !== 'video') continue;
      const meta = this.media.get(t.handle.id, item.id)?.meta;
      files[item.id] = { file: this.mediaFile(t, item.id), hw: decodePlan(t.spec, { ...item, hasAlpha: !!meta?.alpha, pixFmt: meta?.pixFmt }) };
    }
    return { port, fps: t.fps, files, threads: t.decodeThreads, priority: perf().priority };
  }

  runStill(w, t) {
    const job = t.job;
    const handle = job.handle;
    const seq = flattenSequence(job.doc, findSequence(job.doc, job.sequenceId));
    const outDir = path.join(handle.layout.state, 'frames');
    // a still asked for at full size is named *.full.png, which Claude's image check (bin/check-image.mjs) leaves as is
    job.output = job.opts.out ? path.resolve(handle.dir, job.opts.out) : path.join(outDir, `frame-${String(job.startFrame).padStart(6, '0')}${job.opts.maxSide ? '' : '.full'}.png`);
    job.outputRel = handle.relativize(job.output);
    t.out = job.output;
    t.fps = seq.fps;
    t.decodeThreads = 2;
    const media = {};
    for (const m of job.doc.media) {
      const st = this.media.get(handle.id, m.id);
      media[m.id] = { exists: !!st?.exists, previewReady: !!st?.exists && (st.browserOk !== false || st.proxy === 'ready'), key: st?.key || '' };
    }
    this.update(job, { status: 'running' });
    this.send(w, {
      type: 'job',
      spec: {
        jobId: t.runId, kind: 'still', projectId: handle.id, sequenceId: seq.id,
        project: { media: job.doc.media, sequences: [seq] },
        startFrame: job.startFrame, frameCount: 1, width: job.width, height: job.height,
        scale: job.width / seq.width, media, transparent: !!job.opts.transparent,
      },
    });
  }

  mediaFile(t, mediaId) {
    const list = t.kind === 'still' ? t.job.doc?.media : t.chunk.mediaItems;
    const m = (list || []).find((x) => x.id === mediaId);
    return (m && t.handle.resolve(m.path)) || '';
  }

  onWorkerMessage(w, data, isBinary) {
    const t = w.task;
    if (isBinary) {
      // every frame is announced by a { type: 'frame', jobId } message, so a frame from a run that
      // was stopped a moment ago can't end up in the next one
      const mine = t && w.frameFor === t.runId;
      w.frameFor = null;
      if (!mine) return;
      if (t.kind === 'still') {
        fsp.mkdir(path.dirname(t.out), { recursive: true }).then(() => fsp.writeFile(t.out, data))
          .then(() => this.succeed(t), (err) => this.fail(t, err.message));
        return;
      }
      const n = ++t.received;
      const runId = t.runId;
      t.encoder.stdin.write(data, () => this.send(w, { type: 'ack', jobId: runId, n }));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!t || msg.jobId !== t.runId) return;
    if (msg.type === 'frame') {
      w.frameFor = msg.jobId;
    } else if (msg.type === 'progress') {
      t.received = Math.max(t.received, Math.min(+msg.n || 0, t.chunk?.count || 0)); // pages that write to the encoder themselves
    } else if (msg.type === 'decode') {
      // { key, mediaId, srcStart, speed, w, h, crop, index, reqId, prefetch }: prefetch starts the decoder only
      let s = w.streams.get(msg.key);
      if (!s || s.w !== msg.w || s.h !== msg.h || String(s.crop) !== String(msg.crop || null)) {
        s?.kill();
        const item = t.kind === 'still' ? null : t.chunk.mediaItems?.find((x) => x.id === msg.mediaId);
        const meta = this.media.get(t.handle.id, msg.mediaId)?.meta;
        const hw = item ? decodePlan(t.spec, { ...item, hasAlpha: !!meta?.alpha, pixFmt: meta?.pixFmt }) : null;
        s = new DecodeStream({ ffmpeg: FFMPEG, priority: perf().priority, file: this.mediaFile(t, msg.mediaId), srcStart: msg.srcStart, speed: msg.speed || 1, fps: t.fps, w: msg.w, h: msg.h, crop: Array.isArray(msg.crop) ? msg.crop : null, threads: t.decodeThreads, hw });
        w.streams.set(msg.key, s);
      }
      s.get(msg.index).then((buf) => {
        if (msg.prefetch) return;
        if (w.ws?.readyState !== 1 || w.task !== t || t.runId !== msg.jobId) return;
        const out = buf.sent ? Buffer.from(buf) : buf;
        buf.sent = true;
        out.writeUInt32LE(msg.reqId >>> 0, 0);
        w.ws.send(out);
      }).catch((err) => { if (w.task === t && t.runId === msg.jobId) this.fail(t, `Could not read a source frame: ${err.message}`); });
    } else if (msg.type === 'closeStream') {
      w.streams.get(msg.key)?.kill();
      w.streams.delete(msg.key);
    } else if (msg.type === 'done') {
      if (t.kind === 'chunk') this.completeChunk(t, msg.perf);
    } else if (msg.type === 'error') {
      this.fail(t, msg.message || 'Render failed');
    }
  }

  async completeChunk(t, perfMs) {
    const runId = t.runId;
    t.finishing = true;
    t.encoder.stdin.end();
    const code = await t.encoderExit;
    if (t.runId !== runId || t.state !== 'running') return;
    t.finishing = false;
    if (code !== 0) return this.fail(t, `Encoder failed: ${t.encErr.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`}`);
    try {
      await fsp.rename(t.tmp, t.out);
    } catch (err) {
      return this.fail(t, `Could not save a rendered chunk: ${err.message}`);
    }
    return this.succeed(t, perfMs);
  }

  // Stop whatever is running for this task: the page's loop, its decoders and its encoder.
  endRun(t) {
    const w = t.worker;
    if (w) {
      this.send(w, { type: 'cancel', jobId: t.runId });
      for (const s of w.streams.values()) s.kill();
      w.streams.clear();
      w.task = null;
      w.paused = false;
    }
    t.worker = null;
    t.runId = null;
    t.finishing = false;
    if (t.encoder && t.encoder.exitCode == null) { try { t.encoder.kill('SIGKILL'); } catch { /* ignore */ } }
    t.encoder = null;
    if (t.tmp) { const tmp = t.tmp; setTimeout(() => fsp.unlink(tmp).catch(() => {}), 500); }
  }
  stopRun(t) { this.endRun(t); t.state = 'queued'; }
  // Put a running chunk back in the queue (its slot is needed for an export).
  requeue(t) {
    this.stopRun(t);
    t.attempts = Math.max(0, t.attempts - 1);
    this.queue.push(t);
  }

  settle(t, result) {
    if (this.tasks.get(t.key) !== t) return;
    this.tasks.delete(t.key);
    t.state = result.ok ? 'done' : 'error';
    t.resolve(result);
  }
  succeed(t, perfMs) {
    const w = t.worker;
    if (t.kind === 'chunk') fsp.stat(t.chunk.file).then((st) => perflog.io('chunkW', st.size), () => {});
    if (t.kind === 'chunk') perflog.event('chunk', { frames: t.chunk.count, secs: t.startedAt ? +((Date.now() - t.startedAt) / 1000).toFixed(1) : null, bg: !t.owners.size, attempts: t.attempts });
    if (w) { for (const s of w.streams.values()) s.kill(); w.streams.clear(); w.task = null; w.paused = false; }
    t.worker = null;
    t.encoder = null;
    if (t.kind === 'chunk') t.received = t.chunk.count;
    this.settle(t, { ok: true, perf: perfMs || null });
    this.pump();
    budget.workChanged();
  }
  fail(t, error) {
    this.endRun(t);
    this.settle(t, { ok: false, error });
    this.pump();
  }

  // ---------------------------------------------------------------- exports

  async runExport(job) {
    const handle = job.handle;
    let timer = null;
    try {
      // motion graphics still rendering: wait for them, then use their finished files
      if (this.motion) {
        const s = flattenSequence(job.doc, findSequence(job.doc, job.sequenceId)); // nested graphics too
        const ids = [...new Set((s?.clips || []).map((c) => c.media).filter((id) => job.doc.media.some((m) => m.id === id && m.motion)))];
        if (ids.length) {
          this.update(job, { status: 'motion' });
          await this.motion.settle(handle, ids);
          job.doc.media = JSON.parse(JSON.stringify(handle.doc.media)); // the items now point at their finished renders
          if (job.canceled) return;
        }
      }
      const seq = flattenSequence(job.doc, findSequence(job.doc, job.sequenceId));
      let spec = job.spec = outputSpec(seq, job.opts);
      job.engine = spec.enc ? `GPU · ${spec.enc.split('-')[0].replace(/^./, (c) => c.toUpperCase()).replace('Nvidia', 'NVIDIA').replace('Amd', 'AMD')}` : 'CPU';
      job.startedAt = Date.now();
      this.update(job, { status: 'running' });
      timer = setInterval(() => this.progress(job), 500);
      let plan = null;
      const perfSum = { decode: 0, compose: 0, read: 0, wait: 0, frames: 0 };
      // a chunk can disappear between planning and stitching (cache cleared): ask again for what is missing
      for (let pass = 0; pass < 3; pass++) {
        plan = await planSequence({ handle, doc: job.doc, seq, spec, media: this.media, startFrame: job.startFrame, frameCount: job.frameCount });
        await writeSpec(plan.dir, spec);
        if (job.canceled) return;
        const missing = plan.chunks.filter((c) => !fs.existsSync(c.file));
        if (pass === 0) job.reused = plan.chunks.reduce((n, c) => n + (missing.includes(c) ? 0 : c.count), 0);
        if (!missing.length) break;
        if (pass === 2) throw new Error('Rendered chunks keep disappearing from the cache folder');
        const tasks = missing.map((c) => this.requestChunk(handle, seq.fps, spec, c, { owner: job }));
        job.tasks.push(...tasks);
        this.pump();
        const results = await Promise.all(tasks.map((t) => t.done));
        if (job.canceled) return;
        const bad = results.find((r) => !r.ok);
        if (bad && spec.enc && /Encoder failed/.test(bad.error || '')) {
          // the GPU encoder failed: set it aside and do this export on the CPU (chunks can't mix encoders)
          gpuFailed(spec.enc.split('-')[0], bad.error);
          for (const t of job.tasks) this.release(t, job);
          job.tasks = [];
          spec = job.spec = outputSpec(seq, job.opts);
          job.started = false;
          job.engine = 'CPU (GPU failed)';
          job.reused = 0;
          this.update(job, {});
          pass = -1;
          continue;
        }
        if (bad) throw new Error(bad.error || 'Render failed');
        for (const r of results) if (r.perf) for (const k of Object.keys(perfSum)) perfSum[k] += r.perf[k] || 0;
      }
      clearInterval(timer);
      if (job.canceled) return;
      for (const c of plan.chunks) touch(c.file, 0);
      await this.stitch(job, seq, plan, spec);
      const secs = (Date.now() - job.startedAt) / 1000;
      const f = perfSum.frames || 1;
      console.log(`[render] ${seq.name}: ${job.frameCount} frames (${job.reused} reused) in ${secs.toFixed(1)}s, up to ${renderSlots().slots} chunk(s) at once`
        + (perfSum.frames ? ` — avg ms per rendered frame: decode ${(perfSum.decode / f).toFixed(1)} compose ${(perfSum.compose / f).toFixed(1)} readback ${(perfSum.read / f).toFixed(1)} encoder-wait ${(perfSum.wait / f).toFixed(1)}` : ''));
    } catch (err) {
      for (const t of job.tasks) this.release(t, job);
      this.finish(job, { status: 'error', error: err.message });
    } finally {
      clearInterval(timer);
    }
  }

  progress(job) {
    if (FINISHED.includes(job.status) || job.status === 'encoding') return;
    const waiting = this.waitingFor(job);
    if (waiting !== (job.waiting || null)) this.update(job, { waiting, ...(waiting ? { eta: null } : {}) });
    if (job.held || waiting) { job.startedAt += 500; return; } // paused or waiting its turn: the clock (and the time left) stops too
    let rendered = 0;
    for (const t of job.tasks) rendered += Math.min(t.received || 0, t.chunk?.count || 0);
    const done = job.reused + rendered;
    const p = Math.min(0.99, done / job.frameCount);
    const elapsed = (Date.now() - job.startedAt) / 1000;
    const eta = rendered > 10 && elapsed > 1 ? Math.round((job.frameCount - done) / (rendered / elapsed)) : null;
    if (p !== job.progress || eta !== job.eta) this.update(job, { progress: p, eta });
  }

  // Join the chunk files (no re-encode) and mix the audio into the final file.
  async stitch(job, seq, plan, spec) {
    const handle = job.handle;
    this.update(job, { status: 'encoding', progress: 0.99, eta: null });
    const renders = job.opts.outDir ? handle.resolve(String(job.opts.outDir)) : handle.layout.renders;
    await fsp.mkdir(renders, { recursive: true });
    let base;
    // other exports of this project that are still being written (their number and file are taken too)
    const live = [...this.jobs.values()].filter((j) => j !== job && j.projectId === job.projectId && !FINISHED.includes(j.status));
    if (job.opts.addVersion !== false) {
      const taken = [...(handle.reviews?.versions || []).filter((v) => v.sequence === seq.id).map((v) => v.number || 0), ...live.filter((j) => j.sequenceId === seq.id).map((j) => j.versionNumber || 0)];
      const n = Math.max(0, ...taken) + 1;
      job.versionNumber = n;
      // Export › File name: the person's own name for the file; the Review version keeps its number either way
      base = outputBase(job.opts.name, spec.ext) || `${sanitizeFolderName(seq.name)} v${n}`;
    } else {
      base = outputBase(job.opts.name, spec.ext) || sanitizeFolderName(`${seq.name} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
    }
    let file = path.join(renders, `${base}.${spec.ext}`);
    for (let i = 2; fs.existsSync(file) || live.some((j) => j.output === file); i++) file = path.join(renders, `${base} (${i}).${spec.ext}`);
    job.output = file;
    job.outputRel = handle.relativize(file);
    job.tmpOutput = file.replace(/\.(\w+)$/, '.part.$1');

    const t0 = job.startFrame / seq.fps;
    const t1 = (job.startFrame + job.frameCount) / seq.fps;
    const ao = job.opts.audioOut; // Export › Audio (none: the sequence's mix isn't made at all)
    const silent = ao?.codec === 'none';
    // the audio first, into one file: the join then has two inputs however many clips the sequence has
    if (!silent) {
      job.mixFile = path.join(tempRoot(), `claude-edit-${job.id}-mix.w64`);
      const ctl = {};
      job.encoder = { get exitCode() { return null; }, kill: () => ctl.kill?.() }; // cancel() stops every ffmpeg of the mix
      try {
        await mixAudio({ doc: job.doc, resolve: (p) => handle.resolve(p) }, seq, t0, t1, job.mixFile, { codec: ['-c:a', 'pcm_f32le'], mux: 'w64' }, { tmpBase: path.join(tempRoot(), `claude-edit-${job.id}-a`), ctl });
      } catch (err) {
        if (job.canceled) return;
        throw new Error(`The audio mix failed: ${err.message}`);
      }
      if (job.canceled) return;
    }
    job.listFile = path.join(tempRoot(), `claude-edit-${job.id}.txt`);
    const quote = (p) => `'${toPosix(p).replace(/'/g, "'\\''")}'`;
    const [rateNum, rateDen = 1] = fpsRational(seq.fps).split('/').map(Number); // the exact rate the chunks were encoded at
    await fsp.writeFile(job.listFile, `ffconcat version 1.0\n${plan.chunks.map((c) => `file ${quote(c.file)}\nduration ${((c.count * rateDen) / rateNum).toFixed(6)}`).join('\n')}\n`);
    const q = QUALITY[job.opts.quality];
    const audioCodec = !ao ? (FORMATS[spec.format].codec === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', q.abitrate])
      : ao.codec === 'pcm16' ? ['-c:a', 'pcm_s16le'] : ao.codec === 'pcm24' ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'aac', '-b:a', `${ao.kbps}k`];
    // Export › Frame rate: the joined chunks are encoded once more at that rate (frames repeated or dropped);
    // otherwise they are joined as they are
    const convert = job.opts.fps ? videoCodecArgs(spec) : null;
    if (convert) convert[1] = `fps=${fpsRational(job.opts.fps)},${convert[1]}`;
    const args = [
      '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', job.listFile,
      ...(silent ? ['-map', '0:v:0', '-an'] : ['-i', job.mixFile, '-map', '0:v:0', '-map', '1:a:0', ...audioCodec, '-ar', String(ao?.rate || 48000)]),
      ...(convert || ['-c:v', 'copy']),
      ...(convert ? ['-progress', 'pipe:1', '-nostats'] : []),
      '-movflags', '+faststart', '-f', spec.ext === 'mp4' ? 'mp4' : 'mov', job.tmpOutput,
    ];
    const enc = spawn(FFMPEG, withThreads(args, perf().threads), { windowsHide: true });
    lowerPriority(enc);
    job.encoder = enc;
    let encErr = '';
    enc.stderr.on('data', (d) => { encErr = (encErr + d).slice(-8000); });
    if (convert) {
      // how far the conversion is, for the Exports list ("converting to 25 fps · 40%")
      const total = (job.frameCount / seq.fps) * 1e6;
      let buf = '';
      enc.stdout.on('data', (d) => {
        buf = (buf + d).slice(-2000);
        const m = [...buf.matchAll(/out_time_us=(\d+)/g)].pop();
        if (m) this.update(job, { converting: { fps: job.opts.fps, progress: Math.min(1, +m[1] / total) } });
      });
    }
    const code = await new Promise((resolve) => { enc.on('close', resolve); enc.on('error', () => resolve(-1)); });
    if (job.canceled) return;
    if (code !== 0) throw new Error(`Encoder failed: ${encErr.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`}`);
    try {
      await fsp.rename(job.tmpOutput, job.output);
    } catch (err) {
      throw new Error(`Could not save output: ${err.message}`);
    }
    let versionId = null;
    if (job.opts.addVersion !== false) {
      versionId = uid('v');
      await handle.mutateReviews((r) => {
        const n = job.versionNumber;
        r.versions.push({
          id: versionId, sequence: seq.id, sequenceName: seq.name, number: n, name: `v${n}`,
          file: job.outputRel, createdAt: new Date().toISOString(), status: 'in_review',
          duration: job.frameCount / seq.fps, start: job.startFrame / seq.fps, width: job.width, height: job.height, fps: job.opts.fps || seq.fps,
          quality: job.opts.quality,
        });
      });
    }
    this.finish(job, { status: 'done', progress: 1, versionId });
  }

  finish(job, patch) {
    if (FINISHED.includes(job.status)) return;
    this.update(job, { ...patch, finishedAt: Date.now(), eta: null });
    if (patch.status === 'done' && job.output) fsp.stat(job.output).then((st) => perflog.io('exportW', st.size), () => {});
    if (!job.opts?.quiet) perflog.event('export', { id: job.id, status: job.status, label: job.label, kind: job.kind, secs: Math.round((Date.now() - job.createdAt) / 1000), frames: job.frameCount, reused: job.reused, error: job.error || undefined });
    if (patch.status !== 'done' && job.tmpOutput) setTimeout(() => fsp.unlink(job.tmpOutput).catch(() => {}), 500);
    if (job.mixFile) fsp.unlink(job.mixFile).catch(() => {});
    if (job.listFile) fsp.unlink(job.listFile).catch(() => {});
    job.tasks = [];
    job.waiting = null;
    delete job.doc;
    job.resolveDone(job);
    budget.workChanged();
    if (job.kind === 'video') this.onExport?.(job.projectId);
  }

  shutdown() {
    for (const j of this.jobs.values()) if (j.encoder && j.encoder.exitCode == null) j.encoder.kill('SIGKILL');
    for (const t of this.tasks.values()) if (t.encoder && t.encoder.exitCode == null) t.encoder.kill('SIGKILL');
    for (const w of this.workers) killBrowser(w.proc, true);
  }
}

