// The Mac's Smart scheduling (server/gpu.js, ffmpeg.js, budget.js), on its own: `node tests/mac-scheduling.mjs`.
// Runs anywhere: JIMMY_MAC_SCHEDULER turns the Mac rules on, a fake detection result stands in for Apple's media
// engines, and a scratch data folder holds the settings. A second run without it checks Windows is unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const APPLE = { id: 'apple', name: 'Apple M2', label: 'Apple', encode: true, decode: true, hevc: true, prores: false, speedup: 2.4, cpuSaving: 9 };

if (!process.env.MAC_SCHED_CHILD) {
  const run = (mac) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimmy-macsched-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gpuDetected: { sig: 'test', at: 1, names: ['Apple M2'], devices: [APPLE] } }));
    const r = spawnSync(process.execPath, [self], { encoding: 'utf8', env: { ...process.env, MAC_SCHED_CHILD: mac ? 'mac' : 'win', JIMMY_DATA_DIR: dir, ...(mac ? { JIMMY_MAC_SCHEDULER: '1' } : { JIMMY_MAC_SCHEDULER: '' }) } });
    fs.rmSync(dir, { recursive: true, force: true });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) process.exit(r.status || 1);
  };
  run(true);
  if (process.platform !== 'darwin') run(false);
  console.log('mac-scheduling: ok');
  process.exit(0);
}

const { getConfig, updateConfig } = await import('../server/config.js');
const gpu = await import('../server/gpu.js');
const { renderSlots, perf, macScheduling } = await import('../server/ffmpeg.js');
const { budget } = await import('../server/budget.js');
let playing = false;
budget.userState = () => ({ playing, scrubbing: false });
const base = Math.max(1, Math.min(8, Math.floor(perf().threads / 4), Math.floor(os.totalmem() / (3 * 1024 ** 3))));

if (process.env.MAC_SCHED_CHILD === 'win') {
  // Windows: no automatic GPU, the question is asked, slots as before, no export-first plan
  assert.equal(macScheduling(), false);
  assert.equal(gpu.gpuSettings().device, null);
  assert.equal(gpu.gpuInfo().ask?.id, 'apple');
  assert.equal(renderSlots().slots, base);
  budget.replan();
  assert.equal(budget.info().exportFirst, undefined);
  console.log('  windows: unchanged');
  process.exit(0);
}

// Smart (the default): Apple's engines used without asking; heavy sources decode on them
let s = gpu.gpuSettings();
assert.equal(s.device, 'apple');
assert.equal(s.auto, true);
assert.equal(gpu.gpuInfo().ask, null, 'no question');
let eng = gpu.engineFor('high', 'h264', { width: 1920, height: 1080 });
assert.deepEqual(eng, { enc: 'apple', dec: 'apple' });
assert.deepEqual(gpu.decodePlan({ ...eng }, { codec: 'hevc', width: 3840, height: 2160 }), { hwaccel: 'videotoolbox', cuda: false, qsv: false });
// Settings sending the automatic choice back saves nothing; a real choice is saved
assert.equal(gpu.cleanGpuSettings({ device: 'apple', draft: 'gpu', high: 'gpu', battery: 'gpu', asked: true }), null);
assert.equal(gpu.cleanGpuSettings({ device: null, draft: 'gpu', high: 'gpu', battery: 'gpu' }).device, null);

// render slots: more while exports run on the media engines, the old count while you play
const more = Math.max(1, Math.min(8, Math.floor(perf().threads / 2.5), Math.floor(os.totalmem() / (3 * 1024 ** 3))));
assert.equal(renderSlots().slots, more);
playing = true;
assert.equal(renderSlots().slots, base, 'playing: the old count');
playing = false;

// exports first: the plan says so, Full speed is on until no export is left
budget.demand.export = () => ({ want: 6 });
budget.claudeWorking = () => 1;
budget.noteInput();
budget.replan();
assert.equal(budget.info().exportFirst, true);
assert.equal(budget.info().headroom, Math.max(1, more), JSON.stringify(budget.info()));
playing = true;
budget.replan();
assert.ok(budget.info().slowed.includes('playing'));
budget.setRush(true);
assert.equal(budget.info().rush, true);
assert.equal(budget.info().headroom, base, 'Full speed while playing: every slot of the old count');
budget.demand.export = () => null;
budget.replan();
assert.equal(budget.info().rush, false, 'over once the exports are done');
playing = false;

// a CPU-only choice: back to 4 threads a chunk
await updateConfig({ gpu: { device: null, draft: 'gpu', high: 'gpu', battery: 'gpu', asked: true } });
assert.equal(gpu.gpuSettings().device, null);
assert.equal(renderSlots().slots, base);
// Classic scheduling: as before (the question, no automatic device, no GPU decoding on a Mac, no export-first plan)
await updateConfig({ gpu: {}, scheduler: 'classic' });
assert.equal(gpu.gpuSettings().device, null);
assert.equal(gpu.gpuInfo().ask?.id, 'apple');
assert.equal(renderSlots().slots, base);
await updateConfig({ gpu: { device: 'apple', asked: true } });
assert.deepEqual(gpu.engineFor('high', 'h264', { width: 1920, height: 1080 }), { enc: 'apple', dec: null }, 'Classic: encode as chosen, decode on the CPU as before');
budget.demand.export = () => ({ want: 6 });
budget.replan();
assert.equal(budget.plan, null);
budget.setRush(true);
assert.equal(budget.rush, false, 'no Full speed in Classic');
assert.equal(getConfig().scheduler, 'classic');
console.log('  mac rules: ok');
process.exit(0);
