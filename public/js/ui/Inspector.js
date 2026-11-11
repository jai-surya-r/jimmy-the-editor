// Inspector: properties of the selected clip (or the sequence when nothing is selected).
import { html, Icon, IconButton, NumField, ColorField, Select, Segmented, Button } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import {
  isVisualClip, propAt, isAnimated, timecode, parseTime, TRANSITIONS, BLEND_MODES, EASINGS, clamp, snapTime, isBezierSeg,
  usesSourceTime, maxDurationFor, FRAME_RATES, DEFAULT_EFFECTS, deepClone,
} from '../core/model.js';
import { setPropAt, toggleAnimation, keyframeAt, removeKeyframeAt, upsertKeyframe, fitClip, linkedIds, clipLabel, retimeClips } from '../core/ops.js';
import { GOOGLE_FONTS, SYSTEM_FONTS, prepareFont } from '../core/fonts.js';
import { get, post } from '../core/api.js';
import { openDialog } from '../core/notify.js';
import { pickPath } from './dialogs.js';
import { openSpeedDialog } from './speed.js';
import { lutState, loadLut, forgetLut, onLutLoaded } from '../core/lut.js';
import { MotionSection, isMotion } from './motion.js';

const TYPE_LABEL = { video: 'Video clip', audio: 'Audio clip', image: 'Image', text: 'Text', solid: 'Color matte' };
const TYPE_ICON = { video: 'film', audio: 'music', image: 'image', text: 'text', solid: 'square' };

export function Inspector({ tab }) {
  const doc = useStore(tab.store, (s) => s.doc);
  const warnings = useStore(tab.store, (s) => s.warnings);
  const fonts = useStore(tab.store, (s) => s.fonts);
  const selection = useStore(tab.ui, (s) => s.selection);
  const focusClip = useStore(tab.ui, (s) => s.focusClip);
  useStore(tab.ui, (s) => s.sequenceId);
  const seq = doc ? tab.seq : null;
  const clips = seq ? selection.map((id) => seq.clips.find((c) => c.id === id)).filter(Boolean) : [];
  const primary = clips.find((c) => c.id === focusClip) || clips.find(isVisualClip) || clips[0] || null;
  const fps = seq?.fps || 30;
  const animatedAny = clips.some((c) => Object.keys(c.keyframes || {}).length > 0);
  // Re-render every frame while something shown is animated; otherwise every 16 frames, and when the playhead
  // enters or leaves the clip (the stopwatches are only enabled inside it).
  useStore(tab.time, (s) => {
    if (!primary) return 0;
    const f = Math.round(s.t * fps);
    return animatedAny ? f : `${f >> 4}:${s.t >= primary.start - 1e-6 && s.t <= primary.start + primary.duration + 1e-6}`;
  });

  if (!seq) return html`<aside class="panel inspector"><header class="panel-head"><span class="panel-title">Inspector</span></header></aside>`;
  if (!primary) return html`<aside class="panel inspector">
    <header class="panel-head"><span class="panel-title">Inspector</span></header>
    <div class="insp-scroll"><${SequenceProps} tab=${tab} seq=${seq} warnings=${warnings} /></div>
  </aside>`;

  const partner = primary.type !== 'audio' && primary.link ? clips.find((c) => c.type === 'audio' && c.link === primary.link) : null;
  // Multi-selection: every edit applies to all selected (unlocked) clips the property makes sense for.
  const lockedTracks = new Set(seq.tracks.filter((t) => t.locked).map((t) => t.id));
  const editable = clips.filter((c) => !lockedTracks.has(c.track));
  const idsOf = (pred, fallback) => { const l = editable.filter(pred).map((c) => c.id); return l.length ? l : [fallback.id]; };
  const kindIds = {
    all: idsOf(() => true, primary),
    visual: idsOf(isVisualClip, primary),
    media: idsOf((c) => c.type === 'video' || c.type === 'image', primary),
    text: idsOf((c) => c.type === 'text', primary),
    solid: idsOf((c) => c.type === 'solid', primary),
    audio: idsOf((c) => c.type === 'audio', partner || primary),
  };
  const multi = editable.length > 1;
  const linkedPairs = clips.filter((c) => c.type === 'audio' && c.link && clips.some((v) => v.type !== 'audio' && v.link === c.link)).length;
  const ctx = { tab, seq, fps, clip: primary, localT: tab.time.get().t - primary.start, fonts, kindIds };

  return html`<aside class="panel inspector">
    <header class="panel-head">
      <span class="panel-title">Inspector</span>
      ${clips.length > 1 ? html`<span class="pill">${clips.length} selected</span>` : null}
    </header>
    <div class="insp-scroll">
      <${ClipHeader} ...${ctx} ids=${kindIds.all} />
      ${multi ? html`<div class="insp-note is-multi">Editing ${editable.length - linkedPairs} clip${editable.length - linkedPairs > 1 ? 's' : ''}${linkedPairs ? ` (+${linkedPairs} linked audio)` : ''} — values shown are from <b>${clipLabel(primary, tab.mediaById)}</b>; every change applies to all selected clips it fits${clips.length > editable.length ? ' (locked tracks are skipped)' : ''}.</div>` : null}
      <${TimingSection} ...${ctx} ids=${kindIds.all} />
      ${primary.type === 'video' && isMotion(tab.mediaById[primary.media]) ? html`<${MotionSection} ...${ctx} Section=${Section} Row=${Row} />` : null}
      ${primary.type === 'text' ? html`<${TextSection} ...${ctx} ids=${kindIds.text} />` : null}
      ${primary.type === 'solid' ? html`<${SolidSection} ...${ctx} ids=${kindIds.solid} />` : null}
      ${primary.type === 'adjust' ? html`<${BelowSection} ...${ctx} ids=${kindIds.visual.filter((id) => tab.seq.clips.find((c) => c.id === id)?.type === 'adjust')} />` : null}
      ${isVisualClip(primary) ? html`<${TransformSection} ...${ctx} ids=${kindIds.visual} title=${primary.type === 'adjust' ? 'Layer (where it applies)' : 'Transform'} />` : null}
      ${isVisualClip(primary) ? html`<${TransitionSection} ...${ctx} ids=${kindIds.visual} />` : null}
      ${isVisualClip(primary) ? html`<${EffectsSection} ...${ctx} ids=${kindIds.visual} />` : null}
      ${primary.type === 'audio' ? html`<${AudioSection} ...${ctx} ids=${kindIds.audio} />` : null}
      ${partner ? html`<${AudioSection} ...${{ ...ctx, clip: partner, localT: tab.time.get().t - partner.start }} ids=${kindIds.audio} title="Linked audio" />` : null}
    </div>
  </aside>`;
}

