// Rulers and guides drawn around/over a frame (Program viewer and Review player).
// Drag from a ruler to add a guide, drag a guide to move it, drag it back onto a ruler (or off the
// frame) to delete it. Guides are stored per sequence in the tab's UI state, so the same guides show
// in Edit and in Review.
import { html, IconButton } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { openMenu } from '../core/notify.js';

// Short-form platform overlays, as fractions of a 9:16 frame (1080×1920 px in brackets).
// The organic ones trace the app UI that actually sits on top of a normal (non-ad) post on a phone:
//  Instagram Reels — header/camera ~8% (~155), username + caption + audio row ~16% (~310) at the
//    bottom, like/comment/share/remix rail ~13% (~140) wide on the right, from mid-frame down.
//  YouTube Shorts — search/menu ~7% (~135), channel + subscribe + title ~15% (~290) at the bottom,
//    like/dislike/comment/share/remix rail ~12% (~130) wide on the right.
// "Ads" is Meta's published spec for Reels ads (CTA button + sponsored label take more room):
//  top 14%, bottom 35%, 6% each side; rail over the right 21% of the bottom 40%.
export const PLATFORMS = {
  instagram: {
    label: 'Instagram Reels', color: '#ff4fa3',
    safe: { top: 0.08, bottom: 0.16, left: 0.04, right: 0.13 },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.08, label: 'Reels · camera' },
      { x: 0, y: 0.84, w: 0.87, h: 0.16, label: 'Username · caption · audio' },
      { x: 0.87, y: 0.52, w: 0.13, h: 0.42, label: 'Rail' },
    ],
  },
  youtube: {
    label: 'YouTube Shorts', color: '#ff3b30',
    safe: { top: 0.07, bottom: 0.15, left: 0.04, right: 0.12 },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.07, label: 'Search · menu' },
      { x: 0, y: 0.85, w: 0.88, h: 0.15, label: 'Channel · subscribe · title' },
      { x: 0.88, y: 0.45, w: 0.12, h: 0.48, label: 'Rail' },
    ],
  },
  instagramAds: {
    label: 'Instagram Reels ads (Meta spec)', color: '#c77dff',
    safe: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 },
    zones: [
      { x: 0, y: 0, w: 1, h: 0.14, label: 'Username · sponsored' },
      { x: 0, y: 0.65, w: 0.79, h: 0.35, label: 'Caption · CTA button' },
      { x: 0.79, y: 0.6, w: 0.21, h: 0.4, label: 'Rail' },
    ],
  },
};

function PlatformOverlay({ id, width, height, sw, sh }) {
  const P = PLATFORMS[id];
  if (!P) return null;
  const s = P.safe;
  const vertical = Math.abs(sw / sh - 9 / 16) < 0.02;
  const fs = Math.max(9, Math.min(13, width / 32));
  return html`<svg class="platform-layer" width=${width} height=${height} viewBox="0 0 ${width} ${height}">
    ${P.zones.map((z) => html`<g>
      <rect x=${z.x * width} y=${z.y * height} width=${z.w * width} height=${z.h * height} fill=${P.color} fill-opacity="0.16" stroke=${P.color} stroke-opacity="0.5" stroke-dasharray="4 3" />
      <text x=${(z.x + z.w / 2) * width} y=${(z.y + z.h / 2) * height} font-size=${fs} text-anchor="middle" dominant-baseline="middle">${z.label}</text>
    </g>`)}
    <rect x=${s.left * width} y=${s.top * height} width=${(1 - s.left - s.right) * width} height=${(1 - s.top - s.bottom) * height} fill="none" stroke=${P.color} stroke-width="2" />
    <text x=${s.left * width + 6} y=${s.top * height + fs + 4} font-size=${fs} class="platform-name">${P.label} safe area${vertical ? '' : ' · made for 9:16 frames'}</text>
  </svg>`;
}

const R = 16; // ruler thickness (css px)

export function GuideButtons({ tab }) {
  const rulers = useStore(tab.ui, (s) => s.rulers);
  const showGuides = useStore(tab.ui, (s) => s.showGuides);
  const platform = useStore(tab.ui, (s) => s.platformSafe);
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, [
      { label: 'Off', checked: !platform, action: () => tab.ui.set({ platformSafe: null }) },
      ...Object.entries(PLATFORMS).map(([k, p]) => ({ label: p.label, checked: platform === k, action: () => tab.ui.set({ platformSafe: k }) })),
    ]);
  };
  return html`<${IconButton} icon="phone" title=${platform ? `${PLATFORMS[platform].label} safe zones (click to change / turn off)` : 'Short-form safe zones: Instagram Reels / YouTube Shorts'} active=${!!platform} onClick=${pick} />
    <${IconButton} icon="ruler" title="Rulers — drag from a ruler to add a guide, right-click a ruler to clear" active=${rulers} onClick=${() => tab.ui.set({ rulers: !rulers })} />
    <${IconButton} icon="guides" title="Show guides" active=${showGuides} onClick=${() => tab.ui.set({ showGuides: !showGuides })} />`;
}

function niceStep(z) {
  for (const s of [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]) if (s * z >= 48) return s;
  return 5000;
}

