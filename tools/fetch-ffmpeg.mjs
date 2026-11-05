#!/usr/bin/env node
// npm run fetch-ffmpeg [-- --platform win32-x64] [--force]
// Downloads the LGPL ffmpeg build the desktop app ships into vendor/ffmpeg/<platform>-<arch>/ (ffmpeg, ffprobe,
// LICENSE.txt, SOURCE.txt). LGPL because x264/x265 are GPL: CPU H.264 uses OpenH264 instead (server/ffmpeg.js).
// Builds come from BtbN/FFmpeg-Builds (release branch 8.1, statically linked); each download is checked against
// the SHA-256 that release publishes. There is no prebuilt LGPL build for macOS: there, ffmpeg has to be built from
// source (planned for the Mac CI build, Step 11), and until then the app uses the installed ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const BUILDS = {
  'win32-x64': { file: 'ffmpeg-n8.1-latest-win64-lgpl-8.1.zip', exe: '.exe' },
  'linux-x64': { file: 'ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz', exe: '' },
};

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const platform = opt('--platform') || `${process.platform}-${process.arch}`;
const force = argv.includes('--force');

async function download(url, file) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')}: ${r.stderr || r.error?.message}`);
  return r.stdout;
}

async function main() {
  const build = BUILDS[platform];
  if (!build) {
    console.log(`No prebuilt LGPL ffmpeg for ${platform} (available: ${Object.keys(BUILDS).join(', ')}).`);
    console.log('The app will use the ffmpeg installed on this machine.');
    return;
  }
  const dest = path.join(ROOT, 'vendor', 'ffmpeg', platform);
  if (!force && fs.existsSync(path.join(dest, `ffmpeg${build.exe}`))) {
    console.log(`Already there: ${path.relative(ROOT, dest)} (--force to fetch again)`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jimmy-ffmpeg-'));
  try {
    console.log(`Downloading ${build.file}…`);
    const sums = path.join(tmp, 'checksums.sha256');
    await download(`${RELEASE}/checksums.sha256`, sums);
    const want = fs.readFileSync(sums, 'utf8').split('\n').find((l) => l.trim().endsWith(build.file))?.split(/\s+/)[0];
    if (!want) throw new Error(`${build.file} is not in the release's checksums.sha256`);
    const archive = path.join(tmp, build.file);
    await download(`${RELEASE}/${build.file}`, archive);
    const got = sha256(archive);
    if (got !== want) throw new Error(`checksum mismatch for ${build.file}: got ${got}, expected ${want}`);
    // Windows' own tar (bsdtar) reads zip files; Git's GNU tar doesn't
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const out = path.join(tmp, 'x');
    fs.mkdirSync(out);
    sh(tar, ['-xf', archive, '-C', out]);
    const top = path.join(out, fs.readdirSync(out)[0]);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const name of ['ffmpeg', 'ffprobe']) {
      fs.copyFileSync(path.join(top, 'bin', `${name}${build.exe}`), path.join(dest, `${name}${build.exe}`));
      if (!build.exe) fs.chmodSync(path.join(dest, name), 0o755);
    }
    fs.copyFileSync(path.join(top, 'LICENSE.txt'), path.join(dest, 'LICENSE.txt'));
    const version = sh(path.join(dest, `ffmpeg${build.exe}`), ['-hide_banner', '-version']).split('\n')[0];
    const commit = /-g([0-9a-f]{7,})/.exec(version)?.[1];
    fs.writeFileSync(path.join(dest, 'SOURCE.txt'), [
      version,
      `Archive: ${build.file} (sha256 ${got}), from ${RELEASE.replace('/download/latest', '')}`,
      'Licence: LGPL v3 or later (built with --enable-version3, without GPL or non-free parts); see LICENSE.txt.',
      `Source code: https://github.com/FFmpeg/FFmpeg${commit ? `/tree/${commit}` : ''}`,
      'Build scripts (configure flags, bundled libraries and their versions): https://github.com/BtbN/FFmpeg-Builds',
      '',
    ].join('\n'));
    console.log(`${version}\n→ ${path.relative(ROOT, dest)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(`fetch-ffmpeg: ${e.message}`); process.exit(1); });
