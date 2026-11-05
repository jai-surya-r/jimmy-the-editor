// Saved transcripts: `vedit transcript` says when there is none (exit 2), `vedit transcript save` keeps one (SRT, VTT
// or Whisper-style JSON with word times) in the cache, and the same footage finds it again from another project and
// another path (it is found by the file's contents); a different file doesn't. The bin's details ask the same.
//   node tests/transcripts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, openGolden, api, WORK, ROOT, PORT, GOLDEN_DIR } from './lib/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const BASE = path.join(WORK, 'transcripts');
fs.rmSync(BASE, { recursive: true, force: true });
const A = path.join(BASE, 'Project A'), B = path.join(BASE, 'Laptop copy', 'Project B');
for (const d of [path.join(A, 'audio'), path.join(B, 'footage')]) fs.mkdirSync(d, { recursive: true });
const made = [];
const srv = await startServer();
try {
  await openGolden(); // the test media
  // the same recording at two paths, and a different one
  fs.copyFileSync(path.join(GOLDEN_DIR, 'media', 'tone.wav'), path.join(A, 'audio', 'interview.wav'));
  fs.copyFileSync(path.join(GOLDEN_DIR, 'media', 'tone.wav'), path.join(B, 'footage', 'interview copy.wav'));
  fs.copyFileSync(path.join(GOLDEN_DIR, 'media', 'clip-23976.mp4'), path.join(A, 'audio', 'other.mp4'));
  const proj = (name, media) => JSON.stringify({ format: 'claude-edit/1', name, settings: { originalNames: 1 }, folders: [], media, sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }, null, 2);
  fs.writeFileSync(path.join(A, 'project.json'), proj('A', [{ id: 'm_int', path: 'audio/interview.wav', type: 'audio' }, { id: 'm_other', path: 'audio/other.mp4', type: 'video' }]));
  fs.writeFileSync(path.join(B, 'project.json'), proj('B', [{ id: 'm_copy', path: 'footage/interview copy.wav', type: 'audio' }]));
  const vedit = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'vedit.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_EDIT_URL: `http://127.0.0.1:${PORT}` } });
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
  };

  let r = vedit(A, 'transcript', 'm_int');
  ok(r.code === 2 && /No saved transcript for m_int interview\.wav yet/.test(r.out) && /vedit transcript save m_int/.test(r.out), 'none yet: it says so (exit 2) and how to keep one');

  const srt = path.join(BASE, 'interview.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,500\nNamaste, aaj hum baat karenge\n\n2\n00:00:02,500 --> 00:00:05,000\nabout saving money.\n');
  r = vedit(A, 'transcript', 'save', 'm_int', srt);
  const savedFile = (r.out.match(/→ (.+?\.json)\./) || [])[1];
  if (savedFile) made.push(savedFile);
  ok(r.code === 0 && /Saved the transcript of m_int interview\.wav: 2 lines/.test(r.out), `an SRT is kept (${r.out.slice(0, 70)}…)`);
  ok(!!savedFile && /[\\/]transcripts[\\/][0-9a-f]{24}\.json$/.test(savedFile) && fs.existsSync(savedFile), `in the cache's transcripts folder (${savedFile && path.basename(path.dirname(path.dirname(savedFile)))}/transcripts/…)`);

  r = vedit(A, 'transcript', 'm_int');
  ok(r.code === 0 && /0–2\.5 {2}Namaste, aaj hum baat karenge/.test(r.out) && /2\.5–5 {2}about saving money\./.test(r.out), 'the next chat gets it as timed lines');
  r = vedit(B, 'transcript', 'm_copy');
  ok(r.code === 0 && /Namaste/.test(r.out), 'the same footage in another project, at another path, finds it too');
  r = vedit(A, 'transcript', 'm_other');
  ok(r.code === 2, 'a different file has none');

  // Whisper-style JSON with word times, by file path
  const js = path.join(BASE, 'other.json');
  fs.writeFileSync(js, JSON.stringify({ language: 'hi', segments: [{ start: 0.1, end: 1.9, text: ' Pehla shot', words: [{ start: 0.1, end: 0.8, word: ' Pehla' }, { start: 0.9, end: 1.9, word: ' shot' }] }] }));
  r = vedit(A, 'transcript', 'save', path.join(A, 'audio', 'other.mp4'), js);
  const f2 = (r.out.match(/→ (.+?\.json)\./) || [])[1];
  if (f2) made.push(f2);
  ok(r.code === 0 && /1 lines, hi/.test(r.out), 'Whisper-style JSON is kept too, named by the file\'s path');
  r = vedit(A, 'transcript', 'm_other', '--json');
  const kept = JSON.parse(fs.readFileSync(r.out.trim(), 'utf8'));
  ok(kept.language === 'hi' && kept.segments[0].words?.length === 2 && kept.segments[0].text === 'Pehla shot', '--json gives the file, with the word times');
  r = vedit(A, 'transcript', 'list');
  ok(/m_int {2}interview\.wav {2}saved \(2 lines\)/.test(r.out) && /m_other {2}other\.mp4 {2}saved \(1 lines, hi\)/.test(r.out), 'list shows which clips have one');
  const bad = path.join(BASE, 'bad.json');
  fs.writeFileSync(bad, '{"hello": 1}');
  r = vedit(A, 'transcript', 'save', 'm_int', bad);
  ok(r.code !== 0 && /Not a transcript/.test(r.out), 'something that isn\'t a transcript is refused');

  // the bin's details
  const { id } = await api('POST', '/api/projects/open', { path: B });
  const d = await api('GET', `/api/p/${id}/media/m_copy/transcript`);
  ok(d.exists && d.summary.segments === 2, 'the bin\'s details see it for the copy too');
  const md = fs.readFileSync(path.join(A, 'CLAUDE.md'), 'utf8');
  ok(/Run it before transcribing anything/.test(md), 'the project CLAUDE.md tells Claude to look first and save after');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await srv.stop();
  for (const f of made) fs.rmSync(f, { force: true });
}
console.log(failed ? `transcripts: ${failed} failed` : 'transcripts: all checks passed');
process.exit(failed ? 1 : 0);
