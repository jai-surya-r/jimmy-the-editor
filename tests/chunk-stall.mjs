// A classic export whose render page freezes: the watchdog restarts that part and the export finishes; a part that
// freezes twice ends the export with a reason instead of hanging; a held export is left alone.
//   JIMMY_APP=electron node tests/chunk-stall.mjs
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startServer, openGolden, api } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const { FFPROBE } = await import('../server/ffmpeg.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const STALL = 4000;

async function run(freeze, body) {
  const srv = await startServer({ env: { JIMMY_CHUNK_STALL_MS: String(STALL), ...(freeze ? { JIMMY_TEST_FREEZE_CHUNK: freeze } : {}) } });
  try {
    await api('POST', '/api/settings', { prerender: { enabled: false } });
    const { id, doc } = await openGolden();
    await body(id, doc.sequences[0], () => fs.readFileSync(srv.log, 'utf8'));
  } finally { await srv.stop(); }
}
const clearChunks = async (id) => { const p = await api('GET', `/api/p/${id}`); fs.rmSync(`${p.dir}/.cache/chunks`, { recursive: true, force: true }); };
const count = (log) => (log.match(/made no progress/g) || []).length;
// what a stopped page or its ffmpeg would leave behind: processes of this repo's Electron or ffmpeg
const leftovers = () => {
  const ps = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq 'ffmpeg.exe') -and $_.ExecutablePath -like '*Jimmy - The Editor*' } | Measure-Object | ForEach-Object Count";
  return Number(spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim()) || 0;
};

await run('once', async (id, seq, log) => {
  await clearChunks(id);
  const t0 = Date.now();
  const r = await api('POST', `/api/p/${id}/render`, { sequenceId: seq.id, quality: 'draft', wait: true });
  ok(r.job.status === 'done', `a frozen part is restarted and the export finishes (${r.job.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  ok(count(log()) === 1, `the watchdog stepped in once (${count(log())})`);
  const frames = spawnSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', r.job.output], { encoding: 'utf8' }).stdout.trim();
  ok(Number(frames) === r.job.frames, `the file has every frame (${frames} of ${r.job.frames})`);
  if (r.job.output) fs.rmSync(r.job.output, { force: true });
});

await run('always', async (id, seq, log) => {
  await clearChunks(id);
  const t0 = Date.now();
  const r = await api('POST', `/api/p/${id}/render`, { sequenceId: seq.id, quality: 'draft', wait: true });
  ok(r.job.status === 'error' && /stopped making progress/.test(r.job.error || ''), `a part that freezes twice ends with a reason: ${r.job.error}`);
  ok(Date.now() - t0 < 60000, `…instead of hanging (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  ok(count(log()) === 2, `…after two tries (${count(log())})`);
});

await run('', async (id, seq, log) => {
  await clearChunks(id);
  const started = await api('POST', `/api/p/${id}/render`, { sequenceId: seq.id, quality: 'high' });
  const jid = started.job?.id || started.id;
  await sleep(1500);
  await api('POST', `/api/jobs/${jid}/pause`, { paused: true });
  await sleep(STALL * 2.5);
  await api('POST', `/api/jobs/${jid}/pause`, { paused: false });
  let job;
  for (let i = 0; i < 240; i++) { job = (await api('GET', '/api/jobs')).jobs.find((j) => j.id === jid); if (['done', 'error', 'canceled'].includes(job?.status)) break; await sleep(500); }
  ok(job?.status === 'done', `an export on hold longer than the limit carries on (${job?.status})`);
  ok(count(log()) === 0, 'the watchdog left it alone');
  if (job?.output) fs.rmSync(job.output, { force: true });
});

await sleep(2500);
const n = leftovers();
ok(n === 0, `no frozen page or ffmpeg is left running (${n})`);

console.log(failed ? `chunk-stall: ${failed} failed` : 'chunk-stall: all checks passed');
process.exit(failed ? 1 : 0);
