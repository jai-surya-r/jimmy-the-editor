// The machine test and the power tiers (server/machine.js, server/tiers.js), on fresh data folders:
//   - a first start measures the computer by itself; on an install whose performance settings were never changed, the
//     measured tier's settings are used (JIMMY_FAKE_TIER=light stands in for a small laptop)
//   - Light: one render slot, two motion pages, 1080p60 footage gets a proxy, the preview's tier cap is half
//   - an install whose settings were changed by hand keeps them (the tier is only measured and offered)
//   - picking a profile in Settings changes the limits; "Test this computer again" measures again
//   node tests/machine-tier.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, startServer, api } from './lib/server.mjs';

const { FFMPEG } = await import('../server/ffmpeg.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const BASE = path.join(WORK, 'machine-tier');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
const until = async (fn, ms = 60000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(300); } };

// 1080p60 footage: fine on a strong computer, proxied on a light one
const clip = path.join(BASE, 'clip60.mp4');
const made = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-b:v', '8M', clip], { encoding: 'utf8' });
if (made.status) throw new Error(made.stderr);
const clip2 = path.join(BASE, 'clip60 copy.mp4'); // the same footage as another file (proxies are kept per file)
fs.copyFileSync(clip, clip2);
const project = (name, file = clip) => {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name, settings: {}, folders: [],
    media: [{ id: 'm1', name: 'clip', path: file, type: 'video' }],
    sequences: [{ id: 's1', name: 'S', width: 1920, height: 1080, fps: 60, tracks: [{ id: 'v1', kind: 'video' }], clips: [] }] }));
  return dir;
};
const proxyOf = async (id) => until(async () => { const st = (await api('GET', `/api/p/${id}`)).mediaStatus.m1; return st?.probed ? st : null; });

console.log('a fresh install on a small laptop');
let data = path.join(BASE, 'data-fresh');
let srv = await startServer({ env: { JIMMY_DATA_DIR: data, JIMMY_NO_MACHINE_TEST: '', JIMMY_FAKE_TIER: 'light' } });
try {
  const m = await until(async () => { const s = await api('GET', '/api/state'); return s.machine?.measured ? s : null; }, 90000);
  ok(!!m?.machine?.measured?.decodeFps1, `the computer is measured by itself after the start (${JSON.stringify(m?.machine?.measured && { cores: m.machine.measured.cores, ramGB: m.machine.measured.ramGB, decodeFps1: m.machine.measured.decodeFps1 })})`);
  // (the tier's settings are written just after the measurement)
  const s = await until(async () => { const x = await api('GET', '/api/state'); return x.performance.usage === 50 ? x : null; }, 5000) || await api('GET', '/api/state');
  ok(s.machine.tier === 'light', `the tier is Light (${s.machine.tier})`);
  ok(s.performance.usage === 50 && s.performance.jobs === 1 && s.performance.priority === 'idle' && s.prerender.enabled === false,
    `Light's settings are used on an untouched install (${JSON.stringify({ usage: s.performance.usage, jobs: s.performance.jobs, priority: s.performance.priority, prerender: s.prerender.enabled })})`);
  ok(s.renderSlots === 1, `one render slot at a time (${s.renderSlots})`);
  ok(s.machine.limits.light.previewCap === 0.5, 'the preview starts at half size on Light');
  const { id } = await api('POST', '/api/projects/open', { path: project('light') });
  const st = await proxyOf(id);
  ok(st && st.proxy !== 'none', `1080p60 footage gets a proxy on Light (${st?.proxy})`);
  // a profile picked in Settings
  await api('POST', '/api/settings', { performance: { usage: 70, priority: 'low', jobs: 2, profile: 'full' } });
  const f = await api('GET', '/api/state');
  ok(f.machine.tier === 'full' && f.machine.profile === 'full' && f.renderSlots > 1, `picking Full in Settings lifts the limits (tier ${f.machine.tier}, ${f.renderSlots} render slots)`);
  const { id: id2 } = await api('POST', '/api/projects/open', { path: project('full', clip2) });
  const st2 = await proxyOf(id2);
  ok(st2 && st2.proxy === 'none', `on Full the same 1080p60 footage plays as it is (${st2?.proxy})`);
  const again = await api('POST', '/api/machine/test');
  ok(again.testing === true, 'Test this computer again starts a new measurement');
  const done = await until(async () => { const x = (await api('GET', '/api/state')).machine; return !x.testing && x.measured.at > m.machine.measured.at ? x : null; }, 90000);
  ok(!!done, 'and it finishes with a new result');
} finally { await srv.stop(); }

console.log('an install whose settings were changed by hand');
data = path.join(BASE, 'data-custom');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ performance: { usage: 100, threads: 'auto', priority: 'normal', jobs: 3 } }, null, 2));
srv = await startServer({ env: { JIMMY_DATA_DIR: data, JIMMY_NO_MACHINE_TEST: '', JIMMY_FAKE_TIER: 'light' } });
try {
  const m = await until(async () => { const s = await api('GET', '/api/state'); return s.machine?.measured ? s : null; }, 90000);
  ok(m?.machine?.measured?.tier === 'light', 'measured as Light');
  ok(m.performance.usage === 100 && m.performance.jobs === 3 && m.performance.priority === 'normal', `the person's own settings stay (${JSON.stringify({ usage: m.performance.usage, jobs: m.performance.jobs, priority: m.performance.priority })})`);
} finally { await srv.stop(); }

fs.rmSync(BASE, { recursive: true, force: true });
console.log(failed ? `machine-tier: ${failed} failed` : 'machine-tier: all checks passed');
process.exit(failed ? 1 : 0);
