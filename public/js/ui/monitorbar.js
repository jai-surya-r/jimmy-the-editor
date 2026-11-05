// The monitors' time bar, as in Premiere's Program monitor (Step 82): a time ruler with the playhead (click or drag on
// it to move the playhead) and, under it, a zoom bar: drag its round ends to zoom in or out, its middle to move along,
// double-click it to see the whole length again. Alt + wheel or a trackpad pinch over the bar zooms around the cursor
// (as on the timeline); Shift + wheel or a sideways swipe moves along. It says how far it is zoomed and which stretch
// is in view. While playing, the view turns the page when the playhead runs out of it.
// Used by the Program monitor (Viewer) and the Review player (Review).
import { html } from './common.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { timecode } from '../core/model.js';
import { drawRuler } from './timeline-draw.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The stretch in view, [v0, v1] in seconds (all of it until zoomed). Ten frames at the most zoomed.
export function useMonitorZoom(dur, fps) {
  // the view lives in a ref, so several wheel steps before the next redraw each build on the last one
  const ref = useRef(null);
  const [, redraw] = useState(0);
  const total = Math.max(0, dur || 0);
  const minSpan = Math.min(total, Math.max(10 / (fps || 25), 0.2));
  const range = () => {
    const view = ref.current;
    if (!view || !(total > 0)) return [0, total];
    const span = clamp(view[1] - view[0], minSpan, total);
    const s = clamp(view[0], 0, total - span);
    return [s, s + span];
  };
  const put = (v) => { ref.current = v; redraw((n) => n + 1); };
  const [v0, v1] = range();
  const z = { v0, v1, dur: total, fps, zoomed: v1 - v0 < total - 1e-6 };
  z.set = (a, b) => {
    if (!(total > 0)) return;
    const span = clamp(b - a, minSpan, total);
    if (span >= total - 1e-6) { put(null); return; }
    const s = clamp(a, 0, total - span);
    put([s, s + span]);
  };
  // zoom by a factor (>1 in) keeping the time under the cursor where it is
  z.zoomAt = (f, at) => {
    const [a, b] = range();
    const span = clamp((b - a) / f, minSpan, total);
    const k = b - a > 0 ? (at - a) / (b - a) : 0.5;
    z.set(at - k * span, at - k * span + span);
  };
  z.pan = (dt) => { const [a, b] = range(); z.set(a + dt, b + dt); };
  z.fit = () => put(null);
  z.now = range; // the stretch in view right now (also between redraws)
  return z;
}

// Alt + wheel / pinch zooms, Shift + wheel or a sideways swipe moves along. `fracAt(clientX)`: where the cursor is
// along the bar's time scale, 0..1.
export function useZoomWheel(ref, z, fracAt) {
  const cur = useRef(null);
  cur.current = { z, fracAt };
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const on = (e) => {
      const { z: zz, fracAt: at } = cur.current;
      if (!(zz.dur > 0)) return;
      const w = el.getBoundingClientRect().width || 1;
      const [a, b] = zz.now();
      if (e.altKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        // a pinch (ctrlKey, small steps) zooms smoothly; a wheel notch by a fixed step
        const pinch = e.ctrlKey && Math.abs(e.deltaY) < 50;
        const f = pinch ? Math.exp(-clamp(e.deltaY, -50, 50) * 0.01) : e.deltaY < 0 ? 1.25 : 1 / 1.25;
        zz.zoomAt(f, a + clamp(at(e.clientX), 0, 1) * (b - a));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (b - a >= zz.dur - 1e-6) return;
        e.preventDefault();
        zz.pan(((e.shiftKey ? e.deltaY : e.deltaX) / w) * (b - a));
      }
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []);
}

// while playing, the view keeps the playhead in sight (turning the page, as Premiere does)
export function useFollow(z, t, playing) {
  useEffect(() => {
    if (!playing || !z.zoomed) return;
    const span = z.v1 - z.v0;
    if (t > z.v1 || t < z.v0) z.set(t - span * 0.02, t - span * 0.02 + span);
  }, [playing, Math.floor(t * 4)]);
}

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return w;
}