function drawRuler(cv, horizontal, len, size, z) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round((horizontal ? len : R) * dpr);
  cv.height = Math.round((horizontal ? R : len) * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#15171d';
  ctx.fillRect(0, 0, horizontal ? len : R, horizontal ? R : len);
  ctx.strokeStyle = '#5b6170';
  ctx.fillStyle = '#9aa1b2';
  ctx.font = '9px ui-monospace, Consolas, monospace';
  ctx.lineWidth = 1;
  const step = niceStep(z);
  const minor = step / 5;
  ctx.beginPath();
  for (let i = 0; i * minor <= size + 0.01; i++) {
    const v = i * minor;
    const p = Math.round(v * z) + 0.5;
    const major = i % 5 === 0;
    const tl = major ? R : R * 0.3;
    if (horizontal) { ctx.moveTo(p, R); ctx.lineTo(p, R - tl); } else { ctx.moveTo(R, p); ctx.lineTo(R - tl, p); }
    if (major) {
      if (horizontal) ctx.fillText(String(Math.round(v)), p + 2, 9);
      else { ctx.save(); ctx.translate(9, p + 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right'; ctx.fillText(String(Math.round(v)), 0, 0); ctx.restore(); }
    }
  }
  ctx.stroke();
}

// left/top/width/height: the frame's css rect inside the positioned parent; sw/sh: frame size in pixels.
export function GuidesOverlay({ tab, seqId, left = 0, top = 0, width, height, sw, sh }) {
  const rulers = useStore(tab.ui, (s) => s.rulers);
  const showGuides = useStore(tab.ui, (s) => s.showGuides);
  const all = useStore(tab.ui, (s) => s.guides);
  const platform = useStore(tab.ui, (s) => s.platformSafe);
  const list = (all && all[seqId]) || [];
  const [drag, setDrag] = useState(null); // { i, axis, v, out }
  const hRef = useRef(null), vRef = useRef(null), boxRef = useRef(null);
  const z = width / sw;

  useEffect(() => {
    if (rulers) { drawRuler(hRef.current, true, width, sw, z); drawRuler(vRef.current, false, height, sh, z); }
  }, [rulers, width, height, sw, sh]);

  const save = (next) => tab.ui.set({ guides: { ...(tab.ui.get().guides || {}), [seqId]: next } });

  const start = (e, axis, index) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = boxRef.current.getBoundingClientRect();
    const posOf = (ev) => (axis === 'x' ? (ev.clientX - rect.left) / z : (ev.clientY - rect.top) / z);
    const outside = (ev) => (axis === 'x' ? ev.clientX < rect.left + 2 || ev.clientX > rect.right : ev.clientY < rect.top + 2 || ev.clientY > rect.bottom);
    const snap = (v) => {
      const size = axis === 'x' ? sw : sh;
      for (const s of [0, size / 2, size]) if (Math.abs(v - s) * z < 6) return s;
      return Math.round(v);
    };
    let cur = { i: index, axis, v: snap(posOf(e)), out: index == null };
    setDrag(cur);
    const move = (ev) => { cur = { ...cur, v: snap(posOf(ev)), out: outside(ev) }; setDrag(cur); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const next = list.slice();
      if (cur.out) { if (index != null) next.splice(index, 1); }
      else if (index != null) next[index] = { axis, v: cur.v };
      else next.push({ axis, v: cur.v });
      save(next);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shown = list.map((g, i) => (drag && drag.i === i ? { ...g, v: drag.v, dragging: true, out: drag.out } : g));
  if (drag && drag.i == null && !drag.out) shown.push({ axis: drag.axis, v: drag.v, dragging: true });
  const visible = showGuides || drag;
  const clear = (e) => { e.preventDefault(); save([]); };

  return html`<div class="guides-layer" ref=${boxRef} style=${{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}>
    ${platform ? html`<${PlatformOverlay} id=${platform} width=${width} height=${height} sw=${sw} sh=${sh} />` : null}
    ${rulers ? html`
      <canvas ref=${hRef} class="ruler ruler-h" style=${{ width: `${width}px`, height: `${R}px`, top: `${-R}px` }}
        onPointerDown=${(e) => e.button === 0 && start(e, 'y', null)} onContextMenu=${clear}></canvas>
      <canvas ref=${vRef} class="ruler ruler-v" style=${{ width: `${R}px`, height: `${height}px`, left: `${-R}px` }}
        onPointerDown=${(e) => e.button === 0 && start(e, 'x', null)} onContextMenu=${clear}></canvas>
      <div class="ruler-corner" style=${{ left: `${-R}px`, top: `${-R}px`, width: `${R}px`, height: `${R}px` }}></div>` : null}
    ${visible ? shown.map((g, i) => html`<div key=${i} class="guide guide-${g.axis} ${g.dragging ? 'is-drag' : ''} ${g.out ? 'is-out' : ''}"
        style=${g.axis === 'x' ? { left: `${g.v * z}px` } : { top: `${g.v * z}px` }}
        onPointerDown=${(e) => e.button === 0 && start(e, g.axis, i < list.length ? i : null)}>
        ${g.dragging ? html`<span class="guide-tip">${g.out ? 'Remove' : `${g.v}px`}</span>` : null}
      </div>`) : null}
  </div>`;
}
