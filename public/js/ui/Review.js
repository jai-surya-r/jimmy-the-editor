// Review mode (Frame.io-style): rendered versions, frame-accurate player, timecoded comments with
// drawings, approvals, version compare — and a one-click hand-off of the notes to Claude.
// A version can also be a timeline round: nothing is rendered, the stage plays the live timeline and the
// comments sit on the sequence's timecodes (they show on the Edit timeline's ruler too).
import { html, Icon, IconButton, Button, Select, Segmented, Empty, timeAgo } from './common.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore, loadPref, savePref } from '../core/store.js';
import { app } from '../core/app.js';
import { uid, timecode, findSequence, clamp, sequenceDuration } from '../core/model.js';
import { projectFileUrl, post, get } from '../core/api.js';
import { openDialog, openMenu, notify, overlays } from '../core/notify.js';
import { ExportDialog, confirmDialog } from './dialogs.js';
import { sendToClaude, useClaudeBusy } from './ClaudePanel.js';
import { GuidesOverlay, GuideButtons } from './Guides.js';
import { Viewer } from './Viewer.js';
import { audioGraph } from '../core/playback.js';
import { commandOf } from './keymap.js';
import { autoFixStore, setAutoFix, liveRounds, rerun, sendNow, queued, stalled, BATCH } from './autofix.js';
import { useMonitorZoom, useZoomWheel, useFollow, MonitorRuler, ZoomBar } from './monitorbar.js';

const STATUS = {
  in_review: { label: 'In review', cls: 'is-review' },
  changes: { label: 'Changes requested', cls: 'is-changes' },
  approved: { label: 'Approved', cls: 'is-approved' },
};
const COLORS = ['#ff4d6a', '#f5c451', '#3ddc97', '#4fa3ff', '#ffffff'];
const isRound = (v) => v?.kind === 'timeline';

// Start a review round on the live timeline: no render, just a saved copy of the sequence to go back to.
async function startRound(tab, seqId) {
  try {
    tab.engine.pause();
    const r = await post(`/api/p/${tab.projectId}/rounds`, { sequence: seqId || tab.ui.get().sequenceId });
    tab.ui.set({ reviewVersion: r.versionId });
  } catch (err) { notify(err.message, 'error'); }
}

// The sequence's live timeline in Review: its latest round, made the first time Review opens the sequence.
const latestRound = (versions, seqId) => versions.filter((v) => isRound(v) && v.sequence === seqId).sort((a, b) => b.number - a.number)[0] || null;
const ensuring = new Set();
async function ensureRound(tab, seqId) {
  const key = `${tab.projectId}|${seqId}`;
  if (!seqId || ensuring.has(key)) return;
  ensuring.add(key);
  try { await post(`/api/p/${tab.projectId}/rounds`, { sequence: seqId, ensure: true }); } catch (err) { notify(err.message, 'error'); } finally { ensuring.delete(key); }
}

// Put the sequence back the way it was when the round started (one undo step).
async function restoreRound(tab, v) {
  if (!(await confirmDialog(`Restore the timeline to ${v.name}?`, 'The sequence goes back to how it was when this round started. You can undo it in Edit.', 'Restore'))) return;
  try {
    const snap = await get(`/api/p/${tab.projectId}/rounds/${v.id}`);
    tab.apply(`Restore ${v.name}`, (d) => {
      const i = d.sequences.findIndex((x) => x.id === snap.sequence.id);
      if (i < 0) d.sequences.push(snap.sequence); else d.sequences[i] = snap.sequence;
      for (const m of snap.media || []) if (!d.media.some((x) => x.id === m.id)) d.media.push(m);
    });
    notify(`Timeline restored to ${v.name}`, 'success');
  } catch (err) { notify(err.message, 'error'); }
}

// The live timeline standing in for the review <video>: the same calls, backed by the editor's playback engine.
function timelinePlayer(tab) {
  const eng = tab.engine;
  return {
    get currentTime() { return eng.t; },
    set currentTime(x) { eng.seek(x); },
    get paused() { return !eng.playing; },
    get duration() { return tab.seq ? sequenceDuration(tab.seq) : 0; },
    get playbackRate() { return eng.rate > 0 ? eng.rate : 1; },
    set playbackRate(r) { eng.rate = r; },
    play() { if (!(eng.rate > 0)) eng.rate = 1; eng.play(); return Promise.resolve(); },
    pause() { eng.pause(); },
  };
}

export function ReviewMode({ tab }) {
  const reviews = useStore(tab.store, (s) => s.reviews);
  const doc = useStore(tab.store, (s) => s.doc);
  const versionId = useStore(tab.ui, (s) => s.reviewVersion);
  const seqId = useStore(tab.ui, (s) => s.sequenceId);
  const jobs = useStore(app, (s) => s.jobs);
  const versions = reviews?.versions || [];
  // the timeline is what Review shows unless a draft is picked
  const picked = versions.find((v) => v.id === versionId);
  const version = picked || latestRound(versions, seqId);
  useEffect(() => { if (reviews && !picked && seqId && !latestRound(versions, seqId)) ensureRound(tab, seqId); }, [reviews, picked, seqId]);
  const running = Object.values(jobs).filter((j) => j.projectId === tab.projectId && j.kind === 'video' && !['done', 'error', 'canceled'].includes(j.status));

  return html`<div class="review">
    <${VersionList} tab=${tab} doc=${doc} versions=${versions} comments=${reviews?.comments || []} current=${version} running=${running} />
    ${version
      ? html`<${ReviewStage} key=${version.id} tab=${tab} version=${version} versions=${versions} reviews=${reviews} doc=${doc} />`
      : seqId ? html`<div class="review-empty"><span class="spinner"></span></div>`
      : html`<div class="review-empty">
          <${Empty} icon="message" title="Nothing to review yet">
            Start a review round to scrub the timeline itself and leave comments on it: nothing is rendered. Or export a draft when someone outside the app needs a video.
            <div class="btn-row center"><${Button} kind="primary" icon="message" onClick=${() => startRound(tab, seqId)}>Review the timeline</${Button}>
              <${Button} icon="download" onClick=${() => openDialog(ExportDialog, { tab })}>Export a draft</${Button}></div>
          </${Empty}>
        </div>`}
  </div>`;
}

// Versions, one dropdown per sequence: click a sequence to show its versions, newest first. Exported videos that
// aren't in Review yet (renders/ and the export folders, e.g. 3_Exports) sit in the dropdown of the sequence
// they're named after; click one to review it.
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// Removing a version only takes it out of Review: Jimmy never deletes the video file.
async function deleteVersions(tab, list) {
  if (list.some((v) => v.id === tab.ui.get().reviewVersion)) tab.ui.set({ reviewVersion: null });
  try {
    return await post(`/api/p/${tab.projectId}/versions/delete`, { ids: list.map((v) => v.id) });
  } catch (err) { notify(err.message, 'error'); return null; }
}

