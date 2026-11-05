#!/usr/bin/env node
// Projects made with Jimmy's template keep their files inside the project folder:
//   node tests/template-files.mjs
// A throwaway template project (tests/.work/template) with a motion graphic and a 4K clip in 4_Footage/A_Roll/Day 1. Checks:
//   1. the motion graphic renders into 3_Exports/1_After Effects Exports (the folder the project already has) and
//      isn't listed as an export in Review;
//   2. the clip's proxy goes to 4_Footage/A_Roll/Proxies/Day 1/C0001_proxy.mp4 and is what the preview plays;
//   3. the editor's own files go to 5_Projects/Jimmy Files;
//   4. a project left by an earlier version (render, proxy, UI state in the app's data folder) moves them into the
//      project when it opens, without rendering or encoding again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';
import { FFMPEG } from '../server/ffmpeg.js';

const DATA = path.join(WORK, 'template-data');
const DIR = path.join(WORK, 'template', 'Proj');
const AE = path.join(DIR, '3_Exports', '1_After Effects Exports');
const CLIP = path.join(DIR, '4_Footage', 'A_Roll', 'Day 1', 'C0001.MP4');
const PROXY = path.join(DIR, '4_Footage', 'A_Roll', 'Proxies', 'Day 1', 'C0001_proxy.mp4');
const FILES = path.join(DIR, '5_Projects', 'Jimmy Files');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
};

fs.rmSync(path.join(WORK, 'template'), { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
for (const d of ['1_Assets/4_Overlays', '2_Audio', '3_Exports/1_After Effects Exports', '3_Exports/3_Premier_Pro_Exports/1_Internal_QC', '4_Footage/A_Roll/Day 1', '5_Projects']) fs.mkdirSync(path.join(DIR, d), { recursive: true });
const made = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=25:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', CLIP]);
if (made.status !== 0) throw new Error(`ffmpeg: ${made.stderr}`);

const env = { JIMMY_DATA_DIR: DATA };
const movs = () => (fs.existsSync(AE) ? fs.readdirSync(AE).filter((n) => n.endsWith('.mov')) : []);
let server = await startServer({ env });
let id, mid, vid, render;
try {
  console.log('first open');
  ({ id } = await api('POST', '/api/projects/open', { path: DIR }));
  ({ id: mid } = await api('POST', `/api/p/${id}/motion`, { starter: true, name: 'Badge', duration: 1 }));
  ([vid] = (await api('POST', `/api/p/${id}/media/link`, { paths: [CLIP] })).ids);
  await until(async () => (await api('GET', `/api/p/${id}/motion/${mid}`)).status?.state === 'ready', 180000, 'the motion render');
  render = movs()[0];
  check(movs().length === 1 && /^Badge-\w+-[0-9a-f]{12}\.mov$/.test(render), `motion graphic rendered into 3_Exports/1_After Effects Exports (${movs().join(', ')})`);
  check(!fs.existsSync(path.join(DIR, '3_Exports', '1_After_Effects_Exports')), 'no second After Effects folder');
  check(!fs.existsSync(path.join(DATA, 'state')) || !fs.readdirSync(path.join(DATA, 'state')).some((p) => fs.existsSync(path.join(DATA, 'state', p, 'motion-renders'))), 'nothing in the app data folder\'s motion-renders');
  const { files } = await api('GET', `/api/p/${id}/exports`);
  check(!files.some((f) => f.name === render), `Review doesn't list the render as an export (${files.length} exports)`);
  await until(async () => (await api('GET', `/api/p/${id}`)).mediaStatus[vid]?.proxy === 'ready', 180000, 'the proxy');
  check(fs.existsSync(PROXY), 'proxy in 4_Footage/A_Roll/Proxies/Day 1/C0001_proxy.mp4');
  const r = await fetch(`http://127.0.0.1:4455/media/${id}/${vid}/preview`);
  const len = Number(r.headers.get('content-length'));
  await r.body?.cancel();
  check(r.ok && len === fs.statSync(PROXY).size, 'the preview plays that proxy');
  await api('POST', `/api/p/${id}/chat-links`, { links: {} }).catch(() => {});
  check(fs.existsSync(FILES), '5_Projects/Jimmy Files exists');
  const doc = (await api('GET', `/api/p/${id}`)).doc;
  check(doc.media.find((m) => m.id === mid).path === `3_Exports/1_After Effects Exports/${render}`, 'project.json points at the render inside the project');
} finally {
  await server.stop();
}

// As an earlier version left it: render, proxy and UI state in the app's data folder
console.log('a project from an earlier version');
const state = path.join(DATA, 'state', id);
fs.mkdirSync(path.join(state, 'motion-renders'), { recursive: true });
fs.mkdirSync(path.join(state, 'cache'), { recursive: true });
fs.renameSync(path.join(AE, render), path.join(state, 'motion-renders', render));
const st = fs.statSync(CLIP);
const key = crypto.createHash('sha1').update(`${CLIP}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
fs.renameSync(PROXY, path.join(state, 'cache', `${key}.proxy.mp4`));
fs.writeFileSync(path.join(state, 'ui.json'), '{"old":true}\n');
fs.rmSync(path.join(FILES, 'ui.json'), { force: true });
const log = path.join(WORK, 'server-template-2.log');
server = await startServer({ env, log });
try {
  await api('POST', '/api/projects/open', { path: DIR });
  await api('GET', `/api/p/${id}`);
  await until(async () => (await api('GET', `/api/p/${id}/motion/${mid}`)).status?.state === 'ready', 60000, 'the motion graphic');
  check(movs().length === 1 && movs()[0] === render, 'the old render moved into After Effects Exports');
  check(!fs.existsSync(path.join(state, 'motion-renders', render)), '…and left the app data folder');
  check(!/\[motion\] rendered/.test(fs.readFileSync(log, 'utf8')), '…without rendering again');
  await until(async () => (await api('GET', `/api/p/${id}`)).mediaStatus[vid]?.proxy === 'ready', 60000, 'the proxy');
  check(fs.existsSync(PROXY) && !fs.existsSync(path.join(state, 'cache', `${key}.proxy.mp4`)), 'the old proxy moved next to the footage');
  check(fs.readFileSync(path.join(FILES, 'ui.json'), 'utf8').includes('"old":true') && !fs.existsSync(path.join(state, 'ui.json')), 'ui.json moved into Jimmy Files');
} finally {
  await server.stop();
}
console.log(failed ? `template-files: ${failed} failed` : 'template-files: all checks passed');
process.exit(failed ? 1 : 0);
