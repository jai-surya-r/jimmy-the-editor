// Clip Speed / Duration (Premiere's Ctrl+R): retime the selected clips by speed % or by a target duration.
import { html, Modal, Button, NumField, Toggle, IconButton } from './common.js';
import { useState } from 'preact/hooks';
import { timecode, parseTime, usesSourceTime, maxDurationFor } from '../core/model.js';
import { retimeClips, linkedIds } from '../core/ops.js';
import { openDialog, notify } from '../core/notify.js';

export function openSpeedDialog(tab, ids) {
  const seq = tab.seq;
  const sel = new Set(ids && ids.length ? ids : tab.ui.get().selection);
  const clips = seq.clips.filter((c) => sel.has(c.id));
  if (!clips.length) { notify('Select a clip first'); return; }
  openDialog(SpeedDialog, { tab, ids: [...sel] });
}

function SpeedDialog({ close, tab, ids }) {
  const seq = tab.seq;
  const fps = seq.fps;
  const clips = seq.clips.filter((c) => ids.includes(c.id));
  const primary = clips.find((c) => c.id === tab.ui.get().focusClip) || clips.find(usesSourceTime) || clips[0];
  const [speed, setSpeed] = useState((primary.speed || 1) * 100);
  const [dur, setDur] = useState(primary.duration);
  const [linked, setLinked] = useState(true);
  const [ripple, setRipple] = useState(false);
  const [mode, setMode] = useState('speed'); // which field the user set last
  const timed = usesSourceTime(primary);
  const srcLen = primary.duration * (primary.speed || 1);
  const onSpeed = (v) => { setSpeed(v); setMode('speed'); if (linked && timed) setDur(srcLen / (v / 100)); };
  const onDur = (v) => { setDur(v); setMode('duration'); if (linked && timed) setSpeed((srcLen / v) * 100); };
  const apply = () => {
    const opts = { ripple, fps, mediaById: tab.mediaById };
    if (mode === 'duration' || !timed) opts.duration = Math.max(1 / fps, dur);
    else opts.speed = speed / 100;
    // unlinked: speed changes but the clip keeps its length (content is cut or held to the old duration)
    tab.apply(mode === 'duration' ? 'Change duration' : `Speed ${Math.round(speed * 100) / 100}%`, (d, ds) => {
      const set = linkedIds(ds, ids);
      if (!linked && timed && mode === 'duration') {
        // unlinked duration = a plain trim of the out point at the current speed
        for (const c of ds.clips) if (set.has(c.id)) c.duration = Math.max(1 / fps, Math.min(dur, maxDurationFor(c, tab.mediaById[c.media])));
        return;
      }
      const before = new Map(ds.clips.map((c) => [c.id, c.duration]));
      retimeClips(ds, set, linked || !timed ? opts : { ...opts, ripple: false }); // unlinked: the length is put back below, so nothing after it moves
      if (!linked && timed) for (const c of ds.clips) if (set.has(c.id) && usesSourceTime(c)) c.duration = Math.min(before.get(c.id), maxDurationFor(c, tab.mediaById[c.media]));
    });
    close(true);
  };
  return html`<${Modal} title="Clip Speed / Duration" onClose=${() => close(null)} width=${400}
    footer=${html`<div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" onClick=${apply}>OK</${Button}>`}>
    <div class="form speed-form" onKeyDown=${(e) => { if (e.key === 'Enter') apply(); }}>
      <div class="speed-grid">
        <span>Speed</span>
        <${NumField} value=${speed} step=${1} precision=${2} unit="%" min=${5} max=${1600} disabled=${!timed} onChange=${onSpeed} />
        <${IconButton} icon="link" title=${linked ? 'Speed and duration are linked' : 'Unlinked: change one without the other'} active=${linked} onClick=${() => setLinked(!linked)} />
        <span>Duration</span>
        <${NumField} value=${dur} step=${1 / fps} min=${1 / fps} format=${(v) => timecode(v, fps)} parse=${(s) => parseTime(s, fps)} onChange=${onDur} />
        <span></span>
      </div>
      <${Toggle} checked=${ripple} onChange=${setRipple} label="Ripple edit, shifting trailing clips" />
      <div class="dialog-hint">${clips.length > 1 ? `${clips.length} clips selected (linked audio follows). ` : ''}${timed
        ? `Source used: ${srcLen.toFixed(2)}s. Without ripple, a clip that gets longer stops at the next clip on its track.`
        : 'Stills, text and mattes only change duration.'}</div>
    </div>
  </${Modal}>`;
}
