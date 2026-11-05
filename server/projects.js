// Project folders on disk ⇄ in-memory documents, with live two-way sync.
// The editor UI commits through here (optimistic concurrency via `rev`), and a directory
// watcher picks up edits Claude makes to project.json / reviews.json directly.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeProject, serializeProject, stringifyCompact, normalizeReviews,
  makeProject, makeReviews, deepClone,
} from '../public/js/core/model.js';
import { projectIdFor, writeFileAtomic, sanitizeFolderName, readJsonSafe, readJson, toPosix, exists, sha1 } from './util.js';
import { getConfig, updateConfig } from './config.js';
import { ensureClaudeMd } from './claudemd.js';
import { layoutFor, adoptLegacyFiles, warmLayout } from './layout.js';
import { keepNames, resetNames } from './clipnames.js';
import { watchSnapshots, unwatchSnapshots, beforeChatEdit } from './snapshots.js';

// A project folder directly inside the projects folder (those are found by listing it; any other is kept in `recent`).
const inRoot = (dir, projectsRoot) => projectIdFor(path.dirname(dir)) === projectIdFor(projectsRoot);

function collectIds(doc) {
  const ids = [];
  for (const m of doc?.media || []) ids.push(m?.id);
  for (const f of doc?.folders || []) ids.push(f?.id);
  for (const s of doc?.sequences || []) {
    ids.push(s?.id);
    for (const c of s?.clips || []) ids.push(c?.id);
  }
  return ids.join('|');
}

export class ProjectHandle {
  constructor(manager, dir) {
    this.manager = manager;
    this.dir = dir;
    this.id = projectIdFor(dir);
    this.file = path.join(dir, 'project.json');
    this.reviewsFile = path.join(dir, 'reviews.json');
    this.doc = null;
    this.rev = 0;
    this.userRev = 0;
    this.text = null;
    this.error = null;
    this.warnings = [];
    this.reviews = null;
    this.reviewsRev = 0;
    this.reviewsText = null;
    this.reviewsError = null;
    this.ownTexts = new Set();
    this.writing = 0; // writes queued or in flight
    this.writeChain = Promise.resolve();
    this.watcher = null;
    this.timers = {};
    this.focus = null;
    this.seqSeen = new Map(); // sequence id -> hashes of the states it has had (see keepNewerSequences)
  }

  noteSequences(doc) {
    for (const s of doc?.sequences || []) {
      let seen = this.seqSeen.get(s.id);
      if (!seen) this.seqSeen.set(s.id, (seen = new Set()));
      seen.add(sha1(JSON.stringify(s)));
      if (seen.size > 80) seen.delete(seen.values().next().value);
    }
  }

  // Several chats can edit project.json side by side, each on its own sequence. A save made from an older copy
  // of the whole file would also put back older versions of the other chats' sequences (or drop ones added
  // since). So a save that changes more than one sequence and returns one of them to a state it already had
  // keeps that sequence as it is now, and puts back sequences it dropped (with the media they use). Returns
  // the names of the sequences kept.
  keepNewerSequences(next) {
    const prev = this.doc;
    if (!prev || this.error) return [];
    const hash = (s) => sha1(JSON.stringify(s));
    const nextById = new Map(next.sequences.map((s) => [s.id, s]));
    const changed = prev.sequences.filter((s) => { const n = nextById.get(s.id); return !n || hash(n) !== hash(s); });
    const added = next.sequences.filter((s) => !prev.sequences.some((p) => p.id === s.id));
    if (changed.length + added.length < 2) return [];
    const rolledBack = changed.filter((s) => nextById.has(s.id) && this.seqSeen.get(s.id)?.has(hash(nextById.get(s.id))));
    if (!rolledBack.length) return [];
    const kept = [...rolledBack, ...changed.filter((s) => !nextById.has(s.id))];
    for (const s of kept) {
      const n = nextById.get(s.id);
      if (n) next.sequences[next.sequences.indexOf(n)] = deepClone(s);
      else next.sequences.splice(Math.min(prev.sequences.indexOf(s), next.sequences.length), 0, deepClone(s));
      for (const c of s.clips) {
        if (c.media && !next.media.some((m) => m.id === c.media)) {
          const m = prev.media.find((x) => x.id === c.media);
          if (m) next.media.push(deepClone(m));
        }
      }
    }
    return kept.map((s) => s.name);
  }

