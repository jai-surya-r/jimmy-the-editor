// One editor tab = one project. Owns the document, undo history, server sync, UI state and the
// preview engine. Edits are applied optimistically and saved in the background.
import { createStore, loadPref, savePref } from './store.js';
import { get, put, post, socket, clientId } from './api.js';
import { normalizeProject, deepClone, mediaMap, findSequence, flattenSequence } from './model.js';
import { PlaybackEngine } from './playback.js';
import { notify } from './notify.js';
import { resolveOverlaps } from './ops.js';

const UI_KEYS = ['mode', 'sequenceId', 'pps', 'scrollX', 'claudeOpen', 'snap', 'linked', 'viewerZoom', 'quality', 'safeArea', 'openFolders', 'rulers', 'showGuides', 'guides', 'exportDir', 'platformSafe', 'graph', 'graphMode', 'graphBox'];

export class Tab {
  constructor(id, projectId) {
    this.id = id;
    this.projectId = projectId;
    const saved = projectId ? loadPref(`tab.${id}`, {}) : {};
    this.store = createStore({
      status: projectId ? 'loading' : 'home', loadError: null, dir: '', doc: null, rev: 0,
      reviews: null, reviewsRev: 0, mediaStatus: {}, projectError: null, reviewsError: null,
      warnings: [], terminal: null, chat: null, fonts: [], claudeAt: 0, prerender: null,
    });
    this.ui = createStore({
      mode: 'edit', sequenceId: null, pps: 80, scrollX: 0, selection: [], tool: 'select', snap: true,
      linked: true, claudeOpen: true, reviewVersion: null, viewerZoom: 'fit', quality: 'auto', safeArea: false, rulers: false, showGuides: true, guides: {},
      openFolders: {}, binSelection: [], kfSel: null, graph: false, graphProps: null, graphMode: 'value', graphBox: null, ...saved, reviewVersion: null, // Review opens on the live timeline
    });
    this.time = createStore({ t: projectId ? loadPref(`tab.${id}.t`, 0) : 0, playing: false });
    this.flash = createStore({ ids: [], at: 0 });
    this.undoStack = [];
    this.redoStack = [];
    this.saving = false;
    this.savePending = false;
    this.dragStart = null;
    this.reviewChain = Promise.resolve();
    this.engine = new PlaybackEngine(this);
    this._mm = { media: null, map: {} };
    this.unsubs = [];
    if (projectId) {
      this.unsubs.push(this.ui.subscribe((s) => {
        const o = {};
        for (const k of UI_KEYS) o[k] = s[k];
        savePref(`tab.${id}`, o);
      }));
      let tTimer = null;
      let wasPlaying = false, lastT = this.time.get().t, lastScrub = 0;
      this.unsubs.push(this.time.subscribe((s) => {
        clearTimeout(tTimer);
        tTimer = setTimeout(() => savePref(`tab.${id}.t`, s.t), 400);
        this.reportFocus();
        // tell the server when the playhead is in use, so background pre-rendering stays out of the way
        if (s.playing !== wasPlaying) { wasPlaying = s.playing; socket.send({ type: 'activity', playing: s.playing }); }
        else if (!s.playing && s.t !== lastT && Date.now() - lastScrub > 800) { lastScrub = Date.now(); socket.send({ type: 'activity', scrub: true }); }
        lastT = s.t;
      }));
      this.unsubs.push(() => { if (wasPlaying) socket.send({ type: 'activity', playing: false }); });
      this.unsubs.push(this.ui.subscribe(() => this.reportFocus()));
    }
  }

  // ------------------------------------------------------------ accessors

  get doc() { return this.store.get().doc; }
  get reviews() { return this.store.get().reviews; }
  get seq() {
    const doc = this.doc;
    if (!doc) return null;
    return findSequence(doc, this.ui.get().sequenceId) || doc.sequences[0] || null;
  }
  // the sequence as it plays and renders: nested sequences expanded into their contents (model.js flattenSequence)
  get playSeq() {
    const s = this.seq;
    if (!s) return null;
    // asked for many times a frame: the same project and sequence give the same answer
    const m = this._playSeq;
    if (m && m.doc === this.doc && m.s === s) return m.flat;
    const flat = flattenSequence(this.doc, s);
    this._playSeq = { doc: this.doc, s, flat };
    return flat;
  }
  get mediaById() {
    const doc = this.doc;
    if (!doc) return {};
    if (this._mm.media !== doc.media) this._mm = { media: doc.media, map: mediaMap(doc) };
    return this._mm.map;
  }
  seqIn(doc) {
    return findSequence(doc, this.ui.get().sequenceId) || doc.sequences[0] || null;
  }
  get selection() { return this.ui.get().selection; }

