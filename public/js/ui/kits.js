// Home-screen dialogs: New project (location → name → IP → Claude account) and IP kits
// (per-IP skills and design references, stored locally in the app's kits/ folder).
import { html, Modal, Button, Icon, IconButton, Select, Toggle, fmtBytes } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { get, post } from '../core/api.js';
import { app } from '../core/app.js';
import { useStore } from '../core/store.js';
import { openDialog, dialogCaller, notify } from '../core/notify.js';
import { pickPath, confirmDialog } from './dialogs.js';

export const fetchKits = () => get('/api/kits').then((r) => r.kits).catch(() => []);

// Only one dialog shows at a time, so the New project form survives a trip to the folder browser here.
let draft = null;

export function NewProjectDialog({ close, ip: presetIp }) {
  const server = useStore(app, (s) => s.server);
  const profiles = server?.claudeProfiles || [];
  const [form, setForm] = useState(() => draft || { location: '', name: '', ip: presetIp || '', account: profiles[0]?.dir || '', template: true });
  const [kits, setKits] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { draft = null; fetchKits().then(setKits); }, []);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const browse = async () => {
    draft = form;
    const caller = dialogCaller();
    const r = await pickPath({ title: 'Where should the project folder go?', mode: 'folder', startPath: form.location || undefined, okLabel: 'Choose this location' });
    if (r?.path) draft = { ...draft, location: r.path };
    openDialog(NewProjectDialog, {}).then(caller);
  };
  const newIp = async () => {
    draft = form;
    const caller = dialogCaller();
    const kit = await openDialog(NewIPDialog, {});
    if (kit?.id) draft = { ...draft, ip: kit.id };
    openDialog(NewProjectDialog, {}).then(caller);
  };

  // with no Claude profile found on this computer there is nothing to pick: the project uses the default
  const ready = form.location && form.name.trim() && (form.account || !profiles.length);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await post('/api/projects', { name: form.name.trim(), location: form.location, ip: form.ip || null, account: form.account || null, useTemplate: form.template });
      close(r);
    } catch (err) { notify(err.message, 'error'); setBusy(false); }
  };

  return html`<${Modal} title="New project" onClose=${() => close(null)} width=${520}
    footer=${html`<${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" icon="plus" disabled=${!ready || busy} onClick=${create}>Create project</${Button}>`}>
    <div class="form">
      <label class="field"><span>1 · Folder location</span>
        <div class="field-row" style=${{ gap: '6px' }}>
          <input class="input" readonly placeholder="Browse to choose where the project folder is created" value=${form.location} onClick=${browse} />
          <${Button} icon="folder" onClick=${browse}>Browse…</${Button}>
        </div>
      </label>
      <label class="field"><span>2 · Project name</span>
        <input class="input" placeholder="e.g. Rohith Kamath — Reel 03" value=${form.name} onInput=${(e) => set({ name: e.target.value })}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && ready && !busy) create(); }} />
      </label>
      <label class="field"><span>3 · IP</span>
        <div class="field-row" style=${{ gap: '6px' }}>
          <${Select} value=${form.ip} onChange=${(v) => set({ ip: v })}
            options=${[{ value: '', label: kits === null ? 'Loading…' : kits.length ? 'No IP' : 'No IPs yet' }, ...(kits || []).map((k) => ({ value: k.id, label: k.name }))]} />
          <${Button} icon="plus" onClick=${newIp}>New IP…</${Button}>
        </div>
      </label>
      <label class="field"><span>4 · Claude account</span>
        <${Select} value=${form.account} onChange=${(v) => set({ account: v })}
          options=${profiles.map((p) => ({ value: p.dir, label: p.name }))} />
      </label>
      <${Toggle} checked=${form.template} onChange=${(v) => set({ template: v })} label="Set up Jimmy's template folders inside it" />
      ${form.location && form.name.trim() ? html`<div class="dialog-hint">Creates <code>${form.location.replace(/[\\/]+$/, '')}${form.location.includes('\\') ? '\\' : '/'}${form.name.trim()}</code></div>` : null}
    </div>
  </${Modal}>`;
}

export function NewIPDialog({ close }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await post('/api/kits', { name: name.trim() });
      close(r.kit);
      // straight into the kit so skills and references can be added
      if (!draft) openDialog(KitDialog, { kitId: r.kit.id });
    } catch (err) { notify(err.message, 'error'); setBusy(false); }
  };
  return html`<${Modal} title="New IP" onClose=${() => close(null)} width=${460}
    footer=${html`<${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" icon="plus" disabled=${!name.trim() || busy} onClick=${create}>Create IP kit</${Button}>`}>
    <div class="form">
      <label class="field"><span>IP name</span>
        <input class="input" autoFocus placeholder="e.g. My Show" value=${name} onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') create(); }} />
      </label>
      <div class="dialog-hint">An IP kit holds this IP's skills and design references for Claude. It's stored on this computer in the app's <code>kits</code> folder, so it doesn't depend on which drive is connected.</div>
    </div>
  </${Modal}>`;
}

const kitUrl = (kitId, part, name) => `/api/kits/${encodeURIComponent(kitId)}/file?part=${part}&name=${encodeURIComponent(name)}`;

export function KitDialog({ close, kitId }) {
  const [kit, setKit] = useState(null);
  const [uploading, setUploading] = useState(0);
  const inputs = { skills: useRef(null), references: useRef(null), rules: useRef(null), notes: useRef(null) };
  const load = () => fetchKits().then((ks) => setKit(ks.find((k) => k.id === kitId) || null));
  useEffect(() => { load(); }, []);

  const upload = async (part, files) => {
    for (const f of files) {
      setUploading((n) => n + 1);
      try {
        const res = await fetch(`/api/kits/${encodeURIComponent(kitId)}/upload?part=${part}&name=${encodeURIComponent(f.name || 'pasted.png')}`, { method: 'POST', body: f });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      } catch (err) { notify(`${f.name}: ${err.message}`, 'error'); } finally { setUploading((n) => n - 1); }
    }
    load();
  };
  const remove = async (part, name) => {
    const caller = dialogCaller();
    if (await confirmDialog(`Remove ${name}?`, 'The file is deleted from this IP kit.', 'Remove')) {
      await post(`/api/kits/${encodeURIComponent(kitId)}/remove`, { part, name }).catch((e) => notify(e.message, 'error'));
    }
    openDialog(KitDialog, { kitId }).then(caller);
  };

  // called as a plain function below (not as a component): defined in here it would be a new component on
  // every render, and each section would be rebuilt, losing focus mid-paste
  const section = ({ part, title, hint, accept }) => html`<div class="kit-section"
      onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); upload(part, [...e.dataTransfer.files]); } }}
      onPaste=${(e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); upload(part, f); } }} tabIndex="0">
    <div class="kit-section-head"><b>${title}</b><span class="muted">${kit?.[part]?.length || 0}</span><div class="spacer"></div>
      <${Button} icon="upload" onClick=${() => inputs[part].current?.click()}>Add files</${Button}>
      <input type="file" multiple accept=${accept} ref=${inputs[part]} style=${{ display: 'none' }} onChange=${(e) => { upload(part, [...e.target.files]); e.target.value = ''; }} />
    </div>
    <div class="dialog-hint">${hint}</div>
    <div class="kit-files">
      ${(kit?.[part] || []).map((f) => html`<div class="kit-file">
        ${part === 'references' && /\.(png|jpe?g|webp|gif)$/i.test(f.name) ? html`<img src=${kitUrl(kitId, part, f.name)} alt="" />` : html`<${Icon} name=${part === 'skills' ? 'wand' : 'film'} size=${14} />`}
        <span class="kit-file-name" title=${f.name}>${f.name}${f.folder && f.skill ? html` <code class="kit-cmd">/${kit.plugin}:${f.name}</code>` : null}${f.folder && !f.skill ? html` <span class="muted">(no SKILL.md inside)</span>` : null}</span>
        <span class="muted">${f.folder ? '' : fmtBytes(f.size)}</span>
        ${f.folder ? null : html`<${IconButton} icon="external" size=${13} title="Open" onClick=${() => window.open(kitUrl(kitId, part, f.name), '_blank')} />`}
        <${IconButton} icon="trash" size=${13} title="Remove" onClick=${() => remove(part, f.name)} />
      </div>`)}
      ${!kit?.[part]?.length ? html`<div class="kit-empty">Drop files here, paste (Ctrl+V), or use Add files.</div>` : null}
    </div>
  </div>`;

  return html`<${Modal} title=${kit ? `IP kit · ${kit.name}` : 'IP kit'} onClose=${() => close(null)} width=${620}
    footer=${html`<${Button} icon="folder" onClick=${() => post(`/api/kits/${encodeURIComponent(kitId)}/reveal`)}>Open folder</${Button}><div class="spacer"></div>
      ${uploading ? html`<span class="muted"><span class="spinner spinner-xs"></span> Adding ${uploading}…</span>` : null}
      <${Button} kind="primary" onClick=${() => close(null)}>Done</${Button}>`}>
    ${!kit ? html`<div class="loading-inline"><span class="spinner"></span></div>` : html`<div class="form">
      ${section({ part: 'skills', title: 'Skills', accept: '.md,.zip,.skill',
        hint: html`Add a skill's <code>SKILL.md</code> or a <code>.zip</code>/<code>.skill</code> of a skill folder. In this IP's projects, run it with <code>/${kit.plugin}:<i>skill-name</i></code> in the Claude panel.` })}
      ${section({ part: 'references', title: 'Design references',
        hint: 'Approved edits, frame grabs, style frames, brand guides — anything that shows the look.' })}
      ${section({ part: 'rules', title: 'Rules',
        hint: "Do's and don'ts, style rules, client preferences for this IP (text or markdown files)." })}
      ${section({ part: 'notes', title: 'Other files',
        hint: 'Anything else Claude should have for this IP — scripts, briefs, fonts, LUTs, docs.' })}
    </div>`}
  </${Modal}>`;
}
