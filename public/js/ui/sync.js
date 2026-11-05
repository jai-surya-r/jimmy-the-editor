// Synchronize… (Premiere's name): line up the selected clips with a reference clip by their sound, their timecode, or
// their start or end. Clips linked together (a camera's picture and sound) move as one; a separate recording (a lone
// audio clip) is placed to the sample by shifting where its source starts, everything else to the nearest frame, as in
// Premiere. A clip that would land on another goes to a free track (a new one if needed). Audio results show how sure
// the match is; unsure ones aren't applied unless ticked. One Undo takes it all back.
import { html, Modal, Button, Select, Segmented } from './common.js';
import { useState } from 'preact/hooks';
import { clipEnd, trackLabel } from '../core/model.js';
import { linkedIds, addTrack } from '../core/ops.js';
import { post } from '../core/api.js';
import { openDialog, notify } from '../core/notify.js';

const EPS = 1e-6;
// the selection as groups that move together: linked clips are one group
export function syncGroups(seq, ids) {
  const all = linkedIds(seq, ids);
  const groups = [];
  const seen = new Set();
  for (const c of seq.clips) {
    if (!all.has(c.id) || seen.has(c.id) || !c.media) continue;
    const members = c.link ? seq.clips.filter((x) => x.link === c.link && all.has(x.id)) : [c];
    for (const m of members) seen.add(m.id);
    groups.push({ clips: members, anchor: members.find((x) => x.type === 'audio') || members[0] });
  }
  return groups;
}
const tcSeconds = (tc, fps) => {
  const m = /^(\d+):(\d+):(\d+)([:;.])(\d+)$/.exec(String(tc || ''));
  if (!m || !(fps > 0)) return null;
  const [h, mi, s, f] = [m[1], m[2], m[3], m[5]].map(Number);
  const tb = Math.round(fps);
  let frames = ((h * 60 + mi) * 60 + s) * tb + f;
  if (m[4] === ';' && Math.abs(fps - tb) > 0.001) { const mins = h * 60 + mi; frames -= Math.round(tb / 15) * (mins - Math.floor(mins / 10)); }
  return frames / fps;
};
export const syncLabel = (r) => (!r || r.error ? 'failed' : r.confidence >= 1.6 && r.precise ? 'sure' : r.confidence >= 1.25 ? 'likely' : 'unsure');

// where each group's anchor clip must start (seconds, unrounded) to line up with the reference; null where impossible
export function targetStarts(doc, seq, groups, refIndex, method, lags = {}) {
  const media = Object.fromEntries(doc.media.map((m) => [m.id, m]));
  const R = groups[refIndex].anchor;
  return groups.map((g, i) => {
    if (i === refIndex) return { start: R.start, why: null };
    const X = g.anchor;
    if (method === 'start') return { start: R.start };
    if (method === 'end') return { start: clipEnd(R) - (clipEnd(X) - X.start) };
    if (method === 'timecode') {
      const tr = tcSeconds(media[R.media]?.timecode, media[R.media]?.fps), tx = tcSeconds(media[X.media]?.timecode, media[X.media]?.fps);
      if (tr == null || tx == null) return { start: null, why: 'no timecode' };
      return { start: R.start + (tx + (X.in || 0)) - (tr + (R.in || 0)) };
    }
    // audio: the moment t of the reference's file is at t + lag in this one
    if ((R.speed || 1) !== 1 || (X.speed || 1) !== 1) return { start: null, why: 'speed changed' };
    const r = lags[X.media];
    if (!r || r.error) return { start: null, why: r?.error || 'not measured' };
    return { start: R.start - (R.in || 0) + (X.in || 0) - r.lag, result: r };
  });
}

