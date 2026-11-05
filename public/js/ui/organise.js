// Organise the project bin: media go into folders by what they are. Two sources, the better one winning:
// - Claude's tags: a media item may carry `role` (one of ROLES) and `tags` (a few short words: who, where, what kind
//   of shot), which Claude writes into project.json when asked ("Ask Claude to tag" below, or the project's CLAUDE.md).
// - The file itself, instantly and for free: motion graphics, stills, audio by its folder or name (music, sound
//   effects, voice-over), video by its folder (A_Roll, B_Roll, screen recordings).
// One Organise is one undoable edit. By default only items not in a folder yet move, so the person's own folders
// stay as they are. Claude's first tag can make sub-folders (B-Roll / Product shots).
import { html, Modal, Button, Toggle, Icon } from './common.js';
import { useState } from 'preact/hooks';
import { uid } from '../core/model.js';
import { isMotion } from './motion.js';
import { sendToClaude } from './ClaudePanel.js';
import { openDialog, notify } from '../core/notify.js';

// role id → folder name, in the order folders are listed
export const ROLES = [
  ['a-roll', 'A-Roll'], ['b-roll', 'B-Roll'], ['screen', 'Screen recordings'], ['footage', 'Footage'],
  ['graphics', 'Graphics'], ['stills', 'Stills'],
  ['voiceover', 'Voice-over'], ['music', 'Music'], ['sfx', 'Sound effects'], ['audio', 'Audio'],
];
const ROLE_NAME = Object.fromEntries(ROLES);

// what the file says about itself: its folder names, its name, its type
export function factsRole(m) {
  const where = String(m.path || '').replace(/\\/g, '/').toLowerCase();
  const dirs = where.split('/').slice(0, -1).join('/');
  const name = where.split('/').pop() || '';
  const has = (re) => re.test(dirs) || re.test(name);
  if (isMotion(m)) return 'graphics';
  if (m.type === 'image') return has(/overlay|graphic|logo|title|lower.?third|caption/) ? 'graphics' : 'stills';
  if (m.type === 'audio') {
    if (has(/music|bgm|song|score|track\d/)) return 'music';
    if (has(/sfx|foley|sound.?effect|whoosh|swoosh|(^|[^a-z])fx([^a-z]|$)/)) return 'sfx';
    if (has(/voice|(^|[^a-z])vo([^a-z]|$)|narrat|dialog/)) return 'voiceover';
    return 'audio';
  }
  if (has(/a[ _-]?roll|interview|talking.?head/)) return 'a-roll';
  if (has(/b[ _-]?roll|stock|cutaway|insert/)) return 'b-roll';
  if (has(/screen|recording|capture|screencast/)) return 'screen';
  if (has(/overlay|graphic|lower.?third|title/)) return 'graphics';
  return 'footage';
}
export const roleOf = (m) => (ROLE_NAME[m.role] ? m.role : factsRole(m));
const tagged = (m) => !!ROLE_NAME[m.role] || (Array.isArray(m.tags) && m.tags.length > 0);
const subName = (m) => (Array.isArray(m.tags) && m.tags[0] ? String(m.tags[0]).trim().replace(/^\w/, (c) => c.toUpperCase()).slice(0, 40) : null);

// The plan: [{ name, sub, items: [media], exists }] in ROLES order, sub-folders after their folder.
export function organisePlan(doc, { onlyLoose = true, subFolders = false } = {}) {
  const groups = new Map();
  for (const m of doc.media) {
    if (onlyLoose && m.folder) continue;
    const name = ROLE_NAME[roleOf(m)];
    const sub = subFolders ? subName(m) : null;
    const key = `${name}\u0000${sub || ''}`;
    if (!groups.has(key)) groups.set(key, { name, sub, items: [] });
    groups.get(key).items.push(m);
  }
  const order = ROLES.map(([, n]) => n);
  const rootFolder = (n) => doc.folders.find((f) => !f.parent && f.name === n);
  return [...groups.values()]
    .map((g) => ({ ...g, exists: !!rootFolder(g.name) && (!g.sub || doc.folders.some((f) => f.parent === rootFolder(g.name)?.id && f.name === g.sub)) }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name) || String(a.sub || '').localeCompare(String(b.sub || '')));
}

// Carries out a plan on a project (inside tab.apply): folders found by name at the root (or made), media moved in.
export function applyPlan(d, plan) {
  let moved = 0;
  const folderNamed = (name, parent) => {
    let f = d.folders.find((x) => (x.parent || null) === parent && x.name === name);
    if (!f) { f = { id: uid('f'), name, parent }; d.folders.push(f); }
    return f.id;
  };
  for (const g of plan) {
    const top = folderNamed(g.name, null);
    const target = g.sub ? folderNamed(g.sub, top) : top;
    for (const m of g.items) {
      const it = d.media.find((x) => x.id === m.id);
      if (it && it.folder !== target) { it.folder = target; moved++; }
    }
  }
  return moved;
}

