// Open review comments on a live Timeline follow the timeline when Claude changes it: a clip that gets longer
// stretches the comments on it, later clips' comments move with them, resolved comments stay put; `vedit move`
// puts one comment on a given moment by hand.
//   node tests/comments-follow.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, openGolden, api, ROOT, GOLDEN_DIR } from './lib/server.mjs';
import { mapTime } from '../server/followtimeline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

console.log('Mapping');
const s0 = { clips: [{ id: 'g', track: 'v1', start: 0, duration: 40, in: 0 }, { id: 'e', track: 'v1', start: 40, duration: 5, in: 0 }] };
const s1 = { clips: [{ id: 'g', track: 'v1', start: 0, duration: 50, in: 0 }, { id: 'e', track: 'v1', start: 50, duration: 5, in: 0 }] };
ok(mapTime(s0, s1, 30) === 37.5, 'a motion graphic retimed 40 s → 50 s: a comment at 30 s goes to 37.5 s');
ok(mapTime(s0, s1, 42) === 52, 'a comment on the clip after it moves with that clip (42 → 52)');
ok(mapTime(s0, s1, 47) === 57, 'past the end: moves with the last clip (47 → 57)');

const srv = await startServer();
const REVIEWS = path.join(GOLDEN_DIR, 'reviews.json');
const keep = fs.existsSync(REVIEWS) ? fs.readFileSync(REVIEWS) : null;
const PROJECT = path.join(GOLDEN_DIR, 'project.json');
const keepProject = fs.readFileSync(PROJECT);
try {
  console.log('Claude edits project.json');
  const { id } = await openGolden();
  const { versionId } = await api('POST', `/api/p/${id}/rounds`, { sequence: 's_cuts' });
  let p = await api('GET', `/api/p/${id}`);
  const note = (cid, t, resolved = false, tEnd = null) => ({ id: cid, version: versionId, t, tEnd, text: `note ${cid}`, author: 'You', createdAt: new Date().toISOString(), resolved, replies: [], drawing: [], refs: [] });
  await api('PUT', `/api/p/${id}/reviews`, { doc: { ...p.reviews, comments: [...p.reviews.comments, note('n1', 1), note('n2', 5, false, 5.5), note('n3', 13), note('n4', 5, true)] }, baseRev: p.reviewsRev });
  // the third cut gets 2 s longer and everything after it moves up, written straight to the file as a chat would
  const raw = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
  const seq = raw.sequences.find((s) => s.id === 's_cuts');
  for (const c of seq.clips) if (c.track.startsWith('v1') && c.start > 4) c.start += 2;
  seq.clips.find((c) => c.id === 'c_cut3').duration = 4;
  fs.writeFileSync(PROJECT, JSON.stringify(raw, null, 2));
  let cs = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    p = await api('GET', `/api/p/${id}`);
    cs = Object.fromEntries(p.reviews.comments.map((c) => [c.id, c]));
    if (cs.n3?.t !== 13) break;
  }
  ok(cs.n1.t === 1, `a comment before the change stays (${cs.n1.t})`);
  ok(cs.n2.t === 6 && cs.n2.tEnd === 7, `a range on the lengthened clip stretches with it (5–5.5 → ${cs.n2.t}–${cs.n2.tEnd})`);
  ok(cs.n3.t === 15, `a comment on a later clip moves with it (13 → ${cs.n3.t})`);
  ok(cs.n4.t === 5, `a resolved comment stays where it was (${cs.n4.t})`);
  console.log('vedit move');
  execFileSync(process.execPath, [path.join(ROOT, 'bin', 'vedit.mjs'), 'move', 'n2', '6.5'], { cwd: GOLDEN_DIR, env: { ...process.env, CLAUDE_EDIT_PORT: '4455' } });
  for (let i = 0; i < 30; i++) { await sleep(200); p = await api('GET', `/api/p/${id}`); cs = Object.fromEntries(p.reviews.comments.map((c) => [c.id, c])); if (cs.n2.t !== 6) break; }
  ok(cs.n2.t === 6.5 && cs.n2.tEnd === 7.5, `moves a comment, keeping its range's length (${cs.n2.t}–${cs.n2.tEnd})`);
} finally {
  fs.writeFileSync(PROJECT, keepProject);
  if (keep) fs.writeFileSync(REVIEWS, keep); else fs.rmSync(REVIEWS, { force: true });
  await srv.stop();
}
console.log(failed ? `\ncomments-follow: ${failed} failed` : '\ncomments-follow: all checks passed');
process.exit(failed ? 1 : 0);
