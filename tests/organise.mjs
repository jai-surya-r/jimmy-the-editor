// Organise the bin: media go into folders by what they are, from the files themselves (folders and names, type,
// motion graphics) and, where Claude has added them, its "role" and "tags" (which also make sub-folders and are found
// by search). Only items not in a folder yet move by default; one Undo puts it all back. The files need not exist.
//   JIMMY_APP=electron node tests/organise.mjs [folder for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9363;
const SHOTS = process.argv[2];
const DIR = path.join(WORK, 'organise');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const media = [
  ['m_a', '4_Footage/A_Roll/Day 1/C0001.MP4', 'video', 'a-roll'],
  ['m_b', '4_Footage/B_Roll/C0050.MP4', 'video', 'b-roll'],
  ['m_s', 'captures/Screen Recording 2026-11-03.mov', 'video', 'screen'],
  ['m_f', 'D:/Shoot/GX010123.MP4', 'video', 'footage'],
  ['m_mu', '2_Audio/2_Music/track01.wav', 'audio', 'music'],
  ['m_fx', 'sounds/sfx/whoosh_03.wav', 'audio', 'sfx'],
  ['m_vo', 'audio/VO take 2.wav', 'audio', 'voiceover'],
  ['m_au', 'audio/room tone.wav', 'audio', 'audio'],
  ['m_lo', 'brand/logo.png', 'image', 'graphics'],
  ['m_ph', 'photos/IMG_2231.jpg', 'image', 'stills'],
];
const doc = {
  format: 'claude-edit/1', name: 'Organise', settings: { originalNames: 1 },
  folders: [{ id: 'f_mine', name: 'Client picks', parent: null }],
  media: [
    ...media.map(([id, p, type]) => ({ id, path: p, type })),
    { id: 'm_mg', name: 'Lower third', path: 'motion/renders/lt.mov', type: 'video', motion: { src: 'motion/lt.html', params: {}, duration: 4, width: 1920, height: 1080, fps: 30 } },
    { id: 'm_mine', path: '4_Footage/B_Roll/C0099.MP4', type: 'video', folder: 'f_mine' },
  ],
  sequences: [{ id: 's1', name: 'Main', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] }],
};
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(doc, null, 2));

