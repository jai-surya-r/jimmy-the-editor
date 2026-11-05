// The sequence's level beside the timeline: left and right bars on a dB scale, green / yellow / red, a peak line that
// holds for a moment, and a clip light that stays on until it is clicked. It reads the mix itself, so the Review page's
// volume doesn't change what it shows.
import { html } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../core/store.js';
import { audioGraph } from '../core/playback.js';
import { onThemeChange } from '../core/theme.js';

const FLOOR = -60;
const TICKS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60];
const SEGMENTS = [[-12, '#2fd07f'], [-3, '#f5c451'], [Infinity, '#ff4d6a']]; // up to this dB: this colour
const FALL_DB_PER_S = 24;
const HOLD_MS = 1500;
const CLIP_H = 7;
const TOP = 14;
const BOTTOM = 18;

const level = (db) => Math.min(1, Math.max(0, (db - FLOOR) / -FLOOR));
const peakDb = (an, buf) => {
  an.getFloatTimeDomainData(buf);
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return 20 * Math.log10(p || 1e-6);
};

export function AudioMeter({ tab }) {
  const playing = useStore(tab.time, (s) => s.playing);
  const ref = useRef(null);
  const [clipped, setClipped] = useState(false);
  const state = useRef({ bars: [{ db: FLOOR, peak: FLOOR, at: 0 }, { db: FLOOR, peak: FLOOR, at: 0 }], colors: null, buf: null, last: 0, box: null });

  const draw = () => {
    const cv = ref.current;
    if (!cv) return;
    const S = state.current;
    const box = S.box || (S.box = cv.parentElement.getBoundingClientRect()); // kept up to date by the ResizeObserver
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(box.width), Math.round(box.height)];
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`; }
    if (!S.colors) {
      const css = getComputedStyle(cv);
      S.colors = { track: css.getPropertyValue('--panel-3').trim(), text: css.getPropertyValue('--muted').trim(), line: css.getPropertyValue('--line-2').trim(), peak: css.getPropertyValue('--text').trim() };
    }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const barH = h - TOP - BOTTOM;
    const y = (db) => TOP + barH * (1 - level(db));
    const [barW, gap, x0] = [11, 3, 8];
    c.font = '9px "JetBrains Mono", monospace';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    const every = barH < 150 ? 12 : 6; // a short timeline keeps the scale readable
    for (const db of TICKS) {
      if (db % every) continue;
      const ty = Math.round(y(db)) + 0.5;
      c.fillStyle = S.colors.line;
      c.fillRect(x0 + barW * 2 + gap + 1, ty - 0.5, 3, 1);
      c.fillStyle = S.colors.text;
      c.fillText(String(Math.abs(db)), w - 3, ty);
    }
    S.bars.forEach((b, i) => {
      const x = x0 + i * (barW + gap);
      c.fillStyle = S.colors.track;
      c.fillRect(x, TOP, barW, barH);
      let from = FLOOR;
      for (const [to, color] of SEGMENTS) {
        const top = Math.min(to, b.db, 0);
        if (top > from) { c.fillStyle = color; c.fillRect(x, y(top), barW, y(from) - y(top)); }
        from = to;
        if (b.db <= to) break;
      }
      if (b.peak > FLOOR) {
        const shown = Math.min(b.peak, 0);
        c.fillStyle = SEGMENTS.find(([to]) => shown <= to)[1];
        c.fillRect(x, Math.round(y(shown)), barW, 1);
      }
      c.fillStyle = S.colors.text;
      c.textAlign = 'center';
      c.fillText('LR'[i], x + barW / 2, h - 9);
      c.textAlign = 'right';
    });
  };

  // runs while something plays and until the bars have fallen back, so an idle timeline costs nothing
  useEffect(() => {
    const S = state.current;
    let raf = 0;
    const loop = (now) => {
      raf = 0;
      const dt = Math.min(0.1, (now - (S.last || now)) / 1000);
      S.last = now;
      let live = [null, null];
      if (tab.engine.playing) {
        const { meters } = audioGraph();
        S.buf ||= new Float32Array(meters[0].fftSize);
        live = meters.map((m) => peakDb(m, S.buf));
      }
      S.bars.forEach((b, i) => {
        const db = live[i] ?? FLOOR;
        b.db = Math.max(db, b.db - FALL_DB_PER_S * dt, FLOOR);
        if (db >= b.peak) { b.peak = db; b.at = now; } else if (now - b.at > HOLD_MS) b.peak = Math.max(FLOOR, b.peak - FALL_DB_PER_S * dt);
        if (db > 0) setClipped(true);
      });
      // about 30 times a second is all a meter needs (the screen may refresh 144 times)
      const more = tab.engine.playing || S.bars.some((b) => b.db > FLOOR || b.peak > FLOOR);
      if (!more || now - (S.drawnAt || 0) >= 30) { S.drawnAt = now; draw(); }
      if (more) raf = requestAnimationFrame(loop);
      else S.last = 0;
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [playing, tab]);

  useEffect(() => {
    const ro = new ResizeObserver(() => { state.current.box = null; draw(); });
    ro.observe(ref.current.parentElement);
    const off = onThemeChange(() => { state.current.colors = null; draw(); });
    return () => { ro.disconnect(); off(); };
  }, []);

  return html`<div class="audio-meter" title="Audio level in dB">
    <canvas ref=${ref}></canvas>
    <button class=${`meter-clip ${clipped ? 'is-on' : ''}`} style=${{ height: `${CLIP_H}px` }} title=${clipped ? 'The audio went over 0 dB. Click to clear' : 'Lights up if the audio goes over 0 dB'} onClick=${() => setClipped(false)}></button>
  </div>`;
}
