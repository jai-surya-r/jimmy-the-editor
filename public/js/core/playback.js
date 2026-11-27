// Live preview engine: keeps one <video>/<audio> element per clip in sync with the playhead,
// mixes audio through Web Audio (per-clip gain = volume × fades × keyframes × track volume)
// and feeds the compositor with the current frames.
import {
  resolveFrame, clipActiveAt, clipSourceTime, audibleTracks, audioGainAt, sequenceDuration,
} from './model.js';
import { OFFLINE } from './compositor.js';
import { mediaUrl, post, socket } from './api.js';
import { noteAudio } from './perf.js';

// Browsers refuse a playbackRate outside this range (the assignment throws), e.g. a 5% clip or a 4x clip shuttled at 8x.
const mediaRate = (r) => Math.min(16, Math.max(0.0625, r));

let graph = null;
// Bumped when the audio graph is replaced (rebuildAudio): every engine then makes its clips' audio again on the new one.
let graphGen = 0;
export function audioGraph() {
  if (!graph) {
    const actx = new AudioContext({ latencyHint: 'interactive' });
    const mix = actx.createGain(); // every clip plays into this; master is the Review page's volume after it
    const master = actx.createGain();
    mix.connect(master);
    master.connect(actx.destination);
    // the timeline's level meter: always two channels, so a mono clip shows on both sides
    const tap = actx.createGain();
    tap.channelCount = 2;
    tap.channelCountMode = 'explicit';
    const split = actx.createChannelSplitter(2);
    mix.connect(tap).connect(split);
    const meters = [0, 1].map((ch) => { const a = actx.createAnalyser(); a.fftSize = 2048; split.connect(a, ch); return a; });
    graph = { actx, mix, master, meters };
  }
  return graph;
}
export function resumeAudio() {
  const { actx } = audioGraph();
  if (actx.state !== 'running') actx.resume().catch(() => {});
}
// An audio context whose clock stopped while it should be playing (its output device went away, or the system's
// audio was starved while the machine was busy rendering) stays silent: replace it, keeping the master volume.
let rebuiltAt = 0;
function rebuildAudio(why) {
  const now = performance.now();
  if (now - rebuiltAt < 10000) return false; // not in a loop: once every 10 s at most
  rebuiltAt = now;
  const old = graph;
  graph = null;
  graphGen++;
  const g = audioGraph();
  if (old) {
    g.master.gain.value = old.master.gain.value;
    old.actx.close().catch(() => {});
  }
  g.actx.resume().catch(() => {});
  noteAudio(`audio output rebuilt: ${why}`);
  return true;
}

export class PlaybackEngine {
  constructor(tab) {
    this.tab = tab;
    // Media elements are pooled per source file: a cut-up A-roll reuses one or two decoders instead of
    // opening one <video> per clip (each one is a full decoder — that's what made playback stutter).
    this.videos = new Map(); // entryKey -> entry
    this.audios = new Map(); // entryKey -> entry
    this.clipVideo = new Map(); // clipId -> entry
    this.clipAudio = new Map(); // clipId -> entry
    this.frameNo = 0;
    this.nextKey = 1;
    this.images = new Map(); // mediaId -> { img, state, url }
    this.lastOk = new Map(); // mediaId -> the last preview url that could be shown (see previewInfo)
    this.playing = false;
    this.rate = 1;
    this.t = tab.time.get().t || 0;
    this.last = 0;
    this.drawUntil = 0;
    this.loop = false;
    this.frame = [];
    this.audioGen = graphGen;
  }

  get seq() { return this.tab.playSeq; } // nested sequences play their contents

  invalidate(ms = 300) {
    this.drawUntil = Math.max(this.drawUntil, performance.now() + ms);
    this.wake();
  }
  // the Viewer's loop sleeps while nothing changes; this wakes it (a redraw asked for, a hover on the picture)
  onWake(fn) { (this.wakers ||= new Set()).add(fn); return () => this.wakers.delete(fn); }
  wake() { for (const fn of this.wakers || []) fn(); }
  // While playing, the picture (and everything that follows the playhead) changes once per frame of the sequence,
  // not on every refresh of the screen (often 60–144 a second): drawing in between only kept the page busy.
  needsDraw(now) {
    if (this.playing) return this.playFrame() !== this.drawnFrame;
    // paused, after a change (a step, a seek, an edit): about 30 times a second while the sources settle
    return now < this.drawUntil && now - (this.drawnAt || 0) >= 30;
  }
  frameIndex() { return Math.floor(this.t * (this.seq?.fps || 30) + 1e-6); }
  // the frame playing: only forward (backward for reverse play). The clock's small pulls toward the audio can move
  // the time back across a frame's start, which would draw and publish the same frame twice; a real jump (a loop)
  // still counts.
  playFrame() {
    const f = this.frameIndex(), last = this.lastPlayFrame;
    if (last != null && Math.abs(f - last) <= 2 && Math.sign(f - last) === -Math.sign(this.rate)) return last;
    this.lastPlayFrame = f;
    return f;
  }
  drawn() { this.drawnFrame = this.playing ? this.playFrame() : null; this.drawnAt = performance.now(); }

