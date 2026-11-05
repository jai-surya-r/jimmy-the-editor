// Settings › Storage: see what the app keeps on disk and in this browser, and clear what isn't needed.
import { html, Modal, Button, Icon, fmtBytes } from './common.js';
import { useEffect, useState } from 'preact/hooks';
import { get, post } from '../core/api.js';
import { openDialog, notify } from '../core/notify.js';
import { applyTheme } from '../core/theme.js';

const KINDS = {
  cache: { label: 'Media cache', hint: 'Thumbnails, waveforms and preview proxies. Rebuilt automatically when needed (proxies take a while for big files).' },
  chunks: { label: 'Pre-rendered chunks', hint: 'Rendered pieces of your timelines that make exports fast. Safe to clear: the next export just renders those parts again. They are rebuilt in the background after your next edit.' },
  attachments: { label: 'Chat attachments', hint: 'Files attached in the Claude chat (.attachments folder). Claude can no longer open them once cleared.' },
  drafts: { label: 'Old draft exports', hint: 'Draft review versions, except the newest draft of each sequence. Their review comments are removed too.' },
};
const APP_KINDS = {
  temp: { label: 'Temp files', hint: 'Export worker profiles, motion previews and the shrunk images Claude checks. Kept in the cache folder (or your system Temp folder if none is set). Clear when no export is running.' },
  log: { label: 'Server log', hint: 'data/server.log — only needed when reporting a problem.' },
  fonts: { label: 'System font list', hint: 'Rescanned on the next start.' },
};

// localStorage keys this app writes (all prefixed "ce.").
const BROWSER = [
  { id: 'drafts', label: 'Unsent chat messages', hint: 'Text typed in the Claude chat but not sent.', match: (k) => k.startsWith('chat.draft.') },
  { id: 'tabs', label: 'Tab view state', hint: 'Playhead, zoom and open panels per tab. Open tabs are kept.', match: (k) => /^tab\..+/.test(k) },
  { id: 'layout', label: 'Panel sizes', hint: 'Resized panels go back to their default size.', match: (k) => k.startsWith('size.') },
  { id: 'prefs', label: 'Preferences', hint: 'Theme, volume, review and chat settings, sort order. Everything goes back to defaults.', match: (k) => !/^(chat\.draft\.|tab\.|size\.)/.test(k) && k !== 'tabs' && k !== 'activeTab' },
];
function browserUsage() {
  const out = Object.fromEntries(BROWSER.map((b) => [b.id, { bytes: 0, keys: [] }]));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full?.startsWith('ce.')) continue;
      const k = full.slice(3);
      const b = BROWSER.find((x) => x.match(k));
      if (!b) continue;
      out[b.id].bytes += (full.length + (localStorage.getItem(full) || '').length) * 2;
      out[b.id].keys.push(full);
    }
  } catch { /* storage unavailable */ }
  return out;
}

function Row({ label, hint, bytes, files, checked, onChange }) {
  const empty = !bytes && !files;
  return html`<label class=${`storage-row${empty ? ' is-empty' : ''}`}>
    <input type="checkbox" checked=${checked && !empty} disabled=${empty} onChange=${(e) => onChange(e.target.checked)} />
    <span class="storage-row-text"><b>${label}</b><span class="muted">${hint}</span></span>
    <span class="storage-row-size">${empty ? '—' : fmtBytes(bytes)}${files ? html`<span class="muted"> · ${files} file${files === 1 ? '' : 's'}</span>` : null}</span>
  </label>`;
}