function VersionList({ tab, doc, versions, comments, current, running }) {
  const [files, setFiles] = useState(null);
  // fresh: look through the export folders again (the server otherwise answers from a look up to 15 s old)
  const loadFiles = (fresh = true) => get(`/api/p/${tab.projectId}/exports${fresh ? '?fresh=1' : ''}`).then((r) => setFiles(r.files)).catch(() => setFiles([]));
  // the next look is asked for once the last one has answered (on a busy NAS one can take longer than the gap)
  useEffect(() => {
    let live = true, t = null;
    const tick = (fresh) => loadFiles(fresh).finally(() => { if (live) t = setTimeout(() => tick(false), 10000); });
    tick(true);
    return () => { live = false; clearTimeout(t); };
  }, [tab.projectId, versions.length, running.length]);
  const groups = useMemo(() => {
    const m = new Map();
    const group = (key, name) => {
      if (!m.has(key)) m.set(key, { key, seqId: key === 'other' ? null : key, name, list: [], files: [] });
      return m.get(key);
    };
    for (const s of doc?.sequences || []) group(s.id, s.name); // every sequence, with its Timeline even before any export
    for (const v of versions) group(v.sequence || 'other', findSequence(doc, v.sequence)?.name || v.sequenceName || 'Other').list.push(v);
    // exported files not in Review: under the sequence whose name starts the file name (the longest match wins)
    const seqs = [...(doc?.sequences || [])].sort((a, b) => b.name.length - a.name.length);
    for (const f of files || []) {
      if (f.inReview) continue;
      const s = seqs.find((x) => squash(x.name) && squash(f.name).startsWith(squash(x.name)));
      group(s ? s.id : 'other', s ? s.name : 'Other').files.push(f);
    }
    // the live timeline (the latest round) leads its sequence's list, then everything newest first
    for (const g of m.values()) { const top = latestRound(g.list, g.seqId); g.list.sort((a, b) => (b === top) - (a === top) || b.number - a.number); g.live = top; }
    return [...m.values()].sort((a, b) => (a.key === 'other') - (b.key === 'other'));
  }, [versions, doc, files]);
  const prefKey = `review.open.${tab.projectId}`;
  const [openSet, setOpenSet] = useState(() => new Set(loadPref(prefKey, null) || []));
  const [touched, setTouched] = useState(() => loadPref(prefKey, null) != null);
  // until the editor opens or closes one, the dropdown of the version on screen is open
  const isOpen = (g) => (touched ? openSet.has(g.key) : current ? (current.sequence || 'other') === g.key : groups[0] === g);
  const toggle = (g) => {
    const next = new Set(touched ? openSet : groups.filter(isOpen).map((x) => x.key));
    if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
    setOpenSet(next);
    setTouched(true);
    savePref(prefKey, [...next]);
  };
  const openCount = (v) => comments.filter((c) => c.version === v.id && !c.resolved).length;
  const removeOne = async (v) => {
    const ok = isRound(v)
      ? await confirmDialog(`Remove ${v.name}?`, 'This timeline round leaves Review with its comments. The timeline itself is not changed.', 'Remove')
      : await confirmDialog(`Remove ${v.name} from Review?`, 'Its comments are removed too. The video file stays where it is.', 'Remove');
    if (ok) await deleteVersions(tab, [v]);
  };
  const removeOlder = async (g) => {
    const older = g.list.slice(1);
    if (!older.length) return;
    if (!(await confirmDialog(`Remove older versions of ${g.name} from Review?`, `Keeps ${g.list[0]?.name || 'the newest version'}. Removes ${older.length} older version${older.length > 1 ? 's' : ''} (${older.map((v) => v.name).join(', ')}) with their comments. The video files stay where they are.`, 'Remove'))) return;
    const r = await deleteVersions(tab, older);
    if (r) { notify(`Removed ${older.length} from ${g.name}`, 'success'); loadFiles(); }
  };
  const menu = (e, v) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, isRound(v) ? [
      { label: 'Open its sequence in Edit', icon: 'seq', disabled: !findSequence(doc, v.sequence), action: () => { tab.setSequence(v.sequence); tab.ui.set({ mode: 'edit' }); } },
      { label: 'Restore the timeline to this round', icon: 'undo', disabled: !findSequence(doc, v.sequence), action: () => restoreRound(tab, v) },
      { separator: true },
      { label: 'Remove round', icon: 'x', action: () => removeOne(v) },
    ] : [
      { label: 'Show file in Explorer', icon: 'external', action: () => post(`/api/p/${tab.projectId}/reveal`, { path: v.file }) },
      { label: 'Open its sequence in Edit', icon: 'seq', disabled: !findSequence(doc, v.sequence), action: () => { tab.setSequence(v.sequence); tab.ui.set({ mode: 'edit' }); } },
      { separator: true },
      { label: 'Remove from Review (the file stays)', icon: 'x', action: () => removeOne(v) },
    ]);
  };
  const groupMenu = (e, g) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const ctx = e.type === 'contextmenu';
    openMenu(ctx ? e.clientX : r.left, ctx ? e.clientY : r.bottom + 4, [
      g.live
        ? { label: 'Start a new review round (no render)', icon: 'message', action: () => { tab.setSequence(g.seqId); startRound(tab, g.seqId); } }
        : { label: 'Review the timeline (no render)', icon: 'message', disabled: !findSequence(doc, g.seqId), action: () => { tab.setSequence(g.seqId); tab.ui.set({ reviewVersion: null }); } },
      { label: 'Export a draft', icon: 'download', disabled: !g.seqId, action: () => { tab.setSequence(g.seqId); openDialog(ExportDialog, { tab }); } },
      { label: 'Open in Edit', icon: 'seq', disabled: !findSequence(doc, g.seqId), action: () => { tab.setSequence(g.seqId); tab.ui.set({ mode: 'edit' }); } },
      { separator: true },
      { label: 'Remove older versions from Review (files stay)', icon: 'x', disabled: g.list.length < 2, action: () => removeOlder(g) },
    ]);
  };
  const pickFile = async (f, g) => {
    try {
      const r = await post(`/api/p/${tab.projectId}/exports/add`, { path: f.path, sequence: g.seqId || tab.ui.get().sequenceId });
      tab.ui.set({ reviewVersion: r.versionId });
      loadFiles();
    } catch (err) { notify(err.message, 'error'); }
  };
  return html`<aside class="panel versions">
    <header class="panel-head"><span class="panel-title">Versions</span><div class="spacer"></div>
      <${IconButton} icon="folderOpen" title="Open the exports folder" onClick=${() => post(`/api/p/${tab.projectId}/reveal`, { path: files?.[0]?.path || current?.file })} />
      <${IconButton} icon="download" title="Export a draft (a video, for sharing outside the app)" onClick=${() => openDialog(ExportDialog, { tab })} />
      <${IconButton} icon="plus" title="Start a new review round: keeps the current timeline's comments as an earlier round and starts fresh ones (nothing is rendered)" onClick=${() => startRound(tab)} />
    </header>
    <div class="versions-list">
      ${running.map((j) => html`<div class="version-card is-rendering">
        <div class="version-top"><span class="spinner spinner-xs"></span><b>${j.label}</b><span class="version-sub">${j.status === 'encoding' ? 'finishing' : `${Math.round((j.progress || 0) * 100)}%`}</span></div>
        <div class="progress"><div style=${{ width: `${Math.round((j.progress || 0) * 100)}%` }}></div></div>
      </div>`)}
      ${!groups.length ? html`<div class="version-sub">${files == null ? 'Loading…' : 'No versions or exported videos yet'}</div>` : null}
      ${groups.map((g) => {
        const open = isOpen(g);
        return html`<div class="version-group ${open ? 'is-open' : ''}" key=${g.key}>
          <div class="version-seq" role="button" tabindex="0" title=${open ? 'Hide versions' : 'Show versions'} onClick=${() => toggle(g)} onContextMenu=${(e) => groupMenu(e, g)}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(g); } }}>
            <${Icon} name=${open ? 'down' : 'chevronRight'} size=${12} />
            <b>${g.name}</b>
            <span class="version-count">${g.list.filter((v) => !isRound(v)).length + g.files.length}</span>
            ${!open && g.list.some((v) => v.id === current?.id) ? html`<span class="version-seq-cur">${current.name}</span>` : null}
            <div class="spacer"></div>
            <button class="icon-btn version-seq-more" title="More" onClick=${(e) => groupMenu(e, g)}><${Icon} name="more" size=${14} /></button>
          </div>
          ${open ? html`<div class="version-drafts">
            ${g.seqId && !g.live && findSequence(doc, g.seqId) ? html`<div class="version-card" role="button" tabindex="0"
                onClick=${() => { tab.setSequence(g.seqId); tab.ui.set({ reviewVersion: null }); }}>
              <div class="version-top"><b><${Icon} name="seq" size=${12} /> Timeline</b></div>
              <div class="version-sub"><span class="version-kind">live</span> comment on the timeline itself</div>
            </div>` : null}
            ${g.list.map((v) => {
              const n = openCount(v);
              return html`<div class="version-card ${current?.id === v.id ? 'is-active' : ''}" role="button" tabindex="0" key=${v.id}
                  onClick=${() => tab.ui.set({ reviewVersion: v.id })} onContextMenu=${(e) => menu(e, v)}>
                <div class="version-top"><b>${v === g.live ? html`<${Icon} name="seq" size=${12} /> Timeline` : v.name}</b><span class="status-pill ${STATUS[v.status]?.cls}">${STATUS[v.status]?.label}</span>
                  <div class="spacer"></div>
                  <button class="icon-btn version-del" title=${isRound(v) ? 'Remove this round' : 'Remove from Review (the file stays)'} onClick=${(e) => { e.stopPropagation(); removeOne(v); }}><${Icon} name="x" size=${13} /></button>
                </div>
                <div class="version-sub">${v === g.live ? html`<span class="version-kind">live</span> comment on the timeline itself` : timeAgo(v.createdAt)}${v === g.live ? '' : isRound(v) ? html` · <span class="version-kind">timeline</span>` : ` · ${timecode(v.duration || 0, v.fps || 30, { frames: false })}${v.quality === 'draft' ? ' · draft' : ''}`}</div>
                ${n ? html`<div class="version-comments"><${Icon} name="message" size=${12} />${n} open</div>` : null}
              </div>`;
            })}
            ${g.files.length ? html`<div class="version-files-label">In the export folders, not in Review</div>` : null}
            ${g.files.map((f) => html`<div class="version-card is-file" role="button" tabindex="0" key=${f.path} title=${f.path} onClick=${() => pickFile(f, g)}>
              <div class="version-top"><${Icon} name="film" size=${12} /><b class="version-file-name">${f.name}</b></div>
              <div class="version-sub">${timeAgo(f.mtime)} · ${(f.size / 1048576).toFixed(1)} MB · ${f.path.split('/').slice(0, -1).join('/')} · click to review</div>
            </div>`)}
          </div>` : null}
        </div>`;
      })}
    </div>
  </aside>`;
}

