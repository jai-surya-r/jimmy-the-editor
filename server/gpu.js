// Graphics hardware for exports. Motion graphics render on the CPU (a headless browser drawing frames, saved
// as ProRes 4444 with alpha, which only the CPU encodes); exports and pre-rendering can move their two heaviest
// steps to the GPU: encoding the H.264 output (NVENC / Quick Sync / AMF / VideoToolbox) and decoding heavy
// sources (4K, HEVC, AV1). The CPU is then mostly free for graphics.
//
// Detection is real: every candidate encodes and decodes a short test clip with the exact settings exports
// use, and only what passes is offered. It is cached until ffmpeg or the graphics hardware changes. A GPU that
// fails during an export is set aside for the session and the export carries on on the CPU.
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { FFMPEG, cpuH264, bitrateArgs } from './ffmpeg.js';
import { getConfig, updateConfig } from './config.js';
import { tempRoot } from './cachedir.js';
import { budget } from './budget.js';

// What each kind of hardware can do, and how. `encode` gives the encoder arguments for a quality level.
const VENDORS = [
  {
    id: 'nvidia', match: /nvidia|geforce|quadro|rtx|gtx/i, platforms: ['win32', 'linux'], codec: 'h264_nvenc', pix: 'yuv420p',
    decode: 'cuda', // scale_cuda path: decode + scale on the GPU
    // quality matched to the CPU encoder by VMAF on real footage: cq 21 ~ x264 crf 17 (high), 24 ~ crf 20, 33 ~ crf 26
    encode: (q) => ({
      high: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', 'high'],
      standard: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '24', '-b:v', '0', '-spatial-aq', '1', '-profile:v', 'high'],
      draft: ['-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-cq', '33', '-b:v', '0', '-profile:v', 'high'],
    })[q],
    hevc: {
      codec: 'hevc_nvenc',
      encode: (q) => ['-c:v', 'hevc_nvenc', '-preset', q === 'draft' ? 'p3' : 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', { high: '23', standard: '26', draft: '33' }[q], '-b:v', '0', '-spatial-aq', '1', '-profile:v', 'main'],
    },
    // a bitrate instead of a quality: the codec and its preset (rateArgs adds the numbers)
    rate: (codec, q) => ['-c:v', codec, '-preset', q === 'draft' ? 'p3' : 'p6', '-tune', 'hq', '-spatial-aq', '1', '-profile:v', codec === 'h264_nvenc' ? 'high' : 'main'],
    cbr: ['-rc', 'cbr'], vbr: ['-rc', 'vbr'],
  },
  {
    id: 'intel', match: /intel|iris|uhd graphics|arc/i, platforms: ['win32', 'linux'], codec: 'h264_qsv', pix: 'nv12', decode: 'qsv',
    encode: (q) => ({
      high: ['-c:v', 'h264_qsv', '-preset', 'slower', '-global_quality', '21', '-profile:v', 'high'],
      standard: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '24', '-profile:v', 'high'],
      draft: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '31', '-profile:v', 'high'],
    })[q],
    hevc: {
      codec: 'hevc_qsv',
      encode: (q) => ['-c:v', 'hevc_qsv', '-preset', { high: 'slower', standard: 'medium', draft: 'veryfast' }[q], '-global_quality', { high: '23', standard: '26', draft: '32' }[q], '-profile:v', 'main'],
    },
    rate: (codec, q) => ['-c:v', codec, '-preset', q === 'draft' ? 'veryfast' : 'slower', '-profile:v', codec === 'h264_qsv' ? 'high' : 'main'],
    cbr: [], vbr: [],
  },
  {
    id: 'amd', match: /amd|radeon/i, platforms: ['win32', 'linux'], codec: 'h264_amf', pix: 'nv12', decode: 'd3d11va',
    encode: (q) => ({
      high: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20', '-qp_b', '22', '-profile:v', 'high'],
      standard: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '21', '-qp_p', '23', '-qp_b', '25', '-profile:v', 'high'],
      draft: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '25', '-qp_p', '27', '-qp_b', '29', '-profile:v', 'high'],
    })[q],
    hevc: {
      codec: 'hevc_amf',
      encode: (q) => ['-c:v', 'hevc_amf', '-quality', { high: 'quality', standard: 'balanced', draft: 'speed' }[q], '-rc', 'cqp', '-qp_i', { high: '20', standard: '23', draft: '27' }[q], '-qp_p', { high: '22', standard: '25', draft: '29' }[q], '-profile:v', 'main'],
    },
    rate: (codec, q) => ['-c:v', codec, '-quality', q === 'draft' ? 'speed' : 'quality', '-profile:v', codec === 'h264_amf' ? 'high' : 'main'],
    cbr: ['-rc', 'cbr'], vbr: ['-rc', 'vbr_peak'],
  },
  {
    id: 'apple', match: /apple|m\d|amd|radeon|intel/i, platforms: ['darwin'], codec: 'h264_videotoolbox', pix: 'nv12', decode: 'videotoolbox',
    encode: (q) => ({
      high: ['-c:v', 'h264_videotoolbox', '-q:v', '72', '-allow_sw', '0', '-profile:v', 'high'],
      standard: ['-c:v', 'h264_videotoolbox', '-q:v', '62', '-allow_sw', '0', '-profile:v', 'high'],
      draft: ['-c:v', 'h264_videotoolbox', '-q:v', '48', '-allow_sw', '0', '-profile:v', 'high'],
    })[q],
    hevc: {
      codec: 'hevc_videotoolbox',
      encode: (q) => ['-c:v', 'hevc_videotoolbox', '-q:v', { high: '70', standard: '60', draft: '46' }[q], '-allow_sw', '0', '-profile:v', 'main'],
    },
    rate: (codec) => ['-c:v', codec, '-allow_sw', '0', '-profile:v', codec === 'h264_videotoolbox' ? 'high' : 'main'],
    cbr: ['-constant_bit_rate', '1'], vbr: [],
    prores: ['-c:v', 'prores_videotoolbox', '-profile:v', 'hq'], // Apple silicon with a ProRes engine (M1 Pro/Max and later)
  },
];
const vendor = (id) => VENDORS.find((v) => v.id === id);
const LABEL = { nvidia: 'NVIDIA', intel: 'Intel', amd: 'AMD', apple: 'Apple' };

