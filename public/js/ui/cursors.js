// Timeline tool cursors (Premiere-style: the tool's own shape over the tracks while it is active).
// Each one is drawn for a cursor, not taken from the toolbar icons: the same 32-unit grid as the system arrow,
// a white body with a dark outline and a soft shadow, so they are all one size and read on any background.
// Shapes are drawn three times: the shadow, the outline of every shape, then every shape's fill, so overlapping
// shapes join into one outline. Each cursor is offered at 1x and 2x (image-set), so it stays sharp on scaled screens.
const INK = '#111318';
const dark = (d, w = 1.4) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

// id -> [hotspot x, hotspot y, shapes, details drawn on top, fallback]
const GLYPHS = {
  trackfwd: [6.5, 16, '<rect x="5" y="8" width="3" height="16" rx="1"/><path d="M10.5 9.5L17.5 16l-7 6.5z"/><path d="M17.5 9.5L24.5 16l-7 6.5z"/>', '', 'e-resize'],
  trackback: [25.5, 16, '<rect x="24" y="8" width="3" height="16" rx="1"/><path d="M21.5 9.5L14.5 16l7 6.5z"/><path d="M14.5 9.5L7.5 16l7 6.5z"/>', '', 'w-resize'],
  ripple: [9, 16, '<path d="M8 7h7v3.2h-3.8v11.6H15V25H8z"/><path d="M17 14.3h4.5v-3.8L28 16l-6.5 5.5v-3.8H17z"/>', '', 'ew-resize'],
  roll: [16, 16, '<path d="M15 7H9.5v3.2h2.3v11.6H9.5V25H15z"/><path d="M17 7h5.5v3.2h-2.3v11.6h2.3V25H17z"/><path d="M7.5 12v8L3 16z"/><path d="M24.5 12v8l4.5-4z"/>', '', 'col-resize'],
  ratestretch: [16, 16, '<rect x="4" y="8" width="3" height="16" rx="1"/><rect x="25" y="8" width="3" height="16" rx="1"/><path d="M9 16l5.5-5.2v3.5h3v-3.5L23 16l-5.5 5.2v-3.5h-3v3.5z"/>', '', 'ew-resize'],
  razor: [4, 4, '<path d="M4 4l10.6 4.6-6 6z"/><path d="M15.6 9.6l-6 6 11.6 11.6c1 1 2.6 1 3.6 0l2.4-2.4c1-1 1-2.6 0-3.6z"/>',
    `${dark('M17.8 17.8l5.4 5.4', 1.2)}${dark('M5.2 5.2l5.2 5.2', 0.9)}`, 'crosshair'],
  slip: [16, 16, '<rect x="3" y="9" width="26" height="3" rx="1"/><rect x="3" y="20" width="26" height="3" rx="1"/><rect x="3" y="9" width="3" height="14" rx="1"/><rect x="26" y="9" width="3" height="14" rx="1"/><path d="M8.5 16l3.5-3v2h8v-2l3.5 3-3.5 3v-2h-8v2z"/>', '', 'ew-resize'],
  slide: [16, 16, '<rect x="3" y="9" width="3" height="14" rx="1"/><rect x="26" y="9" width="3" height="14" rx="1"/><rect x="11" y="10" width="10" height="12" rx="1.5"/><path d="M7.5 16l2.5-3.5v7z"/><path d="M24.5 16L22 12.5v7z"/>', '', 'move'],
  pen: [4, 4, '<path d="M4 4l12.5 3.5 6 6-9 9-6-6z"/><path d="M23.5 14.5l-9 9 3 3 9-9z"/>',
    `${dark('M4.8 4.8l6.2 6.2', 1.1)}<circle cx="12.4" cy="12.4" r="1.7" fill="${INK}"/>`, 'crosshair'],
  hand: [16, 14, '<rect x="9.2" y="6" width="3.6" height="12" rx="1.8"/><rect x="12.8" y="4.5" width="3.6" height="13.5" rx="1.8"/><rect x="16.4" y="6" width="3.6" height="12" rx="1.8"/><rect x="20" y="8.5" width="3.4" height="11" rx="1.7"/>'
    + '<path d="M9.2 15h14.2v5.5c0 4.4-3 7.5-7.2 7.5H15c-2.6 0-4.4-1.2-5.8-3.2L5 19.6c-.9-1.2-.6-2.7.5-3.4 1-.6 2.2-.4 3 .5l.7.8z"/>',
    `${dark('M12.8 9.5V16', 1)}${dark('M16.4 9.5V16', 1)}${dark('M20 10.5V16', 1)}`, 'grab'],
  zoom: [13, 13, '<circle cx="13" cy="13" r="9"/><path d="M19.6 17.4l7.6 7.6a2 2 0 0 1-2.8 2.8l-7.6-7.6z"/>',
    `<circle cx="13" cy="13" r="6.4" fill="none" stroke="${INK}" stroke-opacity=".22"/>${dark('M13 9.6v6.8M9.6 13h6.8', 1.8)}`, 'zoom-in'],
  zoomOut: [13, 13, '<circle cx="13" cy="13" r="9"/><path d="M19.6 17.4l7.6 7.6a2 2 0 0 1-2.8 2.8l-7.6-7.6z"/>',
    `<circle cx="13" cy="13" r="6.4" fill="none" stroke="${INK}" stroke-opacity=".22"/>${dark('M9.6 13h6.8', 1.8)}`, 'zoom-out'],
};

function svg(shapes, details, scale) {
  const px = 32 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32" stroke-linejoin="round">`
    + `<g transform="translate(.5 1.1)" opacity=".32" fill="#000" stroke="#000" stroke-width="2.8">${shapes}</g>`
    + `<g fill="none" stroke="${INK}" stroke-width="2.4">${shapes}</g>`
    + `<g fill="#fff" stroke="none">${shapes}</g>${details}</svg>`;
}
const url = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;

const cache = {};
// The CSS cursor value for a tool, or null for tools that keep the normal pointer (Selection).
export function toolCursor(tool) {
  const g = GLYPHS[tool];
  if (!g) return null;
  if (!cache[tool]) {
    const [x, y, shapes, details, fallback] = g;
    // the hotspot is given in 1x (CSS) pixels; the browser scales it for the 2x image
    cache[tool] = `image-set(${url(svg(shapes, details, 1))} 1x, ${url(svg(shapes, details, 2))} 2x) ${x} ${y}, ${url(svg(shapes, details, 1))} ${x} ${y}, ${fallback}`;
  }
  return cache[tool];
}
// for tests: the drawing of a tool's cursor at a scale, and its hotspot
export const cursorSvg = (tool, scale = 1) => (GLYPHS[tool] ? svg(GLYPHS[tool][2], GLYPHS[tool][3], scale) : null);
export const cursorHotspot = (tool) => (GLYPHS[tool] ? [GLYPHS[tool][0], GLYPHS[tool][1]] : null);
