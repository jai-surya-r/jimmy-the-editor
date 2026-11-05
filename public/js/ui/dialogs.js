import { THEMES, applyTheme, currentTheme, savedTheme } from '../core/theme.js';
// Dialogs: prompts, confirm, new sequence, export, file browser, settings, source preview.
import { html, Modal, Button, Icon, IconButton, Select, Toggle, Segmented, fmtBytes } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { openDialog, notify } from '../core/notify.js';
import { get, post, mediaUrl } from '../core/api.js';
import { SEQUENCE_PRESETS, FRAME_RATES, makeSequence, findSequence, sequenceDuration, timecode, snapTime, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT } from '../core/model.js';
import { insertMedia } from '../core/ops.js';
import { app } from '../core/app.js';
import { useStore } from '../core/store.js';
import { openStorage } from './storage.js';
import { openShortcuts } from './shortcuts.js';
import { openAccounts } from './accounts.js';

// ------------------------------------------------------------------ prompt / confirm

function PromptDialog({ close, title, value = '', placeholder, okLabel = 'OK', multiline }) {
  const [v, setV] = useState(value);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const ok = () => close(v);
  return html`<${Modal} title=${title} onClose=${() => close(null)} width=${420}
    footer=${html`<${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" onClick=${ok}>${okLabel}</${Button}>`}>
    ${multiline
      ? html`<textarea ref=${ref} class="input" rows="4" value=${v} placeholder=${placeholder} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok(); }}></textarea>`
      : html`<input ref=${ref} class="input" value=${v} placeholder=${placeholder} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); }} />`}
  </${Modal}>`;
}
export const promptText = (title, value, opts = {}) => openDialog(PromptDialog, { title, value, ...opts });

// What a detected GPU does here, in one line (numbers measured on this computer when it was detected)
export const gpuSummary = (d) => [
  !d.speedup ? null : d.speedup >= 1.15 ? `encodes about ${d.speedup}× faster` : d.speedup >= 0.85 ? 'encodes at about the speed of the CPU' : 'encodes more slowly than the CPU',
  d.cpuSaving ? `with about ${Math.min(20, d.cpuSaving)}× less CPU` : null,
  d.decode ? 'decodes 4K and HEVC footage' : null,
  d.prores ? 'makes ProRes' : null,
].filter(Boolean).join(', ');

// Asked once, the first time a GPU that helps is found.
export function GpuAskDialog({ close, device }) {
  const choose = async (use) => {
    const s = app.get().server?.gpu?.settings || {};
    await post('/api/settings', { gpu: { ...s, device: use ? device.id : null } }).catch(() => {});
    app.set({ server: await get('/api/state') });
    if (use) notify(`Exports now use the ${device.name}. Change it any time in Settings.`, 'success');
    close(use);
  };
  return html`<${Modal} title="Use the graphics card for exports?" onClose=${() => choose(false)} width=${460}
    footer=${html`<${Button} onClick=${() => choose(false)}>Keep CPU</${Button}><${Button} kind="primary" onClick=${() => choose(true)}>Use GPU</${Button}>`}>
    <p class="dialog-text"><b>${device.name}</b> ${gpuSummary(device)} (measured on this computer).</p>
    <p class="dialog-text">Exports and pre-rendering move to it, while motion graphics keep the CPU, so both can run side by side. Picture quality matches the CPU's. If the GPU ever fails, that export finishes on the CPU. Change this any time in Settings › Hardware acceleration.</p>
  </${Modal}>`;
}

function ConfirmDialog({ close, title, body, okLabel = 'OK', danger = true }) {
  return html`<${Modal} title=${title} onClose=${() => close(false)} width=${420}
    footer=${html`<${Button} onClick=${() => close(false)}>Cancel</${Button}><${Button} kind=${danger ? 'danger' : 'primary'} onClick=${() => close(true)}>${okLabel}</${Button}>`}>
    ${body ? html`<p class="dialog-text">${body}</p>` : null}
  </${Modal}>`;
}
export const confirmDialog = (title, body, okLabel, danger = true) => openDialog(ConfirmDialog, { title, body, okLabel, danger });

// ------------------------------------------------------------------ new sequence / sequence settings

export function NewSequenceDialog({ close, tab, edit, fromMedia, folder }) {
  const doc = tab.doc;
  const base = edit || (fromMedia ? { width: fromMedia.width || 1920, height: fromMedia.height || 1080, fps: fromMedia.fps || 30 } : { width: 1080, height: 1920, fps: 30 });
  const [name, setName] = useState(edit ? edit.name : fromMedia ? fromMedia.name.replace(/\.[^.]+$/, '') : `Sequence ${doc.sequences.length + 1}`);
  const [w, setW] = useState(base.width);
  const [h, setH] = useState(base.height);
  const [fps, setFps] = useState(String(base.fps));
  const [bg, setBg] = useState(edit?.background || '#000000');
  const preset = SEQUENCE_PRESETS.find((p) => p.width === +w && p.height === +h)?.id || 'custom';
  const ok = () => {
    const width = Math.max(16, Math.round(+w / 2) * 2), height = Math.max(16, Math.round(+h / 2) * 2);
    if (edit) {
      tab.apply('Sequence settings', (d) => { const s = findSequence(d, edit.id); Object.assign(s, { name: name || s.name, width, height, fps: +fps, background: bg }); });
      close(true);
      return;
    }
    const seq = makeSequence({ name: name || 'Sequence', width, height, fps: +fps, background: bg, folder: folder || null });
    tab.apply('New sequence', (d) => {
      d.sequences.push(seq);
      if (fromMedia) insertMedia(d, seq, fromMedia, { start: 0, scaling: 'fit' });
    });
    tab.setSequence(seq.id);
    close(seq.id);
  };
  const ratio = (+w && +h) ? (+w / +h) : 1;
  return html`<${Modal} title=${edit ? 'Sequence settings' : 'New sequence'} onClose=${() => close(null)} width=${520}
    footer=${html`<${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" onClick=${ok}>${edit ? 'Save' : 'Create sequence'}</${Button}>`}>
    <div class="form">
      <label class="field"><span>Name</span><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); }} /></label>
      <div class="preset-grid">
        ${SEQUENCE_PRESETS.map((p) => html`<button class="preset ${preset === p.id ? 'is-active' : ''}" onClick=${() => { setW(p.width); setH(p.height); }}>
          <span class="preset-shape" style=${{ aspectRatio: `${p.width}/${p.height}` }}></span>
          <span class="preset-label">${p.label}</span><span class="preset-size">${p.width}×${p.height}</span>
        </button>`)}
      </div>
      <div class="field-row">
        <label class="field"><span>Width</span><input class="input" type="number" value=${w} onInput=${(e) => setW(e.target.value)} /></label>
        <label class="field"><span>Height</span><input class="input" type="number" value=${h} onInput=${(e) => setH(e.target.value)} /></label>
        <label class="field"><span>Frame rate</span><${Select} value=${fps} options=${FRAME_RATES.map((f) => ({ value: String(f), label: `${f} fps` }))} onChange=${setFps} /></label>
        <label class="field"><span>Background</span><input class="input input-color" type="color" value=${bg} onInput=${(e) => setBg(e.target.value)} /></label>
      </div>
      <div class="dialog-hint">${Math.round(ratio * 1000) / 1000}:1 aspect${fromMedia ? ` · matches ${fromMedia.name}` : ''}</div>
    </div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ export