  // ------------------------------------------------------------ loading / server events

  async load() {
    if (!this.projectId) return;
    socket.subscribe(this.projectId);
    if (!this._watching) { this._watching = true; this.watchMissing(); }
    try {
      const r = await get(`/api/p/${this.projectId}`);
      this.store.set({
        status: 'ready', dir: r.dir, doc: r.doc, rev: r.rev, reviews: r.reviews, reviewsRev: r.reviewsRev,
        mediaStatus: r.mediaStatus || {}, projectError: r.error, reviewsError: r.reviewsError,
        warnings: r.warnings || [], terminal: r.terminal, chat: r.chat, fonts: r.fonts || [], prerender: r.prerender || null,
        chatLinks: r.chatLinks || {}, chatsLive: r.chatsLive || [],
      });
      this.ensureSequence();
      this.engine.seek(this.time.get().t);
    } catch (err) {
      this.store.set({ status: 'error', loadError: err.message });
    }
  }

  async refresh() {
    const r = await get(`/api/p/${this.projectId}`);
    if (this.saving || this.dragStart) return;
    this.store.set({ doc: r.doc, rev: r.rev, mediaStatus: r.mediaStatus || {}, warnings: r.warnings || [] });
    this.engine.invalidate();
  }

  ensureSequence() {
    const doc = this.doc;
    if (!doc) return;
    const { sequenceId } = this.ui.get();
    if (!findSequence(doc, sequenceId)) this.ui.set({ sequenceId: doc.sequences[0]?.id || null, selection: [] });
    else {
      const seq = this.seq;
      const sel = this.ui.get().selection.filter((id) => seq.clips.some((c) => c.id === id));
      if (sel.length !== this.ui.get().selection.length) this.ui.set({ selection: sel });
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'project': return this.onProject(msg);
      case 'projectError': this.store.set({ projectError: msg.error }); notify('project.json has an error — editing is paused until it is fixed.', 'error'); return;
      case 'reviews':
        if (msg.origin === clientId) return;
        this.store.set({ reviews: msg.doc, reviewsRev: msg.rev, reviewsError: null });
        if (msg.origin === 'external' || msg.origin === 'vedit') {
          this.store.set({ claudeAt: Date.now() });
          notify('Claude updated the review comments', 'claude');
        }
        return;
      case 'reviewsError': this.store.set({ reviewsError: msg.error }); return;
      case 'mediaStatus':
        this.store.set((s) => ({ ...s, mediaStatus: { ...s.mediaStatus, [msg.mediaId]: msg.status } }));
        this.engine.invalidate(600);
        return;
      case 'prerender': this.store.set({ prerender: { enabled: msg.enabled, quality: msg.quality, paused: msg.paused, held: msg.held, on: msg.on || [], sequences: msg.sequences } }); return;
      case 'terminal': this.store.set({ terminal: msg.info }); return;
      case 'chat': this.store.set({ chat: msg.info }); return;
      case 'chats-live': this.store.set({ chatsLive: msg.live }); return;
      case 'chat-links': this.store.set({ chatLinks: msg.links || {} }); return;
      case 'notice': notify(msg.text, 'info', { timeout: 12000 }); return;
      case 'chat-notice': {
        // a chat finished (or waits for an answer): say so unless it is the one open in a visible panel
        if (msg.shown && this.ui.get().claudeOpen && !document.hidden) return;
        const what = msg.kind === 'ask' ? 'needs your answer' : msg.kind === 'error' ? 'stopped with an error' : 'finished';
        const open = msg.shown || !msg.sessionId ? null : {
          label: 'Open',
          run: async () => { this.ui.set({ claudeOpen: true }); (await import('../ui/ClaudeChat.js')).startChat(this.projectId, 'resume', msg.sessionId); },
        };
        notify(msg.sequence ? `The "${msg.sequence}" chat ${what}` : `Chat "${msg.title}" ${what}`, msg.kind === 'error' ? 'error' : 'claude', { action: open, timeout: 12000 });
        return;
      }
      default:
    }
  }