function ReviewStage({ tab, version, versions, reviews, doc }) {
  const live = isRound(version);
  const liveSeq = live ? findSequence(doc, version.sequence) : null;
  const fps = (live ? liveSeq?.fps : null) || version.fps || 30;
  const vRef = useRef(null);
  const player = useMemo(() => (live ? timelinePlayer(tab) : null), [live, tab]);
  if (live) vRef.current = player;
  const timeT = useStore(tab.time, (s) => s.t);
  const enginePlaying = useStore(tab.time, (s) => s.playing);
  const loopRef = useRef(null);
  const bRef = useRef(null);
  const drawRef = useRef(null);
  const stageRef = useRef(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(version.duration || 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [compare, setCompare] = useState(null); // version id
  const [compareMode, setCompareMode] = useState('side');
  const [wipe, setWipe] = useState(0.5);
  const [activeComment, setActiveComment] = useState(null);
  const [tool, setTool] = useState(null); // drawing tool while composing
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState([]);
  const [box, setBox] = useState(null); // displayed video rect within the stage
  // a round plays the live timeline: show its sequence, and stop when leaving
  useEffect(() => {
    if (!live) return undefined;
    if (liveSeq && tab.ui.get().sequenceId !== liveSeq.id) tab.setSequence(liveSeq.id);
    return () => tab.engine.pause();
  }, [live, version.id]);
  // Frame.io-style extras: playback quality, loop, volume, timecode display
  const [quality, setQuality] = useState(() => loadPref('review.quality', 'full'));
  const [preparing, setPreparing] = useState(null);
  const [readyQ, setReadyQ] = useState('full');
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(() => loadPref('review.volume', 1));
  const [tcMode, setTcMode] = useState(() => loadPref('review.tcMode', 'tc'));
  const resumeAt = useRef(null);
  const rulersOn = useStore(tab.ui, (s) => s.rulers);
  const comments = (reviews?.comments || []).filter((c) => c.version === version.id).sort((a, b) => a.t - b.t);
  const compareV = versions.find((v) => v.id === compare) || null;
  const fullUrl = projectFileUrl(tab.projectId, version.file);
  const url = readyQ === 'full' ? fullUrl : `/api/p/${tab.projectId}/review-proxy?path=${encodeURIComponent(version.file)}&h=${readyQ}`;
  const shortSide = Math.min(version.width || 1080, version.height || 1920);
  const qualities = live ? [] : [360, 540, 720, 1080].filter((q) => q < shortSide);
  // switching quality: build the smaller copy once on the server, then swap sources at the same time
  useEffect(() => {
    savePref('review.quality', quality);
    if (quality === 'full' || !qualities.includes(+quality)) {
      setPreparing(null);
      if (readyQ !== 'full') { resumeAt.current = vRef.current?.currentTime || 0; setReadyQ('full'); }
      return undefined;
    }
    let alive = true;
    setPreparing(quality);
    post(`/api/p/${tab.projectId}/review-proxy`, { path: version.file, height: +quality })
      .then(() => { if (alive) { resumeAt.current = vRef.current?.currentTime || 0; setReadyQ(quality); } })
      .catch((err) => notify(`Couldn't make the ${quality}p copy: ${err.message}`, 'error'))
      .finally(() => alive && setPreparing(null));
    return () => { alive = false; };
  }, [quality, version.id]);
  useEffect(() => { if (vRef.current && !live) vRef.current.volume = volume; savePref('review.volume', volume); }, [volume]);
  // the live timeline plays through the editor's audio: volume and mute act on it while reviewing
  useEffect(() => {
    if (!live) return undefined;
    audioGraph().master.gain.value = muted ? 0 : volume;
    return () => { audioGraph().master.gain.value = 1; };
  }, [live, muted, volume]);
  useEffect(() => { if (live) tab.engine.loop = loop; }, [live, loop]);
  useEffect(() => { savePref('review.tcMode', tcMode); }, [tcMode]);
  const fmtT = (x) => (tcMode === 'frames' ? `${Math.round(x * fps)} f` : tcMode === 'sec' ? `${x.toFixed(2)}s` : timecode(x, fps));
  const loopRange = () => {
    const c = activeComment ? comments.find((x) => x.id === activeComment) : null;
    return c && c.tEnd != null && c.tEnd > c.t ? [c.t, c.tEnd] : null;
  };
  const jumpComment = (dir) => {
    const v = vRef.current;
    const cur = v ? v.currentTime : t;
    const list = dir > 0 ? comments.filter((c) => c.t > cur + 0.5 / fps) : comments.filter((c) => c.t < cur - 0.5 / fps).reverse();
    const c = list[0];
    if (!c) return;
    v?.pause();
    setActiveComment(c.id);
    seek(c.t);
  };
  const exportComments = (kind) => {
    const name = `${(findSequence(doc, version.sequence)?.name || 'review').replace(/[\\/:*?"<>|]/g, '_')} ${version.name} comments`;
    let body, type;
    if (kind === 'csv') {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['#', 'Timecode', 'End', 'Seconds', 'Author', 'Comment', 'Status', 'Replies', 'Created']];
      comments.forEach((c, i) => rows.push([i + 1, timecode(c.t, fps), c.tEnd != null ? timecode(c.tEnd, fps) : '', c.t, c.author, c.text, c.resolved ? 'Resolved' : 'Open', (c.replies || []).map((r) => `${r.author}: ${r.text}`).join(' | '), c.createdAt]));
      body = rows.map((r) => r.map(q).join(',')).join('\r\n');
      type = 'text/csv';
    } else {
      body = `${name}\n${'='.repeat(name.length)}\n\n` + comments.map((c, i) => `${i + 1}. [${timecode(c.t, fps)}${c.tEnd != null ? ` → ${timecode(c.tEnd, fps)}` : ''}] ${c.resolved ? '✓ ' : ''}${c.author}: ${c.text}${(c.replies || []).map((r) => `\n     ↳ ${r.author}: ${r.text}`).join('')}`).join('\n\n') + '\n';
      type = 'text/plain';
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }));
    a.download = `${name}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // frame-accurate clock while playing
  useEffect(() => {
    let raf, shown = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = vRef.current;
      if (!v) return;
      if (!v.paused) {
        // the page follows the picture about 30 times a second, not on every refresh of the screen
        const f = Math.floor(v.currentTime * 30);
        if (f !== shown) { shown = f; setT(v.currentTime); }
        const lr = loopRef.current;
        if (lr && v.currentTime >= lr[1]) v.currentTime = lr[0];
      }
      const b = bRef.current;
      if (b && compareV) {
        const bEnd = (b.duration || 1e9) - 0.01;
        const target = Math.min(v.currentTime, bEnd);
        if (Math.abs(b.currentTime - target) > 0.06) b.currentTime = target;
        const run = !v.paused && v.currentTime < bEnd; // past the end of a shorter version it holds its last frame
        if (run === b.paused) { if (run) b.play().catch(() => {}); else b.pause(); }
        if (b.playbackRate !== v.playbackRate) b.playbackRate = v.playbackRate;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [compareV]);

  // displayed (object-fit: contain) video rectangle for the drawing overlay
  useEffect(() => {
    const frameEl = () => (live ? stageRef.current?.querySelector('.viewer-canvas-wrap') : vRef.current);
    const measure = () => {
      const v = frameEl(), st = stageRef.current;
      if (!v || !st) return;
      const r = v.getBoundingClientRect(), s = st.getBoundingClientRect();
      const vw = v.videoWidth || version.width || 16, vh = v.videoHeight || version.height || 9;
      const k = Math.min(r.width / vw, r.height / vh);
      const w = vw * k, h = vh * k;
      setBox({ left: r.left - s.left + (r.width - w) / 2, top: r.top - s.top + (r.height - h) / 2, width: w, height: h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stageRef.current);
    if (live) {
      // the viewer lays its frame out after the stage resizes: follow the frame itself as well
      const mo = new MutationObserver(() => { const f = frameEl(); if (f && !f.dataset.rvObserved) { f.dataset.rvObserved = '1'; ro.observe(f); measure(); } });
      mo.observe(stageRef.current, { childList: true, subtree: true });
      const f = frameEl();
      if (f) { f.dataset.rvObserved = '1'; ro.observe(f); }
      return () => { ro.disconnect(); mo.disconnect(); };
    }
    const v = vRef.current;
    v?.addEventListener('loadedmetadata', measure);
    return () => { ro.disconnect(); v?.removeEventListener('loadedmetadata', measure); };
  }, [compare, compareMode, rulersOn, live]);

  const seek = (time) => {
    const v = vRef.current;
    if (!v) return;
    const tt = clamp(time, 0, dur || v.duration || 0);
    v.currentTime = tt;
    setT(tt);
  };
  const jumpCommentRef = useRef(null);
  const step = (n) => { vRef.current?.pause(); seek(Math.round((vRef.current.currentTime + n / fps) * fps) / fps + 0.0001); };
  const toggle = () => { const v = vRef.current; if (!v) return; if (v.paused) { setTool(null); v.play(); } else v.pause(); };

  // keyboard: space, arrows, J/K/L, C to comment
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, .xterm')) return;
      if (overlays.get().dialog || overlays.get().menu) return;
      const v = vRef.current;
      if (!v) return;
      // the keyboard layout's Review commands (keymap.js); Ctrl+C still copies, Ctrl+J is still the Claude panel
      const cmd = commandOf(e, 'review');
      if (cmd === 'rv.play') { e.preventDefault(); toggle(); }
      else if (cmd === 'rv.prevFrame') { e.preventDefault(); step(-1); }
      else if (cmd === 'rv.nextFrame') { e.preventDefault(); step(1); }
      else if (cmd === 'rv.prevSecond') { e.preventDefault(); step(-fps); }
      else if (cmd === 'rv.nextSecond') { e.preventDefault(); step(fps); }
      else if (cmd === 'rv.pause') v.pause();
      else if (cmd === 'rv.faster') { v.playbackRate = v.paused ? 1 : Math.min(4, v.playbackRate * 2); setRate(v.playbackRate); v.play(); }
      else if (cmd === 'rv.back') { v.pause(); seek(v.currentTime - 1); }
      else if (cmd === 'rv.comment') { e.preventDefault(); v.pause(); document.querySelector('.composer textarea')?.focus(); }
      else if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) { setTool(null); setStrokes([]); setActiveComment(null); }
      else if (cmd === 'rv.prevComment' || cmd === 'rv.nextComment') { e.preventDefault(); jumpCommentRef.current(cmd === 'rv.nextComment' ? 1 : -1); }
      else if (cmd === 'rv.loop') { setLoop((x) => !x); }
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dur, fps]);

  // which drawing to show: the composer's, or the active comment's when the playhead is on it
  const shownComment = activeComment ? comments.find((c) => c.id === activeComment) : null;
  const showDrawing = tool || strokes.length ? strokes : shownComment && Math.abs(shownComment.t - t) < 0.75 / fps + 0.05 ? shownComment.drawing : [];
  useEffect(() => { drawStrokes(drawRef.current, box, showDrawing); }, [box, showDrawing]);

  const onDrawDown = (e) => {
    if (!tool || !box) return;
    e.preventDefault();
    vRef.current?.pause();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer (a synthetic event) */ }
    const r = el.getBoundingClientRect();
    const pt = (ev) => [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
    const stroke = { tool, color, width: 0.006, points: [pt(e)] };
    const base = strokes;
    const move = (ev) => {
      const p = pt(ev);
      if (tool === 'pen') stroke.points.push(p);
      else stroke.points = [stroke.points[0], p];
      setStrokes([...base, { ...stroke, points: [...stroke.points] }]);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const addComment = (text, { range, refs }) => {
    const ms = (x) => Math.round(x * 1000) / 1000;
    const from = range != null ? Math.min(t, range) : t, to = range != null && range !== t ? Math.max(t, range) : null;
    const c = { id: uid('cm'), version: version.id, t: ms(from), tEnd: to != null ? ms(to) : null, text, author: 'You', createdAt: new Date().toISOString(), resolved: false, drawing: strokes, refs: refs || [], replies: [] };
    tab.updateReviews((r) => { r.comments.push(c); if (r.versions.find((v) => v.id === version.id)?.status === 'approved') r.versions.find((v) => v.id === version.id).status = 'in_review'; });
    setStrokes([]);
    setTool(null);
    setActiveComment(c.id);
  };

  const setStatus = (status) => tab.updateReviews((r) => { const v = r.versions.find((x) => x.id === version.id); if (v) v.status = status; });
  const open = comments.filter((c) => !c.resolved);
  const liveNow = live && liveRounds(reviews).some((v) => v.id === version.id); // the sequence's current Timeline, not an earlier round
  const waiting = liveNow ? queued(reviews, version.sequence).length : 0; // this sequence's live Timeline comments not yet sent to Claude
  const again = liveNow ? stalled(reviews, version.sequence).length : 0; // sent, but its turn stopped before Claude answered them
  const seqName = findSequence(doc, version.sequence)?.name || version.sequenceName || 'the sequence';
  // this sequence's chat (its linked one, else the open chat)
  const claudeBusy = useClaudeBusy(tab, version.sequence || null);
  const handoff = async () => {
    if (!open.length) { notify('No open comments on this version'); return; }
    if (await sendToClaude(tab, `I left ${open.length} review comment${open.length > 1 ? 's' : ''} on "${seqName}" ${version.name}${version.sourceName ? ` (${version.file})` : ''} in Jimmy. Run \`vedit comments --open --version ${version.id}\` to read them (times are seconds in the sequence; some have drawings described as shapes on the frame, and some have reference images or links — open those to see what I mean). Work through them ONE AT A TIME, in timecode order: for each comment, make the fix in project.json, check it with \`vedit frame <t>\`, then immediately run \`vedit reply <commentId> "what you changed" --resolve\` before moving to the next one (each reply is one short line, no paragraphs). ${live ? 'This is a timeline round: there is no video, I review on the timeline itself, so do NOT render. When every comment is resolved, just tell me.' : 'When every comment is resolved, run \`vedit render\` once so I can review the new version.'}`, version.sequence || null)) setStatus('changes');
  };

  jumpCommentRef.current = jumpComment;
  loopRef.current = loop ? (loopRange() || null) : null;
  // a round's clock and length come from the live timeline
  const tShown = live ? timeT : t;
  const durShown = live ? (liveSeq ? sequenceDuration(liveSeq) : 0) : dur;
  const playingShown = live ? enginePlaying : playing;
  useEffect(() => { if (live) setT(timeT); }, [live, timeT]);
  useEffect(() => { if (live) setDur(durShown); }, [live, durShown]);
  // the seeker zooms like the timeline (Alt + wheel, a pinch, the zoom bar), as Premiere's monitor does
  const mz = useMonitorZoom(durShown, fps);
  useFollow(mz, tShown, playingShown);
  const barRef = useRef(null);
  useZoomWheel(barRef, mz, (x) => { const r = barRef.current.getBoundingClientRect(); return (x - r.left - 14) / Math.max(1, r.width - 28); });
  const inView = comments.filter((c) => c.t >= mz.v0 && c.t <= mz.v1).length;

  return html`<div class="review-main">
    <div class="review-center">
      <header class="review-head">
        <div class="review-title"><b>${seqName}</b><span class="pill">${version.name}</span><span class="review-sub">${live ? html`<span class="version-kind">live timeline</span> · ` : null}${live && liveSeq ? liveSeq.width : version.width}×${live && liveSeq ? liveSeq.height : version.height} · ${fps} fps · ${timeAgo(version.createdAt)}</span></div>
        <div class="spacer"></div>
        <${GuideButtons} tab=${tab} />
        ${live ? null : html`<${Select} class="select-sm" value=${qualities.includes(+quality) ? quality : 'full'} title="Playback resolution (a smaller copy is made once; comments and drawings are unaffected)"
          onChange=${setQuality} options=${[{ value: 'full', label: `Full · ${shortSide}p` }, ...qualities.slice().reverse().map((q) => ({ value: String(q), label: `${q}p` }))]} />`}
        ${preparing ? html`<span class="pill">Preparing ${preparing}p…</span>` : null}
        <${IconButton} icon="download" title="Export comments (CSV for spreadsheets, TXT to read or send)" onClick=${(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom + 4, [
            { label: 'Comments as CSV', action: () => exportComments('csv') },
            { label: 'Comments as text', action: () => exportComments('txt') },
            { separator: true },
            ...(live ? [
              { label: 'Export a draft of the timeline', action: () => openDialog(ExportDialog, { tab }) },
              { label: 'Restore the timeline to this round', action: () => restoreRound(tab, version) },
            ] : [
              { label: 'Download this version (video)', action: () => { const a = document.createElement('a'); a.href = fullUrl; a.download = (version.file || 'version.mp4').split(/[\\/]/).pop(); a.click(); } },
              { label: 'Show file in Explorer', action: () => post(`/api/p/${tab.projectId}/reveal`, { path: version.file }) },
            ]),
          ]);
        }} />
        <${Select} class="select-sm" value=${compare || ''} title="Compare with another version" onChange=${(v) => setCompare(v || null)}
          options=${[{ value: '', label: 'Compare…' }, ...versions.filter((v) => v.id !== version.id && !isRound(v)).map((v) => ({ value: v.id, label: `${findSequence(doc, v.sequence)?.name || v.sequenceName || ''} ${v.name}` }))]} />
        ${compare ? html`<${Segmented} value=${compareMode} onChange=${setCompareMode} options=${[{ value: 'side', label: 'Side by side' }, { value: 'wipe', label: 'Wipe' }]} />` : null}
        <${Select} class="select-sm status-select ${STATUS[version.status]?.cls}" value=${version.status} onChange=${setStatus}
          options=${Object.entries(STATUS).map(([k, s]) => ({ value: k, label: s.label }))} />
        ${liveNow ? html`<${AutoFixSwitch} tab=${tab} seqId=${version.sequence} />` : null}
        ${liveNow ? html`<${Button} kind="claude" icon="sparkle" title=${claudeBusy ? 'Claude is working: this is enabled when it finishes (or press Stop in the chat)' : !waiting && !again ? 'Nothing to send: every comment here is resolved, being fixed, or has a question from Claude for you' : `Send this sequence's comments waiting for Claude now, without waiting for ${BATCH}${again ? ` (with ${again} that Claude didn't get to last time)` : ''}`} disabled=${!(waiting + again) || claudeBusy} onClick=${() => sendNow(tab.projectId, version.sequence)}>Send ${waiting + again || ''} to Claude</${Button}>`
          : html`<${Button} kind="claude" icon="sparkle" title=${claudeBusy ? 'Claude is working: this is enabled when it finishes (or press Stop in the chat)' : "Type these notes into this project's Claude session"} disabled=${claudeBusy} onClick=${handoff}>Send ${open.length || ''} to Claude</${Button}>`}
      </header>
      <div class="review-stage ${compare ? `is-compare is-${compareMode}` : ''} ${rulersOn && !compare ? 'has-rulers' : ''}" ref=${stageRef}>
        <div class="rv-video-wrap">
          ${live ? html`<${Viewer} tab=${tab} readOnly />` : html`<video ref=${vRef} class="rv-video" src=${url} preload="auto" muted=${muted}
            onLoadedMetadata=${(e) => { setDur(e.target.duration); e.target.volume = volume; e.target.playbackRate = rate; if (resumeAt.current != null) { e.target.currentTime = resumeAt.current; resumeAt.current = null; if (playing) e.target.play().catch(() => {}); } }}
            onEnded=${(e) => { if (loop) { const lr = loopRange(); e.target.currentTime = lr ? lr[0] : 0; e.target.play().catch(() => {}); } }} onPlay=${() => setPlaying(true)} onPause=${(e) => { setPlaying(false); setT(e.target.currentTime); }}
            onSeeked=${(e) => setT(e.target.currentTime)} onClick=${toggle}></video>`}
          ${compare && compareMode === 'side' ? html`<span class="rv-label">${version.name}</span>` : null}
        </div>
        ${compareV ? html`<div class="rv-video-wrap rv-b" style=${compareMode === 'wipe' ? { clipPath: `inset(0 0 0 ${wipe * 100}%)` } : null}>
          <video ref=${bRef} class="rv-video" src=${projectFileUrl(tab.projectId, compareV.file)} preload="auto" muted></video>
          <span class="rv-label rv-label-b">${compareV.name}</span>
        </div>` : null}
        ${compareV && compareMode === 'wipe' ? html`<input type="range" class="wipe-slider" min="0" max="1" step="0.001" value=${wipe} onInput=${(e) => setWipe(+e.target.value)} />` : null}
        ${box && !compare ? html`<${GuidesOverlay} tab=${tab} seqId=${version.sequence || 'review'} left=${box.left} top=${box.top} width=${box.width} height=${box.height} sw=${version.width || 1080} sh=${version.height || 1920} />` : null}
        ${box && !compare ? html`<canvas ref=${drawRef} class="rv-draw ${tool ? 'is-drawing' : ''}" style=${{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}
          width=${Math.round(box.width * devicePixelRatio)} height=${Math.round(box.height * devicePixelRatio)} onPointerDown=${onDrawDown}></canvas>` : null}
      </div>
      <div class="mon-bar rv-monbar" ref=${barRef}>
        <${MonitorRuler} z=${mz} t=${tShown} fps=${fps} onSeek=${(tt, phase) => { if (phase === 'start') vRef.current?.pause(); seek(tt); }} />
        <${ScrubBar} thumbUrl=${live ? null : url} t=${tShown} dur=${durShown} comments=${comments} active=${activeComment} onSeek=${seek}
          onPick=${(c) => { setActiveComment(c.id); seek(c.t); vRef.current?.pause(); }} fps=${fps} v0=${mz.v0} v1=${mz.v1} />
        <${ZoomBar} z=${mz} extra=${`${inView} comment${inView === 1 ? '' : 's'} in view`} />
      </div>
      <div class="rv-controls">
        <button class="tc tc-current tc-toggle" title="Click: timecode / frames / seconds" onClick=${() => setTcMode(tcMode === 'tc' ? 'frames' : tcMode === 'frames' ? 'sec' : 'tc')}>${fmtT(tShown)}</button>
        <div class="transport-buttons">
          <${IconButton} icon="chevronLeft" title="Previous comment ([)" onClick=${() => jumpComment(-1)} />
          <${IconButton} icon="prev" title="Previous frame (←)" onClick=${() => step(-1)} />
          <button class="play-btn" onClick=${toggle} title="Play / pause (Space)"><${Icon} name=${playingShown ? 'pause' : 'play'} size=${18} /></button>
          <${IconButton} icon="next" title="Next frame (→)" onClick=${() => step(1)} />
          <${IconButton} icon="chevronRight" title="Next comment (])" onClick=${() => jumpComment(1)} />
          <${IconButton} icon="loop" title=${loopRange() ? 'Loop the selected range comment (O)' : 'Loop playback (O)'} active=${loop} onClick=${() => setLoop(!loop)} />
        </div>
        <div class="transport-right">
          <${Select} class="select-sm" value=${String(rate)} onChange=${(v) => { setRate(+v); vRef.current.playbackRate = +v; }}
            options=${[...new Set(['0.5', '1', '1.5', '2', String(rate)])].map((r) => ({ value: r, label: `${r}×` }))} />
          <${IconButton} icon=${muted ? 'volumeX' : 'volume'} title="Mute" onClick=${() => setMuted(!muted)} />
          <input type="range" class="rv-volume" min="0" max="1" step="0.01" value=${muted ? 0 : volume} title="Volume"
            onInput=${(e) => { setVolume(+e.target.value); if (muted && +e.target.value > 0) setMuted(false); }} />
          <${IconButton} icon="fullscreen" title="Fullscreen" onClick=${() => stageRef.current?.requestFullscreen?.()} />
          <div class="tc tc-dur">${fmtT(durShown)}</div>
        </div>
      </div>
    </div>
    <${CommentsPanel} tab=${tab} version=${version} comments=${comments} fps=${fps} t=${tShown} active=${activeComment}
      onPick=${(c) => { setActiveComment(c.id); seek(c.t); vRef.current?.pause(); }}
      onAdd=${addComment} tool=${tool} setTool=${(x) => { setTool(x); if (x) vRef.current?.pause(); }} color=${color} setColor=${setColor}
      strokes=${strokes} clearStrokes=${() => setStrokes([])} pause=${() => vRef.current?.pause()} />
  </div>`;
}

function ScrubBar({ t, dur, comments, active, onSeek, onPick, fps, thumbUrl, v0 = 0, v1 = null }) {
  const a = v0, b = v1 ?? dur, span = Math.max(1e-6, b - a); // the stretch in view (zoomed: monitorbar.js)
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  // hover preview frame (Frame.io-style): a hidden second player seeks to the hovered time
  const thumbV = useRef(null), thumbC = useRef(null), pendingT = useRef(null), busy = useRef(false);
  const showThumb = (time) => {
    const v = thumbV.current;
    if (!v || v.readyState < 1) return; // nothing loaded yet: a seek now would never report back
    pendingT.current = time;
    if (busy.current) return;
    busy.current = true;
    v.currentTime = time;
  };
  const onThumbSeeked = () => {
    const v = thumbV.current, c = thumbC.current;
    if (c && v.videoWidth) { c.width = 160; c.height = Math.round(160 * v.videoHeight / v.videoWidth); c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); }
    busy.current = false;
    if (pendingT.current != null && Math.abs(pendingT.current - v.currentTime) > 0.04) showThumb(pendingT.current);
  };
  const at = (e) => { const r = ref.current.getBoundingClientRect(); return a + clamp((e.clientX - r.left) / r.width, 0, 1) * span; };
  const down = (e) => {
    if (e.target.closest('.rv-mark')) return;
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer (a synthetic event) */ }
    onSeek(at(e));
    const move = (ev) => onSeek(at(ev));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const pct = (x) => `${dur ? ((x - a) / span) * 100 : 0}%`;
  const shownComments = comments.filter((c) => (c.tEnd ?? c.t) >= a && c.t <= b);
  return html`<div class="rv-scrub" ref=${ref} onPointerDown=${down} onPointerMove=${(e) => { const x = at(e); setHover(x); showThumb(x); }} onPointerLeave=${() => setHover(null)}>
    <div class="rv-track"><div class="rv-fill" style=${{ width: `${clamp(((t - a) / span) * 100, 0, 100)}%` }}></div></div>
    ${shownComments.map((c) => html`
      ${c.tEnd != null ? html`<div class="rv-range" style=${{ left: pct(Math.max(c.t, a)), width: `${((Math.min(c.tEnd, b) - Math.max(c.t, a)) / span) * 100}%` }}></div>` : null}
      ${c.t >= a ? html`<button class="rv-mark ${c.resolved ? 'is-resolved' : ''} ${active === c.id ? 'is-active' : ''}" style=${{ left: pct(c.t) }}
        title="${timecode(c.t, fps)} — ${c.text}" onClick=${() => onPick(c)}>${c.author === 'Claude' ? 'C' : 'Y'}</button>` : null}`)}
    ${t >= a && t <= b ? html`<div class="rv-head" style=${{ left: pct(t) }}></div>` : null}
    ${hover != null ? html`<div class="rv-hover" style=${{ left: pct(hover) }}>${timecode(hover, fps)}</div>` : null}
    ${thumbUrl ? html`<video ref=${thumbV} src=${thumbUrl} muted preload="auto" style=${{ display: 'none' }} onSeeked=${onThumbSeeked} onLoadedMetadata=${() => { busy.current = false; }}></video>
    <canvas ref=${thumbC} class="rv-thumb" style=${{ left: pct(hover ?? 0), display: hover != null ? 'block' : 'none' }}></canvas>` : null}
  </div>`;
}

function CommentsPanel({ tab, version, comments, fps, t, active, onPick, onAdd, tool, setTool, color, setColor, strokes, clearStrokes, pause }) {
  const [filter, setFilter] = useState('all');
  const [text, setText] = useState('');
  const [range, setRange] = useState(null);
  const [refs, setRefs] = useState([]);
  const [uploading, setUploading] = useState(0);
  const listRef = useRef(null);
  const fileRef = useRef(null);
  const addRefs = useRefAdder(tab, setRefs, setUploading);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('time');
  // the comment box's height: drag the top edge of the box area (double-click: back to normal)
  const [boxH, setBoxH] = useState(() => loadPref('review.composerH', 0));
  const taRef = useRef(null);
  const grip = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer (a synthetic event) */ }
    const y0 = e.clientY, h0 = taRef.current?.getBoundingClientRect().height || 40;
    let h = h0;
    const move = (ev) => { h = Math.round(clamp(h0 + (y0 - ev.clientY), 36, window.innerHeight * 0.6)); setBoxH(h); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); savePref('review.composerH', h); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const qq = query.trim().toLowerCase();
  const shown = comments.filter((c) => (filter === 'open' ? !c.resolved : filter === 'resolved' ? c.resolved : true))
    .filter((c) => !qq || `${c.text} ${c.author} ${(c.replies || []).map((r) => r.text).join(' ')}`.toLowerCase().includes(qq))
    .sort((a, b) => (sort === 'newest' ? String(b.createdAt).localeCompare(String(a.createdAt)) : sort === 'author' ? a.author.localeCompare(b.author) || a.t - b.t : a.t - b.t));
  useEffect(() => { listRef.current?.querySelector('.comment.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const submit = () => {
    if (uploading > 0) return;
    const v = text.trim();
    if (!v && !strokes.length && !refs.length) return;
    onAdd(v || (refs.length ? '(reference)' : '(drawing)'), { range, refs });
    setText('');
    setRange(null);
    setRefs([]);
  };
  const update = (id, fn) => tab.updateReviews((r) => { const c = r.comments.find((x) => x.id === id); if (c) fn(c, r); });
  // every resolved comment of this version at once, instead of deleting them one by one
  const resolvedCount = comments.filter((c) => c.resolved).length;
  const clearResolved = async () => {
    if (!(await confirmDialog(`Clear ${resolvedCount} resolved comment${resolvedCount === 1 ? '' : 's'}?`, `They are removed from ${version.name}, with their replies and drawings. Open comments stay.`, 'Clear resolved'))) return;
    tab.updateReviews((r) => { r.comments = r.comments.filter((x) => !(x.version === version.id && x.resolved)); });
    if (filter === 'resolved') setFilter('all');
    notify(`Cleared ${resolvedCount} resolved comment${resolvedCount === 1 ? '' : 's'}`, 'success');
  };
  // the sequence's current Timeline: its comments are auto-fixed and can be re-run
  const liveTimeline = useStore(tab.store, (s) => liveRounds(s.reviews).some((v) => v.id === version.id));
  const autoOn = useStore(autoFixStore(tab.projectId), (s) => s.on);
  const claudeBusy = useClaudeBusy(tab, version.sequence || null);
  const onAskOne = (c) => sendToClaude(tab, `Fix just this one review comment in Jimmy: ${c.id} on version ${version.name} at ${c.t}s ("${c.text.replace(/\s+/g, ' ')}"). Run \`vedit comments --open --version ${version.id}\` for its details, drawing and any reference images/links, make the fix in project.json, check it with \`vedit frame ${c.t}\`, then \`vedit reply ${c.id} "what you changed" --resolve\` (one short line). ${isRound(version) ? 'This is the live timeline: do NOT render or export.' : "Don't render yet."}`, version.sequence || null);
  return html`<aside class="panel comments">
    <header class="panel-head">
      <span class="panel-title">Comments</span><span class="pill">${comments.filter((c) => !c.resolved).length} open</span>
      <div class="spacer"></div>
      <${Segmented} class="seg-sm" value=${filter} onChange=${setFilter} options=${[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'resolved', label: 'Done' }]} />
    </header>
    <div class="comment-tools">
      <input class="input comment-search" placeholder="Search comments" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape') setQuery(''); }} />
      <${Select} class="select-xs" value=${sort} onChange=${setSort} options=${[{ value: 'time', label: 'By time' }, { value: 'newest', label: 'Newest' }, { value: 'author', label: 'By author' }]} />
      ${resolvedCount ? html`<${Button} class="btn-xs comment-clear" icon="check" title=${`Clear the ${resolvedCount} resolved comment${resolvedCount === 1 ? '' : 's'}: removes every resolved comment on this version from the list (the video and open comments stay)`} onClick=${clearResolved}>Clear done (${resolvedCount})</${Button}>` : null}
    </div>
    <div class="comment-list" ref=${listRef}>
      ${shown.length ? shown.map((c) => html`<${Comment} key=${c.id} c=${c} query=${qq} fps=${fps} active=${active === c.id} onPick=${() => onPick(c)}
        onResolve=${() => update(c.id, (x) => { x.resolved = !x.resolved; x.resolvedAt = x.resolved ? new Date().toISOString() : null; })}
        onReply=${(txt) => update(c.id, (x) => { x.replies.push({ id: uid('r'), author: 'You', text: txt, createdAt: new Date().toISOString() }); x.resolved = false; if (liveTimeline && x.auto?.state === 'needs') delete x.auto; })}
        onRerun=${liveTimeline ? () => rerun(tab, c) : null} autoOn=${autoOn} claudeBusy=${claudeBusy}
        onAsk=${() => onAskOne(c)}
        onEdit=${(txt, nextRefs) => update(c.id, (x) => { x.text = txt; x.refs = nextRefs; x.editedAt = new Date().toISOString(); })}
        tab=${tab}
        onDelete=${() => tab.updateReviews((r) => { r.comments = r.comments.filter((x) => x.id !== c.id); })} />`)
      : html`<${Empty} icon="message" title=${filter === 'all' ? 'No comments yet' : 'Nothing here'}>
          ${filter === 'all' ? html`Pause on a frame and type below. Press <kbd>C</kbd> to jump to the comment box.` : null}
        </${Empty}>`}
    </div>
    <div class="composer">
      <div class="composer-grip" onPointerDown=${grip} onDblClick=${() => { setBoxH(0); savePref('review.composerH', 0); }} title="Drag to make the comment box taller or shorter (double-click: back to normal)"></div>
      <div class="composer-meta">
        <span class="tc-chip"><${Icon} name="clock" size=${12} />${timecode(t, fps)}${range != null ? ` → ${timecode(range, fps)}` : ''}</span>
        <button class="chip ${range != null ? 'is-on' : ''}" title="Make this a range comment ending at the current time (move the playhead first, then click)"
          onClick=${() => setRange(range != null ? null : t)}>${range != null ? 'Range ✓' : 'Range'}</button>
        <div class="spacer"></div>
        ${['pen', 'arrow', 'square'].map((tl) => html`<${IconButton} icon=${tl} size=${14} title=${`Draw ${tl === 'square' ? 'box' : tl}`} active=${tool === tl}
          onClick=${() => setTool(tool === tl ? null : tl)} />`)}
        ${tool || strokes.length ? html`<div class="color-dots">${COLORS.map((c) => html`<button class="color-dot ${color === c ? 'is-on' : ''}" style=${{ background: c }} onClick=${() => setColor(c)}></button>`)}</div>` : null}
        ${strokes.length ? html`<${IconButton} icon="eraser" size=${14} title="Clear drawing" onClick=${clearStrokes} />` : null}
        <${IconButton} icon="image" size=${14} title="Attach reference files (or paste / drop images into the box)" onClick=${() => fileRef.current?.click()} />
        <${IconButton} icon="link" size=${14} title="Add a reference link" onClick=${() => { const u = webLink(window.prompt('Reference link (URL)')); if (u) setRefs((r) => [...r, { type: 'link', url: u, name: u }]); }} />
        <input type="file" multiple ref=${fileRef} style=${{ display: 'none' }} onChange=${(e) => { addRefs([...e.target.files]); e.target.value = ''; }} />
      </div>
      ${refs.length || uploading ? html`<${RefList} tab=${tab} refs=${refs} uploading=${uploading} onRemove=${(i) => setRefs((r) => r.filter((_, j) => j !== i))} />` : null}
      <div class="composer-box" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addRefs([...e.dataTransfer.files]); } }}>
        <textarea rows="2" ref=${taRef} style=${boxH ? { height: `${boxH}px`, maxHeight: 'max(36px, calc(100vh - 430px))' } : null} placeholder="Leave a comment at ${timecode(t, fps)}… (paste screenshots or links as references)" value=${text}
          onPaste=${(e) => pasteRefs(e, addRefs, setRefs)}
          onFocus=${pause} onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') e.target.blur(); }}></textarea>
        <button class="send-btn" title="Post (Enter)" disabled=${(!text.trim() && !strokes.length && !refs.length) || uploading > 0} onClick=${submit}><${Icon} name="send" size=${15} /></button>
      </div>
    </div>
  </aside>`;
}

