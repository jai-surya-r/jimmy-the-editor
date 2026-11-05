// Keyboard shortcuts: every command the editor's keys can run, its default keys, and the user's own layout presets
// (edited in the Keyboard Shortcuts window, shortcuts.js). Key handlers ask commandOf(e, ctx) which command a key press
// runs instead of testing keys themselves, so a remapped shortcut works everywhere at once.
//
// Combos are written "Ctrl+Shift+Alt+Key". "Ctrl" is Cmd on a Mac, so one layout works on both.
// ctx: 'app' runs everywhere in a project; the others only in that place: 'edit' (the Edit tab: viewer, timeline, tools),
// 'graph' (graph editor window), 'bin' (project bin), 'review', 'motion'. One combo can run one command per place,
// and an 'app' combo can't be reused anywhere.
// Layouts are saved in the server's config.json (keymap: { preset, presets: { name: { commandId: [combos] } } }),
// each preset holding only the commands it changes from the defaults.
import { createStore } from '../core/store.js';
import { app } from '../core/app.js';
import { post } from '../core/api.js';

export const COMMANDS = [
  { id: 'app.undo', area: 'Application', ctx: 'app', cmd: 'Undo', keys: ['Ctrl+Z'] },
  { id: 'app.redo', area: 'Application', ctx: 'app', cmd: 'Redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'] },
  { id: 'app.export', area: 'Application', ctx: 'app', cmd: 'Export…', keys: ['Ctrl+E'] },
  { id: 'app.shortcuts', area: 'Application', ctx: 'app', cmd: 'Keyboard shortcuts', keys: ['Ctrl+Alt+K'] },
  { id: 'app.claude', area: 'Panels', ctx: 'app', cmd: 'Show / hide the AI panel (chat and terminal)', keys: ['Ctrl+J', 'Ctrl+`'] },
  { id: 'edit.graph', area: 'Panels', ctx: 'edit', cmd: 'Graph editor', keys: ['Shift+G'] },

  { id: 'tool.select', area: 'Tools', ctx: 'edit', cmd: 'Selection tool', keys: ['V'] },
  { id: 'tool.trackfwd', area: 'Tools', ctx: 'edit', cmd: 'Track Select Forward tool', keys: ['A'] },
  { id: 'tool.trackback', area: 'Tools', ctx: 'edit', cmd: 'Track Select Backward tool', keys: ['Shift+A'] },
  { id: 'tool.ripple', area: 'Tools', ctx: 'edit', cmd: 'Ripple Edit tool', keys: ['B'] },
  { id: 'tool.roll', area: 'Tools', ctx: 'edit', cmd: 'Rolling Edit tool', keys: ['N'] },
  { id: 'tool.ratestretch', area: 'Tools', ctx: 'edit', cmd: 'Rate Stretch tool', keys: ['R'] },
  { id: 'tool.razor', area: 'Tools', ctx: 'edit', cmd: 'Razor tool', keys: ['C'] },
  { id: 'tool.slip', area: 'Tools', ctx: 'edit', cmd: 'Slip tool', keys: ['Y'] },
  { id: 'tool.slide', area: 'Tools', ctx: 'edit', cmd: 'Slide tool', keys: ['U'] },
  { id: 'tool.pen', area: 'Tools', ctx: 'edit', cmd: 'Pen tool', keys: ['P'] },
  { id: 'tool.hand', area: 'Tools', ctx: 'edit', cmd: 'Hand tool', keys: ['H'] },
  { id: 'tool.zoom', area: 'Tools', ctx: 'edit', cmd: 'Zoom tool (Alt+click zooms out)', keys: ['Z'] },

  { id: 'play.toggle', area: 'Playback', ctx: 'edit', cmd: 'Play / Stop', keys: ['Space'] },
  { id: 'play.left', area: 'Playback', ctx: 'edit', cmd: 'Shuttle left', keys: ['J'] },
  { id: 'play.stop', area: 'Playback', ctx: 'edit', cmd: 'Shuttle stop', keys: ['K'] },
  { id: 'play.right', area: 'Playback', ctx: 'edit', cmd: 'Shuttle right', keys: ['L'] },
  { id: 'play.prevFrame', area: 'Playback', ctx: 'edit', cmd: 'Step back one frame', keys: ['Left'] },
  { id: 'play.nextFrame', area: 'Playback', ctx: 'edit', cmd: 'Step forward one frame', keys: ['Right'] },
  { id: 'play.prevSecond', area: 'Playback', ctx: 'edit', cmd: 'Step back one second', keys: ['Shift+Left'] },
  { id: 'play.nextSecond', area: 'Playback', ctx: 'edit', cmd: 'Step forward one second', keys: ['Shift+Right'] },
  { id: 'play.start', area: 'Playback', ctx: 'edit', cmd: 'Go to sequence start', keys: ['Home'] },
  { id: 'play.end', area: 'Playback', ctx: 'edit', cmd: 'Go to sequence end', keys: ['End'] },
  { id: 'play.prevEdit', area: 'Playback', ctx: 'edit', cmd: 'Go to previous edit point', keys: ['Up'] },
  { id: 'play.nextEdit', area: 'Playback', ctx: 'edit', cmd: 'Go to next edit point', keys: ['Down'] },

  { id: 'tl.split', area: 'Timeline', ctx: 'edit', cmd: 'Add edit: slice clips at the playhead', keys: ['Ctrl+K'] },
  { id: 'tl.enable', area: 'Timeline', ctx: 'edit', cmd: 'Enable / disable clip', keys: ['Shift+E'] },
  { id: 'tl.delete', area: 'Timeline', ctx: 'edit', cmd: 'Clear (delete)', keys: ['Delete', 'Backspace'] },
  { id: 'tl.rippleDelete', area: 'Timeline', ctx: 'edit', cmd: 'Ripple delete', keys: ['Shift+Delete', 'Shift+Backspace'] },
  { id: 'tl.trimPrev', area: 'Timeline', ctx: 'edit', cmd: 'Ripple trim previous edit to playhead (delete left)', keys: ['Q'] },
  { id: 'tl.trimNext', area: 'Timeline', ctx: 'edit', cmd: 'Ripple trim next edit to playhead (delete right)', keys: ['W'] },
  { id: 'tl.speed', area: 'Timeline', ctx: 'edit', cmd: 'Speed / Duration…', keys: ['Ctrl+R'] },
  { id: 'tl.text', area: 'Timeline', ctx: 'edit', cmd: 'Add text', keys: ['T'] },
  { id: 'tl.marker', area: 'Timeline', ctx: 'edit', cmd: 'Add marker', keys: ['M'] },
  { id: 'tl.in', area: 'Timeline', ctx: 'edit', cmd: 'Mark in', keys: ['I'] },
  { id: 'tl.out', area: 'Timeline', ctx: 'edit', cmd: 'Mark out', keys: ['O'] },
  { id: 'tl.clearInOut', area: 'Timeline', ctx: 'edit', cmd: 'Clear in and out', keys: ['Alt+X'] },
  { id: 'tl.snap', area: 'Timeline', ctx: 'edit', cmd: 'Snap on / off', keys: ['S'] },
  { id: 'tl.zoomIn', area: 'Timeline', ctx: 'edit', cmd: 'Zoom in', keys: ['=', 'Shift+='] },
  { id: 'tl.zoomOut', area: 'Timeline', ctx: 'edit', cmd: 'Zoom out', keys: ['-', 'Shift+-'] },
  { id: 'tl.zoomFit', area: 'Timeline', ctx: 'edit', cmd: 'Zoom to sequence', keys: ['\\'] },
  { id: 'tl.deselect', area: 'Timeline', ctx: 'edit', cmd: 'Deselect all / keyframes', keys: ['Esc'] },

  { id: 'ed.copy', area: 'Editing', ctx: 'edit', cmd: 'Copy', keys: ['Ctrl+C'] },
  { id: 'ed.cut', area: 'Editing', ctx: 'edit', cmd: 'Cut to clipboard', keys: ['Ctrl+X'] },
  { id: 'ed.paste', area: 'Editing', ctx: 'edit', cmd: 'Paste', keys: ['Ctrl+V'] },
  { id: 'ed.selectAll', area: 'Editing', ctx: 'edit', cmd: 'Select all', keys: ['Ctrl+A'] },
  { id: 'ed.dupSeq', area: 'Editing', ctx: 'edit', cmd: 'Duplicate sequence', keys: ['Ctrl+Shift+D'] },
  { id: 'ed.ease', area: 'Editing', ctx: 'edit', cmd: 'Easy ease (keyframes)', keys: ['F9'] },
  { id: 'ed.easeIn', area: 'Editing', ctx: 'edit', cmd: 'Easy ease in', keys: ['Shift+F9'] },
  { id: 'ed.easeOut', area: 'Editing', ctx: 'edit', cmd: 'Easy ease out', keys: ['Alt+F9'] },

  { id: 'graph.fit', area: 'Graph editor', ctx: 'graph', cmd: 'Fit the curves in view', keys: ['F'] },
  { id: 'graph.delete', area: 'Graph editor', ctx: 'graph', cmd: 'Delete selected keyframes', keys: ['Delete', 'Backspace'] },
  { id: 'graph.selectAll', area: 'Graph editor', ctx: 'graph', cmd: 'Select all keyframes', keys: ['Ctrl+A'] },
  { id: 'graph.ease', area: 'Graph editor', ctx: 'graph', cmd: 'Easy ease', keys: ['F9'] },
  { id: 'graph.easeIn', area: 'Graph editor', ctx: 'graph', cmd: 'Easy ease in', keys: ['Shift+F9'] },
  { id: 'graph.easeOut', area: 'Graph editor', ctx: 'graph', cmd: 'Easy ease out', keys: ['Alt+F9'] },
  { id: 'graph.close', area: 'Graph editor', ctx: 'graph', cmd: 'Close / deselect', keys: ['Esc'] },

  { id: 'bin.rename', area: 'Project bin', ctx: 'bin', cmd: 'Rename', keys: ['F2'] },
  { id: 'bin.open', area: 'Project bin', ctx: 'bin', cmd: 'Open sequence', keys: ['Enter'] },
  { id: 'bin.delete', area: 'Project bin', ctx: 'bin', cmd: 'Delete selected', keys: ['Delete', 'Backspace'] },
  { id: 'bin.selectAll', area: 'Project bin', ctx: 'bin', cmd: 'Select all', keys: ['Ctrl+A'] },

  { id: 'rv.play', area: 'Review', ctx: 'review', cmd: 'Play / Pause', keys: ['Space'] },
  { id: 'rv.pause', area: 'Review', ctx: 'review', cmd: 'Pause', keys: ['K'] },
  { id: 'rv.faster', area: 'Review', ctx: 'review', cmd: 'Play faster', keys: ['L'] },
  { id: 'rv.back', area: 'Review', ctx: 'review', cmd: 'Back one second', keys: ['J'] },
  { id: 'rv.prevFrame', area: 'Review', ctx: 'review', cmd: 'Step back one frame', keys: ['Left'] },
  { id: 'rv.nextFrame', area: 'Review', ctx: 'review', cmd: 'Step forward one frame', keys: ['Right'] },
  { id: 'rv.prevSecond', area: 'Review', ctx: 'review', cmd: 'Step back one second', keys: ['Shift+Left'] },
  { id: 'rv.nextSecond', area: 'Review', ctx: 'review', cmd: 'Step forward one second', keys: ['Shift+Right'] },
  { id: 'rv.comment', area: 'Review', ctx: 'review', cmd: 'Write a comment', keys: ['C'] },
  { id: 'rv.prevComment', area: 'Review', ctx: 'review', cmd: 'Previous comment', keys: ['['] },
  { id: 'rv.nextComment', area: 'Review', ctx: 'review', cmd: 'Next comment', keys: [']'] },
  { id: 'rv.loop', area: 'Review', ctx: 'review', cmd: 'Loop on / off', keys: ['O'] },

  { id: 'mo.play', area: 'Motion', ctx: 'motion', cmd: 'Play / Pause', keys: ['Space'] },
  { id: 'mo.prevFrame', area: 'Motion', ctx: 'motion', cmd: 'Step back one frame', keys: ['Left'] },
  { id: 'mo.nextFrame', area: 'Motion', ctx: 'motion', cmd: 'Step forward one frame', keys: ['Right'] },
  { id: 'mo.prevSecond', area: 'Motion', ctx: 'motion', cmd: 'Step back one second', keys: ['Shift+Left'] },
  { id: 'mo.nextSecond', area: 'Motion', ctx: 'motion', cmd: 'Step forward one second', keys: ['Shift+Right'] },
  { id: 'mo.start', area: 'Motion', ctx: 'motion', cmd: 'Go to start', keys: ['Home'] },
  { id: 'mo.end', area: 'Motion', ctx: 'motion', cmd: 'Go to end', keys: ['End'] },
  { id: 'mo.delete', area: 'Motion', ctx: 'motion', cmd: 'Delete selected keyframe or layer', keys: ['Delete', 'Backspace'] },
  { id: 'mo.deselect', area: 'Motion', ctx: 'motion', cmd: 'Deselect', keys: ['Esc'] },
];
export const CONTEXTS = { app: 'Application', edit: 'Edit tab', graph: 'Graph editor', bin: 'Project bin', review: 'Review', motion: 'Motion' };
const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
export const commandById = (id) => BY_ID.get(id);
export const DEFAULT_PRESET = 'Default';

