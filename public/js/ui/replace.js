// Replace Footage (Premiere: Project panel > right-click > Replace Footage…).
//
// How it works — same as Premiere:
//  - Every clip on every sequence refers to the bin item by id; only the item's file path changes.
//  - Clips keep their start, duration, source in point, speed, cuts, effects and keyframes, so each cut
//    shows the same source time — from the new file (e.g. the CG / VFX render of the same plate).
//  - The server checks the new file first: same media type (required), long enough to cover every
//    source range the timeline uses (required), and warns when frame size, frame rate, duration or
//    audio differ. The swap is one undoable step (Ctrl+Z restores the original file).
import { html, Modal, Button } from './common.js';
import { post } from '../core/api.js';
import { openDialog, notify } from '../core/notify.js';
import { pickPath } from './dialogs.js';
import { VIDEO_EXT, AUDIO_EXT, IMAGE_EXT } from '../core/model.js';

export async function replaceFootage(tab, media) {
  const st = tab.store.get().mediaStatus[media.id];
  const cur = st?.abs || media.path;
  const exts = media.type === 'audio' ? AUDIO_EXT : media.type === 'image' ? IMAGE_EXT : VIDEO_EXT;
  const r = await pickPath({
    title: `Replace footage: ${media.name}`, mode: 'file', exts,
    startPath: /^[a-z]:|^\//i.test(cur) ? cur.replace(/[\\/][^\\/]*$/, '') : tab.store.get().dir, okLabel: 'Check file',
  });
  if (!r?.path) return;
  let check;
  try {
    check = await post(`/api/p/${tab.projectId}/media/${media.id}/replace-check`, { path: r.path });
  } catch (err) { notify(err.message, 'error'); return; }
  openDialog(ReplaceDialog, { tab, media, check });
}

const fmt = {
  size: (m) => (m.width ? `${m.width}×${m.height}` : '—'),
  fps: (m) => (m.fps ? `${Math.round(m.fps * 1000) / 1000} fps` : '—'),
  dur: (m) => (Number.isFinite(m.duration) ? `${m.duration.toFixed(3)}s` : '—'),
  audio: (m) => (m.hasAudio == null ? '—' : m.hasAudio ? 'Yes' : 'No'),
};

function ReplaceDialog({ close, tab, media, check }) {
  const { old, meta, errors, warnings, clips, need } = check;
  const rows = [['Type', old.type || '—', meta.type], ['Frame size', fmt.size(old), fmt.size(meta)], ['Frame rate', fmt.fps(old), fmt.fps(meta)], ['Duration', fmt.dur(old), fmt.dur(meta)], ['Audio', fmt.audio(old), fmt.audio(meta)]];
  const go = () => {
    tab.apply(`Replace footage: ${media.name}`, (d) => {
      const m = d.media.find((x) => x.id === media.id);
      if (!m) return false;
      m.path = check.path;
      m.name = check.name;
      // adopt the new file's metadata right away (the server re-probes and builds new thumbnails/proxies)
      for (const k of ['type', 'duration', 'hasAudio', 'hasVideo', 'codec', 'width', 'height', 'fps', 'sampleRate']) if (meta[k] !== undefined) m[k] = meta[k];
      if (meta.timecode) m.timecode = meta.timecode; else delete m.timecode; // the old file's start timecode no longer applies
      return undefined;
    });
    notify(`Replaced footage in ${clips} clip${clips === 1 ? '' : 's'} — Ctrl+Z to undo`, 'success');
    close(true);
  };
  return html`<${Modal} title="Replace footage" onClose=${() => close(null)} width=${540}
    footer=${html`<div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}>
      <${Button} kind="primary" disabled=${errors.length > 0} onClick=${go}>${warnings.length ? 'Replace anyway' : 'Replace'}</${Button}>`}>
    <div class="replace-box">
      <div><b>${media.name}</b> → <b>${check.name}</b></div>
      <div class="dialog-hint">${clips} clip${clips === 1 ? '' : 's'} use this item${need ? `; the timeline needs source time up to ${need.toFixed(3)}s` : ''}. Starts, durations, in points, speed, cuts, effects and keyframes stay exactly as they are.</div>
      <table class="replace-cmp">
        <tr><th></th><th>Current</th><th>New file</th></tr>
        ${rows.map(([k, a, b]) => html`<tr><th>${k}</th><td>${a}</td><td class=${a !== b ? 'is-diff' : ''}>${b}</td></tr>`)}
      </table>
      ${errors.map((e) => html`<div class="replace-msg is-error">${e}</div>`)}
      ${warnings.map((w) => html`<div class="replace-msg is-warn">${w}</div>`)}
      ${!errors.length && !warnings.length ? html`<div class="replace-msg is-ok">Matches the original — safe to replace.</div>` : null}
    </div>
  </${Modal}>`;
}
