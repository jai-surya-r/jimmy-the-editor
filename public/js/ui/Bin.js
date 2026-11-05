// Project bin: folders, media and sequences. Import (upload or link in place), organise, drag to timeline.
import { html, Icon, IconButton, Empty, fmtBytes, Memo } from './common.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore, loadPref, savePref } from '../core/store.js';
import { uid, shortTime, sequenceDuration } from '../core/model.js';
import { addCaptions } from '../core/ops.js';
import { parseSubtitles, toSrt } from '../core/srt.js';
import { openMenu, openDialog, notify } from '../core/notify.js';
import { get, post, uploadFile, mediaUrl } from '../core/api.js';
import { replaceFootage } from './replace.js';
import { exportXml, duplicateSeq, prerenderMenuItem } from './Timeline.js';
import { NewSequenceDialog, pickPath, SourcePreview, confirmDialog } from './dialogs.js';
import { NewMotionDialog, motionActions, isMotion } from './motion.js';
import { chatMenuItems } from './chatlinks.js';
import { commandOf, shortcutLabel } from './keymap.js';
import { openOrganise, roleOf, ROLES } from './organise.js';
import { openSnapshots } from './snapshots.js';
import { openReframe } from './reframe.js';

const MEDIA_ICON = { video: 'film', audio: 'music', image: 'image' };

