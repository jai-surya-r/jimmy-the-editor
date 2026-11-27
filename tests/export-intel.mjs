// Exports from heavy footage (4K HEVC, 10-bit HEVC, 4K H.264) with an Intel GPU chosen for exports: the footage
// decodes on the GPU (server/decodestream.js: Intel keeps frames on the GPU, so they are scaled there and brought
// back) and the export finishes on it. Before, GPU decoding failed for every such file ("GPU decoding failed for …;
// using the CPU" in the log) and the footage was decoded on the CPU. Skips on a machine without a working Intel encoder.
//   node tests/export-intel.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';

const { FFMPEG } = await import('../server/ffmpeg.js');
const { getConfig } = await import('../server/config.js');
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const intel = (getConfig().gpuDetected?.devices || []).find((d) => d.id === 'intel' && d.encode && d.decode);
if (!intel) { console.log('export-intel: no Intel GPU encoder and decoder here, skipped'); process.exit(0); }

const DIR = path.join(WORK, 'export-intel');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const SRC = [
  ['4K HEVC', 'hevc.mp4', ['-pix_fmt', 'yuv420p', '-c:v', 'libkvazaar', '-b:v', '20M']],
  ['4K HEVC 10-bit', 'hevc10.mp4', ['-pix_fmt', 'yuv420p10le', '-c:v', 'hevc_qsv', '-profile:v', 'main10', '-b:v', '20M']],
  ['4K H.264', 'h264.mp4', ['-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-b:v', '40M']],
];
for (const [, file, enc] of SRC) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=25:duration=4', ...enc, path.join(DIR, file)], { encoding: 'utf8' });
  if (r.status) throw new Error(`${file}: ${r.stderr}`);
}
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify({
  format: 'claude-edit/1', name: 'Intel export', settings: {}, folders: [],
  media: SRC.map(([name, file], i) => ({ id: `m${i}`, name, path: path.join(DIR, file), type: 'video' })),
  sequences: SRC.map(([name], i) => ({ id: `s${i}`, name, width: 1920, height: 1080, fps: 25, background: '#000000',
    tracks: [{ id: 'v1', kind: 'video' }], clips: [{ id: 'c1', type: 'video', media: `m${i}`, track: 'v1', start: 0, duration: 3, in: 0.5 }] })),
}, null, 2));

const srv = await startServer();
try {
  await api('POST', '/api/settings', { prerender: { enabled: false }, gpu: { device: 'intel', draft: 'gpu', high: 'gpu', battery: 'gpu' } });
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  for (let i = 0; i < 120; i++) { const p = await api('GET', `/api/p/${id}`); if (p.doc.media.every((m) => m.duration != null)) break; await new Promise((r) => setTimeout(r, 250)); }
  for (const [name] of SRC) {
    const i = SRC.findIndex((x) => x[0] === name);
    const r = await api('POST', `/api/p/${id}/render`, { sequenceId: `s${i}`, quality: 'standard', wait: true });
    const st = await api('GET', '/api/state');
    ok(r.job.status === 'done' && !st.gpu?.failed, `${name}: the export finishes with the Intel GPU still in use (${r.job.status}${r.job.error ? `: ${r.job.error}` : ''}${st.gpu?.failed ? `; set aside: ${st.gpu.failed.reason.slice(0, 120)}` : ''}; ${r.job.engine || ''})`);
    if (r.job.output) fs.rmSync(r.job.output, { force: true });
  }
  const log = fs.readFileSync(path.join(WORK, 'server.log'), 'utf8');
  const fell = log.split('\n').filter((l) => /GPU decoding failed/.test(l));
  ok(!fell.length, `the footage decoded on the GPU, none fell back to the CPU (${fell.length ? fell[0].slice(0, 160) : 'no fallbacks in the log'})`);
} finally {
  await api('POST', '/api/settings', { gpu: { device: null } }).catch(() => {});
  await srv.stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log(failed ? `export-intel: ${failed} failed` : 'export-intel: all checks passed');
process.exit(failed ? 1 : 0);
