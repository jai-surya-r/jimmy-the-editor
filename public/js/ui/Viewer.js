// Program monitor: live composite + direct manipulation of layers (move / scale / rotate).
import { html, Icon, IconButton, Select } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { composeFrame, layerGeometry, clearTextCache } from '../core/compositor.js';
import { app } from '../core/app.js';
import { ExactFrame } from './exactframe.js';
import { onLutLoaded } from '../core/lut.js';
import { onFontsChanged, useProjectFontsIn } from '../core/fonts.js';
import { timecode, sequenceDuration, isVisualClip, clamp, snapTime } from '../core/model.js';
import { useMonitorZoom, useZoomWheel, useFollow, MonitorRuler, ZoomBar } from './monitorbar.js';
import { setPropAt, linkedIds } from '../core/ops.js';
import { GuidesOverlay, GuideButtons } from './Guides.js';
import { LiveMotionLayers } from './motion.js';
import { shortcutLabel } from './keymap.js';

const QUALITY = { auto: 1, full: 1, half: 0.5, quarter: 0.25 };

// readOnly (Review): no layer handles or guides, no header or transport; children sit over the frame.
export function Viewer({ tab, readOnly = false, children = null }) {
  const doc = useStore(tab.store, (s) => s.doc);
  const seqId = useStore(tab.ui, (s) => s.sequenceId);
  const zoomMode = useStore(tab.ui, (s) => s.viewerZoom);
  const quality = useStore(tab.ui, (s) => s.quality);
  const safe = useStore(tab.ui, (s) => s.safeArea);
  const rulers = useStore(tab.ui, (s) => s.rulers);
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const exactRef = useRef(null);
  const overlayRef = useRef(null);
  const [box, setBox] = useState({ w: 800, h: 450 });
  const [pending, setPending] = useState(null);
  const live = useRef({});
  const [view, setView] = useState(null); // { z, x, y }: frame offset from centred, in css px
  useEffect(() => setView(null), [zoomMode, seqId]);

  // Mouse wheel zooms around the cursor; middle-button drag pans.
  useEffect(() => {
    const st = wrapRef.current;
    if (!st || readOnly) return undefined;
    const frameRect = () => st.querySelector('.viewer-canvas-wrap')?.getBoundingClientRect();
    const current = () => {
      const L = live.current, r = st.getBoundingClientRect(), wr = frameRect();
      if (L.view) return L.view;
      return { z: L.z, x: wr ? wr.left - r.left - (r.width - L.cssW) / 2 : 0, y: wr ? wr.top - r.top - (r.height - L.cssH) / 2 : 0 };
    };
    const onWheel = (e) => {
      const L = live.current, wr = frameRect();
      if (!wr) return;
      e.preventDefault();
      const r = st.getBoundingClientRect();
      const nz = clamp(L.z * Math.exp(-e.deltaY * 0.0015), Math.min(L.fit, 0.05), L.zMax);
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const u = (px - (wr.left - r.left)) / L.z, v = (py - (wr.top - r.top)) / L.z;
      setView({ z: nz, x: px - u * nz - (r.width - L.sw * nz) / 2, y: py - v * nz - (r.height - L.sh * nz) / 2 });
    };
    const onDown = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const base = current();
      const x0 = e.clientX, y0 = e.clientY;
      st.classList.add('is-panning');
      const move = (ev) => setView({ ...base, x: base.x + ev.clientX - x0, y: base.y + ev.clientY - y0 });
      const up = () => { st.classList.remove('is-panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    const noAutoscroll = (e) => { if (e.button === 1) e.preventDefault(); };
    st.addEventListener('wheel', onWheel, { passive: false });
    st.addEventListener('pointerdown', onDown, true);
    st.addEventListener('mousedown', noAutoscroll, true);
    return () => { st.removeEventListener('wheel', onWheel); st.removeEventListener('pointerdown', onDown, true); st.removeEventListener('mousedown', noAutoscroll, true); };
  }, [seqId, !!doc]);
  const seq = doc ? tab.seq : null;

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // --- layout
  const sw = seq?.width || 1920, sh = seq?.height || 1080;
  const pad = rulers ? 60 : 28; // leave room for the rulers
  const fit = Math.max(0.02, Math.min((box.w - pad) / sw, (box.h - pad) / sh));
  const dpr = window.devicePixelRatio || 1;
  // Free zoom/pan from the mouse wheel and middle-button drag; picking Fit/100% in the menu resets it.
  const zMax = Math.max(fit, Math.min(8, 8192 / (sw * dpr), 8192 / (sh * dpr)));
  const z = view ? view.z : zoomMode === 'fit' ? fit : Number(zoomMode);
  const cssW = Math.max(1, Math.round(sw * z)), cssH = Math.max(1, Math.round(sh * z));
  const cap = QUALITY[quality] || 1;
  const pxW = Math.max(1, Math.round(Math.min(cssW * dpr, sw * cap)));
  const pxH = Math.max(1, Math.round(pxW * (sh / sw)));
  live.current = { ...live.current, readOnly, z, cssW, cssH, pxW, pxH, dpr, safe, zMax, fit, sw, sh, view };
  useEffect(() => tab.engine.wake(), [pxW, pxH, z, safe, readOnly]); // a new size or zoom: draw again

  // --- render loop
  useEffect(() => {
    let raf = 0;
    let lastDoc = null, lastSel = null, lastLayout = '', lastPending = '';
    const exact = new ExactFrame(tab, () => exactRef.current, () => live.current);
    const offFonts = onFontsChanged(() => { clearTextCache(); tab.engine.invalidate(); });
    const offLut = onLutLoaded(() => tab.engine.invalidate());
    // A hidden page stops drawing frames, and with them the per-frame sync that cuts between clips: the
    // source files would simply play on. Pause instead.
    const onHide = () => { if (document.hidden) tab.engine.pause(); };
    document.addEventListener('visibilitychange', onHide);
    const off = () => { offFonts(); offLut(); document.removeEventListener('visibilitychange', onHide); };
    useProjectFontsIn(tab.projectId);
    // While nothing plays or changes, the loop sleeps (a few checks a second for the exact frame and pending
    // layers) instead of running on every refresh of the screen: woken at once by the playhead, the project, the
    // selection or a redraw asked for. Running 60–144 times a second for nothing kept the page busy.
    let timer = 0;
    const wake = () => { if (timer) { clearTimeout(timer); timer = 0; } if (!raf) raf = requestAnimationFrame(loop); };
    const offWake = [tab.engine.onWake(wake), tab.time.subscribe(wake), tab.ui.subscribe(wake), tab.store.subscribe(wake)];
    const loop = (now) => {
      raf = 0;
      step(now);
      const eng = tab.engine;
      if (raf) return; // woken while it ran (the playhead moved): that frame is asked for already
      if (eng.playing || now < eng.drawUntil) raf = requestAnimationFrame(loop);
      else if (!timer) timer = setTimeout(() => { timer = 0; if (!raf) raf = requestAnimationFrame(loop); }, 100);
    };
    const step = (now) => {
      const eng = tab.engine;
      eng.tick(now);
      exact.tick(now);
      const L = live.current;
      const layoutKey = `${L.pxW}x${L.pxH}:${L.z}:${L.safe}`;
      const sel = tab.ui.get().selection;
      if (tab.doc !== lastDoc || sel !== lastSel || layoutKey !== lastLayout || live.current.dirtyOverlay) {
        lastDoc = tab.doc; lastSel = sel; lastLayout = layoutKey; live.current.dirtyOverlay = false;
        eng.invalidate(120);
      }
      if (!eng.needsDraw(now)) return;
      draw();
      eng.drawn();
      const p = eng.pendingLayers();
      const pk = p.map((x) => Math.round(x.progress * 100)).join(',');
      if (pk !== lastPending) { lastPending = pk; setPending(p.length ? p : null); }
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); offWake.forEach((f) => f()); off(); tab.engine.suspend(); };
  }, [tab]);

  function draw() {
    const canvas = canvasRef.current;
    const s = tab.playSeq;
    if (!canvas || !s) return;
    const k = canvas.width / s.width;
    const env = { seq: s, mediaById: tab.mediaById, t: tab.engine.t, scale: k, frame: tab.engine.frame, getSource: (l) => tab.engine.getSource(l), projectId: tab.projectId, liveMotion: true };
    composeFrame(canvas.getContext('2d'), env);
    drawOverlay();
  }

  function selectedLayers() {
    const sel = tab.ui.get().selection;
    const locked = new Set((tab.seq?.tracks || []).filter((t) => t.locked).map((t) => t.id));
    const out = [];
    for (const tr of tab.engine.frame) for (const l of tr.layers) if (sel.includes(l.clip.id) && isVisualClip(l.clip) && !locked.has(l.clip.track)) out.push(l);
    return out;
  }

  function drawOverlay() {
    const cv = overlayRef.current;
    const s = tab.seq;
    if (!cv || !s) return;
    const L = live.current;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    const z = L.z;
    if (L.safe) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      for (const f of [0.9, 0.8]) {
        const w = s.width * z * f, h = s.height * z * f;
        ctx.strokeRect((s.width * z - w) / 2 + 0.5, (s.height * z - h) / 2 + 0.5, w, h);
      }
      ctx.beginPath();
      ctx.moveTo(s.width * z / 2 - 10, s.height * z / 2); ctx.lineTo(s.width * z / 2 + 10, s.height * z / 2);
      ctx.moveTo(s.width * z / 2, s.height * z / 2 - 10); ctx.lineTo(s.width * z / 2, s.height * z / 2 + 10);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (L.readOnly) return;
    const hover = live.current.hover;
    if (hover && !tab.ui.get().selection.includes(hover.clip.id)) {
      const g = layerGeometry(hover, tab.mediaById, s);
      ctx.strokeStyle = 'rgba(160,140,255,0.55)';
      ctx.lineWidth = 1;
      poly(ctx, g.corners.map(([x, y]) => [x * z, y * z]));
      ctx.stroke();
    }
    const layers = selectedLayers();
    for (const l of layers) {
      const g = layerGeometry(l, tab.mediaById, s);
      const pts = g.corners.map(([x, y]) => [x * z, y * z]);
      ctx.strokeStyle = '#8b7bff';
      ctx.lineWidth = 1.5;
      poly(ctx, pts);
      ctx.stroke();
      if (layers.length === 1) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#6d5cf5';
        for (const [x, y] of pts) { ctx.beginPath(); ctx.rect(x - 4.5, y - 4.5, 9, 9); ctx.fill(); ctx.stroke(); }
        const [rx, ry] = rotHandle(g, z);
        const tx = (pts[0][0] + pts[1][0]) / 2, ty = (pts[0][1] + pts[1][1]) / 2;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(rx, ry); ctx.stroke();
        ctx.beginPath(); ctx.arc(rx, ry, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(g.cx * z, g.cy * z, 3, 0, Math.PI * 2); ctx.fillStyle = '#8b7bff'; ctx.fill();
      }
    }
    const guides = live.current.guides;
    if (guides) {
      ctx.strokeStyle = '#ff4fd8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of guides.x || []) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, s.height * z); }
      for (const y of guides.y || []) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(s.width * z, y * z + 0.5); }
      ctx.stroke();
    }
  }

  // --- interaction
  const toSeq = (e) => {
    const r = overlayRef.current.getBoundingClientRect();
    return [(e.clientX - r.left) / live.current.z, (e.clientY - r.top) / live.current.z];
  };
  const hitTest = (p) => {
    const s = tab.seq;
    const frame = tab.engine.frame;
    for (let i = frame.length - 1; i >= 0; i--) {
      const tr = frame[i];
      // a nested sequence's contents aren't clips of this sequence: the nested clip itself is what gets picked
      if (tr.track.nest || s.tracks.find((t) => t.id === tr.track.id)?.locked) continue;
      for (let j = tr.layers.length - 1; j >= 0; j--) {
        const l = tr.layers[j];
        if (layerGeometry(l, tab.mediaById, s).contains(p[0], p[1])) return l;
      }
    }
    return null;
  };

  const onPointerMove = (e) => {
    if (live.current.dragging || !tab.seq) return;
    const p = toSeq(e);
    const layers = selectedLayers();
    let cursor = 'default';
    if (layers.length === 1) {
      const g = layerGeometry(layers[0], tab.mediaById, tab.seq);
      const z = live.current.z;
      const [rx, ry] = rotHandle(g, z);
      if (Math.hypot(p[0] * z - rx, p[1] * z - ry) < 9) cursor = 'grab';
      else if (g.corners.some(([x, y]) => Math.hypot((x - p[0]) * z, (y - p[1]) * z) < 9)) cursor = 'nwse-resize';
      else if (g.contains(p[0], p[1])) cursor = 'move';
    }
    const hit = hitTest(p);
    if (cursor === 'default' && hit) cursor = 'pointer';
    overlayRef.current.style.cursor = cursor;
    if (live.current.hover?.clip.id !== hit?.clip.id) { live.current.hover = hit; tab.engine.invalidate(60); }
  };

  const onPointerLeave = () => { if (live.current.hover) { live.current.hover = null; tab.engine.invalidate(60); } };

  const onPointerDown = (e) => {
    if (e.button !== 0 || !tab.seq) return;
    tab.engine.pause();
    const s = tab.seq;
    const p0 = toSeq(e);
    const z = live.current.z;
    const fps = s.fps;
    let layers = selectedLayers();
    let mode = null;
    if (layers.length === 1) {
      const g = layerGeometry(layers[0], tab.mediaById, s);
      const [rx, ry] = rotHandle(g, z);
      if (Math.hypot(p0[0] * z - rx, p0[1] * z - ry) < 9) mode = 'rotate';
      else if (g.corners.some(([x, y]) => Math.hypot((x - p0[0]) * z, (y - p0[1]) * z) < 9)) mode = 'scale';
      else if (g.contains(p0[0], p0[1])) mode = 'move';
    }
    if (!mode && layers.some((l) => layerGeometry(l, tab.mediaById, s).contains(p0[0], p0[1])) && !e.shiftKey) mode = 'move';
    if (!mode) {
      const hit = hitTest(p0);
      if (!hit) { tab.ui.set({ selection: [] }); return; }
      tab.select(tab.ui.get().linked ? [...linkedIds(s, [hit.clip.id])] : [hit.clip.id], { add: e.shiftKey }); // with its linked audio, like a click in the timeline
      layers = e.shiftKey ? [...layers, hit] : [hit];
      mode = 'move';
    }
    const el = overlayRef.current;
    el.setPointerCapture(e.pointerId);
    live.current.dragging = true;
    const start = layers.map((l) => ({ id: l.clip.id, localT: l.localT, g: layerGeometry(l, tab.mediaById, s), tr: layerGeometry(l, tab.mediaById, s).transform }));
    const primary = start[0];
    let moved = false;
    const move = (ev) => {
      const p = toSeq(ev);
      if (!moved && Math.hypot((p[0] - p0[0]) * z, (p[1] - p0[1]) * z) < 2) return;
      if (!moved) { moved = true; tab.begin(); }
      const guides = { x: [], y: [] };
      if (mode === 'move') {
        let dx = p[0] - p0[0], dy = p[1] - p0[1];
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (!ev.ctrlKey) {
          // snap the primary layer's centre and edges to the frame centre and edges
          const tol = 7 / z;
          const xs = primary.g.corners.map((c) => c[0]), ys = primary.g.corners.map((c) => c[1]);
          const cands = [
            { v: primary.g.cx, targets: [s.width / 2] }, { v: Math.min(...xs), targets: [0] }, { v: Math.max(...xs), targets: [s.width] },
          ];
          for (const c of cands) for (const t of c.targets) if (Math.abs(c.v + dx - t) < tol) { dx = t - c.v; guides.x.push(t); }
          const candsY = [
            { v: primary.g.cy, targets: [s.height / 2] }, { v: Math.min(...ys), targets: [0] }, { v: Math.max(...ys), targets: [s.height] },
          ];
          for (const c of candsY) for (const t of c.targets) if (Math.abs(c.v + dy - t) < tol) { dy = t - c.v; guides.y.push(t); }
        }
        tab.preview((d, ds) => {
          for (const st of start) {
            const c = ds.clips.find((x) => x.id === st.id);
            if (!c) continue;
            setPropAt(c, 'x', Math.round((st.tr.x + dx) * 100) / 100, st.localT, fps);
            setPropAt(c, 'y', Math.round((st.tr.y + dy) * 100) / 100, st.localT, fps);
          }
        });
      } else if (mode === 'scale') {
        const g = primary.g;
        const d0 = Math.hypot(p0[0] - g.cx, p0[1] - g.cy) || 1;
        const d1 = Math.hypot(p[0] - g.cx, p[1] - g.cy);
        let sc = Math.max(0.01, (primary.tr.scale * d1) / d0);
        sc = Math.round(sc * 1000) / 1000;
        tab.preview((d, ds) => {
          const c = ds.clips.find((x) => x.id === primary.id);
          if (c) setPropAt(c, 'scale', sc, primary.localT, fps);
        });
      } else if (mode === 'rotate') {
        const g = primary.g;
        const a0 = Math.atan2(p0[1] - g.cy, p0[0] - g.cx), a1 = Math.atan2(p[1] - g.cy, p[0] - g.cx);
        const turn = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)); // the short way round (−180°…180°)
        let r = primary.tr.rotation + (turn * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        else if (Math.abs(r - Math.round(r / 90) * 90) < 2) r = Math.round(r / 90) * 90;
        r = Math.round(r * 10) / 10;
        tab.preview((d, ds) => {
          const c = ds.clips.find((x) => x.id === primary.id);
          if (c) setPropAt(c, 'rotation', r, primary.localT, fps);
        });
      }
      live.current.guides = guides.x.length || guides.y.length ? guides : null;
      live.current.dirtyOverlay = true;
      tab.engine.wake();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      live.current.dragging = false;
      live.current.guides = null;
      live.current.dirtyOverlay = true;
      tab.engine.wake();
      if (moved) tab.end(mode === 'move' ? 'Move layer' : mode === 'scale' ? 'Scale layer' : 'Rotate layer');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onDblClick = (e) => {
    const hit = tab.seq && hitTest(toSeq(e));
    if (hit?.clip.type === 'text') {
      tab.select([hit.clip.id]);
      setTimeout(() => window.dispatchEvent(new CustomEvent('ce:edit-text')), 30);
    }
  };

  if (!seq) {
    return html`<section class="panel viewer"><div class="viewer-stage" ref=${wrapRef}><div class="viewer-empty">No sequence — create one from the project bin.</div></div></section>`;
  }

  return html`<section class="panel viewer ${readOnly ? 'is-readonly' : ''}">
    ${readOnly ? null : html`<header class="panel-head">
      <span class="panel-title">Program</span>
      <span class="viewer-meta">${seq.name} · ${seq.width}×${seq.height} · ${seq.fps} fps</span>
      <div class="spacer"></div>
      <${GuideButtons} tab=${tab} />
      <${IconButton} icon="safe" title="Safe margins" active=${safe} onClick=${() => tab.ui.set({ safeArea: !safe })} />
      <${Select} class="select-sm" value=${zoomMode} title="Zoom" onChange=${(v) => tab.ui.set({ viewerZoom: v })}
        options=${[{ value: 'fit', label: 'Fit' }, { value: '0.25', label: '25%' }, { value: '0.5', label: '50%' }, { value: '1', label: '100%' }]} />
      <${Select} class="select-sm" value=${quality} title="Preview resolution" onChange=${(v) => tab.ui.set({ quality: v })}
        options=${[{ value: 'auto', label: 'Auto' }, { value: 'half', label: '1/2' }, { value: 'quarter', label: '1/4' }]} />
    </header>`}
    <div class="viewer-stage ${view ? 'is-zoomed' : zoomMode !== 'fit' ? 'is-scroll' : ''}" ref=${wrapRef} onDblClick=${(e) => { if (e.target === wrapRef.current) setView(null); }}>
      ${view ? html`<button class="viewer-zoom-badge" title="Back to Fit (or double-click the background)" onClick=${() => setView(null)}>${Math.round(z * 100)}% · Fit</button>` : null}
      <div class="viewer-canvas-wrap" style=${view
        ? { width: `${cssW}px`, height: `${cssH}px`, left: `${Math.round((box.w - cssW) / 2 + view.x)}px`, top: `${Math.round((box.h - cssH) / 2 + view.y)}px` }
        : { width: `${cssW}px`, height: `${cssH}px` }}>
        <canvas ref=${canvasRef} class="viewer-canvas" width=${pxW} height=${pxH} style=${{ width: `${cssW}px`, height: `${cssH}px` }}></canvas>
        <img ref=${exactRef} class="viewer-exact" alt="" />
        <canvas ref=${overlayRef} class="viewer-overlay" width=${Math.round(cssW * dpr)} height=${Math.round(cssH * dpr)}
          style=${{ width: `${cssW}px`, height: `${cssH}px` }}
          onPointerDown=${readOnly ? null : onPointerDown} onPointerMove=${readOnly ? null : onPointerMove} onPointerLeave=${readOnly ? null : onPointerLeave} onDblClick=${readOnly ? null : onDblClick}></canvas>
        <${LiveMotionLayers} tab=${tab} z=${z} />
        ${readOnly ? null : html`<${GuidesOverlay} tab=${tab} seqId=${seq.id} width=${cssW} height=${cssH} sw=${sw} sh=${sh} />`}
        ${children}
        ${pending ? html`<div class="viewer-badge"><span class="spinner"></span>Preparing preview… ${Math.round((pending[0].progress || 0) * 100)}%</div>` : null}
      </div>
    </div>
    ${readOnly ? null : html`<${ProgramBar} tab=${tab} seq=${seq} />`}
    ${readOnly ? null : html`<${Transport} tab=${tab} seq=${seq} />`}
  </section>`;
}

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// Rotation handle: 26px above the middle of the top edge, following the layer's rotation.
function rotHandle(g, z) {
  const [a, b] = [g.corners[0], g.corners[1]];
  const mx = ((a[0] + b[0]) / 2) * z, my = ((a[1] + b[1]) / 2) * z;
  const rad = (g.rotation * Math.PI) / 180;
  const flip = g.scale < 0 ? -1 : 1;
  return [mx + Math.sin(rad) * 26 * flip, my - Math.cos(rad) * 26 * flip];
}

// Premiere's Program monitor time bar: a ruler with in/out and markers to move the playhead on, zoomable with the
// zoom bar under it, Alt + wheel or a pinch (monitorbar.js)
function ProgramBar({ tab, seq }) {
  const t = useStore(tab.time, (s) => s.t);
  const playing = useStore(tab.time, (s) => s.playing);
  const dur = sequenceDuration(seq);
  const z = useMonitorZoom(dur, seq.fps);
  useFollow(z, t, playing);
  const ref = useRef(null);
  useZoomWheel(ref, z, (x) => { const r = ref.current.getBoundingClientRect(); return (x - r.left - 10) / Math.max(1, r.width - 20); });
  const inOut = seq.inPoint != null || seq.outPoint != null ? `In–Out ${timecode(Math.max(0, (seq.outPoint ?? dur) - (seq.inPoint ?? 0)), seq.fps)}` : null;
  return html`<div class="mon-bar" ref=${ref}>
    <${MonitorRuler} z=${z} t=${t} fps=${seq.fps} inPoint=${seq.inPoint ?? null} outPoint=${seq.outPoint ?? null} markers=${seq.markers || null}
      onSeek=${(tt, phase) => { if (phase === 'start') tab.engine.pause(); tab.engine.seek(snapTime(tt, seq.fps)); }} />
    <${ZoomBar} z=${z} extra=${inOut} />
  </div>`;
}

function Transport({ tab, seq }) {
  const t = useStore(tab.time, (s) => s.t);
  const playing = useStore(tab.time, (s) => s.playing);
  const [loop, setLoop] = useState(tab.engine.loop);
  const dur = sequenceDuration(seq);
  const eng = tab.engine;
  return html`<div class="transport">
    <div class="tc tc-current" title="Current time">${timecode(t, seq.fps)}</div>
    <div class="transport-buttons">
      <${IconButton} icon="toStart" title="Go to start" kbd=${shortcutLabel('play.start')} onClick=${() => eng.seek(0)} />
      <${IconButton} icon="prev" title="Previous frame" kbd=${shortcutLabel('play.prevFrame')} onClick=${() => eng.step(-1)} />
      <button class="play-btn" title=${`Play / pause (${shortcutLabel('play.toggle')})`} onClick=${() => eng.toggle()}>
        <${Icon} name=${playing ? 'pause' : 'play'} size=${18} />
      </button>
      <${IconButton} icon="next" title="Next frame" kbd=${shortcutLabel('play.nextFrame')} onClick=${() => eng.step(1)} />
      <${IconButton} icon="toEnd" title="Go to end" kbd=${shortcutLabel('play.end')} onClick=${() => eng.seek(dur)} />
      <${IconButton} icon="loop" title="Loop playback (in/out range if set)" active=${loop} onClick=${() => { eng.loop = !eng.loop; setLoop(eng.loop); }} />
    </div>
    <div class="transport-right">
      <div class="tc tc-dur" title="Sequence duration">${timecode(dur, seq.fps)}</div>
    </div>
  </div>`;
}
