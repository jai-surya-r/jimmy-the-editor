// Keyboard Shortcuts window (Ctrl+Alt+K), laid out like Premiere's: layout presets, a keyboard map coloured by what each key
// does with the chosen modifiers, a searchable command list where shortcuts are edited, and the commands of the key under
// the pointer. Click a shortcut to change it, + to add one, × to remove one; drag a command onto a key of the keyboard.
// A shortcut taken from another command is moved (with a warning and Undo). Nothing is saved until OK.
// The commands and the layouts themselves live in keymap.js.
import { html, Modal, Button, Select, Icon } from './common.js';
import { useMemo, useRef, useState, useEffect } from 'preact/hooks';
import { openDialog, notify } from '../core/notify.js';
import {
  COMMANDS, CONTEXTS, DEFAULT_PRESET, keymap, keysIn, conflictsIn, saveKeymap, comboOf, showCombo, commandById,
} from './keymap.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

// "Ctrl+Shift+E" → { ctrl, shift, alt, key: 'E' }
function parse(combo) {
  const parts = combo.split('+');
  const key = parts.pop() || '+';
  return { ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'), key: key.length === 1 ? key.toUpperCase() : key };
}
const show = showCombo;

// keyboard rows: [label, width in key units, id] (id defaults to the label)
const ROWS = [
  [['Esc', 1.5], ['', 0.5, null], ...['F1', 'F2', 'F3', 'F4'].map((k) => [k, 1]), ['', 0.5, null], ...['F5', 'F6', 'F7', 'F8'].map((k) => [k, 1]), ['', 0.5, null], ...['F9', 'F10', 'F11', 'F12'].map((k) => [k, 1])],
  [['`', 1], ...'1234567890'.split('').map((k) => [k, 1]), ['-', 1], ['=', 1], ['Backspace', 2]],
  [['Tab', 1.5], ...'QWERTYUIOP'.split('').map((k) => [k, 1]), ['[', 1], [']', 1], ['\\', 1.5]],
  [['Caps', 1.75, null], ...'ASDFGHJKL'.split('').map((k) => [k, 1]), [';', 1], ["'", 1], ['Enter', 2.25]],
  [['Shift', 2.25, 'mod-shift'], ...'ZXCVBNM'.split('').map((k) => [k, 1]), [',', 1], ['.', 1], ['/', 1], ['Shift', 2.75, 'mod-shift']],
  [[MOD, 1.5, 'mod-ctrl'], [IS_MAC ? 'Ctrl' : 'Win', 1.25, null], [ALT, 1.25, 'mod-alt'], ['Space', 6.25], [ALT, 1.25, 'mod-alt'], [MOD, 1.5, 'mod-ctrl']],
];
const NAV = [
  [['Home', 1], ['End', 1], ['PgUp', 1, 'PageUp']],
  [['Delete', 1], ['Ins', 1, 'Insert'], ['PgDn', 1, 'PageDown']],
  [['', 1, null], ['Up', 1], ['', 1, null]],
  [['Left', 1], ['Down', 1], ['Right', 1]],
];
const ARROW = { Left: '←', Right: '→', Up: '↑', Down: '↓' };
const AREAS = [...new Set(COMMANDS.map((s) => s.area))];
const scopeClass = (c) => (c.ctx === 'app' ? 'is-app' : 'is-panel');

export function openShortcuts(onBack) {
  return openDialog(ShortcutsDialog, {}).then(() => onBack?.());
}

export function ShortcutsDialog({ close }) {
  const saved = keymap.get();
  // the layouts being edited: { preset, presets }; saved on OK
  const [state, setState] = useState(() => ({ preset: saved.preset, presets: JSON.parse(JSON.stringify(saved.presets)) }));
  const [history, setHistory] = useState([]);
  const [warning, setWarning] = useState(null);
  const [mods, setMods] = useState({ ctrl: false, shift: false, alt: false });
  const [ctx, setCtx] = useState('all');
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState(null);
  const [picked, setPicked] = useState(null);
  const [selected, setSelected] = useState(null); // command row selected in the list
  const [editing, setEditing] = useState(null); // { id, i } (i = index of the shortcut being replaced, or -1 to add one)
  const [naming, setNaming] = useState(null); // name typed for "Save As"
  const dragId = useRef(null);

  const overrides = state.preset === DEFAULT_PRESET ? null : state.presets[state.preset] || {};
  const keysOf = (id) => keysIn(overrides, id);
  const binds = useMemo(() => COMMANDS.flatMap((s) => keysOf(s.id).map((k) => ({ ...s, combo: k, ...parse(k) }))), [state]);
  const inCtx = (c) => ctx === 'all' || c.ctx === ctx || c.ctx === 'app';
  const onKeyNow = (id) => binds.filter((b) => inCtx(b) && b.key === id && b.ctrl === mods.ctrl && b.shift === mods.shift && b.alt === mods.alt);
  const keyInfo = hover || picked;
  const q = query.trim().toLowerCase();
  const rows = COMMANDS.filter((s) => (ctx === 'all' || s.ctx === ctx) && (!q || s.cmd.toLowerCase().includes(q) || s.area.toLowerCase().includes(q) || keysOf(s.id).some((k) => show(k).toLowerCase().includes(q))));
  const toggle = (m) => setMods({ ...mods, [m]: !mods[m] });
  const customNames = Object.keys(state.presets);
  const modified = (id) => !!overrides && Object.prototype.hasOwnProperty.call(overrides, id);

  // every change goes through here: on the built-in layout it first makes a custom copy (as Premiere does)
  const change = (fn) => {
    setHistory((h) => [...h.slice(-49), JSON.stringify(state)]);
    setState((s) => {
      const next = JSON.parse(JSON.stringify(s));
      if (next.preset === DEFAULT_PRESET) {
        let name = 'Custom', n = 2;
        while (next.presets[name]) name = `Custom ${n++}`;
        next.presets[name] = {};
        next.preset = name;
      }
      fn(next.presets[next.preset]);
      return next;
    });
  };
  const undo = () => {
    if (!history.length) return;
    setState(JSON.parse(history[history.length - 1]));
    setHistory((h) => h.slice(0, -1));
    setWarning(null);
  };

  // give a command a combo (replacing shortcut i, or added when i is -1); taken from whatever had it in the same place
  const assign = (id, i, combo) => {
    const taken = conflictsIn(overrides, id, combo);
    if (keysOf(id).includes(combo) && i === -1) { setEditing(null); return; }
    change((o) => {
      for (const c of taken) o[c.id] = keysIn(o, c.id).filter((k) => k !== combo);
      const cur = [...keysIn(o, id)];
      if (i >= 0 && i < cur.length) cur[i] = combo; else cur.push(combo);
      o[id] = [...new Set(cur)];
    });
    setEditing(null);
    setWarning(taken.length ? `${show(combo)} was used by “${taken.map((c) => c.cmd).join('”, “')}”${taken.some((c) => c.ctx !== commandById(id).ctx) ? ` (${taken.map((c) => CONTEXTS[c.ctx]).join(', ')})` : ''}. It now runs “${commandById(id).cmd}”.` : null);
  };
  const removeKey = (id, combo) => { change((o) => { o[id] = keysIn(o, id).filter((k) => k !== combo); }); setWarning(null); };
  const clearSelected = () => { if (selected) { change((o) => { o[selected] = []; }); setWarning(null); } };
  const resetSelected = () => { if (selected && modified(selected)) { change((o) => { delete o[selected]; }); setWarning(null); } };

  // typing the new shortcut: the next key press (with its modifiers) is the shortcut; clicking elsewhere cancels
  const capture = (e) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboOf(e);
    if (combo) assign(editing.id, editing.i, combo);
  };

  const pickPreset = (name) => { setState({ ...state, preset: name }); setHistory([]); setWarning(null); setEditing(null); };
  const saveAs = () => {
    const name = (naming || '').trim();
    if (!name) { setNaming(null); return; }
    if (name === DEFAULT_PRESET) { notify('“Default” is the built-in layout: choose another name', 'error'); return; }
    setHistory((h) => [...h, JSON.stringify(state)]);
    setState({ preset: name, presets: { ...state.presets, [name]: { ...(overrides || {}) } } });
    setNaming(null);
  };
  const deletePreset = () => {
    if (state.preset === DEFAULT_PRESET) return;
    const presets = { ...state.presets };
    delete presets[state.preset];
    setHistory((h) => [...h, JSON.stringify(state)]);
    setState({ preset: DEFAULT_PRESET, presets });
  };
  const ok = async () => {
    try { await saveKeymap(state); close(true); } catch (err) { notify(`Couldn't save the shortcuts: ${err.message}`, 'error'); }
  };

  const Key = ([label, w, id = label]) => {
    if (id === null) return html`<div class=${`ks-key ${label ? 'is-dead' : 'is-blank'}`} style=${{ flexGrow: w }}>${label ? html`<span class="ks-cap">${label}</span>` : null}</div>`;
    if (id.startsWith('mod-')) {
      const m = id.slice(4);
      return html`<button class=${`ks-key is-mod ${mods[m] ? 'is-on' : ''}`} style=${{ flexGrow: w }} onClick=${() => toggle(m)} title="Show the shortcuts that use this modifier">${label}</button>`;
    }
    const b = onKeyNow(id);
    const scope = b.some((x) => x.ctx === 'app') ? 'is-app' : b.length ? 'is-panel' : '';
    const combo = [mods.ctrl && 'Ctrl', mods.shift && 'Shift', mods.alt && 'Alt', id].filter(Boolean).join('+');
    return html`<button class=${`ks-key ${scope} ${picked === id ? 'is-picked' : ''}`} style=${{ flexGrow: w }}
      onMouseEnter=${() => setHover(id)} onMouseLeave=${() => setHover(null)} onClick=${() => setPicked(picked === id ? null : id)}
      onDragOver=${(e) => { if (dragId.current) { e.preventDefault(); e.currentTarget.classList.add('is-drop'); } }}
      onDragLeave=${(e) => e.currentTarget.classList.remove('is-drop')}
      onDrop=${(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-drop'); if (dragId.current) assign(dragId.current, -1, combo); dragId.current = null; }}
      title=${b.map((x) => x.cmd).join('\n')}>
      <span class="ks-cap">${ARROW[id] || label}</span>${b.length ? html`<span class="ks-cmd">${b[0].cmd}${b.length > 1 ? ` +${b.length - 1}` : ''}</span>` : null}</button>`;
  };
  const modName = [mods.ctrl && MOD, mods.shift && 'Shift', mods.alt && ALT].filter(Boolean).join('+');
  const keyList = keyInfo ? binds.filter((b) => b.key === keyInfo && inCtx(b)) : [];

  const Shortcuts = (s) => {
    const keys = keysOf(s.id);
    const chip = (k, i) => (editing?.id === s.id && editing.i === i
      ? html`<${Capture} onKey=${capture} onCancel=${() => setEditing(null)} />`
      : html`<kbd class=${`ks-chip ${scopeClass(s)}`} title="Click to change this shortcut" onClick=${(e) => { e.stopPropagation(); setSelected(s.id); setEditing({ id: s.id, i }); }}>${show(k)}<button class="ks-x" title="Remove this shortcut" onClick=${(e) => { e.stopPropagation(); removeKey(s.id, k); }}>×</button></kbd>`);
    return html`<span class="ks-keys">${keys.map(chip)}${editing?.id === s.id && editing.i === -1
      ? html`<${Capture} onKey=${capture} onCancel=${() => setEditing(null)} />`
      : html`<button class="ks-add" title="Add a shortcut" onClick=${(e) => { e.stopPropagation(); setSelected(s.id); setEditing({ id: s.id, i: -1 }); }}>+</button>`}</span>`;
  };

  return html`<${Modal} title="Keyboard Shortcuts" class="ks-modal" width=${1100} onClose=${() => close(null)}
    footer=${html`<span class="muted">${editing ? 'Press the new shortcut (with its modifiers). Click anywhere else to cancel.' : 'Drag a command onto a key to assign it. Purple: application-wide · Green: panel-specific'}</span><div class="spacer"></div>
      <${Button} onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" onClick=${ok}>OK</${Button}>`}>
    <div class="ks-top">
      <label class="ks-preset"><span class="muted">Keyboard layout preset</span>
        <${Select} class="select-sm" value=${state.preset} onChange=${pickPreset}
          options=${[{ value: DEFAULT_PRESET, label: 'Jimmy Default (Premiere Pro)' }, ...customNames.map((n) => ({ value: n, label: n }))]} /></label>
      ${naming != null
        ? html`<input class="input input-sm ks-name" data-esc="1" autoFocus placeholder="Preset name" value=${naming} onInput=${(e) => setNaming(e.target.value)}
            onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') saveAs(); if (e.key === 'Escape') setNaming(null); }} />
          <${Button} class="btn-sm" onClick=${saveAs}>Save</${Button}>`
        : html`<${Button} class="btn-sm" onClick=${() => setNaming(state.preset === DEFAULT_PRESET ? 'My shortcuts' : `${state.preset} copy`)}>Save As…</${Button}>`}
      <${Button} class="btn-sm" disabled=${state.preset === DEFAULT_PRESET} title="Delete this preset" onClick=${deletePreset}>Delete</${Button}>
      <div class="ks-mods">
        <span class="muted">Modifiers</span>
        ${['ctrl', 'shift', 'alt'].map((m) => html`<button class=${`ks-mod ${mods[m] ? 'is-on' : ''}`} onClick=${() => toggle(m)}>${{ ctrl: MOD, shift: 'Shift', alt: ALT }[m]}</button>`)}
      </div>
      <${Select} class="select-sm ks-ctx" value=${ctx} onChange=${setCtx} title="Show the shortcuts of one place"
        options=${[{ value: 'all', label: 'All panels' }, ...Object.entries(CONTEXTS).map(([value, label]) => ({ value, label }))]} />
      <div class="ks-legend"><i class="is-app"></i>Application <i class="is-panel"></i>Panel <i></i>Free</div>
    </div>
    <div class="ks-board">
      <div class="ks-main">${ROWS.map((r) => html`<div class="ks-row">${r.map(Key)}</div>`)}</div>
      <div class="ks-nav">${NAV.map((r) => html`<div class="ks-row">${r.map(Key)}</div>`)}</div>
    </div>
    <div class="ks-bottom">
      <div class="ks-list">
        <div class="ks-list-bar">
          <input class="input ks-search" placeholder="Search commands or keys" value=${query} onInput=${(e) => setQuery(e.target.value)}
            onKeyDown=${(e) => e.stopPropagation()} />
          <${Button} class="btn-sm" disabled=${!history.length} onClick=${undo} title="Undo the last change">Undo</${Button}>
          <${Button} class="btn-sm" disabled=${!selected || !keysOf(selected).length} onClick=${clearSelected} title="Remove every shortcut of the selected command">Clear</${Button}>
          <${Button} class="btn-sm" disabled=${!selected || !modified(selected)} onClick=${resetSelected} title="Give the selected command its default shortcuts back">Default</${Button}>
        </div>
        ${warning ? html`<div class="ks-warn"><${Icon} name="alert" size=${13} /><span>${warning}</span><button class="link-btn" onClick=${undo}>Undo</button></div>` : null}
        <div class="ks-table">
          <div class="ks-th"><span>Command</span><span>Shortcut</span></div>
          ${AREAS.map((a) => {
            const list = rows.filter((s) => s.area === a);
            return list.length ? html`<div class="ks-group">${a}</div>${list.map((s) => html`<div class=${`ks-tr ${selected === s.id ? 'is-sel' : ''}`} draggable="true"
              onDragStart=${(e) => { dragId.current = s.id; e.dataTransfer.effectAllowed = 'link'; e.dataTransfer.setData('text/plain', s.cmd); }}
              onDragEnd=${() => { dragId.current = null; }}
              onClick=${() => setSelected(s.id)}>
              <span>${s.cmd}${modified(s.id) ? html`<small class="ks-mark" title="Changed from the default"> ●</small>` : null}</span>${Shortcuts(s)}</div>`)}` : null;
          })}
          ${!rows.length ? html`<div class="ks-empty muted">No command matches "${query}"</div>` : null}
        </div>
      </div>
      <div class="ks-side">
        <div class="ks-side-title">${keyInfo ? html`Key: <kbd>${ARROW[keyInfo] || keyInfo}</kbd>` : 'Key'}</div>
        ${!keyInfo ? html`<div class="muted ks-hint">Point at a key to see what it does with each modifier. Click a key to keep it here.${modName ? ` Showing ${modName} shortcuts on the keyboard.` : ''}</div>`
          : keyList.length ? html`<div class="ks-table">
            <div class="ks-th"><span>Modifiers</span><span>Command</span></div>
            ${keyList.map((b) => html`<div class="ks-tr"><span><kbd class=${scopeClass(b)}>${show(b.combo)}</kbd></span><span>${b.cmd} <small class="muted">${b.area}</small></span></div>`)}
          </div>` : html`<div class="muted ks-hint">Nothing uses this key.</div>`}
      </div>
    </div>
  </${Modal}>`;
}

// the "type a shortcut" box: takes the next key press wherever the focus is; a click anywhere else cancels it
function Capture({ onKey, onCancel }) {
  const ref = useRef(null);
  const cb = useRef(null);
  cb.current = { onKey, onCancel };
  useEffect(() => {
    ref.current?.focus();
    const key = (e) => { if (e.target !== ref.current) cb.current.onKey(e); }; // focused: its own onKeyDown has it
    const down = (e) => { if (!ref.current?.contains(e.target)) cb.current.onCancel(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', down, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', down, true); };
  }, []);
  return html`<span ref=${ref} class="ks-chip is-capture" tabIndex="0" data-esc="1" onKeyDown=${onKey}>Type shortcut…</span>`;
}
