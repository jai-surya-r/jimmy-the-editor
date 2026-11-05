// Motion tab: an After Effects–style editor for motion graphics that works on the HTML exactly as Claude
// wrote it. What it can reach without touching the file:
//   • the page's own elements (picked in the viewer or the layer list): move, scale, rotate, fade, blur,
//     recolour, restyle text, change text, hide, delete — each keyframable, applied on top of Claude's animation
//     (the layer list shows them as After Effects layers: a type, a readable name, front-most first)
//   • layers added on top: text, rectangles, ellipses, images, fully keyframable
//   • page timing (start offset, speed), its declared parameters, its CSS variables, simple values in its
//     code (constants like HITS = [12, 72]) and the timing of CSS / Web / GSAP animations it creates
// Everything is saved in the media item's motion.edit and applied by public/motion/runtime.js, in this
// preview and in the render alike, so the clip on the timeline re-renders with the changes.
import { html, Icon, IconButton, NumField, ColorField, Select, Toggle, Button, Segmented, usePanelSize, Resizer } from './common.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { get } from '../core/api.js';
import { openMenu, notify, overlays } from '../core/notify.js';
import { uid } from '../core/model.js';
import { motionPageUrl, isMotion, motionActions, ParamField } from './motion.js';
import { GOOGLE_FONTS, SYSTEM_FONTS } from '../core/fonts.js';
import { commandOf, shortcutLabel } from './keymap.js';

// ------------------------------------------------------------------ edit model (mirrors the runtime)

const isKeyed = (v) => !!v && typeof v === 'object' && Array.isArray(v.k);
const EASE = { linear: (x) => x, ease: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2), in: (x) => x * x * x, out: (x) => 1 - (1 - x) ** 3 };
const EASES = [['linear', 'Linear'], ['ease', 'Ease in & out'], ['in', 'Ease in'], ['out', 'Ease out'], ['hold', 'Hold']];
function mix(a, b, p) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
  return p < 1 ? a : b; // colours and text: shown as the earlier key until the next one (the runtime blends colours)
}
export function valueAt(v, t) {
  if (!isKeyed(v)) return v;
  const k = v.k;
  if (!k.length) return undefined;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) {
    const [t0, v0, e] = k[i];
    const [t1, v1] = k[i + 1];
    if (t < t1) return e === 'hold' ? v0 : mix(v0, v1, (EASE[e] || EASE.linear)((t - t0) / (t1 - t0 || 1)));
  }
  return k[k.length - 1][1];
}
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

// The props object of the selected layer inside an edit (created when `create`).
function propsOf(edit, sel, create) {
  if (!sel) return null;
  if (sel.added) return edit.added?.find((l) => l.id === sel.added)?.props || null;
  if (!edit.layers?.[sel.sel]) {
    if (!create) return null;
    edit.layers = { ...(edit.layers || {}), [sel.sel]: { props: {} } };
  }
  const L = edit.layers[sel.sel];
  L.props ||= {};
  return L.props;
}

// Set a prop at time t: a keyframe if the prop is animated, otherwise the plain value.
function setPropValue(edit, sel, key, value, t) {
  const next = clone(edit);
  const P = propsOf(next, sel, true);
  if (!P) return edit;
  const cur = P[key];
  if (isKeyed(cur)) {
    const i = cur.k.findIndex((k) => Math.abs(k[0] - t) < 1e-4);
    if (i >= 0) cur.k[i][1] = value;
    else { cur.k.push([t, value, 'linear']); cur.k.sort((a, b) => a[0] - b[0]); }
  } else P[key] = value;
  return next;
}
function mapProps(edit, sel, fn) {
  const next = clone(edit);
  const P = propsOf(next, sel, true);
  if (P) fn(P);
  return tidy(next);
}
// Drop empty sections so an untouched graphic keeps no edit at all (and keeps its cached render).
function tidy(e) {
  for (const [s, L] of Object.entries(e.layers || {})) {
    for (const [k, v] of Object.entries(L.props || {})) if (v == null || v === '' || (isKeyed(v) && !v.k.length)) delete L.props[k];
    if (!Object.keys(L.props || {}).length && !L.hidden && !L.removed) delete e.layers[s];
  }
  for (const k of ['layers', 'vars', 'consts', 'anims']) if (e[k] && !Object.keys(e[k]).length) delete e[k];
  if (e.added && !e.added.length) delete e.added;
  // Google fonts used anywhere: the runtime loads their stylesheets
  const fonts = new Set();
  const fam = (v) => (isKeyed(v) ? v.k.map((k) => k[1]) : [v]).forEach((f) => { const u = googleFontUrl(String(f || '').trim()); if (u) fonts.add(u); });
  for (const L of Object.values(e.layers || {})) fam(L.props?.fontFamily);
  for (const L of e.added || []) if (L.type === 'text') fam(L.props?.fontFamily ?? 'Inter');
  if (fonts.size) e.fonts = [...fonts]; else delete e.fonts;
  if (e.timing && !Number(e.timing.offset) && (Number(e.timing.speed) || 1) === 1) delete e.timing;
  return e;
}
const editEmpty = (e) => !e || !Object.keys(tidy(clone(e))).length;

const PROP_LABEL = { x: 'Position X', y: 'Position Y', w: 'Width', h: 'Height', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', blur: 'Blur', color: 'Colour',
  bg: 'Background', stroke: 'Stroke', strokeWidth: 'Stroke width', fontSize: 'Font size', fontWeight: 'Font weight', fontFamily: 'Font', letterSpacing: 'Tracking',
  text: 'Text', radius: 'Corner radius', padding: 'Padding', align: 'Align', src: 'Image' };

const FONT_LIST = [...Object.keys(GOOGLE_FONTS), ...SYSTEM_FONTS];
const googleFontUrl = (family) => (GOOGLE_FONTS[family]
  ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${GOOGLE_FONTS[family]}&display=block` : null);

// ------------------------------------------------------------------ the tab

export function MotionMode({ tab }) {
  const doc = useStore(tab.store, (s) => s.doc);
  const statusAll = useStore(tab.store, (s) => s.mediaStatus);
  const motionMedia = useStore(tab.ui, (s) => s.motionMedia);
  const selection = useStore(tab.ui, (s) => s.selection);
  const items = (doc?.media || []).filter(isMotion);
  // the graphic picked here before, else the one selected on the timeline, else the first
  const selClip = doc && tab.seq?.clips.find((c) => selection?.includes(c.id) && items.some((m) => m.id === c.media));
  const media = items.find((m) => m.id === motionMedia) || items.find((m) => m.id === selClip?.media) || items[0];
  if (!media) {
    return html`<div class="mo-empty"><${Icon} name="wand" size=${28} /><h3>No motion graphics in this project yet</h3>
      <p>Ask Claude to make one, or use the bin's New motion graphic. Then come back here to adjust every part of it.</p></div>`;
  }
  return html`<${MotionEditor} key=${media.id} tab=${tab} media=${media} items=${items} st=${statusAll?.[media.id]?.motion || {}} />`;
}