let detecting = null;
let failed = null; // { device, reason }: set aside for this session after failing during an export
const listeners = new Set();
export const onGpuChange = (fn) => listeners.add(fn);
const changed = () => { for (const fn of listeners) { try { fn(gpuInfo()); } catch { /* ignore */ } } };

// ------------------------------------------------------------------ settings

export function gpuSettings() {
  const s = getConfig().gpu || {};
  return {
    device: s.device || null, // which detected device exports use, or null for the CPU only
    draft: s.draft === 'cpu' ? 'cpu' : 'gpu',
    high: s.high === 'cpu' ? 'cpu' : 'gpu', // high and standard exports, and background pre-rendering
    battery: s.battery === 'cpu' ? 'cpu' : 'gpu',
    asked: !!s.asked,
  };
}
export function cleanGpuSettings(s = {}) {
  const det = getConfig().gpuDetected?.devices || [];
  return {
    device: det.some((d) => d.id === s.device && d.encode) ? s.device : null,
    draft: s.draft === 'cpu' ? 'cpu' : 'gpu', high: s.high === 'cpu' ? 'cpu' : 'gpu',
    battery: s.battery === 'cpu' ? 'cpu' : 'gpu', asked: true,
  };
}

// What the editor shows: detection results, settings, and whether to ask the person once.
export function gpuInfo() {
  const det = getConfig().gpuDetected || null;
  const s = gpuSettings();
  const usable = (det?.devices || []).filter((d) => d.encode);
  const best = usable.slice().sort((a, b) => (b.speedup || 0) - (a.speedup || 0))[0] || null;
  return {
    detecting: !!detecting, detected: det, settings: s, failed,
    // first time a GPU that helps is found: the editor asks whether to use it
    ask: !s.asked && best && (best.speedup >= 1.15 || best.cpuSaving >= 1.5) ? best : null,
  };
}

// ------------------------------------------------------------------ engine for an export

// The output side of an export at this quality: which encoder (null = CPU) and whether heavy sources decode on
// the GPU. Part of a chunk's spec, so chunks made either way never mix in one file.
export function engineFor(quality, format, { width = 0, height = 0 } = {}) {
  const s = gpuSettings();
  const det = getConfig().gpuDetected?.devices || [];
  const d = det.find((x) => x.id === s.device);
  const v = d && vendor(d.id);
  const want = (quality === 'draft' ? s.draft : s.high) === 'gpu' && !(budget.battery && s.battery === 'cpu');
  if (!v || !want || (failed && failed.device === d.id)) return { enc: null, dec: null };
  let enc = null;
  // hardware H.264 encoders stop at 4096 px a side: bigger frames encode on the CPU
  if (format === 'h264' && d.encode && Math.max(width, height) <= 4096) enc = d.id;
  else if (format === 'hevc' && d.hevc && Math.max(width, height) <= 8192) enc = `${d.id}-hevc`;
  else if (format === 'prores' && d.prores) enc = `${d.id}-prores`;
  return { enc, dec: d.decode ? d.id : null };
}