export function StorageDialog({ close, onBack }) {
  const [data, setData] = useState(null);
  const [browser, setBrowser] = useState(browserUsage);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const load = () => get('/api/storage').then(setData).catch((e) => notify(e.message, 'error'));
  useEffect(() => { load(); }, []);

  const toggle = (key, v) => setSel((s) => ({ ...s, [key]: v }));
  const projTotal = (p) => Object.keys(KINDS).reduce((n, k) => n + (p[k]?.bytes || 0), 0);
  const totals = data ? Object.fromEntries(Object.keys(KINDS).map((k) => [k, data.projects.reduce((n, p) => n + p[k].bytes, 0)])) : {};
  // a per-project pick is covered by the matching "all projects" pick
  const picked = Object.entries(sel).filter(([k, v]) => v && !(k.startsWith('p:') && sel[`all:${k.split(':')[2]}`])).map(([k]) => k);
  const pickedBytes = picked.reduce((n, key) => {
    const [scope, a, b] = key.split(':');
    if (scope === 'p') return n + (data?.projects.find((p) => p.id === a)?.[b]?.bytes || 0);
    if (scope === 'all') return n + (totals[a] || 0);
    if (scope === 'app') return n + (data?.app[a]?.bytes || 0);
    if (scope === 'b') return n + (browser[a]?.bytes || 0);
    return n;
  }, 0);

  const clear = async () => {
    const items = [];
    const browserIds = [];
    for (const key of picked) {
      const [scope, a, b] = key.split(':');
      if (scope === 'p') items.push({ project: a, kind: b });
      else if (scope === 'all') for (const p of data.projects) if (p[a].bytes || p[a].files) items.push({ project: p.id, kind: a });
      else if (scope === 'app') items.push({ kind: a });
      else if (scope === 'b') browserIds.push(a);
    }
    setBusy(true);
    try {
      if (items.length) await post('/api/storage/clear', { items });
      for (const id of browserIds) for (const k of browser[id].keys) try { localStorage.removeItem(k); } catch { /* ignore */ }
      if (browserIds.includes('prefs')) applyTheme('dark');
      notify(`Cleared ${fmtBytes(pickedBytes)}`, 'success');
      setSel({});
      setBrowser(browserUsage());
      await load();
    } catch (err) { notify(err.message, 'error'); }
    setBusy(false);
  };

  const done = () => { close(null); onBack?.(); };
  return html`<${Modal} title="Storage & cache" onClose=${done} width=${640}
    footer=${html`<span class="muted">${picked.length ? `${fmtBytes(pickedBytes)} selected` : 'Pick what to clear'}</span><div class="spacer"></div>
      <${Button} onClick=${done}>Done</${Button}>
      <${Button} kind="danger" icon="trash" disabled=${!picked.length || busy} onClick=${clear}>${busy ? 'Clearing…' : 'Clear selected'}</${Button}>`}>
    ${!data ? html`<div class="loading-inline"><span class="spinner"></span> Measuring…</div>` : html`<div class="form storage">
      <div class="storage-head">Across all projects</div>
      ${Object.entries(KINDS).map(([k, d]) => html`<${Row} key=${k} label=${d.label} hint=${d.hint} bytes=${totals[k]} files=${data.projects.reduce((n, p) => n + p[k].files, 0)}
        checked=${!!sel[`all:${k}`]} onChange=${(v) => toggle(`all:${k}`, v)} />`)}

      <div class="storage-head">Per project</div>
      <div class="storage-projects">
        ${data.projects.length === 0 ? html`<div class="kit-empty">No projects.</div>` : [...data.projects].sort((a, b) => projTotal(b) - projTotal(a)).map((p) => html`<div class="storage-project" key=${p.id}>
          <button class="storage-project-head" onClick=${() => setOpen(open === p.id ? null : p.id)}>
            <${Icon} name=${open === p.id ? 'down' : 'chevronRight'} size=${12} /><span class="storage-project-name">${p.name}</span><span class="muted">${fmtBytes(projTotal(p))}</span>
          </button>
          ${open === p.id ? Object.entries(KINDS).map(([k, d]) => html`<${Row} key=${k} label=${d.label} hint=${p.dir} bytes=${p[k].bytes} files=${p[k].files}
            checked=${!!sel[`p:${p.id}:${k}`] || !!sel[`all:${k}`]} onChange=${(v) => toggle(`p:${p.id}:${k}`, v)} />`) : null}
        </div>`)}
      </div>

      <div class="storage-head">App</div>
      ${Object.entries(APP_KINDS).map(([k, d]) => html`<${Row} key=${k} label=${d.label} hint=${d.hint} bytes=${data.app[k].bytes} checked=${!!sel[`app:${k}`]} onChange=${(v) => toggle(`app:${k}`, v)} />`)}

      <div class="storage-head">This browser</div>
      ${BROWSER.map((b) => html`<${Row} key=${b.id} label=${b.label} hint=${b.hint} bytes=${browser[b.id].bytes} files=${0} checked=${!!sel[`b:${b.id}`]} onChange=${(v) => toggle(`b:${b.id}`, v)} />`)}
      <div class="dialog-hint">Nothing here touches your media, project files or final exports.</div>
    </div>`}
  </${Modal}>`;
}

export const openStorage = (onBack) => openDialog(StorageDialog, { onBack });
