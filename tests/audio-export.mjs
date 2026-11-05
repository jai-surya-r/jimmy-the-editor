#!/usr/bin/env node
// The audio mix of every export, and Export › Audio only:
//   node tests/audio-export.mjs
// A synthetic project (tests/.work/audio-export) with a busy 5-minute sequence: 200 short clips cut from a 4K video
// with sound (speed changes, fades, volume keyframes), music beds, overlapping clips on one track and a muted track.
//   1. the fast mix (mixAudio: lanes, batches mixed side by side) against a video export's mix (buildAudioGraph):
//      the same samples, and how long each takes;
//   2. through the server on port 4455: every format exports, with the right codec, length and file name.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';
import { FFMPEG, FFPROBE } from '../server/ffmpeg.js';
import { buildAudioGraph, mixAudio, AUDIO_FORMATS } from '../server/render.js';
import { normalizeProject } from '../public/js/core/model.js';

const DIR = path.join(WORK, 'audio-export');
const MEDIA = path.join(DIR, 'media');
let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.error?.message || String(r.stderr).slice(-500)}`);
  return r;
};

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(MEDIA, { recursive: true });
console.log('making media…');
const VIDEO = path.join(MEDIA, 'talk-4k.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=25:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=60,volume=0.4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', VIDEO]);
const MUSIC = path.join(MEDIA, 'music.wav');
ff(['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*(220+40*sin(t))*t)|0.2*sin(2*PI*(277+30*sin(1.3*t))*t):s=44100:d=120', '-c:a', 'pcm_s16le', MUSIC]);
const SFX = path.join(MEDIA, 'sfx.mp3');
ff(['-f', 'lavfi', '-i', 'anoisesrc=d=3:c=pink:a=0.3:r=44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', SFX]);

const media = [
  { id: 'm_v', name: 'talk-4k.mp4', path: 'media/talk-4k.mp4', type: 'video', hasAudio: true, duration: 60 },
  { id: 'm_m', name: 'music.wav', path: 'media/music.wav', type: 'audio', hasAudio: true, duration: 120 },
  { id: 'm_s', name: 'sfx.mp3', path: 'media/sfx.mp3', type: 'audio', hasAudio: true, duration: 3 },
];
const clips = [];
let t = 0;
for (let i = 0; i < 200; i++) {
  const speed = i % 7 === 3 ? 1.5 : i % 11 === 5 ? 0.75 : 1;
  const d = 1.2 + (i % 5) * 0.1;
  clips.push({ id: `c_d${i}`, type: 'audio', track: 'a1', media: 'm_v', start: +t.toFixed(4), duration: d, in: (i * 0.27) % 50, speed,
    volume: 0.8 + (i % 3) * 0.1, fadeIn: i % 4 === 0 ? 0.1 : 0, fadeOut: i % 6 === 0 ? 0.2 : 0,
    ...(i % 9 === 0 ? { keyframes: { volume: [{ t: 0, v: 0.2, ease: 'easeInOut' }, { t: d / 2, v: 1, ease: 'linear' }, { t: d, v: 0.5 }] } } : {}) });
  t += d + (i % 10 === 9 ? 0.5 : 0); // a short gap now and then
}
const total = t;
for (let s = 0, k = 0; s < total; s += 100, k++) clips.push({ id: `c_m${k}`, type: 'audio', track: 'a2', media: 'm_m', start: s, duration: Math.min(100, total - s), in: 5, volume: 0.6, fadeIn: 2, fadeOut: 2 });
for (let k = 0; k < 40; k++) clips.push({ id: `c_s${k}`, type: 'audio', track: 'a3', media: 'm_s', start: 3 + k * 7, duration: k % 4 === 0 ? 2.5 : 1.5, in: 0, volume: 0.5 }); // some overlap the next
for (let k = 0; k < 40; k++) clips.push({ id: `c_o${k}`, type: 'audio', track: 'a3', media: 'm_s', start: 4 + k * 7, duration: 1, in: 1, volume: 0.4 });
clips.push({ id: 'c_mute', type: 'audio', track: 'a4', media: 'm_m', start: 0, duration: 30, in: 0 });
const doc = normalizeProject({
  format: 'claude-edit/1', name: 'Audio export test', media,
  sequences: [{ id: 's_mix', name: 'Busy mix', width: 1920, height: 1080, fps: 30, background: '#000000',
    tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio', volume: 0.7 }, { id: 'a3', kind: 'audio' }, { id: 'a4', kind: 'audio', muted: true }],
    clips, markers: [] }],
}).project;
const project = doc;
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(project, null, 2));
const seq = project.sequences[0];
for (const tr of seq.tracks) tr.volume ??= 1; // as the server's loading fills it in
console.log(`sequence: ${total.toFixed(1)} s, ${seq.clips.length} audio clips`);

// 1. the same samples as a video export's mix
// the video export's graph passes every clip as an -i input: with this many clips only short relative paths
// (run from the project folder) fit on a Windows command line
const handle = { doc: project, resolve: (p) => path.join(DIR, p) };
const relHandle = { doc: project, resolve: (p) => p };
const raw = (inputs, graph, out) => {
  const gf = path.join(DIR, `${path.basename(out)}.filter`);
  fs.writeFileSync(gf, graph);
  const t0 = Date.now();
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...inputs, '-/filter_complex', gf, '-map', '[aout]', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', out], { cwd: DIR });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.error?.message || String(r.stderr).slice(-500)}`);
  return (Date.now() - t0) / 1000;
};
const oldGraph = (t0) => {
  const fs0 = fs.existsSync;
  fs.existsSync = (p) => fs0(path.isAbsolute(p) ? p : path.join(DIR, p)); // the relative paths above, checked from the project folder
  try { return buildAudioGraph(relHandle, seq, t0, total, 0); } finally { fs.existsSync = fs0; }
};
const old = oldGraph(0);
const tOld = raw(old.inputs, old.graph, path.join(DIR, 'old.f32'));
const t1 = Date.now();
const fast = await mixAudio(handle, seq, 0, total, path.join(DIR, 'new.f32'), { codec: ['-c:a', 'pcm_f32le'], mux: 'f32le' }, { tmpBase: path.join(DIR, 'mix') });
const tNew = (Date.now() - t1) / 1000;
fast.lanes = `${fast.lanes} lanes, ${fast.batches.length} batches side by side`;
const read = (f) => new Float32Array(fs.readFileSync(path.join(DIR, f)).buffer.slice(0));
const a = read('old.f32');
const b = read('new.f32');
// difference of x against the reference r from sample frame `from` on (r starts at `rFrom`)
const compare = (r, x, from, to, rFrom = 0) => {
  let maxDiff = 0, sumSq = 0, sigSq = 0;
  for (let i = from * 2; i < Math.min(to * 2, x.length, (r.length + rFrom * 2)); i++) {
    const v = r[i - rFrom * 2];
    const d = v - x[i];
    if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
    sumSq += d * d; sigSq += v * v;
  }
  return { maxDiff, snr: 10 * Math.log10(sigSq / Math.max(1e-30, sumSq)) };
};
console.log(`  video export's mix: ${tOld.toFixed(2)} s · audio-only mix: ${tNew.toFixed(2)} s (${fast.clips} clips in ${fast.lanes}) · ${(total / tNew).toFixed(0)}× real time`);
check(Math.abs(a.length - b.length) <= 2, `same length (${a.length / 2} / ${b.length / 2} samples per channel; ${Math.round(total * 48000)} expected)`);
// With this many clips the video export's own mix drifts after about three minutes (see docs/PROGRESS.md, Found,
// not fixed), so it is the reference for the first 150 s only; then up to 197.9 s against the same graph run on
// just that stretch (few inputs, where it doesn't drift). It stops before the music's fade-out at 198 s: the volume
// filter steps a fade once per 1024 samples, counted from where the clip starts, and that reference starts the
// music clip 50 s in, so its steps land elsewhere.
const SPLIT = 150, UNTIL = 197.9;
const head = compare(a, b, 0, SPLIT * 48000);
check(head.maxDiff < 1e-4 && head.snr > 90, `0–${SPLIT} s, the video export's mix: largest difference ${head.maxDiff.toExponential(2)}, ${head.snr.toFixed(1)} dB below the signal`);
const tail = oldGraph(SPLIT);
raw(tail.inputs, tail.graph, path.join(DIR, 'tail.f32'));
const rest = compare(read('tail.f32'), b, SPLIT * 48000, UNTIL * 48000, SPLIT * 48000);
check(rest.maxDiff < 1e-3 && rest.snr > 90, `${SPLIT}–${UNTIL} s, that stretch mixed on its own: largest difference ${rest.maxDiff.toExponential(2)}, ${rest.snr.toFixed(1)} dB below the signal`);
check(tNew < tOld, `faster than the video export's mix (${(tOld / tNew).toFixed(1)}×)`);

