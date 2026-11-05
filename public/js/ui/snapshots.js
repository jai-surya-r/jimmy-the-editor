// Project snapshots (server/snapshots.js): copies of the project's own files in its cache, taken on opening, every
// 10 minutes while it changes, before a chat's edit, and by hand. Restoring one first keeps the current state as a
// snapshot too, so a restore can always be undone the same way.
import { html, Modal, Button, Empty, timeAgo } from './common.js';
import { useEffect, useState } from 'preact/hooks';
import { get, post } from '../core/api.js';
import { openDialog, notify, dialogCaller } from '../core/notify.js';
import { confirmDialog } from './dialogs.js';

export function SnapshotsDialog({ close, tab }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => get(`/api/p/${tab.projectId}/snapshots`).then((r) => setList(r.snapshots)).catch((e) => { notify(e.message, 'error'); setList([]); });
  useEffect(() => { load(); }, []);
  const takeNow = async () => {
    setBusy(true);
    try {
      const r = await post(`/api/p/${tab.projectId}/snapshots`, {});
      notify(r.unchanged ? 'Nothing changed since the last snapshot' : 'Snapshot taken', r.unchanged ? 'info' : 'success');
      await load();
    } catch (e) { notify(e.message, 'error'); }
    setBusy(false);
  };
  // the question replaces this window (one dialog at a time); it opens again afterwards
  const restore = async (s) => {
    const caller = dialogCaller();
    const when = new Date(s.createdAt).toLocaleString();
    const yes = await confirmDialog('Restore this snapshot?', `The project goes back to how it was on ${when}: sequences, clips, bin and review comments. How it is now is kept as a snapshot first, so you can come back to it. Footage and exports aren't touched.`, 'Restore', false);
    if (yes) {
      try { await post(`/api/p/${tab.projectId}/snapshots/${encodeURIComponent(s.id)}/restore`, {}); notify(`Restored the snapshot from ${when}`, 'success'); } catch (e) { notify(e.message, 'error'); }
    }
    openDialog(SnapshotsDialog, { tab }).then(caller);
  };
  return html`<${Modal} title="Project snapshots" onClose=${() => close(null)} width=${520}
    footer=${html`<span class="muted">Kept in the project's cache: the newest 40, then one a day for 30 days.</span><div class="spacer"></div>
      <${Button} disabled=${busy} onClick=${takeNow}>Take one now</${Button}><${Button} kind="primary" onClick=${() => close(null)}>Done</${Button}>`}>
    ${!list ? html`<div class="loading-inline"><span class="spinner"></span> Looking…</div>`
      : !list.length ? html`<${Empty} icon="clock" title="No snapshots yet">One is taken when the project opens and every 10 minutes while you edit.</${Empty}>`
      : html`<div class="snapshot-list">${list.map((s, i) => html`<div class="snapshot-row" key=${s.id}>
          <div class="snapshot-text"><b title=${new Date(s.createdAt).toLocaleString()}>${timeAgo(s.createdAt)}</b>
            <span class="muted">${s.label}${s.summary?.sequences != null ? ` · ${s.summary.sequences} sequence${s.summary.sequences === 1 ? '' : 's'}, ${s.summary.clips} clips, ${s.summary.media} media` : ''}${i === 0 ? ' · newest' : ''}</span></div>
          <${Button} class="btn-sm" onClick=${() => restore(s)}>Restore</${Button}>
        </div>`)}</div>`}
    <div class="dialog-hint">A snapshot holds the project's own files (project.json, review comments, chat links): never footage or renders, so they take little space.</div>
  </${Modal}>`;
}

export const openSnapshots = (tab) => openDialog(SnapshotsDialog, { tab });
