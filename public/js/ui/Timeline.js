// Multi-track timeline: sequences, tracks, clips, trimming, razor, snapping, markers, drop-from-bin.
import { html, Icon, IconButton, Slider } from './common.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore, loadPref, savePref } from '../core/store.js';
import {
  clipEnd, videoTracks, audioTracks, trackLabel, sequenceDuration, snapTime, maxDurationFor, usesSourceTime,
  uid, clipsOnTrack, isVisualClip, timecode, TRANSITIONS, clamp, deepClone, findSequence, LABEL_COLORS,
} from '../core/model.js';
import {
  clearRange, linkedIds, splitAt, deleteClips, trimHead, insertMedia, addTrack, addText, addSolid, pasteClips, addAdjust, insertSequence, nestClips,
  clipLabel, editPoints, keyframeTimes, gapAt, closeGap, rippleTrimToPlayhead, setSpeed, fitClip, retimeClips,
  moveKeyframes, clampKeyframeShift, deleteKeyframes, keysAtTimes, setKeyframeInterp,
} from '../core/ops.js';
import { openSpeedDialog } from './speed.js';
import { downloadSequenceXml, duplicateSequence } from '../core/xml.js';
import { drawRuler, drawLane, onAssetLoaded, CLIP_COLORS } from './timeline-draw.js';
import { onThemeChange } from '../core/theme.js';
import { openMenu, notify, openDialog } from '../core/notify.js';
import { clipboard } from '../core/app.js';
import { uploadFile, post } from '../core/api.js';
import { promptText, NewSequenceDialog, confirmDialog } from './dialogs.js';
import { chatMenuItems } from './chatlinks.js';
import { keymap, shortcutLabel } from './keymap.js';
import { toolCursor } from './cursors.js';
import { openReframe } from './reframe.js';
import { openSync } from './sync.js';
import { AudioMeter } from './AudioMeter.js';
import { noteWheel } from '../core/perf.js';
import { ClipLine, lineDown, propsFor, propLabel, shownProp, showProp } from './cliplines.js';

export const HEAD_W = 176;
const TRACK_H = { video: 62, audio: 54 };
const TRACK_MIN = 32, TRACK_MAX = 400;
const TYPE_ICON = { video: 'film', audio: 'music', image: 'image', text: 'text', solid: 'square', sequence: 'seq' };

const kindOf = (c) => (c.type === 'audio' ? 'audio' : 'video');
// a Ctrl+click the clip's line used (curve, keyframe): on a Mac that click is also a right-click, whose menu is skipped
let lineCtrlClickAt = 0;
// whether Ctrl (Cmd) is really held, from the key events: a trackpad pinch sends ctrlKey on its wheel without it
const modsDown = { ctrl: false };
// a pinch's wheel steps: small and fractional (a notch of a mouse wheel is a whole 100 or more, in CSS pixels)
export const isPinchDelta = (e) => e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && !Number.isInteger(e.deltaY);
// pinches in the perf log (one line per gesture), to see what a touchpad really sends
let lastPinch = 0;
const notePinch = (e, held) => { const now = Date.now(); if (now - lastPinch > 1500) noteWheel(`pinch dy=${e.deltaY.toFixed(2)} mode=${e.deltaMode} ctrlHeld=${held}`); lastPinch = now; };
// Tool cursors over the tracks (cursors.js); everywhere else the pointer stays normal. The Selection tool keeps the arrow.
// Timeline tools in Premiere's order (their shortcuts are the tool.* commands in keymap.js).
const TOOLS = [
  { id: 'select', icon: 'pointer', title: 'Selection tool' },
  { id: 'trackfwd', icon: 'trackfwd', title: 'Track Select Forward — click to select every clip to the right (Shift: this track only), then drag' },
  { id: 'trackback', icon: 'trackback', title: 'Track Select Backward — click to select every clip to the left (Shift: this track only), then drag' },
  { id: 'ripple', icon: 'ripple', title: 'Ripple Edit tool — drag a clip edge to trim it; later clips move to close the gap' },
  { id: 'roll', icon: 'roll', title: 'Rolling Edit tool — drag the cut between two clips; one gets longer, the other shorter' },
  { id: 'ratestretch', icon: 'ratestretch', title: 'Rate Stretch tool — drag a clip edge to change its speed so the same footage fills the new length' },
  { id: 'razor', icon: 'scissors', title: 'Razor tool — click a clip to cut (Shift: all tracks)' },
  { id: 'slip', icon: 'slip', title: 'Slip tool — drag a clip to change which part of its footage it shows, without moving it' },
  { id: 'slide', icon: 'slide', title: 'Slide tool — drag a clip left/right; the clips either side adjust so nothing else moves' },
  { id: 'pen', icon: 'penTool', title: 'Pen tool — click the line on a clip to add a keyframe, drag keyframes, drag across a clip to select several' },
  { id: 'hand', icon: 'hand', title: 'Hand tool — drag to scroll the timeline' },
  { id: 'zoom', icon: 'zoomIn', title: 'Zoom tool — click to zoom in, Alt+click to zoom out' },
];