  onProject(msg) {
    if (msg.origin === clientId) return; // our own save echoed back
    if (msg.origin === 'server') {
      // background metadata fill: adopt unless we have unsaved local work
      if (this.saving || this.dragStart) { this.staleServer = true; return; }
      this.store.set({ doc: msg.doc, rev: msg.rev, warnings: msg.warnings || [] });
      this.engine.invalidate();
      return;
    }
    const prev = this.dragStart || this.doc; // mid-drag, this.doc is only the preview of the gesture
    this.dragStart = null;
    this.store.set({ doc: msg.doc, rev: msg.rev, projectError: null, warnings: msg.warnings || [], claudeAt: msg.origin === 'external' ? Date.now() : this.store.get().claudeAt });
    if (prev) {
      this.undoStack.push({ doc: prev, label: msg.origin === 'external' ? 'Claude edit' : msg.origin === 'import' ? 'Import media' : 'Remote edit' });
      this.redoStack = [];
      if (msg.origin === 'external') this.flashChanges(prev, msg.doc);
    }
    this.ensureSequence();
    this.engine.invalidate();
    if (msg.origin === 'external') notify('Claude updated the project', 'claude');
  }

  flashChanges(prev, next) {
    const seqId = this.ui.get().sequenceId;
    const a = findSequence(prev, seqId), b = findSequence(next, seqId);
    if (!b) return;
    const old = new Map((a?.clips || []).map((c) => [c.id, JSON.stringify(c)]));
    const ids = b.clips.filter((c) => old.get(c.id) !== JSON.stringify(c)).map((c) => c.id);
    if (ids.length) this.flash.set({ ids, at: Date.now() });
  }

  // ------------------------------------------------------------ editing

  // apply(label, (draftDoc, draftSeq) => { mutate; return false to cancel })
  apply(label, fn) {
    const before = this.doc;
    if (!before) return false;
    if (!this.canEdit()) return false;
    const draft = deepClone(before);
    if (fn(draft, this.seqIn(draft)) === false) return false;
    for (const sq of draft.sequences || []) resolveOverlaps(sq);
    this.commitDoc(normalizeProject(draft).project, before, label);
    return true;
  }

  commitDoc(next, before, label) {
    this.undoStack.push({ doc: before, label });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.store.set({ doc: next });
    this.engine.invalidate();
    this.save();
  }

  // Transient edits (drags): begin() → preview(fn)… → end(label)
  begin() {
    if (!this.dragStart) this.dragStart = this.doc;
  }
  preview(fn) {
    // a gesture whose begin() was cancelled (e.g. Claude's edit arrived mid-drag) restarts from the current doc
    if (!this.dragStart) this.dragStart = this.doc;
    if (!this.dragStart) return;
    const draft = deepClone(this.dragStart);
    fn(draft, this.seqIn(draft));
    this.store.set({ doc: draft });
    this.engine.invalidate();
  }
  end(label) {
    const start = this.dragStart;
    this.dragStart = null;
    if (!start) return;
    if (this.doc === start) { this.catchUp(); return; }
    if (this.store.get().projectError) {
      this.store.set({ doc: start });
      notify('project.json has a syntax error. Fix it before editing.', 'error');
      return;
    }
    for (const sq of this.doc.sequences || []) resolveOverlaps(sq);
    this.commitDoc(normalizeProject(this.doc).project, start, label);
  }
  cancelDrag() {
    if (this.dragStart) {
      this.store.set({ doc: this.dragStart });
      this.dragStart = null;
      this.engine.invalidate();
      this.catchUp();
    }
  }
  // A background update from the server arrived while a drag or save was under way: take it now.
  catchUp() {
    if (!this.staleServer || this.saving || this.savePending) return;
    this.staleServer = false;
    this.refresh().catch(() => {});
  }
  canEdit() {
    if (!this.store.get().projectError) return true;
    notify('project.json has a syntax error. Fix it (or ask Claude to) before editing.', 'error');
    return false;
  }

  undo() {
    if (!this.undoStack.length || !this.canEdit()) return;
    const e = this.undoStack.pop();
    this.redoStack.push({ doc: this.doc, label: e.label });
    this.store.set({ doc: e.doc });
    this.ensureSequence();
    this.engine.invalidate();
    this.save();
    notify(`Undo: ${e.label}`);
  }
  redo() {
    if (!this.redoStack.length || !this.canEdit()) return;
    const e = this.redoStack.pop();
    this.undoStack.push({ doc: this.doc, label: e.label });
    this.store.set({ doc: e.doc });
    this.ensureSequence();
    this.engine.invalidate();
    this.save();
    notify(`Redo: ${e.label}`);
  }

  async save() {
    if (this.saving) { this.savePending = true; return; }
    this.saving = true;
    try {
      do {
        this.savePending = false;
        const doc = this.doc;
        const res = await put(`/api/p/${this.projectId}/project`, { doc, baseRev: this.store.get().rev, clientId });
        if (res.status === 409) {
          this.store.set({ doc: res.doc, rev: res.rev });
          this.ensureSequence();
          this.engine.invalidate();
          notify('Claude changed the project at the same moment — your last change was not applied.', 'warn');
          this.savePending = false;
          break;
        }
        if (res.status === 423) {
          this.store.set({ projectError: res.error });
          notify(res.error, 'error');
          break;
        }
        this.store.set({ rev: res.rev });
      } while (this.savePending);
    } catch (err) {
      notify(`Couldn't save: ${err.message}`, 'error');
    } finally {
      this.saving = false;
      this.catchUp();
    }
  }