// Auto-fix switch for the live Timeline: on, comments go to Claude by themselves (see autofix.js).
// (each sequence on its own: its comments go to its own chat, never mixed with another sequence's)
function AutoFixSwitch({ tab, seqId }) {
  const on = useStore(autoFixStore(tab.projectId), (s) => s.on);
  const st = useStore(autoFixStore(tab.projectId), (s) => s.bySeq?.[seqId]) || {};
  const label = !on ? 'Auto-fix off' : st.phase === 'fixing' ? 'Claude is fixing…' : st.phase === 'compacting' ? 'Compacting Claude…' : st.phase === 'waiting' || st.phase === 'paused' || st.phase === 'collecting' ? `Auto-fix · ${st.note}` : 'Auto-fix on';
  return html`<button class="chip autofix ${on ? 'is-on' : ''} ${st.phase === 'paused' ? 'is-paused' : ''}"
      title=${on ? `Every ${BATCH} comments on this sequence go to its chat together, 10 seconds after the last one. Fewer than ${BATCH}? Press Send to Claude. Click to turn off.` : `Turn on: every ${BATCH} comments go to Claude by themselves`}
      onClick=${() => setAutoFix(tab.projectId, !on)}>
    ${on && (st.phase === 'fixing' || st.phase === 'compacting') ? html`<span class="spinner spinner-xs"></span>` : html`<${Icon} name="sparkle" size=${12} />`}${label}
  </button>`;
}