// Audio-only exports (server/render.js AUDIO_FORMATS)
const AUDIO_EXPORTS = [
  { value: 'wav24', label: 'WAV 24-bit (.wav)', hint: 'Uncompressed WAV, 24-bit' },
  { value: 'wav16', label: 'WAV 16-bit (.wav)', hint: 'Uncompressed WAV, 16-bit' },
  { value: 'flac', label: 'FLAC (.flac) — lossless, smaller', hint: 'Lossless FLAC, 24-bit' },
  { value: 'mp3', label: 'MP3 320 kbps (.mp3)', hint: 'MP3 at 320 kbps' },
  { value: 'aac', label: 'AAC 256 kbps (.m4a)', hint: 'AAC at 256 kbps' },
];

// Video formats (server/render.js FORMATS). lossy: H.264 / H.265, which take a quality or a bitrate and an MP4 or MOV.
const VIDEO_FORMATS = [
  { value: 'h264', label: 'H.264 — for sharing, uploads and Review', lossy: true },
  { value: 'hevc', label: 'H.265 (HEVC) — same picture, about half the size', lossy: true },
  { value: 'prores', label: 'ProRes 422 HQ (.mov) — for Premiere / Resolve' },
  { value: 'prores422', label: 'ProRes 422 (.mov)' },
  { value: 'proreslt', label: 'ProRes 422 LT (.mov)' },
  { value: 'proresproxy', label: 'ProRes 422 Proxy (.mov)' },
  { value: 'prores4444o', label: 'ProRes 4444 (.mov)' },
  { value: 'prores4444', label: 'ProRes 4444 + alpha (.mov) — transparent background' },
];
const EXPORT_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]; // server/render.js EXPORT_RATES
const SHORT_SIDES = [2160, 1440, 1080, 720, 540];
const VIDEO_AUDIO = [
  { value: 'aac320', label: 'AAC 320 kbps' }, { value: 'aac256', label: 'AAC 256 kbps' }, { value: 'aac192', label: 'AAC 192 kbps' },
  { value: 'aac128', label: 'AAC 128 kbps' }, { value: 'pcm24', label: 'PCM 24-bit (uncompressed)', mov: true },
  { value: 'pcm16', label: 'PCM 16-bit (uncompressed)', mov: true }, { value: 'none', label: 'No audio' },
];
// The settings a preset holds (everything but the sequence, range and folder)
const DEFAULT_EXPORT = { format: 'h264', quality: 'high', rateMode: 'quality', mbps: 16, cbr: false, container: 'mp4', size: 'full', width: 1920, fps: 'match', audio: 'aac256', sampleRate: 48000 };
const BUILTIN_PRESETS = [
  { name: 'High quality H.264 (match sequence)', o: {} },
  { name: 'YouTube 1080p — H.264, 16 Mbps', o: { rateMode: 'bitrate', mbps: 16, size: 's1080', audio: 'aac320' } },
  { name: 'YouTube 4K — H.264, 45 Mbps', o: { rateMode: 'bitrate', mbps: 45, size: 's2160', audio: 'aac320' } },
  { name: 'Instagram / Reels — H.264 1080p, 12 Mbps', o: { rateMode: 'bitrate', mbps: 12, size: 's1080', audio: 'aac256' } },
  { name: 'Small file — H.265 1080p, 5 Mbps', o: { format: 'hevc', rateMode: 'bitrate', mbps: 5, size: 's1080', audio: 'aac192' } },
  { name: 'ProRes 422 HQ master', o: { format: 'prores', audio: 'pcm24' } },
];
const fmtSize = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`);

export function ExportDialog({ close, tab, init }) {
  const doc = tab.doc;
  // `init`: the choices made before stepping out to the folder browser (the dialog is opened again afterwards)
  const [seqId, setSeqId] = useState(init?.seqId ?? tab.seq?.id);
  const seq = findSequence(doc, seqId);
  const last = tab.ui.get().exportOpts || {};
  const [o, setO] = useState(() => ({ ...DEFAULT_EXPORT, format: tab.ui.get().exportFormat || 'h264', ...last, ...(init?.o || {}) }));
  const set = (patch) => setO((cur) => ({ ...cur, ...patch }));
  const [audioFmt, setAudioFmt] = useState(init?.audioFmt ?? (tab.ui.get().exportAudio || 'wav24'));
  const { format, quality } = o;
  const audioOnly = format === 'audio';
  const vf = VIDEO_FORMATS.find((f) => f.value === format);
  const lossy = !!vf?.lossy;
  const mov = !lossy || o.container === 'mov';
  const byRate = lossy && o.rateMode === 'bitrate';
  const hasInOut = seq && seq.inPoint != null && seq.outPoint != null && seq.outPoint > seq.inPoint;
  // the output size: the sequence's shape, at its own size, a common height (the shorter side) or a chosen width
  const sw = seq?.width || 1920, sh = seq?.height || 1080;
  const short = Math.min(sw, sh);
  const evenOf = (v) => Math.max(2, Math.round(v / 2) * 2);
  const scaleFor = (size) => (size === 'full' ? 1 : size === 'half' ? 0.5 : size === 'custom' ? Math.max(16, +o.width || sw) / sw
    : /^s\d+$/.test(size) ? +size.slice(1) / short : 1);
  const scale = scaleFor(o.size);
  // drafts are 1080p at most (the frame's shorter side; the server keeps to it), smaller sequences keep their size
  const draftCapped = lossy && !byRate && quality === 'draft' && short * scale > 1080;
  const outW = evenOf(sw * (draftCapped ? 1080 / short : scale)), outH = evenOf(sh * (draftCapped ? 1080 / short : scale));
  const sizeOptions = [
    { value: 'full', label: `Match sequence · ${sw}×${sh}` },
    ...SHORT_SIDES.filter((s) => s !== short).map((s) => ({ value: `s${s}`, label: `${s}p · ${evenOf((sw * s) / short)}×${evenOf((sh * s) / short)}` })),
    { value: 'half', label: `Half · ${evenOf(sw / 2)}×${evenOf(sh / 2)}` },
    { value: 'custom', label: 'Custom width…' },
  ];
  const audioOptions = VIDEO_AUDIO.filter((a) => !a.mov || mov);
  const audio = audioOptions.some((a) => a.value === o.audio) ? o.audio : (mov && !lossy ? 'pcm16' : 'aac256');
  const [range, setRange] = useState(init?.range ?? (hasInOut ? 'inout' : 'all'));
  const [addVersion, setAddVersion] = useState(init?.addVersion ?? true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(init?.name ?? null);
  const [stamp] = useState(() => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  const [folders, setFolders] = useState(null);
  const [outDir, setOutDir] = useState(tab.ui.get().exportDir || null);
  const presets = useStore(app, (s) => s.server?.exportPresets) || {};
  const [presetName, setPresetName] = useState(null); // naming a new preset
  useEffect(() => {
    get(`/api/p/${tab.projectId}/export-folders`).then((r) => {
      setFolders(r.folders);
      setOutDir((cur) => cur || r.default);
    }).catch(() => setFolders([]));
  }, []);
  const browse = async () => {
    // Only one dialog shows at a time: pick the folder, then come back to this dialog.
    const r = await pickPath({ title: 'Export to folder', mode: 'folder', startPath: outDir && /^[a-z]:|^\//i.test(outDir) ? outDir : tab.store.get().dir, okLabel: 'Export here' });
    if (r?.path) tab.ui.set({ exportDir: r.path });
    openDialog(ExportDialog, { tab, init: { seqId, o, range, addVersion, audioFmt, name } });
  };
  const savePresets = async (next) => {
    app.set((s) => ({ ...s, server: s.server ? { ...s.server, exportPresets: next } : s.server }));
    await post('/api/settings', { exportPresets: next }).catch((e) => notify(e.message, 'error'));
  };
  const presetValue = Object.keys(presets).find((n) => JSON.stringify({ ...DEFAULT_EXPORT, ...presets[n] }) === JSON.stringify(o))
    ? `u:${Object.keys(presets).find((n) => JSON.stringify({ ...DEFAULT_EXPORT, ...presets[n] }) === JSON.stringify(o))}`
    : BUILTIN_PRESETS.find((p) => JSON.stringify({ ...DEFAULT_EXPORT, ...p.o }) === JSON.stringify(o))?.name || '';
  const pickPreset = (v) => {
    if (v.startsWith('u:')) setO({ ...DEFAULT_EXPORT, ...presets[v.slice(2)] });
    else { const p = BUILTIN_PRESETS.find((x) => x.name === v); if (p) setO({ ...DEFAULT_EXPORT, ...p.o }); }
  };
  const dur = seq ? (range === 'inout' && hasInOut ? seq.outPoint - seq.inPoint : sequenceDuration(seq)) : 0;
  const outFps = o.fps === 'match' ? seq?.fps : +o.fps;
  const audioKbps = audio === 'none' ? 0 : audio.startsWith('aac') ? +audio.slice(3) : (o.sampleRate * 2 * (audio === 'pcm24' ? 24 : 16)) / 1000;
  const estMB = byRate ? ((+o.mbps || 0) * 1000 + audioKbps) * dur / 8 / 1000 : null;
  // how much of this sequence the background pre-render already has (it works at full resolution)
  const pre = useStore(tab.store, (s) => s.prerender);
  const ps = pre?.sequences?.[seqId];
  const plain = format === 'h264' && !byRate && o.container !== 'mov' && scale === 1 && o.fps === 'match';
  const preHint = !pre?.enabled || !ps?.total || !plain || quality !== (pre.quality || 'high') ? null
    : ps.ready >= ps.total ? 'Pre-rendered: this export only needs stitching.' : `Pre-rendered: ${Math.round((ps.ready / ps.total) * 100)}% — the rest is rendered now.`;
  const canReview = format === 'h264' && o.container !== 'mov';
  const badRate = byRate && !(+o.mbps > 0);
  // File name: the name the server would give it, until the person types their own (null = that default). The server
  // never writes over a file: if the name is taken, the export is saved as "<name> (2)".
  const ext = audioOnly ? (AUDIO_EXPORTS.find((a) => a.value === audioFmt)?.label.match(/\(\.(\w+)\)/)?.[1] || 'wav') : mov ? 'mov' : 'mp4';
  const nextVersion = 1 + Math.max(0, ...((tab.store.get().reviews?.versions || []).filter((v) => v.sequence === seqId).map((v) => v.number || 0)));
  const defaultName = !seq ? '' : audioOnly ? `${seq.name} audio` : canReview && addVersion ? `${seq.name} v${nextVersion}` : `${seq.name} ${stamp}`;
  const shownName = name ?? defaultName;
  const badChars = /[<>:"/\\|?*]/.test(shownName);
  const go = async () => {
    setBusy(true);
    try {
      if (outDir) tab.ui.set({ exportDir: outDir });
      tab.ui.set({ exportFormat: format, ...(audioOnly ? { exportAudio: audioFmt } : { exportOpts: o }) });
      const a = audio === 'none' ? { codec: 'none' } : audio.startsWith('aac') ? { codec: 'aac', kbps: +audio.slice(3) } : { codec: audio };
      // only a name the person typed goes to the server; the default is worked out there, as before
      const fileName = name != null && name.trim() && name.trim() !== defaultName ? name.trim() : undefined;
      const r = await post(`/api/p/${tab.projectId}/render`, audioOnly ? { sequenceId: seqId, audio: audioFmt, range: range === 'inout' ? 'inout' : null, outDir, name: fileName }
        : {
          sequenceId: seqId, name: fileName, quality: lossy && !byRate ? quality : 'high', format, scale, range: range === 'inout' ? 'inout' : null, addVersion: canReview && addVersion, outDir,
          rate: byRate ? { mbps: +o.mbps, cbr: !!o.cbr } : null, container: lossy ? o.container : null,
          fps: o.fps === 'match' ? null : +o.fps, audioOut: { ...a, rate: o.sampleRate },
        });
      notify(`Export started: ${r.job.label}`, 'info');
      close(r.job);
    } catch (err) {
      notify(err.message, 'error');
      setBusy(false);
    }
  };
  const summary = audioOnly ? null : [
    VIDEO_FORMATS.find((f) => f.value === format)?.label.split(' — ')[0],
    lossy ? (byRate ? `${+o.mbps || 0} Mbps ${o.cbr ? 'CBR' : 'VBR'}` : `${quality} quality`) : null,
    `${outW}×${outH}`, `${outFps} fps${o.fps !== 'match' ? ' (converted)' : ''}`,
    VIDEO_AUDIO.find((x) => x.value === audio)?.label + (audio !== 'none' ? ` · ${o.sampleRate === 44100 ? '44.1' : '48'} kHz` : ''),
    lossy ? `.${o.container}` : '.mov',
  ].filter(Boolean).join(' · ');
  return html`<${Modal} title="Export" onClose=${() => close(null)} width=${560}
    footer=${html`<${Button} title="Final Cut 7 XML of this sequence — import it in Premiere (File > Import) or Resolve" onClick=${async () => { const { exportXml } = await import('./Timeline.js'); exportXml(tab, seqId); }}>Export XML</${Button}><div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" icon="download" disabled=${busy || !seq || dur <= 0 || badRate} onClick=${go}>${audioOnly ? 'Export audio' : `Export ${mov ? 'MOV' : 'MP4'}`}</${Button}>`}>
    <div class="form">
      <label class="field"><span>Sequence</span><${Select} value=${seqId} options=${doc.sequences.map((s) => ({ value: s.id, label: `${s.name} · ${s.width}×${s.height}` }))} onChange=${setSeqId} /></label>
      ${audioOnly ? null : html`<div class="field"><span>Preset</span><div class="field-row" style=${{ gap: '6px' }}>
        <${Select} value=${presetValue} onChange=${pickPreset} options=${[
          ...(presetValue ? [] : [{ value: '', label: 'Custom settings' }]),
          ...BUILTIN_PRESETS.map((p) => ({ value: p.name, label: p.name })),
          ...Object.keys(presets).map((n) => ({ value: `u:${n}`, label: `★ ${n}` })),
        ]} />
        ${presetValue.startsWith('u:') ? html`<${IconButton} icon="trash" title="Delete this preset" onClick=${() => { const next = { ...presets }; delete next[presetValue.slice(2)]; savePresets(next); }} />`
          : html`<${Button} title="Keep these settings as a preset of your own" onClick=${() => setPresetName('')}>Save preset…</${Button}>`}
      </div></div>`}
      ${presetName !== null ? html`<div class="field-row" style=${{ gap: '6px' }}>
        <input class="input" data-esc placeholder="Preset name, e.g. Client — 10 Mbps 1080p" value=${presetName} ref=${(el) => el && !el.dataset.f && (el.dataset.f = 1, el.focus())}
          onInput=${(e) => setPresetName(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && presetName.trim()) { savePresets({ ...presets, [presetName.trim()]: o }); setPresetName(null); } if (e.key === 'Escape') setPresetName(null); }} />
        <${Button} kind="primary" disabled=${!presetName.trim()} onClick=${() => { savePresets({ ...presets, [presetName.trim()]: o }); setPresetName(null); }}>Save</${Button}>
        <${Button} onClick=${() => setPresetName(null)}>Cancel</${Button}></div>` : null}
      <label class="field"><span>Format</span><${Select} value=${format} onChange=${(v) => set({ format: v, ...(lossy && v.startsWith('prores') && audio.startsWith('aac') ? { audio: 'pcm24' } : {}) })}
        options=${[...VIDEO_FORMATS, { value: 'audio', label: 'Audio only — the sequence’s mix, no video' }]} /></label>
      ${audioOnly ? html`<label class="field"><span>Audio format</span><${Select} value=${audioFmt} onChange=${setAudioFmt}
        options=${AUDIO_EXPORTS} /></label>` : null}
      ${lossy ? html`<div class="field-row">
        <label class="field"><span>Bitrate</span><${Segmented} value=${o.rateMode} onChange=${(v) => set({ rateMode: v })}
          options=${[{ value: 'quality', label: 'By quality' }, { value: 'bitrate', label: 'Target bitrate' }]} /></label>
        <label class="field"><span>Container</span><${Segmented} value=${o.container} onChange=${(v) => set({ container: v })}
          options=${[{ value: 'mp4', label: 'MP4' }, { value: 'mov', label: 'MOV' }]} /></label>
      </div>` : null}
      ${lossy && !byRate ? html`<label class="field"><span>Quality</span><${Segmented} value=${quality} onChange=${(v) => set({ quality: v })}
        options=${[{ value: 'high', label: 'High' }, { value: 'standard', label: 'Standard' }, { value: 'draft', label: 'Draft' }]} /></label>` : null}
      ${byRate ? html`<div class="field-row">
        <label class="field"><span>Target bitrate (Mbps)</span><input class="input" type="number" min="0.1" max="500" step="0.5" value=${o.mbps}
          onInput=${(e) => set({ mbps: e.target.value })} onKeyDown=${(e) => e.stopPropagation()} /></label>
        <label class="field"><span>Encoding</span><${Segmented} value=${o.cbr ? 'cbr' : 'vbr'} onChange=${(v) => set({ cbr: v === 'cbr' })}
          options=${[{ value: 'vbr', label: 'VBR' }, { value: 'cbr', label: 'CBR' }]} /></label>
      </div>` : null}
      ${audioOnly ? null : html`<div class="field-row">
        <label class="field"><span>Resolution</span><${Select} value=${o.size} onChange=${(v) => set({ size: v, ...(v === 'custom' ? { width: outW } : {}) })} options=${sizeOptions} /></label>
        ${o.size === 'custom' ? html`<label class="field" style=${{ maxWidth: '110px' }}><span>Width</span><input class="input" type="number" min="16" max="8192" value=${o.width}
          onInput=${(e) => set({ width: e.target.value })} onKeyDown=${(e) => e.stopPropagation()} /></label>` : null}
        <label class="field"><span>Frame rate</span><${Select} value=${String(o.fps)} onChange=${(v) => set({ fps: v })}
          options=${[{ value: 'match', label: `Match sequence · ${seq?.fps} fps` }, ...EXPORT_RATES.filter((r) => Math.abs(r - (seq?.fps || 0)) > 0.001).map((r) => ({ value: String(r), label: `${r} fps` }))]} /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Audio</span><${Select} value=${audio} onChange=${(v) => set({ audio: v })} options=${audioOptions} /></label>
        <label class="field"><span>Sample rate</span><${Segmented} value=${String(o.sampleRate)} onChange=${(v) => set({ sampleRate: +v })}
          options=${[{ value: '48000', label: '48 kHz' }, { value: '44100', label: '44.1 kHz' }]} /></label>
      </div>`}
      <label class="field"><span>Range</span><${Select} value=${range} onChange=${setRange}
        options=${[{ value: 'all', label: 'Entire sequence' }, { value: 'inout', label: 'In → Out', disabled: !hasInOut }]} /></label>
      <label class="field"><span>File name</span><div class="field-row export-name" style=${{ gap: '6px', alignItems: 'center' }}>
        <input class="input" data-esc value=${shownName} spellcheck=${false} onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && !busy && seq && dur > 0 && !badRate) go(); }} />
        <span class="muted">.${ext}</span>
        ${name != null && name !== defaultName ? html`<${IconButton} icon="refresh" title=${`Back to the default name (${defaultName})`} onClick=${() => setName(null)} />` : null}
      </div>${badChars ? html`<span class="dialog-hint">${'< > : " / \\ | ? *'} can't be in a file name: they become spaces.</span>` : null}</label>
      <label class="field"><span>Save to folder</span><div class="field-row" style=${{ gap: '6px' }}>
        <${Select} value=${outDir || ''} onChange=${setOutDir}
          options=${[...new Set([...(folders || []), ...(outDir ? [outDir] : [])])].map((f) => ({ value: f, label: f }))} />
        <${Button} icon="folder" onClick=${browse}>Browse…</${Button}></div></label>
      ${canReview ? html`<${Toggle} checked=${addVersion} onChange=${setAddVersion} label="Add to Review as a new version" />` : null}
      <div class="dialog-hint">${audioOnly ? html`${AUDIO_EXPORTS.find((a) => a.value === audioFmt)?.hint} · 48 kHz stereo · mixed straight from the sources, no frames rendered · ${timecode(dur, seq?.fps || 30)} · saved to <code>${outDir || '…'}</code>` : html`${summary}${draftCapped ? ' (drafts are 1080p at most)' : ''} · ${timecode(dur, seq?.fps || 30)}${estMB != null ? html` · <b>about ${fmtSize(estMB)}</b>` : ''}${format === 'prores4444' ? ' · the sequence background is left transparent' : ''}${!canReview ? ' · not added to Review (only H.264 MP4s play there)' : ''}${o.fps !== 'match' ? ' · the frame rate is converted after rendering (frames repeated or dropped)' : ''} · saved to <code>${outDir || '…'}</code>${preHint ? html`<br />${preHint}` : null}`}</div>
    </div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ choosing files and folders

