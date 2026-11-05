// Footage keeps its own name: names Claude gave footage clips before the rule are cleared once when the project opens,
// a chat renaming footage (clips or bin items) in project.json is taken back, names set in the editor stay, and motion
// graphics, text, sequences keep the names they are given.
//   node tests/clip-names.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK } from './lib/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DIR = path.join(WORK, 'clip-names');
const FILE = path.join(DIR, 'project.json');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// a project as a chat left it before the rule (no settings.originalNames); the footage files need not exist
const before = {
  format: 'claude-edit/1', name: 'Clip names', settings: {}, folders: [],
  media: [
    { id: 'm_aroll', name: 'Interview A', path: 'D:/Shoot/A_Roll/C0004.MP4', type: 'video' },
    { id: 'm_music', name: 'Music bed', path: 'music/track01.wav', type: 'audio' },
    { id: 'm_still', name: 'logo.png', path: 'logo.png', type: 'image' },
    { id: 'm_mg', name: 'Lower third', path: 'motion/renders/lt-abc.mov', type: 'video', motion: { src: 'motion/lt.html', params: {}, duration: 4, width: 1920, height: 1080, fps: 30 } },
  ],
  sequences: [{
    id: 's1', name: 'Rough cut', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }],
    clips: [
      { id: 'c_v1', type: 'video', track: 'v1', media: 'm_aroll', start: 0, duration: 2, in: 0, name: 'C1', link: 'l1' },
      { id: 'c_a1', type: 'audio', track: 'a1', media: 'm_aroll', start: 0, duration: 2, in: 0, name: 'C1', link: 'l1' },
      { id: 'c_v2', type: 'video', track: 'v1', media: 'm_aroll', start: 2, duration: 2, in: 5, name: 'C4a' },
      { id: 'c_mus', type: 'audio', track: 'a1', media: 'm_music', start: 2, duration: 2, in: 0 },
      { id: 'c_img', type: 'image', track: 'v2', media: 'm_still', start: 0, duration: 1, name: 'Logo' },
      { id: 'c_mg', type: 'video', track: 'v2', media: 'm_mg', start: 1, duration: 2, in: 0, name: 'LT for the host' },
      { id: 'c_tx', type: 'text', track: 'v2', start: 3, duration: 1, text: 'Hello', name: 'Hook title' },
    ],
  }],
};
fs.writeFileSync(FILE, JSON.stringify(before, null, 2));
const disk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const clip = (d, id) => d.sequences[0].clips.find((c) => c.id === id);
const media = (d, id) => d.media.find((m) => m.id === id);

const srv = await startServer();
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  let d = null;
  for (let i = 0; i < 50; i++) { d = disk(); if (d.settings?.originalNames) break; await sleep(100); }

  // ------------------------------------------------------------ once, when the project opens
  ok(d.settings.originalNames === 1, 'the project is marked as done');
  ok(['c_v1', 'c_a1', 'c_v2', 'c_img'].every((c) => !clip(d, c).name), 'footage clips named by a chat lose those names (C1, C4a, Logo)');
  ok(media(d, 'm_aroll').name === 'C0004.MP4' && media(d, 'm_music').name === 'track01.wav', 'renamed footage in the bin gets its file name back');
  ok(media(d, 'm_mg').name === 'Lower third' && clip(d, 'c_mg').name === 'LT for the host', 'a motion graphic and its clip keep their names');
  ok(clip(d, 'c_tx').name === 'Hook title' && d.sequences[0].name === 'Rough cut', 'text clips and sequences keep theirs');

  // ------------------------------------------------------------ names the user sets in the editor stay
  const p = await api('GET', `/api/p/${id}`);
  const mine = structuredClone(p.doc);
  clip(mine, 'c_v2').name = 'Best take';
  media(mine, 'm_still').name = 'Client logo';
  await api('PUT', `/api/p/${id}/project`, { doc: mine, baseRev: p.rev, clientId: 'test-editor' });
  await sleep(400);
  d = disk();
  ok(clip(d, 'c_v2').name === 'Best take' && media(d, 'm_still').name === 'Client logo', 'a name the user gives in the editor is saved');

  // ------------------------------------------------------------ a chat renaming footage is taken back
  const chat = disk();
  clip(chat, 'c_v1').name = 'Intro bite';
  clip(chat, 'c_v2').name = 'C2';
  media(chat, 'm_aroll').name = 'A-roll main';
  media(chat, 'm_still').name = 'logo_v2';
  clip(chat, 'c_mg').name = 'LT v2';
  chat.media.push({ id: 'm_new', name: 'B-roll street', path: 'D:/Shoot/B_Roll/C0110.MP4', type: 'video' });
  chat.sequences[0].clips.push({ id: 'c_new', type: 'video', track: 'v2', media: 'm_new', start: 4, duration: 1, in: 0, name: 'Street shot' });
  clip(chat, 'c_tx').name = 'Hook v2';
  delete chat.settings.originalNames;
  fs.writeFileSync(FILE, JSON.stringify(chat, null, 2));
  for (let i = 0; i < 60; i++) { await sleep(150); d = disk(); if (clip(d, 'c_v1')?.name === '' || clip(d, 'c_v1')?.name == null) break; }
  ok(!clip(d, 'c_v1').name, 'a chat naming a footage clip is undone');
  ok(clip(d, 'c_v2').name === 'Best take', '…and a chat renaming one the user named puts the user\'s name back');
  ok(media(d, 'm_aroll').name === 'C0004.MP4' && media(d, 'm_still').name === 'Client logo', '…the same for footage in the bin');
  ok(media(d, 'm_new').name === 'C0110.MP4' && !clip(d, 'c_new').name, 'new footage a chat adds gets its file name, its clip no name of its own');
  ok(clip(d, 'c_mg').name === 'LT v2' && clip(d, 'c_tx').name === 'Hook v2', 'a chat may still name motion graphics and text');
  ok(d.settings.originalNames === 1, 'the mark stays even if a chat drops it');
  const live = await api('GET', `/api/p/${id}`);
  ok(!clip(live.doc, 'c_v1').name && media(live.doc, 'm_new').name === 'C0110.MP4', 'the editor sees the original names too');

  // ------------------------------------------------------------ the one-time clean-up doesn't come back
  const md = fs.readFileSync(path.join(DIR, 'CLAUDE.md'), 'utf8');
  ok(/Footage keeps its own name/.test(md), 'the project\'s CLAUDE.md tells Claude the rule');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await srv.stop();
}
// reopen with a fresh server: names the user set survive (the clean-up ran once)
const srv2 = await startServer();
try {
  await api('POST', '/api/projects/open', { path: DIR });
  await sleep(800);
  const d = disk();
  ok(clip(d, 'c_v2').name === 'Best take' && media(d, 'm_still').name === 'Client logo', 'opened again, the user\'s names are still there');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await srv2.stop();
}
console.log(failed ? `clip-names: ${failed} failed` : 'clip-names: all checks passed');
process.exit(failed ? 1 : 0);