// ------------------------------------------------------------------ helpers

// ids: one clip id or a list — the edit runs on every listed clip (multi-selection).
function editor(tab, ids, label) {
  const list = [].concat(ids);
  return {
    onStart: () => tab.begin(),
    change: (fn) => tab.preview((d, ds) => { for (const id of list) { const c = ds.clips.find((x) => x.id === id); if (c) fn(c, ds, d); } }),
    onEnd: () => tab.end(label),
  };
}
function commit(tab, ids, label, fn) {
  const list = [].concat(ids);
  tab.apply(label, (d, ds) => {
    let any = false;
    for (const id of list) { const c = ds.clips.find((x) => x.id === id); if (c && fn(c, ds, d) !== false) any = true; }
    return any ? undefined : false;
  });
}

function Section({ title, icon, children, actions, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`<section class="insp-section ${open ? '' : 'is-collapsed'}">
    <header class="insp-section-head" onClick=${() => setOpen(!open)}>
      <${Icon} name=${open ? 'down' : 'next'} size=${12} />
      ${icon ? html`<${Icon} name=${icon} size=${13} />` : null}
      <span>${title}</span>
      <div class="spacer"></div>
      <div onClick=${(e) => e.stopPropagation()} class="insp-section-actions">${actions}</div>
    </header>
    ${open ? html`<div class="insp-section-body">${children}</div>` : null}
  </section>`;
}

function Row({ label, children, kf }) {
  return html`<div class="prop-row">${kf || html`<span class="kf-slot"></span>`}<label class="prop-label">${label}</label><div class="prop-value">${children}</div></div>`;
}

// A numeric, keyframe-able property row. Left: stopwatch (animate on/off). Right: Premiere-style
// keyframe navigator — ◀ previous keyframe, ◆ add/remove a keyframe at the playhead, ▶ next keyframe.
// With several clips selected every action runs on each of them, at the playhead's time in that clip.
// pair: two properties shown as one (Position = X and Y, as in After Effects): one stopwatch and one keyframe
// for both, a field for each.
function PropRow({ tab, clip, ids, fps, localT, prop, pair, label, mult = 1, step = 1, precision = 1, unit = '', min = -Infinity, max = Infinity, format, parse }) {
  const P = pair || [prop];
  prop = P[0];
  const targets = ids || [clip.id];
  const T = clip.start + localT; // playhead (timeline time) when this was drawn
  // actions take the playhead as it is when they happen: a row without keyframes is not redrawn every frame
  const now = () => tab.time.get().t;
  const ltOf = (c, at = T) => snapTime(clamp(at - c.start, 0, c.duration), fps);
  const covers = (c, at = T) => at >= c.start - 1e-6 && at <= c.start + c.duration + 1e-6;
  const animated = P.some((p) => isAnimated(clip, p));
  const inRange = covers(clip);
  const lt = ltOf(clip);
  const v = propAt(clip, prop, lt);
  const kfOf = (p) => (isAnimated(clip, p) ? keyframeAt(clip, p, lt, fps) : null);
  const kf = animated ? P.map(kfOf).find(Boolean) || null : null;
  const kp = kf ? P.find((p) => kfOf(p) === kf) : prop; // the property whose keyframe kf is
  const ed = editor(tab, targets, `Change ${label.toLowerCase()}`);
  const times = animated ? [...new Set(P.flatMap((p) => (clip.keyframes[p] || []).map((k) => k.t)))].sort((a, b) => a - b) : [];
  const prev = times.filter((t) => t < lt - 1e-4).pop();
  const next = times.find((t) => t > lt + 1e-4);
  const nextKf = kf ? clip.keyframes[kp][clip.keyframes[kp].indexOf(kf) + 1] : null;
  const others = targets.length > 1 ? tab.seq.clips.filter((c) => targets.includes(c.id) && c.id !== clip.id) : [];
  const mixed = others.some((c) => P.some((p) => Math.abs(propAt(c, p, ltOf(c)) - propAt(clip, p, lt)) > 1e-6));
  const toggle = () => {
    const at = now();
    commit(tab, targets, animated ? `Stop animating ${label}` : `Animate ${label}`, (c) => {
      if (P.some((p) => isAnimated(c, p)) !== animated) return false;
      if (!animated && !covers(c, at)) return false;
      for (const p of P) if (isAnimated(c, p) === animated) toggleAnimation(c, p, ltOf(c, at));
      return undefined;
    });
  };
  const diamond = () => {
    const at = now();
    const on = animated && P.some((p) => !!keyframeAt(clip, p, ltOf(clip, at), fps));
    commit(tab, targets, on ? 'Remove keyframe' : 'Add keyframe', (c) => {
      if (!covers(c, at)) return false;
      const l = ltOf(c, at);
      if (on) { if (!P.some((p) => keyframeAt(c, p, l, fps))) return false; for (const p of P) if (keyframeAt(c, p, l, fps)) removeKeyframeAt(c, p, l, fps); }
      else for (const p of P) upsertKeyframe(c, p, l, propAt(c, p, l), fps);
      return undefined;
    });
  };
  return html`<div class="prop-row ${animated ? 'is-animated' : ''} ${mixed ? 'prop-mixed' : ''}">
    <button class="kf-toggle ${animated ? 'is-on' : ''}" title=${animated ? 'Toggle animation off (keeps the current value)' : 'Toggle animation (adds a keyframe at the playhead)'}
      disabled=${!inRange && !animated} onClick=${toggle}><${Icon} name="clock" size=${12} /></button>
    <label class="prop-label" title=${mixed ? `${label}: values differ between the selected clips` : label}>${label}</label>
    <div class="prop-value ${pair ? 'prop-pair' : ''}">
      <${NumField} value=${v * mult} step=${step} precision=${precision} unit=${unit} min=${min * mult} max=${max * mult} format=${format} parse=${parse}
        title=${mixed ? 'Values differ between the selected clips — typing sets them all' : undefined}
        onStart=${ed.onStart} onChange=${(x) => ed.change((c) => setPropAt(c, prop, x / mult, ltOf(c, now()), fps))} onEnd=${ed.onEnd} />
      ${pair ? P.slice(1).map((p) => html`<${NumField} key=${p} value=${propAt(clip, p, lt) * mult} step=${step} precision=${precision} unit=${unit}
        onStart=${ed.onStart} onChange=${(x) => ed.change((c) => setPropAt(c, p, x / mult, ltOf(c, now()), fps))} onEnd=${ed.onEnd} />`) : null}
    </div>
    <div class="kf-nav">
      <button title="Go to previous keyframe" disabled=${prev == null} onClick=${() => tab.engine.seek(clip.start + prev)}><${Icon} name="prev" size=${11} /></button>
      <button class="kf-here ${kf ? 'is-on' : ''}" title=${kf ? 'Remove keyframe' : 'Add keyframe at the playhead'} disabled=${!inRange} onClick=${diamond}>
        <${Icon} name="diamond" size=${10} /></button>
      <button title="Go to next keyframe" disabled=${next == null} onClick=${() => tab.engine.seek(clip.start + next)}><${Icon} name="next" size=${11} /></button>
    </div>
    ${kf && next != null ? html`<div class="prop-ease">
      <span>ease</span>
      <${Select} class="select-xs" value=${nextKf && isBezierSeg(kf, nextKf) ? 'custom' : kf.ease || 'linear'}
        options=${[...EASINGS, ...(nextKf && isBezierSeg(kf, nextKf) ? [{ value: 'custom', label: 'custom (graph)' }] : [])]}
        onChange=${(val) => {
          if (val === 'custom') { tab.ui.set({ graph: true }); return; }
          commit(tab, targets, 'Change easing', (c) => {
            let any = false;
            for (const p of P) {
              const list = c.keyframes?.[p] || [];
              const k = keyframeAt(c, p, ltOf(c), fps);
              if (!k) continue;
              any = true;
              k.ease = val;
              // a named ease replaces the graph handles of this segment
              delete k.out;
              const nk = list[list.indexOf(k) + 1];
              if (nk) delete nk.in;
            }
            return any ? undefined : false;
          });
        }} />
      <button class="kf-graph-btn" title="Open the graph editor" onClick=${() => tab.ui.set({ graph: true })}><${Icon} name="graph" size=${12} /></button>
    </div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ sections

function ClipHeader({ tab, clip, seq, ids }) {
  const label = clipLabel(clip, tab.mediaById, tab.doc);
  const media = clip.media ? tab.mediaById[clip.media] : null;
  return html`<div class="insp-clip-head">
    <div class="insp-clip-icon clip-${clip.type}"><${Icon} name=${isMotion(media) ? 'sparkle' : TYPE_ICON[clip.type]} size=${16} /></div>
    <div class="insp-clip-text">
      <input class="insp-clip-name" key=${`${clip.id}|${clip.name || ''}`} defaultValue=${clip.name || ''} placeholder=${label}
        onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }}
        onBlur=${(e) => { if ((e.target.value || '') !== (clip.name || '')) commit(tab, clip.id, 'Rename clip', (c) => { c.name = e.target.value.trim(); }); }} />
      <div class="insp-clip-sub">${isMotion(media) ? 'Motion graphic' : TYPE_LABEL[clip.type]}${media ? ` · ${media.width ? `${media.width}×${media.height}` : media.name}` : ''} · ${seq.tracks.find((t) => t.id === clip.track) ? clip.track.toUpperCase() : ''}</div>
    </div>
    <${IconButton} icon=${clip.enabled === false ? 'eyeOff' : 'eye'} title=${clip.enabled === false ? 'Enable clip' : 'Disable clip'}
      onClick=${() => commit(tab, ids, clip.enabled === false ? 'Enable clip' : 'Disable clip', (c) => { c.enabled = clip.enabled === false; })} />
  </div>`;
}

function TimingSection({ tab, clip, fps, ids }) {
  const media = clip.media ? tab.mediaById[clip.media] : null;
  const tcFmt = (v) => timecode(v, fps);
  const tcParse = (s) => parseTime(s, fps);
  const step = 1 / fps;
  // every selected clip plus its linked partners; ds comes from the gesture's starting document
  const group = (ds) => linkedIds(ds, ids);
  const gesture = (label, fn) => ({ onStart: () => tab.begin(), onChange: (v) => tab.preview((d, ds) => fn(v, ds, group(ds))), onEnd: () => tab.end(label) });
  const st = gesture('Move clip', (v, ds, set) => {
    const p = ds.clips.find((x) => x.id === clip.id);
    const dl = Math.max(snapTime(v, fps) - p.start, -Math.min(...ds.clips.filter((x) => set.has(x.id)).map((x) => x.start)));
    for (const x of ds.clips) if (set.has(x.id)) x.start = Math.max(0, x.start + dl);
  });
  const du = gesture('Change duration', (v, ds, set) => {
    const nd = Math.max(1 / fps, snapTime(v, fps));
    for (const x of ds.clips) if (set.has(x.id)) x.duration = Math.min(nd, maxDurationFor({ ...x, duration: 0 }, tab.mediaById[x.media]));
  });
  const ip = gesture('Slip clip', (v, ds, set) => {
    for (const x of ds.clips) if (set.has(x.id) && usesSourceTime(x)) {
      const m = tab.mediaById[x.media];
      x.in = clamp(v, 0, Math.max(0, (m?.duration || 1e9) - x.duration * (x.speed || 1)));
    }
  });
  const sp = gesture('Change speed', (v, ds, set) => {
    retimeClips(ds, new Set([...set].filter((id) => usesSourceTime(ds.clips.find((x) => x.id === id)))), { speed: v / 100, fps, mediaById: tab.mediaById });
  });
  const maxDur = maxDurationFor({ ...clip, duration: 0 }, media);
  return html`<${Section} title="Clip" icon="clock">
    <${Row} label="Start"><${NumField} value=${clip.start} step=${step} min=${0} format=${tcFmt} parse=${tcParse} ...${st} /></${Row}>
    <${Row} label="Duration"><${NumField} value=${clip.duration} step=${step} min=${1 / fps} max=${maxDur} format=${tcFmt} parse=${tcParse} ...${du} /></${Row}>
    ${usesSourceTime(clip) ? html`
      <${Row} label="Source in"><${NumField} value=${clip.in || 0} step=${step} min=${0} max=${Math.max(0, (media?.duration || 1e9) - clip.duration * (clip.speed || 1))} format=${tcFmt} parse=${tcParse} ...${ip} /></${Row}>
      <${Row} label="Speed">
        <div class="tr-row">
          <${NumField} value=${(clip.speed || 1) * 100} step=${1} precision=${1} unit="%" min=${5} max=${1600} ...${sp} />
          <button class="chip" title="Clip Speed / Duration… (Ctrl+R): set an exact speed or a target duration, with ripple" onClick=${() => openSpeedDialog(tab, ids)}>Speed / Duration…</button>
        </div>
      </${Row}>` : html`<${Row} label=""><button class="chip" title="Clip Speed / Duration… (Ctrl+R)" onClick=${() => openSpeedDialog(tab, ids)}>Duration…</button></${Row}>`}
    <${Row} label="End"><span class="ro">${timecode(clip.start + clip.duration, fps)}</span></${Row}>
  </${Section}>`;
}

// An adjustment layer's transform of everything below it: the zoom in / zoom out, move and turn (keyframeable)
function BelowSection(ctx) {
  const { tab, ids } = ctx;
  return html`<${Section} title="Layers below" icon="layers" actions=${html`
    <button class="chip" title="Back to no change" onClick=${() => commit(tab, ids, 'Reset layers below', (c) => { c.below = { x: 0, y: 0, scale: 1, rotation: 0 }; for (const p of ['belowX', 'belowY', 'belowScale', 'belowRotation']) if (c.keyframes) delete c.keyframes[p]; })}>Reset</button>`}>
    <${PropRow} ...${ctx} pair=${['belowX', 'belowY']} label="Position" step=${1} precision=${1} unit="px" />
    <${PropRow} ...${ctx} prop="belowScale" label="Scale" mult=${100} step=${0.5} precision=${1} unit="%" min=${0.01} />
    <${PropRow} ...${ctx} prop="belowRotation" label="Rotation" step=${0.5} precision=${1} unit="°" />
    <div class="insp-note">Moves, zooms and turns everything under this layer (its effects apply to it too). Below, "Layer" sets where it applies: the whole frame, or a smaller or moved area.</div>
  </${Section}>`;
}

function TransformSection(ctx) {
  const { tab, clip, seq, ids } = ctx;
  const media = clip.media ? tab.mediaById[clip.media] : null;
  const tr = clip.transform || {};
  return html`<${Section} title=${ctx.title || 'Transform'} icon="expand" actions=${html`
    ${media || clip.type === 'solid' ? html`<button class="chip" title="Fit inside the frame" onClick=${() => commit(tab, ids, 'Fit to frame', (c) => { if (c.type === 'text') return false; fitClip(c, tab.mediaById[c.media], seq, 'fit'); return undefined; })}>Fit</button>
    <button class="chip" title="Fill the frame (crops edges)" onClick=${() => commit(tab, ids, 'Fill frame', (c) => { if (c.type === 'text') return false; fitClip(c, tab.mediaById[c.media], seq, 'fill'); return undefined; })}>Fill</button>` : null}
    <button class="chip" title="Reset position, rotation and opacity" onClick=${() => commit(tab, ids, 'Reset transform', (c) => { c.transform = { ...c.transform, x: 0, y: 0, rotation: 0, opacity: 1 }; for (const p of ['x', 'y', 'rotation', 'opacity']) delete c.keyframes?.[p]; })}>Reset</button>`}>
    <${PropRow} ...${ctx} pair=${['x', 'y']} label="Position" step=${1} precision=${1} unit="px" />
    <${PropRow} ...${ctx} prop="scale" label="Scale" mult=${100} step=${0.5} precision=${1} unit="%" min=${0} />
    <${PropRow} ...${ctx} prop="rotation" label="Rotation" step=${0.5} precision=${1} unit="°" />
    <${PropRow} ...${ctx} prop="opacity" label="Opacity" mult=${100} step=${1} precision=${0} unit="%" min=${0} max=${1} />
    <${Row} label="Flip">
      <div class="btn-row">
        <button class="chip ${tr.flipH ? 'is-on' : ''}" onClick=${() => commit(tab, ids, 'Flip horizontal', (c) => { c.transform = { ...c.transform, flipH: !tr.flipH }; })}>Horizontal</button>
        <button class="chip ${tr.flipV ? 'is-on' : ''}" onClick=${() => commit(tab, ids, 'Flip vertical', (c) => { c.transform = { ...c.transform, flipV: !tr.flipV }; })}>Vertical</button>
      </div>
    </${Row}>
    ${clip.type !== 'text' ? html`
      <${PropRow} ...${ctx} prop="cropLeft" label="Crop left" mult=${100} step=${0.5} precision=${1} unit="%" min=${0} max=${0.95} />
      <${PropRow} ...${ctx} prop="cropTop" label="Crop top" mult=${100} step=${0.5} precision=${1} unit="%" min=${0} max=${0.95} />
      <${PropRow} ...${ctx} prop="cropRight" label="Crop right" mult=${100} step=${0.5} precision=${1} unit="%" min=${0} max=${0.95} />
      <${PropRow} ...${ctx} prop="cropBottom" label="Crop bottom" mult=${100} step=${0.5} precision=${1} unit="%" min=${0} max=${0.95} />` : null}
    <${Row} label="Blend"><${Select} class="select-sm" value=${clip.blend || 'normal'} options=${BLEND_MODES} onChange=${(v) => commit(tab, ids, 'Blend mode', (c) => { c.blend = v; })} /></${Row}>
  </${Section}>`;
}

function TransitionSection({ tab, clip, ids }) {
  const opts = (which) => [{ value: '', label: 'None' }, ...Object.entries(TRANSITIONS)
    .filter(([, d]) => which === 'in' || !d.center)
    .map(([k, d]) => ({ value: k, label: d.pair ? `${d.label} ⇄` : d.label }))];
  const one = (which) => {
    const key = which === 'in' ? 'transitionIn' : 'transitionOut';
    const cur = clip[key];
    const ed = editor(tab, ids, 'Transition duration');
    return html`<${Row} label=${which === 'in' ? 'In' : 'Out'}>
      <div class="tr-row">
        <${Select} class="select-sm" value=${cur?.type || ''} options=${opts(which)}
          onChange=${(v) => commit(tab, ids, v ? `Transition ${which}` : 'Remove transition', (c, ds, d) => { c[key] = v ? { type: v, duration: Math.min(cur?.duration || d.settings.transitionDuration || 0.5, c.duration / 2) } : null; })} />
        ${cur ? html`<${NumField} value=${cur.duration} step=${0.02} precision=${2} unit="s" min=${0.04} max=${clip.duration}
          onStart=${ed.onStart} onChange=${(v) => ed.change((c) => { if (c[key]) c[key] = { ...c[key], duration: Math.min(v, c.duration) }; })} onEnd=${ed.onEnd} />` : null}
      </div>
    </${Row}>`;
  };
  return html`<${Section} title="Transitions" icon="layers">
    ${one('in')}${one('out')}
    <div class="insp-hint">⇄ blends with the clip right before it on the same track; others animate this clip only.</div>
  </${Section}>`;
}

const FX = [
  { key: 'brightness', label: 'Brightness', mult: 100, min: -1, max: 1, unit: '%' },
  { key: 'contrast', label: 'Contrast', mult: 100, min: -1, max: 1, unit: '%' },
  { key: 'saturation', label: 'Saturation', mult: 100, min: -1, max: 1, unit: '%' },
  { key: 'hue', label: 'Hue', mult: 1, min: -180, max: 180, unit: '°' },
  { key: 'grayscale', label: 'Grayscale', mult: 100, min: 0, max: 1, unit: '%' },
  { key: 'blur', label: 'Blur', mult: 1, min: 0, max: 200, unit: 'px' },
];
function EffectsSection(ctx) {
  const { tab, clip, ids } = ctx;
  const fx = { ...DEFAULT_EFFECTS, ...(clip.effects || {}) };
  const fxAnimated = FX.some((f) => isAnimated(clip, f.key));
  const any = Object.values(fx).some((v) => v) || fxAnimated || !!clip.lut;
  return html`<${Section} title="Color & effects" icon="wand" defaultOpen=${any}
    actions=${any ? html`<button class="chip" onClick=${() => commit(tab, ids, 'Reset effects', (c) => { c.effects = { ...DEFAULT_EFFECTS }; c.lut = null; for (const f of FX) delete c.keyframes?.[f.key]; })}>Reset</button>` : null}>
    ${clip.type === 'video' || clip.type === 'image' ? html`<${LutRow} ...${ctx} ids=${ctx.kindIds?.media || ids} />` : null}
    ${FX.map((f) => html`<${PropRow} ...${ctx} prop=${f.key} label=${f.label} mult=${f.mult} step=${f.key === 'blur' ? 0.5 : 1} precision=${f.key === 'blur' ? 1 : 0} unit=${f.unit} min=${f.min} max=${f.max} />`)}
  </${Section}>`;
}

// LUT (.cube): pick from LUTs found in the project, the app's luts folder and Premiere's LUT folders, or browse.
let lutListCache = null;
function LutRow({ tab, clip, ids }) {
  const [list, setList] = useState(lutListCache);
  const [, force] = useState(0);
  const lut = clip.lut;
  useEffect(() => {
    get(`/api/luts?project=${encodeURIComponent(tab.projectId)}`).then((r) => { lutListCache = r; setList(r); }).catch(() => setList({ groups: [] }));
    return onLutLoaded(() => force((n) => n + 1));
  }, []);
  useEffect(() => { if (lut?.path && !lutState(tab.projectId, lut.path)) loadLut(tab.projectId, lut.path); }, [lut?.path]);
  const st = lut?.path ? lutState(tab.projectId, lut.path) : null;
  const setLut = (path) => {
    if (path) { forgetLut(tab.projectId, path); post('/api/luts/recent', { path }).catch(() => {}); }
    commit(tab, ids, path ? 'Apply LUT' : 'Remove LUT', (c) => {
      if (c.type !== 'video' && c.type !== 'image') return false;
      c.lut = path ? { path, intensity: c.lut?.intensity ?? lut?.intensity ?? 1 } : null;
      return undefined;
    });
  };
  const browse = async () => {
    const r = await pickPath({ title: 'Choose a LUT (.cube)', mode: 'file', exts: ['cube'], startPath: lut?.path && /^[a-z]:|^\//i.test(lut.path) ? lut.path.replace(/[\\/][^\\/]*$/, '') : (list?.appLuts || tab.store.get().dir), okLabel: 'Apply LUT' });
    if (r?.path) setLut(r.path);
  };
  const known = new Set((list?.groups || []).flatMap((g) => g.luts.map((l) => l.path)));
  const intEd = editor(tab, ids, 'LUT intensity');
  const base = (p) => p.split(/[\\/]/).pop().replace(/\.cube$/i, '');
  return html`
    <${Row} label="LUT">
      <div class="lut-row">
        <select class="select select-sm" value=${lut?.path || ''} title=${lut?.path || 'No LUT'}
          onChange=${(e) => { const v = e.target.value; if (v === '__browse') { e.target.value = lut?.path || ''; browse(); } else setLut(v || null); }}>
          <option value="">None</option>
          ${lut?.path && !known.has(lut.path) ? html`<option value=${lut.path}>${base(lut.path)}</option>` : null}
          ${(list?.groups || []).map((g) => html`<optgroup label=${g.name}>${g.luts.map((l) => html`<option value=${l.path}>${l.sub ? `${l.sub} / ` : ''}${l.name}</option>`)}</optgroup>`)}
          <option value="__browse">Browse…</option>
        </select>
        <${IconButton} icon="folder" size=${13} title="Browse for a .cube LUT" onClick=${browse} />
      </div>
    </${Row}>
    ${st?.status === 'error' ? html`<${Row} label=""><span class="lut-error">${st.error}</span></${Row}>` : null}
    ${lut ? html`<${Row} label="Intensity"><${NumField} value=${(lut.intensity ?? 1) * 100} step=${1} precision=${0} unit="%" min=${0} max=${100}
      onStart=${intEd.onStart} onChange=${(v) => intEd.change((c) => { if (c.lut) c.lut = { ...c.lut, intensity: clamp(v / 100, 0, 1) }; })} onEnd=${intEd.onEnd} /></${Row}>` : null}
    ${!list?.groups?.length && list ? html`<div class="insp-hint">Tip: put .cube files in the app's <code>luts</code> folder to list them here.</div>` : null}`;
}

const dbFmt = (v) => (v <= 0.0001 ? '-∞' : (20 * Math.log10(v)).toFixed(1));
const dbParse = (s) => (/inf/i.test(s) ? 0 : 10 ** (parseFloat(s) / 20));
function AudioSection(ctx) {
  const { tab, clip, title, fps, ids } = ctx;
  const fadeEd = editor(tab, ids, 'Audio fade');
  return html`<${Section} title=${title || 'Audio'} icon="volume">
    <${PropRow} ...${ctx} prop="volume" label="Volume" step=${0.01} precision=${2} unit="dB" min=${0} max=${4} format=${(v) => dbFmt(v)} parse=${dbParse} />
    <${Row} label="Fade in"><${NumField} value=${clip.fadeIn || 0} step=${1 / fps} precision=${2} unit="s" min=${0} max=${clip.duration}
      onStart=${fadeEd.onStart} onChange=${(v) => fadeEd.change((c) => { c.fadeIn = Math.min(v, c.duration); })} onEnd=${fadeEd.onEnd} /></${Row}>
    <${Row} label="Fade out"><${NumField} value=${clip.fadeOut || 0} step=${1 / fps} precision=${2} unit="s" min=${0} max=${clip.duration}
      onStart=${fadeEd.onStart} onChange=${(v) => fadeEd.change((c) => { c.fadeOut = Math.min(v, c.duration); })} onEnd=${fadeEd.onEnd} /></${Row}>
  </${Section}>`;
}

function SolidSection({ tab, clip, ids }) {
  const ed = editor(tab, ids, 'Matte color');
  return html`<${Section} title="Color matte" icon="square">
    <${Row} label="Color"><${ColorField} value=${clip.color || '#ffffff'} onStart=${ed.onStart} onChange=${(v) => ed.change((c) => { c.color = v; })} onEnd=${ed.onEnd} /></${Row}>
  </${Section}>`;
}

// Every font installed on this computer (Windows, per-user and Adobe Fonts), fetched once.
let systemFamilies = null;
const systemFamiliesReady = get('/api/sysfonts').then((r) => { systemFamilies = r.families; }).catch(() => { systemFamilies = SYSTEM_FONTS; });

function FontSelect({ value, fonts, onChange }) {
  const [, force] = useState(0);
  useEffect(() => { if (!systemFamilies) systemFamiliesReady.then(() => force((n) => n + 1)); }, []);
  const sys = systemFamilies || SYSTEM_FONTS;
  const known = new Set([...Object.keys(GOOGLE_FONTS), ...sys, ...(fonts || [])]);
  return html`<select class="select select-sm" value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${!known.has(value) ? html`<option value=${value}>${value}</option>` : null}
    ${fonts?.length ? html`<optgroup label="Project fonts">${fonts.map((f) => html`<option value=${f}>${f}</option>`)}</optgroup>` : null}
    <optgroup label="Google Fonts">${Object.keys(GOOGLE_FONTS).map((f) => html`<option value=${f}>${f}</option>`)}</optgroup>
    <optgroup label=${`Installed on this computer (${sys.length})`}>${sys.map((f) => html`<option value=${f}>${f}</option>`)}</optgroup>
  </select>`;
}

function TextSection({ tab, clip, seq, fonts, ids }) {
  const st = clip.style;
  const taRef = useRef(null);
  const [draft, setDraft] = useState(clip.text);
  const editingRef = useRef(false);
  useEffect(() => { if (!editingRef.current) setDraft(clip.text); }, [clip.text, clip.id]);
  useEffect(() => {
    const focus = () => { taRef.current?.focus(); taRef.current?.select(); };
    window.addEventListener('ce:edit-text', focus);
    return () => window.removeEventListener('ce:edit-text', focus);
  }, []);
  // the words are per clip; style changes apply to every selected text clip
  const styleEd = editor(tab, ids, 'Text style');
  const setStyle = (fn) => styleEd.change((c) => { c.style = deepClone(c.style); fn(c.style); });
  const one = (label, fn) => commit(tab, ids, label, (c) => { c.style = deepClone(c.style); fn(c.style); });
  const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  return html`<${Section} title="Text" icon="text">
    <textarea ref=${taRef} class="text-input" rows="3" value=${draft} spellcheck="false"
      onFocus=${() => { editingRef.current = true; tab.begin(); }}
      onInput=${(e) => { setDraft(e.target.value); const v = e.target.value; tab.preview((d, ds) => { const c = ds.clips.find((x) => x.id === clip.id); if (c) c.text = v; }); }}
      onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape') e.target.blur(); }}
      onBlur=${() => { editingRef.current = false; tab.end('Edit text'); }}></textarea>
    <${Row} label="Font"><${FontSelect} value=${st.font} fonts=${fonts} onChange=${(v) => { prepareFont({ ...st, font: v }); one('Change font', (s) => { s.font = v; }); }} /></${Row}>
    <${Row} label="Weight">
      <div class="tr-row">
        <${Select} class="select-sm" value=${String(st.weight)} options=${weights.map((w) => ({ value: String(w), label: String(w) }))} onChange=${(v) => one('Font weight', (s) => { s.weight = +v; })} />
        <button class="chip ${st.italic ? 'is-on' : ''}" title="Italic" onClick=${() => one('Italic', (s) => { s.italic = !s.italic; })}><i>I</i></button>
        <button class="chip ${st.uppercase ? 'is-on' : ''}" title="All caps" onClick=${() => one('Uppercase', (s) => { s.uppercase = !s.uppercase; })}>AA</button>
      </div>
    </${Row}>
    <${Row} label="Size"><${NumField} value=${st.size} step=${1} precision=${0} unit="px" min=${4} max=${1000} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.size = v; })} onEnd=${styleEd.onEnd} /></${Row}>
    <${Row} label="Color"><${ColorField} value=${st.color} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.color = v; })} onEnd=${styleEd.onEnd} /></${Row}>
    <${Row} label="Align"><${Segmented} value=${st.align} onChange=${(v) => one('Align text', (s) => { s.align = v; })}
      options=${[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} /></${Row}>
    <${Row} label="Line height"><${NumField} value=${st.lineHeight} step=${0.01} precision=${2} min=${0.5} max=${4} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.lineHeight = v; })} onEnd=${styleEd.onEnd} /></${Row}>
    <${Row} label="Spacing"><${NumField} value=${st.letterSpacing} step=${0.5} precision=${1} unit="px" min=${-50} max=${200} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.letterSpacing = v; })} onEnd=${styleEd.onEnd} /></${Row}>
    <${Row} label="Max width"><${NumField} value=${st.maxWidth || Math.round(seq.width * 0.9)} step=${2} precision=${0} unit="px" min=${20} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.maxWidth = v; })} onEnd=${styleEd.onEnd} /></${Row}>
    <div class="insp-sub">Stroke</div>
    <${Row} label="Width"><${NumField} value=${st.stroke.width} step=${0.5} precision=${1} unit="px" min=${0} max=${100} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.stroke = { ...s.stroke, width: v }; })} onEnd=${styleEd.onEnd} /></${Row}>
    ${st.stroke.width > 0 ? html`<${Row} label="Color"><${ColorField} value=${st.stroke.color} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.stroke = { ...s.stroke, color: v }; })} onEnd=${styleEd.onEnd} /></${Row}>` : null}
    <div class="insp-sub">Shadow</div>
    <${Row} label="Opacity"><${NumField} value=${st.shadow.opacity * 100} step=${1} precision=${0} unit="%" min=${0} max=${100} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.shadow = { ...s.shadow, opacity: v / 100 }; })} onEnd=${styleEd.onEnd} /></${Row}>
    ${st.shadow.opacity > 0 ? html`
      <${Row} label="Color"><${ColorField} value=${st.shadow.color} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.shadow = { ...s.shadow, color: v }; })} onEnd=${styleEd.onEnd} /></${Row}>
      <${Row} label="Blur"><${NumField} value=${st.shadow.blur} step=${0.5} precision=${1} unit="px" min=${0} max=${200} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.shadow = { ...s.shadow, blur: v }; })} onEnd=${styleEd.onEnd} /></${Row}>
      <${Row} label="Offset">
        <div class="tr-row">
          <${NumField} value=${st.shadow.x} step=${0.5} precision=${1} unit="x" onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.shadow = { ...s.shadow, x: v }; })} onEnd=${styleEd.onEnd} />
          <${NumField} value=${st.shadow.y} step=${0.5} precision=${1} unit="y" onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.shadow = { ...s.shadow, y: v }; })} onEnd=${styleEd.onEnd} />
        </div>
      </${Row}>` : null}
    <div class="insp-sub">Background</div>
    <${Row} label="Opacity"><${NumField} value=${st.background.opacity * 100} step=${1} precision=${0} unit="%" min=${0} max=${100} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.background = { ...s.background, opacity: v / 100 }; })} onEnd=${styleEd.onEnd} /></${Row}>
    ${st.background.opacity > 0 ? html`
      <${Row} label="Color"><${ColorField} value=${st.background.color} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.background = { ...s.background, color: v }; })} onEnd=${styleEd.onEnd} /></${Row}>
      <${Row} label="Shape"><${Segmented} value=${st.background.mode} onChange=${(v) => one('Background shape', (s) => { s.background = { ...s.background, mode: v }; })}
        options=${[{ value: 'block', label: 'Box' }, { value: 'line', label: 'Per line' }]} /></${Row}>
      <${Row} label="Padding"><${NumField} value=${st.background.padding} step=${1} precision=${0} unit="px" min=${0} max=${400} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.background = { ...s.background, padding: v }; })} onEnd=${styleEd.onEnd} /></${Row}>
      <${Row} label="Radius"><${NumField} value=${st.background.radius} step=${1} precision=${0} unit="px" min=${0} max=${400} onStart=${styleEd.onStart} onChange=${(v) => setStyle((s) => { s.background = { ...s.background, radius: v }; })} onEnd=${styleEd.onEnd} /></${Row}>` : null}
    <div class="insp-actions">
      <${Button} kind="ghost" icon="layers" title="Copy this style to every text clip on the same track"
        onClick=${() => tab.apply('Apply text style to track', (d, ds) => { for (const c of ds.clips) if (c.type === 'text' && c.track === clip.track && c.id !== clip.id) c.style = deepClone(clip.style); })}>Apply style to track</${Button}>
    </div>
  </${Section}>`;
}

