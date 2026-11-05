// Motion graphics in the editor: creating them, their Inspector section (params, status, live preview)
// and bin actions. The rendering itself happens on the server (server/motion.js).
import { html, Modal, Button, Icon, NumField, ColorField, Select, Toggle, Segmented } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { uid } from '../core/model.js';
import { OFFLINE, layerGeometry } from '../core/compositor.js';
import { post } from '../core/api.js';
import { openDialog, notify } from '../core/notify.js';
import { pickPath } from './dialogs.js';

const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function motionPageUrl(projectId, src, cfg) {
  return `/motion/${projectId}/${String(src).split('/').map(encodeURIComponent).join('/')}?cfg=${b64url(JSON.stringify(cfg))}`;
}
export const isMotion = (m) => !!m?.motion?.src;

// ------------------------------------------------------------------ actions

export const motionActions = {
  openCode: (tab, media) => post(`/api/p/${tab.projectId}/open-source`, { path: media.motion.src }).catch((e) => notify(e.message, 'error')),
  reveal: (tab, media) => post(`/api/p/${tab.projectId}/reveal`, { path: media.motion.src }),
  // to the front of the render stack, pausing a running graphic if needed
  renderNow: (tab, media) => post('/api/motion/stack/rush', { key: `${tab.projectId}:${media.id}` }).then(() => notify(`Rendering ${media.name} next`)).catch((e) => notify(e.message, 'error')),
  rerender: (tab, media) => post(`/api/p/${tab.projectId}/motion/${media.id}/render`, { force: true }).then(() => notify(`Re-rendering ${media.name}`)).catch((e) => notify(e.message, 'error')),
  // a separate copy (own params) for the given clips — e.g. a second lower third with another name
  makeUnique(tab, media, clipIds) {
    const id = uid('m');
    tab.apply('Make motion graphic unique', (d, ds) => {
      const m = d.media.find((x) => x.id === media.id);
      if (!m) return false;
      const copy = JSON.parse(JSON.stringify(m));
      copy.id = id;
      copy.name = `${m.name} copy`;
      copy.motion.params = { ...(m.motion.params || {}) };
      d.media.push(copy);
      for (const c of ds.clips) if (clipIds.includes(c.id) && c.media === media.id) c.media = id;
      return undefined;
    });
    return id;
  },
};

// ------------------------------------------------------------------ new motion graphic