// The system's own file dialog (Windows Explorer / macOS Finder) in the desktop app (electron/preload.cjs); the
// browser version of Jimmy can't get paths from it and uses the server-side browser below.
// Same options and answer as FileBrowser: { path } for 'folder'/'file', { paths, copy: false } for 'media'.
const MEDIA_EXTS = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];
export async function pickPath(opts = {}) {
  const native = window.jimmyApp?.pick;
  if (!native) return openDialog(FileBrowser, opts);
  const mode = opts.mode || 'media';
  const exts = opts.exts || (mode === 'media' ? MEDIA_EXTS : null);
  const r = await native({ title: opts.title, mode, startPath: opts.startPath, okLabel: opts.okLabel, exts });
  if (!r?.length) return null;
  return mode === 'media' ? { paths: r, copy: false } : { path: r[0] };
}

// ------------------------------------------------------------------ file browser (server-side)

// mode: 'media' (multi-select import) | 'folder' | 'file' (pick one file; `exts` limits the list, e.g. ['cube'])
export function FileBrowser({ close, title = 'Choose files', mode = 'media', startPath, okLabel, exts }) {
  const [path, setPath] = useState(startPath || null);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState([]);
  const [copy, setCopy] = useState(false);
  const [err, setErr] = useState(null);
  const [typed, setTyped] = useState('');
  const [newName, setNewName] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setErr(null);
    get(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`).then((d) => { if (alive) { setData(d); setSel([]); setTyped(d.path || ''); } }).catch((e) => setErr(e.message));
    return () => { alive = false; };
  }, [path, reload]);
  const makeFolder = async () => {
    const name = (newName || '').trim();
    if (!name) { setNewName(null); return; }
    try {
      const r = await post('/api/fs/mkdir', { path: data.path, name });
      setNewName(null);
      if (mode === 'folder') setPath(r.path); else setReload((n) => n + 1);
    } catch (e) { notify(e.message, 'error'); }
  };
  const entries = (data?.entries || []).filter((e) => e.dir || (mode !== 'folder' && (!exts || exts.includes(e.ext))));
  const pick = (e, ev) => {
    if (e.dir) return;
    if (mode === 'folder') return;
    if (mode === 'file') { setSel([e.path]); return; }
    if (ev.ctrlKey || ev.metaKey) setSel((s) => (s.includes(e.path) ? s.filter((x) => x !== e.path) : [...s, e.path]));
    else if (ev.shiftKey && sel.length) {
      const list = entries.filter((x) => !x.dir).map((x) => x.path);
      const a = list.indexOf(sel[sel.length - 1]), b = list.indexOf(e.path);
      setSel([...new Set([...sel, ...list.slice(Math.min(a, b), Math.max(a, b) + 1)])]);
    } else setSel([e.path]);
  };
  const confirm = () => {
    if (mode === 'folder') close({ path: data?.path });
    else if (mode === 'file') close({ path: sel[0] });
    else close({ paths: sel.length ? sel : [], copy });
  };
  const crumbs = data?.path ? data.path.split(/[\\/]/).filter(Boolean) : [];
  const sep = data?.path?.includes('\\') ? '\\' : '/';
  const crumbRoot = data?.path?.startsWith('/') ? '/' : ''; // macOS/Linux paths start at "/"
  return html`<${Modal} title=${title} onClose=${() => close(null)} width=${720} class="filebrowser"
    footer=${html`
      ${mode === 'media' ? html`<${Toggle} checked=${copy} onChange=${setCopy} label="Copy into project/media" title="Off: the project links to the file where it is (no copy)" />` : null}
      <div class="spacer"></div>
      <${Button} onClick=${() => close(null)}>Cancel</${Button}>
      ${mode === 'media' && data?.path ? html`<${Button} onClick=${() => close({ paths: [data.path], copy })} title="Import every media file in this folder">Import whole folder</${Button}>` : null}
      <${Button} kind="primary" disabled=${mode === 'folder' ? !data?.path : !sel.length} onClick=${confirm}>${okLabel || (mode === 'folder' ? 'Choose this folder' : mode === 'file' ? 'Choose' : `Import ${sel.length || ''}`)}</${Button}>`}>
    <div class="fb-bar">
      <${IconButton} icon="up" title="Up one level" disabled=${!data?.path} onClick=${() => setPath(data?.parent || null)} />
      <${IconButton} icon="home" title="Places" onClick=${() => setPath(null)} />
      <${IconButton} icon="folderPlus" title="New folder here" disabled=${!data?.path} onClick=${() => setNewName('New folder')} />
      <input class="input fb-path" value=${typed} placeholder="Type or paste a folder path and press Enter"
        onInput=${(e) => setTyped(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') setPath(typed.trim().replace(/^"|"$/g, '')); }} />
    </div>
    ${newName !== null ? html`<div class="fb-bar"><${Icon} name="folderPlus" size=${15} />
      <input class="input" data-esc value=${newName} ref=${(el) => el && !el.dataset.f && (el.dataset.f = 1, el.focus(), el.select())}
        onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') makeFolder(); if (e.key === 'Escape') setNewName(null); }} />
      <${Button} kind="primary" onClick=${makeFolder}>Create</${Button}><${Button} onClick=${() => setNewName(null)}>Cancel</${Button}></div>` : null}
    ${data?.path ? html`<div class="fb-crumbs">${crumbs.map((c, i) => html`<button class="link-btn" onClick=${() => setPath(crumbRoot + crumbs.slice(0, i + 1).join(sep) + (i === 0 && sep === '\\' ? '\\' : ''))}>${c}</button>${i < crumbs.length - 1 ? html`<span>›</span>` : null}`)}</div>` : null}
    ${err ? html`<div class="error-box">${err}</div>` : null}
    <div class="fb-list">
      ${!data?.path && data ? html`
        <div class="fb-group">Places</div>
        ${data.places.map((p) => html`<div class="fb-item is-dir" onClick=${() => setPath(p.path)}><${Icon} name="folder" size=${15} />${p.name}<span class="fb-meta">${p.path}</span></div>`)}
        <div class="fb-group">Drives</div>
        ${data.drives.map((d) => html`<div class="fb-item is-dir" onClick=${() => setPath(d)}><${Icon} name="hd" size=${15} />${d}</div>`)}` : null}
      ${entries.map((e) => html`<div class="fb-item ${e.dir ? 'is-dir' : ''} ${sel.includes(e.path) ? 'is-selected' : ''} ${!e.dir && !e.kind && !exts ? 'is-dim' : ''}"
        onClick=${(ev) => (e.dir ? null : pick(e, ev))} onDblClick=${() => (e.dir ? setPath(e.path) : (mode === 'media' ? close({ paths: [e.path], copy }) : mode === 'file' ? close({ path: e.path }) : null))}>
        <${Icon} name=${e.dir ? (e.isProject ? 'seq' : 'folder') : e.kind === 'audio' ? 'music' : e.kind === 'image' ? 'image' : e.kind === 'video' ? 'film' : 'square'} size=${15} />
        <span class="fb-name">${e.name}</span>
        ${e.isProject ? html`<span class="pill">project</span>` : null}
        <span class="fb-meta">${e.dir ? '' : fmtBytes(e.size)}</span>
      </div>`)}
      ${data?.path && !entries.length ? html`<div class="fb-empty">Empty folder</div>` : null}
    </div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ settings

// Theme cards show the theme at once (a preview); Settings › Save keeps it, Cancel puts the saved one back.
function ThemePicker({ value, onChange }) {
  return html`<div class="theme-grid">${THEMES.map((t) => html`<button type="button" class=${`theme-card${value === t.id ? ' is-on' : ''}`} onClick=${() => { applyTheme(t.id, { save: false }); onChange(t.id); }}>
    <span class="theme-preview" style=${{ background: t.swatch[0] }}>
      <i style=${{ left: '6px', top: '6px', width: '16px', bottom: '6px', background: t.swatch[1] }}></i>
      <i style=${{ left: '26px', top: '6px', right: '6px', height: '12px', background: t.swatch[1] }}></i>
      <i style=${{ left: '26px', bottom: '6px', width: '40%', height: '8px', background: t.swatch[2] }}></i>
    </span>${t.label}</button>`)}</div>`;
}

// Nothing takes effect until Save: Cancel (or closing) leaves every setting as it was, and a theme being tried out
// goes back to the saved one. `init`: the unsaved choices, carried while the dialog steps aside for Accounts,
// Keyboard shortcuts, Storage or the folder browser and opens again afterwards.
export function SettingsDialog({ close, init }) {
  const server = useStore(app, (s) => s.server);
  const [theme, setTheme] = useState(init?.theme ?? savedTheme());
  const [profile, setProfile] = useState(init?.profile ?? (server?.claudeConfigDir || ''));
  const [proxy, setProxy] = useState(init?.proxy ?? (server?.proxyMode || 'auto'));
  const cpus = server?.cpuCount || 4;
  const [perf, setPerf] = useState(init?.perf ?? { usage: 70, priority: 'low', jobs: 2, ...(server?.performance || {}) });
  const setP = (k) => (v) => setPerf({ ...perf, [k]: v });
  const [pre, setPre] = useState(init?.pre ?? { enabled: true, pauseOnBattery: true, light: true, maxGB: 20, ...(server?.prerender || {}) });
  const [cacheDir, setCacheDir] = useState(init?.cacheDir ?? (server?.cacheDir || ''));
  const gpuInfo = useStore(app, (s) => s.server?.gpu);
  const [gpu, setGpu] = useState(init?.gpu ?? { device: null, draft: 'gpu', high: 'gpu', battery: 'gpu', ...(server?.gpu?.settings || {}) });
  const setG = (k) => (v) => setGpu({ ...gpu, [k]: v });
  const [scheduler, setScheduler] = useState(init?.scheduler ?? (server?.scheduler || 'smart'));
  const [exactPause, setExactPause] = useState(init?.exactPause ?? (server?.exactPause !== false));
  const draft = { theme, profile, proxy, perf, pre, cacheDir, gpu, scheduler, exactPause };
  // leaving without Save puts the saved theme back, unless the dialog only steps aside and comes back
  const kept = useRef(false);
  useEffect(() => () => { if (!kept.current && currentTheme() !== savedTheme()) applyTheme(savedTheme(), { save: false }); }, []);
  const stepAside = () => { kept.current = true; return () => openDialog(SettingsDialog, { init: draft }); };
  const [detecting, setDetecting] = useState(false);
  const detectAgain = async () => {
    setDetecting(true);
    try {
      const info = await post('/api/gpu/detect');
      app.set((s) => ({ ...s, server: { ...s.server, gpu: info } }));
      if (gpu.device && !info.detected?.devices?.some((d) => d.id === gpu.device && d.encode)) setGpu({ ...gpu, device: null });
    } catch (e) { notify(e.message, 'error'); } finally { setDetecting(false); }
  };
  const devices = gpuInfo?.detected?.devices || [];
  const usable = devices.filter((d) => d.encode);
  // the cache folder is chosen here and saved with the rest; the browser version's folder browser replaces this
  // dialog, which then opens again with the choice (the desktop app's system dialog leaves it where it is)
  const pickCacheDir = async () => {
    const back = window.jimmyApp?.pick ? null : stepAside();
    const r = await pickPath({ title: 'Cache folder', mode: 'folder', startPath: cacheDir || undefined, okLabel: 'Use this folder' });
    if (back) openDialog(SettingsDialog, { init: { ...draft, ...(r?.path ? { cacheDir: r.path } : {}) } });
    else if (r?.path) setCacheDir(r.path);
  };
  const save = async () => {
    const cacheChanged = (cacheDir || '') !== (server?.cacheDir || '');
    await post('/api/settings', { claudeConfigDir: profile || null, proxyMode: proxy, performance: perf, prerender: pre, ...(gpuInfo ? { gpu } : {}), scheduler, exactPause, ...(cacheChanged ? { cacheDir: cacheDir || null } : {}) });
    applyTheme(theme);
    kept.current = true;
    app.set({ server: await get('/api/state') });
    notify(cacheChanged ? 'Settings saved. Restart Jimmy to use the new cache folder everywhere; old caches can be cleared in Storage.' : 'Settings saved', cacheChanged ? 'info' : 'success');
    close(true);
  };
  return html`<${Modal} title="Settings" onClose=${() => close(null)} width=${520}
    footer=${html`<${Button} kind="danger" icon="x" title="Stops the background server and every embedded Claude session" onClick=${async () => {
      const again = app.get().server?.desktop ? 'Open the Jimmy app to start it again.' : 'Start it again with npm start.';
      const back = stepAside();
      if (!(await confirmDialog('Quit Jimmy?', `This stops the background server and every Claude session running inside the editor. ${again}`, 'Quit'))) { back(); return; }
      post('/api/shutdown').catch(() => {});
      setTimeout(() => window.close(), 300);
    }}>Quit Jimmy</${Button}><div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" onClick=${save}>Save</${Button}>`}>
    <div class="form">
      <div class="field"><span>Theme</span><${ThemePicker} value=${theme} onChange=${setTheme} /></div>
      <div class="field"><span>Default Claude account for new projects</span>
        <div class="field-row" style=${{ gap: '6px' }}>
          <${Select} value=${profile} onChange=${setProfile} options=${[{ value: '', label: 'Inherit from the server environment' }, ...(server?.claudeProfiles || []).map((p) => ({ value: p.dir, label: `${p.name} — ${p.dir}` }))]} />
          <${Button} icon="sparkle" title="See who is signed in, sign in or out, add an account" onClick=${() => { const back = stepAside(); close(null); openAccounts({ onBack: back }); }}>Accounts…</${Button}>
        </div>
      </div>
      <label class="field"><span>Preview proxies</span>
        <${Segmented} value=${proxy} onChange=${setProxy} options=${[{ value: 'auto', label: 'Auto' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Only when needed' }]} />
      </label>
      <div class="dialog-hint">Auto makes lightweight preview copies for formats the browser can't play (HEVC, ProRes…) and for very large video. Always makes them for every video — smoothest scrubbing on long-GOP camera files. Exports always use the original files.</div>
      <label class="field"><span>How much of this computer exports and pre-rendering may use</span>
        <${Segmented} value=${String(perf.usage)} onChange=${(v) => setPerf({ ...perf, usage: Number(v) })} options=${[{ value: '25', label: '25%' }, { value: '50', label: '50%' }, { value: '70', label: '70%' }, { value: '100', label: '100%' }]} />
      </label>
      <div class="dialog-hint">A target, not an exact figure: it sets how many parts of a timeline render side by side (about ${Math.max(1, Math.round((cpus * perf.usage) / 100))} of ${cpus} cores here). Higher is faster; lower leaves more for other apps.</div>
      <div class="field"><span>Background pre-rendering</span>
        <${Toggle} checked=${pre.enabled} onChange=${(v) => setPre({ ...pre, enabled: v })} label="Pre-render the sequences you turn it on for, while you edit, so their exports take seconds" />
        <${Toggle} checked=${pre.pauseOnBattery} onChange=${(v) => setPre({ ...pre, pauseOnBattery: v })} label="Pause on battery power" />
        <${Toggle} checked=${pre.light !== false} onChange=${(v) => setPre({ ...pre, light: v })} label="Lighter on the disk: only the tab you're on, plain camera clips once you've been idle 2 min, and a pause after your last edit" />
        <div class="field-row" style=${{ gap: '8px', alignItems: 'center' }}><span class="muted" style=${{ flex: 'none' }}>Keep at most</span>
          <input class="input" type="number" min="1" max="2000" style=${{ width: '80px', flex: 'none' }} value=${pre.maxGB} onInput=${(e) => setPre({ ...pre, maxGB: e.target.value })} />
          <span class="muted">GB of pre-rendered chunks (all projects; oldest are removed first)</span></div>
      </div>
      <div class="dialog-hint">It is off for every sequence until you turn it on for one: right-click the sequence (its tab above the timeline, or in the bin) › Pre-render this sequence. Pre-rendering waits a few seconds after each edit, pauses while you play or scrub, and always gives way to exports. Chunks that no longer match the timeline are removed automatically, and a sequence's chunks are cleared when a version is marked Approved.</div>
      <div class="field"><span>Hardware acceleration</span>
        ${detecting || gpuInfo?.detecting ? html`<div class="gpu-row"><span class="spinner spinner-xs"></span> Looking for graphics hardware and testing it…</div>`
          : !gpuInfo ? html`<div class="muted">Restart Jimmy to use hardware acceleration.</div>`
          : devices.length ? devices.map((d) => html`<div class="gpu-row ${d.encode ? '' : 'is-off'}">
              <${Icon} name=${d.encode ? 'checkCircle' : 'alert'} size=${13} />
              <div><b>${d.name}</b><div class="muted">${d.encode ? gpuSummary(d) : `Not usable here: ${d.error}`}</div></div>
            </div>`)
          : html`<div class="muted">No graphics hardware that can encode video was found. Exports use the CPU.</div>`}
        ${gpuInfo?.failed ? html`<div class="error-box">The ${gpuInfo.failed.device} GPU failed during an export and is set aside until Jimmy restarts (or Detect again): ${gpuInfo.failed.reason}</div>` : null}
        ${usable.length ? html`<label class="field-row" style=${{ gap: '8px', alignItems: 'center' }}><span class="muted" style=${{ flex: 'none' }}>Use for exports</span>
          <${Select} value=${gpu.device || ''} onChange=${(v) => setG('device')(v || null)} options=${[{ value: '', label: 'None: CPU only' }, ...usable.map((d) => ({ value: d.id, label: d.name }))]} /></label>` : null}
        ${gpu.device && usable.some((d) => d.id === gpu.device) ? html`
          <label class="field-row gpu-choice"><span class="muted">Draft exports</span><${Segmented} value=${gpu.draft} onChange=${setG('draft')} options=${[{ value: 'gpu', label: 'GPU' }, { value: 'cpu', label: 'CPU' }]} /></label>
          <label class="field-row gpu-choice"><span class="muted">High and standard exports, and pre-rendering</span><${Segmented} value=${gpu.high} onChange=${setG('high')} options=${[{ value: 'gpu', label: 'GPU' }, { value: 'cpu', label: 'CPU' }]} /></label>
          <label class="field-row gpu-choice"><span class="muted">On battery</span><${Segmented} value=${gpu.battery} onChange=${setG('battery')} options=${[{ value: 'gpu', label: 'Keep GPU' }, { value: 'cpu', label: 'Use CPU' }]} /></label>` : null}
        <div class="field-row" style=${{ gap: '8px', alignItems: 'center' }}><${Button} icon="refresh" disabled=${detecting || gpuInfo?.detecting || !gpuInfo} onClick=${detectAgain}>Detect again</${Button}>
          <span class="muted">${gpuInfo?.detected?.at ? `Tested ${new Date(gpuInfo.detected.at).toLocaleString()}` : ''}</span></div>
      </div>
      <div class="dialog-hint">Motion graphics always render on the CPU (a browser draws them and they're saved with transparency), so with exports on the GPU both run side by side. GPU H.264 matches the CPU's picture quality; files can be a little larger. NVIDIA, Intel and AMD GPUs can't make ProRes: those exports encode on the CPU but still read 4K and HEVC footage on the GPU. GPU encoding uses less power than the CPU, so keeping it on battery is usually fine. If the GPU fails during an export, that export finishes on the CPU.</div>
      <label class="field"><span>Preview</span>
        <${Toggle} checked=${exactPause} onChange=${setExactPause} label="Exact frame when paused: a moment after you stop, the preview shows the frame exactly as it will export" />
      </label>
      <label class="field"><span>Scheduling of background work</span>
        <${Segmented} value=${scheduler} onChange=${setScheduler} options=${[{ value: 'smart', label: 'Smart' }, { value: 'classic', label: 'Classic' }]} />
      </label>
      <div class="dialog-hint">Smart shares the machine out by what matters most right now: your clicks and playback first, then motion graphics, exports, proxies and pre-rendering, each weighted by how urgent it is and how long it has waited. While you edit, background work leaves room (about 70%); while you play or scrub, about a third; after 20 seconds away it takes the whole machine. Pre-rendering waits while an export or a graphic renders, and proxies use every spare slot when nothing renders. Classic is the earlier fixed rules (graphics and exports on the CPU take turns).</div>
      <label class="field"><span>Background job priority</span>
        <${Segmented} value=${perf.priority} onChange=${setP('priority')} options=${[{ value: 'normal', label: 'Normal' }, { value: 'low', label: 'Low' }, { value: 'idle', label: 'Idle' }]} />
      </label>
      <label class="field"><span>Media jobs at once (proxies, thumbnails, waveforms)</span>
        <${Segmented} value=${String(perf.jobs)} onChange=${(v) => setPerf({ ...perf, jobs: Number(v) })} options=${['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} />
      </label>
      <div class="dialog-hint">Proxies, thumbnails, waveforms and exports run as separate processes spread over these cores. Low priority keeps the editor and the rest of the laptop responsive while they work; Normal finishes exports faster.</div>
      <div class="field"><span>Keyboard shortcuts</span>
        <div class="field-row" style=${{ gap: '8px', alignItems: 'center' }}><${Button} icon="keyboard" onClick=${() => { const back = stepAside(); close(null); openShortcuts(back); }}>Keyboard shortcuts…</${Button}>
        <span class="muted">Every key, laid out like Premiere's shortcut map</span></div></div>
      <div class="field"><span>Storage & cache</span>
        <div class="field-row" style=${{ gap: '8px', alignItems: 'center' }}><${Button} icon="trash" onClick=${() => { const back = stepAside(); close(null); openStorage(back); }}>View and clear…</${Button}>
        <span class="muted">Media caches, pre-rendered chunks, chat attachments, old drafts, browser data</span></div></div>
      <div class="field"><span>Cache folder</span>
        <div class="field-row" style=${{ gap: '6px' }}>
          <code class="codebox" style=${{ flex: 1 }}>${cacheDir || 'Not set (each project + system Temp)'}</code>
          <div style=${{ flex: 'none', display: 'flex', gap: '6px' }}><${Button} icon="folder" onClick=${pickCacheDir}>Choose…</${Button}>
          ${cacheDir ? html`<${Button} kind="ghost" onClick=${() => setCacheDir('')}>Reset</${Button}>` : null}</div>
        </div></div>
      <div class="dialog-hint">One folder for everything the app can rebuild: thumbnails, waveforms, preview proxies, pre-rendered chunks and temp files. Pick a folder on another drive to keep C: free; delete it any time (quit Jimmy first).</div>
      <div class="field"><span>Projects folder</span><code class="codebox">${server?.projectsRoot}</code></div>
      <div class="field"><span>Claude CLI for project folders</span><code class="codebox">node "${server?.appDir}/bin/vedit.mjs" status</code></div>
    </div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ source preview (double-click a bin item)

export function SourcePreview({ close, tab, media }) {
  const vref = useRef(null);
  const [inP, setIn] = useState(0);
  const [outP, setOut] = useState(media.duration || 0);
  const [t, setT] = useState(0);
  const st = tab.store.get().mediaStatus[media.id];
  const url = st?.exists ? mediaUrl(tab.projectId, media.id, 'preview', `${st.key}${st.proxy === 'ready' ? 'p' : ''}`) : null;
  const fps = media.fps || tab.seq?.fps || 30;
  const insert = () => {
    const start = snapTime(tab.time.get().t, tab.seq.fps);
    tab.apply('Insert media', (d, ds) => {
      const ids = insertMedia(d, ds, d.media.find((m) => m.id === media.id), { start, inPoint: inP, duration: media.type === 'image' ? undefined : Math.max(1 / fps, outP - inP) });
      tab.ui.set({ selection: ids });
    });
    close(true);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const v = vref.current;
      if (!v) return;
      if (e.key === 'i') setIn(v.currentTime);
      else if (e.key === 'o') setOut(v.currentTime);
      else if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const isImage = media.type === 'image';
  return html`<${Modal} title=${media.name} onClose=${() => close(null)} width=${760} class="source-preview"
    footer=${html`<div class="dialog-hint">${isImage ? 'Image' : `I / O to mark · in ${timecode(inP, fps)} · out ${timecode(outP, fps)} · ${timecode(Math.max(0, outP - inP), fps)}`}</div>
      <div class="spacer"></div><${Button} onClick=${() => close(null)}>Close</${Button}>
      <${Button} kind="primary" icon="plus" disabled=${!tab.seq} onClick=${insert}>Insert at playhead</${Button}>`}>
    ${!url ? html`<div class="error-box">Media offline</div>`
      : isImage ? html`<img class="sp-media" src=${url} />`
      : media.type === 'audio' ? html`<audio ref=${vref} class="sp-audio" src=${url} controls onTimeUpdate=${(e) => setT(e.target.currentTime)} />`
      : html`<video ref=${vref} class="sp-media" src=${url} controls onTimeUpdate=${(e) => setT(e.target.currentTime)}></video>`}
    ${!isImage && media.duration ? html`<div class="sp-range">
      <div class="sp-range-fill" style=${{ left: `${(inP / media.duration) * 100}%`, width: `${((outP - inP) / media.duration) * 100}%` }}></div>
      <div class="sp-range-head" style=${{ left: `${(t / media.duration) * 100}%` }}></div>
    </div>
    <div class="btn-row">
      <${Button} kind="ghost" onClick=${() => setIn(vref.current?.currentTime || 0)}>Mark in (I)</${Button}>
      <${Button} kind="ghost" onClick=${() => setOut(vref.current?.currentTime || media.duration)}>Mark out (O)</${Button}>
      <${Button} kind="ghost" onClick=${() => { setIn(0); setOut(media.duration); }}>Clear</${Button}>
    </div>` : null}
  </${Modal}>`;
}