// the words a comment search found, marked in the text (any case)
function Hl({ text, q }) {
  const s = String(text ?? '');
  if (!q) return s;
  const low = s.toLowerCase(), parts = [];
  let i = 0;
  for (let j = low.indexOf(q); j >= 0; j = low.indexOf(q, i)) {
    if (j > i) parts.push(s.slice(i, j));
    parts.push(html`<mark class="hl">${s.slice(j, j + q.length)}</mark>`);
    i = j + q.length;
  }
  if (i < s.length) parts.push(s.slice(i));
  return parts;
}

function Comment({ tab, c, fps, active, onPick, onResolve, onReply, onAsk, onEdit, onDelete, onRerun, autoOn, claudeBusy, query = '' }) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState(null); // { text, refs }
  const [uploading, setUploading] = useState(0);
  const setEditRefs = (fn) => setEditing((ed) => (ed ? { ...ed, refs: typeof fn === 'function' ? fn(ed.refs) : fn } : ed));
  const addRefs = useRefAdder(tab, setEditRefs, setUploading);
  const saveEdit = () => { if (uploading > 0) return; onEdit(editing.text.trim() || c.text, editing.refs); setEditing(null); };
  const isClaude = c.author === 'Claude';
  return html`<div class="comment ${active ? 'is-active' : ''} ${c.resolved ? 'is-resolved' : ''}" onClick=${onPick}>
    <div class="comment-head">
      <span class="avatar ${isClaude ? 'is-claude' : ''}">${isClaude ? html`<${Icon} name="sparkle" size=${12} />` : (c.author || 'Y')[0]}</span>
      <b><${Hl} text=${c.author} q=${query} /></b>
      <button class="tc-chip" onClick=${(e) => { e.stopPropagation(); onPick(); }}>${timecode(c.t, fps)}${c.tEnd != null ? ` → ${timecode(c.tEnd, fps)}` : ''}</button>
      ${c.drawing?.length ? html`<${Icon} name="pen" size=${12} class="muted" />` : null}
      <div class="spacer"></div>
      ${onRerun && !c.resolved && c.author !== 'Claude' ? (c.auto?.state === 'working' ? html`<span class="auto-tag is-working"><span class="spinner spinner-xs"></span>Claude</span>`
        : c.auto?.state === 'needs' ? html`<span class="auto-tag is-needs" title=${c.auto.error || 'Claude finished without resolving it: read its reply, then reply or re-run'}>needs you</span>`
        : !c.auto && autoOn ? html`<span class="auto-tag">queued</span>` : null) : null}
      <span class="comment-time">${timeAgo(c.createdAt)}</span>
      <button class="resolve ${c.resolved ? 'is-on' : ''}" title=${c.resolved ? 'Reopen' : 'Mark resolved'} onClick=${(e) => { e.stopPropagation(); onResolve(); }}><${Icon} name="check" size=${13} /></button>
    </div>
    ${editing ? html`<div class="comment-edit" onClick=${(e) => e.stopPropagation()}>
        <textarea class="input" rows="3" value=${editing.text} autoFocus
          onInput=${(e) => setEditing({ ...editing, text: e.target.value })}
          onPaste=${(e) => pasteRefs(e, addRefs, setEditRefs)}
          onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addRefs([...e.dataTransfer.files]); } }}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') setEditing(null); }}></textarea>
        <${RefList} tab=${tab} refs=${editing.refs} uploading=${uploading} onRemove=${(i) => setEditRefs((r) => r.filter((_, j) => j !== i))} />
        <div class="btn-row"><button class="link-btn" onClick=${() => setEditing(null)}>Cancel</button><button class="link-btn" disabled=${uploading > 0} onClick=${saveEdit}><${Icon} name="check" size=${12} /> Save</button></div>
      </div>`
    : html`<div class="comment-text"><${Hl} text=${c.text} q=${query} />${c.editedAt ? html` <span class="comment-time">(edited)</span>` : null}</div>
      ${c.refs?.length ? html`<${RefList} tab=${tab} refs=${c.refs} />` : null}`}
    ${c.replies.map((r) => html`<div class="reply"><span class="avatar avatar-sm ${r.author === 'Claude' ? 'is-claude' : ''}">${r.author === 'Claude' ? html`<${Icon} name="sparkle" size=${10} />` : r.author[0]}</span>
      <div><b>${r.author}</b> <span class="comment-time">${timeAgo(r.createdAt)}</span><div class="comment-text"><${Hl} text=${r.text} q=${query} /></div></div></div>`)}
    <div class="comment-actions" onClick=${(e) => e.stopPropagation()}>
      ${replying ? html`<div class="reply-box">
        <input class="input input-sm" placeholder="Reply…" value=${reply} autoFocus onInput=${(e) => setReply(e.target.value)}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && reply.trim()) { onReply(reply.trim()); setReply(''); setReplying(false); } if (e.key === 'Escape') setReplying(false); }} />
      </div>` : html`<button class="link-btn" onClick=${() => setReplying(true)}><${Icon} name="reply" size=${12} /> Reply</button>
        ${onRerun && c.author !== 'Claude' ? ((c.auto && c.auto.state !== 'working') || c.resolved ? html`<button class="link-btn" disabled=${claudeBusy} title=${claudeBusy ? 'Claude is working: enabled when it finishes' : 'Reopen it and send it to Claude again'} onClick=${onRerun}><${Icon} name="undo" size=${12} /> Re-run</button>` : null)
          : !c.resolved && c.author !== 'Claude' ? html`<button class="link-btn" disabled=${claudeBusy} title=${claudeBusy ? 'Claude is working: enabled when it finishes' : 'Send only this note to Claude'} onClick=${onAsk}><${Icon} name="sparkle" size=${12} /> Ask Claude</button>` : null}
        ${c.author !== 'Claude' && !editing ? html`<button class="link-btn" onClick=${() => setEditing({ text: c.text, refs: c.refs || [] })}><${Icon} name="edit" size=${12} /> Edit</button>` : null}
        ${c.author !== 'Claude' ? html`<button class="link-btn danger" onClick=${onDelete}><${Icon} name="trash" size=${12} /> Delete</button>` : null}`}
    </div>
  </div>`;
}

