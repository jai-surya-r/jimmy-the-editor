#!/usr/bin/env node
// Compares an engine's golden frames with the references and writes tests/golden/report.html.
//   node tests/golden/compare.mjs [engine]     (default: ENGINE env, then classic)
// REF=<engine> compares with that engine's frames (tests/.work/golden-out/<engine>) instead of the classic references,
// Per frame: PSNR over RGB, the largest single-pixel difference, and the worst 16x16 area (mean absolute
// difference of its worst channel). Pass: PSNR >= 45 dB (video/image) or >= 40 dB (text), and no area
// off by more than 8/255.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, WORK } from '../lib/server.mjs';
import { REF_DIR, frameList, frameFile } from './capture.mjs';

const { FFMPEG } = await import('../../server/ffmpeg.js');
export const LIMITS = { psnr: { video: 45, text: 40 }, area: 8, block: 16 };
const REPORT = path.join(ROOT, 'tests', 'golden', 'report.html');

function pngSize(file) {
  const b = fs.readFileSync(file).subarray(0, 24);
  if (b.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function decode(file) {
  const { w, h } = pngSize(file);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: w * h * 3 + 1024 });
  if (r.status !== 0) throw new Error(`could not decode ${file}: ${r.stderr}`);
  return { w, h, px: r.stdout };
}
function encodePng(px, w, h, file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', file], { input: px });
  if (r.status !== 0) throw new Error(`could not write ${file}: ${r.stderr}`);
}

export function measure(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { sizeMismatch: `${b.w}x${b.h} vs reference ${a.w}x${a.h}` };
  const { w, h } = a, B = LIMITS.block;
  let sq = 0, maxPx = 0;
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const blockSum = new Float64Array(bw * bh * 3), blockN = new Uint32Array(bw * bh);
  const heat = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const by = (y / B) | 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, bi = by * bw + ((x / B) | 0);
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.px[i + c] - b.px[i + c]);
        sq += d * d;
        blockSum[bi * 3 + c] += d;
        if (d > m) m = d;
      }
      blockN[bi]++;
      if (m > maxPx) maxPx = m;
      // heatmap: the reference dimmed to grey, differences on top from red (1/255) to yellow (16/255 and up)
      const grey = ((a.px[i] + a.px[i + 1] + a.px[i + 2]) / 12) | 0;
      if (m === 0) { heat[i] = heat[i + 1] = heat[i + 2] = grey; }
      else { heat[i] = 255; heat[i + 1] = Math.min(255, m * 16); heat[i + 2] = 0; }
    }
  }
  let area = 0;
  for (let bi = 0; bi < bw * bh; bi++) for (let c = 0; c < 3; c++) area = Math.max(area, blockSum[bi * 3 + c] / blockN[bi]);
  const mse = sq / (w * h * 3);
  return { psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), maxPx, area, heat };
}

export function compare(engine, ref = process.env.REF || null) {
  const refDir = ref ? path.join(WORK, 'golden-out', ref) : REF_DIR;
  const outDir = path.join(WORK, 'golden-out', engine);
  const diffDir = path.join(WORK, 'golden-diff', engine);
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'capture.json'), 'utf8'));
  fs.rmSync(diffDir, { recursive: true, force: true });
  fs.mkdirSync(diffDir, { recursive: true });
  const rows = [];
  for (const f of frameList()) {
    const name = frameFile(f, meta.fps[f.seq]);
    const refFile = path.join(refDir, name), outFile = path.join(outDir, name);
    const row = { ...f, name, limit: LIMITS.psnr[f.kind] ?? LIMITS.psnr.video };
    if (!fs.existsSync(refFile)) row.error = ref ? `no ${ref} frame (ENGINE=${ref} npm run golden first)` : 'no reference (run npm run golden:ref)';
    else if (!fs.existsSync(outFile)) row.error = 'not rendered';
    else {
      const ref = decode(refFile);
      const m = measure(ref, decode(outFile));
      if (m.sizeMismatch) row.error = `size ${m.sizeMismatch}`;
      else {
        Object.assign(row, { psnr: m.psnr, maxPx: m.maxPx, area: m.area });
        if (m.maxPx > 0) { encodePng(m.heat, ref.w, ref.h, path.join(diffDir, name)); row.diff = true; }
      }
    }
    row.pass = !row.error && row.psnr >= row.limit && row.area <= LIMITS.area;
    rows.push(row);
  }
  writeReport(engine, rows, { outDir, diffDir, refDir, ref: ref || 'classic' });
  return rows;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtPsnr = (v) => (v === Infinity ? '∞' : v == null ? '—' : v.toFixed(2));

