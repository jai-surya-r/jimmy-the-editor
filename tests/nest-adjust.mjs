// Nested sequences and adjustment layers, by their pixels: stills and an export rendered through the server's real
// path, read back with ffmpeg. Also: a nested sequence's sound in the mix, a sequence never inside itself, Nest on
// selected clips, double-click to open a nested clip, and the adjustment layer's "Layers below" in the Inspector.
//   JIMMY_APP=electron node tests/nest-adjust.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, openGolden, api, WORK, PORT, GOLDEN_DIR } from './lib/server.mjs';
import { FFMPEG } from '../server/ffmpeg.js';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9373;
const DIR = path.join(WORK, 'nest-adjust');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const solid = (id, track, start, duration, color, extra = {}) => ({ id, type: 'solid', track, start, duration, color, ...extra });
const tracks = (v, a = 1) => [...Array.from({ length: v }, (_, i) => ({ id: `v${i + 1}`, kind: 'video' })), ...Array.from({ length: a }, (_, i) => ({ id: `a${i + 1}`, kind: 'audio' }))];
const S = (id, name, clips, nv = 3) => ({ id, name, width: 1920, height: 1080, fps: 25, background: '#000000', tracks: tracks(nv), clips });

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  await openGolden(); // test media (the tone)
  const doc = {
    format: 'claude-edit/1', name: 'Nest', settings: { originalNames: 1 }, folders: [],
    media: [{ id: 'm_tone', path: path.join(GOLDEN_DIR, 'media', 'tone.wav').replace(/\\/g, '/') }],
    sequences: [
      // red on the left half, and a tone
      S('s_inner', 'Inner', [solid('c_red', 'v1', 0, 6, '#ff0000', { crop: { left: 0, top: 0, right: 0.5, bottom: 0 } }), { id: 'c_tone', type: 'audio', track: 'a1', media: 'm_tone', start: 0, duration: 6, in: 0, volume: 1 }]),
      S('s_outer', 'Outer', [
        solid('c_blue', 'v1', 0, 6, '#0000ff'),
        { id: 'c_n1', type: 'sequence', sequence: 's_inner', track: 'v2', start: 0, duration: 3, in: 0, transform: { x: 480 } },
        { id: 'c_n2', type: 'sequence', sequence: 's_inner', track: 'v2', start: 3, duration: 3, in: 3, transform: { opacity: 0.5 } },
      ]),
      S('s_adj', 'Adjust', [
        solid('c_green', 'v1', 0, 4, '#00ff00'),
        solid('c_white', 'v2', 0, 4, '#ffffff', { transform: { scale: 0.25 } }),
        { id: 'c_adj1', type: 'adjust', track: 'v3', start: 0, duration: 2, below: { scale: 2 }, transform: { scale: 0.4 } },
        { id: 'c_adj2', type: 'adjust', track: 'v3', start: 2, duration: 2, below: { scale: 2 }, transform: { opacity: 0.5 } },
      ]),
    ],
  };
  fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(doc, null, 2));
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  for (let i = 0; i < 60; i++) { const p = await api('GET', `/api/p/${id}`); if (p.doc.media.every((m) => m.duration)) break; await sleep(250); }

  // a still at full size, read back as pixels
  const pixels = async (seqId, t) => {
    const r = await api('POST', `/api/p/${id}/still`, { sequenceId: seqId, time: t, scale: 1 });
    const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', r.path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 << 20 }).stdout;
    return (x, y) => { const i = (y * 1920 + x) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
  };
  const near = (p, q, tol = 6) => p.every((v, i) => Math.abs(v - q[i]) <= tol);
  const show = (p) => `rgb(${p.join(',')})`;

  // ------------------------------------------------------------ nested sequence
  let px = await pixels('s_outer', 1);
  ok(near(px(700, 540), [255, 0, 0]) && near(px(1400, 540), [255, 0, 0]), `the nested sequence's red half shows, moved right by the nested clip (${show(px(700, 540))})`);
  ok(near(px(200, 540), [0, 0, 255]) && near(px(1600, 540), [0, 0, 255]), `where the nested sequence is empty, what is below shows through (${show(px(200, 540))}, ${show(px(1600, 540))})`);
  px = await pixels('s_outer', 4);
  ok(near(px(200, 540), [128, 0, 128], 12) && near(px(1200, 540), [0, 0, 255]), `a nested clip at 50% opacity mixes with what is below (${show(px(200, 540))})`);

  // ------------------------------------------------------------ adjustment layer
  px = await pixels('s_adj', 1);
  ok(near(px(1300, 540), [255, 255, 255]), `the layers below are zoomed ×2 inside the adjustment's area (${show(px(1300, 540))}, green without it)`);
  ok(near(px(1400, 540), [0, 255, 0]), `outside its own area (scale 40%) the picture is as it was (${show(px(1400, 540))})`);
  ok(near(px(960, 540), [255, 255, 255]) && near(px(100, 100), [0, 255, 0]), 'the centre and the corners are right');
  px = await pixels('s_adj', 3);
  ok(near(px(1300, 540), [128, 255, 128], 12), `at 50% opacity the zoomed picture mixes with the original (${show(px(1300, 540))})`);

  // ------------------------------------------------------------ an export (chunks, the render page) of a nested sequence
  const job = (await api('POST', `/api/p/${id}/render`, { sequenceId: 's_outer', quality: 'high', addVersion: false, outDir: DIR, name: 'outer export', wait: true })).job;
  ok(job.status === 'done' && fs.existsSync(job.output), `the nested sequence exports (${job.status} ${job.error || ''})`);
  if (job.status === 'done') {
    const frame = (t) => spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', job.output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 << 20 }).stdout;
    const f1 = frame(1), at = (raw, x, y) => { const i = (y * 1920 + x) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
    ok(near(at(f1, 700, 540), [255, 0, 0], 20) && near(at(f1, 200, 540), [0, 0, 255], 20), `…with the same picture as the still (${show(at(f1, 700, 540))}, ${show(at(f1, 200, 540))})`);
    const vol = spawnSync(FFMPEG, ['-v', 'info', '-i', job.output, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = parseFloat((vol.match(/mean_volume: (-?[\d.]+) dB/) || [])[1]);
    ok(mean > -40, `…and the nested sequence's sound is in it (mean ${mean} dB)`);
  }

  // ------------------------------------------------------------ the editor
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy.activeTab()?.seq).catch(() => false)) break; await sleep(200); }
  await page.call(() => window.__jimmy.activeTab().setSequence('s_outer'));
  await sleep(500);
  const ed = await page.call(async () => {
    const t = window.__jimmy.activeTab();
    const { insertSequence } = await import('/js/core/ops.js');
    const d = structuredClone(t.doc);
    const inner = d.sequences.find((s) => s.id === 's_inner');
    const loop = insertSequence(d, inner, 's_outer', { start: 0, trackId: 'v1' }); // Outer already holds Inner
    const self = insertSequence(d, inner, 's_inner', { start: 0, trackId: 'v1' });
    const label = document.querySelector('[data-clip="c_n1"]')?.textContent || '';
    return { loop: loop === null, self: self === null, label };
  });
  ok(ed.loop && ed.self, 'a sequence is never put inside itself, directly or through another');
  ok(/Inner/.test(ed.label), `a nested clip on the timeline is named after its sequence (${ed.label.trim().slice(0, 30)})`);
  // the preview draws the nested contents (the same compositor as the export)
  await page.call(() => window.__jimmy.activeTab().engine.seek(1));
  await sleep(800);
  const prev = await page.call(() => { const c = document.querySelector('.viewer-canvas'); const x = Math.round(c.width * 700 / 1920), y = Math.round(c.height / 2); return [...c.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3); });
  ok(near(prev, [255, 0, 0], 20), `the preview shows the nested sequence too (${show(prev)})`);
  // double-click opens it
  await page.call(() => document.querySelector('[data-clip="c_n1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(300);
  ok(await page.call(() => window.__jimmy.activeTab().seq.id === 's_inner'), 'double-clicking a nested clip opens its sequence');
  // Nest on selected clips
  await page.call(() => window.__jimmy.activeTab().setSequence('s_adj'));
  await sleep(300);
  const nest = await page.call(async () => {
    const t = window.__jimmy.activeTab();
    const { nestClips } = await import('/js/core/ops.js');
    let made = null;
    t.apply('Nest', (d, ds) => { made = nestClips(d, ds, ['c_green', 'c_white'], 'Square'); });
    const s = t.seq;
    const inner = t.doc.sequences.find((x) => x.id === made.sequence.id);
    return { left: s.clips.map((c) => `${c.type}@${c.track}`).sort().join(' '), inner: inner.clips.map((c) => `${c.id}@${c.start}`).join(' '), name: inner.name };
  });
  ok(nest.left === 'adjust@v3 adjust@v3 sequence@v1' && nest.name === 'Square' && nest.inner === 'c_green@0 c_white@0', `Nest moves the clips into a new sequence and leaves one nested clip (${nest.left}; ${nest.inner})`);
  const after = await pixels('s_adj', 1).catch(() => null);
  // (the project was saved by the editor: the server renders the nested version)
  for (let i = 0; i < 20; i++) { const p = await api('GET', `/api/p/${id}`); if (p.doc.sequences.length === 4) break; await sleep(200); }
  const px2 = await pixels('s_adj', 1);
  ok(near(px2(1300, 540), [255, 255, 255]) && near(px2(1400, 540), [0, 255, 0]), 'after nesting, the adjustment layer over the nested clip gives the same picture');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(400);
  ok(await page.call(() => window.__jimmy.activeTab().doc.sequences.length === 3 && window.__jimmy.activeTab().seq.clips.some((c) => c.id === 'c_white')), 'one Undo takes the nest back');
  // the Inspector of an adjustment layer
  await page.call(() => { const t = window.__jimmy.activeTab(); t.select(['c_adj1']); t.ui.set({ focusClip: 'c_adj1' }); });
  await sleep(300);
  const insp = await page.call(() => [...document.querySelectorAll('.inspector .section-title, .inspector [class*="section"] h3, .inspector header')].map((e) => e.textContent.trim()).join(' | ') || document.querySelector('.inspector')?.textContent || '');
  ok(/Layers below/.test(insp) && /Layer \(where it applies\)/.test(insp), `the Inspector has "Layers below" and "Layer (where it applies)" for an adjustment layer`);
  void after;
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `nest-adjust: ${failed} failed` : 'nest-adjust: all checks passed');
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
