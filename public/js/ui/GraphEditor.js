// Graph editor (After Effects style): value and speed curves for the selected clip's keyframes, in a
// small floating window. Left: the clip's animated properties (all, or a chosen few). Right: the graph —
// drag keyframes in time/value, drag bezier handles to shape the ease, F9 assists, Delete removes.
import { html, Icon, IconButton, Segmented } from './common.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { evalKeyframes, speedAt, segmentBezier, clamp, snapTime, timecode } from '../core/model.js';
import { bakeSegment, setKeyframeInterp, deleteKeyframes } from '../core/ops.js';
import { commandOf } from './keymap.js';

const PROPS = {
  x: { label: 'Position X', unit: 'px', mult: 1, color: '#ff6b6b' },
  y: { label: 'Position Y', unit: 'px', mult: 1, color: '#51cf66' },
  scale: { label: 'Scale', unit: '%', mult: 100, color: '#4dabf7' },
  rotation: { label: 'Rotation', unit: '°', mult: 1, color: '#fcc419' },
  opacity: { label: 'Opacity', unit: '%', mult: 100, color: '#e599f7' },
  volume: { label: 'Volume', unit: '×', mult: 1, color: '#20c997' },
  brightness: { label: 'Brightness', unit: '%', mult: 100, color: '#ffa94d' },
  contrast: { label: 'Contrast', unit: '%', mult: 100, color: '#74c0fc' },
  saturation: { label: 'Saturation', unit: '%', mult: 100, color: '#f783ac' },
  hue: { label: 'Hue', unit: '°', mult: 1, color: '#a9e34b' },
  grayscale: { label: 'Grayscale', unit: '%', mult: 100, color: '#ced4da' },
  blur: { label: 'Blur', unit: 'px', mult: 1, color: '#9775fa' },
  cropLeft: { label: 'Crop left', unit: '%', mult: 100, color: '#ff8787' },
  cropTop: { label: 'Crop top', unit: '%', mult: 100, color: '#8ce99a' },
  cropRight: { label: 'Crop right', unit: '%', mult: 100, color: '#91a7ff' },
  cropBottom: { label: 'Crop bottom', unit: '%', mult: 100, color: '#ffd43b' },
};
const meta = (p) => PROPS[p] || { label: p, unit: '', mult: 1, color: '#adb5bd' };
const fmt = (v, p) => { const m = meta(p); const x = v * m.mult; return `${Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(Math.abs(x) >= 10 ? 1 : 2)}${m.unit}`; };

const PAD = { l: 46, r: 14, t: 22, b: 10 };
const HIT = 7;
const keyId = (prop, t) => `${prop}|${t.toFixed(5)}`;