// ------------------------------------------------------------------ key presses → combos

// The key itself, by its place on the keyboard for letters, digits and punctuation (Shift+= is still "=", Alt+X still "X" on a Mac).
const CODE_KEYS = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter' };
const NAMED = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', ' ': 'Space', Spacebar: 'Space', Delete: 'Delete', Backspace: 'Backspace', Enter: 'Enter', Home: 'Home', End: 'End', Tab: 'Tab', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };
const MODIFIER = /^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock|Fn)$/;
export function keyOf(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  if (c === 'Space') return 'Space';
  if (/^F\d{1,2}$/.test(e.key || '')) return e.key;
  if (NAMED[e.key]) return NAMED[e.key];
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return null;
}
// "Ctrl+Shift+K" for a key press, or null for a modifier on its own
export function comboOf(e) {
  if (MODIFIER.test(e.key || '')) return null;
  const k = keyOf(e);
  if (!k) return null;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', k].filter(Boolean).join('+');
}
// any spelling ("shift+ctrl+k") → the canonical "Ctrl+Shift+K"
export function normalize(combo) {
  const parts = String(combo).split('+');
  let key = parts.pop();
  if (key === '' && parts.length && parts[parts.length - 1] === '') { parts.pop(); key = '+'; }
  const has = (m) => parts.some((p) => p.toLowerCase() === m);
  key = key.length === 1 ? key.toUpperCase() : key;
  return [(has('ctrl') || has('cmd') || has('meta')) && 'Ctrl', has('shift') && 'Shift', (has('alt') || has('option')) && 'Alt', key].filter(Boolean).join('+');
}

