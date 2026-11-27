// Timeline audio comes back by itself after the two failures that could leave playback silent (seen with pre-rendering
// on: the machine busy rendering when play starts):
//   • the clip's audio element fails (a read broken off while the disk was busy): it was kept and asked to play on
//     every frame, silently; now it is made again after a second
//   • the audio output stalls (its clock stops; the system suspended it): it is resumed, or replaced, keeping the
//     master volume, and every clip's audio is made again on the new one
//   JIMMY_APP=electron node tests/audio-recover.mjs
import { startServer, openGolden, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9367;

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy.activeTab()?.doc).catch(() => false)) break; await sleep(200); }
  await page.call(() => { const t = window.__jimmy.activeTab(); t.setSequence('s_cuts'); t.ui.set({ mode: 'edit' }); });
  await sleep(800);

  // what the clip's audio is doing: the element playing it, and whether it is really sounding
  const state = () => page.call(async () => {
    const t = window.__jimmy.activeTab(), eng = t.engine;
    const { audioGraph } = await import('/js/core/playback.js');
    const g = audioGraph();
    const e = [...eng.audios.values()].find((x) => x.clip && x.clip.start <= eng.t && eng.t < x.clip.start + x.clip.duration);
    if (!e) return { none: true, playing: eng.playing, t: eng.t };
    if (!e.el.__id) e.el.__id = Math.random().toString(36).slice(2, 8);
    return { id: e.el.__id, paused: e.el.paused, ready: e.el.readyState, error: !!e.error, gain: e.gain.gain.value, ctx: g.actx.state, ctxTime: g.actx.currentTime, master: g.master.gain.value, playing: eng.playing, t: eng.t };
  });
  const sounding = (s) => s && !s.none && !s.paused && s.ready >= 3 && !s.error && s.gain > 0.01 && s.ctx === 'running';
  const until = async (fn, ms) => { const t0 = Date.now(); let s; for (;;) { s = await state(); if (fn(s) || Date.now() - t0 > ms) return s; await sleep(150); } };

  await page.call(() => { const eng = window.__jimmy.activeTab().engine; eng.seek(0.5); eng.loop = true; eng.play(); });
  let s = await until(sounding, 8000);
  ok(sounding(s), `playing, the clip's audio sounds (${JSON.stringify(s)})`);

  console.log('the audio element fails');
  const before = s.id;
  await page.call(() => {
    const eng = window.__jimmy.activeTab().engine;
    const e = [...eng.audios.values()].find((x) => x.clip && x.clip.start <= eng.t && eng.t < x.clip.start + x.clip.duration);
    e.el.dispatchEvent(new Event('error')); // what the browser does when the file's bytes stop coming
  });
  await sleep(300);
  s = await state();
  ok(s.error === true || s.id !== before, 'the failure is noticed');
  s = await until((x) => sounding(x) && x.id !== before, 6000);
  ok(sounding(s) && s.id !== before, `within seconds a new element plays the clip, audibly (${s.id} replaced ${before})`);

  console.log('the audio output stalls');
  await page.call(async () => {
    const { audioGraph } = await import('/js/core/playback.js');
    const g = audioGraph();
    g.master.gain.value = 0.7; // a Review volume, say: it must survive
    window.__oldCtx = g.actx;
    g.actx.resume = () => Promise.resolve(); // a context that won't come back
    await g.actx.suspend();
  });
  s = await until((x) => sounding(x) && x.ctxTime > 0 && x.ctx === 'running', 9000);
  const replaced = await page.call(async () => { const { audioGraph } = await import('/js/core/playback.js'); return audioGraph().actx !== window.__oldCtx; });
  ok(replaced, 'the stalled audio output is replaced');
  ok(sounding(s), `…and the clip sounds again on the new one (${JSON.stringify(s)})`);
  ok(Math.abs(s.master - 0.7) < 1e-6, `…at the same master volume (${s.master})`);
  const t1 = (await state()).t; await sleep(1000); const t2 = (await state()).t;
  ok(t2 > t1 || t2 < 1, `playback carries on (${t1.toFixed(2)} → ${t2.toFixed(2)} s)`);

  console.log('a suspended output that can resume');
  await page.call(async () => { const { audioGraph } = await import('/js/core/playback.js'); window.__ctx2 = audioGraph().actx; await audioGraph().actx.suspend(); });
  s = await until((x) => sounding(x), 4000);
  const same = await page.call(async () => { const { audioGraph } = await import('/js/core/playback.js'); return audioGraph().actx === window.__ctx2; });
  ok(sounding(s) && same, 'it is simply resumed (not replaced)');
  await page.call(() => window.__jimmy.activeTab().engine.pause());
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `audio-recover: ${failed} failed` : 'audio-recover: all checks passed');
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
  return { call, close: () => ws.close() };
}
