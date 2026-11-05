// Reframe with Claude: the person picks the new frame size and what must stay in frame; Jimmy writes Claude a careful
// brief (reframePrompt) and sends it to the sequence's chat. Claude then makes a copy at the new size and frames every
// shot itself by looking at its frames, which follows a subject, keeps text and products in frame and avoids black
// edges far better than a fixed crop could.
import { html, Modal, Button, Select, Toggle } from './common.js';
import { useState } from 'preact/hooks';
import { findSequence } from '../core/model.js';
import { sendToClaude } from './ClaudePanel.js';
import { openDialog, notify } from '../core/notify.js';

export const FRAMES = [
  { value: '1080x1920', label: '9:16 vertical · 1080×1920 (Reels, Shorts, TikTok)', tag: '9x16' },
  { value: '1080x1350', label: '4:5 portrait · 1080×1350 (Instagram feed)', tag: '4x5' },
  { value: '1080x1080', label: '1:1 square · 1080×1080', tag: '1x1' },
  { value: '1920x1080', label: '16:9 landscape · 1920×1080 (YouTube)', tag: '16x9' },
  { value: '3840x2160', label: '16:9 4K · 3840×2160', tag: '4K' },
  { value: 'custom', label: 'Custom size…' },
];
export const KEEP = [
  { id: 'faces', label: "People's faces, with headroom (eyes on the upper third)" },
  { id: 'text', label: 'Text in the footage: titles, signs, screens, captions burnt in' },
  { id: 'product', label: 'Products and the main object being shown' },
  { id: 'hands', label: 'Hands and gestures when they show something' },
];

// The brief Claude gets. Everything it needs to do this without asking: the sizes, the maths for filling the frame
// without black edges, how to judge each shot, what to keep, how to treat text clips, and how to check.
export function reframePrompt(seq, { width, height, name, keep = [], extra = '', follow = true, zoom = true, relayout = true }) {
  const keepText = KEEP.filter((k) => keep.includes(k.id)).map((k) => `  - ${k.label}`);
  if (extra.trim()) keepText.push(`  - ${extra.trim()}`);
  return `Reframe the sequence "${seq.name}" (${seq.id}, ${seq.width}×${seq.height}) for ${width}×${height}. Work carefully, shot by shot: the person will judge every frame.

1. Leave "${seq.name}" exactly as it is. Add a copy to project.json named "${name}": same clips, tracks, fps and audio, every clip and the sequence with new unique ids (link ids too, in pairs), width ${width} and height ${height}. Then run \`vedit link <new sequence id>\` and work only on the copy.
2. For every video and image clip, find what matters in the shot, in this order of importance:
${keepText.length ? keepText.join('\n') : '  - the main subject of the shot'}
   Look rather than guess: \`vedit frame <times…> --seq <new id>\` at the start, middle and end of each clip (several times in one call), and for wide shots also a frame of the source at full size if the subject is small.
3. Fill the frame, never leave black edges: a clip of source size w×h needs transform.scale ≥ max(${width}/w, ${height}/h). transform.x / y are pixel offsets of the clip's centre from the frame's centre (+y = down), and to keep the frame covered |x| ≤ (w·scale − ${width})/2 and |y| ≤ (h·scale − ${height})/2. Put the subject where a camera operator would: faces with headroom, eyes about a third from the top, looking room on the side they face.
${follow ? `4. When the subject moves within a clip, follow it with x (and y) keyframes at the moments it moves, eased (easeInOut), slow and smooth, never jittering; one framing per shot when it stays still.` : `4. Use one fixed framing per clip (no moves inside a clip); choose the one that keeps the subject in frame for the whole clip.`}
${zoom ? `5. Where the subject is small in a wide shot, you may scale in further (up to about 1.5× the fill scale, more only if the footage is sharp enough at that size) to keep it readable.` : `5. Don't zoom in beyond what is needed to fill the frame.`}
${relayout ? `6. Text clips, captions and graphics: keep them inside the new frame's safe area (5% margin each side, bottom captions above the lowest 15% for vertical frames). Set style.maxWidth to about 90% of ${width} and reduce style.size if a line would be too long; keep their timing and look. Motion graphics made for the old shape: scale them to fit the width and say which ones would look better redesigned.` : `6. Leave text clips and graphics as they are.`}
7. Check your work: \`vedit frame\` at every cut and every few seconds in long clips, Read them, and fix any face, text or product that is cut off or crowded, and any black edge.
8. Keep project.json edits small (one sequence), re-read it before each. Finish with one short list: the shots that needed a judgement call, and anything you'd like the person to look at.`;
}

