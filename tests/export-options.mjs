#!/usr/bin/env node
// Export options (Export › Format, Bitrate, Container, Resolution, Frame rate, Audio, Presets):
//   node tests/export-options.mjs                      (plain server: frames over the render page's WebSocket)
//   JIMMY_APP=electron node tests/export-options.mjs   (the desktop app: render pages read and write frames themselves)
// Three seconds of the golden project's s_cuts sequence, exported through the server on port 4455 in each kind of
// format, and the files checked with ffprobe: codec, profile, container, size, frame rate, bitrate and audio.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startServer, openGolden, api, APP } from './lib/server.mjs';
import { FFPROBE } from '../server/ffmpeg.js';

let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const probe = (file) => JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }).stdout);
const SECONDS = 3;

const server = await startServer();
const outputs = [];
try {
  const { id, doc } = await openGolden();
  const seq = doc.sequences.find((s) => s.id === 's_cuts');
  await api('POST', '/api/settings', { prerender: { enabled: false } });
  console.log(`${APP ? 'desktop app' : 'plain server'}; ${seq.name}: ${seq.width}×${seq.height} at ${seq.fps} fps, first ${SECONDS} s`);
  const exp = async (what, opts) => {
    const t0 = Date.now();
    const r = await api('POST', `/api/p/${id}/render`, { sequenceId: seq.id, quality: 'high', range: [0, SECONDS], addVersion: false, name: `opts-${Date.now()}`, wait: true, ...opts });
    if (r.job.status !== 'done') { check(false, `${what}: export ${r.job.status} ${r.job.error || ''}`); return null; }
    outputs.push(r.job.output);
    const p = probe(r.job.output);
    const v = p.streams.find((s) => s.codec_type === 'video');
    const a = p.streams.find((s) => s.codec_type === 'audio');
    console.log(`  ${what}: ${((Date.now() - t0) / 1000).toFixed(1)} s · ${r.job.output.split(/[\\/]/).pop()} · ${v.codec_name} ${v.profile || ''} ${v.width}×${v.height} ${v.r_frame_rate} · ${a ? `${a.codec_name} ${a.sample_rate} Hz` : 'no audio'}`);
    return { job: r.job, p, v, a, ext: r.job.output.split('.').pop() };
  };

  let r = await exp('H.265', { format: 'hevc' });
  check(r && r.v.codec_name === 'hevc' && r.ext === 'mp4' && r.v.codec_tag_string === 'hvc1', 'H.265 in an MP4, tagged hvc1 (plays in QuickTime)');
  check(r && r.a?.codec_name === 'aac', 'H.265 has AAC audio');

  r = await exp('H.264 8 Mbps VBR', { rate: { mbps: 8 } });
  const kbps = r && (+r.v.bit_rate || (+r.p.format.bit_rate)) / 1000;
  check(r && r.v.codec_name === 'h264' && kbps > 8000 * 0.5 && kbps < 8000 * 1.6, `H.264 at a target of 8 Mbps came out at ${Math.round(kbps)} kbps`);

  r = await exp('H.264 3 Mbps CBR in a MOV', { rate: { mbps: 3, cbr: true }, container: 'mov' });
  const kbps2 = r && (+r.v.bit_rate || (+r.p.format.bit_rate)) / 1000;
  check(r && r.ext === 'mov' && r.v.codec_name === 'h264' && kbps2 > 3000 * 0.6 && kbps2 < 3000 * 1.4, `H.264 CBR 3 Mbps in a .mov: ${Math.round(kbps2)} kbps`);

  for (const [format, profile] of [['proresproxy', 'Proxy'], ['proreslt', 'LT'], ['prores422', 'Standard'], ['prores', 'HQ'], ['prores4444o', '4444']]) {
    r = await exp(`ProRes ${profile}`, { format });
    check(r && r.v.codec_name === 'prores' && r.ext === 'mov' && r.v.profile === profile && r.a?.codec_name === 'pcm_s16le', `ProRes ${profile} (.mov, PCM audio)${r ? `: ${r.v.profile} ${r.v.pix_fmt}` : ''}`);
  }
  check(r && !/yuva/.test(r.v.pix_fmt), 'ProRes 4444 without alpha is opaque');

  r = await exp('720p', { scale: 720 / Math.min(seq.width, seq.height) });
  check(r && Math.min(r.v.width, r.v.height) === 720, `scaled to 720p: ${r?.v.width}×${r?.v.height}`);

  r = await exp('custom width 2560 (bigger than the sequence)', { scale: 2560 / seq.width });
  check(r && r.v.width === 2560, `made bigger than the sequence: ${r?.v.width}×${r?.v.height}`);

  const to = Math.abs(seq.fps - 25) < 0.01 ? 30 : 25;
  r = await exp(`converted to ${to} fps`, { fps: to });
  const [n, d] = (r?.v.r_frame_rate || '0/1').split('/').map(Number);
  check(r && Math.abs(n / d - to) < 0.01, `frame rate converted to ${to}: ${r?.v.r_frame_rate}`);
  check(r && Math.abs(+r.p.format.duration - SECONDS) < 0.2, `same length after converting: ${(+r?.p.format.duration).toFixed(2)} s`);

  r = await exp('no audio', { audioOut: { codec: 'none' } });
  check(r && !r.a, 'no audio stream');
  r = await exp('AAC 128 kbps at 44.1 kHz', { audioOut: { codec: 'aac', kbps: 128, rate: 44100 } });
  check(r && r.a?.codec_name === 'aac' && +r.a.sample_rate === 44100 && +r.a.bit_rate < 160000, `AAC 128 kbps, 44.1 kHz: ${r?.a?.bit_rate} bit/s`);
  r = await exp('PCM 24-bit in a ProRes MOV', { format: 'prores', audioOut: { codec: 'pcm24' } });
  check(r && r.a?.codec_name === 'pcm_s24le', 'PCM 24-bit audio');
  r = await exp('PCM asked for in an MP4', { audioOut: { codec: 'pcm24' } });
  check(r && r.a?.codec_name === 'aac', 'an MP4 gets AAC instead (it cannot hold PCM)');

  // presets are kept in the settings and come back with the state
  await api('POST', '/api/settings', { exportPresets: { 'Client 10 Mbps': { format: 'h264', rateMode: 'bitrate', mbps: 10 } } });
  const st = await api('GET', '/api/state');
  check(st.exportPresets?.['Client 10 Mbps']?.mbps === 10, 'a saved preset comes back with the settings');
  await api('POST', '/api/settings', { exportPresets: {} });
} finally {
  await server.stop();
  for (const f of outputs) fs.rmSync(f, { force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