function writeReport(engine, rows, { outDir, diffDir, refDir, ref }) {
  const rel = (dir, name) => path.relative(path.dirname(REPORT), path.join(dir, name)).split(path.sep).join('/');
  const failed = rows.filter((r) => !r.pass);
  const sorted = [...failed, ...rows.filter((r) => r.pass)];
  const body = sorted.map((r) => `
  <section class="frame ${r.pass ? 'pass' : 'fail'}">
    <header>
      <span class="badge">${r.pass ? 'PASS' : 'FAIL'}</span>
      <b>${esc(r.seq)} @ ${r.t}s</b> <span class="muted">${esc(r.what)} · ${esc(r.kind)}</span>
      <span class="nums">${r.error ? esc(r.error) : `PSNR ${fmtPsnr(r.psnr)} dB (≥ ${r.limit}) · worst area ${r.area.toFixed(2)}/255 (≤ ${LIMITS.area}) · max pixel ${r.maxPx}/255`}</span>
    </header>
    <div class="imgs">
      <figure><img loading="lazy" src="${rel(refDir, r.name)}"><figcaption>reference (${esc(ref)})</figcaption></figure>
      <figure><img loading="lazy" src="${rel(outDir, r.name)}"><figcaption>${esc(engine)}</figcaption></figure>
      <figure>${r.diff ? `<img loading="lazy" src="${rel(diffDir, r.name)}">` : '<div class="same">identical</div>'}<figcaption>difference</figcaption></figure>
    </div>
  </section>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Golden frames report</title>
<style>
  :root { --bg: #ffffff; --fg: #1a1d24; --muted: #667085; --card: #f4f5f7; --line: #e2e5ea; --pass: #1f8a4c; --fail: #c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111318; --fg: #e8eaf0; --muted: #98a2b3; --card: #1a1d24; --line: #2a2f3a; --pass: #4cc38a; --fail: #ff6b6b; } }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; } .muted { color: var(--muted); }
  .summary { margin: 0 0 20px; } .summary b.ok { color: var(--pass); } .summary b.bad { color: var(--fail); }
  .frame { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 0 0 14px; }
  .frame header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 10px; }
  .nums { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); }
  .badge { font-weight: 700; font-size: 12px; padding: 1px 6px; border-radius: 4px; color: #fff; }
  .pass .badge { background: var(--pass); } .fail .badge { background: var(--fail); } .fail { border-color: var(--fail); }
  .imgs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
  figure { margin: 0; } img { width: 100%; display: block; border-radius: 4px; background: #000; }
  figcaption { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .same { aspect-ratio: 16 / 9; display: grid; place-items: center; border: 1px dashed var(--line); border-radius: 4px; color: var(--muted); }
</style></head><body>
<h1>Golden frames: ${esc(engine)} vs ${esc(ref)}${ref === 'classic' ? ' references' : ''}</h1>
<p class="summary">${new Date().toLocaleString()} · ${rows.length} frames · <b class="${failed.length ? 'bad' : 'ok'}">${failed.length ? `${failed.length} failed` : 'all passed'}</b>
 · limits: PSNR ≥ ${LIMITS.psnr.video} dB (video/image), ≥ ${LIMITS.psnr.text} dB (text); no ${LIMITS.block}×${LIMITS.block} area off by more than ${LIMITS.area}/255.
 Difference images: grey = identical, red→yellow = 1→16+/255.</p>
${body}
</body></html>
`;
  fs.writeFileSync(REPORT, html);
}

export function printTable(engine, rows) {
  const failed = rows.filter((r) => !r.pass);
  const worst = rows.filter((r) => r.psnr != null).sort((a, b) => a.psnr - b.psnr)[0];
  for (const r of failed) console.log(`  FAIL  ${r.name.padEnd(22)} ${r.error || `PSNR ${fmtPsnr(r.psnr)} (≥ ${r.limit})  area ${r.area.toFixed(2)}  max ${r.maxPx}`}  ${r.what}`);
  console.log(`${engine}: ${rows.length - failed.length}/${rows.length} frames pass${worst ? `; lowest PSNR ${fmtPsnr(worst.psnr)} dB (${worst.name})` : ''}`);
  console.log(`report: ${path.relative(ROOT, REPORT)}`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const engine = process.argv[2] || process.env.ENGINE || 'classic';
  const rows = compare(engine);
  printTable(engine, rows);
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
}