function drawStrokes(cv, box, strokes) {
  if (!cv || !box) return;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height;
  for (const s of strokes || []) {
    ctx.strokeStyle = s.color || '#ff4d6a';
    ctx.lineWidth = Math.max(2, (s.width || 0.006) * H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pts = (s.points || []).map(([x, y]) => [x * W, y * H]);
    if (!pts.length) continue;
    ctx.beginPath();
    if (s.tool === 'square' || s.tool === 'rect') {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    } else if (s.tool === 'arrow') {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(12, ctx.lineWidth * 4);
      ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45));
      ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45));
      ctx.stroke();
    } else {
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- references on comments

// Upload dropped / pasted / picked files as comment references (saved into the project).
function useRefAdder(tab, setRefs, setUploading) {
  return async (files) => {
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
        const name = file.name && !/^image\.\w+$/.test(file.name) ? file.name : `reference ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
        const res = await fetch(`/api/p/${tab.projectId}/refs/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: file });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r.error || 'Upload failed');
        setRefs((list) => [...list, { type: file.type.startsWith('image/') ? 'image' : 'file', path: r.path, name: r.name }]);
      } catch (err) {
        notify(`Couldn't attach ${file.name || 'file'}: ${err.message}`, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
}

// A typed link as a web address ("youtube.com/…" gets https://); anything that isn't one is dropped.
function webLink(input) {
  const u = String(input || '').trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? null : `https://${u}`;
}

// Paste: images/files become references; a pasted link on its own becomes a link reference.
function pasteRefs(e, addRefs, setRefs) {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addRefs(files); return; }
  const txt = e.clipboardData?.getData('text/plain')?.trim();
  if (txt && /^https?:\/\/\S+$/i.test(txt)) { e.preventDefault(); setRefs((r) => [...r, { type: 'link', url: txt, name: txt }]); }
}

