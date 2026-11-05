// Audio sync (the timeline's Synchronize… › Audio): how far one recording is offset from another, to a fraction of a
// sample, from the sound itself. The same approach as dedicated sync tools:
//   1. Coarse: each file decoded once at 8 kHz into an onset envelope (where sounds start, 200 per second). Correlating
//      those finds the offset to ±5 ms over the whole length, whatever the microphones, levels and room.
//   2. Fine: 20 s of both at 48 kHz around the busiest stretch they share, lined up by the coarse offset, correlated
//      with GCC-PHAT (phase-weighted, so the sharpest common sounds decide); the peak is refined between samples.
// The answer is lag: the moment at time t in the reference's file is at time t + lag in the other file. With a
// confidence: how far the best match stands above the next best (about 1 means it is a guess).
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import fsp from 'node:fs/promises';
import { FFMPEG, lowerPriority } from './ffmpeg.js';

const ENV_RATE = 200; // onset envelope samples per second
const FINE_RATE = 48000;
const WINDOW = 20; // seconds compared at full rate
const MARGIN = 0.06; // seconds either side of the coarse offset searched at full rate

let worker = null;
const waiting = new Map();
let seq = 0;
function work(msg) {
  if (!worker) {
    // its own start options: the parent's (e.g. --input-type) don't apply to it
    worker = new Worker(new URL('./syncworker.js', import.meta.url), { execArgv: [] });
    worker.unref();
    worker.on('message', (m) => { const p = waiting.get(m.id); if (!p) return; waiting.delete(m.id); if (m.ok) p.resolve(m); else p.reject(new Error(m.error)); });
    worker.on('error', (err) => { for (const p of waiting.values()) p.reject(err); waiting.clear(); worker = null; });
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, [msg.a.buffer, msg.b.buffer]);
  });
}

function decode(abs, { rate, start = 0, dur = null, format = 'f32le' }) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', ...(start > 0 ? ['-ss', start.toFixed(6)] : []), ...(dur ? ['-t', dur.toFixed(6)] : []), '-i', abs, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(rate), '-f', format, 'pipe:1'];
    const p = spawn(FFMPEG, args, { windowsHide: true });
    lowerPriority(p);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) { reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}`)); return; }
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2).slice());
    });
  });
}

// Onset envelope of a whole file: high-passed, RMS over 5 ms, then the rise of its log (sound starting), ≥ 0.
const envCache = new Map(); // `${abs}|${size}|${mtime}` -> { onset, level, dur }
async function envelope(abs) {
  const st = await fsp.stat(abs);
  const key = `${abs}|${st.size}|${st.mtimeMs}`;
  if (envCache.has(key)) return envCache.get(key);
  const x = await decode(abs, { rate: 8000 });
  const hop = 8000 / ENV_RATE;
  const n = Math.floor(x.length / hop);
  const onset = new Float64Array(n), level = new Float64Array(n);
  let prev = 0, prevLog = Math.log(1e-4);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) { const d = x[j] - prev; prev = x[j]; s += d * d; }
    const rms = Math.sqrt(s / hop);
    const lg = Math.log(rms + 1e-4);
    onset[i] = Math.max(0, lg - prevLog);
    level[i] = rms;
    prevLog = lg;
  }
  const out = { onset, level, dur: x.length / 8000 };
  if (envCache.size > 24) envCache.delete(envCache.keys().next().value);
  envCache.set(key, out);
  return out;
}

// a window of a file at 48 kHz, with silence where it reaches before the file's start
async function windowAt(abs, start, dur) {
  if (start >= 0) return decode(abs, { rate: FINE_RATE, start, dur });
  const pad = Math.round(-start * FINE_RATE);
  const rest = await decode(abs, { rate: FINE_RATE, start: 0, dur: dur + start });
  const out = new Float32Array(pad + rest.length);
  out.set(rest, pad);
  return out;
}

// { lag, confidence, coarse: { lag, confidence }, overlap } for two files (absolute paths)
export async function audioLag(refAbs, otherAbs) {
  const [R, C] = await Promise.all([envelope(refAbs), envelope(otherAbs)]);
  if (R.dur < 0.5 || C.dur < 0.5) throw new Error('too short to sync by sound');
  const coarse = await work({ job: 'coarse', a: Float64Array.from(R.onset), b: Float64Array.from(C.onset), guard: 20 });
  const L = coarse.lag / ENV_RATE;
  // where both play, in the reference's time
  const o0 = Math.max(0, -L), o1 = Math.min(R.dur, C.dur - L);
  if (o1 - o0 < 1) throw new Error('the two recordings don\'t play at the same time');
  // the busiest stretch they share: most sound starting there
  const W = Math.min(WINDOW, o1 - o0);
  let best = o0, bestE = -1;
  for (let t = o0; t + W <= o1 + 1e-9; t += 1) {
    let e = 0;
    for (let i = Math.floor(t * ENV_RATE); i < Math.floor((t + W) * ENV_RATE) && i < R.onset.length; i++) e += R.onset[i];
    if (e > bestE) { bestE = e; best = t; }
  }
  const [a, b] = await Promise.all([windowAt(refAbs, best, W), windowAt(otherAbs, best + L - MARGIN, W + 2 * MARGIN)]);
  const fine = await work({ job: 'fine', a: Float64Array.from(a), b: Float64Array.from(b), lo: 0, hi: Math.round(2 * MARGIN * FINE_RATE), guard: 48, phat: 0.8 });
  const fineLag = L - MARGIN + fine.lag / FINE_RATE;
  // the fine answer must agree with the coarse one (it searched only ±MARGIN around it); a weak fine peak keeps the coarse
  const useFine = Number.isFinite(fine.ratio) ? fine.ratio > 1.15 : true;
  return {
    lag: useFine ? fineLag : L,
    confidence: Math.min(useFine ? fine.ratio : 1, coarse.ratio),
    precise: useFine,
    coarse: { lag: L, confidence: coarse.ratio },
    overlap: o1 - o0,
  };
}