export function GraphEditor({ tab }) {
  const doc = useStore(tab.store, (s) => s.doc);
  const selection = useStore(tab.ui, (s) => s.selection);
  const mode = useStore(tab.ui, (s) => s.graphMode) || 'value';
  const shownPref = useStore(tab.ui, (s) => s.graphProps);
  const box = useStore(tab.ui, (s) => s.graphBox) || { x: 24, y: 24, w: 720, h: 320 };
  const now = useStore(tab.time, (s) => s.t);
  const seq = doc ? tab.seq : null;
  const clip = seq && seq.clips.find((c) => selection.includes(c.id) && Object.keys(c.keyframes || {}).length)
    || (seq && seq.clips.find((c) => c.id === selection[0])) || null;
  const fps = seq?.fps || 30;
  const props = clip ? Object.keys(clip.keyframes || {}).filter((p) => clip.keyframes[p]?.length) : [];
  const shown = props.filter((p) => !shownPref || shownPref.includes(p));
  const [sel, setSel] = useState([]); // [{ prop, t }]
  const [view, setView] = useState(null); // [t0, t1] clip-local; null = fit
  const [marquee, setMarquee] = useState(null);
  const [hover, setHover] = useState(null);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const geo = useRef(null);
  // while dragging, the vertical scale stays put (otherwise the curve rescales under the mouse)
  const frozen = useRef(null);
  const [, setTick] = useState(0);
  const [size, setSize] = useState({ w: 400, h: 200 });

  useEffect(() => { setSel([]); setView(null); }, [clip?.id]);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!clip && props.length > 0]);
  // keys of a property that was just hidden are no longer selected (they can't be seen or dragged)
  useEffect(() => { setSel((s) => (s.some((k) => !shown.includes(k.prop)) ? s.filter((k) => shown.includes(k.prop)) : s)); }, [shown.join(',')]);

  // ---------------------------------------------------------------- geometry
  const g = useMemo(() => {
    if (!clip || !shown.length) return null;
    const dur = Math.max(1 / fps, clip.duration);
    const [t0, t1] = view || [-dur * 0.03, dur * 1.03];
    const W = size.w, H = size.h;
    const x = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const tAt = (px) => t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    // per-property y range; several properties are each normalised to their own range
    const ranges = {};
    for (const p of shown) {
      const list = clip.keyframes[p];
      let lo = Infinity, hi = -Infinity;
      const N = 160;
      for (let i = 0; i <= N; i++) {
        const t = (dur * i) / N;
        const v = mode === 'value' ? evalKeyframes(list, t, 0) : speedAt(list, t);
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      for (let i = 0; i < list.length; i++) {
        if (mode === 'value') {
          lo = Math.min(lo, list[i].v); hi = Math.max(hi, list[i].v);
          if (list[i + 1] && list[i].ease !== 'hold') { const P = segmentBezier(list[i], list[i + 1]); lo = Math.min(lo, P[3], P[5]); hi = Math.max(hi, P[3], P[5]); }
        }
      }
      if (mode === 'speed') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-6); lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (hi - lo < 1e-6) { lo = -m; hi = m; } }
      if (hi - lo < 1e-9) { const c = lo; lo = c - (Math.abs(c) || 1) * 0.5; hi = c + (Math.abs(c) || 1) * 0.5; }
      const pad = (hi - lo) * 0.12;
      ranges[p] = [lo - pad, hi + pad];
    }
    if (frozen.current) for (const p of shown) if (frozen.current[p]) ranges[p] = frozen.current[p];
    const single = shown.length === 1;
    const y = (v, p) => { const [lo, hi] = ranges[p]; return PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b); };
    const vAt = (py, p) => { const [lo, hi] = ranges[p]; return lo + (1 - (py - PAD.t) / (H - PAD.t - PAD.b)) * (hi - lo); };
    return { dur, t0, t1, W, H, x, tAt, y, vAt, ranges, single };
  }, [clip, shown.join(','), mode, view, size.w, size.h, fps]);

  // Screen positions of keyframes and handles (for drawing and hit-testing).
  const points = useMemo(() => {
    if (!g) return { keys: [], handles: [] };
    const keys = [], handles = [];
    const selSet = new Set(sel.map((s) => keyId(s.prop, s.t)));
    for (const p of shown) {
      const list = clip.keyframes[p];
      list.forEach((k, i) => {
        const on = selSet.has(keyId(p, k.t));
        if (mode === 'value') {
          keys.push({ prop: p, i, t: k.t, sx: g.x(k.t), sy: g.y(k.v, p), on });
          if (!on) return;
          const prev = list[i - 1], next = list[i + 1];
          if (prev && prev.ease !== 'hold') { const P = segmentBezier(prev, k); handles.push({ prop: p, i, side: 'in', sx: g.x(P[4]), sy: g.y(P[5], p), ax: g.x(k.t), ay: g.y(k.v, p) }); }
          if (next && k.ease !== 'hold') { const P = segmentBezier(k, next); handles.push({ prop: p, i, side: 'out', sx: g.x(P[2]), sy: g.y(P[3], p), ax: g.x(k.t), ay: g.y(k.v, p) }); }
        } else {
          // speed graph: a keyframe sits at its incoming and outgoing speed
          const prev = list[i - 1], next = list[i + 1];
          const sIn = prev && prev.ease !== 'hold' ? speedAt(list, k.t - 1e-5) : 0;
          const sOut = next && k.ease !== 'hold' ? speedAt(list, k.t + 1e-5) : 0;
          keys.push({ prop: p, i, t: k.t, sx: g.x(k.t), sy: g.y(next ? sOut : sIn, p), sy2: g.y(prev ? sIn : sOut, p), on });
          if (!on) return;
          if (prev && prev.ease !== 'hold') { const P = segmentBezier(prev, k); handles.push({ prop: p, i, side: 'in', sx: g.x(P[4]), sy: g.y(sIn, p), ax: g.x(k.t), ay: g.y(sIn, p) }); }
          if (next && k.ease !== 'hold') { const P = segmentBezier(k, next); handles.push({ prop: p, i, side: 'out', sx: g.x(P[2]), sy: g.y(sOut, p), ax: g.x(k.t), ay: g.y(sOut, p) }); }
        }
      });
    }
    return { keys, handles };
  }, [g, clip, sel, mode]);
  geo.current = { g, points };

  // ---------------------------------------------------------------- draw
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, size.w * dpr); cv.height = Math.max(1, size.h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!g) return;
    const css = getComputedStyle(document.documentElement);
    const col = (n, f) => css.getPropertyValue(n).trim() || f;
    const line = col('--line', '#333'), muted = col('--muted', '#888'), text = col('--text', '#eee'), accent = col('--accent', '#7c5cff');
    const { W, H, x, y, t0, t1, dur } = g;
    ctx.font = '10px system-ui, sans-serif';
    // time grid
    const span = t1 - t0;
    const steps = [1 / fps, 2 / fps, 5 / fps, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((s) => ((W - PAD.l - PAD.r) * s) / span > 70) || 60;
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.lineWidth = 1;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const px = Math.round(x(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, H - PAD.b); ctx.stroke();
      ctx.fillText(timecode(clip.start + t, fps).replace(/^00:/, ''), px + 3, 12);
    }
    // clip bounds
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    if (x(0) > PAD.l) ctx.fillRect(PAD.l, PAD.t, x(0) - PAD.l, H - PAD.t - PAD.b);
    if (x(dur) < W - PAD.r) ctx.fillRect(x(dur), PAD.t, W - PAD.r - x(dur), H - PAD.t - PAD.b);
    // value labels (single property) / zero line (speed)
    ctx.fillStyle = muted;
    if (g.single) {
      const p = shown[0];
      for (let i = 0; i <= 4; i++) {
        const py = PAD.t + ((H - PAD.t - PAD.b) * i) / 4;
        ctx.strokeStyle = line; ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(PAD.l, Math.round(py) + 0.5); ctx.lineTo(W - PAD.r, Math.round(py) + 0.5); ctx.stroke();
        ctx.globalAlpha = 1;
        const v = g.vAt(py, p);
        ctx.fillText(mode === 'value' ? fmt(v, p) : `${(v * meta(p).mult).toFixed(Math.abs(v * meta(p).mult) >= 10 ? 0 : 1)}${meta(p).unit}/s`, 3, py + 3);
      }
    } else ctx.fillText(mode === 'value' ? 'normalised' : 'speed', 3, PAD.t + 9);
    if (mode === 'speed') {
      for (const p of shown) {
        const zy = Math.round(y(0, p)) + 0.5;
        ctx.strokeStyle = muted; ctx.globalAlpha = 0.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(PAD.l, zy); ctx.lineTo(W - PAD.r, zy); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        if (g.single) break;
      }
    }
    // curves
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, PAD.t - 6, W - PAD.l - PAD.r, H - PAD.t - PAD.b + 12); ctx.clip();
    for (const p of shown) {
      const list = clip.keyframes[p];
      ctx.strokeStyle = meta(p).color; ctx.lineWidth = 1.6;
      ctx.beginPath();
      const a = Math.max(t0, -1), b = Math.min(t1, dur + 1);
      const n = Math.max(60, Math.round(x(b) - x(a)));
      for (let i = 0; i <= n; i++) {
        const t = a + ((b - a) * i) / n;
        const v = mode === 'value' ? evalKeyframes(list, t, 0) : speedAt(list, t);
        const px = x(t), py = y(v, p);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // handles
    for (const h of points.handles) {
      ctx.strokeStyle = text; ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(h.ax, h.ay); ctx.lineTo(h.sx, h.sy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = hover?.kind === 'handle' && hover.prop === h.prop && hover.i === h.i && hover.side === h.side ? accent : col('--panel', '#222');
      ctx.strokeStyle = meta(h.prop).color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(h.sx, h.sy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // keyframes
    for (const k of points.keys) {
      const c = meta(k.prop).color;
      if (mode === 'speed' && Math.abs(k.sy - k.sy2) > 1) {
        ctx.strokeStyle = c; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(k.sx, k.sy); ctx.lineTo(k.sx, k.sy2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      const s = k.on ? 5 : 4;
      ctx.fillStyle = k.on ? '#fff' : c;
      ctx.strokeStyle = k.on ? accent : 'rgba(0,0,0,0.6)'; ctx.lineWidth = k.on ? 2 : 1;
      ctx.fillRect(k.sx - s, k.sy - s, s * 2, s * 2); ctx.strokeRect(k.sx - s, k.sy - s, s * 2, s * 2);
    }
    ctx.restore();
    // playhead
    const lt = now - clip.start;
    if (lt >= t0 && lt <= t1) {
      const px = Math.round(x(lt)) + 0.5;
      ctx.strokeStyle = col('--playhead', '#ff4fd8'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
    if (marquee) {
      ctx.fillStyle = col('--accent-soft', 'rgba(124,92,255,0.12)'); ctx.strokeStyle = accent;
      const rx = Math.min(marquee.x0, marquee.x1), ry = Math.min(marquee.y0, marquee.y1);
      ctx.fillRect(rx, ry, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0));
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0));
    }
  }, [g, points, now, marquee, hover, size.w, size.h]);

  // ---------------------------------------------------------------- interaction
  const hitTest = (mx, my) => {
    const { points: pts } = geo.current;
    for (const h of pts.handles) if (Math.hypot(h.sx - mx, h.sy - my) <= HIT) return { kind: 'handle', ...h };
    for (const k of [...pts.keys].reverse()) if (Math.abs(k.sx - mx) <= HIT && (Math.abs(k.sy - my) <= HIT || (k.sy2 != null && my >= Math.min(k.sy, k.sy2) - HIT && my <= Math.max(k.sy, k.sy2) + HIT))) return { kind: 'key', ...k };
    return null;
  };
  const local = (e) => { const r = canvasRef.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  const drag = (onMove, onUp) => {
    const move = (ev) => onMove(ev);
    const up = (ev) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onUp?.(ev); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDown = (e) => {
    if (!g || e.button !== 0) return;
    e.preventDefault();
    const [mx, my] = local(e);
    if (my < PAD.t - 4) { seekTo(mx); drag((ev) => seekTo(local(ev)[0])); return; }
    const hit = hitTest(mx, my);
    if (!hit) {
      // empty space: click seeks, drag draws a selection box
      if (!e.shiftKey) setSel([]);
      const start = { x0: mx, y0: my, x1: mx, y1: my };
      let moved = false;
      drag((ev) => {
        const [x1, y1] = local(ev);
        if (!moved && Math.hypot(x1 - mx, y1 - my) < 4) return;
        moved = true;
        setMarquee({ ...start, x1, y1 });
      }, (ev) => {
        setMarquee(null);
        if (!moved) { seekTo(mx); return; }
        const [x1, y1] = local(ev);
        const lx = Math.min(mx, x1), hx = Math.max(mx, x1), ly = Math.min(my, y1), hy = Math.max(my, y1);
        const inside = geo.current.points.keys.filter((k) => k.sx >= lx && k.sx <= hx && k.sy >= ly && k.sy <= hy).map((k) => ({ prop: k.prop, t: k.t }));
        setSel((cur) => (e.shiftKey ? [...cur, ...inside.filter((n) => !cur.some((c) => c.prop === n.prop && Math.abs(c.t - n.t) < 1e-6))] : inside));
      });
      return;
    }
    if (hit.kind === 'handle') { dragHandle(hit, e); return; }
    // keyframe: select (Shift toggles), then drag to move
    const isOn = sel.some((s) => s.prop === hit.prop && Math.abs(s.t - hit.t) < 1e-6);
    let cur = sel;
    if (e.shiftKey) cur = isOn ? sel.filter((s) => !(s.prop === hit.prop && Math.abs(s.t - hit.t) < 1e-6)) : [...sel, { prop: hit.prop, t: hit.t }];
    else if (!isOn) cur = [{ prop: hit.prop, t: hit.t }];
    setSel(cur);
    if (!cur.some((s) => s.prop === hit.prop && Math.abs(s.t - hit.t) < 1e-6)) return;
    dragKeys(cur, hit, e);
  };

  const seekTo = (mx) => { const { g: gg } = geo.current; if (gg) tab.engine.seek(clip.start + clamp(gg.tAt(mx), 0, clip.duration)); };

  // Move selected keyframes: time (both graphs) and value (value graph). Shift locks to one axis.
  const dragKeys = (keys, hit, e) => {
    const { g: gg } = geo.current;
    const [mx0, my0] = local(e);
    const v0 = Object.fromEntries(keys.map((k) => [keyId(k.prop, k.t), clip.keyframes[k.prop]?.find((x) => Math.abs(x.t - k.t) < 1e-6)?.v]));
    const lo = Math.min(...keys.map((k) => k.t)), hi = Math.max(...keys.map((k) => k.t));
    let moved = false, last = { dt: 0, dv: 0 };
    drag((ev) => {
      const [mx, my] = local(ev);
      if (!moved && Math.hypot(mx - mx0, my - my0) < 3) return;
      if (!moved) { moved = true; frozen.current = gg.ranges; tab.begin(); }
      let dx = mx - mx0, dy = my - my0;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      let dt = snapTime((dx / (gg.W - PAD.l - PAD.r)) * (gg.t1 - gg.t0), fps);
      dt = clamp(dt, -lo, clip.duration - hi);
      // value delta in the grabbed property's units, scaled to each other property's range
      const [hlo, hhi] = gg.ranges[hit.prop];
      const dNorm = mode === 'value' ? -dy / (gg.H - PAD.t - PAD.b) : 0;
      last = { dt, dNorm };
      tab.preview((d, ds) => {
        const c = ds.clips.find((x) => x.id === clip.id);
        if (!c) return;
        const byProp = {};
        for (const k of keys) (byProp[k.prop] || (byProp[k.prop] = [])).push(k);
        for (const [p, ks] of Object.entries(byProp)) {
          const list = c.keyframes[p];
          if (!list) continue;
          const [plo, phi] = gg.ranges[p];
          const scale = gg.single ? hhi - hlo : phi - plo;
          const moving = list.filter((k) => ks.some((s) => Math.abs(k.t - s.t) < 1e-6));
          for (const k of moving) {
            const base = v0[keyId(p, k.t)];
            k.t = clamp(k.t + dt, 0, c.duration);
            if (dNorm) k.v = base + dNorm * scale;
          }
          c.keyframes[p] = list.filter((k) => moving.includes(k) || !moving.some((m) => Math.abs(m.t - k.t) < 0.5 / fps)).sort((a, b) => a.t - b.t);
        }
      });
    }, () => {
      frozen.current = null;
      if (!moved) return;
      tab.end(keys.length > 1 ? 'Move keyframes' : 'Move keyframe');
      setSel(keys.map((k) => ({ prop: k.prop, t: clamp(k.t + last.dt, 0, clip.duration) })));
    });
  };

  // Drag a bezier handle. Value graph: the handle point itself. Speed graph: up/down = speed,
  // left/right = influence.
  const dragHandle = (h, e) => {
    const { g: gg } = geo.current;
    const list0 = clip.keyframes[h.prop];
    const segI = h.side === 'out' ? h.i : h.i - 1;
    const a0 = list0[segI], b0 = list0[segI + 1];
    if (!a0 || !b0) return;
    const segDt = b0.t - a0.t;
    void e;
    frozen.current = gg.ranges;
    tab.begin();
    drag((ev) => {
      const [mx, my] = local(ev);
      const t = gg.tAt(mx), v = gg.vAt(my, h.prop);
      tab.preview((d, ds) => {
        const c = ds.clips.find((x) => x.id === clip.id);
        const list = c?.keyframes?.[h.prop];
        if (!list) return;
        bakeSegment(list, segI);
        const a = list[segI], b = list[segI + 1];
        if (h.side === 'out') {
          const infl = clamp((t - a.t) / segDt, 0.01, 1);
          const speed = mode === 'value' ? (v - a.v) / Math.max(1e-6, infl * segDt) : v;
          a.out = { speed, influence: infl };
        } else {
          const infl = clamp((b.t - t) / segDt, 0.01, 1);
          const speed = mode === 'value' ? (b.v - v) / Math.max(1e-6, infl * segDt) : v;
          b.in = { speed, influence: infl };
        }
        // Alt keeps the keyframe's two sides in step (same speed), like a continuous bezier
        if (ev.altKey) {
          const k = h.side === 'out' ? a : b;
          const other = h.side === 'out' ? list[segI - 1] : list[segI + 2];
          if (other) {
            if (h.side === 'out') { bakeSegment(list, segI - 1); k.in = { ...(k.in || { influence: 1 / 3 }), speed: k.out.speed }; }
            else { bakeSegment(list, segI + 1); k.out = { ...(k.out || { influence: 1 / 3 }), speed: k.in.speed }; }
          }
        }
      });
    }, () => { frozen.current = null; tab.end('Adjust keyframe ease'); setTick((n) => n + 1); });
  };

  const onMove = (e) => {
    if (!g || e.buttons) return;
    const [mx, my] = local(e);
    const h = hitTest(mx, my);
    setHover(h);
    canvasRef.current.style.cursor = h ? (h.kind === 'handle' ? 'grab' : 'move') : my < PAD.t - 4 ? 'col-resize' : 'default';
  };

  const onWheel = (e) => {
    if (!g) return;
    e.preventDefault();
    const [mx] = local(e);
    const { t0, t1 } = g;
    if (e.shiftKey) { const d = ((e.deltaY || e.deltaX) / 600) * (t1 - t0); setView([t0 + d, t1 + d]); return; }
    const f = Math.exp(e.deltaY * 0.0015);
    const at = g.tAt(mx);
    const span = clamp((t1 - t0) * f, 4 / fps, Math.max(1, g.dur * 4));
    const r = (at - t0) / (t1 - t0);
    setView([at - span * r, at - span * r + span]);
  };

  // ---------------------------------------------------------------- commands
  const applyAll = (label, fn) => {
    if (!sel.length) return;
    tab.apply(label, (d, ds) => {
      const c = ds.clips.find((x) => x.id === clip.id);
      if (!c) return false;
      fn(c);
      return undefined;
    });
  };
  const ease = (kind) => applyAll({ easy: 'Easy ease', easyIn: 'Easy ease in', easyOut: 'Easy ease out', linear: 'Linear keyframes', hold: 'Hold keyframes' }[kind], (c) => setKeyframeInterp(c, sel, kind, fps));
  const remove = () => { applyAll(sel.length > 1 ? 'Delete keyframes' : 'Delete keyframe', (c) => deleteKeyframes(c, sel, fps)); setSel([]); };
  const selectAll = () => setSel(shown.flatMap((p) => clip.keyframes[p].map((k) => ({ prop: p, t: k.t }))));

  const onKey = (e) => {
    const cmd = commandOf(e, 'graph');
    const eases = { 'graph.ease': 'easy', 'graph.easeIn': 'easyIn', 'graph.easeOut': 'easyOut' };
    if (cmd === 'graph.delete') { e.preventDefault(); e.stopPropagation(); if (sel.length) remove(); } // never falls through to "delete the clip"
    else if (eases[cmd] && sel.length) { e.preventDefault(); e.stopPropagation(); ease(eases[cmd]); }
    else if (cmd === 'graph.selectAll') { e.preventDefault(); e.stopPropagation(); selectAll(); }
    else if (cmd === 'graph.close') { e.stopPropagation(); if (sel.length) setSel([]); else tab.ui.set({ graph: false }); }
    else if (cmd === 'graph.fit') { e.stopPropagation(); setView(null); }
  };

  const toggleProp = (p) => {
    const cur = shownPref ? shownPref.filter((x) => props.includes(x)) : [...props];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    tab.ui.set({ graphProps: next.length === props.length ? null : next });
  };
  const solo = (p) => tab.ui.set({ graphProps: shownPref?.length === 1 && shownPref[0] === p ? null : [p] });

  // ---------------------------------------------------------------- window move / resize
  const moveWin = (e) => {
    if (e.target.closest('button, select, input')) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, b0 = box;
    const host = e.currentTarget.closest('.graph-win').parentElement.getBoundingClientRect();
    drag((ev) => tab.ui.set({ graphBox: { ...b0, x: clamp(b0.x + ev.clientX - x0, 0, host.width - 120), y: clamp(b0.y + ev.clientY - y0, 0, host.height - 40) } }));
  };
  const resizeWin = (e) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, b0 = box;
    drag((ev) => tab.ui.set({ graphBox: { ...b0, w: Math.max(420, b0.w + ev.clientX - x0), h: Math.max(220, b0.h + ev.clientY - y0) } }));
  };

  const lt = clip ? clamp(now - clip.start, 0, clip.duration) : 0;
  return html`<div class="graph-win" style=${{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}
      tabIndex="0" onKeyDown=${onKey} onPointerDown=${(e) => e.currentTarget.focus({ preventScroll: true })}>
    <div class="graph-head" onPointerDown=${moveWin}>
      <${Icon} name="graph" size=${14} /><span class="graph-title">Graph editor${clip ? html`<span class="muted"> · ${clip.name || clip.text || clip.type}</span>` : null}</span>
      <${Segmented} class="seg-xs" value=${mode} onChange=${(v) => tab.ui.set({ graphMode: v })}
        options=${[{ value: 'value', label: 'Value', title: 'Value graph — the property over time' }, { value: 'speed', label: 'Speed', title: 'Speed graph — how fast it changes' }]} />
      <div class="graph-tools">
        <button disabled=${!sel.length} title="Easy ease (F9)" onClick=${() => ease('easy')}>Easy ease</button>
        <button disabled=${!sel.length} title="Easy ease in (Shift+F9)" onClick=${() => ease('easyIn')}>In</button>
        <button disabled=${!sel.length} title="Easy ease out (Alt+F9)" onClick=${() => ease('easyOut')}>Out</button>
        <button disabled=${!sel.length} title="Linear" onClick=${() => ease('linear')}>Linear</button>
        <button disabled=${!sel.length} title="Hold — jump to the next value" onClick=${() => ease('hold')}>Hold</button>
      </div>
      <${IconButton} icon="expand" size=${13} title="Fit (F)" onClick=${() => setView(null)} />
      <${IconButton} icon="trash" size=${13} title="Delete selected keyframes (Del)" disabled=${!sel.length} onClick=${remove} />
      <${IconButton} icon="x" size=${14} title="Close (Esc)" onClick=${() => tab.ui.set({ graph: false })} />
    </div>
    ${!clip ? html`<div class="graph-empty">Select a clip with keyframes. Turn on the stopwatch of a property in the Inspector to animate it.</div>`
      : !props.length ? html`<div class="graph-empty">This clip has no keyframes yet. Click the stopwatch next to a property in the Inspector to start animating it.</div>`
      : html`<div class="graph-body">
        <div class="graph-props">
          <label class="graph-prop is-all"><input type="checkbox" checked=${shown.length === props.length} onChange=${() => tab.ui.set({ graphProps: !shownPref ? [] : null })} /><span>All properties</span></label>
          ${props.map((p) => html`<label class="graph-prop" key=${p} title="Click the name to show only this property" >
            <input type="checkbox" checked=${shown.includes(p)} onChange=${() => toggleProp(p)} />
            <i style=${{ background: meta(p).color }}></i>
            <span class="graph-prop-name" onClick=${(e) => { e.preventDefault(); solo(p); }}>${meta(p).label}</span>
            <span class="graph-prop-val">${fmt(evalKeyframes(clip.keyframes[p], lt, 0), p)}</span>
          </label>`)}
          <div class="graph-hint">${sel.length ? `${sel.length} selected · F9 easy ease · Del` : 'Click or box-select keyframes · drag to move · drag handles to ease · Alt-drag links both sides'}</div>
        </div>
        <div class="graph-canvas" ref=${wrapRef}>
          ${shown.length ? html`<canvas ref=${canvasRef} onPointerDown=${onDown} onPointerMove=${onMove} onPointerLeave=${() => setHover(null)} onWheel=${onWheel}
            onDblClick=${() => setView(null)}></canvas>` : html`<div class="graph-empty">Tick a property on the left to see its curve.</div>`}
        </div>
      </div>`}
    <div class="graph-resize" onPointerDown=${resizeWin}></div>
  </div>`;
}
