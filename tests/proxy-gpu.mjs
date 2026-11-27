// Proxies on the graphics card (server/media.js): with a GPU turned on for exports, 4K H.264 and HEVC proxies decode
// and encode on it and come out as playable 1280-wide H.264; a GPU attempt that fails is redone on the CPU. (How much
// faster and lighter it is shows on longer clips: 4K HEVC 20 s took 2.2-2.6 s instead of 14.5 s, with 1/6 the CPU.) Skips the GPU parts on a machine without a detected encoder.
//   node tests/proxy-gpu.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';

const { FFMPEG, FFPROBE } = await import('../server/ffmpeg.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

const BASE = path.join(WORK, 'proxy-gpu');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
const SRC = {
  h264: ['-c:v', 'libopenh264', '-b:v', '40M'],
  hevc: ['-c:v', 'libkvazaar', '-b:v', '20M'],
};
const make = (name, codec) => {
  const file = path.join(BASE, `${name}.${codec === 'hevc' ? 'mov' : 'mp4'}`);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=d=6',
    '-pix_fmt', 'yuv420p', ...SRC[codec], '-c:a', 'aac', '-shortest', file], { encoding: 'utf8' });
  if (r.status) throw new Error(r.stderr);
  return file;
};
const probe = (file) => {
  const ffprobe = FFPROBE || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,pix_fmt', '-of', 'json', file], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).streams[0]; } catch { return null; }
};

// the GPUs found here (the server's detection, cached in its config), then every test clip before the server starts:
// making a 4K HEVC clip takes a while, and a connection left idle that long is closed by the server
const { getConfig } = await import('../server/config.js');
const devices = (getConfig().gpuDetected?.devices || []).filter((d) => d.encode);
const runs = [{ label: 'CPU', device: null }, ...devices.map((d) => ({ label: d.name, device: d.id }))];
const clips = {};
for (const run of runs) for (const codec of ['h264', 'hevc']) clips[`${codec}-${run.device || 'cpu'}`] = make(`${codec}-${run.device || 'cpu'}`, codec);
const fallbackClip = devices.length ? make('fallback', 'h264') : null;
const srv = await startServer();
try {
  await api('POST', '/api/settings', { prerender: { enabled: false }, proxyMode: 'always' });
  for (const run of runs) {
    await api('POST', '/api/settings', { gpu: { device: run.device, draft: 'gpu', high: 'gpu', battery: 'gpu' } });
    for (const codec of ['h264', 'hevc']) {
      console.log(`  ${run.label} ${codec}…`);
      const clip = clips[`${codec}-${run.device || 'cpu'}`]; // a file of its own: proxies are cached per file
      const dir = path.join(BASE, `p-${codec}-${run.device || 'cpu'}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'P', settings: {}, folders: [],
        media: [{ id: 'm1', name: 'clip', path: clip, type: 'video' }],
        sequences: [{ id: 's1', name: 'S', width: 1920, height: 1080, fps: 25, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }));
      const t0 = Date.now();
      const { id } = await api('POST', '/api/projects/open', { path: dir });
      let st = null;
      for (let i = 0; i < 1200; i++) { st = (await api('GET', `/api/p/${id}`)).mediaStatus.m1; if (st?.proxy === 'ready' || st?.proxy === 'error') break; await sleep(100); }
      const ms = Date.now() - t0;
      const p = st?.proxyPath ? probe(st.proxyPath) : null;
      ok(st?.proxy === 'ready' && p?.codec_name === 'h264' && p.width === 1280 && /^(yuv420p|nv12)$/.test(p.pix_fmt), `${run.label}, 4K ${codec}: a playable 1280-wide H.264 proxy in ${(ms / 1000).toFixed(1)} s (${st?.proxy}${st?.error ? `: ${st.error}` : ''}, ${JSON.stringify(p)})`);
    }
  }
} finally {
  await api('POST', '/api/settings', { gpu: { device: null } }).catch(() => {});
  await srv.stop();
}

// a GPU attempt that fails is made again on the CPU
if (devices.length) {
  console.log('a GPU proxy that fails');
  const srv2 = await startServer({ env: { JIMMY_FAKE_GPU_PROXY_FAIL: '1' } });
  try {
    await api('POST', '/api/settings', { prerender: { enabled: false }, proxyMode: 'always', gpu: { device: devices[0].id } });
    const clip = fallbackClip;
    const dir = path.join(BASE, 'p-fallback');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'P', settings: {}, folders: [],
      media: [{ id: 'm1', name: 'clip', path: clip, type: 'video' }],
      sequences: [{ id: 's1', name: 'S', width: 1920, height: 1080, fps: 25, tracks: [{ id: 'v1', kind: 'video' }], clips: [] }] }));
    const { id } = await api('POST', '/api/projects/open', { path: dir });
    let st = null;
    for (let i = 0; i < 1200; i++) { st = (await api('GET', `/api/p/${id}`)).mediaStatus.m1; if (st?.proxy === 'ready' || st?.proxy === 'error') break; await sleep(100); }
    ok(st?.proxy === 'ready' && probe(st.proxyPath)?.codec_name === 'h264', `the proxy is made on the CPU instead (${st?.proxy}${st?.error ? `: ${st.error}` : ''})`);
  } finally {
    await api('POST', '/api/settings', { gpu: { device: null } }).catch(() => {});
    await srv2.stop();
  }
} else console.log('  (no GPU encoder here: GPU parts skipped)');
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failed ? `proxy-gpu: ${failed} failed` : 'proxy-gpu: all checks passed');
process.exit(failed ? 1 : 0);
