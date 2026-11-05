#!/usr/bin/env node
// Claude Code PreToolUse hook (Read) for the editor's chats: an image Claude opens is shown to it check-sized.
// Every image stays in the conversation and is re-read on each later step, so anything bigger than a 540p frame is
// replaced by a shrunk copy (cached in the temp folder): at most CHECK_SIDE on its longest side and no more pixels
// than 960×540 (16:9 960×540, 9:16 540×960, square 720×720, a contact sheet the same area; Step 83 — before, only
// the longest side was capped, so square frames and sheets reached Claude at up to twice that). Files named
// *.full.<ext> (vedit frame --full: Claude asked for full size) and images already small enough (crops) pass through.
// usage (from the settings file the editor writes): node check-image.mjs <ffmpeg> <checks folder>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CHECK_SIDE = 960;
const CHECK_PIXELS = 960 * 540;
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// width/height from the file header (PNG, JPEG, WebP); null when unknown
function size(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (n > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
      if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
      if (kind === 'VP8L') { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < n;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } finally { fs.closeSync(fd); }
  return null;
}

function main(input) {
  const ffmpeg = process.argv[2] || 'ffmpeg';
  const tool = input.tool_input || {};
  const file = typeof tool.file_path === 'string' ? tool.file_path : '';
  const ext = path.extname(file).toLowerCase();
  if (!EXTS.has(ext) || /\.full\.\w+$/i.test(file)) return;
  const st = fs.statSync(file);
  const wh = size(file);
  if (!wh || (Math.max(...wh) <= CHECK_SIDE && wh[0] * wh[1] <= CHECK_PIXELS)) return;
  const k = Math.min(1, CHECK_SIDE / Math.max(...wh), Math.sqrt(CHECK_PIXELS / (wh[0] * wh[1])));
  const W = Math.max(2, Math.floor((wh[0] * k) / 2) * 2), H = Math.max(2, Math.floor((wh[1] * k) / 2) * 2);
  // (540p: copies made by the longest-side rule before aren't reused)
  const key = crypto.createHash('sha1').update(`540p|${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  // the long form of the temp path: Claude Code asks before reading an 8.3 short name (C:\Users\ABC~1\…)
  const dir = process.argv[3] || path.join(fs.realpathSync.native(os.tmpdir()), 'claude-edit-checks');
  const out = path.join(dir, `${path.basename(file, ext).slice(0, 60)}-${key}${ext === '.jpg' || ext === '.jpeg' ? '.jpg' : '.png'}`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf',
      `scale=${W}:${H}`, '-q:v', '3', out], { windowsHide: true });
    if (r.status !== 0 || !fs.existsSync(out)) return; // can't shrink it: Claude sees the original
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool, file_path: out } } }));
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  // never block a Read: any problem just lets the original through
  try { main(JSON.parse(raw)); } catch { /* pass through */ }
  process.exit(0);
});
