// The image hook of Jimmy's Claude chats (bin/check-image.mjs): what Claude sees when it Reads an image. 540p unless it
// asks for full size: 16:9 → 960×540, 9:16 → 540×960, square → 720×720, a tall contact sheet → the same pixel count;
// small images and *.full.png pass through untouched. `node tests/check-image.mjs`
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORK, ROOT } from './lib/server.mjs';
import { FFMPEG } from '../server/ffmpeg.js';

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DIR = path.join(WORK, 'check-image');
fs.rmSync(DIR, { recursive: true, force: true });
const OUT = path.join(DIR, 'checks');
fs.mkdirSync(OUT, { recursive: true });

const make = (name, w, h) => {
  const file = path.join(DIR, name);
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=1`, '-frames:v', '1', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return file;
};
const dims = (file) => {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  for (let i = 2; i + 9 < b.length;) { if (b[i] !== 0xff) { i++; continue; } const mk = b[i + 1]; if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + b.readUInt16BE(i + 2); }
  return null;
};
// what Claude reads: the hook's replacement, or the file itself
const seen = (file) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'check-image.mjs'), FFMPEG, OUT], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file } }), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput.file_path : file;
  return { file: out, wh: dims(out) };
};
const cases = [
  ['frame 1080p', 'wide.png', 1920, 1080, [960, 540]],
  ['frame 4K', 'uhd.png', 3840, 2160, [960, 540]],
  ['vertical 9:16', 'tall.png', 1080, 1920, [540, 960]],
  ['square', 'square.png', 1080, 1080, [720, 720]],
  ['square at 960 (vedit frame of a 1:1 sequence)', 'square960.png', 960, 960, [720, 720]],
  ['contact sheet 1920×1872', 'sheet.png', 1920, 1872, null],
  ['strip 1920×360', 'strip.png', 1920, 360, [960, 180]],
  ['JPEG 1080p', 'photo.jpg', 1920, 1080, [960, 540]],
];
for (const [label, name, w, h, want] of cases) {
  const s = seen(make(name, w, h));
  const px = s.wh[0] * s.wh[1];
  const good = want ? s.wh[0] === want[0] && s.wh[1] === want[1] : px <= 960 * 540 && Math.max(...s.wh) <= 960 && Math.abs(s.wh[0] / s.wh[1] - w / h) < 0.02;
  ok(good, `${label}: Claude sees ${s.wh.join('×')}${want ? '' : ` (${px} px, at most ${960 * 540})`}`);
}
const small = make('crop.png', 640, 360);
ok(seen(small).file === small, 'a small image (a crop) passes through untouched');
const full = make('frame.full.png', 1920, 1080);
ok(seen(full).file === full && seen(full).wh[0] === 1920, 'a *.full.png (Claude asked for full size) passes through at 1920×1080');
const again = seen(path.join(DIR, 'wide.png'));
ok(fs.readdirSync(OUT).filter((f) => f.startsWith('wide-')).length === 1 && again.wh[0] === 960, 'the shrunk copy is made once and reused');
console.log(failed ? `check-image: ${failed} failed` : 'check-image: all checks passed');
process.exit(failed ? 1 : 0);