export function Timeline({ tab }) {
  const doc = useStore(tab.store, (s) => s.doc);
  const mediaStatus = useStore(tab.store, (s) => s.mediaStatus);
  const reviews = useStore(tab.store, (s) => s.reviews);
  const pps = useStore(tab.ui, (s) => s.pps);
  const scrollX = useStore(tab.ui, (s) => s.scrollX);
  const selection = useStore(tab.ui, (s) => s.selection);
  const kfSel = useStore(tab.ui, (s) => s.kfSel);
  const lineProp = useStore(tab.ui, (s) => s.lineProp);
  const gapSel = useStore(tab.ui, (s) => s.gapSel);
  const tool = useStore(tab.ui, (s) => s.tool);
  const snap = useStore(tab.ui, (s) => s.snap);
  const linked = useStore(tab.ui, (s) => s.linked);
  const flash = useStore(tab.flash, (s) => s);
  useStore(tab.ui, (s) => s.sequenceId);
  const prerender = useStore(tab.store, (s) => s.prerender);
  const [width, setWidth] = useState(900);
  const [assetTick, setAssetTick] = useState(0);
  const [marquee, setMarquee] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [tip, setTip] = useState(null);
  const [flashOn, setFlashOn] = useState(false);
  const [snapT, setSnapT] = useState(null);
  // each track's height, as a factor of the default (Ctrl+wheel over the track); kept per project
  const [trackScale, setTrackScale] = useState(() => loadPref(`trackHeights.${tab.projectId}`, {}));
  const trackKey = (tr) => `${tab.ui.get().sequenceId}:${tr.id}`;
  const trackH = (tr) => Math.round(TRACK_H[tr.kind] * (trackScale[trackKey(tr)] || 1));
  const lineSel = kfSel?.prop ? kfSel : null;
  const bodyTool = tool === 'select' || tool === 'pen';
  const snapHit = useRef(null);
  const bodyRef = useRef(null);
  const wheelRef = useRef(null);
  const tracksRef = useRef(null);
  const rulerRef = useRef(null);
  const canvases = useRef({});
  const seq = doc ? tab.seq : null;
  const mediaById = tab.mediaById;

  // on the way down, so nothing under the cursor can take a wheel meant for the timeline
  useEffect(() => {
    const el = bodyRef.current;
    if (!seq || !el) return undefined;
    const on = (e) => wheelRef.current?.(e);
    el.addEventListener('wheel', on, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', on, { capture: true });
  }, [!seq]);
  useEffect(() => onAssetLoaded(() => setAssetTick((x) => x + 1)), []);
  useEffect(() => { if (selection.length && tab.ui.get().gapSel) tab.ui.set({ gapSel: null }); }, [selection]);
  useEffect(() => onThemeChange(() => setAssetTick((x) => x + 1)), []);
  // Holding Ctrl/Cmd switches clip edges to rolling-edit mode, holding Alt the Zoom tool to zoom out (class toggles only, no re-render).
  useEffect(() => {
    const sync = (e) => { modsDown.ctrl = !!(e.ctrlKey || e.metaKey); tracksRef.current?.classList.toggle('is-roll', modsDown.ctrl); tracksRef.current?.classList.toggle('is-alt', !!e.altKey); };
    const off = () => { modsDown.ctrl = false; tracksRef.current?.classList.remove('is-roll', 'is-alt'); };
    // a mouse event without Ctrl means it is up: a key-up missed (in the terminal, a dialog, another window) left it
    // "held", and every pinch after that changed track heights instead of zooming (Step 82). (Only ever cleared this
    // way: the events around a pinch may carry ctrlKey without the key.)
    const mouse = (e) => { if (modsDown.ctrl && !e.ctrlKey && !e.metaKey) sync(e); };
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', off);
    window.addEventListener('pointermove', mouse, true);
    window.addEventListener('pointerdown', mouse, true);
    return () => { window.removeEventListener('keydown', sync); window.removeEventListener('keyup', sync); window.removeEventListener('blur', off); window.removeEventListener('pointermove', mouse, true); window.removeEventListener('pointerdown', mouse, true); };
  }, []);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(100, e.contentRect.width - HEAD_W)));
    ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!flash.ids.length || Date.now() - flash.at > 2000) return undefined;
    setFlashOn(true);
    const t = setTimeout(() => setFlashOn(false), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const rows = useMemo(() => (seq ? [...videoTracks(seq).slice().reverse(), ...audioTracks(seq)] : []), [seq]);
  const byTrack = useMemo(() => {
    const m = {};
    if (seq) for (const c of seq.clips) (m[c.track] || (m[c.track] = [])).push(c);
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.start - b.start);
    return m;
  }, [seq]);

  const reviewMarks = useMemo(() => {
    if (!seq || !reviews) return [];
    const vs = reviews.versions.filter((v) => v.sequence === seq.id).sort((a, b) => b.number - a.number);
    if (!vs.length) return [];
    const v = vs[0];
    return reviews.comments.filter((c) => c.version === v.id).map((c) => ({ t: (v.start || 0) + c.t, resolved: c.resolved }));
  }, [seq, reviews]);

  // draw ruler + lane canvases
  useLayoutEffect(() => {
    if (!seq) return;
    const rendered = prerender?.enabled ? prerender.sequences?.[seq.id] : null;
    if (rulerRef.current) drawRuler(rulerRef.current, { pps, scrollX, width, seq, markers: seq.markers, comments: reviewMarks, inPoint: seq.inPoint, outPoint: seq.outPoint, rendered: rendered && !rendered.approved ? rendered : null });
    for (const tr of rows) {
      const cv = canvases.current[tr.id];
      if (cv) drawLane(cv, { track: tr, clips: byTrack[tr.id] || [], pps, scrollX, width, height: trackH(tr), projectId: tab.projectId, mediaById, mediaStatus });
    }
  }, [seq, pps, scrollX, width, mediaStatus, assetTick, reviewMarks, rows, byTrack, prerender, trackScale]);

  if (!seq) {
    return html`<section class="panel timeline" ref=${bodyRef}><div class="tl-empty">This project has no sequences yet.
      <button class="btn btn-primary" onClick=${() => openDialog(NewSequenceDialog, { tab })}>New sequence</button></div></section>`;
  }

  const fps = seq.fps;
  const dur = sequenceDuration(seq);
  const minPps = Math.max(0.5, (width - 40) / Math.max(10, dur * 1.1));
  const maxPps = fps * 40;
  const setPps = (next, anchorX = width / 2) => {
    const p = clamp(next, minPps, maxPps);
    const tAt = (scrollX + anchorX) / pps;
    tab.ui.set({ pps: p, scrollX: Math.max(0, tAt * p - anchorX) });
  };
  const fitZoom = () => tab.ui.set({ pps: clamp((width - 40) / Math.max(1, dur), 0.5, maxPps), scrollX: 0 });

  // ------------------------------------------------------------ geometry helpers
  const laneLeft = () => bodyRef.current.getBoundingClientRect().left + HEAD_W;
  const timeAt = (clientX) => (clientX - laneLeft() + tab.ui.get().scrollX) / tab.ui.get().pps;
  const rowAt = (clientY) => {
    for (const el of tracksRef.current.querySelectorAll('[data-row]')) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return el;
    }
    return null;
  };
  const isLocked = (s, trackId) => !!s.tracks.find((t) => t.id === trackId)?.locked;
  const snapTargets = (s, exclude) => {
    const pts = [0, tab.time.get().t];
    for (const c of s.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
    for (const m of s.markers || []) pts.push(m.t);
    if (s.inPoint != null) pts.push(s.inPoint);
    if (s.outPoint != null) pts.push(s.outPoint);
    return pts;
  };
  const snapValue = (values, targets, enabled) => {
    snapHit.current = null;
    if (!enabled) return 0;
    const tol = 8 / tab.ui.get().pps;
    let best = null;
    for (const v of values) for (const tg of targets) {
      const d = tg - v;
      if (Math.abs(d) < tol && (best === null || Math.abs(d) < Math.abs(best))) { best = d; snapHit.current = tg; }
    }
    return best ?? 0;
  };
  // Pointer capture for a drag gesture. Esc cancels it and restores the timeline.
  const capture = (e, move, up) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const cleanup = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      setSnapT(null);
    };
    const onUp = (ev) => { cleanup(); up(ev); };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
      tab.cancelDrag();
      setTip(null);
      setMarquee(null);
      document.body.classList.remove('is-scrubbing');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
  };
  // show the snap guide only when the dragged edge actually landed on the snap target
  const showSnap = (edgeTime) => {
    const t = snapHit.current;
    setSnapT(t != null && (edgeTime == null || Math.abs(edgeTime - t) < 1e-6) ? t : null);
  };

  // ------------------------------------------------------------ clip gestures
  function startMove(e, clip) {
    const s = tab.seq;
    const sel = new Set(tab.ui.get().selection);
    if (!sel.size) sel.add(clip.id);
    const group = linked && !e.altKey ? linkedIds(s, sel) : sel;
    const clips = s.clips.filter((c) => group.has(c.id) && !isLocked(s, c.track));
    if (!clips.length) return;
    const orig = new Map(clips.map((c) => [c.id, { start: c.start, end: clipEnd(c), track: c.track }]));
    const ids = new Set(orig.keys());
    const kind = kindOf(clip);
    const kindList = kind === 'audio' ? audioTracks(s) : videoTracks(s);
    const primaryIdx = kindList.findIndex((t) => t.id === clip.track);
    const targets = snapTargets(s, ids);
    const minStart = Math.min(...clips.map((c) => c.start));
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, lastDt = 0, lastShift = 0;
    const apply = (ds, dt, shift, final) => {
      for (const c of ds.clips) {
        const o = orig.get(c.id);
        if (!o) continue;
        c.start = Math.max(0, snapTime(o.start + dt, fps));
        if (shift && kindOf(c) === kind) {
          const i = kindList.findIndex((t) => t.id === o.track);
          if (i >= 0) c.track = kindList[clamp(i + shift, 0, kindList.length - 1)].id;
        }
      }
      // overwrite whatever sits underneath; shown live while dragging, so clips never overlap
      for (const c of ds.clips.filter((x) => ids.has(x.id))) clearRange(ds, c.track, c.start, clipEnd(c), ids);
    };
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      if (!moved) { moved = true; tab.begin(); }
      let dt = (ev.clientX - x0) / tab.ui.get().pps;
      const vals = [];
      for (const o of orig.values()) vals.push(o.start + dt, o.end + dt);
      dt += snapValue(vals, targets, tab.ui.get().snap && !ev.ctrlKey);
      dt = Math.max(dt, -minStart);
      showSnap();
      let shift = 0;
      const row = rowAt(ev.clientY);
      const tr = row && s.tracks.find((t) => t.id === row.dataset.row);
      if (tr && tr.kind === kind && !tr.locked && primaryIdx >= 0) shift = kindList.indexOf(tr) - primaryIdx; // never onto a locked track
      for (const c of clips) {
        if (kindOf(c) !== kind) continue;
        const i = kindList.findIndex((t) => t.id === c.track);
        if (i + shift < 0) shift = -i;
        if (i + shift > kindList.length - 1) shift = kindList.length - 1 - i;
      }
      lastDt = dt; lastShift = shift;
      tab.preview((d, ds) => apply(ds, dt, shift, false));
      setTip({ x: ev.clientX, y: ev.clientY, text: `${dt < 0 ? '−' : '+'}${timecode(Math.abs(dt), fps)}  →  ${timecode(Math.max(0, clip.start + dt), fps)}` });
    }, () => {
      setTip(null);
      if (!moved) return;
      if (!lastDt && !lastShift) { tab.cancelDrag(); return; }
      tab.preview((d, ds) => apply(ds, lastDt, lastShift, true));
      tab.end(clips.length > 1 ? 'Move clips' : 'Move clip');
    });
  }

  // Trim (Selection tool) leaves a gap; ripple trim (B) keeps the clip's start and moves everything
  // after it on the same tracks, so the gap closes (or opens).
  function startTrim(e, clip, edge, ripple = false) {
    const s = tab.seq;
    const group = linked && !e.altKey ? [...linkedIds(s, [clip.id])] : [clip.id];
    const clips = s.clips.filter((c) => group.includes(c.id) && !isLocked(s, c.track));
    const orig = new Map(clips.map((c) => [c.id, deepClone(c)]));
    let lo = -Infinity, hi = Infinity;
    for (const c of clips) {
      const others = clipsOnTrack(s, c.track).filter((x) => !group.includes(x.id));
      if (edge === 'l') {
        const prevEnd = Math.max(0, ...others.filter((x) => clipEnd(x) <= c.start + 1e-6).map(clipEnd));
        let min = ripple ? -Infinity : prevEnd - c.start;
        if (usesSourceTime(c)) min = Math.max(min, -(c.in || 0) / (c.speed || 1));
        lo = Math.max(lo, min);
        hi = Math.min(hi, c.duration - 1 / fps);
      } else {
        const nextStart = ripple ? Infinity : Math.min(Infinity, ...others.filter((x) => x.start >= clipEnd(c) - 1e-6).map((x) => x.start));
        hi = Math.min(hi, nextStart - clipEnd(c), maxDurationFor(c, mediaById[c.media]) - c.duration);
        lo = Math.max(lo, -(c.duration - 1 / fps));
      }
    }
    const edgeT = edge === 'l' ? clip.start : clipEnd(clip);
    const targets = snapTargets(s, new Set(group));
    const x0 = e.clientX;
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; tab.begin(); }
      let dt = (ev.clientX - x0) / tab.ui.get().pps;
      dt += snapValue([edgeT + dt], targets, tab.ui.get().snap && !ev.ctrlKey);
      dt = snapTime(edgeT + dt, fps) - edgeT;
      dt = clamp(dt, lo, hi);
      showSnap(edgeT + dt);
      tab.preview((d, ds) => {
        for (const c of ds.clips) {
          const o = orig.get(c.id);
          if (!o) continue;
          Object.assign(c, deepClone(o));
          if (edge === 'l') { trimHead(c, dt); if (ripple) c.start = o.start; } else c.duration = o.duration + dt;
        }
        if (!ripple) return;
        const shift = edge === 'l' ? -dt : dt, shifted = new Set();
        for (const o of orig.values()) {
          for (const c of ds.clips) {
            if (orig.has(c.id) || shifted.has(c.id) || c.track !== o.track || c.start < clipEnd(o) - 1e-6) continue;
            c.start += shift;
            shifted.add(c.id);
          }
        }
      });
      const newDur = edge === 'l' ? clip.duration - dt : clip.duration + dt;
      setTip({ x: ev.clientX, y: ev.clientY, text: `${ripple ? 'Ripple ' : ''}${dt < 0 ? '−' : '+'}${timecode(Math.abs(dt), fps)}   duration ${timecode(newDur, fps)}` });
    }, () => {
      setTip(null);
      if (moved) tab.end(ripple ? 'Ripple trim' : 'Trim clip');
    });
  }

  // Slip (Y): drag a clip to change which part of its footage it shows; it stays where it is on the
  // timeline. Dragging right shows earlier footage, as in Premiere.
  function startSlip(e, clip) {
    const s = tab.seq;
    const group = new Set(linked && !e.altKey ? [...linkedIds(s, [clip.id])] : [clip.id]);
    const clips = s.clips.filter((c) => group.has(c.id) && usesSourceTime(c) && !isLocked(s, c.track));
    if (!clips.length) return;
    const orig = new Map(clips.map((c) => [c.id, deepClone(c)]));
    let lo = -Infinity, hi = Infinity;
    for (const c of clips) {
      const sp = c.speed || 1;
      hi = Math.min(hi, (c.in || 0) / sp);
      const m = mediaById[c.media];
      if (m && Number.isFinite(m.duration) && m.duration > 0) lo = Math.max(lo, c.duration - (m.duration - (c.in || 0)) / sp);
    }
    if (lo > hi) return;
    const main = clips.find((c) => c.id === clip.id) || clips[0];
    const x0 = e.clientX;
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; tab.begin(); }
      const dt = clamp(snapTime((ev.clientX - x0) / tab.ui.get().pps, fps), lo, hi);
      tab.preview((d, ds) => {
        for (const c of ds.clips) { const o = orig.get(c.id); if (o) c.in = Math.max(0, (o.in || 0) - dt * (o.speed || 1)); }
      });
      const sp = main.speed || 1, inT = Math.max(0, (main.in || 0) - dt * sp);
      setTip({ x: ev.clientX, y: ev.clientY, text: `Slip   in ${timecode(inT, fps)}   out ${timecode(inT + main.duration * sp, fps)}` });
    }, () => {
      setTip(null);
      if (moved) tab.end('Slip');
    });
  }

  // Slide (U): move a clip along its track; the touching clip before it gets longer/shorter and the one
  // after it shorter/longer to match, so nothing else moves and the sequence keeps its length.
  function startSlide(e, clip) {
    const s = tab.seq;
    const tol = 0.5 / fps;
    const group = new Set(linked && !e.altKey ? [...linkedIds(s, [clip.id])] : [clip.id]);
    const clips = s.clips.filter((c) => group.has(c.id) && !isLocked(s, c.track));
    if (!clips.length) return;
    const parts = [];
    let lo = -Infinity, hi = Infinity;
    for (const c of clips) {
      const others = clipsOnTrack(s, c.track).filter((x) => !group.has(x.id));
      const prev = others.find((x) => Math.abs(clipEnd(x) - c.start) < tol);
      const next = others.find((x) => Math.abs(x.start - clipEnd(c)) < tol);
      if (prev) {
        lo = Math.max(lo, -(prev.duration - 1 / fps));
        hi = Math.min(hi, maxDurationFor(prev, mediaById[prev.media]) - prev.duration);
      } else lo = Math.max(lo, Math.max(0, ...others.filter((x) => clipEnd(x) <= c.start + tol).map(clipEnd)) - c.start);
      if (next) {
        hi = Math.min(hi, next.duration - 1 / fps);
        if (usesSourceTime(next)) lo = Math.max(lo, -(next.in || 0) / (next.speed || 1));
      } else hi = Math.min(hi, Math.min(Infinity, ...others.filter((x) => x.start >= clipEnd(c) - tol).map((x) => x.start)) - clipEnd(c));
      parts.push({ id: c.id, prev: prev?.id, next: next?.id });
    }
    if (lo > hi) return;
    const ids = new Set(parts.flatMap((p) => [p.id, p.prev, p.next]).filter(Boolean));
    const orig = new Map(s.clips.filter((c) => ids.has(c.id)).map((c) => [c.id, deepClone(c)]));
    const targets = snapTargets(s, ids);
    const x0 = e.clientX;
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; tab.begin(); }
      let dt = (ev.clientX - x0) / tab.ui.get().pps;
      dt += snapValue([clip.start + dt, clipEnd(clip) + dt], targets, tab.ui.get().snap && !ev.ctrlKey);
      dt = clamp(snapTime(clip.start + dt, fps) - clip.start, lo, hi);
      showSnap();
      tab.preview((d, ds) => {
        const byId = new Map(ds.clips.map((c) => [c.id, c]));
        for (const p of parts) {
          byId.get(p.id).start = orig.get(p.id).start + dt;
          if (p.prev) byId.get(p.prev).duration = orig.get(p.prev).duration + dt;
          if (p.next) trimHead(byId.get(p.next), dt);
        }
      });
      setTip({ x: ev.clientX, y: ev.clientY, text: `Slide ${dt < 0 ? '−' : '+'}${timecode(Math.abs(dt), fps)}  →  ${timecode(clip.start + dt, fps)}` });
    }, () => {
      setTip(null);
      if (moved) tab.end('Slide');
    });
  }

  // Rate Stretch (R): dragging an edge changes the clip's speed so the same source range fills the new length.
  function startStretch(e, clip, edge) {
    const s = tab.seq;
    const group = new Set(linked && !e.altKey ? [...linkedIds(s, [clip.id])] : [clip.id]);
    const clips = s.clips.filter((c) => group.has(c.id) && !isLocked(s, c.track));
    if (!clips.length) return;
    const orig = new Map(clips.map((c) => [c.id, deepClone(c)]));
    const ids = new Set(orig.keys());
    // the edge may move up to the neighbouring clip, and the speed must stay within 5%..1600%
    let lo = -Infinity, hi = Infinity;
    for (const c of clips) {
      const others = clipsOnTrack(s, c.track).filter((x) => !ids.has(x.id));
      const src = c.duration * (c.speed || 1);
      const minD = usesSourceTime(c) ? Math.max(1 / fps, src / 16) : 1 / fps;
      const maxD = usesSourceTime(c) ? src / 0.05 : Infinity;
      if (edge === 'l') {
        const prevEnd = Math.max(0, ...others.filter((x) => clipEnd(x) <= c.start + 1e-6).map(clipEnd));
        lo = Math.max(lo, prevEnd - c.start, c.duration - maxD);
        hi = Math.min(hi, c.duration - minD);
      } else {
        const nextStart = Math.min(Infinity, ...others.filter((x) => x.start >= clipEnd(c) - 1e-6).map((x) => x.start));
        hi = Math.min(hi, nextStart - clipEnd(c), maxD - c.duration);
        lo = Math.max(lo, minD - c.duration);
      }
    }
    const edgeT = edge === 'l' ? clip.start : clipEnd(clip);
    const targets = snapTargets(s, ids);
    const x0 = e.clientX;
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; tab.begin(); }
      let dt = (ev.clientX - x0) / tab.ui.get().pps;
      dt += snapValue([edgeT + dt], targets, tab.ui.get().snap && !ev.ctrlKey);
      dt = clamp(snapTime(edgeT + dt, fps) - edgeT, lo, hi);
      showSnap(edgeT + dt);
      tab.preview((d, ds) => {
        for (const c of ds.clips) {
          const o = orig.get(c.id);
          if (!o) continue;
          Object.assign(c, deepClone(o));
          const nd = edge === 'l' ? o.duration - dt : o.duration + dt;
          retimeClips(ds, new Set([c.id]), { duration: nd, ripple: true, fps, anchor: edge === 'l' ? 'end' : 'start' });
        }
        // ripple:true above only skips the neighbour check (limits are enforced here); undo its shifts
        for (const c of ds.clips) if (!orig.has(c.id)) { const o = s.clips.find((x) => x.id === c.id); if (o) c.start = o.start; }
      });
      const c = tab.seq.clips.find((x) => x.id === clip.id);
      setTip({ x: ev.clientX, y: ev.clientY, text: `${usesSourceTime(clip) ? `Speed ${Math.round((c.speed || 1) * 1000) / 10}%   ` : ''}duration ${timecode(c.duration, fps)}` });
    }, () => {
      setTip(null);
      if (moved) tab.end('Rate stretch');
    });
  }

  // Rolling edit (Ctrl/Cmd + drag the join between two touching clips): moves the cut point,
  // shortening one clip and lengthening the other, so nothing else on the track moves.
  function rollPair(s, clip, edge) {
    const tol = 0.5 / fps;
    const others = clipsOnTrack(s, clip.track).filter((x) => x.id !== clip.id);
    if (edge === 'r') {
      const b = others.find((x) => Math.abs(x.start - clipEnd(clip)) < tol);
      return b ? [clip, b] : null;
    }
    const a = others.find((x) => Math.abs(clipEnd(x) - clip.start) < tol);
    return a ? [a, clip] : null;
  }

  function startRoll(e, a, b) {
    const s = tab.seq;
    const cut = clipEnd(a);
    const pairs = [[a, b]];
    if (linked && !e.altKey) {
      // linked audio/video cut at the same point rolls along
      for (const id of linkedIds(s, [a.id, b.id])) {
        const la = s.clips.find((c) => c.id === id);
        if (!la || la.id === a.id || la.id === b.id || isLocked(s, la.track) || Math.abs(clipEnd(la) - cut) > 0.5 / fps) continue;
        const lb = clipsOnTrack(s, la.track).find((x) => x.id !== la.id && Math.abs(x.start - cut) < 0.5 / fps);
        if (lb && !pairs.some(([, pb]) => pb.id === lb.id)) pairs.push([la, lb]);
      }
    }
    let lo = -Infinity, hi = Infinity;
    for (const [pa, pb] of pairs) {
      lo = Math.max(lo, -(pa.duration - 1 / fps));
      hi = Math.min(hi, maxDurationFor(pa, mediaById[pa.media]) - pa.duration, pb.duration - 1 / fps);
      if (usesSourceTime(pb)) lo = Math.max(lo, -(pb.in || 0) / (pb.speed || 1));
    }
    const orig = new Map(pairs.flat().map((c) => [c.id, deepClone(c)]));
    const heads = new Set(pairs.map(([, pb]) => pb.id));
    const targets = snapTargets(s, new Set(orig.keys()));
    const x0 = e.clientX;
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; tab.begin(); }
      let dt = (ev.clientX - x0) / tab.ui.get().pps;
      dt += snapValue([cut + dt], targets, tab.ui.get().snap && !ev.shiftKey);
      dt = clamp(snapTime(cut + dt, fps) - cut, lo, hi);
      showSnap(cut + dt);
      tab.preview((d, ds) => {
        for (const c of ds.clips) {
          const o = orig.get(c.id);
          if (!o) continue;
          Object.assign(c, deepClone(o));
          if (heads.has(c.id)) trimHead(c, dt);
          else c.duration = o.duration + dt;
        }
      });
      setTip({ x: ev.clientX, y: ev.clientY, text: `Roll ${dt < 0 ? '−' : '+'}${timecode(Math.abs(dt), fps)}   cut @ ${timecode(cut + dt, fps)}` });
    }, () => {
      setTip(null);
      if (moved) tab.end('Rolling edit');
    });
  }

  function startFade(e, clip, which) {
    let moved = false;
    capture(e, (ev) => {
      if (!moved) { moved = true; tab.begin(); }
      const local = timeAt(ev.clientX) - clip.start;
      tab.preview((d, ds) => {
        const c = ds.clips.find((x) => x.id === clip.id);
        if (!c) return;
        if (which === 'in') c.fadeIn = snapTime(clamp(local, 0, c.duration - (c.fadeOut || 0)), fps);
        else c.fadeOut = snapTime(clamp(c.duration - local, 0, c.duration - (c.fadeIn || 0)), fps);
      });
      const c = tab.seq.clips.find((x) => x.id === clip.id);
      setTip({ x: ev.clientX, y: ev.clientY, text: `Fade ${which}: ${(which === 'in' ? c.fadeIn : c.fadeOut).toFixed(2)}s` });
    }, () => { setTip(null); if (moved) tab.end(`Fade ${which}`); });
  }

  function startMarquee(e, lane) {
    const x0 = e.clientX, y0 = e.clientY;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = add ? tab.ui.get().selection : [];
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      const r = { l: Math.min(x0, ev.clientX), r: Math.max(x0, ev.clientX), t: Math.min(y0, ev.clientY), b: Math.max(y0, ev.clientY) };
      setMarquee(r);
      const hits = [];
      for (const el of tracksRef.current.querySelectorAll('[data-clip]')) {
        const b = el.getBoundingClientRect();
        if (b.right > r.l && b.left < r.r && b.bottom > r.t && b.top < r.b) hits.push(el.dataset.clip);
      }
      tab.ui.set({ selection: [...new Set([...base, ...hits])] });
    }, () => {
      setMarquee(null);
      if (moved) { tab.ui.set({ gapSel: null }); return; }
      if (add) return;
      // Premiere: clicking the empty stretch between two clips selects that gap (on this track only); Delete closes it
      const s = tab.seq, tr = lane?.dataset.lane;
      const gap = tab.ui.get().tool === 'select' && tr && !isLocked(s, tr) ? gapAt(s, tr, timeAt(x0)) : null;
      tab.ui.set({ selection: [], gapSel: gap ? { seq: s.id, track: tr, start: gap.start, end: gap.end } : null });
    });
  }

  // Pen tool: drag across a clip to select the keyframes on its line.
  function startKfMarquee(e, clip) {
    const x0 = e.clientX, y0 = e.clientY;
    const prop = shownProp(tab, clip);
    const prev = kfSel?.clipId === clip.id && kfSel.prop === prop && e.shiftKey ? kfSel.times : [];
    let moved = false;
    capture(e, (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      const r = { l: Math.min(x0, ev.clientX), r: Math.max(x0, ev.clientX), t: Math.min(y0, ev.clientY), b: Math.max(y0, ev.clientY) };
      setMarquee(r);
      const hits = [];
      for (const el of tracksRef.current.querySelectorAll(`[data-clip="${clip.id}"] [data-lk]`)) {
        const b = el.getBoundingClientRect();
        const [cx, cy] = [(b.left + b.right) / 2, (b.top + b.bottom) / 2];
        if (cx > r.l && cx < r.r && cy > r.t && cy < r.b) hits.push(Number(el.dataset.t));
      }
      tab.ui.set({ kfSel: { clipId: clip.id, times: [...new Set([...prev, ...hits])], prop } });
    }, () => { setMarquee(null); if (!moved && !e.shiftKey) tab.ui.set({ kfSel: null }); });
  }

  const onLanesDown = (e) => {
    if (e.button !== 0) return;
    const lane = e.target.closest('[data-lane]');
    if (!lane) return;
    tab.engine.pause();
    const s = tab.seq;
    const clipEl = e.target.closest('[data-clip]');
    const tool = tab.ui.get().tool;
    if (tool === 'hand') {
      const x0 = e.clientX, s0 = tab.ui.get().scrollX;
      capture(e, (ev) => tab.ui.set({ scrollX: Math.max(0, s0 - (ev.clientX - x0)) }), () => {});
      return;
    }
    if (tool === 'zoom') { setPps(tab.ui.get().pps * (e.altKey ? 0.5 : 2), e.clientX - laneLeft()); return; }
    if (tool === 'trackfwd' || tool === 'trackback') {
      // Track Select Forward (A) / Backward (Shift+A): every clip from the click point to the end (or
      // the start) of the sequence, on all tracks — or only this track with Shift. Then drag to move them.
      const t = timeAt(e.clientX);
      const fwd = tool === 'trackfwd';
      const picked = s.clips.filter((c) => (fwd ? clipEnd(c) > t + 1e-6 : c.start < t - 1e-6) && (!e.shiftKey || c.track === lane.dataset.lane));
      if (!picked.length) { tab.ui.set({ selection: [] }); return; }
      tab.ui.set({ selection: picked.map((c) => c.id) });
      const anchor = (clipEl && picked.find((c) => c.id === clipEl.dataset.clip)) || picked.reduce((a, b) => (b.start < a.start ? b : a));
      startMove({ clientX: e.clientX, clientY: e.clientY, altKey: !e.shiftKey, shiftKey: false, ctrlKey: false, pointerId: e.pointerId, target: e.target, currentTarget: e.currentTarget, button: 0, preventDefault() {}, stopPropagation() {} }, anchor);
      return;
    }
    if (!clipEl) { startMarquee(e, lane); return; }
    const clip = s.clips.find((c) => c.id === clipEl.dataset.clip);
    if (!clip) return;
    if (tool === 'razor') {
      if (isLocked(s, clip.track)) return;
      let t = snapTime(timeAt(e.clientX), fps);
      const ph = tab.time.get().t;
      if (Math.abs(t - ph) * tab.ui.get().pps < 8) t = ph;
      tab.apply('Razor', (d, ds) => (splitAt(ds, t, e.shiftKey ? null : new Set([clip.id])).length ? undefined : false));
      return;
    }
    const expand = (ids) => (linked && !e.altKey ? [...linkedIds(s, ids)] : ids);
    if (tool === 'select' || tool === 'pen') {
      const took = lineDown(tab, e, clip, { setTip, locked: isLocked(s, clip.track), selectClip: () => { tab.select(expand([clip.id])); tab.ui.set({ focusClip: clip.id }); } });
      if (took === 'marquee') startKfMarquee(e, clip);
      if (took && e.ctrlKey) lineCtrlClickAt = Date.now();
      if (took) return;
    }
    const sel = tab.ui.get().selection;
    const edgeHit = e.target.closest('[data-edge]')?.dataset.edge;
    if ((e.ctrlKey || e.metaKey) && edgeHit && tool === 'select' && !isLocked(s, clip.track)) {
      const pair = rollPair(s, clip, edgeHit);
      if (pair) { tab.select(expand(pair.map((c) => c.id))); startRoll(e, pair[0], pair[1]); return; }
    }
    if (e.ctrlKey || e.metaKey) { tab.select(expand([clip.id]), { toggle: true }); return; }
    if (e.shiftKey) tab.select(expand([clip.id]), { add: true });
    else if (!sel.includes(clip.id)) tab.select(expand([clip.id]));
    tab.ui.set({ focusClip: clip.id });
    if (isLocked(s, clip.track)) return;
    const fade = e.target.closest('[data-fade]')?.dataset.fade;
    const edge = e.target.closest('[data-edge]')?.dataset.edge;
    if (tool === 'ratestretch') { if (edge) startStretch(e, clip, edge); return; }
    if (tool === 'slip') { startSlip(e, clip); return; }
    if (tool === 'slide') { startSlide(e, clip); return; }
    if (tool === 'ripple') { if (edge) startTrim(e, clip, edge, true); return; }
    if (tool === 'roll') {
      if (!edge) return;
      const pair = rollPair(s, clip, edge);
      if (pair) { tab.select(expand(pair.map((c) => c.id))); startRoll(e, pair[0], pair[1]); } else startTrim(e, clip, edge);
      return;
    }
    if (fade) startFade(e, clip, fade);
    else if (edge) startTrim(e, clip, edge);
    else startMove(e, clip);
  };

  const onLanesContext = (e) => {
    e.preventDefault();
    if (Date.now() - lineCtrlClickAt < 800) return; // a Mac's Ctrl+click the clip's line already used
    const s = tab.seq;
    const clipEl = e.target.closest('[data-clip]');
    if (clipEl) {
      const clip = s.clips.find((c) => c.id === clipEl.dataset.clip);
      if (!clip) return;
      const lk = e.target.closest('[data-lk]');
      if (lk) {
        const t = Number(lk.dataset.t), prop = shownProp(tab, clip);
        if (!tab.ui.get().selection.includes(clip.id)) tab.select([clip.id]);
        const cur = tab.ui.get().kfSel;
        if (!(cur?.clipId === clip.id && cur.prop === prop && cur.times.some((x) => Math.abs(x - t) < 1e-3))) tab.ui.set({ kfSel: { clipId: clip.id, times: [t], prop } });
        lineKfMenu(tab, e);
        return;
      }
      if (!tab.ui.get().selection.includes(clip.id)) tab.select(linked ? [...linkedIds(s, [clip.id])] : [clip.id]);
      tab.ui.set({ focusClip: clip.id });
      openMenu(e.clientX, e.clientY, clipMenu(tab, clip));
      return;
    }
    const lane = e.target.closest('[data-lane]');
    if (!lane) return;
    const trackId = lane.dataset.lane;
    const t = Math.max(0, snapTime(timeAt(e.clientX), fps));
    const gap = gapAt(s, trackId, t);
    openMenu(e.clientX, e.clientY, [
      { label: 'Paste here', icon: 'paste', disabled: !clipboard.clips.length, action: () => tab.apply('Paste', (d, ds) => { const ids = pasteClips(ds, clipboard.clips, t); tab.ui.set({ selection: ids }); }) },
      gap && !s.tracks.find((tr) => tr.id === trackId)?.locked && { label: `Close gap (${(gap.end - gap.start).toFixed(2)}s)`, icon: 'minus', action: () => rippleCloseGap(tab, trackId, gap) },
      { separator: true },
      { label: 'Add text here', icon: 'text', action: () => tab.apply('Add text', (d, ds) => { const c = addText(ds, { start: t }); tab.ui.set({ selection: [c.id], focusClip: c.id }); }) },
      { label: 'Add adjustment layer here', icon: 'layers', action: () => tab.apply('Add adjustment layer', (d, ds) => { const c = addAdjust(ds, { start: t }); tab.ui.set({ selection: [c.id], focusClip: c.id }); }) },
      { label: 'Add color matte here', icon: 'square', action: () => tab.apply('Add color matte', (d, ds) => { const c = addSolid(ds, { start: t }); tab.ui.set({ selection: [c.id], focusClip: c.id }); }) },
    ]);
  };

  // ------------------------------------------------------------ ruler
  const onRulerDown = (e) => {
    if (e.button !== 0) return;
    tab.engine.pause();
    const seekTo = (ev) => {
      let t = Math.max(0, timeAt(ev.clientX));
      if (tab.ui.get().snap && !ev.shiftKey) {
        const tol = 6 / tab.ui.get().pps;
        t = nearestWithin([...editPoints(tab.seq), ...(tab.seq.markers || []).map((m) => m.t)], t, tol);
      }
      tab.engine.seek(snapTime(t, fps));
    };
    seekTo(e);
    document.body.classList.add('is-scrubbing');
    capture(e, seekTo, () => document.body.classList.remove('is-scrubbing'));
  };
  const onRulerContext = (e) => {
    e.preventDefault();
    const t = Math.max(0, snapTime(timeAt(e.clientX), fps));
    const near = (seq.markers || []).find((m) => Math.abs(m.t - t) * pps < 7);
    openMenu(e.clientX, e.clientY, [
      near ? { label: `Rename marker…`, icon: 'marker', action: async () => { const label = await promptText('Marker label', near.label); if (label != null) tab.apply('Rename marker', (d, ds) => { ds.markers.find((m) => m.id === near.id).label = label; }); } } : null,
      near ? { label: 'Delete marker', icon: 'trash', danger: true, action: () => tab.apply('Delete marker', (d, ds) => { ds.markers = ds.markers.filter((m) => m.id !== near.id); }) } : null,
      { label: 'Add marker here', icon: 'marker', action: () => tab.apply('Add marker', (d, ds) => { ds.markers.push({ id: uid('mk'), t, label: '', color: '#f5a524' }); }) },
      { separator: true },
      { label: 'Set in point here', shortcut: shortcutLabel('tl.in'), action: () => tab.apply('Set in', (d, ds) => { ds.inPoint = t; if (ds.outPoint != null && ds.outPoint <= t) ds.outPoint = null; }) },
      { label: 'Set out point here', shortcut: shortcutLabel('tl.out'), action: () => tab.apply('Set out', (d, ds) => { ds.outPoint = t; if (ds.inPoint != null && ds.inPoint >= t) ds.inPoint = null; }) },
      { label: 'Clear in/out', disabled: seq.inPoint == null && seq.outPoint == null, action: () => tab.apply('Clear in/out', (d, ds) => { ds.inPoint = null; ds.outPoint = null; }) },
    ]);
  };

  // ------------------------------------------------------------ wheel
  const onWheel = (e) => {
    // Ctrl (Cmd on a Mac) + wheel: the height of the track under the cursor; Alt (Option) + wheel: zoom around the cursor.
    // A trackpad pinch arrives as a wheel with ctrlKey set but no Ctrl key held: it zooms, smoothly, with the pinch.
    // Its steps are small fractions (a mouse wheel's are whole notches of 100 or more), which also tells it apart.
    const pinch = e.ctrlKey && !e.metaKey && (!modsDown.ctrl || isPinchDelta(e));
    const heightKey = (e.ctrlKey || e.metaKey) && !pinch;
    if (pinch) {
      e.preventDefault();
      e.stopPropagation();
      notePinch(e, modsDown.ctrl);
      setPps(pps * Math.exp(-clamp(e.deltaY, -50, 50) * 0.01), e.clientX - laneLeft());
      return;
    }
    if (e.altKey || heightKey) noteWheel(`alt=${e.altKey} ctrl=${heightKey} dy=${Math.round(e.deltaY)} on ${e.target.tagName}.${e.target.getAttribute('class') || ''} row=${rowAt(e.clientY)?.dataset.row || 'none'} tool=${tool}`);
    if (heightKey) {
      e.preventDefault();
      e.stopPropagation();
      const tr = rows.find((r) => r.id === rowAt(e.clientY)?.dataset.row);
      if (!tr || !e.deltaY) return;
      const key = trackKey(tr);
      const k = (trackScale[key] || 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      const next = { ...trackScale, [key]: clamp(k, TRACK_MIN / TRACK_H[tr.kind], TRACK_MAX / TRACK_H[tr.kind]) };
      setTrackScale(next);
      savePref(`trackHeights.${tab.projectId}`, next);
    } else if (e.altKey) {
      e.preventDefault();
      const ax = e.clientX - laneLeft();
      setPps(pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18), ax);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      tab.ui.set({ scrollX: Math.max(0, scrollX + d) });
    }
  };

  wheelRef.current = onWheel;

  // ------------------------------------------------------------ drop from bin / OS
  const onDragOver = (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes('application/x-ce-items') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const row = rowAt(e.clientY);
    let t = Math.max(0, timeAt(e.clientX));
    const ph = tab.time.get().t;
    if (Math.abs(t - ph) * pps < 10) t = ph;
    else if (snap) {
      const tol = 10 / pps;
      t = nearestWithin(editPoints(seq), t, tol);
    }
    setGhost({ track: row?.dataset.row || null, t: snapTime(t, fps) });
  };
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setGhost(null); };
  const onDrop = async (e) => {
    e.preventDefault();
    const g = ghost;
    setGhost(null);
    const t = g ? g.t : Math.max(0, snapTime(timeAt(e.clientX), fps));
    const trackId = g?.track;
    const raw = e.dataTransfer.getData('application/x-ce-items');
    let mediaIds = [], seqIds = [];
    if (raw) {
      try { const items = JSON.parse(raw); mediaIds = items.media || []; seqIds = (items.ids || []).filter((id) => tab.doc.sequences.some((s) => s.id === id)); } catch { /* ignore */ }
    } else if (e.dataTransfer.files.length) {
      const files = [], paths = [];
      for (const f of e.dataTransfer.files) { const p = window.jimmyApp?.pathOf(f); if (p) paths.push(p); else files.push(f); }
      // desktop app: linked where they are on disk, nothing copied
      if (paths.length) {
        try { mediaIds.push(...((await post(`/api/p/${tab.projectId}/media/link`, { paths })).ids || [])); } catch (err) { notify(err.message, 'error'); }
      }
      if (files.length) notify(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);
      for (const f of files) {
        try { const r = await uploadFile(tab.projectId, f); mediaIds.push(...(r.ids || [])); } catch (err) { notify(err.message, 'error'); }
      }
      for (let i = 0; i < 50 && !mediaIds.every((id) => tab.mediaById[id]); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (!mediaIds.length && !seqIds.length) return;
    if (trackId && tab.seq?.tracks.find((tr) => tr.id === trackId)?.locked) { notify('That track is locked', 'info'); return; }
    if (!mediaIds.length) {
      // sequences from the bin come in as nested sequence clips (never one inside itself)
      let refused = 0;
      tab.apply('Insert nested sequence', (d, ds) => {
        let at = t;
        const sel = [];
        for (const sid of seqIds) {
          const c = insertSequence(d, ds, sid, { start: at, trackId: ds.tracks.find((x) => x.id === trackId)?.kind === 'video' ? trackId : undefined });
          if (!c) { refused++; continue; }
          sel.push(c.id);
          at = snapTime(at + c.duration, fps);
        }
        if (!sel.length) return false;
        tab.ui.set({ selection: sel });
        return undefined;
      });
      if (refused) notify(refused === seqIds.length ? "A sequence can't go inside itself" : 'Sequences that would contain this one were left out', 'error');
      return;
    }
    tab.apply('Insert media', (d, ds) => {
      let at = t;
      const sel = [];
      for (const mid of mediaIds) {
        const m = d.media.find((x) => x.id === mid);
        if (!m) continue;
        sel.push(...insertMedia(d, ds, m, { start: at, trackId }));
        at = snapTime(at + (m.type === 'image' ? d.settings.stillDuration : m.duration || 5), fps);
      }
      if (!sel.length) return false;
      tab.ui.set({ selection: sel });
      return undefined;
    });
  };

  const selected = new Set(selection);
  const gapShown = shownGap(tab, gapSel, selection);
  const flashIds = flashOn ? new Set(flash.ids) : null;

  return html`<section class="panel timeline">
    <${Tools} tab=${tab} tool=${tool} />
    <div class="tl-main">
    <${Toolbar} tab=${tab} doc=${doc} seq=${seq} snap=${snap} linked=${linked}
      pps=${pps} minPps=${minPps} maxPps=${maxPps} setPps=${setPps} fitZoom=${fitZoom} />
    <div class="tl-body" ref=${bodyRef}>
      <div class="tl-ruler-row">
        <div class="tl-corner"><${TimecodeReadout} tab=${tab} fps=${fps} /></div>
        <canvas class="tl-ruler" ref=${rulerRef} onPointerDown=${onRulerDown} onContextMenu=${onRulerContext}></canvas>
      </div>
      <div class=${`tl-tracks ${toolCursor(tool) ? 'has-tool-cursor' : ''}`} ref=${tracksRef} onPointerDown=${onLanesDown} onContextMenu=${onLanesContext}
        onDragOver=${onDragOver} onDragLeave=${onDragLeave} onDrop=${onDrop}
        style=${toolCursor(tool) ? { '--tl-cursor': toolCursor(tool), '--tl-cursor-alt': toolCursor(tool === 'zoom' ? 'zoomOut' : tool) } : null}>
        ${rows.map((tr, i) => html`
          ${i > 0 && rows[i - 1].kind === 'video' && tr.kind === 'audio' ? html`<div class="tl-divider"></div>` : null}
          <div class="tl-row tl-row-${tr.kind} ${tr.locked ? 'is-locked' : ''} ${ghost && ghost.track === tr.id ? 'is-drop' : ''}" data-row=${tr.id} key=${tr.id} style=${{ height: `${trackH(tr)}px` }}>
            <${TrackHead} tab=${tab} seq=${seq} track=${tr} />
            <div class="tl-lane tl-tool-${tool} ${tool === 'ratestretch' ? 'is-stretch' : ''}" data-lane=${tr.id}>
              <canvas class="lane-canvas" ref=${(el) => { canvases.current[tr.id] = el; }}></canvas>
              ${(byTrack[tr.id] || []).map((c) => {
                const x = c.start * pps - scrollX, w = c.duration * pps;
                if (x + w < -50 || x > width + 50) return null;
                return html`<${ClipBox} key=${c.id} clip=${c} x=${x} w=${w} pps=${pps} label=${clipLabel(c, mediaById, doc)}
                  selected=${selected.has(c.id)} flashing=${flashIds?.has(c.id)} offline=${!!c.media && (!mediaById[c.media] || mediaStatus[c.media]?.exists === false)}
                  kfTimes=${kfSel?.clipId === c.id && !kfSel.prop ? kfSel.times : null} onKf=${(e, t) => keyframeDown(tab, c, t, e, pps)}
                  h=${trackH(tr) - 6} seq=${seq} tab=${tab} prop=${lineProp?.[c.id] && propsFor(c).includes(lineProp[c.id]) ? lineProp[c.id] : propsFor(c)[0]}
                  live=${bodyTool && !tr.locked} lineTimes=${lineSel?.clipId === c.id ? lineSel.times : null} />`;
              })}
              ${gapShown && gapShown.track === tr.id ? html`<div class="tl-gap-sel" style=${{ left: `${gapShown.start * pps - scrollX}px`, width: `${(gapShown.end - gapShown.start) * pps}px` }}></div>` : null}
              ${ghost && ghost.track === tr.id ? html`<div class="tl-ghost" style=${{ left: `${ghost.t * pps - scrollX}px` }}></div>` : null}
            </div>
          </div>`)}
        <div class="tl-tail">
          <button class="btn btn-ghost btn-xs" onClick=${() => tab.apply('Add video track', (d, ds) => { addTrack(ds, 'video'); })}><${Icon} name="plus" size=${12} /> Video track</button>
          <button class="btn btn-ghost btn-xs" onClick=${() => tab.apply('Add audio track', (d, ds) => { addTrack(ds, 'audio'); })}><${Icon} name="plus" size=${12} /> Audio track</button>
          ${seq.clips.length === 0 ? html`<span class="tl-hint">Drag media here from the bin — or ask Claude to assemble an edit.</span>` : null}
        </div>
      </div>
      ${snapT != null && snapT * pps - scrollX >= 0 && snapT * pps - scrollX <= width ? html`<div class="tl-snap" style=${{ left: `${HEAD_W + snapT * pps - scrollX}px` }}></div>` : null}
      <${Playhead} tab=${tab} pps=${pps} scrollX=${scrollX} width=${width} />
      ${marquee ? html`<div class="marquee" style=${{ left: `${marquee.l}px`, top: `${marquee.t}px`, width: `${marquee.r - marquee.l}px`, height: `${marquee.b - marquee.t}px` }}></div>` : null}
    </div>
    <${HScroll} tab=${tab} pps=${pps} scrollX=${scrollX} width=${width} dur=${dur} />
    </div>
    <${AudioMeter} tab=${tab} />
    ${tip ? html`<div class="drag-tip" style=${{ left: `${tip.x + 14}px`, top: `${tip.y + 16}px` }}>${tip.text}</div>` : null}
  </section>`;
}

// ---------------------------------------------------------------- pieces

function TimecodeReadout({ tab, fps }) {
  const t = useStore(tab.time, (s) => s.t);
  return html`<span class="tc tc-small">${timecode(t, fps)}</span>`;
}

function Tools({ tab, tool }) {
  useStore(keymap, (s) => s); // the shortcut hints follow the keyboard layout
  return html`<div class="tl-tools">
    ${TOOLS.map((t) => html`<${IconButton} key=${t.id} icon=${t.icon} title=${t.title} kbd=${shortcutLabel(`tool.${t.id}`)} active=${tool === t.id} onClick=${() => tab.ui.set({ tool: t.id })} />`)}
  </div>`;
}

function Toolbar({ tab, doc, seq, snap, linked, pps, minPps, maxPps, setPps, fitZoom }) {
  useStore(keymap, (s) => s); // the shortcut hints follow the keyboard layout
  const preOn = useStore(tab.store, (s) => s.prerender?.on) || [];
  const seqMenu = (e, s) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: 'Rename…', icon: 'edit', action: async () => { const n = await promptText('Sequence name', s.name); if (n) tab.apply('Rename sequence', (d) => { findSequence(d, s.id).name = n; }); } },
      { label: 'Duplicate', icon: 'copy', shortcut: shortcutLabel('ed.dupSeq'), action: () => duplicateSeq(tab, s.id) },
      { label: 'Reframe with Claude…', icon: 'crop', action: () => openReframe(tab, s.id) },
      { label: 'Export XML (Premiere / Resolve)…', icon: 'download', action: () => exportXml(tab, s.id) },
      { label: 'Sequence settings…', icon: 'sliders', action: () => openDialog(NewSequenceDialog, { tab, edit: s }) },
      prerenderMenuItem(tab, s.id),
      ...chatMenuItems(tab, s.id),
      { separator: true },
      { label: 'Delete sequence', icon: 'trash', danger: true, disabled: doc.sequences.length < 2, action: async () => {
        if (await confirmDialog(`Delete sequence "${s.name}"?`, 'Its clips are removed. Media stays in the bin.', 'Delete')) {
          tab.apply('Delete sequence', (d) => { d.sequences = d.sequences.filter((x) => x.id !== s.id); });
          tab.ensureSequence();
        }
      } },
    ]);
  };
  return html`<div class="tl-toolbar">
    <div class="seq-tabs">
      ${doc.sequences.map((s) => html`<button class="seq-tab ${s.id === seq.id ? 'is-active' : ''}" key=${s.id}
        onClick=${() => tab.setSequence(s.id)} onContextMenu=${(e) => seqMenu(e, s)} title="${s.width}×${s.height} · ${s.fps} fps${preOn.includes(s.id) ? ' · pre-rendering' : ''}">
        <${Icon} name="seq" size=${13} />${s.name}${preOn.includes(s.id) ? html`<i class="seq-pre" title="Pre-rendering is on for this sequence"></i>` : null}</button>`)}
      <${IconButton} icon="plus" title="New sequence" onClick=${() => openDialog(NewSequenceDialog, { tab })} />
    </div>
    <div class="spacer"></div>
    <div class="tool-group">
      <${IconButton} icon="magnet" title="Snapping" kbd=${shortcutLabel('tl.snap')} active=${snap} onClick=${() => tab.ui.set({ snap: !snap })} />
      <${IconButton} icon="link" title="Linked selection (video + its audio move together; hold Alt to override)" active=${linked} onClick=${() => tab.ui.set({ linked: !linked })} />
      <${IconButton} icon="graph" title="Graph editor — value and speed curves of the selected clip's keyframes" kbd=${shortcutLabel('edit.graph')} active=${tab.ui.get().graph} onClick=${() => tab.ui.set({ graph: !tab.ui.get().graph })} />
    </div>
    <div class="tool-group">
      <${IconButton} icon="text" title="Add text at playhead" kbd=${shortcutLabel('tl.text')} onClick=${() => addTextAtPlayhead(tab)} />
      <${IconButton} icon="square" title="Add color matte at playhead" onClick=${() => tab.apply('Add color matte', (d, ds) => { const c = addSolid(ds, { start: snapTime(tab.time.get().t, ds.fps) }); tab.ui.set({ selection: [c.id], focusClip: c.id }); })} />
      <${IconButton} icon="marker" title="Add marker" kbd=${shortcutLabel('tl.marker')} onClick=${() => addMarker(tab)} />
      <${IconButton} icon="scissors" class="split-btn" title="Split at playhead" kbd=${shortcutLabel('tl.split')} onClick=${() => splitAtPlayhead(tab)} />
    </div>
    <div class="tool-group zoom">
      <${IconButton} icon="zoomOut" title="Zoom out" kbd=${shortcutLabel('tl.zoomOut')} onClick=${() => setPps(pps / 1.5)} />
      <${Slider} class="slider-sm zoom-slider" min=${Math.log2(minPps)} max=${Math.log2(maxPps)} step=${0.01} value=${Math.log2(pps)} onChange=${(v) => setPps(2 ** v)} />
      <${IconButton} icon="zoomIn" title="Zoom in" kbd=${shortcutLabel('tl.zoomIn')} onClick=${() => setPps(pps * 1.5)} />
      <${IconButton} icon="expand" title="Zoom to fit" kbd=${shortcutLabel('tl.zoomFit')} onClick=${fitZoom} />
    </div>
  </div>`;
}

