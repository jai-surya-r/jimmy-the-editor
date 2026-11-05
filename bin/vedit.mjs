#!/usr/bin/env node
// vedit — command-line companion for Claude (and humans) working on a Jimmy project.
// Run inside a project folder (or any subfolder). Most commands talk to the running editor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { normalizeProject, normalizeReviews, sequenceDuration, timecode, videoTracks, audioTracks, trackLabel, clipEnd } = await import(pathToFileURL(path.join(APP_DIR, 'public/js/core/model.js')).href);

const { layoutFor } = await import(pathToFileURL(path.join(APP_DIR, 'server/layout.js')).href);
const { guideText } = await import(pathToFileURL(path.join(APP_DIR, 'server/claudemd.js')).href);

const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const v = eq < 0 ? undefined : a.slice(eq + 1);
    if (v !== undefined) opts[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !['open', 'all', 'draft', 'final', 'copy', 'resolve', 'frames', 'no-version', 'full', 'inout', 'place', 'force', 'starter', 'replace', 'no-wait', 'none', 'cbr', 'mov'].includes(k)) opts[k] = argv[++i];
    else opts[k] = true;
  } else pos.push(a);
}

const f2 = (n) => (Number.isFinite(n) ? (Math.round(n * 1000) / 1000).toString() : '?');
const die = (msg) => { console.error(`vedit: ${msg}`); process.exit(1); };

function findProjectDir(start) {
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, 'project.json'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
// Where a running Jimmy is: CLAUDE_EDIT_URL (set for the Claude sessions Jimmy starts), else the server.json a
// running Jimmy keeps in its data folder (the desktop app's, then this folder's data/), else the port in config.json.
function dataDirs() {
  const home = os.homedir();
  const appData = process.platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return [process.env.JIMMY_DATA_DIR, path.join(appData, 'Jimmy - The Editor'), path.join(APP_DIR, 'data')].filter(Boolean);
}
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function serverUrl() {
  if (process.env.CLAUDE_EDIT_URL) return process.env.CLAUDE_EDIT_URL.replace(/\/$/, '');
  for (const d of dataDirs()) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(d, 'server.json'), 'utf8'));
      if (s.port && s.pid && isRunning(s.pid)) return `http://127.0.0.1:${s.port}`;
    } catch { /* none here */ }
  }
  let port = 4377;
  try { port = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'config.json'), 'utf8')).port || port; } catch { /* default */ }
  return `http://127.0.0.1:${port}`;
}
const BASE = serverUrl();
const dir = findProjectDir(opts.project || process.cwd());

