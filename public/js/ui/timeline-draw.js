// Canvas drawing for the timeline: ruler, filmstrip thumbnails and audio waveforms.
import { mediaUrl } from '../core/api.js';
import { clipEnd, audioGainAt, timecode } from '../core/model.js';
import { currentTheme } from '../core/theme.js';

// ---------------------------------------------------------------- asset caches

const sprites = new Map(); // url -> { img, ok }
const waves = new Map(); // url -> { data: Uint8Array | null }
const listeners = new Set();
export function onAssetLoaded(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => { for (const fn of listeners) fn(); };

function sprite(url) {
  let s = sprites.get(url);
  if (!s) {
    s = { img: new Image(), ok: false };
    s.img.onload = () => { s.ok = true; emit(); };
    s.img.src = url;
    sprites.set(url, s);
  }
  return s.ok ? s.img : null;
}
function wave(url) {
  let w = waves.get(url);
  if (!w) {
    w = { data: null };
    waves.set(url, w);
    fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => { if (b) { w.data = new Uint8Array(b); emit(); } }).catch(() => {});
  }
  return w.data;
}

export const CLIP_COLORS = {
  video: '#4f7cff', audio: '#25b38a', image: '#9a6bff', text: '#f0a63a', solid: '#ff6fae', sequence: '#2fb5c9', adjust: '#8d93a3',
};