// What Claude is asked, for the media that have no role or tags yet.
export function tagPrompt(doc, list = doc.media.filter((m) => !tagged(m))) {
  const shown = list.slice(0, 150);
  const lines = shown.map((m) => `- ${m.id}  ${m.name}  (${isMotion(m) ? 'motion graphic' : m.type}${m.duration ? `, ${Math.round(m.duration)} s` : ''})`);
  return `Please tag the media in this project's bin so Jimmy can organise it into folders. For each item below, add two fields to its entry in project.json's "media" list:
- "role": one of ${ROLES.map(([r]) => r).join(', ')}
- "tags": 2 to 5 short lowercase words about what is in it (who, where, what kind of shot or sound), most useful first, e.g. ["product shot", "kitchen", "close-up"]
Look at the video and images cheaply: make contact sheets of about 12 to 20 clips each with ffmpeg (one frame from the middle of each clip) in a temp folder and Read those, not one image per clip. Judge audio by its name, folder and length. Change only "role" and "tags" (never names, paths or anything else), with small Edits, and re-read project.json before each one. Reply with one short line when done.
${lines.join('\n')}${list.length > shown.length ? `\n…and ${list.length - shown.length} more without tags: do those too (\`vedit status\` lists every media item).` : ''}`;
}

export function OrganiseDialog({ close, tab }) {
  const doc = tab.doc;
  const anyTags = doc.media.some((m) => Array.isArray(m.tags) && m.tags.length);
  const [onlyLoose, setOnlyLoose] = useState(true);
  const [subFolders, setSubFolders] = useState(anyTags);
  const plan = organisePlan(doc, { onlyLoose, subFolders });
  const count = plan.reduce((n, g) => n + g.items.length, 0);
  const untagged = doc.media.filter((m) => !tagged(m));
  const go = () => {
    let moved = 0;
    tab.apply('Organise bin', (d) => { moved = applyPlan(d, plan); return moved ? undefined : false; });
    const folders = new Set(plan.map((g) => g.name)).size;
    notify(moved ? `Organised ${moved} item${moved === 1 ? '' : 's'} into ${folders} folder${folders === 1 ? '' : 's'}. Ctrl+Z to undo` : 'Everything is already in place', moved ? 'success' : 'info');
    close(moved);
  };
  const askClaude = async () => {
    close(null);
    if (await sendToClaude(tab, tagPrompt(doc, untagged), null)) notify('Claude is tagging the media. Open Organise again when it is done', 'claude');
  };
  return html`<${Modal} title="Organise the bin" onClose=${() => close(null)} width=${500}
    footer=${html`${untagged.length ? html`<${Button} icon="sparkle" kind="claude" title="Claude looks at the clips and writes a role and a few tags into the project; Organise then uses them" onClick=${askClaude}>Ask Claude to tag ${untagged.length === doc.media.length ? 'them' : `the ${untagged.length} untagged`}</${Button}>` : null}
      <div class="spacer"></div><${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" icon="folder" disabled=${!count} onClick=${go}>Organise</${Button}>`}>
    <div class="form">
      ${count ? html`<div class="organise-plan">${plan.map((g) => html`<div class="organise-row">
          <${Icon} name="folder" size=${14} /><span class="organise-name">${g.name}${g.sub ? html` <span class="muted">/ ${g.sub}</span>` : null}</span>
          <span class="muted">${g.items.length} item${g.items.length === 1 ? '' : 's'}${g.exists ? '' : ' · new folder'}</span>
        </div>`)}</div>`
        : html`<div class="muted">${onlyLoose ? 'Every item is in a folder already.' : 'No media in this project yet.'}</div>`}
      <${Toggle} checked=${onlyLoose} onChange=${setOnlyLoose} label="Only items that aren't in a folder yet (your own folders stay as they are)" />
      ${anyTags ? html`<${Toggle} checked=${subFolders} onChange=${setSubFolders} label="Sub-folders from Claude's first tag (e.g. B-Roll / Product shot)" />` : null}
      <div class="dialog-hint">${untagged.length === doc.media.length
        ? 'Sorted by what the files themselves say: motion graphics, stills, audio by its folder or name (music, sound effects, voice-over), video by its folder (A_Roll, B_Roll, screen recordings). Ask Claude to tag the media for sorting by what is in them.'
        : `${doc.media.length - untagged.length} of ${doc.media.length} items have Claude's role and tags; the rest are sorted by what the files say.`} One Ctrl+Z puts everything back.</div>
    </div>
  </${Modal}>`;
}

export const openOrganise = (tab) => openDialog(OrganiseDialog, { tab });