const srv = await startServer({ env: { JIMMY_DEBUG_PORT: String(DEBUG_PORT) }, visible: true });
let page;
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  page = await connectPage();
  await page.call(() => { localStorage.removeItem('ce.tabs'); localStorage.removeItem('ce.activeTab'); location.reload(); });
  await sleep(1500);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  await page.call((pid) => { window.__jimmy.openProject(pid); }, id);
  for (let i = 0; i < 100; i++) { if (await page.call(() => !!document.querySelector('.bin-row')).catch(() => false)) break; await sleep(200); }
  await sleep(500);
  const shot = async (name) => { if (!SHOTS) return; const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };

  // ------------------------------------------------------------ what the files say
  const roles = await page.call(async () => { const { factsRole } = await import('/js/ui/organise.js'); return Object.fromEntries(window.__jimmy.activeTab().doc.media.map((m) => [m.id, factsRole(m)])); });
  for (const [mid, p, , want] of media) ok(roles[mid] === want, `${p} → ${want}${roles[mid] === want ? '' : ` (got ${roles[mid]})`}`);
  ok(roles.m_mg === 'graphics', 'a motion graphic → graphics');

  // ------------------------------------------------------------ the window and Organise
  const folderOf = () => page.call(() => { const d = window.__jimmy.activeTab().doc; const name = (id) => { const f = d.folders.find((x) => x.id === id); return f ? (f.parent ? `${name(f.parent)} / ${f.name}` : f.name) : null; }; return Object.fromEntries(d.media.map((m) => [m.id, name(m.folder)])); });
  await page.call(() => document.querySelector('.bin [title^="Organise"]').click());
  await sleep(300);
  const rows = await page.call(() => [...document.querySelectorAll('.organise-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.length === 10 && /^A-Rolls*1 item · new folder/.test(rows[0]), `the window shows the plan first (${rows.length} folders: ${rows.map((r) => r.split(' ')[0]).join(', ')})`);
  ok(await page.call(() => /Ask Claude to tag them/.test(document.querySelector('.modal-foot').textContent)), 'it offers to ask Claude to tag the media');
  await shot('organise-dialog.png');
  await page.call(() => [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === 'Organise').click());
  await sleep(400);
  let where = await folderOf();
  ok(where.m_a === 'A-Roll' && where.m_b === 'B-Roll' && where.m_mu === 'Music' && where.m_fx === 'Sound effects' && where.m_vo === 'Voice-over' && where.m_lo === 'Graphics' && where.m_mg === 'Graphics' && where.m_ph === 'Stills' && where.m_s === 'Screen recordings' && where.m_f === 'Footage',
    `Organise puts each item in its folder (${Object.entries(where).map(([k, v]) => `${k}:${v}`).join(', ')})`);
  ok(where.m_mine === 'Client picks', 'an item already in the person\'s own folder stays there');
  await shot('organise-done.png');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(400);
  where = await folderOf();
  ok(Object.entries(where).filter(([k]) => k !== 'm_mine').every(([, v]) => v === null) && (await page.call(() => window.__jimmy.activeTab().doc.folders.length)) === 1, 'one Undo puts everything back, new folders gone');

  // ------------------------------------------------------------ Claude's role and tags
  const prompt = await page.call(async () => { const { tagPrompt } = await import('/js/ui/organise.js'); return tagPrompt(window.__jimmy.activeTab().doc); });
  ok(/"role": one of a-roll, b-roll/.test(prompt) && /m_f {2}GX010123\.MP4 {2}\(video/.test(prompt) && /contact sheets/.test(prompt) && /never names, paths/.test(prompt), 'the request to Claude lists the untagged media, the roles, cheap contact sheets, and not to touch names');
  await page.call(() => window.__jimmy.activeTab().apply('Tag', (d) => {
    const f = d.media.find((m) => m.id === 'm_f'); f.role = 'b-roll'; f.tags = ['product shot', 'kitchen'];
    const s = d.media.find((m) => m.id === 'm_s'); s.role = 'b-roll'; s.tags = ['product shot'];
  }));
  await sleep(300);
  await page.call(() => document.querySelector('.bin [title^="Organise"]').click());
  await sleep(300);
  const rows2 = await page.call(() => [...document.querySelectorAll('.organise-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows2.some((r) => /^B-Roll \/ Product shot\s*2 items/.test(r)), `Claude's role wins and its first tag makes a sub-folder (${rows2.find((r) => /Product/.test(r))})`);
  ok(await page.call(() => /2 of 12 items have Claude's role and tags/.test(document.querySelector('.modal .dialog-hint').textContent)), 'it says how many items Claude has tagged');
  await page.call(() => [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === 'Organise').click());
  await sleep(400);
  where = await folderOf();
  ok(where.m_f === 'B-Roll / Product shot' && where.m_s === 'B-Roll / Product shot' && where.m_b === 'B-Roll', `tagged items go into B-Roll / Product shot, next to the other B-Roll (${where.m_f})`);
  // search finds tags
  await page.call(() => { const i = document.querySelector('.bin-search input'); i.value = 'kitchen'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  const found = await page.call(() => [...document.querySelectorAll('.bin-row .bin-name, .bin-tile-name')].map((x) => x.textContent));
  ok(found.length === 1 && found[0] === 'GX010123.MP4', `search finds media by Claude's tags (${found})`);
  await page.call(() => { document.querySelector('.bin-row[data-bin="m_f"]')?.click(); });
  await sleep(200);
  ok(await page.call(() => /Sort\s*B-Roll · product shot, kitchen/.test(document.querySelector('.bin-info')?.textContent || '')), 'the clip\'s details show its role and tags');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  page?.close();
  await srv.stop();
}
console.log(failed ? `organise: ${failed} failed` : 'organise: all checks passed');
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