// ------------------------------------------------------------------ the active layout

// { preset: name, presets: { name: { commandId: [combos] } } }; "Default" is the built-in layout and never stored
export const keymap = createStore({ preset: DEFAULT_PRESET, presets: {} });

// the keys a command has in a layout (overrides: a preset's changes; none = the defaults)
export function keysIn(overrides, id) {
  return overrides && Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : BY_ID.get(id)?.keys || [];
}
export function activeOverrides(s = keymap.get()) {
  return s.preset === DEFAULT_PRESET ? null : s.presets[s.preset] || null;
}
export const keysFor = (id) => keysIn(activeOverrides(), id);

let table = null; // `${ctx}|${combo}` -> command id, for the active layout
keymap.subscribe(() => { table = null; });
function lookup() {
  if (table) return table;
  table = new Map();
  const o = activeOverrides();
  for (const c of COMMANDS) for (const k of keysIn(o, c.id)) if (!table.has(`${c.ctx}|${k}`)) table.set(`${c.ctx}|${k}`, c.id);
  return table;
}

// The command a key press runs in this place (or an application-wide one), or null.
export function commandOf(e, ctx) {
  const combo = comboOf(e);
  if (!combo) return null;
  const t = lookup();
  return (ctx && t.get(`${ctx}|${combo}`)) || t.get(`app|${combo}`) || null;
}

