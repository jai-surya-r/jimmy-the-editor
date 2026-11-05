// The exact frame on pause: the browser decodes video a little differently from the exports' ffmpeg, so a moment after
// the playhead stops, the same frame is rendered the way an export renders it and shown over the live preview. Anything
// that changes the picture (playing, scrubbing, an edit, a resize) hides it at once, so it can never be stale. A step of
// a few frames while it shows (the arrow keys) keeps it on: the next exact frame replaces it as soon as it is ready,
// instead of the live preview (proxies) flashing in between (Step 82). Steps in quick succession hide it.
// Settings › Exact frame when paused.
import { post } from '../core/api.js';
import { app } from '../core/app.js';
import { sequenceDuration } from '../core/model.js';

const SETTLE_MS = 350;
const STEP_FRAMES = 5; // a move this small (while an exact frame shows) keeps it on

export class ExactFrame {
  constructor(tab, img, live) {
    this.tab = tab;
    this.img = img; // () => the <img>
    this.live = live; // () => the Viewer's sizes
    this.key = '';
    this.doc = null;
    this.at = 0;
    this.done = false;
    this.busy = false;
  }

  hide() {
    const el = this.img();
    if (!el) return;
    el.classList.remove('is-on');
    el.parentElement?.classList.remove('has-exact');
  }

  // Called every frame by the Viewer's loop.
  tick(now) {
    const { tab } = this;
    const seq = tab.seq;
    const L = this.live();
    if (!this.img() || !seq) return;
    const frame = Math.round(tab.engine.t * seq.fps);
    const key = `${seq.id}:${frame}:${L.pxW}x${L.pxH}`;
    const off = tab.engine.playing || L.readOnly || app.get().server?.exactPause === false;
    if (key !== this.key || tab.doc !== this.doc || off) {
      // a frame step while the exact frame shows: it stays, and the next one is asked for right away
      const prev = this.key.split(':');
      const step = !off && this.done && tab.doc === this.doc && prev[0] === seq.id && prev[2] === `${L.pxW}x${L.pxH}`
        && Math.abs(frame - Number(prev[1])) <= STEP_FRAMES && !tab.dragStart && !document.body.classList.contains('is-scrubbing');
      if (step) {
        this.key = key;
        this.at = now - SETTLE_MS;
        this.done = false;
        this.holding = true;
        return;
      }
      if (this.key || this.done || this.holding) this.hide();
      this.holding = false;
      this.key = key;
      this.doc = tab.doc;
      this.at = now;
      this.done = false;
      return;
    }
    if (this.done || this.busy || now - this.at < SETTLE_MS) return;
    // the server renders what it has: wait for edits to reach it, and for a drag to end
    if (tab.saving || tab.savePending || tab.dragStart || tab.engine.t >= sequenceDuration(seq)) return;
    this.fetch(key, tab.doc, seq, Math.max(L.pxW, L.pxH));
  }

  async fetch(key, doc, seq, maxSide) {
    const { tab } = this;
    const same = () => key === this.key && doc === this.doc && !tab.engine.playing;
    this.busy = true;
    this.pending = key;
    try {
      const r = await post(`/api/p/${tab.projectId}/exact-frame`, { sequenceId: seq.id, time: Number(key.split(':')[1]) / seq.fps, maxSide });
      if (!same()) return;
      // decoded aside first, so the frame on screen is swapped for the next without a blank in between
      const src = `data:image/png;base64,${r.png}`;
      const next = new Image();
      next.src = src;
      await next.decode();
      if (!same()) return;
      const el = this.img();
      el.src = src;
      await el.decode().catch(() => {});
      if (!same()) return;
      el.classList.add('is-on');
      el.parentElement?.classList.add('has-exact');
      this.done = true;
      this.holding = false;
    } catch {
      if (same()) { this.done = true; if (this.holding) { this.hide(); this.holding = false; } } // the live preview stays; the next change of frame tries again
    } finally {
      this.busy = false;
      this.pending = null;
    }
  }
}
