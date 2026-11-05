// Home: project picker (shown in a new/empty tab).
import { html, Icon, Button, IconButton, Select, Empty, timeAgo } from './common.js';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { get, post, api, socket } from '../core/api.js';
import { openProject, app } from '../core/app.js';
import { openDialog, openMenu, notify } from '../core/notify.js';
import { pickPath, confirmDialog } from './dialogs.js';
import { useStore, loadPref, savePref } from '../core/store.js';
import { NewProjectDialog, NewIPDialog, KitDialog, fetchKits } from './kits.js';

export function Home() {
  const [projects, setProjects] = useState(null);
  const [kits, setKits] = useState([]);
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState(() => loadPref('home.sort', 'recent'));
  const setSort = (v) => { setSortState(v); savePref('home.sort', v); };
  const server = useStore(app, (s) => s.server);
  const load = () => get('/api/projects').then((r) => setProjects(r.projects)).catch((e) => notify(e.message, 'error'));
  const loadKits = () => fetchKits().then(setKits);
  useEffect(() => { load(); loadKits(); }, []);
  // keep the list current without a manual refresh: the server says when projects are added or removed,
  // and coming back to the window re-reads it (a folder may have been copied in by hand)
  useEffect(() => {
    const refresh = () => { load(); loadKits(); };
    const off = socket.on((msg) => { if (msg.type === 'projects' || msg.type === 'projectDeleted') refresh(); });
    const onFocus = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { off(); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, []);

  const create = async (ip) => {
    const r = await openDialog(NewProjectDialog, { ip });
    if (r?.id) openProject(r.id);
    else { load(); loadKits(); }
  };
  const newIp = async () => {
    await openDialog(NewIPDialog, {});
    loadKits();
  };
  const openKit = async (k) => { await openDialog(KitDialog, { kitId: k.id }); loadKits(); };
  const kitName = (id) => kits.find((k) => k.id === id)?.name || id;
  const openFolder = async () => {
    const r = await pickPath({ title: 'Open a project folder', mode: 'folder', okLabel: 'Open as project' });
    if (!r?.path) return;
    try { const res = await post('/api/projects/open', { path: r.path }); openProject(res.id); } catch (err) { notify(err.message, 'error'); }
  };
  const deleteKit = async (k) => {
    const used = (projects || []).filter((p) => p.ip === k.id).length;
    const ok = await confirmDialog(`Delete the IP kit "${k.name}"?`, html`Its skills, references, rules and other files go to the Recycle Bin.${used ? html`<br />${used} project${used === 1 ? '' : 's'} using this IP keep working, just without the kit.` : null}`, 'Delete IP kit');
    if (!ok) return;
    try { await post(`/api/kits/${encodeURIComponent(k.id)}/delete`, {}); notify(`Deleted ${k.name}`, 'success'); } catch (err) { notify(err.message, 'error'); }
    loadKits();
  };
  const menu = (e, p) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: 'folderOpen', action: () => openProject(p.id) },
      { label: 'Show in Explorer', icon: 'external', action: () => post(`/api/p/${p.id}/reveal`, {}) },
      { separator: true },
      { label: 'Remove from list (the folder stays)', icon: 'x', action: async () => { await api('DELETE', `/api/projects/${p.id}`); load(); } },
    ].filter(Boolean));
  };
  const kitMenu = (e, k) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: 'Open kit', icon: 'folderOpen', action: () => openKit(k) },
      { label: `New project in ${k.name}`, icon: 'plus', action: () => create(k.id) },
      { label: 'Show in Explorer', icon: 'external', action: () => post(`/api/kits/${encodeURIComponent(k.id)}/reveal`) },
      { label: 'Delete IP kit…', icon: 'trash', danger: true, action: () => deleteKit(k) },
    ]);
  };

  const shown = useMemo(() => {
    if (!projects) return null;
    const q = query.trim().toLowerCase();
    const list = q ? projects.filter((p) => `${p.name} ${p.dir} ${p.ip ? kitName(p.ip) : ''}`.toLowerCase().includes(q)) : [...projects];
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const by = {
      recent: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
      oldest: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)),
      name: byName,
      nameDesc: (a, b) => byName(b, a),
      ip: (a, b) => (!a.ip - !b.ip) || (a.ip ? kitName(a.ip) : '').localeCompare(b.ip ? kitName(b.ip) : '') || byName(a, b),
    }[sort] || (() => 0);
    return list.sort(by);
  }, [projects, query, sort, kits]);

  return html`<div class="home">
    <div class="home-inner">
      <div class="home-hero">
        <img class="brand-mark big" src="/icon.svg" alt="" />
        <h1 class="home-title">Jimmy - The Editor</h1>
        <p class="home-sub">Edit with Claude. Every project is a folder Claude can read and change — you see it live, tweak it by hand, and review it frame by frame.</p>
        <div class="home-create">
          <${Button} kind="primary" icon="plus" onClick=${() => create()}>New project</${Button}>
          <${Button} icon="sparkle" onClick=${newIp}>New IP</${Button}>
          <${Button} icon="folderOpen" onClick=${openFolder}>Open folder…</${Button}>
        </div>
      </div>
      ${kits.length ? html`<div class="home-section-title">IP kits <span class="muted">· skills and design references Claude uses for each IP</span></div>
        <div class="home-grid kit-grid">${kits.map((k) => html`<div class="project-card kit-card" key=${k.id} onClick=${() => openKit(k)} onContextMenu=${(e) => kitMenu(e, k)}>
          <div class="project-card-top"><span class="project-card-icon"><${Icon} name="sparkle" size=${16} /></span><span class="project-card-name">${k.name}</span>
            <${IconButton} class="card-more" icon="more" size=${14} title="More" onClick=${(e) => kitMenu(e, k)} /></div>
          <div class="project-card-meta">${k.skills.length} skill${k.skills.length === 1 ? '' : 's'} · ${k.references.length} reference${k.references.length === 1 ? '' : 's'} · ${(k.rules?.length || 0)} rule file${k.rules?.length === 1 ? '' : 's'}${k.notes?.length ? ` · ${k.notes.length} other` : ''}</div>
          <div class="btn-row"><button class="link-btn" onClick=${(e) => { e.stopPropagation(); create(k.id); }}><${Icon} name="plus" size=${12} /> New project in ${k.name}</button></div>
        </div>`)}</div>` : null}
      <div class="home-section-title home-projects-head">
        <span>Projects ${server ? html`<span class="muted">· ${server.projectsRoot}</span>` : null}
          <${IconButton} icon="refresh" size=${13} title="Refresh the project list" onClick=${() => { setProjects(null); load(); loadKits(); }} /></span>
        ${projects?.length ? html`<div class="home-tools">
          <label class="bin-search home-search"><${Icon} name="search" size=${13} />
            <input placeholder="Search projects" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape') setQuery(''); }} />
            ${query ? html`<${IconButton} icon="x" size=${12} title="Clear" onClick=${() => setQuery('')} />` : null}
          </label>
          <${Select} value=${sort} onChange=${setSort} title="Sort projects" options=${[
            { value: 'recent', label: 'Recently edited' }, { value: 'oldest', label: 'Oldest edited' },
            { value: 'name', label: 'Name A–Z' }, { value: 'nameDesc', label: 'Name Z–A' }, { value: 'ip', label: 'By IP' },
          ]} />
        </div>` : null}
      </div>
      ${projects === null ? html`<div class="loading-inline"><span class="spinner"></span></div>`
        : projects.length === 0 ? html`<${Empty} icon="film" title="No projects yet">Create one above — it gets its own folder with a CLAUDE.md so any Claude Code chat knows how to edit it.</${Empty}>`
        : shown.length === 0 ? html`<div class="kit-empty">No projects match "${query}".</div>`
        : html`<div class="home-grid">${shown.map((p) => html`<div class="project-card" role="button" tabIndex="0" key=${p.id} onClick=${() => openProject(p.id)} onKeyDown=${(e) => { if (e.key === 'Enter') openProject(p.id); }} onContextMenu=${(e) => menu(e, p)}>
            <div class="project-card-top"><span class="project-card-icon"><${Icon} name="seq" size=${16} /></span><span class="project-card-name">${p.name}</span>
              <${IconButton} class="card-more" icon="more" size=${14} title="More" onClick=${(e) => menu(e, p)} /></div>
            ${p.ip ? html`<div class="project-card-ip"><${Icon} name="sparkle" size=${11} />${kitName(p.ip)}</div>` : null}
            <div class="project-card-meta">${p.sequences} sequence${p.sequences === 1 ? '' : 's'} · ${p.media} media · ${timeAgo(p.updatedAt)}</div>
            <div class="project-card-path" title=${p.dir}>${p.dir}</div>
          </div>`)}</div>`}
      <div class="home-tips">
        <div><${Icon} name="sparkle" size=${14} /> Each tab has its own Claude Code session running in the project folder.</div>
        <div><${Icon} name="message" size=${14} /> Switch to Review to comment on exports — then send the notes to Claude in one click.</div>
        <div><${Icon} name="keyboard" size=${14} /> Space play · J K L shuttle · Ctrl+K split · C razor · T text · M marker · Ctrl+Z undo (even Claude's edits)</div>
      </div>
    </div>
  </div>`;
}