  async restoreLastGood() {
    const res = await put(`/api/p/${this.projectId}/project`, { doc: this.doc, clientId, force: true });
    if (res.rev) this.store.set({ rev: res.rev, projectError: null });
  }

  // Reviews: mutators are replayed on the latest server copy if someone else changed it meanwhile.
  updateReviews(fn) {
    this.reviewChain = this.reviewChain.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const base = this.reviews;
        const draft = deepClone(base);
        if (fn(draft) === false) return;
        this.store.set({ reviews: draft });
        const res = await put(`/api/p/${this.projectId}/reviews`, { doc: draft, baseRev: this.store.get().reviewsRev, clientId });
        if (res.status === 409) { this.store.set({ reviews: res.doc, reviewsRev: res.rev }); continue; }
        this.store.set({ reviewsRev: res.rev });
        return;
      }
      notify('Could not save the review change — please try again.', 'error');
    }).catch((err) => notify(`Review save failed: ${err.message}`, 'error'));
    return this.reviewChain;
  }

  // ------------------------------------------------------------ selection / focus

  select(ids, { add = false, toggle = false } = {}) {
    let sel = add || toggle ? [...this.ui.get().selection] : [];
    for (const id of ids) {
      const i = sel.indexOf(id);
      if (toggle && i >= 0) sel.splice(i, 1);
      else if (i < 0) sel.push(id);
    }
    this.ui.set({ selection: sel });
  }

  setSequence(id) {
    this.engine.pause();
    this.ui.set({ sequenceId: id, selection: [] });
    this.engine.seek(0);
  }

  reportFocus() {
    clearTimeout(this._focusTimer);
    this._focusTimer = setTimeout(() => {
      if (!this.projectId || this.store.get().status !== 'ready') return;
      const ui = this.ui.get();
      post(`/api/p/${this.projectId}/focus`, {
        mode: ui.mode, sequenceId: this.seq?.id, time: Math.round(this.time.get().t * 1000) / 1000,
        selection: ui.selection, version: ui.reviewVersion,
      }).catch(() => {});
    }, 700);
  }

  // Look for missing or failed footage again (e.g. after reconnecting a drive) without reopening the project.
  async reloadMedia({ quiet = false } = {}) {
    if (this._reloading) return;
    this._reloading = true;
    try {
      await post(`/api/p/${this.projectId}/media/refresh`, { quick: true });
      this.engine.reloadMedia();
      const st = this.store.get().mediaStatus;
      const bad = (this.doc?.media || []).filter((m) => st[m.id]?.exists === false || st[m.id]?.error).length;
      if (!quiet) notify(bad ? `${bad} file${bad > 1 ? 's are' : ' is'} still missing` : 'Footage reloaded', bad ? 'error' : 'success');
    } catch (err) {
      if (!quiet) notify(`Couldn't reload footage: ${err.message}`, 'error');
    } finally { this._reloading = false; }
  }

  // anything offline? check again when the window comes back to the front, and every few seconds meanwhile
  watchMissing() {
    // the timer only looks for files that are gone (cheap); focus also retries ones that failed to read or play
    const missing = (all) => {
      const st = this.store.get().mediaStatus;
      return (this.doc?.media || []).some((m) => st[m.id]?.exists === false || (all && st[m.id]?.error)) || (all && this.engine.hasErrors());
    };
    const check = (all) => { if (document.visibilityState === 'visible' && missing(all)) { this.reloadMedia({ quiet: true }); return true; } return false; };
    // a drive that stays offline (a network share that isn't connected) is looked at less and less often:
    // 8 s, 16 s … up to 2 min; coming back to the window looks at once and starts over
    let delay = 8000, timer = null;
    const tick = () => { delay = check(false) ? Math.min(delay * 2, 120000) : 8000; timer = setTimeout(tick, delay); };
    timer = setTimeout(tick, delay);
    const onFocus = () => { delay = 8000; check(true); };
    window.addEventListener('focus', onFocus);
    this.unsubs.push(() => { clearTimeout(timer); window.removeEventListener('focus', onFocus); });
  }

  dispose() {
    clearTimeout(this._focusTimer);
    for (const u of this.unsubs) u();
    if (this.projectId) socket.unsubscribe(this.projectId);
    this.engine.dispose();
  }
}