// ---------------------------------------------------------------- ruler

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
export function drawRuler(canvas, { pps, scrollX, width, seq, markers, comments, inPoint, outPoint, rendered }) {
  const dpr = window.devicePixelRatio || 1;
  const H = 30;
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(H * dpr)) canvas.height = Math.round(H * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, H);
  const fps = seq.fps;
  const frameSteps = [1, 2, 5, 10].map((f) => f / fps).filter((s) => s < 1);
  const steps = [...frameSteps, ...STEPS];
  const major = steps.find((s) => s * pps >= 80) || 3600;
  const minorDiv = major <= 1 / fps ? 1 : major < 1 ? Math.max(1, Math.round(major * fps)) : major >= 60 ? 6 : major === 15 || major === 30 ? 3 : 5;
  const minor = major / minorDiv;
  const t0 = scrollX / pps, t1 = (scrollX + width) / pps;
  const css = getComputedStyle(canvas);

  if (inPoint != null || outPoint != null) {
    const a = ((inPoint ?? 0) * pps) - scrollX, b = ((outPoint ?? t1 + 1) * pps) - scrollX;
    ctx.fillStyle = css.getPropertyValue('--accent-soft') || 'rgba(124, 92, 255, 0.18)';
    ctx.fillRect(a, 0, b - a, H);
    ctx.fillStyle = css.getPropertyValue('--accent-2') || '#8b7bff';
    if (inPoint != null) ctx.fillRect(a, 0, 2, H);
    if (outPoint != null) ctx.fillRect(b - 2, 0, 2, H);
  }

  ctx.strokeStyle = css.getPropertyValue('--ruler-tick') || 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
    const x = Math.round(i * minor * pps - scrollX) + 0.5;
    const isMajor = Math.abs((i * minor) / major - Math.round((i * minor) / major)) < 1e-6;
    ctx.moveTo(x, isMajor ? 12 : 21);
    ctx.lineTo(x, H);
  }
  ctx.stroke();
  ctx.fillStyle = css.getPropertyValue('--ruler-text') || 'rgba(232,234,240,0.62)';
  ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'top';
  for (let i = Math.floor(t0 / major); i * major <= t1 + major; i++) {
    const t = i * major;
    if (t < 0) continue;
    const x = Math.round(t * pps - scrollX);
    ctx.fillText(rulerLabel(t, fps, major), x + 4, 3);
  }

  // Render bar (like Premiere's): green where the timeline is already pre-rendered, amber where it isn't yet.
  if (rendered?.frames > 0) {
    const y = H - 3;
    const end = Math.min(width, (rendered.frames / fps) * pps - scrollX);
    if (end > 0) {
      ctx.fillStyle = 'rgba(245, 165, 36, 0.6)';
      ctx.fillRect(Math.max(0, -scrollX), y, end - Math.max(0, -scrollX), 3);
      ctx.fillStyle = '#34d399';
      for (const [a, b] of rendered.runs || []) {
        const x0 = Math.max(0, (a / fps) * pps - scrollX), x1 = Math.min(width, (b / fps) * pps - scrollX);
        if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 3);
      }
    }
  }

  for (const m of markers || []) {
    const x = m.t * pps - scrollX;
    if (x < -10 || x > width + 10) continue;
    ctx.fillStyle = m.color || '#f5a524';
    ctx.beginPath();
    ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x + 5, 8); ctx.lineTo(x, 13); ctx.lineTo(x - 5, 8);
    ctx.closePath();
    ctx.fill();
  }
  for (const c of comments || []) {
    const x = c.t * pps - scrollX;
    if (x < -10 || x > width + 10) continue;
    ctx.fillStyle = c.resolved ? 'rgba(52, 211, 153, 0.9)' : '#ff6fae';
    ctx.beginPath();
    ctx.arc(x, H - 6, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function rulerLabel(t, fps, major) {
  if (major < 1) return timecode(t, fps);
  const s = Math.round(t);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

// ---------------------------------------------------------------- lanes

export function drawLane(canvas, { track, clips, pps, scrollX, width, height, projectId, mediaById, mediaStatus }) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const top = 18, bodyH = height - top - 3;
  for (const c of clips) {
    const x0 = c.start * pps - scrollX, x1 = clipEnd(c) * pps - scrollX;
    if (x1 < 0 || x0 > width) continue;
    const vx0 = Math.max(0, x0), vx1 = Math.min(width, x1);
    const st = c.media ? mediaStatus[c.media] : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vx0 + 1, 1, vx1 - vx0 - 2, height - 2);
    ctx.clip();
    if (c.type === 'video' && st?.thumbs && st.key) {
      const img = sprite(mediaUrl(projectId, c.media, 'thumbs', st.key));
      if (img) {
        const th = st.thumbs;
        const tw = Math.max(8, (bodyH * th.w) / th.h);
        const first = Math.floor((vx0 - x0) / tw);
        ctx.globalAlpha = c.enabled === false ? 0.35 : 0.9;
        for (let i = first; x0 + i * tw < vx1; i++) {
          const px = x0 + i * tw;
          const src = (c.in || 0) + ((i * tw + tw / 2) / pps) * (c.speed || 1);
          const idx = Math.max(0, Math.min(th.count - 1, Math.floor(src / th.interval)));
          ctx.drawImage(img, idx * th.w, 0, th.w, th.h, px, top, tw, bodyH);
        }
      }
    } else if (c.type === 'image' && st?.poster && st.key) {
      const img = sprite(mediaUrl(projectId, c.media, 'poster', st.key));
      if (img) {
        const tw = Math.max(8, (bodyH * img.naturalWidth) / Math.max(1, img.naturalHeight));
        ctx.globalAlpha = 0.85;
        for (let px = x0 + Math.floor((vx0 - x0) / tw) * tw; px < vx1; px += tw) ctx.drawImage(img, px, top, tw, bodyH);
      }
    } else if (c.type === 'audio' && st?.wave && st.key) {
      const data = wave(mediaUrl(projectId, c.media, 'wave', st.key));
      if (data) {
        const mid = top + bodyH / 2;
        const speed = c.speed || 1;
        ctx.fillStyle = track.muted || c.enabled === false ? 'rgba(160,170,180,0.35)' : currentTheme() === 'light' ? 'rgba(8, 115, 82, 0.85)' : 'rgba(150, 255, 214, 0.78)';
        for (let x = Math.floor(vx0); x < vx1; x++) {
          const ta = (x - x0) / pps, tb = (x + 1 - x0) / pps;
          const sa = Math.floor(((c.in || 0) + ta * speed) * 100), sb = Math.max(sa + 1, Math.ceil(((c.in || 0) + tb * speed) * 100));
          let peak = 0;
          for (let i = sa; i < sb && i < data.length; i++) if (data[i] > peak) peak = data[i];
          const g = Math.min(2, audioGainAt(c, c.start + ta) * (track.volume ?? 1));
          const hgt = Math.max(0.5, (peak / 255) * (bodyH / 2) * g);
          ctx.fillRect(x, mid - hgt, 1, hgt * 2);
        }
      }
    }
    ctx.restore();
  }
  // Overlaps can only come from outside edits (e.g. project.json changed by hand); flag them in red.
  // The next edit in the editor resolves them.
  let maxEnd = -Infinity;
  for (const c of clips) {
    const e = clipEnd(c);
    if (c.start < maxEnd - 1e-4) {
      const a = c.start * pps - scrollX, b = Math.min(maxEnd, e) * pps - scrollX;
      ctx.fillStyle = 'rgba(255, 77, 106, 0.45)';
      ctx.fillRect(a, 0, Math.max(2, b - a), height);
    }
    maxEnd = Math.max(maxEnd, e);
  }
}
