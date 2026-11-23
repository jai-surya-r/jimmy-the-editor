// Which chat works on which sequence: sequence id -> Claude chat (session) id, one chat per sequence and one
// sequence per chat on each computer. Kept in the project's state folder, so the links survive restarts. A linked
// chat gets that sequence's messages and review comments, and keeps running in the background while another is shown.
//
// A shared project (a synced folder, a copy on a friend's computer) carries the links of every computer that
// worked on it, but Claude's chats stay on the computer they were made on. So the file can hold several chats per
// sequence ({ seqId: "id" } or { seqId: ["id", "id"] }), and each computer only uses the ones it has: a sequence
// linked only to chats from elsewhere is "fresh" here (freshSequences): its next message starts a new chat for it.
// Writing keeps the other computers' entries.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFileAtomic } from './util.js';
import { projectChats, historyDir, adoptChats, localChatIds } from './chathistory.js';
import { layoutFor } from './layout.js';

const file = (h) => path.join(h.layout.files, 'chat-links.json');
// sequences unlinked by hand (sequence id -> { at, chat }), so healChatLinks doesn't link them again
const unlinksFile = (h) => path.join(h.layout.files, 'chat-unlinks.json');
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' ? [v] : []);

// The links on disk; null when the file is there but can't be read right now (being written, a busy NAS):
// a passing failure must never be taken for "no links" and then written back over them.
function readLinks(h) {
  try {
    const v = JSON.parse(fs.readFileSync(file(h), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (err) { return err.code === 'ENOENT' ? {} : null; }
}
function readUnlinks(h) {
  try { return JSON.parse(fs.readFileSync(unlinksFile(h), 'utf8')) || {}; } catch { return {}; }
}

// the chats this computer has (looked up at most every few seconds) and the ones linked here since the start
function mine(h) {
  if (!h._mine) h._mine = new Set();
  if (!h._known || Date.now() - h._known.at > 5000) h._known = { at: Date.now(), ids: localChatIds(h.dir) };
  return (id) => h._mine.has(id) || h._known.ids.has(id);
}

function raw(h) {
  if (!h._chatLinks) {
    const links = readLinks(h);
    if (!links) return null; // asked again next time
    h._chatLinks = links;
    h._unlinks = readUnlinks(h);
  }
  return h._chatLinks;
}

// this computer's links: { seqId: sessionId }
export function chatLinks(h) {
  const all = raw(h);
  if (!all) return {};
  const here = mine(h);
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    const id = ids(v).find(here);
    if (id) out[k] = id;
  }
  return out;
}

// sequences linked only to chats made on other computers (and not unlinked by hand): each gets a new chat here
export function freshSequences(h) {
  const all = raw(h);
  if (!all || !h.doc) return [];
  const here = mine(h);
  const un = h._unlinks || {};
  return h.doc.sequences.map((s) => s.id).filter((k) => ids(all[k]).length && !ids(all[k]).some(here) && !un[k]);
}

export function linkedSequence(h, sessionId) {
  if (!sessionId) return null;
  const links = chatLinks(h);
  const seqId = Object.keys(links).find((k) => links[k] === sessionId);
  return (seqId && h.doc?.sequences.find((s) => s.id === seqId)) || null;
}

async function save(h, links, unlinked = []) {
  const out = {};
  for (const [k, v] of Object.entries(links)) {
    const list = [...new Set(ids(v))];
    if (list.length) out[k] = list.length === 1 ? list[0] : list; // one chat: the plain form older versions read
  }
  h._chatLinks = out;
  await fs.promises.mkdir(h.layout.files, { recursive: true });
  await writeFileAtomic(file(h), JSON.stringify(out, null, 1));
  const un = (await readJson(unlinksFile(h), {})) || {};
  const before = JSON.stringify(un);
  for (const k of Object.keys(chatLinks(h))) delete un[k];
  for (const [k, chat] of unlinked) un[k] = { at: Date.now(), chat };
  h._unlinks = un;
  if (JSON.stringify(un) !== before) await writeFileAtomic(unlinksFile(h), JSON.stringify(un, null, 1));
}

// link a sequence to a chat (sessionId null: unlink the sequence); a chat linked elsewhere moves here. Only this
// computer's chats change: the other computers' links stay in the file.
export async function setChatLink(h, seqId, sessionId) {
  const current = raw(h);
  if (!current) throw new Error("The project's chat links can't be read right now: try again in a moment");
  const here = mine(h);
  const links = {};
  const unlinked = [];
  for (const [k, v] of Object.entries(current)) {
    const keep = [];
    for (const id of ids(v)) {
      const drop = (k === seqId && here(id)) || (sessionId && id === sessionId);
      if (!drop) keep.push(id);
      else if (k !== seqId || !sessionId) unlinked.push([k, id]);
    }
    if (keep.length) links[k] = keep;
  }
  if (seqId && !sessionId && !unlinked.some(([k]) => k === seqId)) unlinked.push([seqId, null]);
  if (seqId && sessionId) {
    h._mine = h._mine || new Set();
    h._mine.add(sessionId);
    links[seqId] = [...ids(links[seqId]), sessionId];
  }
  await save(h, links, unlinked);
  return chatLinks(h);
}

// a resumed chat that came back with a new session id keeps its sequence
export async function moveChatLink(h, fromId, toId) {
  const seq = linkedSequence(h, fromId);
  return seq ? setChatLink(h, seq.id, toId) : null;
}

// Links that went missing (an older version could write over them when the file couldn't be read; a project
// folder copied from elsewhere brings its own file) come back: every message to a linked chat starts with a
// <jimmy-sequence id="…"> note, so a sequence without a chat here gets the chat whose latest note names it. A sequence
// unlinked by hand is left alone unless a chat used after that names it. The same project on another path (see
// adoptChats) lends its links first: a chat linked there but never written to has no note. Returns true when links were added.
export async function healChatLinks(h) {
  const all = raw(h);
  if (!h.doc || !all) return false; // the file can't be read right now
  const links = chatLinks(h);
  const open = new Set(h.doc.sequences.map((s) => s.id).filter((id) => !links[id]));
  if (!open.size) return false;
  const used = new Set(Object.values(links));
  const unlinks = (await readJson(unlinksFile(h), {})) || {};
  const found = {};
  const others = await adoptChats(h.dir); // first: the chats it brings in count
  const known = new Set(projectChats(h.dir).map((c) => c.id));
  for (const other of others) {
    const theirs = (await readJson(path.join(layoutFor(other).files, 'chat-links.json'), {}).catch(() => null)) || {};
    for (const [seqId, v] of Object.entries(theirs)) {
      const chat = ids(v).find((id) => known.has(id) && !used.has(id));
      if (!chat || !open.has(seqId) || found[seqId] || unlinks[seqId]) continue;
      found[seqId] = chat;
      used.add(chat);
    }
  }
  for (const c of projectChats(h.dir).slice(0, 80)) { // newest first
    if (used.has(c.id)) continue;
    const seqId = await lastNote(path.join(historyDir(c.dir, h.dir), `${c.id}.jsonl`));
    // unlinked by hand: not that chat again (it keeps its old note when used after), nor one older than the unlink
    const un = unlinks[seqId];
    if (!seqId || !open.has(seqId) || found[seqId] || (un && (un.chat === c.id || c.updatedAt <= un.at))) continue;
    found[seqId] = c.id;
    used.add(c.id);
  }
  if (!Object.keys(found).length || h._chatLinks !== all) return false;
  h._mine = h._mine || new Set();
  const next = { ...all };
  for (const [k, id] of Object.entries(found)) { h._mine.add(id); next[k] = [...ids(all[k]), id]; }
  await save(h, next);
  console.log(`[chat links] ${h.doc.name}: linked again from the chats' sequence notes: ${Object.keys(found).length}`);
  return true;
}

// the sequence id in the last <jimmy-sequence> note of a chat file (read through in 1 MB pieces, as chats run to
// tens of MB; remembered per file version)
const NOTE_RE = /jimmy-sequence id=\\"([\w-]+)\\"/g;
const notes = new Map(); // file -> { size, mtimeMs, seqId }
async function lastNote(f) {
  try {
    const st = await fs.promises.stat(f);
    const hit = notes.get(f);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.seqId;
    let seqId = null, carry = '';
    for await (const chunk of fs.createReadStream(f, { encoding: 'utf8', highWaterMark: 1024 * 1024 })) {
      const text = carry + chunk;
      for (const m of text.matchAll(NOTE_RE)) seqId = m[1];
      carry = text.slice(-120); // a note cut in two by the piece boundary is found in the next one
    }
    notes.set(f, { size: st.size, mtimeMs: st.mtimeMs, seqId });
    return seqId;
  } catch { return null; }
}