// The time ruler: ticks and times for the stretch in view, in/out, markers, and the playhead. onSeek(t, phase):
// phase 'start' | 'move' | 'end' (a click is a start and an end).
export function MonitorRuler({ z, t, fps, onSeek, inPoint = null, outPoint = null, markers = null, comments = null }) {
  const ref = useRef(null), cv = useRef(null);
  const w = useWidth(ref);
  const span = Math.max(1e-6, z.v1 - z.v0);
  useEffect(() => {
    if (!cv.current || !w) return;
    const pps = w / span;
    drawRuler(cv.current, { pps, scrollX: z.v0 * pps, width: w, seq: { fps }, markers, comments, inPoint, outPoint });
  }, [w, z.v0, z.v1, fps, markers, comments, inPoint, outPoint]);
  const at = (x) => z.v0 + clamp((x - ref.current.getBoundingClientRect().left) / (w || 1), 0, 1) * span;
  const down = (e) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer (a synthetic event) */ }
    document.body.classList.add('is-scrubbing');
    onSeek(at(e.clientX), 'start');
    const move = (ev) => onSeek(at(ev.clientX), 'move');
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('is-scrubbing');
      onSeek(at(ev.clientX), 'end');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const x = ((t - z.v0) / span) * 100;
  return html`<div class="mon-ruler" ref=${ref} onPointerDown=${down} title="Click or drag to move the playhead · Alt + wheel or pinch to zoom">
    <canvas ref=${cv}></canvas>
    ${x >= -0.5 && x <= 100.5 ? html`<div class="mon-head" style=${{ transform: `translateX(${(x / 100) * (w || 0)}px)` }}></div>` : null}
  </div>`;
}

// The zoom bar under the ruler, with what is in view.
export function ZoomBar({ z, extra = null }) {
  const ref = useRef(null);
  const w = useWidth(ref);
  const { dur, fps } = z;
  const pct = (s) => `${dur > 0 ? (s / dur) * 100 : 0}%`;
  const drag = (e, what) => {
    if (e.button !== 0 || !(dur > 0)) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer (a synthetic event) */ }
    const x0 = e.clientX, a0 = z.v0, b0 = z.v1;
    const perPx = dur / Math.max(1, w);
    const move = (ev) => {
      const d = (ev.clientX - x0) * perPx;
      if (what === 'a') z.set(Math.min(a0 + d, b0), b0);
      else if (what === 'b') z.set(a0, Math.max(b0 + d, a0));
      else z.set(a0 + d, b0 + d);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  // a click on the bar beside the thumb jumps the view there
  const jump = (e) => {
    if (e.button !== 0 || !(dur > 0) || !z.zoomed) return;
    const r = ref.current.getBoundingClientRect();
    const c = ((e.clientX - r.left) / Math.max(1, r.width)) * dur, span = z.v1 - z.v0;
    z.set(c - span / 2, c + span / 2);
  };
  const level = z.zoomed ? `${(dur / Math.max(1e-6, z.v1 - z.v0)).toFixed((dur / (z.v1 - z.v0)) < 10 ? 1 : 0)}×` : 'Fit';
  return html`<div class="mon-zoom">
    <div class="mon-zoom-track" ref=${ref} onPointerDown=${jump} onDblClick=${() => z.fit()} title="Drag the ends to zoom, the middle to move along · double-click for the whole length">
      <div class="mon-zoom-thumb ${z.zoomed ? 'is-zoomed' : ''}" style=${{ left: pct(z.v0), width: pct(z.v1 - z.v0) }} onPointerDown=${(e) => drag(e, 'mid')}>
        <span class="mon-zoom-end is-a" onPointerDown=${(e) => drag(e, 'a')}></span>
        <span class="mon-zoom-end is-b" onPointerDown=${(e) => drag(e, 'b')}></span>
      </div>
    </div>
    <span class="mon-zoom-info" title="Zoom level · the stretch in view">
      <b class=${z.zoomed ? 'is-zoomed' : ''} onClick=${() => z.fit()}>${level}</b> ${timecode(z.v0, fps)} – ${timecode(z.v1, fps)}${extra ? html` · ${extra}` : null}
    </span>
  </div>`;
}
