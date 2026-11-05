// Text layout + rasterisation for text clips (canvas 2D).
import { fontString } from './fonts.js';

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let measure = null;
function mctx() {
  if (!measure) measure = makeCanvas(8, 8).getContext('2d');
  return measure;
}

function applySpacing(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px || 0}px`;
}

export function textLayout(clip, seq) {
  const st = clip.style;
  let text = String(clip.text ?? '');
  if (st.uppercase) text = text.toUpperCase();
  const ctx = mctx();
  ctx.font = fontString(st, st.size);
  applySpacing(ctx, st.letterSpacing);
  const maxW = st.maxWidth > 0 ? st.maxWidth : seq.width * 0.9;
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  const widths = lines.map((l) => ctx.measureText(l).width);
  const textW = Math.max(1, ...widths);
  const lineH = st.size * st.lineHeight;
  const textH = Math.max(lineH, lines.length * lineH);
  const bg = st.background;
  const pad = bg.opacity > 0 ? bg.padding : 0;
  const w = textW + pad * 2;
  const h = textH + pad * 2;
  const sh = st.shadow;
  const margin = Math.ceil((st.stroke.width || 0) + (sh.opacity > 0 ? sh.blur * 2 + Math.max(Math.abs(sh.x), Math.abs(sh.y)) : 0) + 4);
  return { lines, widths, textW, lineH, w, h, pad, margin, st };
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Returns { canvas, w, h, margin } — w/h is the layout box in sequence pixels; the bitmap is
// (w + 2·margin)·factor wide so strokes and shadows aren't clipped.
export function drawTextBitmap(layout, factor) {
  const { lines, widths, textW, lineH, w, h, pad, margin, st } = layout;
  const cw = Math.max(1, Math.ceil((w + margin * 2) * factor));
  const ch = Math.max(1, Math.ceil((h + margin * 2) * factor));
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.scale(factor, factor);
  ctx.translate(margin, margin);

  const bg = st.background;
  if (bg.opacity > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, bg.opacity);
    ctx.fillStyle = bg.color;
    ctx.beginPath();
    if (bg.mode === 'line') {
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        const lw = widths[i] + pad * 2;
        const x = st.align === 'left' ? 0 : st.align === 'right' ? w - lw : (w - lw) / 2;
        roundRectPath(ctx, x, pad + i * lineH - pad * 0.4, lw, lineH + pad * 0.8, bg.radius);
      });
    } else {
      roundRectPath(ctx, 0, 0, w, h, bg.radius);
    }
    ctx.fill();
    ctx.restore();
  }

  ctx.font = fontString(st, st.size);
  applySpacing(ctx, st.letterSpacing);
  ctx.textBaseline = 'middle';
  ctx.textAlign = st.align;
  const x = st.align === 'left' ? pad : st.align === 'right' ? pad + textW : pad + textW / 2;
  const ys = lines.map((_, i) => pad + i * lineH + lineH / 2);
  const sh = st.shadow;
  const setShadow = (on) => {
    if (on && sh.opacity > 0) {
      ctx.shadowColor = withAlpha(sh.color, sh.opacity);
      ctx.shadowBlur = sh.blur * factor;
      ctx.shadowOffsetX = sh.x * factor;
      ctx.shadowOffsetY = sh.y * factor;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
  };
  if (st.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = st.stroke.width * 2;
    ctx.strokeStyle = st.stroke.color;
    setShadow(true);
    lines.forEach((l, i) => ctx.strokeText(l, x, ys[i]));
    setShadow(false);
  } else setShadow(true);
  ctx.fillStyle = st.color;
  lines.forEach((l, i) => ctx.fillText(l, x, ys[i]));
  return { canvas, w, h, margin };
}

export function withAlpha(color, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color).trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  const base = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${base * a})`;
}
