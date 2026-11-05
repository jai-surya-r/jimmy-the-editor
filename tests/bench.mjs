#!/usr/bin/env node
// npm run bench: export speed, the numbers later work must beat.
//   - every golden sequence, a plain 60 s 1080p clip and a plain 60 s 4K clip, each with GPU encoding off and on
//   - one fresh motion-graphic render
// Every export starts with an empty chunk cache and background pre-rendering off, so nothing is reused.
// Per-frame timings (decode / compose / readback / encoder-wait ms) come from the server's [render] log line.
// Results: tests/.work/bench-<time>.json, or tests/baseline.json with --baseline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, WORK, GOLDEN_DIR, startServer, openGolden, api } from './lib/server.mjs';

const { FFMPEG } = await import('../server/ffmpeg.js');
const BENCH_DIR = path.join(WORK, 'bench');
const asBaseline = process.argv.includes('--baseline');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ bench project (plain clips + a motion graphic)

function makeBenchProject() {
  const media = path.join(BENCH_DIR, 'media');
  fs.mkdirSync(media, { recursive: true });
  const clips = [['plain-1080p-60s.mp4', 1920, 1080, 160], ['plain-4k-60s.mp4', 3840, 2160, 320]];
  for (const [file, w, h, box] of clips) {
    const out = path.join(media, file);
    if (fs.existsSync(out)) continue;
    console.log(`  making ${file}…`);
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=60`,
      '-f', 'lavfi', '-i', `color=c=0xff3355:size=${box}x${box}:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
      '-filter_complex', `[0:v][1:v]overlay=x='mod(t*${w / 5}\\,${w - box})':y='${(h - box) / 2}':shortest=1,format=yuv420p[v]`,
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-g', '60', '-c:a', 'aac', '-shortest', '-t', '60', out,
    ], { encoding: 'utf8', timeout: 600000 });
    if (r.status !== 0) throw new Error(`could not make ${file}: ${r.stderr}`);
  }
  fs.mkdirSync(path.join(BENCH_DIR, 'motion'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests', 'golden', 'motion', 'badge.html'), path.join(BENCH_DIR, 'motion', 'badge.html'));
  // a param that changes every run gives the graphic a new render signature, so it really renders
  const stamp = `BENCH ${Date.now().toString(36)}`;
  const doc = {
    format: 'claude-edit/1', name: 'Bench', settings: { defaultScaling: 'fit', stillDuration: 5, transitionDuration: 0.5 }, folders: [],
    media: [
      { id: 'm_p1080', name: 'plain-1080p-60s.mp4', path: 'media/plain-1080p-60s.mp4', type: 'video' },
      { id: 'm_p4k', name: 'plain-4k-60s.mp4', path: 'media/plain-4k-60s.mp4', type: 'video' },
      { id: 'm_motion', name: 'Bench badge', path: '', type: 'video', motion: { src: 'motion/badge.html', params: { label: stamp }, duration: 4, width: 1920, height: 1080, fps: 30 } },
    ],
    sequences: [
      { id: 's_p1080', name: 'Plain 1080p 60s', width: 1920, height: 1080, fps: 30, background: '#000000',
        tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
        clips: [{ id: 'c1', type: 'video', media: 'm_p1080', track: 'v1', start: 0, duration: 60, in: 0 }] },
      { id: 's_p4k', name: 'Plain 4K 60s', width: 3840, height: 2160, fps: 30, background: '#000000',
        tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
        clips: [{ id: 'c1', type: 'video', media: 'm_p4k', track: 'v1', start: 0, duration: 60, in: 0 }] },
    ],
  };
  fs.writeFileSync(path.join(BENCH_DIR, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
}

// ------------------------------------------------------------------ helpers

const logText = (log) => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };
const RENDER_LINE = /\[render\] (.+?): (\d+) frames \((\d+) reused\) in ([\d.]+)s, up to (\d+) chunk\(s\) at once(?: — avg ms per rendered frame: decode ([\d.]+) compose ([\d.]+) readback ([\d.]+) encoder-wait ([\d.]+))?/g;
const MOTION_LINE = /\[motion\] rendered (\S+): (\d+) frames in ([\d.]+)s/g;
function lastMatch(re, text, from) {
  let m, last = null;
  re.lastIndex = from;
  while ((m = re.exec(text))) last = m;
  return last;
}

async function waitProbed(id, dir) {
  for (let i = 0; i < 300; i++) {
    const p = await api('GET', `/api/p/${id}`);
    const probed = p.doc.media.filter((m) => !m.motion).every((m) => m.duration != null);
    if (probed) return p.doc;
    await sleep(1000);
  }
  throw new Error(`media in ${dir} never finished probing`);
}

async function exportOnce(server, id, dir, seq) {
  fs.rmSync(path.join(dir, '.cache', 'chunks'), { recursive: true, force: true });
  const before = logText(server.log).length;
  const t0 = Date.now();
  const r = await api('POST', `/api/p/${id}/render`, { sequenceId: seq.id, quality: 'high', wait: true });
  const wall = (Date.now() - t0) / 1000;
  const job = r.job;
  if (job.status !== 'done') throw new Error(`export of "${seq.name}" ended ${job.status}: ${job.error || ''}`);
  await sleep(200); // let the log line land
  const text = logText(server.log);
  const m = lastMatch(RENDER_LINE, text, before);
  if (job.output) fs.rmSync(job.output, { force: true });
  const frames = job.frames;
  return {
    sequence: seq.name, frames, size: `${seq.width}x${seq.height}`, engine: job.engine || 'CPU', reused: job.reused,
    seconds: +wall.toFixed(2), fps: +(frames / wall).toFixed(1),
    chunksAtOnce: m ? +m[5] : null,
    msPerFrame: m && m[6] ? { decode: +m[6], compose: +m[7], readback: +m[8], encoderWait: +m[9] } : null,
  };
}

async function setGpu(on, device) {
  await api('POST', '/api/settings', { gpu: on ? { device, draft: 'gpu', high: 'gpu', battery: 'gpu' } : { device: null } });
}

// ------------------------------------------------------------------ run

async function main() {
  makeBenchProject();
  const server = await startServer();
  const results = { at: new Date().toISOString(), machine: {}, settings: {}, exports: [], motion: null };
  try {
    const state = await api('GET', '/api/state');
    // background pre-rendering would fill the cache while we measure
    await api('POST', '/api/settings', { prerender: { enabled: false } });
    console.log('Detecting GPU encoders…');
    const gpu = await api('POST', '/api/gpu/detect');
    const devices = (gpu.detected?.devices || []).filter((d) => d.encode);
    const best = devices.sort((a, b) => (b.speedup || 0) - (a.speedup || 0))[0] || null;
    results.machine = {
      platform: `${process.platform} ${os.release()}`, cpu: os.cpus()[0]?.model?.trim(), cores: state.cpuCount,
      memGB: Math.round(os.totalmem() / 2 ** 30), gpus: (gpu.detected?.devices || []).map((d) => `${d.name || d.id}${d.encode ? '' : ' (no encode)'}`),
      node: process.version, ffmpeg: spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0],
    };
    results.settings = { usage: state.performance?.usage, renderSlots: state.renderSlots, gpuDevice: best?.id || null };

    const golden = await openGolden();
    const bench = await api('POST', '/api/projects/open', { path: BENCH_DIR });
    const benchDoc = await waitProbed(bench.id, BENCH_DIR);

    // the motion graphic first and on its own (opening the project started it), so it doesn't share the
    // machine with the exports
    console.log('  motion graphic render…');
    const t0 = Date.now();
    for (;;) {
      const p = await api('GET', `/api/p/${bench.id}`);
      const mo = p.doc.media.find((m) => m.id === 'm_motion');
      if (mo.path && fs.existsSync(path.join(BENCH_DIR, mo.path))) break;
      if (Date.now() - t0 > 300000) throw new Error('motion render timed out');
      await sleep(500);
    }
    await sleep(300);
    const mm = lastMatch(MOTION_LINE, logText(server.log), 0);
    results.motion = mm ? { file: mm[1], frames: +mm[2], seconds: +mm[3], fps: +(mm[2] / mm[3]).toFixed(1) } : null;

    const cases = [
      ...golden.doc.sequences.map((s) => ({ group: 'golden', id: golden.id, dir: GOLDEN_DIR, seq: s })),
      ...benchDoc.sequences.map((s) => ({ group: 'plain', id: bench.id, dir: BENCH_DIR, seq: s })),
    ];
    for (const gpuOn of best ? [false, true] : [false]) {
      await setGpu(gpuOn, best?.id);
      for (const c of cases) {
        process.stdout.write(`  ${gpuOn ? 'GPU' : 'CPU'}  ${c.seq.name.padEnd(34)} `);
        const r = await exportOnce(server, c.id, c.dir, c.seq);
        results.exports.push({ group: c.group, gpu: gpuOn, ...r });
        console.log(`${String(r.seconds).padStart(7)} s  ${String(r.fps).padStart(6)} fps  [${r.engine}]${r.gpuComposited != null ? `, GPU-composited ${r.gpuComposited} / CPU ${r.cpuComposited}` : ''}`);
      }
    }
    if (!best) console.log('  (no working GPU encoder found: GPU runs skipped)');
  } finally {
    await server.stop();
  }
  printTable(results);
  const out = asBaseline ? path.join(ROOT, 'tests', 'baseline.json') : path.join(WORK, `bench-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nsaved ${path.relative(ROOT, out)}`);
}

export function printTable(r) {
  const totals = (group, gpu) => {
    const xs = r.exports.filter((e) => e.group === group && e.gpu === gpu);
    if (!xs.length) return null;
    const frames = xs.reduce((a, e) => a + e.frames, 0), secs = xs.reduce((a, e) => a + e.seconds, 0);
    return { frames, secs: +secs.toFixed(1), fps: +(frames / secs).toFixed(1) };
  };
  console.log(`\n${r.engine} engine · ${r.machine.cpu} (${r.machine.cores} threads) · GPU: ${r.settings.gpuDevice || 'none'}`);
  console.log('| Export | Frames | CPU encode s (fps) | GPU encode s (fps) | ms/frame decode / compose / readback / enc-wait (CPU run) |');
  console.log('|---|---|---|---|---|');
  const names = [...new Set(r.exports.map((e) => e.sequence))];
  for (const n of names) {
    const c = r.exports.find((e) => e.sequence === n && !e.gpu), g = r.exports.find((e) => e.sequence === n && e.gpu);
    const ms = c?.msPerFrame ? `${c.msPerFrame.decode} / ${c.msPerFrame.compose} / ${c.msPerFrame.readback} / ${c.msPerFrame.encoderWait}` : '—';
    console.log(`| ${n} | ${c?.frames ?? g?.frames} | ${c ? `${c.seconds} (${c.fps})` : '—'} | ${g ? `${g.seconds} (${g.fps})` : '—'} | ${ms} |`);
  }
  for (const group of ['golden', 'plain']) {
    const c = totals(group, false), g = totals(group, true);
    console.log(`| **${group} total** | ${c?.frames ?? g?.frames} | ${c ? `${c.secs} (${c.fps})` : '—'} | ${g ? `${g.secs} (${g.fps})` : '—'} | |`);
  }
  if (r.motion) console.log(`| Motion graphic (${r.motion.frames} frames, ProRes 4444) | ${r.motion.frames} | ${r.motion.seconds} (${r.motion.fps}) | — | |`);
}

main().catch((e) => { console.error(`\nbench: ${e.message}`); process.exit(1); });