// What a combo would collide with in a layout: commands in the same place, or anywhere if either side is application-wide.
export function conflictsIn(overrides, id, combo) {
  const me = BY_ID.get(id);
  return COMMANDS.filter((c) => c.id !== id && (c.ctx === me.ctx || c.ctx === 'app' || me.ctx === 'app') && keysIn(overrides, c.id).includes(combo));
}

// Layout version. 2: "Cut" (to the clipboard) was easily taken for slicing a clip; a single key with no Ctrl or Alt on it
// (W in one such layout) was meant to slice, so it moves to "Add edit" and Cut gets its Ctrl+X back. Done once per
// saved layout: one saved at this version keeps whatever it holds, including a single key on Cut chosen afterwards.
export const KEYMAP_VERSION = 2;
export function migrate(km) {
  if (!km || typeof km !== 'object' || (km.v || 1) >= KEYMAP_VERSION) return km;
  const presets = {};
  for (const [name, o] of Object.entries(km.presets || {})) {
    const cut = o && Array.isArray(o['ed.cut']) ? o['ed.cut'] : null;
    const single = (cut || []).filter((k) => !normalize(k).split('+').slice(0, -1).some((m) => m === 'Ctrl' || m === 'Alt'));
    if (!single.length) { presets[name] = o; continue; }
    const out = { ...o };
    const rest = cut.filter((k) => !single.includes(k));
    if (rest.length) out['ed.cut'] = rest; else delete out['ed.cut'];
    out['tl.split'] = [...new Set([...keysIn(o, 'tl.split'), ...single.map(normalize)])];
    presets[name] = out;
  }
  return { ...km, presets, v: KEYMAP_VERSION };
}

