// Synchronize… by audio, end to end in the desktop app: recordings cut from one source at known offsets (a camera with
// picture and sound, a second camera at 44.1 kHz with the treble cut off, a separate recorder, and an unrelated
// recording) placed anywhere; Synchronize lines them up with the camera to a fraction of a millisecond, leaves the
// unrelated one alone, keeps picture on whole frames, moves everything right when something would start before 0, and
// one Undo takes it all back. Also Clip start.
//   JIMMY_APP=electron node tests/sync.mjs [folder for a screenshot]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, api, WORK, PORT } from './lib/server.mjs';
import { FFMPEG, HAS_X264 } from '../server/ffmpeg.js';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9371;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'sync');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'media'), { recursive: true });
const ff = (...a) => { const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...a], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
const M = (f) => path.join(DIR, 'media', f);
// one source: bursts of noise and tones at uneven times, like speech
ff('-f', 'lavfi', '-i', "aevalsrc='(random(0)-0.5)*0.8*gt(sin(2*PI*1.3*t)*sin(2*PI*0.37*t+1),0.15)+0.3*sin(2*PI*(220+80*floor(mod(t*3,5)))*t)*gt(sin(2*PI*0.9*t),0.6)':s=48000:d=60", '-c:a', 'pcm_s24le', M('master.wav'));
const S = { a: 7.3, b: 12.345678, r: 3.0 };
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-ss', String(S.a), '-i', M('master.wav'), '-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.05:r=48000', '-filter_complex', '[1:a]volume=0.5[x];[x][2:a]amix=inputs=2:duration=first:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-t', '40', '-c:v', HAS_X264 ? 'libx264' : 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', M('camA.mp4'));
ff('-ss', String(S.b), '-i', M('master.wav'), '-af', 'lowpass=f=3000', '-ar', '44100', '-t', '40', '-c:a', 'pcm_s16le', M('camB.wav'));
ff('-ss', String(S.r), '-i', M('master.wav'), '-t', '45', '-c:a', 'pcm_s24le', M('recorder.wav'));
ff('-f', 'lavfi', '-i', "aevalsrc='(random(1)-0.5)*0.8*gt(sin(2*PI*1.1*t)*sin(2*PI*0.41*t+2),0.15)':s=48000:d=40", M('unrelated.wav'));
const truth = { camB: S.a - S.b, recorder: S.a - S.r }; // the moment t in camA is at t + lag in the other

