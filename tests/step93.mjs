// Step 93 in the desktop app, with the real mouse and keys:
//   • Export › Range: In → Out works with only an In (or Out) point set, and a Custom range renders any span;
//   • Alt-drag on a clip leaves it where it was and drops a copy where the mouse lets go (Premiere);
//   • Position is one property: one Inspector row with X and Y, one curve in the graph editor (Separate
//     dimensions shows two); ease presets apply to the selected keyframes.
//   JIMMY_APP=electron node tests/step93.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9367;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'step93');
const OUT = path.join(DIR, 'exports');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  await openGolden();
  const solid = (id, track, start, duration, color, extra = {}) => ({ id, type: 'solid', track, start, duration, color, ...extra });
  const doc = {
    format: 'claude-edit/1', name: 'Step 93', settings: { originalNames: 1 }, folders: [], media: [],
    sequences: [{
      id: 's1', name: 'Main', width: 640, height: 360, fps: 30, inPoint: 2,
      tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }],
      clips: [
        solid('c_a', 'v1', 0, 2, '#e04040', { keyframes: {
          x: [{ t: 0, v: 0 }, { t: 1, v: 300 }, { t: 2, v: 300 }],
          y: [{ t: 0, v: 0 }, { t: 1, v: 400 }, { t: 2, v: 400 }],
          opacity: [{ t: 0, v: 1 }, { t: 2, v: 0.5 }],
        } }),
        solid('c_b', 'v1', 3, 2, '#40a0e0'),
      ],
    }, {
      id: 's2', name: 'Other', width: 640, height: 360, fps: 30,
      tracks: [{ id: 'v1', kind: 'video' }], clips: [solid('c_o', 'v1', 0, 6, '#40e080')],
    }],
  };
  fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(doc, null, 2));
  const { id } = await api('POST', '/api/projects/open', { path: DIR });

  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('[data-lane="v1"]')).catch(() => false)) break; await sleep(200); }
  await page.call(() => { const t = window.__jimmy.activeTab(); t.ui.set({ pps: 35, scrollX: 0, tool: 'select' }); });
  await sleep(400);
  const shot = async (name) => { if (!SHOTS) return; const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const at = (track, t) => page.call((tr, tt) => { const el = document.querySelector(`[data-lane="${tr}"]`); el.scrollIntoView({ block: 'nearest' }); const lane = el.getBoundingClientRect(); const ui = window.__jimmy.activeTab().ui.get(); return [lane.left + tt * ui.pps - ui.scrollX, lane.top + lane.height / 2]; }, track, t);
  const clips = () => page.call(() => window.__jimmy.activeTab().seq.clips.map((c) => ({ id: c.id, track: c.track, start: +c.start.toFixed(3), duration: c.duration, color: c.color })));

  console.log('Export range');
  const openExport = (seqId) => page.call(async (dir, sid) => {
    const t = window.__jimmy.activeTab();
    t.ui.set({ exportDir: dir, exportFormat: 'h264', exportOpts: null });
    const { ExportDialog } = await import('/js/ui/dialogs.js');
    const { openDialog } = await import('/js/core/notify.js');
    window.__exportDone = null;
    openDialog(ExportDialog, { tab: t, init: sid ? { seqId: sid } : undefined }).then((job) => { window.__exportDone = job; });
  }, OUT, seqId);
  const rangeField = () => page.call(() => { const f = [...document.querySelectorAll('.modal .field')].find((x) => x.querySelector('span')?.textContent === 'Range'); const s = f?.querySelector('select'); return s ? { value: s.value, options: [...s.options].map((o) => ({ value: o.value, label: o.textContent, disabled: o.disabled })) } : null; });
  const pickRange = (v) => page.call((val) => { const f = [...document.querySelectorAll('.modal .field')].find((x) => x.querySelector('span')?.textContent === 'Range'); const s = f.querySelector('select'); s.value = val; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const exportNow = async () => {
    await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => /^Export (MP4|MOV)$/.test(b.textContent.trim())).click());
    let job = null;
    for (let i = 0; i < 50 && !job; i++) { job = await page.call(() => window.__exportDone); await sleep(100); }
    let j = null;
    for (let i = 0; i < 100; i++) { j = (await api('GET', '/api/jobs')).jobs.find((x) => x.id === (job?.id || job?.jobId)); if (j?.frames) break; await sleep(100); }
    return j;
  };
  await openExport();
  let r = null;
  for (let i = 0; i < 30 && !r; i++) { r = await rangeField(); await sleep(100); }
  const io = r?.options.find((o) => o.value === 'inout');
  ok(r?.value === 'inout' && io && !io.disabled && /00:00:02:00 → 00:00:05:00/.test(io.label), `only an In point set: "In → Out" is offered from In to the end (${io?.label})`);
  let j = await exportNow();
  ok(j?.frames === 90, `…and renders 2 s → 5 s: ${j?.frames} frames (90 expected)`);
  // another sequence, without In / Out: a custom range
  await openExport('s2');
  await sleep(400);
  r = await rangeField();
  ok(r?.value === 'all' && r.options.find((o) => o.value === 'inout')?.disabled, 'a sequence without In / Out starts on the whole sequence');
  await pickRange('custom');
  await sleep(200);
  await page.call(() => {
    const set = (label, v) => { const i = [...document.querySelectorAll('.modal .export-range .field')].find((x) => x.querySelector('span')?.textContent === label).querySelector('input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('From', '1'); set('To', '00:00:02:15');
  });
  await sleep(200);
  await shot('export-custom.png');
  j = await exportNow();
  ok(j?.frames === 45 && j.sequenceId === 's2', `a custom range on any sequence: 1 s → 2.5 s of "Other" = ${j?.frames} frames (45 expected)`);

  console.log('Alt-drag duplicates');
  const [x0, y0] = await at('v1', 3.5);
  const [x1, y1] = await at('v1', 7); // the same track: on a small screen (GitHub's Macs) only one track may be in view
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await mouse('mousePressed', x0, y0, { modifiers: 1 });
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { modifiers: 1 }); await sleep(30); }
  await mouse('mouseReleased', x1, y1, { modifiers: 1 });
  await sleep(400);
  let cs = await clips();
  const orig = cs.find((c) => c.id === 'c_b');
  const copy = cs.find((c) => c.id !== 'c_b' && c.color === '#40a0e0');
  ok(orig && orig.start === 3 && orig.track === 'v1', `the clip stays where it was (${orig?.track} ${orig?.start} s)`);
  ok(copy && copy.track === 'v1' && Math.abs(copy.start - 6.5) < 0.05 && copy.duration === 2, `a copy is dropped where the mouse let go (${copy ? `${copy.track} ${copy.start} s` : 'none'})`);
  const selNow = await page.call(() => window.__jimmy.activeTab().ui.get().selection);
  ok(copy && selNow.length === 1 && selNow[0] === copy.id, 'the copy is selected after the drop, as in Premiere');
  // a plain drag still moves
  const [m0x, m0y] = await at('v1', copy.start + 1);
  const [m1x] = await at('v1', copy.start + 2);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m0x, y: m0y });
  await mouse('mousePressed', m0x, m0y);
  for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', m0x + ((m1x - m0x) * i) / 5, m0y); await sleep(30); }
  await mouse('mouseReleased', m1x, m0y);
  await sleep(300);
  cs = await clips();
  ok(cs.filter((c) => c.color === '#40a0e0').length === 2 && Math.abs(cs.find((c) => c.id === copy.id).start - (copy.start + 1)) < 0.05, 'without Alt a drag only moves (no new copy)');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(300);
  ok((await clips()).filter((c) => c.color === '#40a0e0').length === 1, 'Undo takes the copy away again');

  console.log('Position is one property');
  await page.call(() => { const t = window.__jimmy.activeTab(); t.select(['c_a']); window.__jimmy.activeTab().engine.seek(0.5); t.ui.set({ graph: true, graphProps: null, graphSeparate: false }); });
  await sleep(600);
  const rows = await page.call(() => [...document.querySelectorAll('.prop-row .prop-label')].map((l) => l.textContent.trim()));
  ok(rows.includes('Position') && !rows.includes('Position X') && !rows.includes('Position Y'), `the Inspector has one Position row (${rows.filter((r) => /Position/.test(r)).join(', ')})`);
  const fields = await page.call(() => { const row = [...document.querySelectorAll('.prop-row')].find((r) => r.querySelector('.prop-label')?.textContent.trim() === 'Position'); return row ? { n: row.querySelectorAll('.prop-value .numfield').length, watches: row.querySelectorAll('.kf-toggle').length } : null; });
  ok(fields?.n === 2 && fields.watches === 1, `…with an X and a Y field and one stopwatch (${JSON.stringify(fields)})`);
  const graphProps = () => page.call(() => [...document.querySelectorAll('.graph-prop .graph-prop-name')].map((n) => n.textContent.trim()));
  let gp = await graphProps();
  ok(gp.includes('Position') && !gp.includes('Position X'), `the graph editor shows one Position curve (${gp.join(', ')})`);
  await shot('graph-position.png');
  await page.call(() => [...document.querySelectorAll('.graph-prop.is-sep input')][0]?.click());
  await sleep(300);
  gp = await graphProps();
  ok(gp.includes('Position X') && gp.includes('Position Y'), `"Separate dimensions" shows X and Y as two (${gp.join(', ')})`);
  await page.call(() => [...document.querySelectorAll('.graph-prop.is-sep input')][0]?.click());
  await sleep(300);

  console.log('Presets');
  // select every keyframe (Ctrl+A in the graph), then a preset
  await page.call(() => document.querySelector('.graph-win').focus());
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await sleep(200);
  const opts = await page.call(() => { const s = document.querySelector('.graph-presets'); return s ? { disabled: s.disabled, n: s.querySelectorAll('option').length - 1 } : null; });
  ok(opts && !opts.disabled && opts.n >= 25, `with keyframes selected, the presets menu offers ${opts?.n} curves`);
  await page.call(() => { const s = document.querySelector('.graph-presets'); s.value = 'Expo out'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(400);
  const after = await page.call(() => { const c = window.__jimmy.activeTab().seq.clips.find((x) => x.id === 'c_a'); return c.keyframes; });
  const xo = after.x[0].out, yo = after.y[0].out;
  ok(xo && yo && Math.abs(xo.influence - yo.influence) < 1e-6 && Math.abs(xo.speed / 300 - yo.speed / 400) < 1e-6 && xo.speed > 300,
    `Expo out on Position: X and Y get the same fast-start ease (X ${xo?.speed?.toFixed(0)} px/s, Y ${yo?.speed?.toFixed(0)} px/s, influence ${xo?.influence?.toFixed(2)})`);
  ok(after.opacity[0].out && !after.position, 'the other selected properties get it too; nothing extra is saved in the project');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `step93: ${failed} failed` : 'step93: all checks passed');
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