// ffmpeg arguments for the encoder of a spec made by engineFor (null: the caller uses the CPU encoder)
export function encoderArgs(spec) {
  if (!spec.enc) return null;
  const v = vendor(spec.enc.replace(/-(prores|hevc)$/, ''));
  if (!v) return null;
  if (spec.enc.endsWith('-prores')) return { pix: 'yuv422p10le', args: v.prores };
  const hevc = spec.enc.endsWith('-hevc');
  const q = spec.quality || 'high';
  // Export › Bitrate: an average (and a ceiling) instead of a quality
  if (spec.rate) return { pix: v.pix, args: [...v.rate(hevc ? v.hevc.codec : v.codec, q), ...(spec.rate.cbr ? v.cbr : v.vbr), ...bitrateArgs(spec.rate)] };
  return { pix: v.pix, args: hevc ? v.hevc.encode(q) : v.encode(q) };
}

// Decoder arguments for one source (null: decode on the CPU). Only heavy sources go to the GPU: 4K-class H.264,
// and HEVC / AV1 at any size. Light 1080p H.264 decodes as cheaply on the CPU, and leaves the GPU to the encoder.
export function decodePlan(spec, media) {
  if (!spec.dec || !media || process.env.JIMMY_NO_HW_DECODE) return null;
  const codec = String(media.codec || '').toLowerCase();
  const pixels = (media.width || 0) * (media.height || 0);
  const heavy = codec === 'hevc' || codec === 'av1' || (codec === 'h264' && pixels > 2560 * 1440);
  if (!heavy || media.hasAlpha) return null;
  // GPU H.264 decoders only take 8-bit 4:2:0: 10-bit / 4:2:2 camera files (Sony XAVC and the like) would just fail first
  if (codec === 'h264' && media.pixFmt && !/^(yuvj?420p|nv12)$/.test(media.pixFmt)) return null;
  const v = vendor(spec.dec);
  if (!v) return null;
  return { hwaccel: v.decode, cuda: v.decode === 'cuda' };
}

// A GPU export step failed: use the CPU for the rest of this session (the editor is told).
export function gpuFailed(device, reason) {
  if (failed?.device === device) return;
  failed = { device, reason: String(reason || '').slice(0, 300) };
  console.warn(`[gpu] ${device} set aside for this session: ${failed.reason}`);
  changed();
}

// ------------------------------------------------------------------ detection

function run(args, ms = 30000) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, ms);
    p.on('error', () => { clearTimeout(timer); resolve({ ok: false, err: 'ffmpeg could not start' }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(err);
      resolve({ ok: code === 0, err, cpu: m ? +m[1] + +m[2] : null, wall: m ? +m[3] : null });
    });
  });
}
const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 10000, windowsHide: true }, (e, out) => resolve(e ? '' : String(out))));

