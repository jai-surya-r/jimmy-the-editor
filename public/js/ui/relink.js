// "Locate missing media" (server/relink.js), shown when a project opens with footage that isn't where project.json
// says: made on another computer (Windows <-> Mac), a drive with another letter, a moved folder. Find one file and
// the rest follow it, like Premiere Pro's Link Media.
import { useState } from 'preact/hooks';
import { html, Modal, Button } from './common.js';
import { get, post } from '../core/api.js';
import { notify, openDialog, dialogCaller } from '../core/notify.js';
import { pickPath } from './dialogs.js';

export function RelinkDialog({ tab, list: initial, close }) {
  const [list, setList] = useState(initial || []);
  const [busy, setBusy] = useState(null);
  const caller = dialogCaller();
  const locate = async (m) => {
    const native = !!window.jimmyApp?.pick;
    const picked = await pickPath({ mode: 'file', title: `Locate "${m.name}"`, okLabel: 'Locate' });
    let next = list;
    if (picked?.path) {
      setBusy(m.id);
      try {
        const r = await post(`/api/p/${tab.projectId}/relink`, { mediaId: m.id, path: picked.path });
        const n = r.linked?.length || 0;
        notify(`Found ${n} file${n === 1 ? '' : 's'}${r.missing?.length ? `, ${r.missing.length} still missing` : ''}`, n ? 'success' : 'info');
        next = r.missing || [];
      } catch (err) { notify(err.message, 'error'); }
      setBusy(null);
    }
    // the browser version's file browser took this dialog's place: open it again
    if (!native) { if (next.length) openDialog(RelinkDialog, { tab, list: next }).then(caller); else caller(true); return; }
    if (!next.length) close(true);
    else setList(next);
  };
  const foreign = list.some((m) => m.foreign);
  return html`<${Modal} title="Locate missing media" onClose=${() => close(false)} width=${620}
      footer=${html`<${Button} onClick=${() => close(false)}>Not now</${Button}>`}>
    <p class="relink-lead">${list.length} file${list.length === 1 ? ' isn\'t' : 's aren\'t'} where this project expects ${list.length === 1 ? 'it' : 'them'}${foreign ? ', as the project was made on another computer' : ''}.
      Locate one, and Jimmy finds the others in the same folders or close by.</p>
    <div class="relink-list">${list.map((m) => html`<div class="relink-row" key=${m.id}>
      <div class="relink-name"><b>${m.name}</b><small title=${m.path}>${m.path}</small></div>
      <${Button} kind=${m === list[0] ? 'primary' : 'default'} disabled=${!!busy} onClick=${() => locate(m)}>${busy === m.id ? 'Looking…' : 'Locate…'}</${Button}>
    </div>`)}</div>
  </${Modal}>`;
}

// When a project opens: offer to locate its missing footage (once per open tab).
export async function checkMissing(tab) {
  let r;
  try { r = await get(`/api/p/${tab.projectId}/missing`); } catch { return; }
  if (r?.missing?.length) openDialog(RelinkDialog, { tab, list: r.missing });
}