  resolve(p) {
    if (!p) return null;
    return path.isAbsolute(p) ? path.normalize(p) : path.join(this.dir, p);
  }
  relativize(abs) {
    const rel = path.relative(this.dir, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
    return toPosix(abs);
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.layout = layoutFor(this.dir);
    for (const d of this.layout.ensure) await fsp.mkdir(d, { recursive: true });
    if (this.layout.template) await this.removeStrayFolders();
    await adoptLegacyFiles(this.layout);

    let text = null;
    try { text = await fsp.readFile(this.file, 'utf8'); } catch { /* missing */ }
    if (text == null) {
      await this.commit(makeProject(path.basename(this.dir)), { origin: 'server' });
    } else {
      this.text = text;
      try {
        const raw = JSON.parse(text);
        const { project, warnings, snapped } = normalizeProject(raw);
        const renamed = resetNames(project);
        if (renamed > 0) console.log(`[project] ${project.name}: ${renamed} footage name${renamed === 1 ? '' : 's'} put back to the file's own`);
        this.doc = project;
        this.noteSequences(project);
        this.warnings = warnings;
        this.rev = 1;
        this.userRev = 1;
        // ids were filled in, clips were moved onto whole frames or names put back: write the corrected file back
        if (snapped || renamed >= 0 || collectIds(raw) !== collectIds(project)) await this.commit(project, { origin: 'server' });
      } catch (err) {
        this.error = `project.json: ${err.message}`;
        this.doc = makeProject(path.basename(this.dir));
        this.rev = 1;
        this.userRev = 1;
      }
    }

    let rtext = null;
    try { rtext = await fsp.readFile(this.reviewsFile, 'utf8'); } catch { /* missing */ }
    if (rtext == null) {
      await this.commitReviews(makeReviews(), { origin: 'server' });
    } else {
      this.reviewsText = rtext;
      try { this.reviews = normalizeReviews(JSON.parse(rtext)); } catch (err) { this.reviewsError = `reviews.json: ${err.message}`; this.reviews = makeReviews(); }
      this.reviewsRev = 1;
    }

    await ensureClaudeMd(this.dir).catch((e) => console.warn('[project] CLAUDE.md:', e.message));
    this.watch();
    watchSnapshots(this);
    this.manager.media.sync(this).catch((e) => console.warn('[media] sync:', e.message));
  }

  watch() {
    if (this.watcher) return;
    try {
      // Watch the long-form path: libuv on Windows aborts the whole process when the watched path
      // contains an 8.3 short name (e.g. C:\Users\JOHNSM~1\...) and a file inside it changes.
      let dir = this.dir;
      try { dir = fs.realpathSync.native(this.dir); } catch { /* keep as is */ }
      this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === 'project.json') this.debounce('project', () => this.checkExternal('project'), 120);
        else if (filename === 'reviews.json') this.debounce('reviews', () => this.checkExternal('reviews'), 120);
      });
      this.watcher.on('error', () => {});
    } catch (err) {
      console.warn('[project] cannot watch', this.dir, err.message);
    }
    // Safety net: fs.watch can miss events on Windows/network drives, so also poll the mtimes.
    for (const [file, kind] of [[this.file, 'project'], [this.reviewsFile, 'reviews']]) {
      fs.watchFile(file, { interval: 1500, persistent: false }, (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs) this.debounce(kind, () => this.checkExternal(kind), 120);
      });
    }
  }

  debounce(key, fn, ms) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(fn, ms);
  }

  remember(text) {
    this.ownTexts.add(text);
    if (this.ownTexts.size > 8) this.ownTexts.delete(this.ownTexts.values().next().value);
  }

  queueWrite(file, text) {
    this.remember(text);
    this.writing++;
    this.writeChain = this.writeChain.then(() => writeFileAtomic(file, text)).catch((err) => console.error('[project] write failed:', err.message)).finally(() => { this.writing--; });
    return this.writeChain;
  }

  async checkExternal(kind, retry = true) {
    const file = kind === 'project' ? this.file : this.reviewsFile;
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { return; }
    // One of our own writes still in flight. Once they have settled, the file matching an OLDER text of ours
    // means someone put that version back (an undo of Claude's edit, a restored backup) and is a real change.
    if (this.writing && this.ownTexts.has(text)) return;
    // The writer may still be mid-write: give unparseable content one more look before reporting it.
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {
      if (retry) { this.debounce(kind, () => this.checkExternal(kind, false), 600); return; }
    }
    if (kind === 'project') {
      if (text === this.text) return;
      // a chat's edit (or any outside change): keep a snapshot of the project as it was, unless one is recent
      if (!this.error) beforeChatEdit(this, this.text, this.reviewsText);
      this.text = text;
      let raw;
      try { raw = parsed ?? JSON.parse(text); } catch (err) {
        this.error = `project.json has a syntax error: ${err.message}`;
        this.manager.emit(this, { type: 'projectError', projectId: this.id, error: this.error });
        return;
      }
      const { project, warnings, snapped } = normalizeProject(raw);
      const kept = this.keepNewerSequences(project);
      // a chat renaming footage (clips or bin items) is taken back: footage keeps its file's name
      const renamed = this.error ? 0 : keepNames(this.doc, project);
      if (renamed) console.log(`[project] ${project.name}: a chat renamed footage; kept the original names (${renamed})`);
      this.doc = project;
      this.noteSequences(project);
      this.warnings = warnings;
      this.error = null;
      this.rev++;
      this.userRev = this.rev;
      this.manager.emit(this, { type: 'project', projectId: this.id, rev: this.rev, doc: project, warnings, origin: 'external' });
      if (kept.length) {
        console.log(`[project] ${project.name}: a save from an older copy would have undone ${kept.join(', ')}; kept the newer version`);
        this.manager.emit(this, { type: 'notice', projectId: this.id, text: `A chat saved an older copy of project.json. Kept the newer "${kept.join('", "')}" so its changes weren't undone.` });
      }
      if (kept.length || snapped || renamed || collectIds(raw) !== collectIds(project)) await this.commit(project, { origin: 'server' });
      this.manager.media.sync(this).catch((e) => console.warn('[media] sync:', e.message));
    } else {
      if (text === this.reviewsText) return;
      this.reviewsText = text;
      try {
        this.reviews = normalizeReviews(parsed ?? JSON.parse(text));
        this.reviewsError = null;
      } catch (err) {
        this.reviewsError = `reviews.json has a syntax error: ${err.message}`;
        this.manager.emit(this, { type: 'reviewsError', projectId: this.id, error: this.reviewsError });
        return;
      }
      this.reviewsRev++;
      this.manager.emit(this, { type: 'reviews', projectId: this.id, rev: this.reviewsRev, doc: this.reviews, origin: 'external' });
    }
  }

  // Replace the whole document. baseRev guards against overwriting edits the caller hasn't seen.
  async commit(rawDoc, { origin = 'server', baseRev = null, force = false } = {}) {
    // While project.json on disk is unparseable (e.g. Claude is mid-edit) nobody may overwrite it,
    // except an explicit "restore last good version" (force).
    if (this.error && !force) return { error: this.error, locked: true };
    // Only edits by people (UI, Claude, imports) conflict. Background "server" commits — media
    // metadata fills — are re-applied below, so a client based on an older rev can still save.
    if (baseRev != null && baseRev < this.userRev) return { conflict: true, rev: this.rev, doc: this.doc };
    const { project, warnings } = normalizeProject(rawDoc);
    if (origin !== 'server') this.manager.media.fillMeta(this, project);
    project.updatedAt = new Date().toISOString();
    const text = stringifyCompact(serializeProject(project));
    this.doc = project;
    this.noteSequences(project);
    this.warnings = warnings;
    this.error = null;
    this.rev++;
    if (origin !== 'server') this.userRev = this.rev;
    this.text = text;
    this.queueWrite(this.file, text);
    this.manager.emit(this, { type: 'project', projectId: this.id, rev: this.rev, doc: project, warnings, origin });
    this.manager.media.sync(this).catch((e) => console.warn('[media] sync:', e.message));
    return { ok: true, rev: this.rev };
  }

  async mutate(fn, origin = 'server') {
    if (this.error) return { error: this.error, locked: true };
    const draft = deepClone(this.doc);
    const r = await fn(draft);
    return this.commit(r || draft, { origin });
  }

  async commitReviews(rawDoc, { origin = 'server', baseRev = null } = {}) {
    if (baseRev != null && baseRev !== this.reviewsRev) return { conflict: true, rev: this.reviewsRev, doc: this.reviews };
    const doc = normalizeReviews(rawDoc);
    const text = stringifyCompact(doc);
    this.reviews = doc;
    this.reviewsError = null;
    this.reviewsRev++;
    this.reviewsText = text;
    this.queueWrite(this.reviewsFile, text);
    this.manager.emit(this, { type: 'reviews', projectId: this.id, rev: this.reviewsRev, doc, origin });
    return { ok: true, rev: this.reviewsRev };
  }

  // Earlier versions created these inside template projects; remove them again (empty ones only, plus the
  // editor's own cache/state folders, which now live in the app's data folder).
  async removeStrayFolders() {
    for (const d of ['media', 'renders', 'fonts']) await fsp.rmdir(path.join(this.dir, d)).catch(() => {});
    for (const d of ['.cache', '.claude-edit']) await fsp.rm(path.join(this.dir, d), { recursive: true, force: true }).catch(() => {});
  }

  async mutateReviews(fn, origin = 'server') {
    const draft = deepClone(this.reviews);
    const r = await fn(draft);
    return this.commitReviews(r || draft, { origin });
  }

  setFocus(focus) {
    this.focus = { ...focus, updatedAt: new Date().toISOString() };
    this.debounce('focus', () => {
      const f = this.focus;
      const seq = this.doc?.sequences.find((s) => s.id === f.sequenceId);
      const out = {
        note: 'What the user is currently looking at in Jimmy (updated live).',
        mode: f.mode,
        sequence: seq ? { id: seq.id, name: seq.name } : null,
        playhead: f.time,
        selectedClips: (Array.isArray(f.selection) ? f.selection : []).map((id) => {
          const c = seq?.clips.find((x) => x.id === id);
          return c ? { id, type: c.type, track: c.track, start: c.start, duration: c.duration, media: c.media, text: c.text } : { id };
        }),
        reviewVersion: f.version || null,
        updatedAt: f.updatedAt,
      };
      writeFileAtomic(path.join(this.layout.files, 'ui.json'), JSON.stringify(out, null, 2) + '\n').catch(() => {});
    }, 600);
  }

  snapshot() {
    return {
      id: this.id, dir: this.dir, doc: this.doc, rev: this.rev, error: this.error, warnings: this.warnings,
      reviews: this.reviews, reviewsRev: this.reviewsRev, reviewsError: this.reviewsError,
      mediaStatus: this.manager.media.statusObject(this.id),
    };
  }

  close() {
    unwatchSnapshots(this);
    this.manager.media.motion?.unwatch(this);
    this.watcher?.close();
    this.watcher = null;
    fs.unwatchFile(this.file);
    fs.unwatchFile(this.reviewsFile);
    for (const t of Object.values(this.timers)) clearTimeout(t);
  }
}