// the presets as saved: only real overrides, valid combos, known commands
function clean(km) {
  const presets = {};
  for (const [name, o] of Object.entries(km?.presets || {})) {
    if (!name || name === DEFAULT_PRESET || typeof o !== 'object' || !o) continue;
    const out = {};
    for (const [id, keys] of Object.entries(o)) {
      if (!BY_ID.has(id) || !Array.isArray(keys)) continue;
      const k = [...new Set(keys.map(normalize))];
      if (k.join('\n') !== BY_ID.get(id).keys.join('\n')) out[id] = k;
    }
    presets[name] = out;
  }
  const preset = km?.preset && (km.preset === DEFAULT_PRESET || presets[km.preset]) ? km.preset : DEFAULT_PRESET;
  return { preset, presets, v: KEYMAP_VERSION };
}

export async function saveKeymap(next) {
  const km = clean({ ...next, v: KEYMAP_VERSION });
  keymap.set(km);
  app.set((s) => ({ ...s, server: s.server ? { ...s.server, keymap: km } : s.server }));
  await post('/api/settings', { keymap: km });
}

// the layout saved on the server, once the app knows it (and again whenever it changes)
let seen = null;
const sync = (s) => {
  if (!s.server || s.server.keymap === seen) return;
  seen = s.server.keymap;
  const km = clean(migrate(seen));
  keymap.set(km);
  // an older layout: save what it became, so the change happens once
  if (seen && (seen.v || 1) < KEYMAP_VERSION && Object.keys(seen.presets || {}).length) post('/api/settings', { keymap: km }).catch(() => {});
};
app.subscribe(sync);
sync(app.get());

// the first key of a command, as shown in titles and menus ("⌘K" style on a Mac)
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export function showCombo(combo) {
  return combo.replace(/\bCtrl\b/g, IS_MAC ? '⌘' : 'Ctrl').replace(/\bAlt\b/g, IS_MAC ? '⌥' : 'Alt')
    .replace(/Left$/, '←').replace(/Right$/, '→').replace(/Up$/, '↑').replace(/Down$/, '↓');
}
export const shortcutLabel = (id) => (keysFor(id)[0] ? showCombo(keysFor(id)[0]) : '');