async function copyRef(tab, ref) {
  try {
    if (ref.type === 'link') { await navigator.clipboard.writeText(ref.url); notify('Link copied'); return; }
    if (ref.type === 'image') {
      // The clipboard only takes PNG, so redraw other formats through a canvas.
      const img = new Image();
      img.src = projectFileUrl(tab.projectId, ref.path);
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('Image copied');
      return;
    }
    const dir = tab.store.get().dir || '';
    await navigator.clipboard.writeText(/^[a-z]:|^\//i.test(ref.path) ? ref.path : `${dir}/${ref.path}`);
    notify('File path copied');
  } catch (err) {
    notify(`Copy failed: ${err.message}`, 'error');
  }
}

function RefList({ tab, refs, uploading = 0, onRemove }) {
  const open = (ref) => {
    // only web links are opened: reviews.json can come with a shared project
    if (ref.type === 'link' && !/^https?:\/\//i.test(ref.url || '')) { notify('This link is not a web address', 'error'); return; }
    window.open(ref.type === 'link' ? ref.url : projectFileUrl(tab.projectId, ref.path), '_blank', 'noopener');
  };
  return html`<div class="ref-list" onClick=${(e) => e.stopPropagation()}>
    ${refs.map((ref, i) => html`<div class="ref ${ref.type === 'image' ? 'ref-image' : 'ref-chip'}" title=${ref.type === 'link' ? ref.url : ref.name}>
      ${ref.type === 'image'
        ? html`<img src=${projectFileUrl(tab.projectId, ref.path)} alt=${ref.name} loading="lazy" onClick=${() => open(ref)} />`
        : html`<button class="ref-name" onClick=${() => open(ref)}><${Icon} name=${ref.type === 'link' ? 'link' : 'film'} size=${12} />${ref.type === 'link' ? ref.url.replace(/^https?:\/\/(www\.)?/, '') : ref.name}</button>`}
      <div class="ref-actions">
        <button title="Copy" onClick=${() => copyRef(tab, ref)}><${Icon} name="copy" size=${11} /></button>
        ${onRemove ? html`<button title="Remove" onClick=${() => onRemove(i)}><${Icon} name="x" size=${11} /></button>` : null}
      </div>
    </div>`)}
    ${uploading ? html`<div class="ref ref-chip"><span class="spinner spinner-xs"></span> Attaching…</div>` : null}
  </div>`;
}
