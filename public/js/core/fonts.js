// Font loading shared by the editor and the render worker, so text renders identically in both.

// Curated Google Fonts with the weights each family actually ships.
const ALL = '100;200;300;400;500;600;700;800;900';
export const GOOGLE_FONTS = {
  'Inter': ALL, 'Montserrat': ALL, 'Poppins': ALL, 'Raleway': ALL, 'Outfit': ALL, 'Kanit': ALL, 'Barlow': ALL,
  'Barlow Condensed': ALL, 'DM Sans': ALL, 'Roboto': '100;300;400;500;700;900', 'Lato': '100;300;400;700;900',
  'Open Sans': '300;400;500;600;700;800', 'Oswald': '200;300;400;500;600;700', 'Plus Jakarta Sans': '200;300;400;500;600;700;800',
  'Manrope': '200;300;400;500;600;700;800', 'Space Grotesk': '300;400;500;600;700', 'Playfair Display': '400;500;600;700;800;900',
  'Fredoka': '300;400;500;600;700', 'Teko': '300;400;500;600;700', 'Caveat': '400;500;600;700',
  'Bebas Neue': '400', 'Anton': '400', 'Archivo Black': '400', 'Bangers': '400', 'Permanent Marker': '400',
  'Lobster': '400', 'Righteous': '400', 'Luckiest Guy': '400', 'Russo One': '400', 'Black Ops One': '400',
};
export const SYSTEM_FONTS = [
  'Arial', 'Arial Black', 'Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Impact', 'Tahoma', 'Trebuchet MS',
  'Verdana', 'Times New Roman', 'Courier New', 'Consolas', 'Comic Sans MS',
];

const cssLinks = new Map(); // href -> Promise
function addStylesheet(href) {
  if (typeof document === 'undefined') return Promise.resolve();
  if (cssLinks.has(href)) return cssLinks.get(href);
  const p = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => resolve(); // offline: fall back to system fonts
    document.head.appendChild(link);
  });
  cssLinks.set(href, p);
  return p;
}

export function ensureFontCss(family) {
  const weights = GOOGLE_FONTS[family];
  // Anything else may be an installed font (incl. Adobe Fonts) or a project font file.
  if (!weights) return Promise.all([addStylesheet('/api/sysfonts.css'), ...[...projectFontIds].map((id) => addStylesheet(`/api/p/${id}/fonts.css`))]);
  return addStylesheet(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weights}&display=block`);
}

const projectFontIds = new Set();
export function ensureProjectFonts(projectId) {
  projectFontIds.add(projectId);
  return addStylesheet(`/api/p/${projectId}/fonts.css`);
}

// Editor: load a project's font files, then re-measure any text that was laid out with a fallback.
export async function useProjectFontsIn(projectId) {
  if (projectFontIds.has(projectId)) return;
  await ensureProjectFonts(projectId);
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
  ready.clear();
  for (const fn of listeners) fn();
}

export function quoteFamily(f) {
  return `"${String(f || 'Inter').replace(/"/g, '')}"`;
}
export function fontString(style, px) {
  return `${style.italic ? 'italic ' : ''}${style.weight || 400} ${px}px ${quoteFamily(style.font)}, sans-serif`;
}

const ready = new Set();
const loading = new Map();
const listeners = new Set();
export function onFontsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Web fonts come in pieces (Latin, Latin Extended with ₹, Devanagari, …) that load the first time a glyph
// from them is drawn: text drawn before that used a fallback font, so it is laid out again when a piece arrives.
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => { for (const fn of listeners) fn(); });

const fontKey = (style) => `${style.italic ? 'i' : 'n'}|${style.weight}|${style.font}`;
export function isFontReady(style) {
  return ready.has(fontKey(style));
}

// Resolve once the face is usable. Never rejects; unknown fonts fall back to sans-serif.
export function prepareFont(style) {
  const key = fontKey(style);
  if (ready.has(key)) return Promise.resolve();
  if (loading.has(key)) return loading.get(key);
  const p = (async () => {
    await ensureFontCss(style.font);
    try {
      if (typeof document !== 'undefined' && document.fonts) await document.fonts.load(fontString(style, 48), 'AaBb');
    } catch { /* ignore */ }
    ready.add(key);
    loading.delete(key);
    for (const fn of listeners) fn();
  })();
  loading.set(key, p);
  return p;
}

// Export: every font piece the sequence's text needs, loaded before the first frame is drawn (text bitmaps
// are cached for the whole job, so a piece arriving later would leave that text in the fallback font).
export async function prepareFontsForSequence(seq) {
  const texts = seq.clips.filter((c) => c.type === 'text');
  await Promise.all(texts.map(async (c) => {
    await prepareFont(c.style);
    const text = String(c.text || '');
    try {
      if (typeof document !== 'undefined' && document.fonts) await document.fonts.load(fontString(c.style, 48), c.style.uppercase ? text.toUpperCase() : text);
    } catch { /* unknown font: falls back to sans-serif */ }
  }));
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
}
