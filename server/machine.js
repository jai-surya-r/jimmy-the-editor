// How strong this computer is, measured once (a few seconds, in the background, a little after the first start and
// again when the hardware or ffmpeg changes), and what Jimmy should ask of it: the power tier.
//
//   light     a small laptop: fewer things at once, background work at idle priority, no background pre-rendering,
//             proxies for anything bigger than 1080p (or faster than 30 fps above 720p), the preview at half size
//   balanced  most laptops: proxies above 1080p, a few things at once
//   full      a strong desktop or workstation: the settings Jimmy always had
//
// The test: CPU cores, memory, and how fast ffmpeg decodes 1080p H.264 on one core (the work behind proxies,
// thumbnails, exports and pre-rendering). Decoding with every core and a JavaScript loop are measured and kept, for
// the record only (see tierFor).
// Settings › Performance shows the result; "Power profile" is Auto (the tier measured here) or one picked by hand.
// When a tier is first measured, its settings are applied only if the performance settings were never changed
// (they still equal the old defaults); otherwise they stay as the person set them and Settings offers the tier's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FFMPEG, CPU_COUNT } from './ffmpeg.js';
import { getConfig, updateConfig } from './config.js';
import { tempRoot } from './cachedir.js';
import { TIER_SETTINGS } from './tiers.js';

export { TIERS, TIER_SETTINGS, TIER_LIMITS, currentTier, tierLimits } from './tiers.js';

const TEST_VERSION = 1;
// the performance settings every install had before tiers: still these = never changed by hand
const OLD_DEFAULTS = { usage: 70, priority: 'low', jobs: 2, prerenderEnabled: true };

function signature() {
  const cpu = os.cpus()[0]?.model || '?';
  let st = null;
  try { st = fs.statSync(FFMPEG); } catch { /* none */ }
  return `${cpu}|${CPU_COUNT}|${Math.round(os.totalmem() / 1024 ** 3)}|${st?.size || 0}|${TEST_VERSION}`;
}

function run(args, ms = 60000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => p.kill(), ms);
    p.on('error', () => { clearTimeout(timer); resolve({ ok: false, ms: 0, err: 'ffmpeg did not start' }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, err }); });
  });
}

// single-core JavaScript speed: ms for a fixed amount of work (smaller is faster; a fast desktop core ≈ 60-90)
function jsMs() {
  const t0 = performance.now();
  let x = 0;
  const a = new Float64Array(4096);
  for (let r = 0; r < 4000; r++) for (let i = 0; i < a.length; i++) { a[i] = Math.sqrt(a[i] + i * r) * 1.0001; x += a[i] % 7; }
  return Math.round(performance.now() - t0 + (x < 0 ? 1 : 0));
}

const FRAMES = 150;
export async function measure() {
  const dir = path.join(tempRoot(), 'machine-test');
  fs.mkdirSync(dir, { recursive: true });
  const clip = path.join(dir, `bench-${TEST_VERSION}.mp4`);
  if (!fs.existsSync(clip)) {
    // 5 s of busy 1080p30 at a camera-like bitrate (OpenH264 is in every ffmpeg build Jimmy uses)
    const made = await run(['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30,noise=alls=12:allf=t`, '-frames:v', String(FRAMES),
      '-c:v', 'libopenh264', '-b:v', '20M', '-pix_fmt', 'yuv420p', clip]);
    if (!made.ok) throw new Error(`no test clip: ${made.err.trim().split('\n').pop()}`);
  }
  const decode = async (threads) => {
    const r = await run(['-hide_banner', '-threads', String(threads), '-i', clip, '-f', 'null', '-']);
    if (!r.ok) throw new Error(`decode test failed: ${r.err.trim().split('\n').pop()}`);
    return Math.round((FRAMES / r.ms) * 1000);
  };
  await decode(CPU_COUNT); // warm-up (disk, caches)
  const all = Math.max(await decode(CPU_COUNT), await decode(CPU_COUNT));
  const one = Math.max(await decode(1), await decode(1));
  const js = Math.min(jsMs(), jsMs());
  return { decodeFps: all, decodeFps1: one, jsMs: js };
}

// One core's 1080p decode speed is the steadiest number (decoding many frames with every core scales badly and
// varies run to run; the JavaScript loop varies with the CPU's power state): a fast desktop or laptop core decodes
// ~100+ fps, an ultrabook's ~50-70, a small Celeron/Pentium's ~20-35.
export function tierFor({ cores, ramGB, decodeFps1 }) {
  if (ramGB < 7.5 || cores <= 4 || decodeFps1 < 45) return 'light';
  if (ramGB >= 15 && cores >= 12 && decodeFps1 >= 80) return 'full';
  return 'balanced';
}

// the tier's settings, written into config (performance, prerender), keeping what the tier doesn't set
export async function applyTier(tier) {
  const cfg = getConfig();
  const t = TIER_SETTINGS[tier];
  if (!t) throw new Error(`unknown tier ${tier}`);
  await updateConfig({ performance: { ...cfg.performance, ...t.performance }, prerender: { ...cfg.prerender, ...t.prerender } });
}
const untouched = (cfg) => {
  const p = cfg.performance || {};
  return Number(p.usage) === OLD_DEFAULTS.usage && (p.priority || 'low') === OLD_DEFAULTS.priority && Number(p.jobs || 2) === OLD_DEFAULTS.jobs
    && (cfg.prerender?.enabled !== false) === OLD_DEFAULTS.prerenderEnabled && (!p.profile || p.profile === 'auto');
};

let testing = null;
const listeners = new Set();
export const onMachineChange = (fn) => listeners.add(fn);
// Measure (or reuse the result while the hardware and ffmpeg are the same). force: "Test again" in Settings.
export function testMachine({ force = false } = {}) {
  if (testing) return testing;
  // (Windows only for now: see currentTier)
  if (!FFMPEG || process.env.JIMMY_NO_MACHINE_TEST || (process.platform !== 'win32' && !process.env.JIMMY_TIERS_ANYWHERE)) return Promise.resolve(getConfig().machine || null);
  testing = (async () => {
    const cfg = getConfig();
    const sig = signature();
    if (!force && cfg.machine?.sig === sig) return cfg.machine;
    const first = !cfg.machine;
    const m = await measure();
    const info = {
      sig, at: Date.now(), cpu: (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').trim(), cores: CPU_COUNT,
      ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, ...m,
    };
    info.tier = process.env.JIMMY_FAKE_TIER || tierFor(info);
    const patch = { machine: info };
    await updateConfig(patch);
    // a first measurement on an install whose performance settings were never changed: use the tier's settings
    if (first && untouched(getConfig()) && TIER_SETTINGS[info.tier]) { await applyTier(info.tier); info.applied = true; }
    console.log(`[machine] ${info.cpu}, ${info.cores} threads, ${info.ramGB} GB: 1080p decode ${info.decodeFps} fps (one core ${info.decodeFps1}), JS ${info.jsMs} ms → ${info.tier}${info.applied ? ' (its settings applied)' : ''}`);
    for (const fn of listeners) fn(info);
    return info;
  })().catch((err) => { console.warn('[machine] test failed:', err.message); return null; }).finally(() => { testing = null; });
  return testing;
}
export const machineTesting = () => !!testing;