// 2. through the server
const server = await startServer();
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  for (const [fmt, f] of Object.entries(AUDIO_FORMATS)) {
    const t0 = Date.now();
    const { job } = await api('POST', `/api/p/${id}/render`, { sequenceId: 's_mix', audio: fmt, wait: true });
    const secs = (Date.now() - t0) / 1000;
    if (job.status !== 'done') { check(false, `${fmt}: ${job.status} ${job.error || ''}`); continue; }
    const p = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample:format=duration', '-of', 'json', job.output]);
    const info = JSON.parse(String(p.stdout));
    const s = info.streams[0];
    const dur = +info.format.duration;
    const codec = { wav24: 'pcm_s24le', wav16: 'pcm_s16le', flac: 'flac', mp3: 'mp3', aac: 'aac' }[fmt];
    check(s.codec_name === codec && +s.sample_rate === 48000 && s.channels === 2 && Math.abs(dur - total) < 0.06 && job.output.endsWith(`.${f.ext}`),
      `${f.label}: ${path.basename(job.output)} · ${s.codec_name} ${s.sample_rate} Hz ${s.channels} ch · ${dur.toFixed(2)} s · exported in ${secs.toFixed(2)} s`);
  }
  // a video export of every clip: its command stays short, and its sound is the audio-only mix
  const whole = (await api('POST', `/api/p/${id}/render`, { sequenceId: 's_mix', quality: 'draft', wait: true })).job;
  const wholeInfo = JSON.parse(String(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', whole.output || 'none']).stdout || '{}'));
  check(whole.status === 'done' && wholeInfo.streams?.some((s) => s.codec_type === 'audio') && Math.abs(+wholeInfo.format?.duration - total) < 0.1, `a video export of all ${seq.clips.length} clips works (${whole.status}${whole.error ? `: ${whole.error}` : ''})`);
  const part = (await api('POST', `/api/p/${id}/render`, { sequenceId: 's_mix', format: 'prores', quality: 'draft', range: [170, 200], wait: true })).job;
  const only = (await api('POST', `/api/p/${id}/render`, { sequenceId: 's_mix', audio: 'wav16', range: [170, 200], wait: true })).job;
  const pcm = (f) => { const b = spawnSync(FFMPEG, ['-v', 'error', '-i', f, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', '-'], { maxBuffer: 1 << 30 }).stdout; return new Int16Array(b.buffer, b.byteOffset, b.length >> 1); };
  const pa = pcm(part.output), pb = pcm(only.output);
  let most = 0;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) most = Math.max(most, Math.abs(pa[i] - pb[i]));
  check(Math.abs(pa.length - pb.length) <= 2 && most <= 1, `past the point where the old mix drifted, the video export's sound equals the audio-only mix (largest difference ${most} of 32768, ${pa.length / 2} samples)`);
  const left = fs.readdirSync(path.join(WORK, 'tmp')).filter((n) => n.includes(whole.id) || n.includes(part.id));
  check(!left.length, 'no temporary audio left behind');
  const { job } = await api('POST', `/api/p/${id}/render`, { sequenceId: 's_mix', audio: 'wav24', range: [10, 20], wait: true });
  const dur = +JSON.parse(String(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', job.output]).stdout)).format.duration;
  check(job.status === 'done' && Math.abs(dur - 10) < 0.01 && / \(\d\)\.wav$/.test(job.output), `a range exports just that part, next to the first file (${path.basename(job.output)}, ${dur.toFixed(3)} s)`);
} finally {
  await server.stop();
}
console.log(failed ? `audio-export: ${failed} failed` : 'audio-export: all checks passed');
process.exit(failed ? 1 : 0);
