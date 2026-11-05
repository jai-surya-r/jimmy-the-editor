// Background pre-rendering. While a project is open, the chunks (server/chunks.js) of the sequences it was turned on for
// (per sequence, off by default) are rendered in the background a few seconds after each edit — the user's or Claude's — so that an export
// is mostly a matter of stitching finished chunks together.
//
// It only ever uses capacity nobody is waiting for: exports and frame checks go first (an export takes
// over a slot that is pre-rendering), and it pauses while someone is playing or scrubbing, and on battery.
//
// The chunk cache is kept in check four ways: chunks that no longer match the timeline are removed
// after a grace period; a sequence's chunks are cleared when one of its review versions is approved;
// the cache of all projects together stays under a size cap (least recently used first); and
// Settings › Storage can clear it by hand.
//
// Lighter pre-rendering (Settings, on by default) keeps the disk quieter: only the project in the editor's
// active tab is pre-rendered; chunks that are one camera clip as it is (chunks.js isPlain: they play smoothly
// from their proxy anyway) wait until nobody has touched the editor for two minutes; and while someone is
// editing, rendering starts 20 s after the last change instead of 4 s, so a burst of edits renders once.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getConfig, updateConfig } from './config.js';
import { sha1, readJson, writeFileAtomic } from './util.js';
import { layoutFor } from './layout.js';
import { outputSpec } from './render.js';
import { planSequence, writeSpec, touch, sweepOutdated, enforceCap, clearSequence, approvedFile, chunksRoot } from './chunks.js';
import { sequenceDuration, isVisualClip } from '../public/js/core/model.js';

const SETTLE_MS = 4000; // wait this long after the last change before rendering
const SETTLE_EDITING_MS = 20000; // ... while someone is working in the editor (lighter pre-rendering)
const EDITING_MS = 15000; // a click or key this recent: someone is working in the editor
const PLAIN_IDLE_MS = 2 * 60 * 1000; // plain camera chunks wait for the editor to be idle this long
const SWEEP_EVERY_MS = 5 * 60 * 1000;

export class PrerenderManager {
  constructor({ projects, media, renders, emitProject, isOpen, isActive = () => true, idleMs = () => Infinity }) {
    this.projects = projects;
    this.media = media;
    this.renders = renders;
    this.emitProject = emitProject;
    this.isOpen = isOpen; // (projectId) => an editor tab has this project open
    this.isActive = isActive; // (projectId) => it is the active tab in an editor window
    this.idleMs = idleMs; // () => ms since the last click or key in an editor (or since playback stopped)
    this.timers = new Map();
    this.busy = new Map(); // projectId -> rerun requested while a run is in progress
    this.status = new Map(); // projectId -> { [seqId]: { total, ready, waiting, approved, frames, chunks } }
    this.versions = new Map(); // projectId -> Map(versionId -> status), to notice approvals
    this.held = new Set(); // projects whose cache was just cleared: wait for the next edit
    this.lastSweep = new Map();
    this.statusTimers = new Map();
    this.capTimer = setInterval(() => this.checkCap().catch(() => {}), SWEEP_EVERY_MS);
    this.capTimer.unref?.();
    setTimeout(() => this.checkCap().catch(() => {}), 20000).unref?.();
  }

  cfg() { return getConfig().prerender || {}; }
  light() { return this.cfg().light !== false; }
  settleMs() { return this.light() && this.idleMs() < EDITING_MS ? SETTLE_EDITING_MS : SETTLE_MS; }

  // The output settings chunks are pre-rendered with: a full-resolution H.264 export at this quality.
  spec(seq) {
    return outputSpec(seq, { quality: this.cfg().quality || 'high', format: 'h264', scale: 1 });
  }

  // ---------------------------------------------------------------- triggers

  // A project was opened in the editor.
  open(handle) {
    if (!this.versions.has(handle.id)) this.remember(handle.id, handle.reviews);
    this.schedule(handle.id, 2500, true);
  }

  // Everything the server tells the editor about a project passes through here.
  onEvent(projectId, msg) {
    if (msg.type === 'project') {
      if (msg.origin !== 'server') this.held.delete(projectId);
      this.schedule(projectId, this.settleMs());
    } else if (msg.type === 'mediaStatus') {
      this.schedule(projectId, this.settleMs(), true); // proxies report progress constantly: don't keep pushing the run back
    } else if (msg.type === 'reviews') {
      this.checkApprovals(projectId, msg.doc);
    }
  }

  // keep: leave an already scheduled run where it is
  schedule(projectId, ms = this.settleMs(), keep = false) {
    if (keep && this.timers.has(projectId)) return;
    clearTimeout(this.timers.get(projectId));
    this.timers.set(projectId, setTimeout(() => {
      this.timers.delete(projectId);
      this.run(projectId).catch((err) => console.warn('[prerender]', err.message));
    }, ms));
  }
  scheduleAll(ms = 1000) {
    for (const id of this.projects.handles.keys()) this.schedule(id, ms);
  }

  // ---------------------------------------------------------------- planning