const doc = {
  format: 'claude-edit/1', name: 'Sync', settings: { originalNames: 1 }, folders: [],
  media: [{ id: 'm_a', path: 'media/camA.mp4' }, { id: 'm_b', path: 'media/camB.wav' }, { id: 'm_r', path: 'media/recorder.wav' }, { id: 'm_u', path: 'media/unrelated.wav' }],
  sequences: [{
    id: 's1', name: 'Sync', width: 1920, height: 1080, fps: 25,
    tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio' }, { id: 'a3', kind: 'audio' }, { id: 'a4', kind: 'audio' }],
    clips: [
      { id: 'c_av', type: 'video', track: 'v1', media: 'm_a', start: 0, duration: 30, in: 0, link: 'l1' },
      { id: 'c_aa', type: 'audio', track: 'a1', media: 'm_a', start: 0, duration: 30, in: 0, link: 'l1' },
      { id: 'c_b', type: 'audio', track: 'a2', media: 'm_b', start: 10, duration: 20, in: 0 },
      { id: 'c_r', type: 'audio', track: 'a3', media: 'm_r', start: 20, duration: 20, in: 0 },
      { id: 'c_u', type: 'audio', track: 'a4', media: 'm_u', start: 0, duration: 20, in: 0 },
    ],
  }],
};
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(doc, null, 2));

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  for (let i = 0; i < 100; i++) { const p = await api('GET', `/api/p/${id}`); if (p.doc.media.every((m) => m.duration)) break; await sleep(300); }
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy.activeTab()?.seq).catch(() => false)) break; await sleep(200); }
  await sleep(500);

  // the clip menu offers it for a multi-clip selection
  await page.call(() => { const t = window.__jimmy.activeTab(); t.select(['c_av', 'c_b', 'c_r', 'c_u']); });
  const menu = await page.call(async () => { const { clipMenu } = await import('/js/ui/Timeline.js'); const t = window.__jimmy.activeTab(); return clipMenu(t, t.seq.clips.find((c) => c.id === 'c_b')).filter((x) => x && x.label).map((x) => x.label); });
  ok(menu.includes('Synchronize…'), 'the clip menu offers Synchronize… for several clips');
  await page.call(async () => { const { openSync } = await import('/js/ui/sync.js'); openSync(window.__jimmy.activeTab(), ['c_av', 'c_b', 'c_r', 'c_u']); });
  await sleep(300);
  const rowText = (r) => [...r.querySelectorAll('span')].map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const rows0 = await page.call(`() => [...document.querySelectorAll('.sync-row')].map(${rowText})`);
  ok(rows0.length === 4 && /^camA\.mp4 · V1\+A1 reference/.test(rows0[0]), `the camera (picture and sound together) is the reference (${rows0[0]})`);
  const t0 = Date.now();
  await page.call(() => [...document.querySelectorAll('.modal-foot button')].find((b) => /Find the offsets/.test(b.textContent)).click());
  let rows = [];
  for (let i = 0; i < 150; i++) { rows = await page.call(`() => [...document.querySelectorAll('.sync-row')].map((r) => ({ text: (${rowText})(r), on: r.querySelector('input').checked }))`); if (rows.every((r, j) => j === 0 || /offset|failed|no sound|play/.test(r.text))) break; await sleep(200); }
  console.log(`  info  listened in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${rows.map((r) => r.text).join(' | ')}`);
  ok(/^camB\.wav · A2 (sure|likely)/.test(rows[1].text) && rows[1].on, 'the second camera is found and ticked');
  ok(/^recorder\.wav · A3 sure/.test(rows[2].text) && rows[2].on, 'the recorder is found, sure, ticked');
  ok(/^unrelated\.wav · A4 unsure/.test(rows[3].text) && !rows[3].on, 'the unrelated recording is unsure and not ticked');
  if (SHOTS) { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, 'sync.png'), Buffer.from(data, 'base64')); }
  await page.call(() => [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === 'Synchronize').click());
  await sleep(500);
  const clips = await page.call(() => Object.fromEntries(window.__jimmy.activeTab().seq.clips.map((c) => [c.id, { start: c.start, in: c.in || 0, track: c.track }])));
  // where each clip's source lines up on the timeline, relative to the camera's
  const rel = (c) => (c.start - c.in) - (clips.c_aa.start - clips.c_aa.in);
  const errB = (rel(clips.c_b) + truth.camB) * 1000, errR = (rel(clips.c_r) + truth.recorder) * 1000;
  ok(Math.abs(errB) < 0.1, `the second camera lines up within 0.1 ms (${errB.toFixed(3)} ms)`);
  ok(Math.abs(errR) < 0.1, `the recorder lines up within 0.1 ms (${errR.toFixed(3)} ms)`);
  const onFrame = (t) => Math.abs(t * 25 - Math.round(t * 25)) < 1e-6;
  ok(Object.values(clips).every((c) => onFrame(c.start)), 'every clip still starts on a whole frame (the separate recordings move to the sample through their in point)');
  ok(Math.abs(clips.c_av.start - clips.c_aa.start) < 1e-9 && clips.c_av.start > 4.2, `the recorder would have started before 0, so everything moved right together (camera now at ${clips.c_av.start.toFixed(2)} s)`);
  ok(clips.c_u.start === 0 && clips.c_u.track === 'a4', 'the unrelated recording didn\'t move');
  ok(clips.c_b.track === 'a2' && clips.c_r.track === 'a3', 'clips stay on their tracks when nothing is in the way');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(400);
  const back = await page.call(() => window.__jimmy.activeTab().seq.clips.map((c) => `${c.id}:${c.start}`).join(' '));
  ok(back === 'c_av:0 c_aa:0 c_b:10 c_r:20 c_u:0', `one Undo takes it all back (${back})`);

  // Clip start: the starts line up with the reference's
  await page.call(async () => { const { openSync } = await import('/js/ui/sync.js'); openSync(window.__jimmy.activeTab(), ['c_av', 'c_b']); });
  await sleep(300);
  await page.call(() => [...document.querySelectorAll('.modal .segmented button')].find((b) => b.textContent.trim() === 'Clip start').click());
  await sleep(150);
  await page.call(() => [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === 'Synchronize').click());
  await sleep(400);
  const cs = await page.call(() => { const s = window.__jimmy.activeTab().seq; return { b: s.clips.find((c) => c.id === 'c_b'), u: s.clips.find((c) => c.id === 'c_u') }; });
  ok(cs.b.start === 0 && cs.b.in === 0 && cs.b.track === 'a2', `Clip start puts it at the reference's start (${cs.b.start} s on ${cs.b.track})`);

  // Timecode: two cameras whose files start at 10:00:00:00 and 10:00:05:12 (25 fps) line up by those
  const tc = await page.call(async () => {
    const { syncGroups, targetStarts } = await import('/js/ui/sync.js');
    const t = window.__jimmy.activeTab();
    const doc = structuredClone(t.doc), seq = doc.sequences[0];
    doc.media.find((m) => m.id === 'm_a').timecode = '10:00:00:00';
    doc.media.find((m) => m.id === 'm_b').timecode = '10:00:05:12';
    for (const m of doc.media) m.fps = 25;
    seq.clips.find((c) => c.id === 'c_b').in = 2; // its clip starts 2 s into its file
    const groups = syncGroups(seq, ['c_av', 'c_b']);
    return targetStarts(doc, seq, groups, 0, 'timecode').map((x) => x.start);
  });
  ok(Math.abs(tc[1] - (5 + 12 / 25 + 2)) < 1e-9, `Timecode places it by the difference of the cameras' timecode (${tc[1]} s)`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `sync: ${failed} failed` : 'sync: all checks passed');
process.exit(failed ? 1 : 0);

async function connectPage() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`) && !/render\.html|motion/.test(t.url)); } catch { /* not yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the editor window did not show up on the DevTools port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++seq; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const call = async (fn, ...a) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await send('Page.bringToFront').catch(() => {});
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return { send, call, close: () => ws.close() };
}