export function NewMotionDialog({ close, tab, folder = null, file = null, name = '' }) {
  const seq = tab.seq;
  const [source, setSource] = useState(file ? 'file' : 'starter');
  const [title, setTitle] = useState(name || 'Motion graphic');
  const [duration, setDuration] = useState(5);
  const [place, setPlace] = useState(!!seq);
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    const r = await pickPath({ title: 'Choose an HTML composition', mode: 'file', exts: ['html', 'htm'], startPath: tab.store.get().dir, okLabel: 'Use this file' });
    const picked = r?.path || file;
    const base = picked ? picked.split(/[\\/]/).pop().replace(/\.html?$/i, '') : '';
    openDialog(NewMotionDialog, { tab, folder, file: picked, name: title === 'Motion graphic' && base ? base : title });
  };
  const create = async () => {
    setBusy(true);
    try {
      const body = {
        name: title.trim() || 'Motion graphic', folder,
        ...(source === 'starter' ? { starter: true, duration } : { src: file }),
        ...(seq ? { width: seq.width, height: seq.height, fps: seq.fps } : {}),
        ...(place && seq ? { place: { sequenceId: seq.id, start: tab.time.get().t } } : {}),
      };
      const r = await post(`/api/p/${tab.projectId}/motion`, body);
      tab.ui.set({ binSelection: [r.id], ...(r.clipId ? { selection: [r.clipId] } : {}) });
      notify(`${body.name}: rendering…`, 'info');
      close(r);
    } catch (err) {
      notify(err.message, 'error');
      setBusy(false);
    }
  };
  return html`<${Modal} title="New motion graphic" onClose=${() => close(null)} width=${480}
    footer=${html`<div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}>
      <${Button} kind="primary" icon="sparkle" disabled=${busy || (source === 'file' && !file)} onClick=${create}>Create</${Button}>`}>
    <div class="form">
      <label class="field"><span>Name</span><input class="input" value=${title} onInput=${(e) => setTitle(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} /></label>
      <div class="field"><span>Start from</span><${Segmented} value=${source} onChange=${setSource}
        options=${[{ value: 'starter', label: 'Lower-third starter' }, { value: 'file', label: 'An HTML file' }]} /></div>
      ${source === 'file' ? html`<div class="field"><span>Composition</span><div class="field-row" style=${{ gap: '6px' }}>
        <input class="input" readonly value=${file || ''} placeholder="Choose an .html file" />
        <${Button} icon="folder" onClick=${browse}>Browse…</${Button}></div></div>` : html`<label class="field"><span>Duration</span>
        <${NumField} value=${duration} min=${0.5} max=${600} step=${0.5} precision=${1} unit="s" onChange=${setDuration} /></label>`}
      ${seq ? html`<${Toggle} checked=${place} onChange=${setPlace} label=${`Place on the timeline at the playhead (${seq.name})`} />` : null}
      <div class="dialog-hint">
        A motion graphic is a web page (HTML, CSS, JavaScript — GSAP, canvas, Lottie…) rendered frame by frame into a
        transparent video, ${seq ? `${seq.width}×${seq.height} at ${seq.fps} fps` : 'at the sequence size'}. The source file stays in the
        project, so you or Claude can change it any time and it re-renders by itself. Files outside the project are copied in.
      </div>
    </div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ inspector

export function ParamField({ p, value, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (p.type === 'color') return html`<${ColorField} value=${draft} onChange=${setDraft} onEnd=${(v) => onCommit(v ?? draft)} />`;
  if (p.type === 'number') return html`<${NumField} value=${Number(draft) || 0} step=${p.step || 1} min=${p.min ?? -Infinity} max=${p.max ?? Infinity} precision=${p.step && p.step < 1 ? 2 : 0}
    onChange=${setDraft} onEnd=${(v) => onCommit(Number(v ?? draft))} />`;
  if (p.type === 'boolean') return html`<${Toggle} checked=${!!value} onChange=${(v) => onCommit(v)} />`;
  if (p.type === 'select') return html`<${Select} class="select-sm" value=${String(value)} options=${(p.options || []).map((o) => (typeof o === 'object' ? { value: String(o.value), label: o.label || String(o.value) } : { value: String(o), label: String(o) }))} onChange=${onCommit} />`;
  const commit = (e) => { const v = e.target.value; setDraft(v); if (v !== value) onCommit(v); };
  const keys = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !(p.multiline && e.shiftKey)) { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.value = value ?? ''; setDraft(value); e.target.blur(); } };
  return p.multiline
    ? html`<textarea class="text-input" rows="2" value=${draft ?? ''} onInput=${(e) => setDraft(e.target.value)} onBlur=${commit} onKeyDown=${keys}></textarea>`
    : html`<input class="input input-sm" value=${draft ?? ''} onInput=${(e) => setDraft(e.target.value)} onBlur=${commit} onKeyDown=${keys} />`;
}

// Live preview of the composition at the playhead (before/while the video renders). The page runs in a
// sandboxed frame with no access to the editor.
function LivePreview({ tab, clip, media, params, spec }) {
  const wrap = useRef(null);
  const frame = useRef(null);
  const [w, setW] = useState(260);
  const [err, setErr] = useState(null);
  const t = useStore(tab.time, (s) => s.t);
  useEffect(() => {
    const ro = new ResizeObserver(() => setW(wrap.current?.clientWidth || 260));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const url = motionPageUrl(tab.projectId, media.motion.src, { mode: 'preview', params, ...spec });
  const local = Math.max(0, Math.min(spec.duration, (clip.in || 0) + (t - clip.start) * (clip.speed || 1)));
  const send = () => frame.current?.contentWindow?.postMessage({ type: 'motion-seek', t: local }, '*');
  useEffect(send, [local]);
  useEffect(() => {
    setErr(null);
    const on = (e) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'motion-ready') send();
      if (e.data?.type === 'motion-error') setErr(e.data.message);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [url]);
  const k = w / spec.width;
  return html`<div class="motion-preview" ref=${wrap} style=${{ height: `${Math.round(spec.height * k)}px` }}>
    <iframe ref=${frame} key=${url} src=${url} sandbox="allow-scripts" title="Motion graphic preview" tabIndex="-1"
      style=${{ width: `${spec.width}px`, height: `${spec.height}px`, transform: `scale(${k})` }}></iframe>
    ${err ? html`<div class="motion-preview-err" title=${err}>${err}</div>` : null}
  </div>`;
}

function LengthField({ value, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return html`<${NumField} value=${draft} min=${0.1} max=${600} step=${0.1} precision=${2} unit="s" onChange=${setDraft} onEnd=${(v) => onCommit(v ?? draft)} />`;
}

export function MotionSection({ tab, clip, Section, Row }) {
  const media = tab.mediaById[clip.media];
  const st = useStore(tab.store, (s) => s.mediaStatus[clip.media]?.motion) || {};
  const [preview, setPreview] = useState(true);
  const [showLogs, setShowLogs] = useState(false);
  if (!isMotion(media)) return null;
  const schema = st.schema || [];
  const params = { ...(st.params || {}), ...(media.motion.params || {}) };
  const spec = st.spec || { width: media.width || 1920, height: media.height || 1080, fps: media.fps || 30, duration: media.motion.duration || media.duration || 5 };
  const uses = tab.doc.sequences.reduce((n, s) => n + s.clips.filter((c) => c.media === media.id).length, 0);
  const setParam = (key, v, label) => tab.apply(`Motion: ${label}`, (d) => {
    const m = d.media.find((x) => x.id === media.id);
    if (!m || m.motion.params?.[key] === v) return false;
    m.motion = { ...m.motion, params: { ...(m.motion.params || {}), [key]: v } };
    return undefined;
  });
  const setSpec = (key, v, label) => tab.apply(`Motion: ${label}`, (d) => {
    const m = d.media.find((x) => x.id === media.id);
    if (!m || m.motion[key] === v) return false;
    m.motion = { ...m.motion, [key]: v };
    return undefined;
  });
  const state = st.state || 'queued';
  const badge = state === 'rendering' ? `Rendering ${Math.round((st.progress || 0) * 100)}%` : state === 'queued' ? (st.held ? `Paused by you${st.progress ? ` at ${Math.round(st.progress * 100)}%` : ''}` : st.paused ? `Paused at ${Math.round((st.progress || 0) * 100)}%` : 'Waiting to render') : state === 'error' ? 'Render failed' : 'Rendered';
  const logs = st.logs || [];
  return html`<${Section} title="Motion graphic" icon="sparkle" actions=${html`
    <button class="chip" title="Adjust every part of this graphic in the Motion tab" onClick=${() => { tab.engine.pause(); tab.ui.set({ mode: 'motion', motionMedia: media.id }); }}><${Icon} name="wand" size=${12} /> Motion tab</button>
    <button class="chip" title="Open the composition's HTML in a code editor" onClick=${() => motionActions.openCode(tab, media)}><${Icon} name="code" size=${12} /> Code</button>
    <button class="chip" title="Render again (e.g. after an online asset changed)" onClick=${() => motionActions.rerender(tab, media)}><${Icon} name="refresh" size=${12} /></button>`}>
    <div class="motion-status is-${state}">
      ${state === 'rendering' || state === 'queued' ? html`<span class="spinner spinner-xs"></span>` : html`<${Icon} name=${state === 'error' ? 'alert' : 'checkCircle'} size=${13} />`}
      <span>${badge}</span>
      <span class="motion-src" title=${media.motion.src}>${media.motion.src.split('/').pop()}</span>
      ${state === 'queued' ? html`<button class="link-btn" title="Render this one next, pausing a running graphic if needed" onClick=${() => motionActions.renderNow(tab, media)}>Render now</button>` : null}
    </div>
    ${state === 'rendering' ? html`<div class="progress"><div style=${{ width: `${Math.round((st.progress || 0) * 100)}%` }}></div></div>` : null}
    ${st.error ? html`<div class="error-box">${st.error}</div>` : null}
    ${st.configError ? html`<div class="error-box">${st.configError}</div>` : null}
    ${logs.length ? html`<button class="link-btn" onClick=${() => setShowLogs(!showLogs)}>${showLogs ? 'Hide' : 'Show'} ${logs.length} page message${logs.length > 1 ? 's' : ''}</button>
      ${showLogs ? html`<pre class="motion-logs">${logs.join('\n')}</pre>` : null}` : null}
    ${preview ? html`<${LivePreview} tab=${tab} clip=${clip} media=${media} params=${params} spec=${spec} />` : null}
    <${Row} label="Preview"><${Toggle} checked=${preview} onChange=${setPreview} label="Live at playhead" /></${Row}>
    ${schema.length ? schema.map((p) => html`<${Row} label=${p.label}><${ParamField} p=${p} value=${params[p.key]} onCommit=${(v) => setParam(p.key, v, p.label)} /></${Row}>`)
      : html`<div class="insp-note">This composition declares no editable parameters. Add a <code>&lt;script type="application/json" id="motion"&gt;</code> block with <code>"params"</code> to get fields here.</div>`}
    <${Row} label="Length"><${LengthField} value=${spec.duration} onCommit=${(v) => setSpec('duration', v, 'Length')} /></${Row}>
    <div class="insp-note">${spec.width}×${spec.height} · ${spec.fps} fps · transparent. Parameter changes re-render automatically${uses > 1 ? ` and affect all ${uses} clips using it` : ''}.</div>
    <div class="tr-row">
      ${Object.keys(media.motion.params || {}).length ? html`<button class="chip" onClick=${() => tab.apply('Motion: reset parameters', (d) => { const m = d.media.find((x) => x.id === media.id); if (!m) return false; m.motion = { ...m.motion }; delete m.motion.params; return undefined; })}>Reset to defaults</button>` : null}
      ${uses > 1 ? html`<button class="chip" title="Give the selected clip its own copy with separate parameters" onClick=${() => motionActions.makeUnique(tab, media, tab.ui.get().selection)}>Make unique</button>` : null}
    </div>
  </${Section}>`;
}

// ------------------------------------------------------------------ live graphics in the viewer

// A motion graphic that hasn't rendered yet plays live in the viewer: its page runs in a frame laid over the
// clip's place in the picture, seeked to the playhead. It sits on top of the other layers and heavy pages
// drop frames, so it's a rough preview; the rendered file takes over as soon as it's ready.
export function LiveMotionLayers({ tab, z }) {
  const [list, setList] = useState([]); // [{ id, url, w, h }]
  const els = useRef(new Map()); // clip id -> { el, ready, sent }
  const zRef = useRef(z);
  zRef.current = z;
  useEffect(() => {
    let raf = 0, key = '', timer = 0;
    // every frame while playing; otherwise only when the playhead or the project changes (and a few times a second)
    const wake = () => { if (timer) { clearTimeout(timer); timer = 0; } if (!raf) raf = requestAnimationFrame(loop); };
    const offs = [tab.time.subscribe(wake), tab.store.subscribe(wake)];
    const loop = () => {
      raf = 0;
      if (tab.engine.playing) raf = requestAnimationFrame(loop);
      else if (!timer) timer = setTimeout(() => { timer = 0; if (!raf) raf = requestAnimationFrame(loop); }, 250);
      const eng = tab.engine, seq = tab.seq;
      const live = [];
      // one page at most, and none while the window is hidden: each runs inside the editor's own process, and a
      // heavy composition playing live slows every click (and can take the page's memory)
      if (seq && !document.hidden) {
        for (const tr of eng.frame || []) for (const l of tr.layers) {
          const m = tab.mediaById[l.clip.media];
          if (live.length || !isMotion(m) || eng.getSource(l) !== OFFLINE) continue;
          const st = tab.store.get().mediaStatus[m.id]?.motion || {};
          const spec = st.spec || { width: m.width || seq.width, height: m.height || seq.height, fps: m.fps || 30, duration: m.motion.duration || m.duration || 5 };
          const url = motionPageUrl(tab.projectId, m.motion.src, { mode: 'preview', params: { ...(st.params || {}), ...(m.motion.params || {}) }, ...spec });
          live.push({ l, id: l.clip.id, url, w: spec.width, h: spec.height, dur: spec.duration });
        }
      }
      const k = live.map((x) => `${x.id}|${x.url}`).join('\n');
      if (k !== key) {
        key = k;
        for (const id of els.current.keys()) if (!live.some((x) => x.id === id)) els.current.delete(id);
        setList(live.map(({ id, url, w, h }) => ({ id, url, w, h })));
      }
      for (const x of live) {
        const e = els.current.get(x.id);
        if (!e?.el) continue;
        const c = x.l.clip, g = layerGeometry(x.l, tab.mediaById, seq), zz = zRef.current;
        const sx = g.scale * (c.transform?.flipH ? -1 : 1) * (g.w / x.w), sy = g.scale * (c.transform?.flipV ? -1 : 1) * (g.h / x.h);
        e.el.style.transform = `translate(${g.cx * zz}px, ${g.cy * zz}px) rotate(${g.rotation}deg) scale(${sx * zz}, ${sy * zz}) translate(-50%, -50%)`;
        e.el.style.opacity = String(Math.max(0, Math.min(1, g.transform.opacity * (x.l.alpha ?? 1))));
        const local = Math.max(0, Math.min(x.dur, (c.in || 0) + (eng.t - c.start) * (c.speed || 1)));
        if (e.ready && Math.abs(local - (e.sent ?? -1)) > 1e-4) { e.sent = local; e.el.contentWindow?.postMessage({ type: 'motion-seek', t: local }, '*'); }
      }
    };
    const onMsg = (e) => {
      if (e.data?.type !== 'motion-ready') return;
      for (const x of els.current.values()) if (x.el?.contentWindow === e.source) { x.ready = true; x.sent = null; }
      wake();
    };
    window.addEventListener('message', onMsg);
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); offs.forEach((f) => f()); window.removeEventListener('message', onMsg); };
  }, [tab]);
  const bind = (id) => (el) => {
    if (el && els.current.get(id)?.el !== el) els.current.set(id, { el, ready: false, sent: null });
  };
  if (!list.length) return null;
  return html`<div class="live-motion">
    ${list.map((x) => html`<iframe key=${`${x.id}|${x.url}`} ref=${bind(x.id)} src=${x.url} sandbox="allow-scripts" title="Live motion graphic" tabIndex="-1"
      style=${{ width: `${x.w}px`, height: `${x.h}px` }}></iframe>`)}
    <span class="live-motion-badge" title="This graphic is still rendering: it plays live here (rough, always on top) until the render is ready">Live graphic · rendering</span>
  </div>`;
}