export function Bin({ tab }) {
  const doc = useStore(tab.store, (s) => s.doc);
  const mediaStatus = useStore(tab.store, (s) => s.mediaStatus);
  const sel = useStore(tab.ui, (s) => s.binSelection);
  const openFolders = useStore(tab.ui, (s) => s.openFolders);
  const seqId = useStore(tab.ui, (s) => s.sequenceId);
  const reveal = useStore(tab.ui, (s) => s.binReveal);
  const [query, setQuery] = useState('');
  const [uploads, setUploads] = useState([]);
  const [dropOn, setDropOn] = useState(undefined);
  const [renaming, setRenaming] = useState(null);
  const fileInput = useRef(null);
  const srtInput = useRef(null);
  const listRef = useRef(null);
  // List, Tiles or Gallery, kept per project. The grid views show one folder at a time (double-click a folder to open it).
  const [view, setViewState] = useState(() => loadPref(`binView.${tab.projectId}`, 'list'));
  const setView = (v) => { setViewState(v); savePref(`binView.${tab.projectId}`, v); };
  const grid = view !== 'list';
  const gridFolderId = useStore(tab.ui, (s) => s.binGridFolder) || null;

  useEffect(() => {
    if (!reveal || !doc) return;
    const open = { ...openFolders };
    for (const id of sel) {
      let f = (doc.media.find((m) => m.id === id) || doc.sequences.find((s) => s.id === id))?.folder;
      while (f) { open[f] = true; f = doc.folders.find((x) => x.id === f)?.parent; }
    }
    tab.ui.set({ openFolders: open });
    // the grid views open the folder the first selected item is in
    if (grid && sel.length) {
      const f = doc.folders.find((x) => x.id === sel[0]);
      const it = f || doc.media.find((m) => m.id === sel[0]) || doc.sequences.find((s) => s.id === sel[0]);
      if (it) tab.ui.set({ binGridFolder: (f ? f.parent : it.folder) || null });
    }
    setTimeout(() => listRef.current?.querySelector('.bin-row.is-selected')?.scrollIntoView({ block: 'nearest' }), 50);
  }, [reveal]);

  // how many clips use each file: counted once per version of the project, not per row on every redraw
  const uses = useMemo(() => { const m = new Map(); for (const s of doc?.sequences || []) for (const c of s.clips) if (c.media) m.set(c.media, (m.get(c.media) || 0) + 1); return m; }, [doc]);
  if (!doc) return html`<aside class="panel bin"></aside>`;

  const selSet = new Set(sel);
  const gridFolder = grid && doc.folders.some((f) => f.id === gridFolderId) ? gridFolderId : null;
  const openGridFolder = (id) => tab.ui.set({ binGridFolder: id || null, binSelection: [] });
  const currentFolder = () => {
    const f = doc.folders.find((x) => selSet.has(x.id));
    if (f) return f.id;
    const item = doc.media.find((m) => selSet.has(m.id)) || doc.sequences.find((s) => selSet.has(s.id));
    return item?.folder || gridFolder;
  };
  const usage = (mid) => uses.get(mid) || 0;

  // ------------------------------------------------------------ actions
  const importFiles = async (files, folder) => {
    // From disk (dropped from Explorer, or picked) in the desktop app: linked where they are, nothing is copied.
    // Files without a path on disk (the browser version) are uploaded into the project as before.
    const paths = [], list = [];
    for (const f of files) { const p = window.jimmyApp?.pathOf(f); if (p) paths.push(p); else list.push(f); }
    if (paths.length) {
      try {
        const res = await post(`/api/p/${tab.projectId}/media/link`, { paths, folder });
        notify(`Linked ${res.ids.length} item${res.ids.length === 1 ? '' : 's'}`, 'success');
        tab.ui.set({ binSelection: res.ids });
      } catch (err) { notify(err.message, 'error'); }
    }
    for (const f of list) {
      const key = `${f.name}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: f.name, progress: 0 }]);
      try {
        await uploadFile(tab.projectId, f, { folder, onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))) });
      } catch (err) {
        notify(`${f.name}: ${err.message}`, 'error');
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
  };
  const linkFromDisk = async () => {
    const r = await pickPath({ title: 'Import media', okLabel: 'Import' });
    if (!r?.paths?.length) return;
    try {
      const res = await post(`/api/p/${tab.projectId}/media/link`, { paths: r.paths, copy: r.copy, folder: currentFolder() });
      notify(`Imported ${res.ids.length} item${res.ids.length === 1 ? '' : 's'}`, 'success');
      tab.ui.set({ binSelection: res.ids });
    } catch (err) { notify(err.message, 'error'); }
  };
  const newFolder = (parent = currentFolder()) => {
    const id = uid('f');
    tab.apply('New folder', (d) => { d.folders.push({ id, name: 'New folder', parent }); });
    if (parent) tab.ui.set({ openFolders: { ...openFolders, [parent]: true } });
    tab.ui.set({ binSelection: [id] });
    setRenaming(id);
  };
  const rename = (id, name) => {
    setRenaming(null);
    const n = name.trim();
    if (!n) return;
    tab.apply('Rename', (d) => {
      const it = d.folders.find((x) => x.id === id) || d.media.find((x) => x.id === id) || d.sequences.find((x) => x.id === id);
      if (it && it.name !== n) it.name = n; else return false;
      return undefined;
    });
  };
  const moveTo = (ids, folder) => {
    const set = new Set(ids);
    // a folder can't be moved into itself or its descendants
    const isDesc = (f, anc) => { while (f) { if (f === anc) return true; f = doc.folders.find((x) => x.id === f)?.parent; } return false; };
    tab.apply('Move to folder', (d) => {
      let changed = false;
      for (const f of d.folders) if (set.has(f.id) && !isDesc(folder, f.id) && f.parent !== folder) { f.parent = folder; changed = true; }
      for (const m of d.media) if (set.has(m.id) && m.folder !== folder) { m.folder = folder; changed = true; }
      for (const s of d.sequences) if (set.has(s.id) && s.folder !== folder) { s.folder = folder; changed = true; }
      return changed ? undefined : false;
    });
  };
  const removeItems = async (ids) => {
    const set = new Set(ids);
    const media = doc.media.filter((m) => set.has(m.id));
    const seqs = doc.sequences.filter((s) => set.has(s.id));
    const folders = doc.folders.filter((f) => set.has(f.id));
    const clipCount = media.reduce((n, m) => n + usage(m.id), 0);
    const parts = [];
    if (media.length) parts.push(`${media.length} media item${media.length > 1 ? 's' : ''}${clipCount ? ` (used by ${clipCount} clip${clipCount > 1 ? 's' : ''}, which will be removed too)` : ''}`);
    if (seqs.length) parts.push(`${seqs.length} sequence${seqs.length > 1 ? 's' : ''}`);
    if (folders.length) parts.push(`${folders.length} folder${folders.length > 1 ? 's' : ''} (contents move up a level)`);
    if (!parts.length) return;
    if ((clipCount || seqs.length) && !(await confirmDialog('Remove from project?', `${parts.join(', ')}. Files on disk are not deleted.`, 'Remove'))) return;
    tab.apply('Remove from project', (d) => {
      for (const f of d.folders.filter((x) => set.has(x.id))) {
        for (const x of [...d.folders, ...d.media, ...d.sequences]) if ((x.parent ?? x.folder) === f.id) { if ('parent' in x && d.folders.includes(x)) x.parent = f.parent; else x.folder = f.parent; }
      }
      d.folders = d.folders.filter((x) => !set.has(x.id));
      d.media = d.media.filter((x) => !set.has(x.id));
      d.sequences = d.sequences.filter((x) => !set.has(x.id));
      for (const s of d.sequences) s.clips = s.clips.filter((c) => !c.media || !set.has(c.media));
    });
    tab.ui.set({ binSelection: [] });
    tab.ensureSequence();
  };
  const importCaptions = async (file) => {
    const text = await file.text();
    const cues = parseSubtitles(text);
    if (!cues.length) { notify('No captions found in that file', 'error'); return; }
    if (!tab.seq) { notify('Open a sequence first', 'error'); return; }
    tab.apply('Import captions', (d, ds) => { const r = addCaptions(ds, cues); tab.ui.set({ selection: r.ids.slice(0, 1) }); });
    notify(`Added ${cues.length} captions on a new "Captions" track`, 'success');
  };
  const exportCaptions = () => {
    const s = tab.seq;
    if (!s) return;
    const text = s.clips.filter((c) => c.type === 'text');
    if (!text.length) { notify('No text clips in this sequence', 'error'); return; }
    const blob = new Blob([toSrt(text)], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${s.name}.srt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ------------------------------------------------------------ selection / dnd
  const click = (e, id) => {
    if (e.ctrlKey || e.metaKey) tab.ui.set({ binSelection: selSet.has(id) ? sel.filter((x) => x !== id) : [...sel, id] });
    else if (e.shiftKey && sel.length) {
      const order = [...listRef.current.querySelectorAll('[data-bin]')].map((el) => el.dataset.bin);
      const a = order.indexOf(sel[sel.length - 1]), b = order.indexOf(id);
      tab.ui.set({ binSelection: [...new Set([...sel, ...order.slice(Math.min(a, b), Math.max(a, b) + 1)])] });
    } else tab.ui.set({ binSelection: [id] });
  };
  const dragStart = (e, id) => {
    const ids = selSet.has(id) ? sel : [id];
    if (!selSet.has(id)) tab.ui.set({ binSelection: [id] });
    const mediaIds = ids.filter((x) => doc.media.some((m) => m.id === x));
    e.dataTransfer.setData('application/x-ce-items', JSON.stringify({ media: mediaIds, ids }));
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  const dragOverTarget = (e, folder) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes('application/x-ce-items') && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
    if (dropOn !== folder) setDropOn(folder);
  };
  const dropTarget = (e, folder) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(undefined);
    if (e.dataTransfer.files.length) { importFiles(e.dataTransfer.files, folder); return; }
    try {
      const { ids } = JSON.parse(e.dataTransfer.getData('application/x-ce-items'));
      if (ids?.length) moveTo(ids.filter((x) => x !== folder), folder);
    } catch { /* ignore */ }
  };

  const itemMenu = (e, item, kind) => {
    e.preventDefault();
    if (!selSet.has(item.id)) tab.ui.set({ binSelection: [item.id] });
    const ids = selSet.has(item.id) ? sel : [item.id];
    const st = kind === 'media' ? mediaStatus[item.id] : null;
    openMenu(e.clientX, e.clientY, [
      kind === 'seq' ? { label: 'Open in timeline', icon: 'seq', action: () => tab.setSequence(item.id) } : null,
      kind === 'seq' ? { label: 'Duplicate', icon: 'copy', action: () => duplicateSeq(tab, item.id) } : null,
      kind === 'seq' ? { label: 'Reframe with Claude…', icon: 'crop', action: () => openReframe(tab, item.id) } : null,
      kind === 'seq' ? { label: 'Export XML (Premiere / Resolve)…', icon: 'download', action: () => exportXml(tab, item.id) } : null,
      kind === 'seq' ? prerenderMenuItem(tab, item.id) : null,
      ...(kind === 'seq' ? chatMenuItems(tab, item.id) : []),
      kind === 'seq' ? { separator: true } : null,
      kind === 'media' ? { label: 'Preview / mark in-out…', icon: 'eye', action: () => openDialog(SourcePreview, { tab, media: item }) } : null,
      kind === 'media' && item.type !== 'audio' ? { label: 'New sequence from clip', icon: 'seq', action: () => openDialog(NewSequenceDialog, { tab, fromMedia: item, folder: item.folder }) } : null,
      kind === 'folder' ? { label: 'New folder inside', icon: 'folderPlus', action: () => newFolder(item.id) } : null,
      kind === 'folder' ? { label: 'New sequence here', icon: 'seq', action: () => openDialog(NewSequenceDialog, { tab, folder: item.id }) } : null,
      { label: 'Rename', icon: 'edit', shortcut: shortcutLabel('bin.rename'), action: () => setRenaming(item.id) },
      { label: 'Move to', icon: 'folder', items: [
        { label: 'Project root', action: () => moveTo(ids, null) },
        ...doc.folders.filter((f) => !ids.includes(f.id)).map((f) => ({ label: folderPath(doc, f.id), action: () => moveTo(ids, f.id) })),
      ] },
      kind === 'media' && isMotion(item) ? { separator: true } : null,
      kind === 'media' && isMotion(item) ? { label: 'Edit composition code', icon: 'code', action: () => motionActions.openCode(tab, item) } : null,
      kind === 'media' && isMotion(item) ? { label: 'Show composition file', icon: 'external', action: () => motionActions.reveal(tab, item) } : null,
      kind === 'media' && isMotion(item) && st?.motion?.state === 'queued' ? { label: 'Render now', icon: 'sparkle', action: () => motionActions.renderNow(tab, item) } : null,
      kind === 'media' && isMotion(item) ? { label: 'Render again', icon: 'refresh', action: () => motionActions.rerender(tab, item) } : null,
      kind === 'media' ? { separator: true } : null,
      kind === 'media' && !isMotion(item) ? { label: 'Reload footage', icon: 'refresh', action: () => tab.reloadMedia() } : null,
      kind === 'media' && !isMotion(item) ? { label: 'Replace footage…', icon: 'refresh', action: () => replaceFootage(tab, item) } : null,
      kind === 'media' ? { label: 'Show in Explorer', icon: 'external', action: () => post(`/api/p/${tab.projectId}/reveal`, { path: item.path }) } : null,
      kind === 'media' ? { label: 'Copy file path', icon: 'copy', action: () => { navigator.clipboard?.writeText(st?.abs || item.path); notify('Path copied'); } } : null,
      kind === 'media' && item.type !== 'image' && !isMotion(item) ? { label: st?.proxy === 'ready' ? 'Proxy ready' : st?.proxy === 'running' ? 'Generating proxy…' : 'Generate preview proxy', icon: 'refresh', disabled: st?.proxy === 'ready' || st?.proxy === 'running',
        action: () => post(`/api/p/${tab.projectId}/media/${item.id}/proxy`) } : null,
      { separator: true },
      { label: 'Remove from project', icon: 'trash', danger: true, shortcut: shortcutLabel('bin.delete'), action: () => removeItems(ids) },
    ]);
  };

  // ------------------------------------------------------------ rendering
  const q = query.trim().toLowerCase();
  const rows = [];
  const pushItem = (kind, item, depth) => rows.push({ kind, item, depth });
  const walk = (parent, depth) => {
    for (const f of doc.folders.filter((x) => (x.parent || null) === parent).sort(byName)) {
      pushItem('folder', f, depth);
      if (openFolders[f.id]) walk(f.id, depth + 1);
    }
    for (const s of doc.sequences.filter((x) => (x.folder || null) === parent).sort(byName)) pushItem('seq', s, depth);
    for (const m of doc.media.filter((x) => (x.folder || null) === parent).sort(byName)) pushItem('media', m, depth);
  };
  if (q) {
    for (const s of doc.sequences) if (s.name.toLowerCase().includes(q)) pushItem('seq', s, 0);
    // media also by Claude's tags and role
    for (const m of doc.media) if (m.name.toLowerCase().includes(q) || (Array.isArray(m.tags) && m.tags.some((x) => String(x).toLowerCase().includes(q))) || String(m.role || '').includes(q)) pushItem('media', m, 0);
  } else if (grid) {
    for (const f of doc.folders.filter((x) => (x.parent || null) === gridFolder).sort(byName)) pushItem('folder', f, 0);
    for (const s of doc.sequences.filter((x) => (x.folder || null) === gridFolder).sort(byName)) pushItem('seq', s, 0);
    for (const m of doc.media.filter((x) => (x.folder || null) === gridFolder).sort(byName)) pushItem('media', m, 0);
  } else walk(null, 0);

  const single = sel.length === 1 ? doc.media.find((m) => m.id === sel[0]) : null;

  const onKeyDown = (e) => {
    if (e.target.tagName === 'INPUT') return;
    const cmd = commandOf(e, 'bin');
    if (cmd === 'bin.delete') { e.preventDefault(); e.stopPropagation(); removeItems(sel); }
    else if (cmd === 'bin.rename' && sel.length === 1) { e.preventDefault(); setRenaming(sel[0]); }
    else if (cmd === 'bin.open' && sel.length === 1) {
      const s = doc.sequences.find((x) => x.id === sel[0]);
      if (s) tab.setSequence(s.id);
      else if (grid && doc.folders.some((x) => x.id === sel[0])) openGridFolder(sel[0]);
    } else if (cmd === 'bin.selectAll') {
      e.preventDefault(); e.stopPropagation();
      tab.ui.set({ binSelection: rows.map((r) => r.item.id) });
    }
  };

  return html`<aside class="panel bin" tabIndex="0" onKeyDown=${onKeyDown}>
    <header class="panel-head">
      <span class="panel-title">Project</span>
      <div class="spacer"></div>
      ${window.jimmyApp ? null : html`<${IconButton} icon="upload" title="Upload files into the project" onClick=${() => fileInput.current.click()} />`}
      <${IconButton} icon="link" title="Import from disk (link in place — no copy)" onClick=${linkFromDisk} />
      <${IconButton} icon="wand" title="Organise: put media into folders by what they are (A-Roll, B-Roll, Music…), using Claude's tags where it has added them" onClick=${() => openOrganise(tab)} />
      <${IconButton} icon="folderPlus" title="New folder" onClick=${() => newFolder()} />
      <${IconButton} icon="seq" title="New sequence" onClick=${() => openDialog(NewSequenceDialog, { tab, folder: currentFolder() })} />
      <${IconButton} icon="sparkle" title="New motion graphic (HTML / CSS / JS rendered to transparent video)" onClick=${() => openDialog(NewMotionDialog, { tab, folder: currentFolder() })} />
      <${IconButton} icon="more" title="More" onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom + 4, [
          { label: 'Import captions (SRT / VTT)…', icon: 'captions', action: () => srtInput.current.click() },
          { label: 'Export captions as SRT', icon: 'download', action: exportCaptions },
          { separator: true },
          { label: 'Reload missing footage', icon: 'refresh', action: () => tab.reloadMedia() },
          { label: 'Re-scan all media files', icon: 'refresh', action: () => post(`/api/p/${tab.projectId}/media/refresh`).then(() => { tab.engine.reloadMedia(); notify('Media re-scanned'); }) },
          { label: 'Open project folder', icon: 'external', action: () => post(`/api/p/${tab.projectId}/reveal`, {}) },
          { label: 'Project snapshots…', icon: 'clock', action: () => openSnapshots(tab) },
        ]);
      }} />
      <input ref=${fileInput} type="file" multiple hidden accept="video/*,audio/*,image/*,.mov,.mkv,.mxf" onChange=${(e) => { importFiles(e.target.files, currentFolder()); e.target.value = ''; }} />
      <input ref=${srtInput} type="file" hidden accept=".srt,.vtt" onChange=${(e) => { if (e.target.files[0]) importCaptions(e.target.files[0]); e.target.value = ''; }} />
    </header>
    <div class="bin-searchrow"><div class="bin-search">
      <${Icon} name="search" size=${14} />
      <input placeholder="Search media & sequences" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape') setQuery(''); }} />
      ${query ? html`<button class="icon-btn" onClick=${() => setQuery('')}><${Icon} name="x" size=${12} /></button>` : null}
    </div>
    <div class="bin-views">
      <${IconButton} icon="viewList" size=${14} title="List" active=${view === 'list'} onClick=${() => setView('list')} />
      <${IconButton} icon="viewTiles" size=${14} title="Tiles: small thumbnails; move the mouse over a clip to scrub through it" active=${view === 'tiles'} onClick=${() => setView('tiles')} />
      <${IconButton} icon="viewGallery" size=${14} title="Gallery: large thumbnails; move the mouse over a clip to scrub through it" active=${view === 'gallery'} onClick=${() => setView('gallery')} />
    </div></div>
    ${uploads.length ? html`<div class="bin-uploads">${uploads.map((u) => html`<div class="upload-row"><span>${u.name}</span><div class="progress"><div style=${{ width: `${Math.round(u.progress * 100)}%` }}></div></div></div>`)}</div>` : null}
    ${grid && !q ? html`<div class="bin-crumbs">
      <button class="bin-crumb" disabled=${!gridFolder} onClick=${() => openGridFolder(null)}
        onDragOver=${(e) => dragOverTarget(e, null)} onDrop=${(e) => dropTarget(e, null)}>Project</button>
      ${folderChain(doc, gridFolder).map((f) => html`<${Icon} name="next" size=${10} /><button class="bin-crumb" disabled=${f.id === gridFolder} onClick=${() => openGridFolder(f.id)}
        onDragOver=${(e) => dragOverTarget(e, f.id)} onDrop=${(e) => dropTarget(e, f.id)}>${f.name}</button>`)}
    </div>` : null}
    <div class="bin-list ${grid ? `is-grid is-${view}` : ''} ${dropOn === null ? 'is-drop' : ''}" ref=${listRef}
      onDragOver=${(e) => dragOverTarget(e, null)} onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOn(undefined); }}
      onDrop=${(e) => dropTarget(e, null)}
      onPointerDown=${(e) => { if (e.target === e.currentTarget) tab.ui.set({ binSelection: [] }); }}>
      ${rows.length === 0 ? html`<${Empty} icon="film" title=${q ? 'No matches' : 'No media yet'}>
        ${q ? null : window.jimmyApp ? html`Drop files here or <button class="link-btn" onClick=${linkFromDisk}>import</button> (linked where they are, not copied).<br/>Claude can add media too.`
          : html`Drop files here, <button class="link-btn" onClick=${() => fileInput.current.click()}>upload</button>, or <button class="link-btn" onClick=${linkFromDisk}>import from disk</button>.<br/>Claude can add media too.`}
      </${Empty}>` : null}
      ${rows.map(({ kind, item, depth }) => html`<${Memo} C=${grid ? BinTile : BinRow} key=${item.id} tab=${tab} kind=${kind} item=${item} depth=${depth}
        selected=${selSet.has(item.id)} active=${kind === 'seq' && item.id === seqId} open=${!!openFolders[item.id]}
        status=${kind === 'media' ? mediaStatus[item.id] : null} uses=${kind === 'media' ? usage(item.id) : 0}
        renaming=${renaming === item.id} onRename=${(name) => rename(item.id, name)} onCancelRename=${() => setRenaming(null)}
        dropOn=${dropOn === item.id}
        onClick=${(e) => click(e, item.id)}
        onDblClick=${() => (kind === 'seq' ? tab.setSequence(item.id) : kind === 'folder' ? (grid ? openGridFolder(item.id) : tab.ui.set({ openFolders: { ...openFolders, [item.id]: !openFolders[item.id] } })) : openDialog(SourcePreview, { tab, media: item }))}
        onToggle=${() => tab.ui.set({ openFolders: { ...openFolders, [item.id]: !openFolders[item.id] } })}
        onContextMenu=${(e) => itemMenu(e, item, kind)}
        onDragStart=${(e) => dragStart(e, item.id)}
        onDragOver=${kind === 'folder' ? (e) => dragOverTarget(e, item.id) : undefined}
        onDrop=${kind === 'folder' ? (e) => dropTarget(e, item.id) : undefined} />`)}
    </div>
    ${single ? html`<${MediaInfo} tab=${tab} media=${single} status=${mediaStatus[single.id]} uses=${usage(single.id)} />` : null}
  </aside>`;
}

// one collator for every comparison (localeCompare with options makes a new one each time)
const collator = new Intl.Collator(undefined, { numeric: true });
const byName = (a, b) => collator.compare(a.name, b.name);
function folderPath(doc, id) {
  const parts = [];
  let f = doc.folders.find((x) => x.id === id);
  while (f) { parts.unshift(f.name); f = doc.folders.find((x) => x.id === f.parent); }
  return parts.join(' / ');
}

function BinRow({ tab, kind, item, depth, selected, active, open, status, uses, renaming, onRename, onCancelRename, dropOn, onClick, onDblClick, onToggle, onContextMenu, onDragStart, onDragOver, onDrop }) {
  const inputRef = useRef(null);
  useEffect(() => { if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);
  const doc = tab.doc;
  let thumb, meta = '', badge = null;
  if (kind === 'folder') {
    const n = doc.media.filter((m) => m.folder === item.id).length + doc.sequences.filter((s) => s.folder === item.id).length + doc.folders.filter((f) => f.parent === item.id).length;
    thumb = html`<span class="bin-chevron" onClick=${(e) => { e.stopPropagation(); onToggle(); }}><${Icon} name=${open ? 'down' : 'next'} size=${12} /></span><span class="bin-icon is-folder"><${Icon} name=${open ? 'folderOpen' : 'folder'} size=${15} /></span>`;
    meta = n ? String(n) : '';
  } else if (kind === 'seq') {
    thumb = html`<span class="bin-icon is-seq" style=${{ '--ar': `${item.width}/${item.height}` }}><${Icon} name="seq" size=${14} /></span>`;
    meta = `${item.width}×${item.height} · ${shortTime(sequenceDuration(item))}`;
  } else {
    const poster = status?.poster && status.key ? mediaUrl(tab.projectId, item.id, 'poster', status.key) : null;
    thumb = poster
      ? html`<span class="bin-thumb"><img src=${poster} loading="lazy" draggable="false" /></span>`
      : html`<span class="bin-icon is-${item.type}"><${Icon} name=${isMotion(item) ? 'sparkle' : MEDIA_ICON[item.type] || 'film'} size=${14} /></span>`;
    meta = [item.type !== 'image' && item.duration ? shortTime(item.duration) : null, item.width ? `${item.width}×${item.height}` : null].filter(Boolean).join(' · ');
    badge = mediaBadge(tab, item, status, uses);
  }
  return html`<div class="bin-row ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''} ${dropOn ? 'is-drop' : ''}" data-bin=${item.id}
    style=${{ paddingLeft: `${8 + depth * 14}px` }} draggable=${!renaming}
    onClick=${onClick} onDblClick=${onDblClick} onContextMenu=${onContextMenu} onDragStart=${onDragStart} onDragOver=${onDragOver} onDrop=${onDrop}>
    ${thumb}
    <div class="bin-text">
      ${renaming
        ? html`<input ref=${inputRef} class="bin-rename" defaultValue=${item.name} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.dataset.cancel = '1'; onCancelRename(); } }} onBlur=${(e) => { if (!e.target.dataset.cancel) onRename(e.target.value); }} />`
        : html`<span class="bin-name" title=${item.path || item.name}>${item.name}</span>`}
      ${meta && !renaming ? html`<span class="bin-meta">${meta}</span>` : null}
    </div>
    ${badge}
  </div>`;
}

// What a media item is doing (rendering, offline, making a proxy, still being read) or how often it is used
function mediaBadge(tab, item, status, uses) {
  const mo = isMotion(item) ? status?.motion : null;
  if (mo?.state === 'rendering' || mo?.state === 'queued' || (isMotion(item) && !mo)) return html`<span class="bin-badge is-motion" title="Rendering the motion graphic">${mo?.state === 'rendering' ? `${Math.round((mo.progress || 0) * 100)}%` : 'queued'}</span>`;
  if (mo?.state === 'error') return html`<span class="bin-badge is-error" title=${mo.error}>error</span>`;
  if (status?.exists === false) return html`<button class="bin-badge is-error is-reload" title="File not found: ${item.path}. Click to look again (e.g. after reconnecting the drive)" onClick=${(e) => { e.stopPropagation(); tab.reloadMedia(); }}><${Icon} name="refresh" size=${10} /> offline</button>`;
  if (status?.error) return html`<button class="bin-badge is-error is-reload" title="${status.error}. Click to reload" onClick=${(e) => { e.stopPropagation(); tab.reloadMedia(); }}><${Icon} name="refresh" size=${10} /> error</button>`;
  if (status?.proxy === 'running' || status?.proxy === 'queued') return html`<span class="bin-badge" title="Making a preview proxy">${status.proxy === 'queued' ? 'queued' : `${Math.round((status.proxyProgress || 0) * 100)}%`}</span>`;
  if (status && !status.probed) return html`<span class="spinner spinner-xs"></span>`;
  if (uses) return html`<span class="bin-uses" title="Used in ${uses} clip${uses > 1 ? 's' : ''}">${uses}</span>`;
  return null;
}

// the folders from the project root down to `id`
function folderChain(doc, id) {
  const chain = [];
  let f = doc.folders.find((x) => x.id === id);
  while (f) { chain.unshift(f); f = doc.folders.find((x) => x.id === f.parent); }
  return chain;
}

// A tile in the Tiles and Gallery views. A video shows its poster; moving the mouse across it scrubs through the clip
// using the thumbnail strip the timeline already has (up to 150 frames from the whole clip, so it is instant and
// decodes nothing), with a line where the mouse is and the time there.
function BinTile({ tab, kind, item, selected, active, status, uses, renaming, onRename, onCancelRename, dropOn, onClick, onDblClick, onContextMenu, onDragStart, onDragOver, onDrop }) {
  const inputRef = useRef(null);
  const picRef = useRef(null);
  const scrubRef = useRef(null);
  useEffect(() => { if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); } }, [renaming]);
  const doc = tab.doc;
  const thumbs = kind === 'media' && item.type === 'video' && status?.thumbs && status.key ? status.thumbs : null;
  const poster = kind === 'media' && status?.poster && status.key ? mediaUrl(tab.projectId, item.id, 'poster', status.key) : null;
  const ar = kind === 'seq' ? item.width / item.height : item.width && item.height ? item.width / item.height : 16 / 9;
  let pic;
  if (kind === 'folder') {
    const n = doc.media.filter((m) => m.folder === item.id).length + doc.sequences.filter((s) => s.folder === item.id).length + doc.folders.filter((f) => f.parent === item.id).length;
    pic = html`<span class="bin-tile-icon is-folder"><${Icon} name="folder" size=${28} /><span class="bin-tile-count">${n}</span></span>`;
  } else if (kind === 'seq' || !poster) {
    pic = html`<span class="bin-tile-icon is-${kind === 'seq' ? 'seq' : item.type}"><${Icon} name=${kind === 'seq' ? 'seq' : isMotion(item) ? 'sparkle' : MEDIA_ICON[item.type] || 'film'} size=${26} /></span>`;
  } else {
    pic = html`<span class="bin-tile-frame" ref=${picRef} style=${{ aspectRatio: String(ar), [ar >= 16 / 9 ? 'width' : 'height']: '100%', backgroundImage: `url("${poster}")` }}></span>`;
  }
  // scrubbing: the strip goes in as the background and slides to the frame under the mouse (no re-render)
  const scrub = (e) => {
    const el = picRef.current;
    if (!thumbs || !el) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width));
    const i = Math.floor(frac * thumbs.count);
    el.style.backgroundImage = `url("${mediaUrl(tab.projectId, item.id, 'thumbs', status.key)}")`;
    el.style.backgroundSize = `${thumbs.count * 100}% 100%`;
    el.style.backgroundPosition = `${thumbs.count > 1 ? (i / (thumbs.count - 1)) * 100 : 0}% 0`;
    const s = scrubRef.current;
    if (s) { s.style.left = `${frac * 100}%`; s.dataset.t = shortTime(frac * (item.duration || 0)); s.classList.toggle('is-right', frac > 0.6); s.hidden = false; }
  };
  const unscrub = () => {
    const el = picRef.current;
    if (el && poster) { el.style.backgroundImage = `url("${poster}")`; el.style.backgroundSize = ''; el.style.backgroundPosition = ''; }
    if (scrubRef.current) scrubRef.current.hidden = true;
  };
  const meta = kind === 'seq' ? shortTime(sequenceDuration(item)) : kind === 'media' && item.type !== 'image' && item.duration ? shortTime(item.duration) : '';
  return html`<div class="bin-tile ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''} ${dropOn ? 'is-drop' : ''}" data-bin=${item.id} draggable=${!renaming}
    title=${kind === 'media' ? item.path || item.name : item.name}
    onClick=${onClick} onDblClick=${onDblClick} onContextMenu=${onContextMenu} onDragStart=${onDragStart} onDragOver=${onDragOver} onDrop=${onDrop}>
    <div class="bin-tile-pic" onPointerMove=${thumbs ? scrub : undefined} onPointerLeave=${thumbs ? unscrub : undefined}>
      ${pic}
      ${thumbs ? html`<span class="bin-tile-scrub" ref=${scrubRef} hidden></span>` : null}
      ${meta ? html`<span class="bin-tile-dur">${meta}</span>` : null}
      ${kind === 'media' ? html`<span class="bin-tile-badge">${mediaBadge(tab, item, status, uses)}</span>` : null}
    </div>
    ${renaming
      ? html`<input ref=${inputRef} class="bin-rename" defaultValue=${item.name} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.dataset.cancel = '1'; onCancelRename(); } }} onBlur=${(e) => { if (!e.target.dataset.cancel) onRename(e.target.value); }} />`
      : html`<span class="bin-tile-name">${item.name}</span>`}
  </div>`;
}

function MediaInfo({ tab, media, status, uses }) {
  // a transcript Claude saved for this footage (vedit transcript save), found by the file's contents
  const [tr, setTr] = useState(null);
  useEffect(() => {
    setTr(null);
    if (isMotion(media) || media.type === 'image') return undefined;
    let live = true;
    get(`/api/p/${tab.projectId}/media/${media.id}/transcript`).then((r) => { if (live) setTr(r); }).catch(() => {});
    return () => { live = false; };
  }, [media.id, status?.key]);
  return html`<div class="bin-info">
    <div class="bin-info-name">${media.name}</div>
    <div class="bin-info-grid">
      <span>Type</span><span>${isMotion(media) ? 'motion graphic' : media.type}${media.codec ? ` · ${media.codec}` : ''}</span>
      ${isMotion(media) ? html`<span>Source</span><span class="bin-info-path" title=${media.motion.src}>${media.motion.src}</span>` : null}
      ${media.width ? html`<span>Size</span><span>${media.width}×${media.height}${media.fps ? ` · ${media.fps} fps` : ''}</span>` : null}
      ${media.duration ? html`<span>Length</span><span>${shortTime(media.duration)}${media.hasAudio && media.type === 'video' ? ' · with audio' : ''}</span>` : null}
      <span>File</span><span class="bin-info-path" title=${status?.abs || media.path}>${media.path}${status?.meta?.size ? ` · ${fmtBytes(status.meta.size)}` : ''}</span>
      <span>Preview</span><span>${status?.exists === false ? 'offline' : status?.proxy === 'ready' ? 'proxy' : status?.browserOk === false ? `proxy ${status?.proxy || ''}` : 'original'}</span>
      <span>Used</span><span>${uses} clip${uses === 1 ? '' : 's'}</span>
      ${tr && !tr.offline ? html`<span>Transcript</span><span title=${tr.file || ''}>${tr.exists ? `saved · ${tr.summary.segments} lines${tr.summary.language ? ` · ${tr.summary.language}` : ''}` : 'none yet (Claude saves one when it transcribes)'}</span>` : null}
      <span>Sort</span><span>${Object.fromEntries(ROLES)[roleOf(media)]}${Array.isArray(media.tags) && media.tags.length ? ` · ${media.tags.join(', ')}` : ''}</span>
    </div>
  </div>`;
}
