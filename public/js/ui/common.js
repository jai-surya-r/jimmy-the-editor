// Shared UI building blocks.
import { html } from 'htm/preact';
import { Component } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { ICONS } from './icons.js';
import { overlays, closeDialog, closeMenu, dismissToast } from '../core/notify.js';
import { useStore, loadPref, savePref } from '../core/store.js';

export { html };

export function Icon({ name, size = 16, class: cls = '' }) {
  return html`<svg class="icon ${cls}" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }}></svg>`;
}

export function IconButton({ icon, title, onClick, active, disabled, size = 16, class: cls = '', label, kbd }) {
  return html`<button class="icon-btn ${active ? 'is-active' : ''} ${label ? 'with-label' : ''} ${cls}" title=${kbd ? `${title} (${kbd})` : title}
    disabled=${disabled} onClick=${onClick} aria-label=${title}>
    <${Icon} name=${icon} size=${size} />${label ? html`<span>${label}</span>` : null}
  </button>`;
}

export function Button({ children, onClick, kind = 'default', icon, disabled, title, class: cls = '', type = 'button' }) {
  return html`<button type=${type} class="btn btn-${kind} ${cls}" onClick=${onClick} disabled=${disabled} title=${title}>
    ${icon ? html`<${Icon} name=${icon} size=${15} />` : null}${children}
  </button>`;
}

const fmt = (v, p) => {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(p));
  return String(r);
};

