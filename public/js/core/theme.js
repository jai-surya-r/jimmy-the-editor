// App colour themes. Each theme is a [data-theme] block in app.css overriding the :root tokens.
import { loadPref, savePref } from './store.js';

export const THEMES = [
  { id: 'dark', label: 'Dark', swatch: ['#000000', '#1e1e1e', '#ffffff'] },
  { id: 'light', label: 'Light', swatch: ['#ececec', '#ffffff', '#000000'] },
];

const listeners = new Set();
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const currentTheme = () => document.documentElement.dataset.theme || 'dark';

// save: false only shows it (Settings previews a theme until Save)
export function applyTheme(id, { save = true } = {}) {
  if (!THEMES.some((t) => t.id === id)) id = 'dark';
  document.documentElement.dataset.theme = id;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  if (save) savePref('theme', id);
  for (const fn of listeners) fn(id);
}
export const savedTheme = () => loadPref('theme', 'dark');

export const initTheme = () => applyTheme(savedTheme());