// Moves the groups (inside tab.apply): picture to whole frames, a lone audio clip to the sample via its in point;
// anything that would start before 0 moves everything right; clips that would land on others go to free tracks.
export function applySync(ds, groups, targets, picked, fps, refIndex = 0) {
  const moving = groups.map((g, i) => (picked.has(i) && targets[i].start != null ? { g, exact: targets[i].start } : null)).filter(Boolean);
  if (!moving.length) return 0;
  const frame = (t) => Math.round(t * fps) / fps;
  // the shift of each group, and the sub-frame rest for a lone audio clip
  for (const m of moving) {
    const a = m.g.anchor;
    const lone = m.g.clips.length === 1 && a.type === 'audio';
    m.shift = lone ? frame(m.exact) - a.start : frame(m.exact - a.start);
    m.inFix = lone ? (frame(m.exact) - m.exact) * (a.speed || 1) : 0;
  }
  const minStart = Math.min(...moving.flatMap((m) => m.g.clips.map((c) => c.start + m.shift)));
  const push = minStart < -EPS ? Math.ceil(-minStart * fps - 1e-6) / fps : 0;
  const live = (id) => ds.clips.find((c) => c.id === id);
  // when something would start before 0, the reference and the clips being synced move right together; the rest stay
  if (push) for (const g of [groups[refIndex], ...moving.map((m) => m.g)]) for (const c of g.clips) live(c.id).start += push;
  let moved = 0;
  const fits = (trackId, start, end, self) => !ds.clips.some((c) => c.track === trackId && !self.has(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS);
  for (const m of moving) {
    const self = new Set(m.g.clips.map((c) => c.id));
    for (const c0 of m.g.clips) {
      const c = live(c0.id);
      c.start = Math.max(0, c.start + m.shift);
      if (m.inFix) { c.in = (c.in || 0) + m.inFix; if (c.in < 0) { c.start += 1 / fps; c.in += 1 / fps; } }
      if (!fits(c.track, c.start, clipEnd(c), self)) {
        const kind = c.type === 'audio' ? 'audio' : 'video';
        const free = ds.tracks.filter((t) => t.kind === kind && !t.locked).find((t) => fits(t.id, c.start, clipEnd(c), self));
        c.track = (free || addTrack(ds, kind)).id;
      }
      moved++;
    }
  }
  return moved;
}

export function SyncDialog({ close, tab, ids }) {
  const doc = tab.doc, seq = tab.seq;
  const groups = syncGroups(seq, ids);
  const media = Object.fromEntries(doc.media.map((m) => [m.id, m]));
  const name = (g) => `${media[g.anchor.media]?.name || 'clip'} · ${g.clips.map((c) => trackLabel(seq, seq.tracks.find((t) => t.id === c.track))).join('+')}`;
  // the reference: Premiere syncs to the clip on the lowest track; here the first group with picture on the lowest video track
  const defRef = Math.max(0, groups.findIndex((g) => g.clips.some((c) => c.type !== 'audio')));
  const [ref, setRef] = useState(defRef);
  const allTc = groups.every((g) => media[g.anchor.media]?.timecode);
  const [method, setMethod] = useState('audio');
  const [lags, setLags] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(null);
  const targets = targetStarts(doc, seq, groups, ref, method, lags || {});
  const measure = async () => {
    setBusy(true);
    try {
      const refMedia = groups[ref].anchor.media;
      const others = [...new Set(groups.filter((_, i) => i !== ref).map((g) => g.anchor.media))];
      const r = await post(`/api/p/${tab.projectId}/audio-sync`, { pairs: others.map((o) => ({ ref: refMedia, other: o })) });
      const out = {};
      for (const x of r.results) out[x.other] = x;
      out[refMedia] = { lag: 0, confidence: Infinity, precise: true };
      setLags(out);
      setPicked(new Set(groups.map((g, i) => i).filter((i) => i !== ref && ['sure', 'likely'].includes(syncLabel(out[groups[i].anchor.media])))));
    } catch (e) { notify(e.message, 'error'); }
    setBusy(false);
  };
  const ready = method !== 'audio' || lags;
  const chosen = picked || new Set(groups.map((_, i) => i).filter((i) => i !== ref && targets[i].start != null));
  const apply = () => {
    let moved = 0;
    tab.apply(`Synchronize (${method})`, (d, ds) => { moved = applySync(ds, groups, targets, chosen, seq.fps, ref); return moved ? undefined : false; });
    notify(moved ? `Synchronized ${chosen.size} clip${chosen.size === 1 ? '' : 's'} to ${media[groups[ref].anchor.media]?.name}. Ctrl+Z to undo` : 'Nothing to move', moved ? 'success' : 'info');
    close(moved);
  };
  const resultText = (i) => {
    if (i === ref) return 'reference';
    const t = targets[i];
    if (t.start == null) return t.why || '';
    if (method !== 'audio') return `moves ${(t.start - groups[i].anchor.start >= 0 ? '+' : '')}${(t.start - groups[i].anchor.start).toFixed(3)} s`;
    const r = t.result;
    return `${syncLabel(r)} · offset ${r.lag >= 0 ? '+' : ''}${r.lag.toFixed(4)} s`;
  };
  if (groups.length < 2) {
    return html`<${Modal} title="Synchronize" onClose=${() => close(null)} width=${420} footer=${html`<div class="spacer"></div><${Button} onClick=${() => close(null)}>OK</${Button}>`}>
      <div class="muted">Select two or more clips on the timeline first (a camera's picture and sound count as one).</div></${Modal}>`;
  }
  return html`<${Modal} title="Synchronize" onClose=${() => close(null)} width=${540}
    footer=${html`<div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}>
      ${method === 'audio' && !lags ? html`<${Button} kind="primary" disabled=${busy} onClick=${measure}>${busy ? 'Listening…' : 'Find the offsets'}</${Button}>`
        : html`<${Button} kind="primary" disabled=${!chosen.size} onClick=${apply}>Synchronize</${Button}>`}`}>
    <div class="form">
      <label class="field"><span>Line up by</span><${Segmented} value=${method} onChange=${(v) => { setMethod(v); setPicked(null); }}
        options=${[{ value: 'audio', label: 'Audio' }, { value: 'timecode', label: 'Timecode', title: allTc ? '' : 'Some clips have no timecode' }, { value: 'start', label: 'Clip start' }, { value: 'end', label: 'Clip end' }]} /></label>
      <label class="field"><span>Reference (stays where it is)</span><${Select} value=${String(ref)} onChange=${(v) => { setRef(+v); setLags(null); setPicked(null); }}
        options=${groups.map((g, i) => ({ value: String(i), label: name(g) }))} /></label>
      <div class="sync-list">${groups.map((g, i) => html`<label class="sync-row ${i === ref ? 'is-ref' : ''}">
        <input type="checkbox" disabled=${i === ref || !ready || targets[i].start == null} checked=${i !== ref && chosen.has(i)}
          onChange=${(e) => { const n = new Set(chosen); if (e.target.checked) n.add(i); else n.delete(i); setPicked(n); }} />
        <span class="sync-name">${name(g)}</span>
        <span class=${`sync-result is-${method === 'audio' && targets[i].result ? syncLabel(targets[i].result) : ''}`}>${ready || i === ref ? resultText(i) : ''}</span>
      </label>`)}</div>
      <div class="dialog-hint">${method === 'audio'
        ? 'Listens to the sound of each clip and lines it up with the reference to a fraction of a millisecond, also across different microphones and cameras. A separate recording is placed to the sample, picture to the nearest frame. Unsure matches are left unticked.'
        : method === 'timecode' ? 'Lines up the cameras\' own timecode (read from the files when they were imported).'
        : `Lines up each clip's ${method === 'start' ? 'start' : 'end'} with the reference's.`} Clips that would land on others move to a free track. One Ctrl+Z undoes it.</div>
    </div>
  </${Modal}>`;
}

export const openSync = (tab, ids) => openDialog(SyncDialog, { tab, ids });