function TrackHead({ tab, seq, track }) {
  const label = trackLabel(seq, track);
  const set = (label2, fn) => tab.apply(label2, (d, ds) => fn(ds.tracks.find((t) => t.id === track.id), ds));
  const menu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const empty = !seq.clips.some((c) => c.track === track.id);
    openMenu(e.clientX, e.clientY, [
      { label: 'Rename track…', icon: 'edit', action: async () => { const n = await promptText('Track name', track.name || label); if (n != null) set('Rename track', (t) => { t.name = n.trim(); }); } },
      { label: 'Add video track', icon: 'plus', action: () => tab.apply('Add video track', (d, ds) => { addTrack(ds, 'video'); }) },
      { label: 'Add audio track', icon: 'plus', action: () => tab.apply('Add audio track', (d, ds) => { addTrack(ds, 'audio'); }) },
      { label: 'Select all clips on track', action: () => tab.ui.set({ selection: seq.clips.filter((c) => c.track === track.id).map((c) => c.id) }) },
      { separator: true },
      { label: empty ? 'Delete track' : 'Delete track and its clips', icon: 'trash', danger: true,
        disabled: seq.tracks.filter((t) => t.kind === track.kind).length < 2,
        action: () => { tab.apply('Delete track', (d, ds) => { ds.tracks = ds.tracks.filter((t) => t.id !== track.id); ds.clips = ds.clips.filter((c) => c.track !== track.id); }); tab.ensureSequence(); } },
    ]);
  };
  return html`<div class="tl-head tl-head-${track.kind}" onContextMenu=${menu} onPointerDown=${(e) => e.stopPropagation()}>
    <span class="tl-head-name" title=${track.id} onDblClick=${async () => { const n = await promptText('Track name', track.name || label); if (n != null) set('Rename track', (t) => { t.name = n.trim(); }); }}>${label}</span>
    <div class="tl-head-btns">
      ${track.kind === 'video'
        ? html`<${IconButton} icon=${track.hidden ? 'eyeOff' : 'eye'} size=${14} title=${track.hidden ? 'Show track' : 'Hide track'} active=${track.hidden} onClick=${() => set(track.hidden ? 'Show track' : 'Hide track', (t) => { t.hidden = !t.hidden; })} />`
        : html`
          <button class="tbtn ${track.muted ? 'is-on is-mute' : ''}" title="Mute" onClick=${() => set(track.muted ? 'Unmute track' : 'Mute track', (t) => { t.muted = !t.muted; })}>M</button>
          <button class="tbtn ${track.solo ? 'is-on is-solo' : ''}" title="Solo" onClick=${() => set(track.solo ? 'Unsolo track' : 'Solo track', (t) => { t.solo = !t.solo; })}>S</button>`}
      <${IconButton} icon=${track.locked ? 'lock' : 'unlock'} size=${14} title=${track.locked ? 'Unlock track' : 'Lock track'} active=${track.locked} onClick=${() => set(track.locked ? 'Unlock track' : 'Lock track', (t) => { t.locked = !t.locked; })} />
    </div>
  </div>`;
}

