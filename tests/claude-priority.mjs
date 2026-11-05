// The scheduler with Claude in it (Step 81): while the editor plays (or scrubs), a motion graphic that is rendering
// waits between two frames and goes on when playback stops; a working Claude chat leaves less of the machine for
// background work. Uses tests/lib/fake-claude.mjs in place of `claude`: no Claude is started.
//   JIMMY_APP=electron node tests/claude-priority.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT, ROOT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron' && !process.env.JIMMY_APP_EXE) { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(200); } };
const DIR = path.join(WORK, 'claude-priority');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// `claude` on the PATH is the stand-in
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const fake = path.join(ROOT, 'tests', 'lib', 'fake-claude.mjs');
fs.writeFileSync(path.join(BIN, 'claude.cmd'), `@node "${fake}" %*\r\n`);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
fs.chmodSync(path.join(BIN, 'claude'), 0o755);
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const srv = await startServer({ env: { [pathKey]: `${BIN}${path.delimiter}${process.env[pathKey]}` } });
let ws;
try {
  const proj = path.join(DIR, 'project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'Priority', media: [], folders: [],
    sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 25, background: '#000000', tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }] }, null, 2));
  const { id } = await api('POST', '/api/projects/open', { path: proj });

  // an editor window, as far as the server can tell: it says what the person is doing
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let budget = null;
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'budget') budget = m.budget; } catch { /* ignore */ } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const say = (m) => ws.send(JSON.stringify(m));
  say({ type: 'hello', clientId: 'test-priority' });
  say({ type: 'subscribe', projectId: id });
  say({ type: 'activity', input: true });

  // a graphic long enough to watch
  const { id: mid } = await api('POST', `/api/p/${id}/motion`, { starter: true, name: 'Long badge', duration: 20 });
  const status = async () => (await api('GET', `/api/p/${id}/motion/${mid}`)).status || {};
  const started = await until(async () => { const s = await status(); return s.state === 'rendering' && s.progress > 0.05 && s; }, 120000);
  ok(!!started, `the graphic renders (${Math.round((started?.progress || 0) * 100)}%)`);

  // play: it waits
  say({ type: 'activity', playing: true });
  await sleep(1500);
  const p1 = (await status()).progress;
  await sleep(4000);
  const p2 = (await status()).progress;
  ok(p2 - p1 < 0.02, `while the editor plays, the graphic waits (${Math.round(p1 * 100)}% → ${Math.round(p2 * 100)}% in 4 s)`);
  ok(budget?.held?.includes('motion') && budget?.mode === 'playing', `the scheduler says so (held: ${budget?.held}, mode ${budget?.mode})`);
  ok((await status()).state !== 'error', 'it was not stopped as stuck');
  // stop playing: it goes on
  say({ type: 'activity', playing: false });
  await sleep(3000);
  const p3 = (await status()).progress;
  ok(p3 > p2 + 0.02, `when playback stops, it goes on (${Math.round(p2 * 100)}% → ${Math.round(p3 * 100)}%)`);
  // scrubbing too
  say({ type: 'activity', scrub: true });
  await sleep(600);
  ok(budget?.held?.includes('motion'), 'scrubbing holds it too');
  const ready = await until(async () => (await status()).state === 'ready', 180000);
  ok(ready, 'the graphic finishes');

  // Claude working: less for the background
  say({ type: 'activity', input: true });
  const before = await until(() => budget?.mode === 'editing' && !budget.claude && budget, 8000);
  await api('POST', `/api/p/${id}/chat/start`, { mode: 'new' });
  await until(async () => (await api('GET', `/api/p/${id}/chat`)).sessionId);
  await api('POST', `/api/p/${id}/chat/send`, { text: 'please run it fg' }); // a command that runs until stopped
  const during = await until(() => budget?.claude && budget, 5000);
  ok(!!during && !before?.claude, 'a working chat is counted by the scheduler');
  const drawn = await api('POST', `/api/p/${id}/motion/${mid}/render`, { force: true });
  void drawn;
  const withClaude = await until(() => budget?.claude && budget.shares?.motion > 0 && budget, 60000);
  // (a small machine, like GitHub's Macs, is already at the floor of one slot while editing: nothing less to give)
  ok(withClaude && (withClaude.headroom < before.headroom || before.headroom <= 1), `…and leaves less for background work (headroom ${before?.headroom} → ${withClaude?.headroom}${before?.headroom <= 1 ? ', already the smallest' : ''})`);
  await api('POST', `/api/p/${id}/chat/stop`);
  const after = await until(() => budget && !budget.claude && budget, 8000);
  ok(!!after, 'when the chat ends, it is no longer counted');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  try { ws?.close(); } catch { /* closed */ }
  await srv.stop();
}
console.log(failed ? `claude-priority: ${failed} failed` : 'claude-priority: all checks passed');
process.exit(failed ? 1 : 0);
