#!/usr/bin/env node
// Nested sound in exports, through the server on port 4455: a sequence nested in another sounds once, through its
// linked audio clip (volume, fades, track mute), also when the project was made before nested sound had a clip.
//   node tests/nest-audio-export.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';
import { FFMPEG } from '../server/ffmpeg.js';

const DIR = path.join(WORK, 'nest-audio-export');
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr).slice(-500)}`);
  return r;
};
// RMS of a file between a and b seconds (mono mix, linear)
const rms = (file, a, b) => {
  const pcm = ff(['-i', file, '-ss', String(a), '-t', String(b - a), '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']).stdout;
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
};

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'media'), { recursive: true });
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20,volume=0.5', '-ac', '2', '-c:a', 'pcm_s16le', path.join(DIR, 'media', 'tone.wav')]);
// written as an older project: the nested clip has no sound clip of its own (the server adds it when reading)
const project = {
  format: 'claude-edit/1', name: 'Nested sound',
  media: [{ id: 'm_t', name: 'tone.wav', path: 'media/tone.wav', type: 'audio' }],
  sequences: [
    { id: 's_in', name: 'Inner', width: 1280, height: 720, fps: 25, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
      clips: [{ id: 'c_t', type: 'audio', media: 'm_t', track: 'a1', start: 0, duration: 10, in: 0 }] },
    { id: 's_main', name: 'Main', width: 1280, height: 720, fps: 25, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
      clips: [{ id: 'c_n', type: 'sequence', sequence: 's_in', track: 'v1', start: 2, duration: 8, in: 0 }] },
  ],
};
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(project, null, 2));

const server = await startServer();
try {
  const p = await api('POST', '/api/projects/open', { path: DIR });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let doc;
  for (let i = 0; i < 60; i++) { doc = (await api('GET', `/api/p/${p.id}`)).doc; if (doc.media.every((m) => m.duration != null)) break; await sleep(500); }
  const main = doc.sequences.find((s) => s.id === 's_main');
  const snd = main.clips.find((c) => c.type === 'audio' && c.sequence === 's_in');
  ok(!!snd && snd.link && snd.link === main.clips.find((c) => c.id === 'c_n').link, 'the old nested clip got a linked sound clip when the project was read');
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'project.json'), 'utf8'));
  ok(saved.sequences.find((s) => s.id === 's_main').clips.some((c) => c.sequence && c.type === 'audio'), '…written back to project.json');

  const exportMix = async (label) => {
    const r = await api('POST', `/api/p/${p.id}/render`, { sequenceId: 's_main', audio: 'wav16', wait: true, name: label });
    if (r.job.status !== 'done') throw new Error(`${label}: ${r.job.status} ${r.job.error || ''}`);
    return r.job.output;
  };
  const save = async (fn) => {
    const cur = (await api('GET', `/api/p/${p.id}`));
    const d = JSON.parse(JSON.stringify(cur.doc));
    fn(d.sequences.find((s) => s.id === 's_main'));
    const r = await api('PUT', `/api/p/${p.id}/project`, { doc: d, baseRev: cur.rev });
    if (r.conflict) throw new Error('save conflict');
  };

  const f1 = await exportMix('plain');
  const lead = rms(f1, 0.2, 1.8), body = rms(f1, 3, 9), tail = rms(f1, 10.2, 11);
  ok(lead < 1e-4 && tail < 1e-4, `silent before and after the nest (${lead.toExponential(1)}, ${tail.toExponential(1)})`);
  const src = rms(path.join(DIR, 'media', 'tone.wav'), 3, 9);
  ok(Math.abs(body / src - 1) < 0.02, `the tone sounds once, at its own level (rms ${body.toFixed(4)}, the file's ${src.toFixed(4)}; twice would be ${(src * 2).toFixed(4)})`);

  await save((m) => { const a = m.clips.find((c) => c.type === 'audio' && c.sequence); a.volume = 0.5; a.fadeIn = 2; });
  const f2 = await exportMix('half');
  const b2 = rms(f2, 5, 9), fade = rms(f2, 2.9, 3.1);
  ok(Math.abs(b2 / body - 0.5) < 0.02, `the sound clip's volume 0.5 halves the whole nest (${(b2 / body).toFixed(3)})`);
  ok(Math.abs(fade / body - 0.25) < 0.04, `its fade-in applies (at 1 s of 2: ${(fade / body).toFixed(3)} of full)`);

  await save((m) => { m.tracks.find((t) => t.id === m.clips.find((c) => c.type === 'audio' && c.sequence).track).muted = true; });
  const f3 = await exportMix('muted');
  ok(rms(f3, 3, 9) < 1e-4, 'muting the sound clip\'s track silences the nest');
} finally {
  await server.stop();
}
console.log(failed ? `nest-audio-export: ${failed} failed` : 'nest-audio-export: all checks passed');
process.exit(failed ? 1 : 0);