  // The sequences pre-rendering was turned on for, one by one (right-click a sequence › Pre-render this sequence);
  // every other sequence is left alone. Kept in config.json as prerender.on = { projectId: [sequenceId] }.
  chosen(projectId) {
    return new Set(this.cfg().on?.[projectId] || []);
  }

  async choose(projectId, seqId, on) {
    const all = { ...(this.cfg().on || {}) };
    const ids = this.chosen(projectId);
    if (on) ids.add(seqId); else ids.delete(seqId);
    if (ids.size) all[projectId] = [...ids]; else delete all[projectId];
    await updateConfig({ prerender: { ...this.cfg(), on: all } });
    if (on) this.held.delete(projectId); // asked for by hand: start now, even right after the cache was cleared
    else this.renders.setBackground(projectId, seqId, []);
    this.schedule(projectId, 300);
  }

  // Sequences to pre-render: the chosen ones, the one the user is looking at first.
  targets(handle) {
    const ids = this.chosen(handle.id);
    const focus = handle.focus?.sequenceId;
    return handle.doc.sequences.filter((s) => ids.has(s.id) && s.clips.some((c) => isVisualClip(c) && c.enabled !== false))
      .sort((a, b) => (b.id === focus) - (a.id === focus));
  }

  async run(projectId) {
    if (this.busy.has(projectId)) { this.busy.set(projectId, true); return; }
    this.busy.set(projectId, false);
    try {
      const handle = this.projects.handles.get(projectId);
      if (!handle?.doc) { this.renders.clearBackground(projectId); this.status.delete(projectId); return; }
      // it also waits for the preview proxies the viewer needs (each finished one schedules another look)
      const on = this.cfg().enabled !== false && !handle.error && this.isOpen(projectId) && !this.held.has(projectId)
        && !this.media.proxiesPending(projectId) && (!this.light() || this.isActive(projectId));
      const wanted = on ? this.targets(handle) : [];
      const status = {};
      for (const seq of wanted) status[seq.id] = await this.planSequence(handle, seq);
      // sequences that are no longer targets (or pre-rendering was switched off): drop what was queued for them
      for (const seqId of Object.keys(this.status.get(projectId) || {})) if (!status[seqId]) this.renders.setBackground(projectId, seqId, []);
      if (!on) this.renders.clearBackground(projectId);
      this.status.set(projectId, status);
      this.emitStatus(projectId, true);
      if (Date.now() - (this.lastSweep.get(projectId) || 0) > SWEEP_EVERY_MS) {
        this.lastSweep.set(projectId, Date.now());
        const n = await sweepOutdated(handle, this.media).catch(() => 0);
        if (n) console.log(`[prerender] ${handle.doc.name}: removed ${n} outdated chunk${n === 1 ? '' : 's'}`);
      }
    } finally {
      const again = this.busy.get(projectId);
      this.busy.delete(projectId);
      if (again) this.schedule(projectId, 500);
    }
  }

