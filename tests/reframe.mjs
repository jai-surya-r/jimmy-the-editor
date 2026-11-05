// Reframe with Claude: the sequence menus offer it; the window picks a frame (9:16 by default for a landscape
// sequence), what to keep in frame and how; the brief Claude gets has the sizes, the fill maths, the keep list, and
// the checks. Send isn't pressed: it would start a real Claude chat.
//   JIMMY_APP=electron node tests/reframe.mjs [folder for a screenshot]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openGolden, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9369;
const SHOTS = process.argv[2];

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await openGolden();
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.bin-row')).catch(() => false)) break; await sleep(200); }
  await sleep(400);

  // the bin's sequence menu has it
  await page.call(() => { const r = document.querySelector('.bin-row[data-bin="s_cuts"]'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 })); });
  await sleep(200);
  ok(await page.call(() => [...document.querySelectorAll('.menu-item')].some((m) => /Reframe with Claude/.test(m.textContent))), 'the sequence menu offers Reframe with Claude…');
  await page.call(() => [...document.querySelectorAll('.menu-item')].find((m) => /Reframe with Claude/.test(m.textContent)).click());
  await sleep(300);
  const d = await page.call(() => { const m = document.querySelector('.modal'); return { title: m?.querySelector('h2')?.textContent, frame: m?.querySelector('select')?.value, name: [...m.querySelectorAll('.field')].find((f) => /New sequence name/.test(f.textContent))?.querySelector('input').value, keep: [...m.querySelectorAll('.toggle')].filter((t) => t.querySelector('input')?.checked).length, send: !m.querySelector('.modal-foot .btn-claude')?.disabled }; });
  ok(d.title === 'Reframe with Claude' && d.frame === '1080x1920', `it opens on 9:16 for a landscape sequence (${d.frame})`);
  ok(d.name === '01 Cuts, speed, sources 9x16', `with a name for the copy (${d.name})`);
  ok(d.send, 'Send to Claude is ready');
  if (SHOTS) { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, 'reframe.png'), Buffer.from(data, 'base64')); }
  // its own size can't be sent
  await page.call(() => { const s = document.querySelector('.modal select'); s.value = '1920x1080'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(150);
  ok(await page.call(() => document.querySelector('.modal-foot .btn-claude')?.disabled && /the sequence's own size/.test(document.querySelector('.modal').textContent)), 'its own size is refused, and it says why');
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Cancel').click());

  // the brief
  const brief = await page.call(async () => {
    const { reframePrompt } = await import('/js/ui/reframe.js');
    const seq = window.__jimmy.activeTab().doc.sequences.find((s) => s.id === 's_cuts');
    return [reframePrompt(seq, { width: 1080, height: 1920, name: 'Cuts 9x16', keep: ['faces', 'product'], extra: 'the logo on the mug', follow: true, zoom: false, relayout: true }),
      reframePrompt(seq, { width: 1080, height: 1350, name: 'Cuts 4x5', keep: [], follow: false, zoom: true, relayout: false })];
  });
  const [a, b] = brief;
  ok(/Reframe the sequence "01 Cuts, speed, sources" \(s_cuts, 1920×1080\) for 1080×1920/.test(a) && /Leave "01 Cuts, speed, sources" exactly as it is/.test(a) && /named "Cuts 9x16"/.test(a) && /vedit link <new sequence id>/.test(a), 'the brief: sizes, a copy with its name, the original untouched, link the copy');
  ok(/scale ≥ max\(1080\/w, 1920\/h\)/.test(a) && /\|x\| ≤ \(w·scale − 1080\)\/2/.test(a), 'the fill maths with no black edges, for this size');
  ok(/People's faces, with headroom/.test(a) && /Products and the main object/.test(a) && /the logo on the mug/.test(a) && !/Hands and gestures/.test(a), 'only what was ticked, plus the typed note');
  ok(/follow it with x \(and y\) keyframes/.test(a) && /Don't zoom in beyond/.test(a) && /safe area/.test(a), 'follow / zoom / refit text as chosen');
  ok(/one fixed framing per clip/.test(b) && /you may scale in further/.test(b) && /Leave text clips and graphics as they are/.test(b) && /the main subject of the shot/.test(b), 'the other choices give the other instructions');
  ok(/vedit frame\` at every cut/.test(a) && /shots that needed a judgement call/.test(a), 'it asks Claude to check every cut and report the judgement calls');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `reframe: ${failed} failed` : 'reframe: all checks passed');
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