// ------------------------------------------------------------------ sequence (nothing selected)

function SequenceProps({ tab, seq, warnings }) {
  const set = (label, fn) => tab.apply(label, (d, ds) => fn(ds));
  const sizeEd = { onStart: () => tab.begin(), onEnd: () => tab.end('Sequence size') };
  return html`
    <div class="insp-clip-head">
      <div class="insp-clip-icon"><${Icon} name="seq" size=${16} /></div>
      <div class="insp-clip-text">
        <input class="insp-clip-name" value=${seq.name}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }}
          onBlur=${(e) => { const n = e.target.value.trim(); if (n && n !== seq.name) set('Rename sequence', (s) => { s.name = n; }); }} />
        <div class="insp-clip-sub">Sequence · select a clip to edit it</div>
      </div>
    </div>
    <${Section} title="Sequence" icon="seq">
      <${Row} label="Frame size">
        <div class="tr-row">
          <${NumField} value=${seq.width} step=${2} precision=${0} min=${16} max=${8192} onStart=${sizeEd.onStart} onChange=${(v) => tab.preview((d, ds) => { ds.width = Math.round(v / 2) * 2; })} onEnd=${sizeEd.onEnd} />
          <span class="times">×</span>
          <${NumField} value=${seq.height} step=${2} precision=${0} min=${16} max=${8192} onStart=${sizeEd.onStart} onChange=${(v) => tab.preview((d, ds) => { ds.height = Math.round(v / 2) * 2; })} onEnd=${sizeEd.onEnd} />
        </div>
      </${Row}>
      <${Row} label="Frame rate"><${Select} class="select-sm" value=${String(seq.fps)} options=${[...new Set([...FRAME_RATES, seq.fps])].map((f) => ({ value: String(f), label: `${f} fps` }))} onChange=${(v) => set('Frame rate', (s) => { s.fps = parseFloat(v); })} /></${Row}>
      <${Row} label="Background"><${ColorField} value=${seq.background} onStart=${() => tab.begin()} onChange=${(v) => tab.preview((d, ds) => { ds.background = v; })} onEnd=${() => tab.end('Background color')} /></${Row}>
      <${Row} label="In / Out"><span class="ro">${seq.inPoint != null ? timecode(seq.inPoint, seq.fps) : '—'} → ${seq.outPoint != null ? timecode(seq.outPoint, seq.fps) : '—'}</span></${Row}>
      <${Row} label="Clips"><span class="ro">${seq.clips.length} on ${seq.tracks.length} tracks</span></${Row}>
    </${Section}>
    <${Section} title=${`Markers (${seq.markers.length})`} icon="marker">
      ${seq.markers.length ? html`<div class="marker-list">${[...seq.markers].sort((a, b) => a.t - b.t).map((m) => html`
        <div class="marker-item" key=${m.id}>
          <span class="marker-dot" style=${{ background: m.color }}></span>
          <button class="link-btn tc-small" onClick=${() => tab.engine.seek(m.t)}>${timecode(m.t, seq.fps)}</button>
          <input value=${m.label} placeholder="Marker" onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }}
            onBlur=${(e) => { if (e.target.value !== m.label) set('Rename marker', (s) => { s.markers.find((x) => x.id === m.id).label = e.target.value; }); }} />
          <${IconButton} icon="x" size=${12} title="Delete marker" onClick=${() => set('Delete marker', (s) => { s.markers = s.markers.filter((x) => x.id !== m.id); })} />
        </div>`)}</div>` : html`<div class="insp-hint">Press M to drop a marker at the playhead. Claude can read them too.</div>`}
    </${Section}>
    ${warnings?.length ? html`<${Section} title=${`Project warnings (${warnings.length})`} icon="alert">
      <ul class="warn-list">${warnings.slice(0, 30).map((w) => html`<li>${w}</li>`)}</ul>
    </${Section}>` : null}
    <div class="insp-hint pad">Tip: drag the numbers to scrub values. Hold Shift for ×10, Alt for fine control.</div>`;
}
