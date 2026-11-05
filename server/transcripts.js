// Saved transcripts. Claude transcribes footage in its chats (Jimmy has no transcriber of its own); each transcript
// is kept here so no chat has to make it again: `vedit transcript <clip>` reads it, `vedit transcript save` keeps a
// new one (JSON, SRT or VTT). They live in the cache (Settings › Cache folder, else the app's data folder), one file
// per footage file, keyed by the file's size and the first and last megabyte of its contents, so the same footage
// finds its transcript from any project, any path, and a copy on another drive.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, sha1, writeFileAtomic } from './util.js';
import { cacheRoot } from './cachedir.js';
import { parseSubtitles } from '../public/js/core/srt.js';

const CHUNK = 1 << 20;
export const transcriptsDir = () => path.join(cacheRoot() || path.join(DATA_DIR, 'cache'), 'transcripts');

const keys = new Map(); // `${abs}|${size}|${mtime}` -> key
export async function fileKey(abs) {
  const st = await fsp.stat(abs);
  const memo = `${abs}|${st.size}|${st.mtimeMs}`;
  if (keys.has(memo)) return keys.get(memo);
  const fh = await fsp.open(abs, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, st.size));
    await fh.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(CHUNK, Math.max(0, st.size - head.length)));
    if (tail.length) await fh.read(tail, 0, tail.length, st.size - tail.length);
    const key = sha1(Buffer.concat([Buffer.from(String(st.size)), head, tail])).slice(0, 24);
    keys.set(memo, key);
    return key;
  } finally { await fh.close(); }
}
const fileFor = (key) => path.join(transcriptsDir(), `${key}.json`);

const summary = (t, file) => ({ file, language: t.language || null, segments: t.segments.length, duration: t.segments.length ? t.segments[t.segments.length - 1].end : 0, words: t.segments.reduce((n, s) => n + (s.words?.length || 0), 0) || null, savedAt: t.savedAt, source: t.source || null, by: t.by || null });

// { exists, key, file, summary?, transcript? }
export async function getTranscript(abs, { full = false } = {}) {
  const key = await fileKey(abs);
  const file = fileFor(key);
  let t;
  try { t = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return { exists: false, key, file }; }
  return { exists: true, key, file, summary: summary(t, file), ...(full ? { transcript: t } : {}) };
}

// The transcript in Jimmy's form: segments of { start, end, text } in seconds (words: [{ start, end, word }] kept when
// given), from Jimmy/Whisper-style JSON ({ segments } or a bare array) or SRT/VTT text.
export function normalizeTranscript(input) {
  let segs = null, language = null;
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.startsWith('{') || s.startsWith('[')) return normalizeTranscript(JSON.parse(s));
    segs = parseSubtitles(s).map((c) => ({ start: c.start, end: c.end, text: c.text }));
  } else if (Array.isArray(input)) segs = input;
  else if (input && typeof input === 'object') { segs = input.segments || input.chunks || null; language = input.language || null; }
  if (!Array.isArray(segs)) throw Object.assign(new Error('Not a transcript: give JSON with "segments" [{ start, end, text }], or an SRT/VTT file'), { status: 400 });
  const num = (v) => (Array.isArray(v) ? Number(v[0]) : Number(v));
  const out = segs.map((s) => {
    const start = num(s.start ?? s.timestamp?.[0] ?? s.from);
    const end = Number(s.end ?? s.timestamp?.[1] ?? s.to ?? start);
    const words = Array.isArray(s.words) ? s.words.map((w) => ({ start: Number(w.start), end: Number(w.end), word: String(w.word ?? w.text ?? '').trim() })).filter((w) => Number.isFinite(w.start) && w.word) : null;
    return { start, end, text: String(s.text ?? '').trim(), ...(words?.length ? { words } : {}) };
  }).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
  if (!out.length) throw Object.assign(new Error('The transcript has no timed lines'), { status: 400 });
  return { segments: out.sort((a, b) => a.start - b.start), language };
}

export async function saveTranscript(abs, input, { by = null } = {}) {
  const key = await fileKey(abs);
  const t = normalizeTranscript(input);
  const doc = { format: 'jimmy-transcript/1', source: path.basename(abs), savedAt: new Date().toISOString(), by, language: t.language, segments: t.segments };
  await fsp.mkdir(transcriptsDir(), { recursive: true });
  await writeFileAtomic(fileFor(key), JSON.stringify(doc));
  return { key, file: fileFor(key), summary: summary(doc, fileFor(key)) };
}

export const transcriptExists = async (abs) => { try { return fs.existsSync(fileFor(await fileKey(abs))); } catch { return false; } };