function ClipBox({ clip, x, w, pps, label, selected, flashing, offline, onKf, kfTimes, h, seq, tab, prop, live, lineTimes }) {
  const tin = clip.transitionIn && TRANSITIONS[clip.transitionIn.type] ? clip.transitionIn : null;
  const tout = clip.transitionOut && TRANSITIONS[clip.transitionOut.type] ? clip.transitionOut : null;
  const trW = (tr) => Math.min(w, (TRANSITIONS[tr.type].center ? tr.duration / 2 : tr.duration) * pps);
  // the diamonds along the bottom are for the other properties: the one on the line has its keyframes there
  const others = { keyframes: { ...clip.keyframes, [prop]: [] } };
  const kfs = selected ? keyframeTimes(others).filter((t) => t >= -1e-6 && t <= clip.duration + 1e-6) : [];
  const fx = clip.effects && Object.values(clip.effects).some((v) => v);
  const labelPad = x < 0 ? Math.min(-x, Math.max(0, w - 60)) : 0;
  // on a narrow clip the two 8px edge handles would overlap (the right one wins, so grabbing the head
  // of the last clip extended its tail instead); keep each to a third of the clip
  const edgeW = { width: `${clamp(w / 3, 2, 8)}px` };
  return html`<div class="clip clip-${clip.type} ${selected ? 'is-selected' : ''} ${flashing ? 'is-flash' : ''} ${clip.enabled === false ? 'is-disabled' : ''} ${offline ? 'is-offline' : ''}"
    data-clip=${clip.id} onDblClick=${clip.sequence ? () => tab.setSequence(clip.sequence) : undefined} style=${{ left: `${x}px`, width: `${Math.max(3, w - 1)}px`, '--c': LABEL_COLORS[clip.label] || CLIP_COLORS[clip.type] }}>
    <div class="clip-label" style=${{ paddingLeft: `${6 + labelPad}px` }}>
      <${Icon} name=${offline ? 'alert' : TYPE_ICON[clip.sequence ? 'sequence' : clip.type]} size=${11} />
      <span class="clip-name">${label}</span>
      ${clip.speed && clip.speed !== 1 ? html`<span class="clip-badge">${Math.round(clip.speed * 1000) / 10}%</span>` : null}
      ${fx ? html`<span class="clip-badge">fx</span>` : null}
      ${w > 120 && propsFor(clip).length > 1 ? html`<button class="clip-prop" title="Choose what the line on this clip shows" onPointerDown=${(e) => e.stopPropagation()}
        onClick=${(e) => { e.stopPropagation(); openMenu(e.clientX, e.clientY, linePropItems(tab, clip)); }}>${propLabel(prop)}</button>` : null}
    </div>
    ${tin ? html`<div class="clip-tr clip-tr-in" style=${{ width: `${trW(tin)}px` }} title="${TRANSITIONS[tin.type].label} in · ${tin.duration}s"></div>` : null}
    ${tout ? html`<div class="clip-tr clip-tr-out" style=${{ width: `${trW(tout)}px` }} title="${TRANSITIONS[tout.type].label} out · ${tout.duration}s"></div>` : null}
    ${clip.type === 'audio' ? html`
      ${clip.fadeIn > 0 || clip.fadeOut > 0 ? html`<svg class="clip-fades" width=${Math.max(3, w)} height="100%" preserveAspectRatio="none">
        <polyline points="0,${h - 2} ${(clip.fadeIn || 0) * pps},18 ${w - (clip.fadeOut || 0) * pps},18 ${w},${h - 2}" />
      </svg>` : null}
      <div class="fade-handle" data-fade="in" style=${{ left: `${Math.min(w - 8, (clip.fadeIn || 0) * pps)}px` }} title="Drag to fade in"></div>
      <div class="fade-handle" data-fade="out" style=${{ left: `${Math.max(0, w - (clip.fadeOut || 0) * pps - 8)}px` }} title="Drag to fade out"></div>` : null}
    <${ClipLine} clip=${clip} prop=${prop} seq=${seq} w=${w} h=${h} pps=${pps} live=${live} selected=${lineTimes} />
    ${kfs.length ? html`<div class="clip-kfs">${kfs.map((t) => html`<span class=${`kf${kfTimes?.some((x) => Math.abs(x - t) < 1e-3) ? ' is-on' : ''}`} style=${{ left: `${t * pps}px` }}
      onPointerDown=${(e) => { e.stopPropagation(); onKf(e, t); }} onContextMenu=${(e) => { e.preventDefault(); e.stopPropagation(); }}
      title="Keyframe @ ${t.toFixed(2)}s — drag to move, Del to delete, right-click for easing"></span>`)}</div>` : null}
    <div class="clip-edge clip-edge-l" data-edge="l" style=${edgeW} title="Drag to trim · Ctrl/Cmd+drag a join to roll the cut"></div>
    <div class="clip-edge clip-edge-r" data-edge="r" style=${edgeW} title="Drag to trim · Ctrl/Cmd+drag a join to roll the cut"></div>
  </div>`;
}

