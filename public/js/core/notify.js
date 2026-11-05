// Toasts, dialogs and context menus (app-wide UI overlays).
import { createStore } from './store.js';

export const overlays = createStore({ toasts: [], dialog: null, menu: null });

let toastSeq = 1;
export function notify(text, kind = 'info', { action, timeout } = {}) {
  const id = toastSeq++;
  const t = { id, text, kind, action };
  overlays.set((s) => ({ ...s, toasts: [...s.toasts.slice(-4), t] }));
  const ms = timeout ?? (kind === 'error' ? 7000 : 3800);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}
export function dismissToast(id) {
  overlays.set((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}

// openDialog(Component, props) → Promise resolving with the value passed to close().
// Every open is a new dialog, even of the component already showing (the system file dialog leaves it on screen):
// the key makes it start again from its props rather than carry on with its old state.
let dialogKey = 0;
export function openDialog(Component, props = {}) {
  return new Promise((resolve) => {
    overlays.set({ dialog: { Component, props, resolve, key: ++dialogKey } });
  });
}
// Only one dialog shows at a time, so a dialog that steps aside for another one (a folder browser, a
// confirmation) and then opens itself again is a new dialog. Whoever opened the first one is still waiting:
//   const caller = dialogCaller();  …  openDialog(Self, props).then(caller);
export const dialogCaller = () => overlays.get().dialog?.resolve || (() => {});
export function closeDialog(value) {
  const d = overlays.get().dialog;
  overlays.set({ dialog: null });
  d?.resolve(value);
}

// items: [{ label, icon, shortcut, action, disabled, danger, checked } | { separator: true } | { label, items: [...] }]
export function openMenu(x, y, items) {
  overlays.set({ menu: { x, y, items } });
}
export function closeMenu() {
  if (overlays.get().menu) overlays.set({ menu: null });
}
