import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from './config.js';

function findBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const fromEnv = process.env[`${name.toUpperCase()}_PATH`];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch { /* not on PATH */ }
  for (const dir of ['C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']) {
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export const FFMPEG = findBinary('ffmpeg');
export const FFPROBE = findBinary('ffprobe');

// CPU H.264. x264 is GPL, so the ffmpeg the desktop app ships (an LGPL build) has OpenH264 instead. OpenH264 has
// no CRF: a bitrate for the frame size stands in for it (bits per pixel at 30 fps). Measured on the golden 1080p
// clip, OpenH264 (High profile, CABAC) needs about 1.5x x264's bitrate for the same PSNR: 0.26 bpp ≈ crf 17.
// the encoders this ffmpeg has (null: no ffmpeg, or it couldn't be asked)
const ENCODERS = (() => {
  if (!FFMPEG) return null;
  try { return execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }); } catch { return null; }
})();
const hasEncoder = (name, unknown) => (ENCODERS == null ? unknown : new RegExp(`\\s${name}\\s`).test(ENCODERS));
export const HAS_X264 = hasEncoder('libx264', true); // no answer: assume the usual (x264), nothing to choose
// CPU H.265: x265 where ffmpeg has it (GPL builds); the app's LGPL build has Kvazaar on Windows (slower, so GPUs do
// most HEVC exports) and on a Mac, where the LGPL build has neither, the Mac's own HEVC encoder (VideoToolbox, allowed
// to fall back to software on Macs without HEVC hardware). Quality: x265's CRF runs about 2 above x264's for the same
// picture; Kvazaar takes a QP, VideoToolbox a quality 1-100 (the GPU table's 70/60/46 for high/standard/draft).
export const HAS_X265 = hasEncoder('libx265', true);
export const HEVC_CPU = HAS_X265 ? 'x265' : hasEncoder('libkvazaar', false) ? 'kvazaar'
  : process.platform === 'darwin' && hasEncoder('hevc_videotoolbox', false) ? 'videotoolbox' : null;
// rate: { kbps, cbr } (Export › Bitrate) instead of a quality
export function cpuHevc(crf, preset, rate = null) {
  if (HEVC_CPU === 'x265') {
    const base = ['-c:v', 'libx265', '-preset', preset, '-tag:v', 'hvc1', '-x265-params', 'log-level=error'];
    return rate ? [...base, ...bitrateArgs(rate)] : [...base, '-crf', String(crf + 2)];
  }
  if (HEVC_CPU === 'videotoolbox') {
    const base = ['-c:v', 'hevc_videotoolbox', '-allow_sw', '1', '-profile:v', 'main', '-tag:v', 'hvc1'];
    return rate ? [...base, ...bitrateArgs(rate)] : [...base, '-q:v', String(Math.max(20, Math.min(90, Math.round(70 - (crf - 17) * 2.67))))];
  }
  if (!HEVC_CPU) throw new Error('This ffmpeg has no H.265 encoder (x265, Kvazaar or VideoToolbox). Choose H.264, or turn on GPU encoding in Settings.');
  const kz = `preset=${preset === 'veryfast' ? 'ultrafast' : preset === 'fast' ? 'veryfast' : 'fast'}`;
  return rate ? ['-c:v', 'libkvazaar', '-kvazaar-params', kz, ...bitrateArgs(rate), '-tag:v', 'hvc1']
    : ['-c:v', 'libkvazaar', '-kvazaar-params', `${kz},qp=${crf + 5}`, '-tag:v', 'hvc1'];
}
export function cpuH264Rate(preset, rate) {
  if (HAS_X264) return ['-c:v', 'libx264', '-preset', preset, ...bitrateArgs(rate), ...(rate.cbr ? ['-x264-params', 'nal-hrd=cbr'] : [])];
  return ['-c:v', 'libopenh264', '-rc_mode', 'bitrate', ...bitrateArgs(rate), '-profile:v', 'high', '-coder', 'cabac', '-allow_skip_frames', '0'];
}
// -b:v / -maxrate / -bufsize for { kbps, cbr }: a variable bitrate may peak at 1.5× the average, a constant one may not
export function bitrateArgs({ kbps, cbr }) {
  const max = cbr ? kbps : Math.round(kbps * 1.5);
  return ['-b:v', `${kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${max * 2}k`];
}

