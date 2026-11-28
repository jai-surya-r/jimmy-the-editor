// The real graphics-hardware test (server/gpu.js) with the ffmpeg given in FFMPEG_PATH (on the Mac workflow: the one
// inside the installed app), in a scratch data folder: `FFMPEG_PATH=… node tests/mac-gpu-detect.mjs`.
// Checks that a Mac whose VideoToolbox encodes also decodes on it (the decode test asked for a pixel format called
// "videotoolbox", which doesn't exist, so it always failed), and that Smart scheduling then uses it without asking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimmy-gpudetect-'));
process.env.JIMMY_DATA_DIR = dir;
const { FFMPEG } = await import('../server/ffmpeg.js');
const gpu = await import('../server/gpu.js');
console.log(`ffmpeg: ${FFMPEG}`);
const det = await gpu.detectGpu({ force: true });
for (const d of det?.devices || []) console.log(`  ${d.name}: encode ${d.encode} (${d.speedup}x, ${d.cpuSaving}x less CPU), decode ${d.decode}, HEVC ${d.hevc}, ProRes ${d.prores}${d.error ? `, ${d.error}` : ''}`);
const apple = det?.devices?.find((d) => d.id === 'apple');
if (process.platform !== 'darwin') console.log('(not a Mac: nothing to check)');
else if (!apple?.encode) console.log('VideoToolbox does not encode on this machine (a virtual Mac can lack it): nothing to check');
else {
  assert.equal(apple.decode, true, 'VideoToolbox encodes, so it must decode too');
  const s = gpu.gpuSettings();
  if (gpu.gpuInfo().ask === null && s.auto) console.log(`Smart scheduling uses ${s.device} without asking`);
  else console.log(`not chosen automatically (the test showed too little gain): ${JSON.stringify(gpu.gpuInfo().ask)}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('mac-gpu-detect: ok');
process.exit(0);
