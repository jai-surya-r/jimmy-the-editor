// The same file twice in a project's media, and once more in another project: they share one proxy job, and every
// entry has to end up ready (one used to stay "queued" for ever).
//   node tests/proxy-duplicate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';

const { FFMPEG, HAS_X264 } = await import('../server/ffmpeg.js'); // an installed ffmpeg has x264, the app's LGPL one OpenH264
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

const BASE = path.join(WORK, 'proxy-duplicate');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
const clip = path.join(BASE, 'big clip.mp4');
const made = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=25:duration=2', '-pix_fmt', 'yuv420p', '-c:v', HAS_X264 ? 'libx264' : 'libopenh264', '-b:v', '20M', clip], { encoding: 'utf8' });
if (made.status) throw new Error(made.stderr);

const project = (name, ids) => {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name, settings: {}, folders: [],
    media: ids.map((id) => ({ id, name: 'clip', path: clip, type: 'video' })),
    sequences: [{ id: 's1', name: 'S', width: 1920, height: 1080, fps: 25, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }));
  return dir;
};
const a = project('one', ['m1', 'm2']);
const b = project('two', ['m9']);

const srv = await startServer();
try {
  await api('POST', '/api/settings', { prerender: { enabled: false }, proxyMode: 'auto' });
  const [{ id: A }, { id: B }] = [await api('POST', '/api/projects/open', { path: a }), await api('POST', '/api/projects/open', { path: b })];
  const all = async () => { const [x, y] = [await api('GET', `/api/p/${A}`), await api('GET', `/api/p/${B}`)]; return [x.mediaStatus.m1, x.mediaStatus.m2, y.mediaStatus.m9]; };
  let st = [];
  for (let i = 0; i < 240; i++) { st = await all(); if (st.every((s) => s?.proxy === 'ready')) break; await sleep(250); }
  ok(st[0]?.proxy === 'ready', `the first entry is ready (${st[0]?.proxy})`);
  ok(st[1]?.proxy === 'ready', `the duplicate in the same project is ready (${st[1]?.proxy})`);
  ok(st[2]?.proxy === 'ready', `the same file in another project is ready (${st[2]?.proxy})`);
  ok(st.every((s) => s?.proxyPath && fs.existsSync(s.proxyPath)), 'each points at a proxy that exists');
  ok(st.every((s) => s?.proxyProgress === 1), 'none is left part way');
  const q = (await api('GET', '/api/proxies')).queue;
  ok(!q.length, `nothing is left in the proxy queue (${q.length})`);
} finally { await srv.stop(); fs.rmSync(BASE, { recursive: true, force: true }); }
console.log(failed ? `proxy-duplicate: ${failed} failed` : 'proxy-duplicate: all checks passed');
process.exit(failed ? 1 : 0);