  // ------------------------------------------------------------ transport

  play() {
    const seq = this.seq;
    if (!seq || this.playing) return;
    resumeAudio();
    const dur = sequenceDuration(seq);
    if (this.rate > 0 && this.t >= dur - 1 / seq.fps) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    this.shownFrame = null;
    this.drawnFrame = null;
    this.lastPlayFrame = null;
    this.syncedFrame = null;
    this.syncedAt = 0;
    this.clockSince = null; // watchAudio starts counting afresh
    this.tab.time.set({ t: this.t, playing: true });
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const e of this.videos.values()) if (!e.el.paused) e.el.pause();
    for (const e of this.audios.values()) { if (!e.el.paused) e.el.pause(); }
    // land on a whole frame
    const fps = this.seq?.fps || 30;
    this.t = Math.round(this.t * fps) / fps;
    this.tab.time.set({ t: this.t, playing: false });
    this.invalidate();
  }
  toggle() {
    if (this.playing) this.pause();
    else { this.rate = 1; this.play(); }
  }
  shuttle(dir) {
    // J / L: each press doubles speed in that direction; K stops
    if (dir === 0) { this.rate = 1; this.pause(); return; }
    if (!this.playing || Math.sign(this.rate) !== dir) this.rate = dir;
    else this.rate = Math.max(-8, Math.min(8, this.rate * 2));
    if (!this.playing) this.play();
    else this.tab.time.set({ playing: true });
  }
  seek(t) {
    const seq = this.seq;
    const dur = seq ? sequenceDuration(seq) : 0;
    this.t = Math.max(0, Math.min(t, Math.max(dur, 0)));
    this.tab.time.set({ t: this.t });
    this.invalidate();
  }
  step(frames) {
    const fps = this.seq?.fps || 30;
    this.pause();
    this.seek(Math.round(this.t * fps + frames) / fps);
  }

  // ------------------------------------------------------------ media urls

  previewInfo(mid) {
    const st = this.tab.store.get().mediaStatus[mid];
    if (!st) return { state: 'loading' };
    if (st.exists === false) return { state: 'offline' };
    // a new version of a file the viewer showed before (a motion graphic rendered again, footage replaced) whose
    // preview isn't ready yet: the previous one stays on screen meanwhile. Without it, a graphic would play live
    // (its page running inside the editor, LiveMotionLayers) until the new render's proxy is made.
    const last = this.lastOk.get(mid);
    if (!st.probed) return last ? { state: 'ok', url: last, stale: true } : { state: 'loading' };
    if (st.error && st.proxy !== 'ready') return { state: 'offline' };
    if (st.browserOk === false && st.proxy !== 'ready') return last ? { state: 'ok', url: last, stale: true } : { state: 'proxy', progress: st.proxyProgress || 0 };
    const url = mediaUrl(this.tab.projectId, mid, 'preview', `${st.key}${st.proxy === 'ready' ? 'p' : ''}`);
    this.lastOk.set(mid, url);
    return { state: 'ok', url };
  }

  makeEl(kind, url, entry) {
    const el = document.createElement(kind);
    el.preload = 'auto';
    if (kind === 'video') { el.muted = true; el.playsInline = true; }
    el.addEventListener('loadeddata', () => this.invalidate());
    el.addEventListener('seeked', () => {
      if (entry.pending != null && Math.abs(entry.pending - el.currentTime) > 0.001) {
        const p = entry.pending;
        entry.pending = null;
        el.currentTime = p;
      } else entry.pending = null;
      this.invalidate();
    });
    el.addEventListener('error', () => {
      if (!el.getAttribute('src')) return; // released on purpose
      entry.error = true;
      entry.errAt = performance.now();
      noteAudio(`${kind} element failed (code ${el.error?.code ?? '?'}${el.error?.message ? `: ${el.error.message}` : ''}) for ${entry.mediaId || 'a file'}`);
      this.invalidate();
      // the browser can't decode this file — ask the server for a proxy
      if (entry.mediaId) post(`/api/p/${this.tab.projectId}/media/${entry.mediaId}/proxy`).catch(() => {});
    });
    el.src = url;
    return el;
  }

  release(e) {
    try {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
      e.node?.disconnect();
      e.gain?.disconnect();
    } catch { /* ignore */ }
  }

  ensureImage(mid) {
    const info = this.previewInfo(mid);
    let im = this.images.get(mid);
    if (info.state !== 'ok') return im || null;
    if (!im || im.url !== info.url) {
      const img = new Image();
      im = { img, url: info.url, state: 'loading' };
      img.onload = () => { im.state = 'ok'; this.invalidate(); };
      img.onerror = () => { im.state = 'error'; this.invalidate(); };
      img.src = info.url;
      this.images.set(mid, im);
    }
    return im;
  }

  // A failed element (a read that broke off while the disk was busy rendering, say) is not kept for good: after a
  // second it is dropped, so the clip gets a new one. A file that keeps failing is tried 5 times a minute at most
  // (it shows as offline meanwhile; the server is also asked for a playable copy).
  retryFailed(pool, byClip, e) {
    const now = performance.now();
    if (now - (e.errAt || 0) < 1000) return false;
    const r = (this.retries ||= new Map()).get(e.url);
    const tries = r && now - r.at < 60000 ? r : { n: 0, at: now };
    if (tries.n >= 5) return false;
    tries.n++;
    this.retries.set(e.url, tries);
    this.release(e);
    pool.delete(e.key);
    for (const [cid, x] of byClip) if (x === e) byClip.delete(cid);
    noteAudio(`trying a failed ${pool === this.audios ? 'audio' : 'video'} element again (${tries.n} of 5 this minute)`);
    return true;
  }

  // Element for this clip: the one it already holds, else a free pooled one for the same file, else a new one.
  acquire(pool, byClip, c, url, create) {
    let e = byClip.get(c.id);
    if (e?.error && this.retryFailed(pool, byClip, e)) e = null;
    if (e && (e.owner !== c.id || e.url !== url || !pool.has(e.key) || e.frame === this.frameNo)) e = null;
    if (!e) {
      for (const x of pool.values()) if (x.url === url && x.frame !== this.frameNo && !x.error) { e = x; break; }
      if (!e) {
        e = { key: this.nextKey++, url, mediaId: c.media, clip: c, used: 0, error: false, pending: null };
        create(e);
        pool.set(e.key, e);
      }
      e.owner = c.id;
      byClip.set(c.id, e);
    }
    e.frame = this.frameNo;
    return e;
  }

  syncVideo(c, srcTime, playing, now) {
    const info = this.previewInfo(c.media);
    if (info.state !== 'ok') return;
    const e = this.acquire(this.videos, this.clipVideo, c, info.url, (x) => { x.el = this.makeEl('video', info.url, x); });
    e.clip = c;
    e.used = now;
    const el = e.el;
    const m = this.tab.mediaById[c.media];
    const target = Math.max(0, Math.min(srcTime, (m?.duration || 1e9) - 0.03));
    if (playing) {
      const rate = mediaRate((c.speed || 1) * this.rate);
      if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
        if (!el.ended) el.play()?.catch((err) => this.playRefused(e, 'video', err)); // play() on a finished file would restart it from 0
      } else if (!el.seeking && Math.abs(el.currentTime - target) > 0.3) {
        el.currentTime = target;
      }
    } else {
      if (!el.paused) el.pause();
      const fps = this.seq.fps;
      if (Math.abs(el.currentTime - target) > 0.45 / fps) {
        if (el.seeking) e.pending = target;
        else el.currentTime = target;
      }
    }
  }

  syncAudio(c, srcTime, playing, gain, now) {
    const info = this.previewInfo(c.media);
    if (info.state !== 'ok') return;
    const e = this.acquire(this.audios, this.clipAudio, c, info.url, (x) => {
      x.el = this.makeEl('audio', info.url, x);
      x.el.preservesPitch = true;
      const { actx, mix } = audioGraph();
      x.node = actx.createMediaElementSource(x.el);
      x.gain = actx.createGain();
      x.gain.gain.value = 0;
      x.node.connect(x.gain).connect(mix);
    });
    e.clip = c;
    e.used = now;
    const el = e.el;
    const { actx } = audioGraph();
    e.gain.gain.setTargetAtTime(playing ? gain : 0, actx.currentTime, 0.012);
    const m = this.tab.mediaById[c.media];
    const target = Math.max(0, Math.min(srcTime, (m?.duration || 1e9) - 0.03));
    if (playing) {
      const rate = mediaRate((c.speed || 1) * this.rate);
      if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
        if (!el.ended) el.play()?.catch((err) => this.playRefused(e, 'audio', err));
      } else if (!el.seeking && Math.abs(el.currentTime - target) > 0.2) {
        el.currentTime = target;
      }
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
    }
  }

  // play() said no. Interrupted by a seek or a pause (AbortError): nothing wrong, the next frame asks again. Not
  // allowed (the audio isn't unlocked): unlock it. The file can't be played (NotSupportedError): it counts as failed,
  // so it is made again (retryFailed) instead of being asked to play, silently, on every frame.
  playRefused(e, kind, err) {
    if (err?.name === 'AbortError') return;
    if (err?.name === 'NotAllowedError') { resumeAudio(); return; }
    if (!e.error) noteAudio(`${kind} play() refused: ${err?.name || 'error'}${err?.message ? ` (${err.message})` : ''}`);
    e.error = true;
    e.errAt = performance.now();
    this.invalidate();
  }

  // While playing: is the audio output actually running? A context that the system suspended is resumed; one whose
  // clock stands still although clips should be sounding (the output stalled under load) is replaced (rebuildAudio),
  // and every clip's audio is made again on the new one at the next frame.
  watchAudio(now) {
    const { actx } = audioGraph();
    const sounding = [...this.audios.values()].some((e) => !e.el.paused && !e.el.seeking && e.el.readyState >= 3 && clipActiveAt(e.clip, this.t));
    if (!sounding) { this.clockSince = null; return; }
    if (actx.state !== 'running' && now - (this.resumedAt || 0) > 500) {
      this.resumedAt = now;
      noteAudio(`audio output was "${actx.state}" while playing: resumed`);
      actx.resume().catch(() => {});
    }
    if (this.clockSince == null || actx.currentTime !== this.clockAt) { this.clockSince = now; this.clockAt = actx.currentTime; return; }
    if (now - this.clockSince > 1500 && rebuildAudio(`its clock stood still for ${Math.round(now - this.clockSince)} ms while playing (state "${actx.state}")`)) this.clockSince = null;
  }

  // Time implied by a playing element, used to keep the wall clock honest.
  masterTime() {
    for (const map of [this.audios, this.videos]) {
      for (const e of map.values()) {
        const el = e.el;
        if (el.paused || el.seeking || el.readyState < 3 || !clipActiveAt(e.clip, this.t)) continue;
        return e.clip.start + (el.currentTime - (e.clip.in || 0)) / (e.clip.speed || 1);
      }
    }
    return null;
  }

  // Frames came late while playing: several in two seconds and the server eases off background renders.
  stutter(now) {
    this.late = (this.late || []).filter((x) => now - x < 2000);
    this.late.push(now);
    if (this.late.length >= 4 && now - (this.lagSent || 0) > 3000) {
      this.lagSent = now;
      this.late = [];
      socket.send({ type: 'activity', lag: true });
    }
  }

  // ------------------------------------------------------------ per-frame

  tick(now) {
    const seq = this.seq;
    if (!seq) return;
    if (this.playing) {
      if (now - this.last > 70 && now - this.last < 1000 && !document.hidden) this.stutter(now);
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      let t = this.t + dt * this.rate;
      if (this.rate === 1) {
        const m = this.masterTime();
        if (m != null && Math.abs(m - t) < 0.3) t += (m - t) * 0.2;
      }
      const dur = sequenceDuration(seq);
      const loopOn = this.loop && seq.inPoint != null && seq.outPoint != null && seq.outPoint > seq.inPoint;
      const end = loopOn ? seq.outPoint : dur;
      if (this.rate > 0 && t >= end) {
        if (loopOn) t = seq.inPoint;
        else if (this.loop && dur > 0) t = 0;
        else { this.t = end; this.pause(); this.sync(now); return; }
      }
      if (this.rate < 0 && t <= 0) { this.t = 0; this.pause(); this.sync(now); return; }
      this.t = t;
      // the playhead's time for the page: once per frame (the timeline, timecodes and time bars redraw on it)
      const f = this.playFrame();
      if (f !== this.shownFrame) { this.shownFrame = f; this.tab.time.set({ t }); }
      if (this.rate > 0) this.watchAudio(now);
      // the sources follow the playhead once per frame too (and at least 10 times a second, for their drift)
      if (f === this.syncedFrame && now - this.syncedAt < 100) return;
      this.syncedFrame = f;
      this.syncedAt = now;
    } else if (!this.needsDraw(now)) return; // idle: nothing changed, leave the media alone
    this.sync(now);
  }

  sync(now) {
    // the audio output was replaced (rebuildAudio): this tab's clip audio belongs to the old one, so make it again
    if (this.audioGen !== graphGen) {
      for (const e of this.audios.values()) this.release(e);
      this.audios.clear();
      this.clipAudio.clear();
      this.audioGen = graphGen;
    }
    const seq = this.seq;
    const t = this.t;
    const playing = this.playing && this.rate > 0;
    const frame = resolveFrame(seq, t);
    this.frame = frame;
    this.frameNo++;
    const usedV = new Set();
    for (const tr of frame) {
      for (const l of tr.layers) {
        if (l.clip.type === 'video') { usedV.add(l.clip.id); this.syncVideo(l.clip, l.srcTime, playing, now); }
        else if (l.clip.type === 'image') this.ensureImage(l.clip.media);
      }
    }
    const horizon = playing ? 2.5 : 0.75;
    for (const c of seq.clips) {
      if (c.enabled === false) continue;
      if (c.type === 'video' && !usedV.has(c.id) && c.start > t && c.start - t < horizon) {
        usedV.add(c.id);
        this.syncVideo(c, c.in || 0, false, now);
      } else if (c.type === 'image' && c.start > t && c.start - t < 4) this.ensureImage(c.media);
    }
    const audible = new Set(audibleTracks(seq).map((tr) => tr.id));
    const trackVol = Object.fromEntries(seq.tracks.map((tr) => [tr.id, tr.volume ?? 1]));
    const sounding = seq.clips.filter((c) => c.type === 'audio' && c.enabled !== false && audible.has(c.track));
    // clips that are playing claim their element first, so one that only preloads can't take it from them
    for (const c of sounding) if (clipActiveAt(c, t)) this.syncAudio(c, clipSourceTime(c, t), playing, audioGainAt(c, t) * trackVol[c.track], now);
    for (const c of sounding) if (c.start > t && c.start - t < horizon) this.syncAudio(c, c.in || 0, false, 0, now);
    for (const [key, e] of this.videos) {
      if (e.frame === this.frameNo) continue;
      if (!e.el.paused) e.el.pause();
      if (now - e.used > 6000) { this.release(e); this.videos.delete(key); }
    }
    for (const [key, e] of this.audios) {
      if (e.frame === this.frameNo) continue;
      e.gain.gain.value = 0;
      if (!e.el.paused) e.el.pause();
      if (now - e.used > 6000) { this.release(e); this.audios.delete(key); }
    }
  }

  getSource(l) {
    const c = l.clip;
    if (c.type === 'video') {
      const info = this.previewInfo(c.media);
      if (info.state === 'offline') return OFFLINE;
      const e = this.clipVideo.get(c.id);
      if (!e || e.owner !== c.id) return null;
      if (e.error) return OFFLINE;
      return e.el.readyState >= 2 ? e.el : null;
    }
    if (c.type === 'image') {
      const info = this.previewInfo(c.media);
      if (info.state === 'offline') return OFFLINE;
      const im = this.images.get(c.media);
      if (!im) return null;
      if (im.state === 'error') return OFFLINE;
      return im.state === 'ok' ? im.img : null;
    }
    return null;
  }

  // Layers whose media isn't ready yet (to show "preparing preview" in the viewer).
  pendingLayers() {
    const out = [];
    for (const tr of this.frame) for (const l of tr.layers) {
      if (l.clip.type !== 'video' && l.clip.type !== 'image') continue;
      const info = this.previewInfo(l.clip.media);
      if (info.state === 'proxy') out.push(info);
    }
    return out;
  }

  // Free every decoder (tab hidden / player unmounted). They're recreated on demand.
  suspend() {
    this.pause();
    for (const e of this.videos.values()) this.release(e);
    for (const e of this.audios.values()) this.release(e);
    this.videos.clear();
    this.audios.clear();
    this.clipVideo.clear();
    this.clipAudio.clear();
    this.images.clear();
  }

  hasErrors() {
    for (const e of this.videos.values()) if (e.error) return true;
    for (const e of this.audios.values()) if (e.error) return true;
    for (const im of this.images.values()) if (im.state === 'error') return true;
    return false;
  }

  // Footage came back (a drive reconnected): drop the players and images that failed so they load again.
  reloadMedia() {
    for (const [pool, byClip] of [[this.videos, this.clipVideo], [this.audios, this.clipAudio]]) {
      for (const [k, e] of pool) {
        if (!e.error) continue;
        this.release(e);
        pool.delete(k);
        for (const [cid, x] of byClip) if (x === e) byClip.delete(cid);
      }
    }
    for (const [mid, im] of this.images) if (im.state === 'error') this.images.delete(mid);
    this.invalidate();
  }

  dispose() {
    this.suspend();
  }
}