// Numeric field: drag horizontally to scrub (Shift ×10, Alt ×0.1), click to type.
// onStart → onChange(v)* → onEnd(v) brackets a gesture so it becomes one undo step.
export function NumField({ value, onStart, onChange, onEnd, step = 1, min = -Infinity, max = Infinity, precision = 2, unit = '', disabled, title, format, parse, class: cls = '' }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef(null);
  // What the typed value belongs to: the handlers and value from when typing began. Clicking another clip
  // re-renders this field for that clip before the blur arrives; the value must still go to the first one.
  const typing = useRef(null);
  const clampV = (v) => Math.min(max, Math.max(min, v));
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const onPointerDown = (e) => {
    if (disabled || e.button !== 0) return;
    // finish whatever is being typed elsewhere first (its edit must close before this one opens)
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = Number.isFinite(value) ? value : 0;
    let moved = false, last = v0;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; onStart?.(); document.body.classList.add('is-scrubbing'); }
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      last = clampV(v0 + Math.round(dx) * step * mult);
      onChange?.(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-scrubbing');
      if (moved) onEnd?.(last);
      else {
        const shown = format ? format(value) : fmt(value, precision);
        typing.current = { shown, value, onStart, onChange, onEnd };
        setText(shown);
        setEditing(true);
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const commit = () => {
    setEditing(false);
    const was = typing.current;
    typing.current = null;
    if (!was || text === was.shown) return; // cancelled with Esc, or left as it was (re-parsing the rounded text would change it)
    const v = parse ? parse(text) : parseFloat(text);
    if (v == null || !Number.isFinite(v)) return;
    const c = clampV(v);
    if (c === was.value) return;
    was.onStart?.();
    was.onChange?.(c);
    was.onEnd?.(c);
  };

  if (editing) {
    return html`<input ref=${inputRef} data-esc class="numfield is-editing ${cls}" value=${text}
      onInput=${(e) => setText(e.target.value)} onBlur=${commit}
      onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { typing.current = null; setEditing(false); } }} />`;
  }
  return html`<div class="numfield ${disabled ? 'is-disabled' : ''} ${cls}" title=${title || 'Drag to change · click to type'} onPointerDown=${onPointerDown}>
    ${format ? format(value) : fmt(value, precision)}${unit ? html`<span class="unit">${unit}</span>` : null}
  </div>`;
}

export function ColorField({ value, onStart, onChange, onEnd }) {
  const started = useRef(false);
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  return html`<div class="colorfield">
    <label class="swatch" style=${{ background: value }}>
      <input type="color" value=${/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'}
        onInput=${(e) => { if (!started.current) { started.current = true; onStart?.(); } onChange?.(e.target.value); }}
        onChange=${(e) => { started.current = false; onEnd?.(e.target.value); }} />
    </label>
    <input class="hex" value=${hex} onInput=${(e) => setHex(e.target.value)}
      onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }}
      onBlur=${() => { if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) && hex !== value) { onStart?.(); onChange?.(hex); onEnd?.(hex); } else setHex(value); }} />
  </div>`;
}

export function Select({ value, options, onChange, class: cls = '', title }) {
  return html`<select class="select ${cls}" value=${value} title=${title} onChange=${(e) => onChange(e.target.value)}>
    ${options.map((o) => (typeof o === 'string' ? html`<option value=${o}>${o}</option>` : html`<option value=${o.value} disabled=${o.disabled}>${o.label}</option>`))}
  </select>`;
}

export function Toggle({ checked, onChange, label, title }) {
  return html`<label class="toggle" title=${title}>
    <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
    <span class="track"><span class="thumb"></span></span>${label ? html`<span class="toggle-label">${label}</span>` : null}
  </label>`;
}

export function Slider({ value, min = 0, max = 1, step = 0.01, onStart, onChange, onEnd, class: cls = '' }) {
  const started = useRef(false);
  return html`<input type="range" class="slider ${cls}" min=${min} max=${max} step=${step} value=${value}
    onInput=${(e) => { if (!started.current) { started.current = true; onStart?.(); } onChange?.(parseFloat(e.target.value)); }}
    onChange=${(e) => { started.current = false; onEnd?.(parseFloat(e.target.value)); }} />`;
}

// A row of a long list drawn again only when its own data changes (<${Memo} C=${Row} …props />): the list around it
// may redraw many times a second (a graphic's render progress), and every row with it was what kept the page busy.
// Functions passed in are new on every redraw; the row gets steady ones that call the latest.
export class Memo extends Component {
  shouldComponentUpdate(next) {
    const prev = this.props;
    this.latest = next;
    if (next.C !== prev.C) return true; // another kind of row (List → Tiles)
    for (const k in next) if (typeof next[k] !== 'function' && next[k] !== prev[k]) return true;
    for (const k in prev) if (!(k in next)) return true;
    for (const k in next) if ((typeof next[k] === 'function') !== (typeof prev[k] === 'function')) return true;
    return false;
  }
  render(props) {
    this.latest = props;
    this.fns ||= {};
    const out = {};
    for (const k in props) {
      if (k === 'C') continue;
      if (typeof props[k] === 'function') out[k] = this.fns[k] ||= (...a) => this.latest[k]?.(...a);
      else out[k] = props[k];
    }
    return html`<${props.C} ...${out} />`;
  }
}

export function Segmented({ value, options, onChange, class: cls = '' }) {
  return html`<div class="segmented ${cls}">
    ${options.map((o) => html`<button class=${value === o.value ? 'is-active' : ''} title=${o.title || ''} onClick=${() => onChange(o.value)}>
      ${o.icon ? html`<${Icon} name=${o.icon} size=${14} />` : null}${o.label ? html`<span>${o.label}</span>` : null}${o.badge ? html`<i class="seg-badge">${o.badge}</i>` : null}
    </button>`)}
  </div>`;
}

// Resizable panel size persisted in localStorage.
export function usePanelSize(key, initial, min, max) {
  const [size, setSize] = useState(() => loadPref(`size.${key}`, initial));
  const start = (e, sign = 1, axis = 'x') => {
    e.preventDefault();
    const p0 = axis === 'x' ? e.clientX : e.clientY;
    const s0 = size;
    document.body.classList.add(axis === 'x' ? 'is-resizing-x' : 'is-resizing-y');
    const move = (ev) => {
      const d = ((axis === 'x' ? ev.clientX : ev.clientY) - p0) * sign;
      setSize(Math.round(Math.min(max, Math.max(min, s0 + d))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing-x', 'is-resizing-y');
      setSize((s) => { savePref(`size.${key}`, s); return s; });
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [size, start];
}

export function Resizer({ onPointerDown, axis = 'x' }) {
  return html`<div class="resizer resizer-${axis}" onPointerDown=${onPointerDown}><div class="resizer-line"></div></div>`;
}

// ------------------------------------------------------------------ overlays

export function Modal({ title, children, footer, onClose, width = 480, class: cls = '' }) {
  useEffect(() => {
    // a field that handles Esc itself (data-esc: naming a new folder, a number being typed) cancels only that
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('[data-esc]')) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return html`<div class="modal-backdrop" onPointerDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal ${cls}" style=${{ width: `${width}px` }} role="dialog">
      <header class="modal-head"><h2>${title}</h2><${IconButton} icon="x" title="Close" onClick=${onClose} /></header>
      <div class="modal-body">${children}</div>
      ${footer ? html`<footer class="modal-foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

export function DialogHost() {
  const dialog = useStore(overlays, (s) => s.dialog);
  if (!dialog) return null;
  const { Component, props, key } = dialog;
  return html`<${Component} key=${key} ...${props} close=${closeDialog} />`;
}

function MenuList({ items, x, y, onDone, sub }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState(null); // { i, rect } of the item whose submenu is showing
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    let nx = x, ny = y;
    if (nx + r.width > window.innerWidth - 6) nx = sub ? x - r.width - (sub.w || 0) : window.innerWidth - r.width - 6;
    if (ny + r.height > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - r.height - 6);
    setPos({ x: nx, y: ny });
  }, [x, y]);
  return html`<div class="menu" ref=${ref} style=${{ left: `${pos.x}px`, top: `${pos.y}px` }} onPointerDown=${(e) => e.stopPropagation()}>
    ${items.filter(Boolean).map((it, i) => {
      if (it.separator) return html`<div class="menu-sep"></div>`;
      if (it.heading) return html`<div class="menu-heading">${it.heading}</div>`;
      const hasSub = !!it.items;
      const isOpen = open && open.i === i;
      return html`<div class="menu-item ${it.disabled ? 'is-disabled' : ''} ${it.danger ? 'is-danger' : ''} ${isOpen ? 'is-open' : ''}"
        onPointerEnter=${(e) => setOpen(hasSub ? { i, rect: e.currentTarget.getBoundingClientRect() } : null)}
        onClick=${() => { if (it.disabled || hasSub) return; onDone(); it.action?.(); }}>
        <span class="menu-check">${it.checked ? html`<${Icon} name="check" size=${13} />` : it.icon ? html`<${Icon} name=${it.icon} size=${14} />` : null}</span>
        <span class="menu-label">${it.label}</span>
        ${it.shortcut ? html`<span class="menu-kbd">${it.shortcut}</span>` : null}
        ${hasSub ? html`<${Icon} name="next" size=${13} />` : null}
        ${hasSub && isOpen ? html`<${MenuList} items=${it.items} x=${open.rect.right - 2} y=${open.rect.top - 5} onDone=${onDone} sub=${{ w: open.rect.width }} />` : null}
      </div>`;
    })}
  </div>`;
}

export function MenuHost() {
  const menu = useStore(overlays, (s) => s.menu);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => closeMenu();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
    };
  }, [menu]);
  if (!menu) return null;
  return html`<${MenuList} items=${menu.items} x=${menu.x} y=${menu.y} onDone=${closeMenu} />`;
}

export function Toasts() {
  const toasts = useStore(overlays, (s) => s.toasts);
  return html`<div class="toasts">
    ${toasts.map((t) => html`<div class="toast toast-${t.kind}" key=${t.id}>
      ${t.kind === 'claude' ? html`<${Icon} name="sparkle" size=${15} />` : t.kind === 'error' ? html`<${Icon} name="alert" size=${15} />` : t.kind === 'success' ? html`<${Icon} name="checkCircle" size=${15} />` : null}
      <span>${t.text}</span>
      ${t.action ? html`<button class="toast-action" onClick=${() => { dismissToast(t.id); t.action.run(); }}>${t.action.label}</button>` : null}
      <button class="toast-x" onClick=${() => dismissToast(t.id)} aria-label="Dismiss"><${Icon} name="x" size=${13} /></button>
    </div>`)}
  </div>`;
}

export function Empty({ icon, title, children }) {
  return html`<div class="empty">
    ${icon ? html`<div class="empty-icon"><${Icon} name=${icon} size=${26} /></div>` : null}
    <div class="empty-title">${title}</div>
    ${children ? html`<div class="empty-body">${children}</div>` : null}
  </div>`;
}

export function timeAgo(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}