async function call(method, url, body) {
  let res;
  try {
    res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error(`the Jimmy app isn't running (${BASE}). Start Jimmy first (the Jimmy app, or "npm start" in ${APP_DIR}).`), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return { status: res.status, ...data };
}
let pidCache = null;
async function projectId() {
  if (pidCache) return pidCache;
  if (!dir) die('no project.json found in this folder or its parents');
  const r = await call('POST', '/api/projects/open', { path: dir });
  pidCache = r.id;
  return pidCache;
}
function readLocal(file) {
  const p = path.join(dir, file);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
async function loadProject() {
  try {
    const r = await call('GET', `/api/p/${await projectId()}`);
    return { doc: r.doc, reviews: r.reviews, rev: r.rev, reviewsRev: r.reviewsRev, warnings: r.warnings, error: r.error, live: true };
  } catch (err) {
    if (!err.offline) throw err; // editor not running: read the files directly
  }
  const { project, warnings } = normalizeProject(readLocal('project.json'));
  let reviews = null;
  try { reviews = normalizeReviews(readLocal('reviews.json')); } catch { /* none */ }
  return { doc: project, reviews, warnings, live: false };
}
function pickSeq(doc, id) {
  if (!id) return null;
  return doc.sequences.find((s) => s.id === id || s.name.toLowerCase() === String(id).toLowerCase()) || die(`no sequence "${id}"`);
}
function focus() {
  try { return JSON.parse(fs.readFileSync(path.join(layoutFor(dir).files || layoutFor(dir).state, 'ui.json'), 'utf8')); } catch { return null; }
}
// Run from a Jimmy chat: the sequence that chat is linked to ({ id, name } or null). Commands default to it.
const CHAT_KEY = process.env.CLAUDE_EDIT_CHAT || '';
let chatSeqCache;
async function chatSequence() {
  if (chatSeqCache !== undefined) return chatSeqCache;
  chatSeqCache = null;
  if (CHAT_KEY) {
    try {
      const r = await call('GET', `/api/chat-self?key=${encodeURIComponent(CHAT_KEY)}`);
      // only for this project (a chat could run vedit in another project's folder)
      if (r.sequence && r.chat?.dir && dir && path.resolve(r.chat.dir).toLowerCase() === path.resolve(dir).toLowerCase()) chatSeqCache = r.sequence;
    } catch { /* editor not running */ }
  }
  return chatSeqCache;
}
// --seq if given, else this chat's sequence (if it still exists), else null
async function seqOption(doc) {
  if (opts.seq) return pickSeq(doc, opts.seq);
  if (opts.all) return null;
  const mine = await chatSequence();
  return (mine && doc.sequences.find((s) => s.id === mine.id)) || null;
}

// ------------------------------------------------------------------ commands

// Frames rendered for Claude to look at are check-sized: every image stays in the conversation and is
// re-read on each later step, so full resolution is only used when asked for (--full or --scale).
const CHECK_SIDE = 960;
const frameSize = () => (opts.scale ? { scale: parseFloat(opts.scale) } : opts.full ? { scale: 1 } : { maxSide: CHECK_SIDE });

const commands = {
  async status() {
    if (!dir) die('no project.json found in this folder or its parents');
    let doc, warnings, liveErr;
    try {
      const p = await loadProject();
      ({ doc, warnings } = p);
      liveErr = p.error;
    } catch (e) { die(e.message); }
    const media = Object.fromEntries(doc.media.map((m) => [m.id, m]));
    const fo = focus();
    const mine = await seqOption(doc);
    console.log(`Project: ${doc.name}  (${dir})`);
    if (liveErr) console.log(`!! project.json error: ${liveErr}`);
    if (mine && !opts.seq) console.log(`This chat works on sequence "${mine.name}" (${mine.id}). Other sequences: ${doc.sequences.filter((s) => s !== mine).map((s) => `"${s.name}" (${s.id})`).join(', ') || 'none'} — \`vedit status --all\` shows them.`);
    if (fo) {
      const sel = (fo.selectedClips || []).map((c) => c.id).join(', ') || 'nothing';
      const elsewhere = mine && fo.sequence?.id && fo.sequence.id !== mine.id ? ' (another sequence, not this chat\'s)' : '';
      console.log(`User is looking at: ${fo.mode || 'edit'} mode, sequence "${fo.sequence?.name}" (${fo.sequence?.id})${elsewhere} at ${f2(fo.playhead)}s, selected: ${sel}${fo.reviewVersion ? `, review version ${fo.reviewVersion}` : ''}`);
    }
    if (doc.folders.length) console.log(`Folders: ${doc.folders.map((f) => `${f.name} (${f.id}${f.parent ? ` in ${f.parent}` : ''})`).join(', ')}`);
    console.log(`\nMedia (${doc.media.length}):`);
    for (const m of doc.media) {
      const bits = [m.type, m.duration ? `${f2(m.duration)}s` : null, m.width ? `${m.width}x${m.height}` : null, m.fps ? `${m.fps}fps` : null, m.hasAudio && m.type === 'video' ? 'audio' : null].filter(Boolean).join(' ');
      // a motion graphic's video is a render the editor manages: its HTML source is what matters
      console.log(`  ${m.id}  ${m.name}  ${bits}${m.folder ? `  [folder ${m.folder}]` : ''}  ${m.motion ? `<motion source ${m.motion.src}>` : `<${m.path}>`}`);
    }
    const which = mine ? [mine] : doc.sequences;
    for (const s of which) {
      console.log(`\nSequence "${s.name}" (${s.id})  ${s.width}x${s.height} @ ${s.fps}fps  duration ${f2(sequenceDuration(s))}s  bg ${s.background}${s.folder ? `  [folder ${s.folder}]` : ''}`);
      const rows = [...videoTracks(s).slice().reverse(), ...audioTracks(s)];
      for (const tr of rows) {
        const flags = [tr.hidden && 'hidden', tr.muted && 'muted', tr.solo && 'solo', tr.locked && 'locked', tr.volume !== 1 && `vol ${tr.volume}`].filter(Boolean).join(' ');
        const clips = s.clips.filter((c) => c.track === tr.id).sort((a, b) => a.start - b.start);
        console.log(`  ${trackLabel(s, tr)} (track id "${tr.id}")${flags ? `  [${flags}]` : ''}${clips.length ? '' : '  — empty'}`);
        for (const c of clips) {
          const what = c.type === 'text' ? JSON.stringify(c.text) : c.type === 'solid' ? `color ${c.color}` : media[c.media]?.name || `missing media ${c.media}`;
          const x = [];
          if (c.in) x.push(`in ${f2(c.in)}`);
          if (c.speed && c.speed !== 1) x.push(`speed ${c.speed}`);
          if (c.transform) {
            const t = c.transform;
            const tf = [t.x && `x ${f2(t.x)}`, t.y && `y ${f2(t.y)}`, t.scale !== 1 && `scale ${f2(t.scale)}`, t.rotation && `rot ${f2(t.rotation)}`, t.opacity !== 1 && `opacity ${f2(t.opacity)}`].filter(Boolean);
            if (tf.length) x.push(tf.join(' '));
          }
          if (c.type === 'audio') { if (c.volume !== 1) x.push(`vol ${f2(c.volume)}`); if (c.fadeIn) x.push(`fadeIn ${f2(c.fadeIn)}`); if (c.fadeOut) x.push(`fadeOut ${f2(c.fadeOut)}`); }
          if (c.transitionIn) x.push(`in:${c.transitionIn.type} ${f2(c.transitionIn.duration)}s`);
          if (c.transitionOut) x.push(`out:${c.transitionOut.type} ${f2(c.transitionOut.duration)}s`);
          const kf = Object.keys(c.keyframes || {});
          if (kf.length) x.push(`keyframes: ${kf.join(',')}`);
          if (c.effects && Object.values(c.effects).some((v) => v)) x.push(`fx`);
          if (c.link) x.push(`link ${c.link}`);
          if (c.enabled === false) x.push('DISABLED');
          console.log(`    ${c.id}  ${c.type.padEnd(5)}  ${f2(c.start).padStart(7)} → ${f2(clipEnd(c)).padEnd(7)} (${f2(c.duration)}s)  ${what}${x.length ? `  | ${x.join(' · ')}` : ''}`);
        }
      }
      if (s.markers?.length) console.log(`  markers: ${s.markers.map((m) => `${f2(m.t)}s${m.label ? ` "${m.label}"` : ''}`).join(', ')}`);
      if (s.inPoint != null || s.outPoint != null) console.log(`  in/out: ${f2(s.inPoint)} → ${f2(s.outPoint)}`);
    }
    if (warnings?.length) console.log(`\nWarnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}`);
  },

  async probe() {
    if (!pos[0]) die('usage: vedit probe <file>');
    const r = await call('GET', `/api/probe?path=${encodeURIComponent(path.resolve(pos[0]))}`);
    console.log(JSON.stringify(r, null, 2));
  },

  async import() {
    if (!pos.length) die('usage: vedit import <file|folder...> [--folder "Name"] [--copy]');
    const pid = await projectId();
    const r = await call('POST', `/api/p/${pid}/media/link`, { paths: pos.map((p) => path.resolve(p)), copy: !!opts.copy, folderName: typeof opts.folder === 'string' ? opts.folder : undefined });
    const { doc } = await loadProject();
    for (const id of r.ids) {
      const m = doc.media.find((x) => x.id === id);
      console.log(`${id}  ${m?.name}  ${m?.type} ${m?.duration ? `${f2(m.duration)}s` : ''} ${m?.width ? `${m.width}x${m.height}` : ''}`);
    }
  },

  // Saved transcripts (server/transcripts.js): look before transcribing, save after, so no chat makes one twice.
  //   vedit transcript <media id|name|file> [--json]      the saved one, as "start–end  text" lines (exit 2: none yet)
  //   vedit transcript save <media id|name|file> <file>    keep one: JSON { segments: [{ start, end, text }] }, SRT or VTT
  //   vedit transcript list                                which of this project's media have one
  async transcript() {
    const sub = ['save', 'list'].includes(pos[0]) ? pos.shift() : 'get';
    const footage = async (key) => {
      if (!key) die('usage: vedit transcript <media id|name|file> | vedit transcript save <media> <file> | vedit transcript list');
      if (fs.existsSync(key) && fs.statSync(key).isFile()) return { abs: path.resolve(key), label: path.basename(key) };
      const { doc } = await loadProject();
      const m = doc.media.find((x) => x.id === key) || doc.media.find((x) => x.name.toLowerCase() === String(key).toLowerCase());
      if (!m) die(`no media "${key}" in this project (see: vedit status)`);
      return { abs: path.isAbsolute(m.path) ? m.path : path.join(dir, m.path), label: `${m.id} ${m.name}` };
    };
    if (sub === 'list') {
      const { doc } = await loadProject();
      for (const m of doc.media.filter((x) => !x.motion && x.type !== 'image')) {
        const abs = path.isAbsolute(m.path) ? m.path : path.join(dir, m.path);
        let r = null;
        try { r = await call('GET', `/api/transcript?path=${encodeURIComponent(abs)}`); } catch (e) { if (e.offline) die(e.message); }
        console.log(`${m.id}  ${m.name}  ${r?.exists ? `saved (${r.summary.segments} lines${r.summary.language ? `, ${r.summary.language}` : ''})` : r ? 'none' : 'offline'}`);
      }
      return;
    }
    const { abs, label } = await footage(pos[0]);
    if (sub === 'save') {
      const src = pos[1];
      if (!src || !fs.existsSync(src)) die('usage: vedit transcript save <media id|name|file> <transcript.json|.srt|.vtt>');
      const text = fs.readFileSync(src, 'utf8');
      const r = await call('POST', '/api/transcript', { path: abs, text, by: 'claude' });
      console.log(`Saved the transcript of ${label}: ${r.summary.segments} lines${r.summary.language ? `, ${r.summary.language}` : ''} → ${r.file}. Later chats get it with \`vedit transcript ${pos[0]}\`.`);
      return;
    }
    const r = await call('GET', `/api/transcript?path=${encodeURIComponent(abs)}&full=1`);
    if (!r.exists) {
      console.log(`No saved transcript for ${label} yet. After transcribing it, keep it for every later chat: vedit transcript save ${pos[0]} <transcript.json|.srt|.vtt>`);
      process.exitCode = 2;
      return;
    }
    if (opts.json) { console.log(r.file); return; }
    const t = r.transcript;
    console.log(`Transcript of ${label} (${t.segments.length} lines${t.language ? `, ${t.language}` : ''}, saved ${t.savedAt.slice(0, 10)}; JSON with${t.segments.some((s) => s.words) ? '' : 'out'} word times: ${r.file})`);
    for (const s of t.segments) console.log(`${f2(s.start)}–${f2(s.end)}  ${s.text}`);
  },

  async frame() {
    // several times in one call: one step of the conversation instead of one per frame
    const times = pos.map(parseFloat);
    if (!times.length || !times.every(Number.isFinite)) die('usage: vedit frame <seconds…> [--seq <id|name>] [--out file.png] [--full | --scale 0.5]');
    if (opts.out && times.length > 1) die('--out works with one time; leave it out to get a file per time');
    const pid = await projectId();
    const { doc } = await loadProject();
    const seq = await seqOption(doc);
    const out = opts.out ? path.resolve(String(opts.out)) : undefined;
    for (const t of times) {
      const r = await call('POST', `/api/p/${pid}/still`, { sequenceId: seq?.id, time: t, out, ...frameSize() });
      if (r.error) die(r.error);
      console.log(times.length > 1 ? `${f2(t)}s  ${r.path}` : r.path);
    }
  },

  guide() {
    const text = dir ? guideText(pos[0], dir) : null;
    if (!text) die(dir ? 'usage: vedit guide motion' : 'no project.json found in this folder or its parents');
    console.log(text);
  },

  async render() {
    const pid = await projectId();
    const { doc } = await loadProject();
    const seq = await seqOption(doc);
    let range = null;
    if (typeof opts.range === 'string') { const [a, b] = opts.range.split('-').map(Number); range = [a, b]; }
    else if (opts.inout) range = 'inout';
    // Quick by default: Claude's review renders shouldn't take long. "auto" lets the editor pick — full quality
    // when the sequence is already pre-rendered (the export is then mostly a stitch), a draft (1080p at most)
    // otherwise. --final (or --quality high) always gives the real export; --draft always a draft.
    // Delivery settings (the Export dialog's): any of them makes it a full-quality export unless a quality is given.
    const FORMATS = ['h264', 'hevc', 'prores', 'prores422', 'proreslt', 'proresproxy', 'prores4444o', 'prores4444'];
    const format = typeof opts.format === 'string' ? opts.format : undefined;
    if (format && !FORMATS.includes(format)) die(`--format must be one of ${FORMATS.join(', ')}`);
    const num = (k) => (opts[k] != null && opts[k] !== true ? +opts[k] : null);
    const mbps = num('mbps'), height = num('height'), width = num('width'), fps = num('fps'), sampleRate = num('sample-rate');
    const AUDIO = ['aac320', 'aac256', 'aac192', 'aac128', 'pcm24', 'pcm16', 'none'];
    const audio = typeof opts.audio === 'string' ? opts.audio : null;
    if (audio && !AUDIO.includes(audio)) die(`--audio must be one of ${AUDIO.join(', ')}`);
    const delivery = format || mbps || height || width || fps || audio || sampleRate || opts.mov;
    const quality = opts.final ? 'high' : opts.draft ? 'draft' : typeof opts.quality === 'string' ? opts.quality : delivery ? 'high' : 'auto';
    const s0 = seq || doc.sequences[0];
    const scale = height ? height / Math.min(s0.width, s0.height) : width ? width / s0.width : undefined;
    const audioOut = audio || sampleRate ? { ...(audio === 'none' ? { codec: 'none' } : audio?.startsWith('pcm') ? { codec: audio } : { codec: 'aac', kbps: audio ? +audio.slice(3) : 256 }), rate: sampleRate === 44100 ? 44100 : 48000 } : undefined;
    const r = await call('POST', `/api/p/${pid}/render`, {
      sequenceId: seq?.id, quality, format, range, addVersion: !opts['no-version'], scale,
      rate: mbps ? { mbps, cbr: !!opts.cbr } : undefined, container: opts.mov ? 'mov' : undefined, fps: fps || undefined, audioOut,
    });
    const id = r.job.id;
    let last = -1;
    for (;;) {
      await new Promise((res) => setTimeout(res, 1000));
      const { jobs } = await call('GET', '/api/jobs');
      const j = jobs.find((x) => x.id === id);
      if (!j) die('render job disappeared');
      const p = Math.round((j.progress || 0) * 100);
      if (p !== last && process.stderr.isTTY !== undefined) { process.stderr.write(`\r${j.status} ${p}%   `); last = p; }
      if (j.status === 'done') { process.stderr.write('\n'); console.log(`Rendered ${j.outputRel}${j.versionId ? `  (review version ${j.versionId})` : ''}`); return; }
      if (j.status === 'error' || j.status === 'canceled') { process.stderr.write('\n'); die(`render ${j.status}: ${j.error || ''}`); }
    }
  },

  async comments() {
    if (!dir) die('no project.json found');
    const { doc, reviews } = await loadProject();
    if (!reviews?.versions.length) { console.log('No review versions yet. Run `vedit render` to create one.'); return; }
    let versions = [...reviews.versions];
    if (opts.version && opts.version !== true) {
      const v = String(opts.version);
      versions = versions.filter((x) => x.id === v || x.name === v);
      if (!versions.length) die(`no version "${v}"`);
    } else if (!opts.all) {
      // a linked chat sees its own sequence's versions only
      const mine = await seqOption(doc);
      if (mine) versions = versions.filter((v) => v.sequence === mine.id);
      // the latest version of each sequence, plus any older version that still has open comments
      const latest = new Map();
      for (const v of versions) if (!latest.has(v.sequence) || latest.get(v.sequence).number < v.number) latest.set(v.sequence, v);
      const withOpen = new Set(reviews.comments.filter((c) => !c.resolved).map((c) => c.version));
      versions = versions.filter((v) => latest.get(v.sequence) === v || withOpen.has(v.id)).sort((a, b) => a.number - b.number);
    }
    for (const v of versions) {
      const seq = doc.sequences.find((s) => s.id === v.sequence);
      let list = reviews.comments.filter((c) => c.version === v.id).sort((a, b) => a.t - b.t);
      if (opts.open) list = list.filter((c) => !c.resolved);
      if (v.kind === 'timeline') console.log(`${v.name} of "${seq?.name || v.sequenceName}" (version id ${v.id}, sequence ${v.sequence}) — ${v.status} — timeline round: no video, the user reviewed the live timeline; comment times are sequence times, see them with \`vedit frame <t>\`, and don't render afterwards`);
      else console.log(`${v.name} of "${seq?.name || v.sequenceName}" (version id ${v.id}, sequence ${v.sequence}) — ${v.status} — ${v.file} — ${v.width}x${v.height}, starts at sequence time ${f2(v.start || 0)}s`);
      if (!list.length) console.log(`  (no ${opts.open ? 'open ' : ''}comments)`);
      for (const c of list) {
        const at = (v.start || 0) + c.t;
        console.log(`  ${c.id}  [${c.resolved ? 'resolved' : 'open'}]  ${timecode(at, v.fps || 30)} (t=${f2(at)}s${c.tEnd != null ? ` → ${f2((v.start || 0) + c.tEnd)}s` : ''})  ${c.author}: ${JSON.stringify(c.text)}`);
        for (const s of c.drawing || []) {
          const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
          const px = (a, W) => Math.round(a * W);
          const W = v.width || 1920, H = v.height || 1080;
          const desc = s.tool === 'arrow'
            ? `arrow from (${px(xs[0], W)},${px(ys[0], H)}) pointing to (${px(xs[xs.length - 1], W)},${px(ys[ys.length - 1], H)})`
            : `${s.tool === 'pen' ? 'freehand mark' : 'box'} around x ${px(Math.min(...xs), W)}–${px(Math.max(...xs), W)}, y ${px(Math.min(...ys), H)}–${px(Math.max(...ys), H)}`;
          console.log(`      drawing: ${desc} (pixels in the ${W}x${H} frame, origin top-left)`);
        }
        for (const ref of c.refs || []) {
          if (ref.type === 'link') console.log(`      reference link: ${ref.url}`);
          else console.log(`      reference ${ref.type === 'image' ? 'image (Read it to see what the user means)' : 'file'}: ${path.resolve(dir, ref.path)}`);
        }
        for (const r of c.replies || []) console.log(`      ↳ ${r.author}: ${JSON.stringify(r.text)}`);
        if (opts.frames && v.kind === 'timeline') console.log(`      frame: run \`vedit frame ${f2(at)}\` (a timeline round has no video file)`);
        else if (opts.frames) {
          const file = path.resolve(dir, v.file);
          const outDir = path.join(layoutFor(dir).state, 'comments');
          fs.mkdirSync(outDir, { recursive: true });
          const out = path.join(outDir, `${c.id}${opts.full ? '.full' : ''}.png`);
          const boxes = (c.drawing || []).map((s) => {
            const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
            const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(0.01, Math.max(...xs) - x0), h = Math.max(0.01, Math.max(...ys) - y0);
            return `drawbox=x=iw*${x0.toFixed(4)}:y=ih*${y0.toFixed(4)}:w=iw*${w.toFixed(4)}:h=ih*${h.toFixed(4)}:color=red@0.9:t=6`;
          });
          if (!opts.full) boxes.push(`scale='min(${CHECK_SIDE},iw)':'min(${CHECK_SIDE},ih)':force_original_aspect_ratio=decrease`);
          const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(c.t), '-i', file, '-frames:v', '1', ...(boxes.length ? ['-vf', boxes.join(',')] : []), out], { encoding: 'utf8' });
          console.log(r.status === 0 ? `      frame: ${out}` : `      (could not grab frame: ${(r.stderr || r.error?.message || '').trim()})`);
        }
      }
    }
  },

  async reply() {
    const [id, text] = pos;
    if (!id || (!text && !opts.resolve)) die('usage: vedit reply <commentId> "text" [--resolve]');
    await updateReviews((r) => {
      const c = r.comments.find((x) => x.id === id);
      if (!c) die(`no comment ${id}`);
      if (text) c.replies.push({ id: `r_${Math.random().toString(36).slice(2, 10)}`, author: 'Claude', text, createdAt: new Date().toISOString() });
      if (opts.resolve) { c.resolved = true; c.resolvedAt = new Date().toISOString(); }
    });
    console.log(`${opts.resolve ? 'Resolved' : 'Replied to'} ${id}`);
  },

  async resolve() {
    const ids = pos;
    if (!ids.length) die('usage: vedit resolve <commentId...>');
    await updateReviews((r) => { for (const id of ids) { const c = r.comments.find((x) => x.id === id); if (!c) die(`no comment ${id}`); c.resolved = true; c.resolvedAt = new Date().toISOString(); } });
    console.log(`Resolved ${ids.join(', ')}`);
  },

  async comment() {
    // vedit comment <version> <seconds> "text"  — leave a note as Claude (e.g. a question for the user)
    const [ver, t, text] = pos;
    if (!ver || !Number.isFinite(parseFloat(t)) || !text) die('usage: vedit comment <versionId|name> <seconds> "text"');
    await updateReviews((r) => {
      const v = r.versions.find((x) => x.id === ver || x.name === ver);
      if (!v) die(`no version ${ver}`);
      r.comments.push({ id: `cm_${Math.random().toString(36).slice(2, 10)}`, version: v.id, t: parseFloat(t), tEnd: null, text, author: 'Claude', createdAt: new Date().toISOString(), resolved: false, drawing: [], replies: [] });
    });
    console.log('Comment added');
  },

  async validate() {
    if (!dir) die('no project.json found');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch (e) { die(`project.json is not valid JSON: ${e.message}`); }
    const { project, warnings } = normalizeProject(raw);
    for (const s of project.sequences) for (const c of s.clips) {
      if (c.media && !project.media.some((m) => m.id === c.media)) warnings.push(`clip ${c.id} uses unknown media ${c.media}`);
      const m = project.media.find((x) => x.id === c.media);
      if (m && (c.type === 'video' || c.type === 'audio') && m.duration && c.in + c.duration * (c.speed || 1) > m.duration + 0.05) warnings.push(`clip ${c.id} runs past the end of ${m.name} (needs ${f2(c.in + c.duration * (c.speed || 1))}s, media is ${f2(m.duration)}s)`);
    }
    if (!warnings.length) console.log('project.json looks good.');
    else { console.log(`${warnings.length} problem(s):`); for (const w of warnings) console.log(`  - ${w}`); process.exitCode = 1; }
  },

  // ---------------------------------------------------------------- motion graphics
  async motion() {
    const sub = pos.shift() || 'list';
    const pid = await projectId();
    const items = async () => (await call('GET', `/api/p/${pid}/motion`)).items;
    const pick = async (key) => {
      if (!key) die('give a motion item id or name (see: vedit motion list)');
      const list = await items();
      return list.find((m) => m.id === key) || list.find((m) => m.name.toLowerCase() === String(key).toLowerCase()) || die(`no motion graphic "${key}" (see: vedit motion list)`);
    };
    // key=value pairs (values parsed as JSON when they look like it) plus --params '{"k":…}'
    const paramArgs = (list) => {
      const out = {};
      for (const a of list) {
        const i = a.indexOf('=');
        if (i < 1) die(`expected key=value, got "${a}"`);
        const k = a.slice(0, i), v = a.slice(i + 1);
        try { out[k] = /^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/.test(v) ? JSON.parse(v) : v; } catch { out[k] = v; }
      }
      if (typeof opts.params === 'string') {
        try { Object.assign(out, JSON.parse(opts.params)); } catch (e) { die(`--params is not valid JSON: ${e.message}`); }
      }
      return out;
    };
    const show = (m) => {
      const st = m.status || {};
      console.log(`${m.id}  ${m.name}  [${st.state || 'pending'}${st.state === 'rendering' ? ` ${Math.round((st.progress || 0) * 100)}%` : ''}]  ${m.spec.width}x${m.spec.height} ${m.spec.fps}fps ${f2(m.spec.duration)}s  source: ${m.src}`);
      if (m.schema.length) console.log(`    params: ${m.schema.map((p) => `${p.key}=${JSON.stringify(m.params[p.key])} (${p.type})`).join(', ')}`);
      const extra = Object.keys(m.params).filter((k) => !m.schema.some((p) => p.key === k));
      if (extra.length) console.log(`    undeclared params: ${extra.map((k) => `${k}=${JSON.stringify(m.params[k])}`).join(', ')}`);
      if (m.configError) console.log(`    !! ${m.configError}`);
      if (st.error) console.log(`    !! render error: ${st.error}`);
      for (const l of st.logs || []) console.log(`    page: ${l}`);
    };
    // Starts the render (if one is needed) and reports while waiting: what it is queued behind, then
    // percent, speed and time left, so a slow or stuck render is visible instead of silent.
    const waitRendered = async (id) => {
      let r = await call('POST', `/api/p/${pid}/motion/${id}/render`, { force: !!opts.force });
      const t0 = Date.now();
      const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`);
      let said = '', saidAt = 0, started = null, moved = Date.now(), lastP = -1;
      while (r.status?.state === 'queued' || r.status?.state === 'rendering') {
        const st = r.status;
        const frames = Math.max(1, Math.round(r.spec.duration * r.spec.fps));
        let line;
        if (st.state === 'queued') {
          const w = r.waiting;
          line = w ? `queued (${w.position > 1 ? `${w.position - 1} ahead, ` : ''}waiting for "${w.current.name}" in ${w.current.project}, ${Math.round(w.current.progress * 100)}% done)` : 'queued';
        } else {
          if (started == null) started = Date.now();
          const p = st.progress || 0;
          const el = Date.now() - started;
          line = `rendering ${Math.round(p * 100)}% (${Math.round(p * frames)}/${frames} frames${p > 0.02 ? `, ${(p * frames / (el / 1000)).toFixed(1)} fps, about ${secs(el * (1 - p) / p)} left` : ''})`;
        }
        const p = st.state === 'rendering' ? st.progress || 0 : (r.waiting?.current.progress ?? -1);
        if (p !== lastP) { lastP = p; moved = Date.now(); }
        if (line !== said && Date.now() - saidAt > 10000) { console.log(`${r.id}  ${line}  [${secs(Date.now() - t0)}]`); said = line; saidAt = Date.now(); }
        if (Date.now() - moved > 180000) {
          console.log(`${r.id}  !! no progress for ${secs(Date.now() - moved)} (${line}). The render queue looks stuck; tell the user and suggest restarting Jimmy. Not waiting any longer.`);
          process.exitCode = 1;
          return r;
        }
        await new Promise((res) => setTimeout(res, 1500));
        r = await call('GET', `/api/p/${pid}/motion/${id}`);
      }
      show(r);
      if (r.status?.state === 'ready' && started != null) console.log(`    rendered in ${secs(Date.now() - started)}`);
      if (r.status?.state === 'error') process.exitCode = 1;
      return r;
    };

    if (sub === 'list') {
      const list = await items();
      if (!list.length) console.log('No motion graphics yet. Create one: vedit motion new <file.html> | vedit motion new --starter');
      for (const m of list) show(m);
    } else if (sub === 'info') {
      const m = await pick(pos[0]);
      show(m);
      console.log(`    rendered file: ${m.path}`);
    } else if (sub === 'new') {
      const file = opts.starter ? null : pos.shift();
      if (!file && !opts.starter) die('usage: vedit motion new <file.html> | --starter  [--name N] [--duration s] [--size 1920x1080] [--fps 30] [key=value…] [--place [--seq id] [--track v2] [--at 3.5]] [--folder Name]');
      const { doc } = await loadProject();
      const seq = await seqOption(doc);
      const size = typeof opts.size === 'string' ? opts.size.split(/x/i).map(Number) : null;
      const body = {
        ...(file ? { src: path.resolve(file) } : { starter: true }),
        name: typeof opts.name === 'string' ? opts.name : undefined,
        duration: opts.duration ? Number(opts.duration) : undefined,
        width: size?.[0] || seq?.width, height: size?.[1] || seq?.height, fps: opts.fps ? Number(opts.fps) : seq?.fps,
        params: paramArgs(pos), folderName: typeof opts.folder === 'string' ? opts.folder : undefined,
        place: opts.place ? { sequenceId: seq?.id, track: typeof opts.track === 'string' ? opts.track : undefined, start: opts.at ? Number(opts.at) : 0 } : undefined,
      };
      const r = await call('POST', `/api/p/${pid}/motion`, body);
      console.log(`Created motion graphic ${r.id} (source ${r.src})${r.clipId ? `, placed as clip ${r.clipId} on track ${r.track}` : ''}`);
      if (!opts['no-wait']) await waitRendered(r.id);
    } else if (sub === 'set') {
      const m = await pick(pos.shift());
      const body = { params: paramArgs(pos), replace: !!opts.replace };
      for (const k of ['duration', 'width', 'height', 'fps']) if (opts[k]) body[k] = Number(opts[k]);
      if (typeof opts.name === 'string') body.name = opts.name;
      await call('POST', `/api/p/${pid}/motion/${m.id}/set`, body);
      console.log(`Updated ${m.id}`);
      if (!opts['no-wait']) await waitRendered(m.id);
    } else if (sub === 'render') {
      const list = pos[0] === 'all' || !pos[0] ? await items() : [await pick(pos[0])];
      for (const m of list) await waitRendered(m.id);
    } else if (sub === 'frame' || sub === 'frames') {
      const m = await pick(pos.shift());
      const times = pos.filter((x) => !x.includes('=')).map(Number).filter(Number.isFinite);
      const params = paramArgs(pos.filter((x) => x.includes('=')));
      const r = await call('POST', `/api/p/${pid}/motion/${m.id}/frame`, { times: times.length ? times : [m.spec.duration / 2], ...frameSize(), params: Object.keys(params).length ? params : undefined, outDir: typeof opts.out === 'string' ? path.resolve(opts.out) : undefined });
      for (const f of r.frames) console.log(`${f2(f.t)}s  ${f.path}`);
      for (const l of r.logs || []) console.log(`page: ${l}`);
      console.log('(transparent PNGs — Read them to check the graphic)');
    } else if (sub === 'batch') {
      const m = await pick(pos[0]);
      const file = pos[1] || die('usage: vedit motion batch <id> <rows.csv|rows.json> [--folder Name]');
      const text = fs.readFileSync(path.resolve(file), 'utf8');
      const rows = /\.json$/i.test(file) ? JSON.parse(text) : parseCsv(text);
      const r = await call('POST', `/api/p/${pid}/motion/${m.id}/batch`, { rows, folderName: typeof opts.folder === 'string' ? opts.folder : undefined });
      console.log(`Created ${r.ids.length} motion graphics: ${r.ids.join(', ')} (rendering in the background — vedit motion render all)`);
    } else die(`unknown motion command "${sub}". Try: vedit help`);
  },
  async focus() {
    const f = focus();
    console.log(f ? JSON.stringify(f, null, 2) : 'No editor focus recorded yet.');
    const mine = dir ? await chatSequence() : null;
    if (mine) console.log(`This chat works on sequence "${mine.name}" (${mine.id})${f?.sequence?.id && f.sequence.id !== mine.id ? ' — the user is looking at another sequence' : ''}.`);
  },

  // vedit link <sequence id|name> | --none: this chat works on that sequence (its messages and review comments come here)
  async link() {
    if (!CHAT_KEY) die('vedit link only works inside a Jimmy chat (the Claude panel in the editor).');
    if (!opts.none && !pos[0]) die('usage: vedit link <sequence id|name> | vedit link --none');
    let r;
    // a sequence just written to project.json may take a moment to reach the editor
    for (let i = 0; ; i++) {
      try { r = await call('POST', '/api/chat-self/link', { key: CHAT_KEY, sequence: opts.none ? null : pos[0] }); break; } catch (err) {
        if (i >= 4 || !/No sequence/.test(err.message)) die(err.message);
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    console.log(r.sequence ? `This chat is now linked to sequence "${r.sequence.name}" (${r.sequence.id}): its messages and review comments come here.` : 'This chat is no longer linked to a sequence.');
  },

  help() {
    console.log(`vedit — Jimmy project helper (server ${BASE})

  vedit status [--seq <id|name> | --all]  overview of media, sequences, tracks and clips
  vedit focus                             what the user is looking at in the editor
  vedit link <sequence id|name> | --none  link this chat to the sequence it works on (inside a Jimmy chat)
    (in a linked chat, status / frame / render / comments default to that sequence; --seq or --all for others)
  vedit probe <file>                      media info
  vedit import <file|folder...> [--folder "Name"] [--copy]
  vedit transcript <media> [--json]   the saved transcript of a clip (exit 2 if none yet); vedit transcript list
  vedit transcript save <media> <transcript.json|.srt|.vtt>   keep a transcript you made, for every later chat
  vedit frame <seconds…> [--seq <id>] [--out f.png] [--full | --scale 0.5]   render frames → PNG paths (longest side ${CHECK_SIDE}px unless --full)
  vedit render [--seq <id>] [--final | --draft | --quality high|standard|draft] [--format h264|hevc|prores|prores422|proreslt|proresproxy|prores4444o|prores4444]
      [--mbps <n> [--cbr]] [--mov] [--height <short side px> | --width <px>] [--fps <rate>] [--audio aac320|aac256|aac192|aac128|pcm24|pcm16|none] [--sample-rate 48000|44100]
      [--range a-b | --inout] [--no-version]   (quick by default: full quality if pre-rendered, else a draft; any delivery setting makes it full quality)
  vedit comments [--open] [--version <id|vN>] [--all] [--frames [--full]]
  vedit reply <commentId> "text" [--resolve]
  vedit resolve <commentId...>
  vedit comment <versionId|vN> <seconds> "text"
  vedit validate
  vedit guide motion                      how to write motion graphics (read before writing or changing one)
  vedit motion list                       motion graphics (HTML compositions rendered to transparent video)
  vedit motion new <file.html> | --starter [--name N] [--duration s] [key=value…] [--place [--seq id] [--track v2] [--at s]] [--folder Name]
  vedit motion set <id|name> key=value… [--params '{json}'] [--replace] [--duration s]   (re-renders, waits)
  vedit motion frame <id|name> <seconds…> [key=value…] [--full | --scale 0.5]   render stills of the composition → PNG paths
  vedit motion render <id|name|all> [--force]   wait for renders; shows errors and page console messages
  vedit motion batch <id|name> <rows.csv|rows.json> [--folder Name]   one graphic per row (columns = params, "name")`);
  },
};

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

async function updateReviews(fn) {
  const pid = await projectId();
  for (let i = 0; i < 4; i++) {
    const r = await call('GET', `/api/p/${pid}`);
    const doc = r.reviews;
    fn(doc);
    const res = await call('PUT', `/api/p/${pid}/reviews`, { doc, baseRev: r.reviewsRev, clientId: 'vedit' });
    if (res.status !== 409) return;
  }
  die('reviews kept changing — try again');
}

const run = commands[cmd] || (cmd ? null : commands.help);
if (!run) die(`unknown command "${cmd}". Try: vedit help`);
try {
  await run();
} catch (err) {
  die(err.message);
}
