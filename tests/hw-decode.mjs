#!/usr/bin/env node
// Does decoding 4K on the graphics card help a real export? Exports the same clips with it on and off.
//   node tests/hw-decode.mjs "<8-bit 4:2:0 4K file>" "<10-bit 4:2:2 4K file>"   (the files are only read)
// JIMMY_NO_HW_DECODE=1 turns graphics card decoding off in the server for the "off" run.
import fs from 'node:fs';
import path from 'node:path';
import { WORK, startServer, api } from './lib/server.mjs';

const DIR = path.join(WORK, 'hw-decode');
const SECONDS = 20;
const bench4k = path.join(WORK, 'bench', 'media', 'plain-4k-60s.mp4');
const sources = [...(process.env.ONLY_CAMERA ? [] : [['Synthetic 4K 8-bit', bench4k, 30]]), ['Camera 4K 8-bit 4:2:0', process.argv[2], 25], ['Camera 4K 10-bit 4:2:2', process.argv[3], 25]].filter((s) => s[1] && fs.existsSync(s[1]));
const sizes = [[3840, 2160, '4K'], [1920, 1080, '1080p']];

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const seqs = [];
sources.forEach(([name, file, fps], i) => {
  for (const [width, height, label] of sizes) {
    seqs.push({ id: `s${i}${label}`, name: `${name} to ${label}`, width, height, fps, background: '#000000',
      tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
      clips: [{ id: 'c1', type: 'video', media: `m${i}`, track: 'v1', start: 0, duration: SECONDS, in: 2 }] });
  }
});
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify({
  format: 'claude-edit/1', name: 'HW decode', settings: { defaultScaling: 'fit', stillDuration: 5, transitionDuration: 0.5 }, folders: [],
  media: sources.map(([name, file], i) => ({ id: `m${i}`, name, path: file, type: 'video' })),
  sequences: seqs,
}, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = {};
for (const hw of process.env.OFF_FIRST ? [false, true] : [true, false]) {
  const srv = await startServer({ env: hw ? {} : { JIMMY_NO_HW_DECODE: '1' } });
  try {
    await api('POST', '/api/settings', { prerender: { enabled: false } });
    const gpu = await api('POST', '/api/gpu/detect');
    const best = (gpu.detected?.devices || []).filter((d) => d.encode).sort((a, b) => (b.speedup || 0) - (a.speedup || 0))[0];
    await api('POST', '/api/settings', { gpu: { device: best.id, draft: 'gpu', high: 'gpu', battery: 'gpu' } });
    const { id } = await api('POST', '/api/projects/open', { path: DIR });
    for (let i = 0; i < 120; i++) { const p = await api('GET', `/api/p/${id}`); if (p.doc.media.every((m) => m.duration != null)) break; await sleep(500); }
    for (const s of seqs) {
      fs.rmSync(path.join(DIR, '.cache', 'chunks'), { recursive: true, force: true });
      const t0 = Date.now();
      const r = await api('POST', `/api/p/${id}/render`, { sequenceId: s.id, quality: 'high', wait: true });
      const secs = (Date.now() - t0) / 1000;
      if (r.job.status !== 'done') throw new Error(`${s.name}: ${r.job.status} ${r.job.error || ''}`);
      if (r.job.output) fs.rmSync(r.job.output, { force: true });
      (rows[s.name] ||= {})[hw ? 'on' : 'off'] = secs;
      console.log(`  card decoding ${hw ? 'on ' : 'off'}  ${s.name.padEnd(36)} ${secs.toFixed(1).padStart(6)} s  ${(r.job.frames / secs).toFixed(1).padStart(6)} fps`);
    }
  } finally { await srv.stop(); }
}
console.log('\nExport                                on      off     card saves');
for (const [n, r] of Object.entries(rows)) console.log(`${n.padEnd(36)} ${r.on.toFixed(1).padStart(6)}s ${r.off.toFixed(1).padStart(6)}s ${String(Math.round((1 - r.on / r.off) * 100)).padStart(6)}%`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(0);
