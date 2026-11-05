#!/usr/bin/env node
// Builds the golden test project from generated media only (no real footage).
// Output: tests/.work/golden/ — an ordinary Jimmy project folder (gitignored) holding
//   media/     clips, stills and audio made with ffmpeg test sources
//   luts/      a generated 33-point .cube LUT (a contrast curve, warm tint and less saturation)
//   motion/    the motion-graphic HTML from tests/golden/motion
//   project.json  copied from tests/golden/project.json (reset on every run; the editor patches it)
// Media files are only made when missing (or made by an older version of this script); pass --force to remake them.
// Video is converted with and tagged as BT.709, so every decoder reads the same colours (an untagged clip is
// BT.601 to ffmpeg).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'tests', 'golden');
export const WORK = path.join(ROOT, 'tests', '.work', 'golden');
const MEDIA = path.join(WORK, 'media');
// bump when the generated media changes, so existing copies are remade
const MEDIA_VERSION = '2: BT.709 tagged';
const stampFile = path.join(MEDIA, 'VERSION');
const stale = !fs.existsSync(stampFile) || fs.readFileSync(stampFile, 'utf8').trim() !== MEDIA_VERSION;
const force = process.argv.includes('--force') || stale;

const { FFMPEG, FFPROBE } = await import('../server/ffmpeg.js');
if (!FFMPEG) { console.error('make-media: ffmpeg not found (install it or set FFMPEG_PATH)'); process.exit(1); }

const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const H264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '2', ...BT709, '-movflags', '+faststart'];

// A moving coloured square on top of testsrc2 (which already has its own moving parts and a frame counter).
const moving = (w, h, rate, dur, box, color) => [
  '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${rate}:duration=${dur}`,
  '-f', 'lavfi', '-i', `color=c=${color}:size=${box}x${box}:rate=${rate}`,
  '-filter_complex', `[0:v][1:v]overlay=x='mod(t*${Math.round(w / 5)}\\,${w - box})':y='${(h - box) / 2}+${Math.round(h / 5)}*sin(t*2)':shortest=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]`,
];

const JOBS = [
  {
    file: 'clip-1080p30.mp4', what: '1080p30 H.264 with a 440 Hz tone, 12 s',
    args: [...moving(1920, 1080, 30, 12, 160, '0xff3355'), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-map', '[v]', '-map', '2:a', ...H264, '-c:a', 'aac', '-b:a', '128k', '-shortest'],
  },
  {
    file: 'clip-4k30.mp4', what: '4K 30 fps H.264, 8 s',
    args: [...moving(3840, 2160, 30, 8, 320, '0x33ddff'), '-map', '[v]', ...H264, '-crf', '20', '-preset', 'fast'],
  },
  {
    file: 'clip-23976.mp4', what: '1080p 23.976 fps H.264, 8 s',
    args: [...moving(1920, 1080, '24000/1001', 8, 160, '0x66ff66'), '-map', '[v]', ...H264, '-g', '24'],
  },
  {
    // transparent background; a translucent bar sweeping across and a feathered disc orbiting (soft alpha edges)
    file: 'alpha-prores4444.mov', what: '1080p30 ProRes 4444 with alpha, 5 s',
    args: [
      '-f', 'lavfi', '-i', 'color=c=0x00000000:size=1920x1080:rate=30:duration=5,format=rgba',
      '-f', 'lavfi', '-i', 'color=c=0xffaa00@0.7:size=700x220:rate=30:duration=5,format=rgba',
      '-f', 'lavfi', '-i', "color=size=400x400:rate=30:duration=5,format=rgba,geq=r='40':g='200':b='255':a='255*clip((200-hypot(X-200\\,Y-200))/50\\,0\\,1)'",
      '-filter_complex', "[0:v][1:v]overlay=x='-700+t*500':y=180:format=auto:shortest=1[a];[a][2:v]overlay=x='760+500*cos(t*1.5)':y='340+250*sin(t*1.5)':format=auto:shortest=1,scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]",
      '-map', '[v]', '-t', '5', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', ...BT709,
    ],
  },
  {
    // 1600x900, not the sequence size; soft elliptical alpha edge and fine stripes (shows blur / scaling)
    file: 'still-alpha.png', what: '1600x900 PNG with alpha',
    args: ['-f', 'lavfi', '-i', 'color=size=1600x900,format=rgba',
      '-vf', "geq=r='255*X/W':g='255*Y/H':b='128+127*sin(X/12)':a='255*clip((1-hypot((X-W/2)/(W/2)\\,(Y-H/2)/(H/2)))*8\\,0\\,1)'",
      '-frames:v', '1'],
  },
  {
    file: 'photo.jpg', what: '1280x720 opaque JPEG',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-vf', 'hue=h=40:s=1.3', '-frames:v', '1', '-q:v', '2'],
  },
  {
    file: 'tone.wav', what: '1 kHz stereo tone, 12 s, 48 kHz',
    args: ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=12', '-af', 'volume=0.25', '-ac', '2', '-c:a', 'pcm_s16le'],
  },
];

function ffmpeg(args, out) {
  // the timeout is a safety net: a filter graph with an endless input would otherwise fill the disk
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${path.basename(out)}:\n${(r.stderr || r.error?.message || '').trim()}`);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

// A look made here, so the test owns every number in it: a smooth contrast curve, a warm tint and 80 % saturation
// (the saturation mixes the channels, so the 3D lookup is tested, not only three 1D curves). Red changes fastest.
function testLut(n) {
  const curve = (v) => v * v * (3 - 2 * v) * 0.6 + v * 0.4;
  const lines = ['TITLE "Test_Look"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    let c = [r, g, b].map((v) => curve(v / (n - 1)));
    c = [c[0] * 1.04, c[1], c[2] * 0.94];
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    lines.push(c.map((v) => Math.min(1, Math.max(0, y + (v - y) * 0.8)).toFixed(6)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

fs.mkdirSync(MEDIA, { recursive: true });
for (const job of JOBS) {
  const out = path.join(MEDIA, job.file);
  if (!force && fs.existsSync(out) && fs.statSync(out).size > 0) { console.log(`  have  ${job.file}`); continue; }
  const t0 = Date.now();
  const tmp = out.replace(/(\.\w+)$/, '.part$1');
  ffmpeg(job.args, tmp);
  fs.renameSync(tmp, out);
  console.log(`  made  ${job.file}  (${job.what}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

fs.writeFileSync(stampFile, `${MEDIA_VERSION}\n`);

fs.mkdirSync(path.join(WORK, 'luts'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'luts', 'Test_Look.cube'), testLut(33));
copyDir(path.join(GOLDEN, 'motion'), path.join(WORK, 'motion'));
fs.copyFileSync(path.join(GOLDEN, 'project.json'), path.join(WORK, 'project.json'));

// quick sanity check: every media file the project names exists and probes
const doc = JSON.parse(fs.readFileSync(path.join(WORK, 'project.json'), 'utf8'));
let bad = 0;
for (const m of doc.media) {
  if (m.motion) continue; // rendered by the editor
  const f = path.join(WORK, m.path);
  const r = FFPROBE ? spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f], { encoding: 'utf8' }) : { status: fs.existsSync(f) ? 0 : 1 };
  if (r.status !== 0) { console.error(`  MISSING/UNREADABLE  ${m.path}`); bad++; }
}
if (bad) process.exit(1);
console.log(`\nGolden project ready: ${WORK}`);