  async planSequence(handle, seq) {
    const frames = Math.round(sequenceDuration(seq) * seq.fps);
    const spec = this.spec(seq);
    const plan = await planSequence({ handle, doc: handle.doc, seq, spec, media: this.media, startFrame: 0, frameCount: frames });
    const sig = sha1(plan.chunks.map((c) => c.fp).join(''));
    const marker = await readJson(approvedFile(handle.layout, seq.id));
    if (marker) {
      // approved and unchanged since: nothing to keep ready. The first edit brings pre-rendering back.
      if (marker.sig === sig) { this.renders.setBackground(handle.id, seq.id, []); return { total: plan.chunks.length, ready: 0, waiting: 0, approved: true, frames, chunks: [] }; }
      await fsp.unlink(approvedFile(handle.layout, seq.id)).catch(() => {});
    }
    const have = new Set(plan.chunks.filter((c) => fs.existsSync(c.file)));
    for (const c of have) touch(c.file);
    // lighter pre-rendering: plain camera chunks only once the editor has been idle a while (looked at again then)
    const idle = this.idleMs();
    const plainOk = !this.light() || idle >= PLAIN_IDLE_MS;
    const missing = plan.chunks.filter((c) => !have.has(c) && c.ready && (plainOk || !c.plain));
    if (!plainOk && plan.chunks.some((c) => !have.has(c) && c.ready && c.plain)) this.schedule(handle.id, PLAIN_IDLE_MS - idle + 1000, true);
    // nearest the playhead first
    const at = handle.focus?.sequenceId === seq.id ? Math.round((handle.focus.time || 0) * seq.fps) : 0;
    missing.sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at));
    if (missing.length) await writeSpec(plan.dir, spec);
    const tasks = this.renders.setBackground(handle.id, seq.id, missing.map((chunk) => ({ handle, fps: seq.fps, spec, chunk })));
    for (const t of tasks) {
      if (t.watched) continue;
      t.watched = true;
      t.done.then((r) => this.onChunk(handle.id, seq.id, t.key, r));
    }
    return {
      total: plan.chunks.length, ready: have.size, waiting: plan.chunks.length - have.size - missing.length, frames, sig,
      chunks: plan.chunks.map((c) => ({ start: c.start, end: c.start + c.count, file: c.file, ready: have.has(c) })),
    };
  }

  onChunk(projectId, seqId, file, result) {
    const st = this.status.get(projectId)?.[seqId];
    if (result.ok) {
      let changed = false;
      // identical chunks (a long still or title) share one file: every one of them is ready now
      for (const c of st?.chunks || []) if (c.file === file && !c.ready) { c.ready = true; st.ready = Math.min(st.total, st.ready + 1); changed = true; }
      if (changed) this.emitStatus(projectId);
    } else if (!result.dropped) {
      console.warn(`[prerender] chunk failed: ${result.error}`);
    }
  }

  emitStatus(projectId, now = false) {
    const fire = () => {
      this.statusTimers.delete(projectId);
      this.emitProject(projectId, { type: 'prerender', projectId, ...this.info(projectId) });
    };
    if (now) { clearTimeout(this.statusTimers.get(projectId)); fire(); return; }
    if (!this.statusTimers.has(projectId)) this.statusTimers.set(projectId, setTimeout(fire, 1000));
  }

  info(projectId) {
    const c = this.cfg();
    // per sequence: counts, and the rendered stretches as [startFrame, endFrame) runs (for the timeline's render bar)
    const sequences = {};
    for (const [seqId, st] of Object.entries(this.status.get(projectId) || {})) {
      const runs = [];
      for (const ch of st.chunks || []) {
        if (!ch.ready) continue;
        const last = runs[runs.length - 1];
        if (last && last[1] === ch.start) last[1] = ch.end; else runs.push([ch.start, ch.end]);
      }
      sequences[seqId] = { total: st.total, ready: st.ready, waiting: st.waiting, approved: !!st.approved, frames: st.frames, runs };
    }
    return { enabled: c.enabled !== false, light: this.light(), quality: c.quality || 'high', paused: this.renders.bgPaused, held: this.held.has(projectId), on: [...this.chosen(projectId)], sequences };
  }

  // How much of a sequence is already rendered at pre-render quality (0–1). Used to decide whether a
  // review render can be full quality right away.
  async coverage(handle, seq) {
    const frames = Math.round(sequenceDuration(seq) * seq.fps);
    if (frames < 1) return 0;
    const plan = await planSequence({ handle, doc: handle.doc, seq, spec: this.spec(seq), media: this.media, startFrame: 0, frameCount: frames });
    return plan.chunks.reduce((n, c) => n + (fs.existsSync(c.file) ? c.count : 0), 0) / frames;
  }

  // ---------------------------------------------------------------- cleanup

  remember(projectId, reviews) {
    this.versions.set(projectId, new Map((reviews?.versions || []).map((v) => [v.id, v.status])));
  }

  // A version just went to Approved: that sequence is finished, so its chunks are cleared.
  checkApprovals(projectId, reviews) {
    const before = this.versions.get(projectId);
    this.remember(projectId, reviews);
    if (!before) return;
    const seqs = new Set();
    for (const v of reviews?.versions || []) if (v.status === 'approved' && before.get(v.id) !== 'approved' && v.sequence) seqs.add(v.sequence);
    const handle = this.projects.handles.get(projectId);
    if (!handle?.doc) return;
    for (const seqId of seqs) this.approved(handle, seqId).catch((err) => console.warn('[prerender] approve:', err.message));
  }

  async approved(handle, seqId) {
    const seq = handle.doc.sequences.find((s) => s.id === seqId);
    if (!seq) return;
    const frames = Math.round(sequenceDuration(seq) * seq.fps);
    const plan = frames > 0 ? await planSequence({ handle, doc: handle.doc, seq, spec: this.spec(seq), media: this.media, startFrame: 0, frameCount: frames }) : { chunks: [] };
    const sig = sha1(plan.chunks.map((c) => c.fp).join(''));
    if ((await readJson(approvedFile(handle.layout, seqId)))?.sig === sig) return; // already cleared for this exact timeline
    this.renders.setBackground(handle.id, seqId, []);
    await clearSequence(handle.layout, seqId);
    await fsp.mkdir(chunksRoot(handle.layout), { recursive: true });
    await writeFileAtomic(approvedFile(handle.layout, seqId), JSON.stringify({ sig, at: new Date().toISOString() }));
    console.log(`[prerender] ${handle.doc.name}: "${seq.name}" approved — its pre-rendered chunks were cleared`);
    this.schedule(handle.id, 500);
  }

  // The cache was cleared by hand (Settings › Storage): don't fill it straight back up.
  cleared(projectId) {
    this.held.add(projectId);
    this.renders.clearBackground(projectId);
    this.schedule(projectId, 200);
  }

  async checkCap() {
    const maxGB = Number(this.cfg().maxGB);
    if (!(maxGB > 0)) return;
    const layouts = (await this.projects.list()).map((p) => layoutFor(p.dir));
    const r = await enforceCap(layouts, maxGB * 1024 ** 3);
    if (!r.removed) return;
    console.log(`[prerender] chunk cache over ${maxGB} GB: removed the ${r.removed} least recently used chunks`);
    // the cache is full: don't render straight back what was just removed — wait for the next edit
    for (const id of this.projects.handles.keys()) { this.held.add(id); this.schedule(id, 200); }
  }
}