function Playhead({ tab, pps, scrollX, width }) {
  const t = useStore(tab.time, (s) => s.t);
  const playing = useStore(tab.time, (s) => s.playing);
  const x = t * pps - scrollX;
  useEffect(() => {
    if (document.body.classList.contains('is-scrubbing')) return;
    if (x > width - 12 || x < 0) tab.ui.set({ scrollX: Math.max(0, t * pps - width * (playing ? 0.08 : 0.5)) });
  }, [t, playing]);
  if (x < -1 || x > width + 1) return null;
  // moved, not laid out again: a transform changes no layout (left did, on every frame while playing)
  return html`<div class="tl-playhead" style=${{ transform: `translateX(${HEAD_W + x}px)` }}><div class="tl-playhead-cap"></div></div>`;
}

function HScroll({ tab, pps, scrollX, width, dur }) {
  const total = Math.max((dur + 15) * pps, scrollX + width);
  const thumbW = Math.max(36, (width * width) / total);
  const thumbX = (scrollX / Math.max(1, total - width)) * (width - thumbW);
  const onDown = (e) => {
    e.preventDefault();
    const x0 = e.clientX, s0 = scrollX;
    const move = (ev) => tab.ui.set({ scrollX: clamp(s0 + ((ev.clientX - x0) * (total - width)) / Math.max(1, width - thumbW), 0, Math.max(0, total - width)) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return html`<div class="tl-scroll" style=${{ marginLeft: `${HEAD_W}px` }}>
    <div class="tl-scroll-thumb" style=${{ width: `${thumbW}px`, transform: `translateX(${thumbX}px)` }} onPointerDown=${onDown}></div>
  </div>`;
}

// ---------------------------------------------------------------- shared actions (menus & keys)

export function splitAtPlayhead(tab) {
  const t = snapTime(tab.time.get().t, tab.seq.fps);
  const sel = new Set(tab.ui.get().selection);
  tab.apply('Split', (d, ds) => (splitAt(ds, t, sel.size ? sel : null).length ? undefined : false));
}
// Q / W: ripple trim from the previous edit to the playhead (the playhead then sits on that edit, like Premiere),
// or from the playhead to the next edit.
export function rippleTrimPlayhead(tab, dir) {
  const t = snapTime(tab.time.get().t, tab.seq.fps);
  const sel = new Set(tab.ui.get().selection);
  let range = null;
  const ok = tab.apply(dir === 'prev' ? 'Ripple trim previous edit' : 'Ripple trim next edit', (d, ds) => {
    range = rippleTrimToPlayhead(ds, t, dir, sel);
    return range ? undefined : false;
  });
  if (!ok) { if (!range) notify('Put the playhead over a clip to ripple trim', 'info'); return; }
  if (dir === 'prev') { tab.engine.pause(); tab.engine.seek(range[0]); }
}
export function addTextAtPlayhead(tab) {
  tab.apply('Add text', (d, ds) => {
    const c = addText(ds, { start: snapTime(tab.time.get().t, ds.fps) });
    tab.ui.set({ selection: [c.id], focusClip: c.id });
  });
  setTimeout(() => window.dispatchEvent(new CustomEvent('ce:edit-text')), 60);
}
export function addMarker(tab) {
  const t = snapTime(tab.time.get().t, tab.seq.fps);
  tab.apply('Add marker', (d, ds) => { ds.markers.push({ id: uid('mk'), t, label: '', color: '#f5a524' }); });
}
export function deleteSelection(tab, ripple) {
  const ids = new Set(tab.ui.get().selection);
  if (!ids.size) return;
  tab.apply(ripple ? 'Ripple delete' : 'Delete', (d, ds) => {
    const locked = new Set(ds.tracks.filter((t) => t.locked).map((t) => t.id));
    for (const c of ds.clips) if (locked.has(c.track)) ids.delete(c.id);
    deleteClips(ds, ids, { ripple });
  });
  tab.ui.set({ selection: [] });
}
export function copySelection(tab, cut = false) {
  const ids = new Set(tab.ui.get().selection);
  const clips = tab.seq.clips.filter((c) => ids.has(c.id));
  if (!clips.length) return;
  clipboard.clips = deepClone(clips);
  if (cut) deleteSelection(tab, false);
  else notify(`Copied ${clips.length} clip${clips.length > 1 ? 's' : ''}`);
}
export function paste(tab) {
  if (!clipboard.clips.length) return;
  const t = snapTime(tab.time.get().t, tab.seq.fps);
  tab.apply('Paste', (d, ds) => { tab.ui.set({ selection: pasteClips(ds, clipboard.clips, t) }); });
}

function transitionItems(tab, clip, which) {
  const key = which === 'in' ? 'transitionIn' : 'transitionOut';
  const cur = clip[key];
  const list = Object.entries(TRANSITIONS).filter(([, def]) => which === 'in' || !def.pair || !def.center);
  return [
    { label: 'None', checked: !cur, action: () => tab.apply('Remove transition', (d, ds) => { ds.clips.find((c) => c.id === clip.id)[key] = null; }) },
    { separator: true },
    ...list.map(([type, def]) => ({
      label: def.label, checked: cur?.type === type,
      action: () => tab.apply(`Add ${def.label.toLowerCase()}`, (d, ds) => {
        const c = ds.clips.find((x) => x.id === clip.id);
        c[key] = { type, duration: cur?.duration || Math.min(d.settings.transitionDuration || 0.5, c.duration / 2) };
      }),
    })),
  ];
}

const linePropItems = (tab, clip) => propsFor(clip).map((p) => ({ label: propLabel(p), checked: shownProp(tab, clip) === p, action: () => showProp(tab, clip, p) }));

export function clipMenu(tab, clip) {
  const seq = tab.seq;
  const sel = tab.ui.get().selection;
  const media = clip.media ? tab.mediaById[clip.media] : null;
  const visual = isVisualClip(clip);
  const ids = new Set(sel.length ? sel : [clip.id]);
  return [
    { label: 'Split at playhead', icon: 'scissors', shortcut: shortcutLabel('tl.split'), action: () => splitAtPlayhead(tab) },
    { separator: true },
    { label: 'Cut to clipboard', shortcut: shortcutLabel('ed.cut'), action: () => copySelection(tab, true) },
    { label: 'Copy', icon: 'copy', shortcut: shortcutLabel('ed.copy'), action: () => copySelection(tab) },
    { label: 'Paste at playhead', icon: 'paste', shortcut: shortcutLabel('ed.paste'), disabled: !clipboard.clips.length, action: () => paste(tab) },
    { separator: true },
    visual ? { label: 'Transition in', icon: 'layers', items: transitionItems(tab, clip, 'in') } : null,
    visual ? { label: 'Transition out', icon: 'layers', items: transitionItems(tab, clip, 'out') } : null,
    visual && media ? { label: 'Fit to frame', icon: 'expand', action: () => tab.apply('Fit to frame', (d, ds) => fitClip(ds.clips.find((c) => c.id === clip.id), media, ds, 'fit')) } : null,
    visual && media ? { label: 'Fill frame', icon: 'fullscreen', action: () => tab.apply('Fill frame', (d, ds) => fitClip(ds.clips.find((c) => c.id === clip.id), media, ds, 'fill')) } : null,
    propsFor(clip).length > 1 ? { label: 'Show on clip line', icon: 'graph', items: linePropItems(tab, clip) } : null,
    { label: 'Speed / Duration…', icon: 'gauge', shortcut: shortcutLabel('tl.speed'), action: () => openSpeedDialog(tab, [...ids]) },
    usesSourceTime(clip) ? { label: 'Speed presets', icon: 'gauge', items: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((s) => ({ label: `${s}×`, checked: (clip.speed || 1) === s, action: () => tab.apply(`Speed ${s}×`, (d, ds) => setSpeed(ds, linkedIds(ds, ids), s)) })) } : null,
    { separator: true },
    { label: 'Enable', checked: clip.enabled !== false, shortcut: shortcutLabel('tl.enable'), action: () => toggleEnabled(tab, [...ids]) },
    clip.link
      ? { label: 'Unlink audio/video', icon: 'link', action: () => tab.apply('Unlink', (d, ds) => { const l = clip.link; for (const c of ds.clips) if (c.link === l) c.link = null; }) }
      : ids.size > 1 ? { label: 'Link selected', icon: 'link', action: () => tab.apply('Link', (d, ds) => { const l = uid('l'); for (const c of ds.clips) if (ids.has(c.id)) c.link = l; }) } : null,
    linkedIds(tab.seq, [...ids]).size > 1 && new Set(tab.seq.clips.filter((c) => linkedIds(tab.seq, [...ids]).has(c.id)).map((c) => c.link || c.id)).size > 1
      ? { label: 'Synchronize…', icon: 'layers', action: () => openSync(tab, [...ids]) } : null,
    clip.sequence ? { label: 'Open nested sequence', icon: 'seq', action: () => tab.setSequence(clip.sequence) } : null,
    { label: 'Nest…', icon: 'layers', title: 'Put the selected clips into a new sequence and use it here as one clip', action: async () => {
      const n = await promptText('Nested sequence name', `${tab.seq.name} nest`);
      if (!n) return;
      let made = null;
      tab.apply('Nest', (d, ds) => { made = nestClips(d, ds, [...linkedIds(ds, [...ids])], n.trim()); return made ? undefined : false; });
      if (made) { tab.ui.set({ selection: [made.clip.id], focusClip: made.clip.id }); notify(`Nested into "${made.sequence.name}". Double-click it to open it`, 'success'); }
    } },
    { label: 'Label', items: labelItems(tab, ids, clip) },
    { label: 'Rename…', icon: 'edit', action: async () => { const n = await promptText('Clip name', clip.name || clipLabel(clip, tab.mediaById, tab.doc)); if (n != null) tab.apply('Rename clip', (d, ds) => { ds.clips.find((c) => c.id === clip.id).name = n; }); } },
    media ? { label: 'Reveal in bin', icon: 'folder', action: () => tab.ui.set({ binSelection: [media.id], binReveal: Date.now() }) } : null,
    { separator: true },
    { label: 'Delete', icon: 'trash', danger: true, shortcut: shortcutLabel('tl.delete'), action: () => deleteSelection(tab, false) },
    { label: 'Ripple delete', danger: true, shortcut: shortcutLabel('tl.rippleDelete'), action: () => deleteSelection(tab, true) },
    { label: 'Ripple trim previous edit to playhead', shortcut: shortcutLabel('tl.trimPrev'), action: () => rippleTrimPlayhead(tab, 'prev') },
    { label: 'Ripple trim next edit to playhead', shortcut: shortcutLabel('tl.trimNext'), action: () => rippleTrimPlayhead(tab, 'next') },
  ].filter(Boolean);
}

// Right-click › Label: a colour for the selected clips (and the clips linked to them), or back to their type's colour
const LABEL_NAMES = { violet: 'Violet', iris: 'Iris', caribbean: 'Caribbean', lavender: 'Lavender', cerulean: 'Cerulean', forest: 'Forest',
  rose: 'Rose', mango: 'Mango', purple: 'Purple', blue: 'Blue', teal: 'Teal', magenta: 'Magenta', tan: 'Tan', green: 'Green', brown: 'Brown', yellow: 'Yellow' };
function labelItems(tab, ids, clip) {
  const set = (label) => tab.apply(label ? `Label ${LABEL_NAMES[label]}` : 'Remove label', (d, ds) => {
    const all = linkedIds(ds, [...ids]);
    for (const c of ds.clips) if (all.has(c.id)) { if (label) c.label = label; else delete c.label; }
  });
  return [
    { label: 'None (by type)', swatch: '', checked: !clip.label, action: () => set(null) },
    { separator: true },
    ...Object.keys(LABEL_COLORS).map((k) => ({ label: LABEL_NAMES[k], swatch: LABEL_COLORS[k], checked: clip.label === k, action: () => set(k) })),
  ];
}

// Shared by the sequence tab menu, the bin and the export dialog.
// Pre-rendering is off for every sequence until it's turned on for that one (server/prerender.js).
export function prerenderMenuItem(tab, seqId) {
  const pre = tab.store.get().prerender;
  const on = !!pre?.on?.includes(seqId);
  return {
    label: 'Pre-render this sequence', checked: on,
    disabled: pre && !pre.enabled,
    action: async () => {
      try {
        const info = await post(`/api/p/${tab.projectId}/prerender`, { sequenceId: seqId, on: !on });
        tab.store.set({ prerender: { ...tab.store.get().prerender, ...info } });
        notify(on ? 'Pre-rendering is off for this sequence' : 'Pre-rendering this sequence in the background', 'info');
      } catch (err) { notify(err.message, 'error'); }
    },
  };
}

export function exportXml(tab, seqId) {
  const sk = downloadSequenceXml(tab, seqId);
  if (!sk) return;
  const left = [sk.text && `${sk.text} text`, sk.solid && `${sk.solid} color matte`, sk.transitions && `transitions on ${sk.transitions} clip(s)`, sk.effects && `color effects on ${sk.effects} clip(s)`, sk.luts && `LUTs on ${sk.luts} clip(s)`, sk.keyframed && `keyframes on ${sk.keyframed} clip(s)`, sk.missing && `${sk.missing} offline clip(s)`].filter(Boolean);
  notify(`XML saved to Downloads — in Premiere: File > Import.${left.length ? ` Not included: ${left.join(', ')}.` : ''}`, left.length ? 'warn' : 'success');
}
export function duplicateSeq(tab, id) {
  tab.apply('Duplicate sequence', (d) => { const c = duplicateSequence(d, id); if (!c) return false; setTimeout(() => tab.setSequence(c.id), 0); return undefined; });
}

// ------------------------------------------------------------------ keyframe diamonds

// The selected keyframes, while their clip is still selected (the diamonds are only drawn on selected clips).
const selectedKfClip = (tab) => {
  const { kfSel: ks, selection } = tab.ui.get();
  const clip = ks && selection.includes(ks.clipId) && tab.seq?.clips.find((c) => c.id === ks.clipId);
  return clip && ks.times.length ? { clip, times: ks.times, prop: ks.prop } : null;
};
// The point closest to t within the tolerance, or t itself.
// A keyframe picked on a clip's line stands for that property alone; a diamond for every property at its time.
const pickedKeys = (c, cur, fps) => keysAtTimes(c, cur.times, fps).filter((k) => !cur.prop || k.prop === cur.prop);
const nearestWithin = (points, t, tol) => {
  let best = t, dist = tol;
  for (const p of points) { const d = Math.abs(p - t); if (d < dist) { best = p; dist = d; } }
  return best;
};

export function deleteSelectedKeyframes(tab) {
  const cur = selectedKfClip(tab);
  if (!cur) return false;
  const fps = tab.seq.fps;
  tab.apply(cur.times.length > 1 ? 'Delete keyframes' : 'Delete keyframe', (d, ds) => {
    const c = ds.clips.find((x) => x.id === cur.clip.id);
    if (!c) return false;
    deleteKeyframes(c, pickedKeys(c, cur, fps), fps);
    return undefined;
  });
  tab.ui.set({ kfSel: null });
  return true;
}

export function easeSelectedKeyframes(tab, kind) {
  const cur = selectedKfClip(tab);
  if (!cur) return false;
  const fps = tab.seq.fps;
  const label = { easy: 'Easy ease', easyIn: 'Easy ease in', easyOut: 'Easy ease out', linear: 'Linear keyframes', hold: 'Hold keyframes' }[kind];
  tab.apply(label, (d, ds) => {
    const c = ds.clips.find((x) => x.id === cur.clip.id);
    if (!c) return false;
    setKeyframeInterp(c, pickedKeys(c, cur, fps), kind, fps);
    return undefined;
  });
  return true;
}

// Press on a diamond: select it (Shift/Ctrl adds), move the playhead there, and drag to move every
// selected keyframe in time. Right button opens the keyframe menu.
function keyframeDown(tab, clip, t, e, pps) {
  const fps = tab.seq.fps;
  const ui = tab.ui.get();
  const prev = ui.kfSel?.clipId === clip.id ? ui.kfSel.times : [];
  const has = prev.some((x) => Math.abs(x - t) < 1e-3);
  const add = e.shiftKey || e.ctrlKey || e.metaKey;
  let times = add ? (has ? prev.filter((x) => Math.abs(x - t) >= 1e-3) : [...prev, t]) : has ? prev : [t];
  if (!ui.selection.includes(clip.id)) tab.ui.set({ selection: [clip.id] });
  tab.ui.set({ kfSel: { clipId: clip.id, times } });
  if (e.button === 2) { keyframeMenu(tab, e); return; }
  tab.engine.seek(clip.start + t);
  if (!times.length) return;
  const keys = keysAtTimes(clip, times, fps);
  const x0 = e.clientX;
  let dt = 0, moved = false;
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) { moved = true; tab.begin(); document.body.classList.add('is-scrubbing'); }
    const raw = (ev.clientX - x0) / pps;
    dt = snapTime(clampKeyframeShift(clip, keys, raw), fps);
    dt = clampKeyframeShift(clip, keys, dt);
    tab.preview((d, ds) => {
      const c = ds.clips.find((x) => x.id === clip.id);
      if (c) moveKeyframes(c, keys, dt, fps);
    });
    tab.engine.seek(clip.start + t + dt);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('is-scrubbing');
    if (!moved) return;
    tab.end(keys.length > 1 ? 'Move keyframes' : 'Move keyframe');
    tab.ui.set({ kfSel: { clipId: clip.id, times: times.map((x) => x + dt) } });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function lineKfMenu(tab, e) {
  const n = tab.ui.get().kfSel?.times.length || 0;
  openMenu(e.clientX, e.clientY, [
    { label: 'Linear', action: () => easeSelectedKeyframes(tab, 'linear') },
    { label: 'Bezier', action: () => easeSelectedKeyframes(tab, 'easy') },
    { label: 'Hold', action: () => easeSelectedKeyframes(tab, 'hold') },
    { label: 'Ease In', action: () => easeSelectedKeyframes(tab, 'easyIn') },
    { label: 'Ease Out', action: () => easeSelectedKeyframes(tab, 'easyOut') },
    { separator: true },
    { label: n > 1 ? `Delete ${n} keyframes` : 'Delete', icon: 'trash', danger: true, shortcut: shortcutLabel('tl.delete'), action: () => deleteSelectedKeyframes(tab) },
  ]);
}

function keyframeMenu(tab, e) {
  const n = tab.ui.get().kfSel?.times.length || 0;
  openMenu(e.clientX, e.clientY, [
    { label: 'Easy ease', shortcut: shortcutLabel('ed.ease'), action: () => easeSelectedKeyframes(tab, 'easy') },
    { label: 'Easy ease in', shortcut: shortcutLabel('ed.easeIn'), action: () => easeSelectedKeyframes(tab, 'easyIn') },
    { label: 'Easy ease out', shortcut: shortcutLabel('ed.easeOut'), action: () => easeSelectedKeyframes(tab, 'easyOut') },
    { label: 'Linear', action: () => easeSelectedKeyframes(tab, 'linear') },
    { label: 'Hold', action: () => easeSelectedKeyframes(tab, 'hold') },
    { separator: true },
    { label: 'Graph editor', icon: 'graph', shortcut: shortcutLabel('edit.graph'), action: () => tab.ui.set({ graph: true }) },
    { separator: true },
    { label: n > 1 ? `Delete ${n} keyframes` : 'Delete keyframe', icon: 'trash', danger: true, shortcut: shortcutLabel('tl.delete'), action: () => deleteSelectedKeyframes(tab) },
  ]);
}

// Enable/Disable (Premiere's Shift+E): a disabled clip stays on the timeline, greyed out, but is not seen or
// heard in playback and exports. If any of the clips is enabled they all get disabled, otherwise enabled.
export function toggleEnabled(tab, ids = tab.ui.get().selection) {
  const set = new Set(ids);
  const clips = (tab.seq?.clips || []).filter((c) => set.has(c.id));
  if (!clips.length) return false;
  const on = !clips.some((c) => c.enabled !== false);
  tab.apply(on ? 'Enable clip' : 'Disable clip', (d, ds) => { for (const c of ds.clips) if (set.has(c.id)) c.enabled = on; });
  return true;
}

// Keyboard shortcuts for the timeline. Returns true if handled.
// cmd: the command the key runs in the Edit tab (keymap.js commandOf)
// The selected gap, if it is still exactly a gap in the sequence on screen and no clip is selected (an edit that
// fills or moves it, another sequence, or a clip being selected makes it go away).
function shownGap(tab, g, selection) {
  const s = tab.seq;
  if (!g || !s || g.seq !== s.id || selection.length) return null;
  const now = gapAt(s, g.track, (g.start + g.end) / 2);
  return now && Math.abs(now.start - g.start) < 1e-6 && Math.abs(now.end - g.end) < 1e-6 ? g : null;
}
// Ripple delete a gap: every unlocked track moves left with it (ops.js closeGap); refused, and said why, when a clip
// on another track is in the gap's time.
export function rippleCloseGap(tab, trackId, gap) {
  const s = tab.seq;
  let r = null;
  tab.apply('Ripple delete gap', (d, ds) => { r = closeGap(ds, trackId, gap); return r.moved ? undefined : false; });
  if (r?.blocked) {
    const tr = s.tracks.find((x) => x.id === r.blocked);
    notify(`Can't close this gap: ${tr ? trackLabel(s, tr) : 'another track'} has a clip in that time. Move or trim it first, or lock that track.`, 'error');
    return false;
  }
  tab.ui.set({ gapSel: null });
  return true;
}

export function handleTimelineKey(tab, e, cmd) {
  const seq = tab.seq;
  if (!seq || !cmd) return false;
  // text selected on the page (chat, warnings): copy / cut / select all belong to it, not to the timeline
  if ((cmd === 'ed.copy' || cmd === 'ed.cut' || cmd === 'ed.selectAll') && window.getSelection && !window.getSelection().isCollapsed) return false;
  if (cmd === 'tl.split') { splitAtPlayhead(tab); return true; }
  if (cmd === 'tl.speed') { openSpeedDialog(tab); return true; }
  if (cmd === 'ed.dupSeq') { duplicateSeq(tab, seq.id); return true; }
  if (cmd === 'ed.copy') { copySelection(tab); return true; }
  if (cmd === 'ed.cut') { copySelection(tab, true); return true; }
  if (cmd === 'ed.paste') { paste(tab); return true; }
  if (cmd === 'ed.selectAll') { tab.ui.set({ selection: seq.clips.map((c) => c.id) }); return true; }
  if (cmd === 'tl.delete' || cmd === 'tl.rippleDelete') {
    if (deleteSelectedKeyframes(tab)) return true;
    const g = shownGap(tab, tab.ui.get().gapSel, tab.ui.get().selection);
    if (g) { rippleCloseGap(tab, g.track, g); return true; }
    deleteSelection(tab, cmd === 'tl.rippleDelete');
    return true;
  }
  if (cmd === 'edit.graph') { tab.ui.set({ graph: !tab.ui.get().graph }); return true; }
  if (cmd === 'tl.trimPrev' || cmd === 'tl.trimNext') { rippleTrimPlayhead(tab, cmd === 'tl.trimPrev' ? 'prev' : 'next'); return true; }
  if (cmd === 'tl.enable') { toggleEnabled(tab); return true; }
  if (cmd === 'ed.ease' || cmd === 'ed.easeIn' || cmd === 'ed.easeOut') { easeSelectedKeyframes(tab, { 'ed.ease': 'easy', 'ed.easeIn': 'easyIn', 'ed.easeOut': 'easyOut' }[cmd]); return true; }
  if (cmd.startsWith('tool.')) { tab.ui.set({ tool: cmd.slice(5) }); return true; }
  if (cmd === 'tl.snap') { tab.ui.set({ snap: !tab.ui.get().snap }); return true; }
  if (cmd === 'tl.text') { addTextAtPlayhead(tab); return true; }
  if (cmd === 'tl.marker') { addMarker(tab); return true; }
  if (cmd === 'tl.in') { const t = snapTime(tab.time.get().t, seq.fps); tab.apply('Set in', (d, ds) => { ds.inPoint = t; if (ds.outPoint != null && ds.outPoint <= t) ds.outPoint = null; }); return true; }
  if (cmd === 'tl.out') { const t = snapTime(tab.time.get().t, seq.fps); tab.apply('Set out', (d, ds) => { ds.outPoint = t; if (ds.inPoint != null && ds.inPoint >= t) ds.inPoint = null; }); return true; }
  if (cmd === 'tl.clearInOut') { tab.apply('Clear in/out', (d, ds) => { ds.inPoint = null; ds.outPoint = null; }); return true; }
  if (cmd === 'tl.deselect') { tab.ui.set(selectedKfClip(tab) ? { kfSel: null } : { kfSel: null, selection: [], gapSel: null }); return true; }
  const ui = tab.ui.get();
  // zoom keys keep the playhead where it is on screen
  const zoomKey = (f) => {
    const p = clamp(ui.pps * f, 0.5, seq.fps * 40);
    const t = tab.time.get().t;
    const ax = clamp(t * ui.pps - ui.scrollX, 0, (document.querySelector('.tl-body')?.clientWidth || 900) - HEAD_W);
    tab.ui.set({ pps: p, scrollX: Math.max(0, t * p - ax) });
  };
  if (cmd === 'tl.zoomIn') { zoomKey(1.5); return true; }
  if (cmd === 'tl.zoomOut') { zoomKey(1 / 1.5); return true; }
  if (cmd === 'tl.zoomFit') {
    const w = document.querySelector('.tl-body')?.clientWidth - HEAD_W || 800;
    tab.ui.set({ pps: Math.max(0.5, (w - 40) / Math.max(1, sequenceDuration(seq))), scrollX: 0 });
    return true;
  }
  if (cmd === 'play.prevEdit' || cmd === 'play.nextEdit') {
    const t = tab.time.get().t;
    const pts = editPoints(seq);
    const next = cmd === 'play.nextEdit' ? pts.find((p) => p > t + 1e-4) : [...pts].reverse().find((p) => p < t - 1e-4);
    if (next != null) { tab.engine.pause(); tab.engine.seek(next); }
    return true;
  }
  return false;
}