async function adapterNames() {
  if (process.platform === 'win32') return (await sh('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (process.platform === 'darwin') {
    try { return (JSON.parse(await sh('system_profiler', ['SPDisplaysDataType', '-json'])).SPDisplaysDataType || []).map((x) => x.sppci_model || x._name).filter(Boolean); } catch { return []; }
  }
  const nv = (await sh('nvidia-smi', ['-L'])).split('\n').map((l) => l.replace(/^GPU \d+: /, '').replace(/ \(UUID.*$/, '').trim()).filter(Boolean);
  const pci = (await sh('lspci', [])).split('\n').filter((l) => /VGA|3D|Display/.test(l)).map((l) => l.replace(/^.*?: /, ''));
  return [...nv, ...pci];
}

const encoders = async () => (await sh(FFMPEG, ['-hide_banner', '-encoders'])).split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);

// Test material like an export's: 1080p RGBA frames with light grain, converted the way export chunks are.
// (Calibrated against real camera footage: plain test patterns flatter the CPU encoder, heavy grain the GPU.)
const testFrames = (pix) => ['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30,noise=alls=2:allf=t,format=rgba,scale=out_color_matrix=bt709:out_range=tv,format=${pix}`, '-frames:v', '150'];
const CHUNK_THREADS = () => String(Math.max(2, Math.min(8, Math.round(os.availableParallelism?.() / 4 || 2)))); // about what one export chunk gets

async function detectNow() {
  const tmp = path.join(tempRoot(), `claude-edit-gpu-${process.pid}`);
  await fsp.mkdir(tmp, { recursive: true });
  const names = await adapterNames();
  const have = new Set(await encoders());
  const th = CHUNK_THREADS();
  // baseline: the CPU encoder exports use today (high quality, the threads one export chunk gets)
  const cpu = await run(['-hide_banner', '-nostats', '-benchmark', '-y', '-threads', th, ...testFrames('yuv420p'), ...cpuH264(17, 'medium'), '-threads', th, path.join(tmp, 'cpu.mp4')]);
  // a 4K HEVC clip to test decoding (made by the GPU's own encoder when it can, else the CPU's)
  const devices = [];
  for (const v of VENDORS) {
    if (!v.platforms.includes(process.platform) || !have.has(v.codec)) continue;
    const name = names.find((n) => v.match.test(n)) || null;
    if (!name && process.platform !== 'darwin') continue; // no such hardware in this machine
    const file = path.join(tmp, `${v.id}.mp4`);
    const enc = await run(['-hide_banner', '-nostats', '-benchmark', '-y', '-threads', th, ...testFrames(v.pix), ...v.encode('high'), file]);
    const okEnc = enc.ok && fs.existsSync(file) && fs.statSync(file).size > 1000;
    let okDec = false;
    if (okEnc) {
      const chain = v.decode === 'cuda'
        ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', file, '-vf', 'scale_cuda=1280:720:interp_algo=bicubic:format=yuv444p,hwdownload,format=yuv444p,format=rgba']
        : ['-hwaccel', v.decode, '-hwaccel_output_format', v.decode === 'd3d11va' ? 'd3d11' : v.decode, '-i', file, '-vf', 'hwdownload,format=nv12,format=rgba'];
      okDec = (await run(['-v', 'error', ...chain, '-f', 'null', '-'])).ok;
    }
    let okHevc = false;
    if (okEnc && v.hevc && have.has(v.hevc.codec)) {
      const hf = path.join(tmp, `${v.id}-hevc.mp4`);
      okHevc = (await run(['-v', 'error', '-y', ...testFrames(v.pix).slice(0, -1), '30', ...v.hevc.encode('high'), hf])).ok && fs.existsSync(hf) && fs.statSync(hf).size > 1000;
    }
    let okProres = false;
    if (v.prores && have.has('prores_videotoolbox')) okProres = (await run(['-v', 'error', '-y', ...testFrames('yuv422p10le'), ...v.prores, path.join(tmp, 'p.mov')])).ok;
    devices.push({
      id: v.id, name: name || `${LABEL[v.id]} graphics`, label: LABEL[v.id],
      encode: okEnc, decode: okDec, prores: okProres, hevc: okHevc,
      // measured here: encoding 150 frames of 1080p at high quality, against the CPU encoder
      speedup: okEnc && cpu.wall && enc.wall ? +(cpu.wall / enc.wall).toFixed(1) : null,
      cpuSaving: okEnc && cpu.cpu && enc.cpu ? +(cpu.cpu / Math.max(0.01, enc.cpu)).toFixed(1) : null,
      error: okEnc ? null : (enc.err.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240) || 'did not work'),
    });
  }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return { sig: await signature(names), at: Date.now(), names, devices };
}

// raised when detection looks for something new (2: HEVC), so a cached result is detected again once
const DETECT_VERSION = 2;
async function signature(names) {
  let st = null;
  try { st = await fsp.stat(FFMPEG); } catch { /* none */ }
  return `${names.join('|')}::${FFMPEG}:${st?.size}:${st?.mtimeMs}:${DETECT_VERSION}`;
}

// Detect (or re-use the cached result while nothing changed). force: the "Detect again" button.
export function detectGpu({ force = false } = {}) {
  if (detecting) return detecting;
  if (!FFMPEG) return Promise.resolve(null);
  detecting = (async () => {
    const cached = getConfig().gpuDetected;
    if (!force && cached?.sig) {
      const names = await adapterNames();
      if (cached.sig === (await signature(names))) return cached;
    }
    changed();
    const det = await detectNow();
    const s = getConfig().gpu || {};
    // the chosen device is gone or no longer works: back to the CPU
    const patch = { gpuDetected: det };
    if (s.device && !det.devices.some((d) => d.id === s.device && d.encode)) patch.gpu = { ...s, device: null };
    await updateConfig(patch);
    if (force) failed = null;
    console.log(`[gpu] ${det.devices.length ? det.devices.map((d) => `${d.name}: ${d.encode ? `encode ok (${d.speedup}x speed, ${d.cpuSaving}x less CPU)` : `no (${d.error})`}${d.decode ? ', decode ok' : ''}${d.hevc ? ', HEVC ok' : ''}${d.prores ? ', ProRes ok' : ''}`).join('; ') : 'no usable graphics hardware'}`);
    return det;
  })().catch((err) => { console.warn('[gpu] detection failed:', err.message); return null; }).finally(() => { detecting = null; changed(); });
  return detecting;
}
