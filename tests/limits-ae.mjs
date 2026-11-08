// Usage limits, the compact offer and "convert to AE project", in the desktop app:
//   • limits: a weekly window past 75% (Claude Code's "allowed_warning") shows a short "Near limit" (the % is on its row), not
//     "limit reached"; only "rejected" says the limit is reached; the 5-hour session shows when it resets; an Ultra
//     account (or a session window without a reset) shows the week only
//   • compact: offered from 150k tokens with a cold cache, from 500k with a warm one
//   • motion graphics on the timeline: right-click › "Ask Claude: convert to AE project" for one, "…convert 2
//     graphics…" for a selection; the prompt names every graphic, its source, timing and edits, and the project's
//     After Effects folder (5_Projects/3_After Effects in a template project)
//   JIMMY_APP=electron node tests/limits-ae.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; return c; };
const DEBUG_PORT = 9367;
const DIR = path.join(WORK, 'limits-ae');
fs.rmSync(DIR, { recursive: true, force: true });
for (const d of ['1_Assets/4_Overlays', '2_Audio', '3_Exports', '4_Footage', '5_Projects/3_After Effects']) fs.mkdirSync(path.join(DIR, d), { recursive: true });
const page0 = (t) => `<!doctype html><html><head><script type="application/json" id="motion">{ "duration": 3, "params": { "title": "${t}" } }</script></head><body><div id="title" data-param="title"></div></body></html>`;
fs.writeFileSync(path.join(DIR, '1_Assets/4_Overlays/lower-third.html'), page0('Lower third'));
fs.writeFileSync(path.join(DIR, '1_Assets/4_Overlays/end-card.html'), page0('End card'));
const mo = (id, name, src) => ({ id, name, path: '', type: 'video', motion: { src, params: { title: name }, duration: 3, width: 1920, height: 1080, fps: 25 } });
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: 'Limits', settings: { originalNames: 1, nestAudio: 1 }, folders: [],
  media: [mo('m_lt', 'Lower third', '1_Assets/4_Overlays/lower-third.html'), mo('m_ec', 'End card', '1_Assets/4_Overlays/end-card.html')],
  sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 25, tracks: [{ id: 'v1', kind: 'video' }],
    clips: [{ id: 'c_lt', type: 'video', track: 'v1', media: 'm_lt', start: 2, duration: 3, in: 0 }, { id: 'c_ec', type: 'video', track: 'v1', media: 'm_ec', start: 6, duration: 2, in: 0.5 },
      { id: 'c_tx', type: 'text', track: 'v1', start: 9, duration: 2, text: 'Plain' }] }] }, null, 2));

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT), JIMMY_FAKE_AE: 'C:/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe' }, visible: true });
let page;
try {
  const { id: pid } = await api('POST', '/api/projects/open', { path: DIR });
  await api('POST', '/api/motion/stack/pause-all', { paused: true });
  page = await connectPage();
  const until = async (fn, ms = 15000, ...a) => { for (let i = 0; i < ms / 100; i++) { const v = await page.call(fn, ...a).catch(() => null); if (v) return v; await sleep(100); } return null; };
  // the panel parts, drawn with made-up reports (the same shape Claude Code sends)
  const now = Math.floor(Date.now() / 1000);
  const show = (what, props) => page.call(async (w, p) => {
    const { render } = await import('/vendor/preact.mjs').catch(() => import('preact'));
    const { html } = await import('htm/preact');
    const M = await import('/js/ui/ClaudeChat.js');
    let el = document.getElementById('__t'); if (!el) { el = document.createElement('div'); el.id = '__t'; document.body.appendChild(el); }
    render(null, el);
    render(html`<${M[w]} ...${p} />`, el);
    await new Promise((r) => setTimeout(r, 50));
    return el.innerText.replace(/\s+/g, ' ').trim();
  }, what, props);
  console.log('Limits');
  const week76 = { status: 'allowed_warning', resetsAt: now + 3 * 86400, rateLimitType: 'seven_day', utilization: 0.76, surpassedThreshold: 0.75,
    unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: now + 2 * 3600 + 15 * 60, status: 'allowed' }, seven_day: { utilization: 0.76, resetsAt: now + 3 * 86400, status: 'allowed_warning', surpassedThreshold: 0.75 } } };
  let t = await show('Limits', { limits: week76 });
  ok(!/limit reached/i.test(t) && /Near limit/.test(t) && (t.match(/76%/g) || []).length === 1, `76% of the week (Claude Code's warning) shows a short "Near limit", the percentage once: "${t}"`);
  ok(/Session.*10%.*resets in 2h 1[45]m/.test(t), 'the 5-hour session shows when it resets');
  ok(/Near limit · resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(t), `"Near limit" says the day and time it resets: "${t}"`);
  const { etaText } = { etaText: await page.call(async () => { const A = await import('/js/ui/App.js'); return [A.etaText(42), A.etaText(200), A.etaText(3900)].join('|'); }) };
  ok(etaText === '42s|3m 20s|1h 5m', `export time left in minutes and seconds, hours past an hour: ${etaText}`);
  t = await show('Limits', { limits: { ...week76, status: 'rejected', utilization: 1, unifiedWindows: { ...week76.unifiedWindows, seven_day: { utilization: 1, resetsAt: now + 86400, status: 'rejected' } } } });
  ok(/Weekly limit reached/.test(t), `a rejected report says the limit is reached: "${t}"`);
  t = await show('Limits', { limits: { ...week76, status: 'allowed', plan: 'ultra' } });
  ok(!/Session/.test(t) && /Week/.test(t), `an Ultra account shows the week only: "${t}"`);
  t = await show('Limits', { limits: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0 }, seven_day: { utilization: 0.3, resetsAt: now + 86400 } } } });
  ok(!/Session/.test(t), 'a 5-hour window with no reset time isn\'t shown');

  console.log('Compact');
  const ctx = (n, warmMin) => show('Context', { info: { context: n, lastCallAt: Date.now() - (60 - warmMin) * 60000, cacheTtl: 3600e3 }, busy: false, running: true, onCompact: null, onNew: null });
  ok(!/Compact/.test(await ctx(300000, 30)), 'warm cache, 300k tokens: no compact offer');
  ok(/Compact/.test(await ctx(520000, 30)), 'warm cache, 520k tokens: compact offered');
  ok(!/Compact/.test(await ctx(120000, -5)), 'cold cache, 120k tokens: no offer');
  ok(/Compact/.test(await ctx(160000, -5)), 'cold cache, 160k tokens: compact offered');
  await page.call(() => { document.getElementById('__t')?.remove(); return true; });

  console.log('Convert to AE project');
  const f = await api('GET', `/api/p/${pid}/ae-folder`);
  ok(f.rel === '5_Projects/3_After Effects', `the template's After Effects folder is found: ${f.rel}`);
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); return true; });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((p) => { window.__jimmy.openProject(p); return true; }, pid);
  await until(() => !!document.querySelector('[data-clip="c_lt"]'), 20000);
  // every clip in view, even on a small screen
  await page.call(() => { window.__jimmy.activeTab().ui.set({ pps: 35, scrollX: 0 }); return true; });
  await until(() => !!document.querySelector('[data-clip="c_tx"]'), 10000);
  const menuFor = async (cid, sel) => {
    await page.call((s) => { window.__jimmy.activeTab().ui.set({ selection: s }); return true; }, sel);
    const [x, y] = await page.call((c) => { const r = document.querySelector(`[data-clip="${c}"]`).getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; }, cid);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(300);
    const items = await page.call(() => [...document.querySelectorAll('.menu-item .menu-label')].map((x) => x.textContent));
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
    return items;
  };
  let items = await menuFor('c_lt', ['c_lt']);
  ok(items.includes('Ask Claude: convert to AE project'), 'one motion graphic: "Ask Claude: convert to AE project"');
  items = await menuFor('c_lt', ['c_lt', 'c_ec', 'c_tx']);
  ok(items.includes('Ask Claude: convert 2 graphics to AE project'), 'two selected (and a text clip): "…convert 2 graphics to AE project"');
  await page.call(() => { window.__jimmy.app.set((s) => ({ ...s, server: { ...s.server, afterEffects: null } })); return true; });
  items = await menuFor('c_lt', ['c_lt']);
  ok(!items.some((x) => /AE project/.test(x)), 'without After Effects on the computer the option isn\'t there');
  await page.call(() => { window.__jimmy.app.set((s) => ({ ...s, server: { ...s.server, afterEffects: 'x' } })); return true; });
  items = await menuFor('c_tx', ['c_tx']);
  ok(!items.some((x) => /AE project/.test(x)), 'a clip that isn\'t a motion graphic doesn\'t offer it');
  const prompt = await page.call(async () => { const A = await import('/js/ui/aeconvert.js'); const tab = window.__jimmy.activeTab(); return A.aePrompt(tab, A.motionClips(tab, new Set(['c_lt', 'c_ec', 'c_tx'])), '5_Projects/3_After Effects', 'C:/Adobe/AfterFX.exe'); });
  ok(/1\. "Lower third" — media id m_lt, source 1_Assets\/4_Overlays\/lower-third\.html; 1920×1080, 25 fps, 3 s long; on the timeline at 0 s/.test(prompt)
    && /2\. "End card".*at 4 s from the first selected clip.*2 s used starting 0\.5 s into the graphic/.test(prompt), 'the prompt lists each graphic with its source, size, fps and timing');
  ok(/5_Projects\/3_After Effects\/Main motion graphics\.jsx/.test(prompt) && /app\.project\.save/.test(prompt) && prompt.includes('"C:/Adobe/AfterFX.exe" -r') && /saveFrameToPng/.test(prompt) && /Don't render the video/.test(prompt) && /put the render on the timeline/.test(prompt) && /main composition/.test(prompt),
    'and says where to save, how to build and run it, to check frames without rendering, and that the render can go back on the timeline later');
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `\nlimits-ae: ${failed} failed` : '\nlimits-ae: all checks passed');
process.exit(failed ? 1 : 0);

async function connectPage() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`) && !/render\.html|motion/.test(t.url)); } catch { /* not up yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the editor window did not show up on the DevTools port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const msg = JSON.parse(e.data); const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++seq; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const call = async (fn, ...a) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await send('Page.bringToFront').catch(() => {});
  return { send, call, close: () => ws.close() };
}