export function ReframeDialog({ close, tab, seqId }) {
  const seq = findSequence(tab.doc, seqId);
  const [frame, setFrame] = useState(seq && seq.width > seq.height ? '1080x1920' : '1920x1080');
  const [cw, setCw] = useState(1080), [ch, setCh] = useState(1920);
  const [keep, setKeep] = useState(['faces', 'text', 'product']);
  const [extra, setExtra] = useState('');
  const [follow, setFollow] = useState(true);
  const [zoom, setZoom] = useState(true);
  const [relayout, setRelayout] = useState(true);
  const [w, h] = frame === 'custom' ? [Math.round(+cw), Math.round(+ch)] : frame.split('x').map(Number);
  const tag = FRAMES.find((f) => f.value === frame)?.tag || `${w}x${h}`;
  const [name, setName] = useState(null);
  const shownName = name ?? `${seq?.name || 'Sequence'} ${tag}`;
  const valid = seq && w >= 16 && h >= 16 && w <= 8192 && h <= 8192 && (w !== seq.width || h !== seq.height);
  const go = async () => {
    const text = reframePrompt(seq, { width: w, height: h, name: shownName.trim() || `${seq.name} ${tag}`, keep, extra, follow, zoom, relayout });
    close(text);
    if (await sendToClaude(tab, text, seq.id)) notify(`Claude is reframing "${seq.name}" for ${w}×${h}. The copy appears in the bin`, 'claude');
  };
  if (!seq) return null;
  return html`<${Modal} title="Reframe with Claude" onClose=${() => close(null)} width=${520}
    footer=${html`<div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="claude" icon="sparkle" disabled=${!valid} onClick=${go}>Send to Claude</${Button}>`}>
    <div class="form">
      <div class="muted">"${seq.name}" is ${seq.width}×${seq.height}. Claude makes a copy at the new size and frames every shot by looking at it; the original stays as it is.</div>
      <label class="field"><span>New frame</span><${Select} value=${frame} onChange=${setFrame} options=${FRAMES.map((f) => ({ value: f.value, label: f.label }))} /></label>
      ${frame === 'custom' ? html`<div class="field-row">
        <label class="field"><span>Width</span><input class="input" type="number" min="16" max="8192" value=${cw} onInput=${(e) => setCw(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} /></label>
        <label class="field"><span>Height</span><input class="input" type="number" min="16" max="8192" value=${ch} onInput=${(e) => setCh(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} /></label></div>` : null}
      <div class="field"><span>Keep in frame</span>
        ${KEEP.map((k) => html`<${Toggle} checked=${keep.includes(k.id)} onChange=${(v) => setKeep(v ? [...keep, k.id] : keep.filter((x) => x !== k.id))} label=${k.label} />`)}
        <input class="input" placeholder="Anything else, e.g. the logo on the mug, both people in two-shots" value=${extra} onInput=${(e) => setExtra(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} />
      </div>
      <div class="field"><span>How</span>
        <${Toggle} checked=${follow} onChange=${setFollow} label="Follow the subject when it moves (smooth keyframed pans)" />
        <${Toggle} checked=${zoom} onChange=${setZoom} label="Zoom in where the subject is small in a wide shot" />
        <${Toggle} checked=${relayout} onChange=${setRelayout} label="Refit titles, captions and graphics to the new frame" />
      </div>
      <label class="field"><span>New sequence name</span><input class="input" value=${shownName} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.stopPropagation()} /></label>
      ${valid ? null : html`<div class="dialog-hint">${w === seq.width && h === seq.height ? 'That is the sequence\'s own size.' : 'Give a size between 16 and 8192.'}</div>`}
    </div>
  </${Modal}>`;
}

export const openReframe = (tab, seqId) => openDialog(ReframeDialog, { tab, seqId });
