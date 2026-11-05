// The same project on two paths (the NAS and a copy on the laptop): its chats and their sequence links reach the path
// that is open, the originals stay as they were, and a chat of a different project is left alone. A scratch account
// folder; no Claude is started.
//   node tests/chat-paths.mjs
import fs from 'node:fs';
import path from 'node:path';
import { WORK, startServer, api } from './lib/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

const BASE = path.join(WORK, 'chat-paths');
fs.rmSync(BASE, { recursive: true, force: true });
const PROFILE = path.join(BASE, 'account');
const NAME = 'Same Project';
const NAS = path.join(BASE, 'nas', NAME), LAPTOP = path.join(BASE, 'laptop', NAME), OTHER = path.join(BASE, 'nas', 'Not Same Project');
const hist = (dir) => path.join(PROFILE, 'projects', path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [NOTED, LINKED, PLAIN, GROWS, MINE, DECOY] = [1, 2, 3, 4, 5, 6].map(id);
const line = (cwd, text) => `${JSON.stringify({ type: 'user', cwd, sessionId: 'x', message: { role: 'user', content: text } })}\n`;
const chat = (dir, sid, text, at) => {
  const f = path.join(hist(dir), `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, line(dir, text));
  if (at) fs.utimesSync(f, new Date(at), new Date(at));
  return f;
};
const project = (dir) => {
  fs.mkdirSync(path.join(dir, '.claude-edit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ format: 'claude-edit/1', name: NAME, settings: {}, folders: [], media: [],
    sequences: ['s1', 's2', 's3'].map((s) => ({ id: s, name: s, width: 1920, height: 1080, fps: 25, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }], clips: [] })) }));
};
project(NAS); project(LAPTOP);
const old = Date.now() - 3600000;
chat(NAS, NOTED, '<jimmy-sequence id="s1" name="s1"></jimmy-sequence>\nCut the intro', old);
chat(NAS, LINKED, 'A chat linked to s2 on the NAS', old);
chat(NAS, PLAIN, 'Just a chat', old);
const growing = chat(NAS, GROWS, 'Grows later', old);
const original = chat(NAS, MINE, 'Started on the NAS', old);
chat(OTHER, DECOY, 'Another project', old);
fs.writeFileSync(path.join(NAS, '.claude-edit', 'chat-links.json'), JSON.stringify({ s2: LINKED }));
// this chat was already brought here and then continued here
const here = chat(LAPTOP, MINE, 'Started on the NAS, continued on the laptop, much longer than the original', Date.now());
const before = fs.readFileSync(original);

const srv = await startServer({ env: { CLAUDE_CONFIG_DIR: PROFILE } });
try {
  const { id: P } = await api('POST', '/api/projects/open', { path: LAPTOP });
  await api('GET', `/api/p/${P}`);
  const ids = async () => (await api('GET', `/api/p/${P}/chats`)).chats.map((c) => c.id);
  const list = await ids();
  ok([NOTED, LINKED, PLAIN, GROWS].every((c) => list.includes(c)), `the NAS's chats are listed on the laptop path (${list.length})`);
  ok(!list.includes(DECOY), 'a chat of another project is not brought in');
  const titled = (await api('GET', `/api/p/${P}/chats`)).chats.find((c) => c.id === PLAIN);
  ok(/Just a chat/.test(titled?.title || ''), `it keeps its title (${titled?.title})`);
  ok(Math.abs(titled.updatedAt - old) < 2000, 'and its date, so the list stays in order');
  let links = {};
  for (let i = 0; i < 40; i++) { links = (await api('GET', `/api/p/${P}/chat-links`)).links; if (links.s1 && links.s2) break; await sleep(150); }
  ok(links.s1 === NOTED, 'a linked chat is linked here too (from the note in the chat)');
  ok(links.s2 === LINKED, "a linked chat with no note yet is linked too (from the other path's links)");
  ok(!links.s3, 'a sequence with no chat stays without one');
  ok(fs.readFileSync(original).equals(before), 'the originals are not changed');
  ok(fs.readFileSync(here, 'utf8').includes('continued on the laptop'), 'a chat continued here is not overwritten');
  ok(fs.existsSync(path.join(hist(LAPTOP), `${NOTED}.jsonl`)), 'the copy sits under this path, where --resume looks');
  fs.appendFileSync(growing, line(NAS, 'One more message'));
  const f = path.join(hist(LAPTOP), `${GROWS}.jsonl`);
  ok(!fs.readFileSync(f, 'utf8').includes('One more'), '(before: the copy has the old end)');
} finally { await srv.stop(); }
const srv2 = await startServer({ env: { CLAUDE_CONFIG_DIR: PROFILE } });
try {
  const { id: P } = await api('POST', '/api/projects/open', { path: LAPTOP });
  await api('GET', `/api/p/${P}/chats`);
  ok(fs.readFileSync(path.join(hist(LAPTOP), `${GROWS}.jsonl`), 'utf8').includes('One more'), 'a chat that grew on the other path is brought up to date');
  ok(fs.readFileSync(here, 'utf8').includes('continued on the laptop'), 'and the continued one still stands');
} finally { await srv2.stop(); fs.rmSync(BASE, { recursive: true, force: true }); }
console.log(failed ? `chat-paths: ${failed} failed` : 'chat-paths: all checks passed');
process.exit(failed ? 1 : 0);