export class ProjectManager {
  constructor({ media, emit }) {
    this.media = media;
    this.emitFn = emit;
    this.handles = new Map();
    this.index = new Map(); // id -> dir
  }

  emit(handle, msg) {
    this.emitFn(handle.id, msg);
  }

  async list() {
    const cfg = getConfig();
    const dirs = [];
    const hidden = new Set(cfg.hiddenProjects || []);
    try {
      for (const ent of await fsp.readdir(cfg.projectsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(cfg.projectsRoot, ent.name);
        if (hidden.has(projectIdFor(dir))) continue; // taken off the list by hand
        if (await exists(path.join(dir, 'project.json'))) dirs.push(dir);
      }
    } catch { /* root missing */ }
    for (const r of cfg.recent || []) {
      if (!dirs.some((d) => projectIdFor(d) === projectIdFor(r)) && (await exists(path.join(r, 'project.json')))) dirs.push(r);
    }
    // each project's folders, read side by side without holding the app (the cache cap check asks for them all)
    await Promise.all(dirs.map((d) => warmLayout(d).catch(() => {})));
    const out = [];
    for (const dir of dirs) {
      const id = projectIdFor(dir);
      this.index.set(id, dir);
      const h = this.handles.get(id);
      const raw = h?.doc || (await readJson(path.join(dir, 'project.json'), {}));
      let mtime = null;
      try { mtime = (await fsp.stat(path.join(dir, 'project.json'))).mtime.toISOString(); } catch { /* ignore */ }
      out.push({
        id, dir, name: raw?.name || path.basename(dir), ip: raw?.ip || null,
        updatedAt: raw?.updatedAt || mtime,
        sequences: Array.isArray(raw?.sequences) ? raw.sequences.length : 0,
        media: Array.isArray(raw?.media) ? raw.media.length : 0,
        external: !inRoot(dir, cfg.projectsRoot),
      });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  async create(name, location, { template = null, ip = null } = {}) {
    const root = location || getConfig().projectsRoot;
    await fsp.mkdir(root, { recursive: true });
    const base = sanitizeFolderName(name);
    let folder = base;
    for (let i = 2; fs.existsSync(path.join(root, folder)); i++) folder = `${base} ${i}`;
    const dir = path.join(root, folder);
    await fsp.mkdir(dir, { recursive: true });
    // Copy Jimmy's template folders first, so the project is laid out that way from the start.
    // (.keep files only hold the template's empty folders in git and in the installers; they aren't copied)
    if (template) await fsp.cp(template, dir, { recursive: true, errorOnExist: false, force: false, filter: (src) => path.basename(src) !== '.keep' });
    const doc = makeProject(String(name || folder).trim() || folder);
    if (ip) doc.ip = ip;
    await writeFileAtomic(path.join(dir, 'project.json'), stringifyCompact(serializeProject(doc)));
    return this.openPath(dir);
  }

  async openPath(p) {
    let dir = path.resolve(String(p || ''));
    if (/project\.json$/i.test(dir)) dir = path.dirname(dir);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) throw Object.assign(new Error(`Folder not found: ${dir}`), { status: 404 });
    const cfg = getConfig();
    const id = projectIdFor(dir);
    if (!inRoot(dir, cfg.projectsRoot) && !(cfg.recent || []).some((r) => projectIdFor(r) === id)) {
      await updateConfig({ recent: [dir, ...(cfg.recent || [])].slice(0, 50) });
    }
    if ((cfg.hiddenProjects || []).includes(id)) await updateConfig({ hiddenProjects: cfg.hiddenProjects.filter((x) => x !== id) });
    this.index.set(id, dir);
    return this.get(id);
  }

  // Take a project off the Home list; its folder is never touched. One in the projects folder is remembered as
  // hidden (opening it again brings it back).
  async forget(id) {
    const cfg = getConfig();
    const dir = this.index.get(id);
    const patch = { recent: (cfg.recent || []).filter((r) => projectIdFor(r) !== id) };
    if (dir && inRoot(dir, cfg.projectsRoot)) patch.hiddenProjects = [...new Set([...(cfg.hiddenProjects || []), id])];
    await updateConfig(patch);
  }

  // Stop watching a project (before its folder is deleted).
  unload(id) {
    const h = this.handles.get(id);
    if (h) { h.close(); this.handles.delete(id); }
    this.index.delete(id);
  }

  async dirFor(id) {
    if (!this.index.has(id)) await this.list();
    return this.index.get(id) || null;
  }

  async get(id) {
    const existing = this.handles.get(id);
    if (existing) { await existing.loading; return existing; }
    let dir = this.index.get(id);
    if (!dir) {
      await this.list();
      dir = this.index.get(id);
      // another request for the same project may have opened it while the list was read
      const opened = this.handles.get(id);
      if (opened) { await opened.loading; return opened; }
    }
    if (!dir) return null;
    await warmLayout(dir).catch(() => {}); // its folders read without holding the app (a slow drive)
    const again = this.handles.get(id);
    if (again) { await again.loading; return again; }
    const h = new ProjectHandle(this, dir);
    this.handles.set(id, h);
    h.loading = h.load();
    try { await h.loading; } catch (err) { this.handles.delete(id); throw err; }
    return h;
  }

  // Find the project containing a path (used by the CLI when it runs inside a project folder).
  async findByDir(dir) {
    let cur = path.resolve(dir);
    for (;;) {
      if (await exists(path.join(cur, 'project.json'))) return this.openPath(cur);
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
}