function MotionEditor({ tab, media, items, st }) {
  const pid = tab.projectId;
  const spec = st.spec || { width: media.width || 1920, height: media.height || 1080, fps: media.fps || 30, duration: media.motion.duration || media.duration || 5 };
  const fps = spec.fps || 30;
  const dur = spec.duration || 5;
  const params = { ...(st.params || {}), ...(media.motion.params || {}) };
  const saved = media.motion.edit || {};
  const savedKey = JSON.stringify(saved);

  // draft = what the preview shows; saved to the project on commit (end of a drag, a typed value…)
  const [draft, setDraftState] = useState(() => clone(saved));
  const draftRef = useRef(draft);
  const dragging = useRef(false);
  const setDraft = (e) => { draftRef.current = e; setDraftState(e); };
  // undo/redo (or Claude) changed the saved edits: show them, in this panel and in the preview — except mid-drag in the viewer or timeline
  useEffect(() => { if (!dragging.current && JSON.stringify(draftRef.current) !== savedKey) live(clone(saved)); }, [savedKey]);

  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState(null); // { sel: selector } | { added: id }
  const [box, setBox] = useState(null);
  const [rawLayers, setLayers] = useState([]);
  const layers = useMemo(() => aeLayers(rawLayers), [rawLayers]);
  const [anims, setAnims] = useState([]);
  const [code, setCode] = useState({ consts: [], vars: [] });
  const [err, setErr] = useState(null);
  const [selKey, setSelKey] = useState(null); // { owner, prop, i } — selected keyframe on the timeline
  const frame = useRef(null);
  const post = (m) => frame.current?.contentWindow?.postMessage(m, '*');

  const snap = (x) => Math.max(0, Math.min(dur, Math.round(x * fps) / fps));
  const seek = (x) => { const v = snap(x); tRef.current = v; setT(v); post({ type: 'motion-seek', t: v }); };

  // live: preview only; commit: also saved (one undo step)
  const live = (e) => { setDraft(e); post({ type: 'motion-edit', edit: e }); };
  const commit = (label, e) => {
    const next = tidy(clone(e));
    live(next);
    dragging.current = false;
    tab.apply(`Motion: ${label}`, (d) => {
      const m = d.media.find((x) => x.id === media.id);
      if (!m) return false;
      const motion = { ...m.motion };
      if (editEmpty(next)) delete motion.edit; else motion.edit = next;
      m.motion = motion;
      return undefined;
    });
  };

  // composition code values change the page itself: they're part of the URL, so the frame reloads
  const constsKey = JSON.stringify(draft.consts || {});
  const url = useMemo(() => motionPageUrl(pid, media.motion.src, { mode: 'preview', params, ...spec, edit: { consts: draft.consts || {} } }),
    [pid, media.motion.src, JSON.stringify(params), JSON.stringify(spec), constsKey]);

  const inspect = () => post({ type: 'motion-inspect' });
  useEffect(() => {
    setErr(null);
    const on = (e) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data || {};
      if (d.type === 'motion-ready') {
        post({ type: 'motion-edit', edit: draftRef.current });
        post({ type: 'motion-seek', t: tRef.current });
        inspect();
      } else if (d.type === 'motion-frame') setBox(d.box || null);
      else if (d.type === 'motion-layers') { setLayers(d.layers || []); setAnims(d.anims || []); }
      else if (d.type === 'motion-picked') { if (d.pick) setSel(d.pick); }
      else if (d.type === 'motion-error') setErr(d.message);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [url]);
  useEffect(() => { post({ type: 'motion-select', ...(sel || {}) }); }, [sel?.sel, sel?.added]);
  // elements come and go over time: re-read the layer list after the playhead settles
  useEffect(() => { if (playing) return undefined; const id = setTimeout(inspect, 350); return () => clearTimeout(id); }, [t, playing]);

  // code values and CSS variables, read from the HTML by the server (again whenever the file changes)
  useEffect(() => { get(`/api/p/${pid}/motion/${media.id}/inspect`).then(setCode).catch(() => {}); }, [pid, media.id, st.sig]);

  // playback
  useEffect(() => {
    if (!playing) return undefined;
    let raf, last = performance.now();
    const tick = (now) => {
      let nt = tRef.current + (now - last) / 1000;
      last = now;
      if (nt >= dur) nt = 0;
      tRef.current = nt;
      setT(nt);
      post({ type: 'motion-seek', t: nt });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur]);

  // keys (only while this tab is showing)
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"], .xterm')) return;
      if (overlays.get().dialog || overlays.get().menu) return;
      const cmd = commandOf(e, 'motion'); // the keyboard layout's Motion commands (keymap.js)
      const step = { 'mo.prevFrame': -1 / fps, 'mo.nextFrame': 1 / fps, 'mo.prevSecond': -1, 'mo.nextSecond': 1 }[cmd];
      if (cmd === 'mo.play') { e.preventDefault(); setPlaying((p) => !p); }
      else if (step) { e.preventDefault(); setPlaying(false); seek(tRef.current + step); }
      else if (cmd === 'mo.start') { e.preventDefault(); seek(0); }
      else if (cmd === 'mo.end') { e.preventDefault(); seek(dur); }
      else if (cmd === 'mo.deselect') { setSel(null); setSelKey(null); }
      else if (cmd === 'mo.delete' && selKey) { e.preventDefault(); deleteKey(selKey); }
      else if (cmd === 'mo.delete' && sel?.added) { e.preventDefault(); removeAdded(sel.added); }
      else if (cmd === 'mo.delete' && sel?.sel) { e.preventDefault(); removeElement(sel.sel); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- layer edits
  const ownerSel = (owner) => (owner.startsWith('+') ? { added: owner.slice(1) } : { sel: owner });
  const ownerOf = (s) => (s?.added ? `+${s.added}` : s?.sel);
  const deleteKey = ({ owner, prop, i }) => {
    commit('Delete keyframe', mapProps(draftRef.current, ownerSel(owner), (P) => {
      const v = P[prop];
      if (!isKeyed(v)) return;
      v.k.splice(i, 1);
      if (!v.k.length) delete P[prop];
    }));
    setSelKey(null);
  };
  const addLayer = (type) => {
    const id = uid('L');
    const W = spec.width, H = spec.height;
    const base = { x: Math.round(W / 2), y: Math.round(H / 2) };
    const props = type === 'text' ? { ...base, text: 'Your text', fontSize: Math.round(H / 12), color: '#ffffff', fontWeight: 700, fontFamily: 'Inter' }
      : type === 'image' ? { ...base, w: Math.round(W / 3), src: '' }
        : { ...base, w: Math.round(W / 4), h: Math.round(H / 5), color: '#7c5cff', radius: type === 'rect' ? 12 : 0 };
    const name = { text: 'Text', rect: 'Rectangle', ellipse: 'Ellipse', image: 'Image' }[type];
    const n = (draftRef.current.added || []).filter((l) => l.type === type).length + 1;
    const next = clone(draftRef.current);
    next.added = [...(next.added || []), { id, type, name: `${name} ${n}`, start: 0, end: dur, props }];
    commit(`Add ${name.toLowerCase()} layer`, next);
    setSel({ added: id });
  };
  const removeAdded = (id) => {
    const next = clone(draftRef.current);
    next.added = (next.added || []).filter((l) => l.id !== id);
    commit('Delete layer', next);
    setSel(null);
  };
  // deleting one of the graphic's own elements: it's never drawn again (Restore brings it back), nothing else moves
  const removeElement = (s) => {
    const next = clone(draftRef.current);
    next.layers ||= {};
    (next.layers[s] ||= { props: {} }).removed = true;
    commit('Delete layer', next);
    setSel(null);
  };
  const restoreElement = (s) => {
    const next = clone(draftRef.current);
    if (next.layers?.[s]) delete next.layers[s].removed;
    commit('Restore layer', next);
  };
  const setAddedField = (id, patch, label) => {
    const next = clone(draftRef.current);
    const L = next.added?.find((l) => l.id === id);
    if (!L) return;
    Object.assign(L, patch);
    commit(label, next);
  };
  const toggleHidden = (s) => {
    if (s.added) { const L = draftRef.current.added?.find((l) => l.id === s.added); setAddedField(s.added, { hidden: !L?.hidden }, L?.hidden ? 'Show layer' : 'Hide layer'); return; }
    const next = clone(draftRef.current);
    next.layers ||= {};
    const L = (next.layers[s.sel] ||= { props: {} });
    L.hidden = !L.hidden;
    commit(L.hidden ? 'Hide element' : 'Show element', next);
  };

  // ---- viewer drags: move (body), scale (corners), rotate (top handle)
  const stageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 800, h: 450 });
  useEffect(() => {
    const ro = new ResizeObserver(() => { const r = stageRef.current?.getBoundingClientRect(); if (r) setStageSize({ w: r.width, h: r.height }); });
    if (stageRef.current) ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, []);
  const k = Math.max(0.05, Math.min((stageSize.w - 24) / spec.width, (stageSize.h - 24) / spec.height));
  const ox = (stageSize.w - spec.width * k) / 2, oy = (stageSize.h - spec.height * k) / 2;
  const P = propsOf(clone(draft), sel, false) || {};
  const cur = (key, d) => { const v = valueAt(P[key], t); return v == null || v === '' ? d : v; };
  const isAdded = !!sel?.added;

  const onStageDown = (e) => {
    if (e.button !== 0) return;
    const r = stageRef.current.getBoundingClientRect();
    const cx = (e.clientX - r.left - ox) / k, cy = (e.clientY - r.top - oy) / k;
    const handle = e.target.dataset?.h;
    const inBox = box && cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3];
    if (!sel || (!handle && !inBox)) {
      // click: pick the element under the pointer
      setPlaying(false);
      post({ type: 'motion-pick', x: cx, y: cy });
      return;
    }
    e.preventDefault();
    setPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = clone(draftRef.current);
    const sp = propsOf(clone(start), sel, false) || {};
    const at = (key, d) => { const v = valueAt(sp[key], tRef.current); return v == null || v === '' ? d : Number(v); };
    const mid = [box[0] + box[2] / 2, box[1] + box[3] / 2];
    const x0 = at('x', isAdded ? spec.width / 2 : 0), y0 = at('y', isAdded ? spec.height / 2 : 0), s0 = at('scale', 1), r0 = at('rotation', 0);
    const d0 = Math.hypot(cx - mid[0], cy - mid[1]) || 1, a0 = Math.atan2(cy - mid[1], cx - mid[0]);
    let moved = false;
    dragging.current = true;
    const target = e.currentTarget;
    const move = (ev) => {
      const px = (ev.clientX - r.left - ox) / k, py = (ev.clientY - r.top - oy) / k;
      if (!moved && Math.hypot(px - cx, py - cy) < 2 / k) return;
      moved = true;
      let next = start;
      const tt = tRef.current;
      if (handle === 'scale') {
        const s = Math.max(0.01, s0 * (Math.hypot(px - mid[0], py - mid[1]) / d0));
        next = setPropValue(start, sel, 'scale', Math.round(s * 1000) / 1000, tt);
      } else if (handle === 'rotate') {
        let a = r0 + ((Math.atan2(py - mid[1], px - mid[0]) - a0) * 180) / Math.PI;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        next = setPropValue(start, sel, 'rotation', Math.round(a * 10) / 10, tt);
      } else {
        let dx = px - cx, dy = py - cy;
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        next = setPropValue(setPropValue(start, sel, 'x', Math.round(x0 + dx), tt), sel, 'y', Math.round(y0 + dy), tt);
      }
      live(next);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (moved) commit(handle === 'scale' ? 'Scale' : handle === 'rotate' ? 'Rotate' : 'Move', draftRef.current);
      else dragging.current = false;
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const selLayer = sel?.sel ? layers.find((l) => l.sel === sel.sel) : null;
  const [tlH, startTl] = usePanelSize('motionTimeline', 210, 110, 900);
  const selAdded = sel?.added ? (draft.added || []).find((l) => l.id === sel.added) : null;
  const selName = selAdded?.name || selLayer?.name || (sel?.sel ? 'Layer' : null);

  return html`<div class="mo">
    <div class="mo-top">
      <${LayersPanel} tab=${tab} media=${media} items=${items} layers=${layers} draft=${draft} sel=${sel} setSel=${setSel}
        addLayer=${addLayer} toggleHidden=${toggleHidden} removeAdded=${removeAdded} removeElement=${removeElement} restoreElement=${restoreElement} refresh=${inspect} />
      <div class="mo-center">
        <div class="mo-bar">
          <${IconButton} icon=${playing ? 'pause' : 'play'} title="Play / pause (Space)" onClick=${() => setPlaying(!playing)} />
          <${IconButton} icon="toStart" title="Go to start (Home)" onClick=${() => { setPlaying(false); seek(0); }} />
          <${IconButton} icon="prev" title="Previous frame (←)" onClick=${() => { setPlaying(false); seek(t - 1 / fps); }} />
          <${IconButton} icon="next" title="Next frame (→)" onClick=${() => { setPlaying(false); seek(t + 1 / fps); }} />
          <span class="mo-time">${t.toFixed(2)}s <span class="muted">/ ${dur.toFixed(2)}s · frame ${Math.round(t * fps)}</span></span>
          <div class="spacer"></div>
          ${sel ? html`<span class="mo-selname" title=${sel.sel || ''}>${selName}</span>
            <${IconButton} icon="x" title="Deselect (Esc)" onClick=${() => setSel(null)} />` : html`<span class="muted mo-hint">Click anything in the frame to select it</span>`}
        </div>
        <div class="mo-stage" ref=${stageRef} onPointerDown=${onStageDown}>
          <div class="mo-canvas" style=${{ left: `${ox}px`, top: `${oy}px`, width: `${spec.width * k}px`, height: `${spec.height * k}px` }}>
            <iframe ref=${frame} key=${url} src=${url} sandbox="allow-scripts" title="Motion graphic" tabIndex="-1"
              style=${{ width: `${spec.width}px`, height: `${spec.height}px`, transform: `scale(${k})` }}></iframe>
          </div>
          ${sel && box ? html`<div class="mo-box" style=${{ left: `${ox + box[0] * k}px`, top: `${oy + box[1] * k}px`, width: `${Math.max(2, box[2] * k)}px`, height: `${Math.max(2, box[3] * k)}px` }}>
            ${['nw', 'ne', 'sw', 'se'].map((c) => html`<i class=${`mo-h mo-h-${c}`} data-h="scale" title="Drag to scale"></i>`)}
            <i class="mo-h mo-h-rot" data-h="rotate" title="Drag to rotate (Shift: 15° steps)"></i>
          </div>` : null}
          ${err ? html`<div class="motion-preview-err" title=${err}>${err}</div>` : null}
        </div>
      </div>
      <div class="mo-props">
        ${sel
          ? html`<${LayerProps} key=${ownerOf(sel)} sel=${sel} layer=${selLayer} added=${selAdded} P=${P} cur=${cur} t=${t} spec=${spec} draftRef=${draftRef}
              live=${live} commit=${commit} dragging=${dragging} setAddedField=${setAddedField} tab=${tab} dur=${dur} />`
          : html`<${GraphicProps} tab=${tab} media=${media} st=${st} spec=${spec} params=${params} draft=${draft} code=${code} anims=${anims}
              live=${live} commit=${commit} dragging=${dragging} />`}
      </div>
    </div>
    <${Resizer} axis="y" onPointerDown=${(e) => startTl(e, -1, 'y')} />
    <${KeyTimeline} height=${Math.max(110, Math.min(tlH, window.innerHeight - 280))} draft=${draft} layers=${layers} t=${t} dur=${dur} fps=${fps} seek=${(x) => { setPlaying(false); seek(x); }} sel=${sel} setSel=${setSel}
      selKey=${selKey} setSelKey=${setSelKey} live=${live} commit=${commit} dragging=${dragging} draftRef=${draftRef} ownerSel=${ownerSel} deleteKey=${deleteKey} />
  </div>`;
}

// ------------------------------------------------------------------ left: layers

// Editors think in After Effects layers, not HTML: every element gets a layer type and a readable name. Text layers are named by
// their text, the others by the id or class Claude gave them ("comment-card" → "Comment Card"), else by type ("Shape Layer 3").
const KIND_ICON = { text: 'text', image: 'image', svg: 'pen', canvas: 'film', video: 'film', group: 'layers', shape: 'square', rect: 'square', ellipse: 'circle' };
const AE_TYPE = { text: 'Text', image: 'Image', svg: 'Vector', canvas: 'Canvas', video: 'Video', group: 'Pre-comp', shape: 'Shape Layer', rect: 'Shape Layer', ellipse: 'Shape Layer' };
const pretty = (x) => x.replace(/[-_.]+/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
function aeLayers(list) {
  const count = {};
  return list.map((l) => {
    const n = (count[l.kind] = (count[l.kind] || 0) + 1);
    const own = /^“(.*)”$/.exec(l.label || '')?.[1];
    const id = l.id ?? (/^#(.+)/.exec(l.label || '')?.[1] || '');
    const cls = l.cls ?? (/^[a-z\d-]+\.(.+)/i.exec(l.label || '')?.[1] || '');
    const name = l.kind === 'text' && own ? own : id ? pretty(id) : cls ? pretty(cls) : l.src || `${AE_TYPE[l.kind] || 'Layer'} ${n}`;
    return { ...l, name, type: AE_TYPE[l.kind] || 'Layer' };
  });
}
// page order → After Effects order: the front-most layer first at every level, each one's children right under it
function stackOrder(list) {
  const roots = [];
  const stack = [];
  for (const l of list) {
    const node = { l, kids: [] };
    while (stack.length && stack[stack.length - 1].l.depth >= l.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : roots).push(node);
    stack.push(node);
  }
  const out = [];
  const walk = (nodes, parents) => {
    for (const nd of [...nodes].reverse()) {
      out.push({ ...nd.l, parents, hasKids: nd.kids.length > 0 });
      walk(nd.kids, [...parents, nd.l.sel]);
    }
  };
  walk(roots, []);
  return out;
}

function LayersPanel({ tab, media, items, layers, draft, sel, setSel, addLayer, toggleHidden, removeAdded, removeElement, restoreElement, refresh }) {
  const [q, setQ] = useState('');
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [closed, setClosed] = useState(() => new Set()); // groups twirled shut
  const [showDeleted, setShowDeleted] = useState(false);
  const edited = draft.layers || {};
  const removed = Object.keys(edited).filter((k) => edited[k].removed);
  const gone = new Set(removed);
  const query = q.trim().toLowerCase();
  const ordered = useMemo(() => stackOrder(layers), [layers]);
  const matches = (name, type) => !query || name.toLowerCase().includes(query) || type.toLowerCase().includes(query);
  const shown = ordered.filter((l) => !gone.has(l.sel) && !l.parents.some((p) => gone.has(p)) && matches(l.name, l.type)
    && (query || !l.parents.some((p) => closed.has(p))) && (!visibleOnly || l.visible || edited[l.sel]));
  const added = [...(draft.added || [])].reverse().filter((L) => matches(L.name, AE_TYPE[L.type] || 'Layer'));
  const twirl = (k) => { const n = new Set(closed); if (n.has(k)) n.delete(k); else n.add(k); setClosed(n); };
  const menu = (e, it) => {
    e.preventDefault();
    const target = it.added ? { added: it.added } : { sel: it.sel };
    setSel(target);
    openMenu(e.clientX, e.clientY, [
      { label: it.hidden ? 'Show layer' : 'Hide layer', icon: it.hidden ? 'eye' : 'eyeOff', action: () => toggleHidden(target) },
      { separator: true },
      { label: 'Delete layer', icon: 'trash', danger: true, shortcut: shortcutLabel('mo.delete'), action: () => (it.added ? removeAdded(it.added) : removeElement(it.sel)) },
    ]);
  };
  let n = 0;
  // one row: eye · number · twirl · type icon · name … delete (as in After Effects' timeline panel)
  const row = (it) => html`<div class=${`mo-row ${it.on ? 'is-on' : ''} ${it.hidden ? 'is-hidden' : ''} ${it.dim ? 'is-dim' : ''}`} key=${it.key}
    onClick=${it.pick} onContextMenu=${(e) => menu(e, it)} title=${`${it.type} layer${it.dim ? ' · not visible at this moment' : ''}`}>
    <button class="mo-vis" title=${it.hidden ? 'Show layer' : 'Hide layer'} onClick=${(e) => { e.stopPropagation(); toggleHidden(it.added ? { added: it.added } : { sel: it.sel }); }}>
      <${Icon} name=${it.hidden ? 'eyeOff' : 'eye'} size=${13} /></button>
    <span class="mo-num">${++n}</span>
    <span class="mo-indent" style=${{ width: `${Math.min(it.depth, 8) * 12}px` }}></span>
    ${it.hasKids ? html`<button class="mo-twirl" title=${it.open ? 'Hide what is inside' : 'Show what is inside'} onClick=${(e) => { e.stopPropagation(); twirl(it.sel); }}>
      <${Icon} name=${it.open ? 'down' : 'next'} size=${11} /></button>` : html`<span class="mo-twirl"></span>`}
    <${Icon} name=${KIND_ICON[it.kind] || 'square'} size=${13} /><span class="mo-row-name">${it.name}</span>
    ${it.changed ? html`<i class="mo-dot" title="Changed in the Motion tab"></i>` : null}
    <button class="mo-del" title=${`Delete layer (${shortcutLabel('mo.delete')})`} onClick=${(e) => { e.stopPropagation(); it.added ? removeAdded(it.added) : removeElement(it.sel); }}>
      <${Icon} name="trash" size=${12} /></button>
  </div>`;
  return html`<div class="mo-layers">
    ${items.length > 1 ? html`<div class="mo-pick"><${Select} class="select-sm" value=${media.id} onChange=${(v) => tab.ui.set({ motionMedia: v })}
      options=${items.map((m) => ({ value: m.id, label: m.name }))} /></div>` : html`<div class="mo-pick mo-name" title=${media.motion.src}>${media.name}</div>`}
    <div class="mo-sec-head"><span>Layers <span class="muted">${(draft.added || []).length + shown.length}</span></span>
      <span class="mo-add">
        <button title="New text layer" onClick=${() => addLayer('text')}><${Icon} name="text" size=${13} /></button>
        <button title="New shape layer: rectangle" onClick=${() => addLayer('rect')}><${Icon} name="square" size=${13} /></button>
        <button title="New shape layer: ellipse" onClick=${() => addLayer('ellipse')}><${Icon} name="circle" size=${13} /></button>
        <button title="New image layer" onClick=${() => addLayer('image')}><${Icon} name="image" size=${13} /></button>
        <button title="Read the layers again" onClick=${refresh}><${Icon} name="refresh" size=${13} /></button>
      </span></div>
    <div class="mo-filter">
      <input class="input input-sm" placeholder="Search layers" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
      <${Toggle} checked=${visibleOnly} onChange=${setVisibleOnly} label="Visible now" />
    </div>
    <div class="mo-list">
      ${added.map((L) => row({ key: `+${L.id}`, added: L.id, on: sel?.added === L.id, hidden: L.hidden, depth: 0, kind: L.type, type: AE_TYPE[L.type] || 'Layer', name: L.name,
        pick: () => setSel({ added: L.id }) }))}
      ${shown.map((l) => row({ key: l.sel, sel: l.sel, on: sel?.sel === l.sel, hidden: edited[l.sel]?.hidden, dim: !l.visible, depth: l.parents.length, kind: l.kind, type: l.type, name: l.name,
        hasKids: l.hasKids, open: !closed.has(l.sel), changed: Object.keys(edited[l.sel]?.props || {}).length > 0, pick: () => setSel({ sel: l.sel }) }))}
      ${!layers.length ? html`<div class="mo-note">Loading the graphic…</div>` : null}
      ${layers.length && !added.length && !shown.length ? html`<div class="mo-note">${query ? `No layer matches "${q}"` : 'No layer is visible at this moment: turn off "Visible now" to see them all.'}</div>` : null}
    </div>
    ${removed.length ? html`<div class="mo-deleted">
      <button class="link-btn" onClick=${() => setShowDeleted(!showDeleted)}><${Icon} name=${showDeleted ? 'down' : 'next'} size=${11} />Deleted layers (${removed.length})</button>
      ${showDeleted ? removed.map((k) => html`<div class="mo-row is-deleted" key=${k}>
        <span class="mo-row-name">${layers.find((l) => l.sel === k)?.name || 'Layer'}</span>
        <button class="link-btn" onClick=${() => restoreElement(k)}>Restore</button></div>`) : null}
    </div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ right: properties

// One property row: value field, keyframe stopwatch, add/remove key at the playhead, reset.
function PropRow({ label, k: key, P, t, sel, draftRef, live, commit, dragging, kind = 'num', def, unit, step = 1, min, max, precision = 0, scale = 1, options, help }) {
  const raw = P[key];
  const keyed = isKeyed(raw);
  const v = valueAt(raw, t);
  const shown = v == null || v === '' ? def : v;
  const set = (val, done) => {
    const next = setPropValue(draftRef.current, sel, key, val, t);
    if (done) commit(`${label}`, next); else live(next);
  };
  const onKey = keyed ? raw.k.findIndex((x) => Math.abs(x[0] - t) < 1e-4) : -1;
  const toggleAnim = () => commit(keyed ? `Stop animating ${label}` : `Animate ${label}`, mapProps(draftRef.current, sel, (Q) => {
    Q[key] = keyed ? valueAt(raw, t) : { k: [[t, shown, 'linear']] };
  }));
  const keyHere = () => commit(onKey >= 0 ? 'Delete keyframe' : 'Add keyframe', mapProps(draftRef.current, sel, (Q) => {
    const kk = Q[key];
    if (onKey >= 0) { kk.k.splice(onKey, 1); if (!kk.k.length) delete Q[key]; } else { kk.k.push([t, shown, 'linear']); kk.k.sort((a, b) => a[0] - b[0]); }
  }));
  const reset = () => commit(`Reset ${label}`, mapProps(draftRef.current, sel, (Q) => { delete Q[key]; }));
  let field;
  if (kind === 'num') {
    field = html`<${NumField} value=${Number(shown) * scale} step=${step} min=${min ?? -Infinity} max=${max ?? Infinity} precision=${precision} unit=${unit || ''}
      onChange=${(x) => set(x / scale, false)} onEnd=${(x) => set(x / scale, true)} />`;
  } else if (kind === 'color') {
    field = html`<${ColorField} value=${String(shown || '#ffffff')} onChange=${(x) => set(x, false)} onEnd=${(x) => set(x, true)} />`;
  } else if (kind === 'select') {
    field = html`<${Select} class="select-sm" value=${String(shown ?? '')} options=${options} onChange=${(x) => set(x, true)} />`;
  } else {
    field = html`<${TextField} value=${String(shown ?? '')} multiline=${kind === 'textarea'} list=${kind === 'font' ? 'mo-fonts' : null} onCommit=${(x) => set(x, true)} />`;
  }
  return html`<div class=${`mo-prop ${raw != null ? 'is-set' : ''}`} title=${help || ''}>
    <button class=${`mo-sw ${keyed ? 'is-on' : ''}`} title=${keyed ? 'Animated: click to stop animating' : 'Animate this property (keyframes)'} onClick=${toggleAnim}><${Icon} name="clock" size=${12} /></button>
    <span class="mo-prop-label">${label}</span>
    <div class="mo-prop-field">${field}</div>
    ${keyed ? html`<button class=${`mo-kf ${onKey >= 0 ? 'is-on' : ''}`} title=${onKey >= 0 ? 'Remove the keyframe here' : 'Add a keyframe here'} onClick=${keyHere}><${Icon} name="diamond" size=${11} /></button>` : html`<span class="mo-kf-sp"></span>`}
    ${raw != null ? html`<button class="mo-reset" title="Reset" onClick=${reset}><${Icon} name="refresh" size=${11} /></button>` : html`<span class="mo-kf-sp"></span>`}
  </div>`;
}

function TextField({ value, onCommit, multiline, list }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const keys = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { setDraft(value); e.target.blur(); } };
  return multiline
    ? html`<textarea class="text-input" rows="2" value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${commit} onKeyDown=${keys}></textarea>`
    : html`<input class="input input-sm" list=${list} value=${draft} onInput=${(e) => setDraft(e.target.value)} onBlur=${commit} onKeyDown=${keys} />`;
}

function Group({ title, children, open: open0 = true, extra }) {
  const [open, setOpen] = useState(open0);
  return html`<div class="mo-group">
    <button class="mo-group-head" onClick=${() => setOpen(!open)}><${Icon} name=${open ? 'down' : 'chevronRight'} size=${12} /><span>${title}</span>${extra || null}</button>
    ${open ? html`<div class="mo-group-body">${children}</div>` : null}
  </div>`;
}

function LayerProps({ sel, layer, added, P, t, spec, draftRef, live, commit, dragging, setAddedField, tab, dur }) {
  const common = { P, t, sel, draftRef, live, commit, dragging };
  const isAdded = !!added;
  const kind = added?.type || layer?.kind;
  const svg = !!layer?.svg;
  const textish = kind === 'text';
  const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }));
  const media = tab.doc.media.filter((m) => m.type === 'image' && m.path && !/^([a-z]:|[\\/])/i.test(m.path)); // files inside the project
  return html`<div class="mo-props-inner">
    ${FONT_DATALIST}
    <div class="mo-props-title"><${Icon} name=${KIND_ICON[kind] || 'square'} size=${14} />
      ${isAdded ? html`<${TextField} value=${added.name} onCommit=${(v) => setAddedField(added.id, { name: v || added.name }, 'Rename layer')} />` : html`<span title=${layer ? `${layer.type} layer` : ''}>${layer?.name || 'Layer'}</span>`}</div>
    ${!isAdded ? html`<div class="mo-note">Changes are added on top of Claude's animation, so it keeps moving the way it was made. Position is an offset from where the animation puts it.</div>` : null}
    <${Group} title="Transform">
      <${PropRow} ...${common} label="Position X" k="x" def=${isAdded ? spec.width / 2 : 0} unit="px" />
      <${PropRow} ...${common} label="Position Y" k="y" def=${isAdded ? spec.height / 2 : 0} unit="px" />
      ${isAdded && kind !== 'text' ? html`<${PropRow} ...${common} label="Width" k="w" def=${400} unit="px" min=${1} />` : null}
      ${isAdded && (kind === 'rect' || kind === 'ellipse') ? html`<${PropRow} ...${common} label="Height" k="h" def=${200} unit="px" min=${1} />` : null}
      <${PropRow} ...${common} label="Scale" k="scale" def=${1} scale=${100} unit="%" min=${0} />
      <${PropRow} ...${common} label="Rotation" k="rotation" def=${0} unit="°" precision=${1} />
      <${PropRow} ...${common} label="Opacity" k="opacity" def=${1} scale=${100} unit="%" min=${0} max=${100} />
      <${PropRow} ...${common} label="Blur" k="blur" def=${0} unit="px" min=${0} precision=${1} step=${0.5} />
    </${Group}>
    ${isAdded && kind === 'image' ? html`<${Group} title="Image">
      <div class="mo-prop"><span class="mo-kf-sp"></span><span class="mo-prop-label">Image</span><div class="mo-prop-field">
        <${Select} class="select-sm" value=${valueAt(P.src, t) || ''} onChange=${(v) => commit('Image', setPropValue(draftRef.current, sel, 'src', v, t))}
          options=${[{ value: '', label: media.length ? 'Pick a project image…' : 'Import an image to the bin first' }, ...media.map((m) => ({ value: m.path, label: m.name }))]} /></div></div>
      <${PropRow} ...${common} label="Corner radius" k="radius" def=${0} unit="px" min=${0} />
    </${Group}>` : null}
    ${textish ? html`<${Group} title="Text">
      ${isAdded || layer?.text != null ? html`<${PropRow} ...${common} label="Text" k="text" kind="textarea" def=${isAdded ? 'Text' : layer.text} />` : null}
      <${PropRow} ...${common} label="Colour" k="color" kind="color" def="#ffffff" />
      <${PropRow} ...${common} label="Font" k="fontFamily" kind="font" def=${isAdded ? 'Inter' : ''} help="Any installed font, or one of the Google fonts listed" />
      <${PropRow} ...${common} label="Size" k="fontSize" def=${isAdded ? 80 : 48} unit="px" min=${1} />
      <${PropRow} ...${common} label="Weight" k="fontWeight" kind="select" def=${isAdded ? '700' : '400'} options=${weights} />
      <${PropRow} ...${common} label="Tracking" k="letterSpacing" def=${0} unit="px" precision=${1} step=${0.5} />
      ${isAdded ? html`<${PropRow} ...${common} label="Align" k="align" kind="select" def="center" options=${[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} />
        <${PropRow} ...${common} label="Background" k="bg" kind="color" def="transparent" />
        <${PropRow} ...${common} label="Padding" k="padding" def=${0} unit="px" min=${0} />
        <${PropRow} ...${common} label="Corner radius" k="radius" def=${0} unit="px" min=${0} />` : null}
    </${Group}>` : null}
    ${!textish && !(isAdded && kind === 'image') ? html`<${Group} title="Fill & stroke">
      ${isAdded ? html`<${PropRow} ...${common} label="Fill" k="color" kind="color" def="#7c5cff" />`
        : html`<${PropRow} ...${common} label=${svg ? 'Fill' : 'Colour'} k="color" kind="color" def="#ffffff" />`}
      ${!svg && !isAdded ? html`<${PropRow} ...${common} label="Background" k="bg" kind="color" def="#000000" help="Replaces the element's background (colour or gradient)" />` : null}
      ${svg ? html`<${PropRow} ...${common} label="Stroke" k="stroke" kind="color" def="#ffffff" />` : null}
      ${isAdded ? html`<${PropRow} ...${common} label="Stroke" k="stroke" kind="color" def="#ffffff" />
        <${PropRow} ...${common} label="Stroke width" k="strokeWidth" def=${0} unit="px" min=${0} />
        ${kind === 'rect' ? html`<${PropRow} ...${common} label="Corner radius" k="radius" def=${0} unit="px" min=${0} />` : null}` : null}
    </${Group}>` : null}
    ${isAdded ? html`<${Group} title="Timing">
      <div class="mo-prop"><span class="mo-kf-sp"></span><span class="mo-prop-label">In</span><div class="mo-prop-field">
        <${NumField} value=${added.start || 0} min=${0} max=${dur} step=${0.04} precision=${2} unit="s" onEnd=${(v) => setAddedField(added.id, { start: Math.min(v, added.end ?? dur) }, 'Layer in point')} /></div><span class="mo-kf-sp"></span><span class="mo-kf-sp"></span></div>
      <div class="mo-prop"><span class="mo-kf-sp"></span><span class="mo-prop-label">Out</span><div class="mo-prop-field">
        <${NumField} value=${added.end ?? dur} min=${0} max=${dur} step=${0.04} precision=${2} unit="s" onEnd=${(v) => setAddedField(added.id, { end: Math.max(v, added.start || 0) }, 'Layer out point')} /></div><span class="mo-kf-sp"></span><span class="mo-kf-sp"></span></div>
      ${kind === 'text' ? html`<div class="mo-note">Google fonts load automatically; other fonts must be installed on this computer.</div>` : null}
    </${Group}>` : null}
  </div>`;
}
const FONT_DATALIST = html`<datalist id="mo-fonts">${FONT_LIST.map((f) => html`<option value=${f} />`)}</datalist>`;

function GraphicProps({ tab, media, st, spec, params, draft, code, anims, live, commit, dragging }) {
  const schema = st.schema || [];
  const timing = draft.timing || {};
  const setTiming = (patch, label, done = true) => {
    const next = clone(draft);
    next.timing = { offset: 0, speed: 1, ...(next.timing || {}), ...patch };
    if (done) commit(label, next); else live(next);
  };
  const setParam = (key, v, label) => tab.apply(`Motion: ${label}`, (d) => {
    const m = d.media.find((x) => x.id === media.id);
    if (!m || m.motion.params?.[key] === v) return false;
    m.motion = { ...m.motion, params: { ...(m.motion.params || {}), [key]: v } };
    return undefined;
  });
  const setSection = (sec, key, v, label) => {
    const next = clone(draft);
    next[sec] = { ...(next[sec] || {}) };
    if (v == null) delete next[sec][key]; else next[sec][key] = v;
    commit(label, next);
  };
  const state = st.state || 'queued';
  const top = code.consts.filter((c) => !c.inner);
  const inner = code.consts.filter((c) => c.inner);
  return html`<div class="mo-props-inner">
    <div class="mo-props-title"><${Icon} name="wand" size=${14} /><span>${media.name}</span></div>
    <div class=${`motion-status is-${state}`}>
      ${state === 'rendering' || state === 'queued' ? html`<span class="spinner spinner-xs"></span>` : html`<${Icon} name=${state === 'error' ? 'alert' : 'checkCircle'} size=${13} />`}
      <span>${state === 'rendering' ? `Rendering ${Math.round((st.progress || 0) * 100)}%` : state === 'queued' ? 'Waiting to render' : state === 'error' ? 'Render failed' : 'Timeline clip up to date'}</span>
    </div>
    <div class="mo-note">${spec.width}×${spec.height} · ${spec.fps} fps · ${Number(spec.duration).toFixed(2)}s. Changes here re-render the clip on the timeline by themselves.
      <button class="link-btn" onClick=${() => motionActions.openCode(tab, media)}>Open code</button></div>
    <${Group} title="Timing">
      <div class="mo-prop"><span class="mo-kf-sp"></span><span class="mo-prop-label">Start offset</span><div class="mo-prop-field">
        <${NumField} value=${Number(timing.offset) || 0} step=${0.04} precision=${2} unit="s" onChange=${(v) => setTiming({ offset: v }, '', false)} onEnd=${(v) => setTiming({ offset: v }, 'Start offset')} /></div></div>
      <div class="mo-prop"><span class="mo-kf-sp"></span><span class="mo-prop-label">Speed</span><div class="mo-prop-field">
        <${NumField} value=${(Number(timing.speed) || 1) * 100} min=${5} max=${1000} step=${1} precision=${0} unit="%" onChange=${(v) => setTiming({ speed: v / 100 }, '', false)} onEnd=${(v) => setTiming({ speed: v / 100 }, 'Speed')} /></div></div>
      <div class="mo-note">Start offset delays (or, negative, skips into) Claude's animation; speed plays it faster or slower. Your own layers and keyframes keep their times.</div>
    </${Group}>
    ${schema.length ? html`<${Group} title="Parameters">
      ${schema.map((p) => html`<div class="mo-prop"><span class="mo-kf-sp"></span><span class="mo-prop-label">${p.label}</span><div class="mo-prop-field">
        <${ParamField} p=${p} value=${params[p.key]} onCommit=${(v) => setParam(p.key, v, p.label)} /></div></div>`)}
    </${Group}>` : null}
    ${code.vars.length ? html`<${Group} title=${`CSS variables (${code.vars.length})`}>
      ${code.vars.map((v) => {
        const val = draft.vars?.[v.name] ?? v.value;
        const isColor = /^#([0-9a-f]{3,8})$/i.test(String(val).trim());
        return html`<div class=${`mo-prop ${draft.vars?.[v.name] != null ? 'is-set' : ''}`}><span class="mo-kf-sp"></span><span class="mo-prop-label" title=${v.name}>${v.name.slice(2)}</span><div class="mo-prop-field">
          ${isColor ? html`<${ColorField} value=${val} onEnd=${(x) => setSection('vars', v.name, x, v.name)} />` : html`<${TextField} value=${String(val)} onCommit=${(x) => setSection('vars', v.name, x, v.name)} />`}</div>
          ${draft.vars?.[v.name] != null ? html`<button class="mo-reset" title="Reset" onClick=${() => setSection('vars', v.name, null, `Reset ${v.name}`)}><${Icon} name="refresh" size=${11} /></button>` : null}</div>`;
      })}
    </${Group}>` : null}
    ${code.consts.length ? html`<${Group} title=${`Values in the code (${top.length})`}>
      <div class="mo-note">Numbers, colours and lists Claude set at the top of its script: timings (often in frames), sizes, colours. Change one and the page runs with it.</div>
      ${top.map((c) => html`<${ConstRow} c=${c} draft=${draft} setSection=${setSection} />`)}
      ${inner.length ? html`<${Group} title=${`Inside functions (${inner.length})`} open=${false}>${inner.map((c) => html`<${ConstRow} c=${c} draft=${draft} setSection=${setSection} />`)}</${Group}>` : null}
    </${Group}>` : null}
    ${anims.length ? html`<${Group} title=${`Animations (${anims.length})`}>
      <div class="mo-note">CSS, Web and GSAP animations the page creates: change when each starts and how long it takes.</div>
      ${anims.slice(0, 200).map((a) => {
        const w = draft.anims?.[a.key] || {};
        const o = a.orig || a;
        const set = (patch, label) => setSection('anims', a.key, { ...w, ...patch }, label);
        return html`<div class=${`mo-anim ${draft.anims?.[a.key] ? 'is-set' : ''}`}>
          <div class="mo-anim-name" title=${a.key}><span class="pill">${a.kind}</span>${a.name}${a.target ? html`<span class="muted"> · ${a.target}</span>` : null}</div>
          <div class="mo-anim-fields">
            <${NumField} value=${w.delay ?? o.delay} step=${0.02} precision=${2} unit="s" title="Starts at" onEnd=${(v) => set({ delay: v }, 'Animation start')} />
            <${NumField} value=${w.duration ?? o.duration} min=${0.01} step=${0.02} precision=${2} unit="s" title="Length" onEnd=${(v) => set({ duration: v }, 'Animation length')} />
            ${draft.anims?.[a.key] ? html`<button class="mo-reset" title="Reset" onClick=${() => setSection('anims', a.key, null, 'Reset animation')}><${Icon} name="refresh" size=${11} /></button>` : null}
          </div></div>`;
      })}
    </${Group}>` : null}
    ${!schema.length && !code.vars.length && !code.consts.length && !anims.length ? html`<div class="mo-note">This graphic has no parameters or simple values to show. Click anything in the frame to adjust it, or add your own layers.</div>` : null}
  </div>`;
}

function ConstRow({ c, draft, setSection }) {
  const val = draft.consts?.[c.key] ?? c.value;
  const set = (x) => setSection('consts', c.key, x === c.value ? null : x, c.name);
  let field;
  if (c.kind === 'number') field = html`<${NumField} value=${Number(val)} step=${Math.abs(Number(c.value)) < 2 && String(c.value).includes('.') ? 0.01 : 1} precision=${String(val).includes('.') ? 2 : 0} onEnd=${(v) => set(String(v))} />`;
  else if (c.kind === 'color') field = html`<${ColorField} value=${String(val).slice(1, -1)} onEnd=${(x) => set(`'${x}'`)} />`;
  else if (c.kind === 'boolean') field = html`<${Toggle} checked=${String(val) === 'true'} onChange=${(x) => set(String(!!x))} />`;
  else if (c.kind === 'string') field = html`<${TextField} value=${String(val).slice(1, -1)} onCommit=${(x) => set(JSON.stringify(x))} />`;
  else field = html`<${TextField} value=${String(val)} onCommit=${set} />`;
  return html`<div class=${`mo-prop mo-const ${draft.consts?.[c.key] != null ? 'is-set' : ''}`} title=${c.label || c.name}>
    <span class="mo-kf-sp"></span>
    <span class="mo-prop-label"><code>${c.key}</code>${c.label ? html`<small>${c.label}</small>` : null}</span>
    <div class="mo-prop-field">${field}</div>
    ${draft.consts?.[c.key] != null ? html`<button class="mo-reset" title="Back to Claude's value" onClick=${() => setSection('consts', c.key, null, `Reset ${c.name}`)}><${Icon} name="refresh" size=${11} /></button>` : null}
  </div>`;
}

// ------------------------------------------------------------------ bottom: keyframe timeline

function KeyTimeline({ height, draft, layers, t, dur, fps, seek, sel, setSel, selKey, setSelKey, live, commit, dragging, draftRef, ownerSel, deleteKey }) {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const ro = new ResizeObserver(() => setW(ref.current?.clientWidth || 600));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const LABEL = 190;
  const span = Math.max(50, w - LABEL - 12);
  const X = (s) => LABEL + (s / dur) * span;
  const T = (px) => Math.max(0, Math.min(dur, Math.round((((px - LABEL) / span) * dur) * fps) / fps));

  // rows: every added layer (its bar), then every layer with keyframes and its animated properties
  const rows = [];
  const labelFor = (s) => layers.find((l) => l.sel === s)?.name || 'Layer';
  for (const L of [...(draft.added || [])].reverse()) {
    rows.push({ kind: 'layer', owner: `+${L.id}`, name: L.name, added: L });
    for (const [p, v] of Object.entries(L.props || {})) if (isKeyed(v)) rows.push({ kind: 'prop', owner: `+${L.id}`, prop: p, v });
  }
  for (const [s, L] of Object.entries(draft.layers || {})) {
    if (L.removed) continue;
    const keyed = Object.entries(L.props || {}).filter(([, v]) => isKeyed(v));
    if (!keyed.length && sel?.sel !== s) continue;
    rows.push({ kind: 'layer', owner: s, name: labelFor(s) });
    for (const [p, v] of keyed) rows.push({ kind: 'prop', owner: s, prop: p, v });
  }

  const scrub = (e) => {
    if (e.button !== 0) return;
    const r = ref.current.getBoundingClientRect();
    seek(T(e.clientX - r.left));
    const move = (ev) => seek(T(ev.clientX - r.left));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // drag a keyframe in time
  const dragKey = (e, row, i) => {
    e.stopPropagation();
    if (e.button === 2) return;
    const r = ref.current.getBoundingClientRect();
    setSelKey({ owner: row.owner, prop: row.prop, i });
    setSel(ownerSel(row.owner));
    const start = clone(draftRef.current);
    const t0 = row.v.k[i][0];
    let moved = false;
    const x0 = e.clientX;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      dragging.current = true;
      const nt = T(ev.clientX - r.left);
      const next = clone(start);
      const P = propsOf(next, ownerSel(row.owner), true);
      const k = P[row.prop].k;
      const key = k[i];
      key[0] = nt;
      k.splice(i, 1);
      const j = k.findIndex((x) => Math.abs(x[0] - nt) < 1e-4);
      if (j >= 0) k.splice(j, 1); // dropping onto another key replaces it
      k.push(key);
      k.sort((a, b) => a[0] - b[0]);
      live(next);
      setSelKey({ owner: row.owner, prop: row.prop, i: k.indexOf(key) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) commit('Move keyframe', draftRef.current); else seek(t0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const keyMenu = (e, row, i) => {
    e.preventDefault();
    e.stopPropagation();
    const cur = row.v.k[i][2] || 'linear';
    const setEase = (ease) => commit('Keyframe easing', mapProps(draftRef.current, ownerSel(row.owner), (P) => { if (isKeyed(P[row.prop])) P[row.prop].k[i][2] = ease; }));
    openMenu(e.clientX, e.clientY, [
      ...EASES.map(([v, label]) => ({ label: `${label}${i === row.v.k.length - 1 ? '' : ' → next key'}`, checked: cur === v, action: () => setEase(v) })),
      { separator: true },
      { label: 'Delete keyframe', icon: 'trash', action: () => deleteKey({ owner: row.owner, prop: row.prop, i }) },
    ]);
  };
  // drag an added layer's bar (middle: move, ends: trim)
  const dragBar = (e, L, part) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setSel({ added: L.id });
    const r = ref.current.getBoundingClientRect();
    const s0 = Number(L.start) || 0, e0 = L.end ?? dur;
    const tStart = T(e.clientX - r.left);
    let moved = false;
    const move = (ev) => {
      const d = T(ev.clientX - r.left) - tStart;
      if (!moved && Math.abs(d) < 1 / fps) return;
      moved = true;
      dragging.current = true;
      const next = clone(draftRef.current);
      const M = next.added.find((x) => x.id === L.id);
      if (part === 'l') M.start = Math.max(0, Math.min(e0 - 1 / fps, s0 + d));
      else if (part === 'r') M.end = Math.min(dur, Math.max(s0 + 1 / fps, e0 + d));
      else { const len = e0 - s0; M.start = Math.max(0, Math.min(dur - len, s0 + d)); M.end = M.start + len; }
      live(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) commit('Layer timing', draftRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ticks = [];
  const stepS = dur > 30 ? 5 : dur > 10 ? 1 : dur > 4 ? 0.5 : 0.25;
  for (let s = 0; s <= dur + 1e-6; s += stepS) ticks.push(s);
  return html`<div class="mo-tl" ref=${ref} style=${{ height: `${height}px` }}>
    <div class="mo-tl-ruler" onPointerDown=${scrub}>
      <div class="mo-tl-corner">Keyframes</div>
      ${ticks.map((s) => html`<span class="mo-tick" style=${{ left: `${X(s)}px` }}>${s % 1 === 0 ? `${s}s` : ''}</span>`)}
    </div>
    <div class="mo-tl-rows" onPointerDown=${scrub}>
      ${rows.length ? rows.map((row) => {
        const on = (row.owner.startsWith('+') ? sel?.added === row.owner.slice(1) : sel?.sel === row.owner);
        if (row.kind === 'layer') {
          return html`<div class=${`mo-tl-row is-layer ${on ? 'is-on' : ''}`}>
            <div class="mo-tl-label" onPointerDown=${(e) => { e.stopPropagation(); setSel(ownerSel(row.owner)); }}>${row.name}</div>
            ${row.added ? html`<div class="mo-tl-bar" style=${{ left: `${X(Number(row.added.start) || 0)}px`, width: `${Math.max(4, X(row.added.end ?? dur) - X(Number(row.added.start) || 0))}px` }}
              onPointerDown=${(e) => dragBar(e, row.added, 'm')}>
              <i class="mo-tl-trim is-l" onPointerDown=${(e) => dragBar(e, row.added, 'l')}></i><i class="mo-tl-trim is-r" onPointerDown=${(e) => dragBar(e, row.added, 'r')}></i></div>` : null}
          </div>`;
        }
        return html`<div class=${`mo-tl-row ${on ? 'is-on' : ''}`}>
          <div class="mo-tl-label is-prop">${PROP_LABEL[row.prop] || row.prop}</div>
          ${row.v.k.map((key, i) => html`<button class=${`mo-diamond ${selKey && selKey.owner === row.owner && selKey.prop === row.prop && selKey.i === i ? 'is-sel' : ''} is-${key[2] || 'linear'}`}
            style=${{ left: `${X(key[0])}px` }} title=${`${key[0].toFixed(2)}s · ${String(key[1]).slice(0, 30)} · ${key[2] || 'linear'} (right-click for easing)`}
            onPointerDown=${(e) => dragKey(e, row, i)} onContextMenu=${(e) => keyMenu(e, row, i)}></button>`)}
        </div>`;
      }) : html`<div class="mo-tl-empty">Select a layer and click the clock next to a property to animate it. Its keyframes show here.</div>`}
      <div class="mo-tl-head" style=${{ left: `${X(t)}px` }}></div>
    </div>
  </div>`;
}