export function cpuH264(crf, preset, width = 1920, height = 1080) {
  if (HAS_X264) return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];
  const bpp = crf <= 17 ? 0.26 : crf <= 20 ? 0.18 : crf <= 22 ? 0.14 : crf <= 24 ? 0.11 : 0.07;
  const kbps = Math.max(500, Math.round((width * height * 30 * bpp) / 1000));
  return ['-c:v', 'libopenh264', '-rc_mode', 'bitrate', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`,
    '-profile:v', 'high', '-coder', 'cabac', '-allow_skip_frames', '0'];
}

// ---------------------------------------------------------------- performance
// Like Resolve's "optimized media / render" settings: background work (proxies, thumbnails, waveforms,
// exports) gets a capped number of CPU threads and runs below normal priority so the machine stays responsive.
export const CPU_COUNT = Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
export const USAGE_LEVELS = [25, 50, 70, 100];
export function perf() {
  const p = getConfig().performance || {};
  // "usage" is the share of the machine that exports and pre-rendering may take. It is a target: the app
  // steers it through how many chunks render side by side and how many threads each one gets.
  const usage = USAGE_LEVELS.includes(Number(p.usage)) ? Number(p.usage) : 70;
  let threads = Math.max(1, Math.round((CPU_COUNT * usage) / 100));
  if (Number(p.threads) > 0) threads = Math.min(threads, Number(p.threads)); // an explicit core cap from older settings still applies
  return { threads, usage, priority: p.priority || 'low', jobs: Math.max(1, Math.min(8, Number(p.jobs) || 2)) };
}
// How many chunks render at the same time (each one is a browser page, its decoders and an encoder),
// and the threads each of those gets. Bounded by memory: a slot holds several uncompressed frames.
export function renderSlots() {
  const { threads } = perf();
  const byMemory = Math.max(1, Math.floor(os.totalmem() / (3 * 1024 ** 3)));
  const slots = Math.max(1, Math.min(8, Math.floor(threads / 4), byMemory));
  return { slots, threads: Math.max(1, Math.floor(threads / slots)) };
}
// Threads for one job when several run side by side.
export function jobThreads(parallel = perf().jobs) {
  return Math.max(1, Math.floor(perf().threads / Math.max(1, parallel)));
}
export function lowerPriority(proc) {
  if (!proc?.pid) return;
  const { priority } = perf();
  if (priority === 'normal') return;
  const P = os.constants.priority;
  try { os.setPriority(proc.pid, priority === 'idle' ? P.PRIORITY_LOW : P.PRIORITY_BELOW_NORMAL); } catch { /* process already gone */ }
}
// Insert thread caps into an ffmpeg command line (decoder + filter threads up front, encoder threads before the output).
export function withThreads(args, n = jobThreads()) {
  const out = ['-threads', String(n), '-filter_threads', String(n), ...args];
  out.splice(out.length - 1, 0, '-threads', String(n));
  return out;
}

// Run a process to completion, collecting output. Rejects on non-zero exit.
export function run(bin, args, { onStderr, signal, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, bin === FFMPEG ? withThreads(args) : args, { windowsHide: true });
    if (bin === FFMPEG) lowerPriority(p);
    const out = [];
    let outSize = 0;
    let err = '';
    p.stdout.on('data', (d) => { outSize += d.length; if (outSize <= maxBuffer) out.push(d); });
    p.stderr.on('data', (d) => { const s = d.toString(); err = (err + s).slice(-20000); onStderr?.(s); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(Object.assign(new Error(`${path.basename(bin)} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`), { code, stderr: err }));
    });
    if (signal?.aborted) p.kill('SIGKILL');
    else if (signal) signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
  });
}

const parseRate = (r) => {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
};

const BROWSER_VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
const BROWSER_PIXFMTS = ['yuv420p', 'yuvj420p', 'nv12'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'pcm_s32le'];
const BROWSER_IMAGE_CODECS = ['png', 'mjpeg', 'webp', 'gif', 'bmp', 'svg'];
const BROWSER_CONTAINERS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'mp3', 'wav', 'ogg', 'flac', 'aac'];

export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout.toString('utf8'));
  const streams = info.streams || [];
  const fmt = info.format || {};
  const ext = path.extname(file).slice(1).toLowerCase();
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const formatName = fmt.format_name || '';
  const isImage = !!v && (/_pipe$|^image2$|^png$|^webp$|^gif$|^svg/.test(formatName) || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'avif', 'svg'].includes(ext));
  const type = isImage ? 'image' : v ? 'video' : a ? 'audio' : null;
  if (!type) throw new Error('No audio or video streams found');

  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  let rotation = 0;
  if (v) {
    const dm = (v.side_data_list || []).find((d) => d.rotation != null);
    rotation = dm ? Number(dm.rotation) : Number(v.tags?.rotate || 0);
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  }
  const duration = type === 'image' ? 0 : Number(fmt.duration || v?.duration || a?.duration || 0);
  // the camera's start timecode ("20:53:15:09"; ";" before the frames = drop-frame): MP4/MOV keep it on a tmcd or
  // data track (Sony's rtmd), MXF and others in the container. Editors that import an XML (Resolve, Premiere)
  // match clips to their files by it.
  const tcTag = [fmt, v, ...streams].map((s) => s?.tags?.timecode).find((t) => /^\d{1,2}:\d{2}:\d{2}[:;.]\d{2,3}$/.test(String(t || '').trim()));
  const timecode = type === 'video' && tcTag ? String(tcTag).trim() : null;
  const fps = v && type === 'video' ? Math.round((parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate)) * 1000) / 1000 : 0;
  let browserOk = true;
  if (type === 'video') {
    browserOk = BROWSER_VIDEO_CODECS.includes(v.codec_name) && BROWSER_PIXFMTS.includes(v.pix_fmt) && BROWSER_CONTAINERS.includes(formatName)
      && ['mp4', 'm4v', 'mov', 'webm'].includes(ext) && (!a || BROWSER_AUDIO_CODECS.includes(a.codec_name));
  } else if (type === 'audio') {
    browserOk = BROWSER_AUDIO_CODECS.includes(a.codec_name) && ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4'].includes(ext);
  } else if (type === 'image') {
    browserOk = BROWSER_IMAGE_CODECS.includes(v.codec_name) || ext === 'svg';
  }
  return {
    type,
    duration: Math.round(duration * 1e6) / 1e6,
    width, height, fps, timecode,
    hasVideo: type !== 'audio',
    hasAudio: !!a,
    codec: v?.codec_name || a?.codec_name || null,
    audioCodec: a?.codec_name || null,
    pixFmt: v?.pix_fmt || null,
    alpha: hasAlpha(v?.pix_fmt),
    sampleRate: a ? Number(a.sample_rate) : null,
    channels: a ? a.channels : null,
    size: Number(fmt.size || 0),
    rotation: rotation || undefined,
    browserOk,
  };
}

// Parse "out_time_ms" from `-progress pipe:2` style key=value output.
export function progressParser(totalSec, cb) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line) || /time=(\d+):(\d+):(\d+\.\d+)/.exec(line);
      if (!m) continue;
      const sec = m.length === 2 ? Number(m[1]) / 1e6 : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (totalSec > 0) cb(Math.max(0, Math.min(1, sec / totalSec)));
    }
  };
}

// Pixel formats that carry transparency (ProRes 4444, QuickTime Animation, PNG/QT-PNG, CineForm RGBA…).
export function hasAlpha(pixFmt) {
  return !!pixFmt && /^(yuva|rgba|bgra|argb|abgr|gbrap|ya[0-9]|pal8)/.test(pixFmt);
}
