// The macOS disk counters' parser, on sample `ioreg -r -c IOBlockStorageDriver` output (it can run on any system).
//   node tests/mac-disk.mjs
import { parseIoreg } from '../server/perflog.js';

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const disk = (r, w) => `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x1000002c5, registered, matched, active, busy 0 (1 ms), retain 8>
  {
    "IOClass" = "IOBlockStorageDriver"
    "Statistics" = {"Operations (Write)"=120,"Latency Time (Write)"=0,"Bytes (Read)"=${r},"Errors (Write)"=0,"Total Time (Read)"=9,"Operations (Read)"=88,"Bytes (Write)"=${w},"Errors (Read)"=0}
  }
`;
const one = parseIoreg(disk(1000, 500));
ok(one?.r === 1000 && one?.w === 500, 'one disk: reads and writes apart');
const two = parseIoreg(disk(1000, 500) + disk(30, 7));
ok(two?.r === 1030 && two?.w === 507, 'several disks are added up');
ok(parseIoreg('') === null, 'no output: no figures (iostat takes over)');
ok(parseIoreg('"Statistics" = {"Operations (Read)"=3}') === null, 'statistics without bytes: no figures');
// on a Mac: the real ioreg, read twice around some disk writes
if (process.platform === 'darwin') {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const read = () => parseIoreg(execFileSync('ioreg', ['-r', '-c', 'IOBlockStorageDriver'], { encoding: 'utf8', maxBuffer: 16 << 20 }));
  const a = read();
  ok(a && a.r > 0 && a.w > 0, `this Mac's ioreg gives read and write totals (${a?.r} / ${a?.w} bytes)`);
  const f = path.join(os.tmpdir(), `mac-disk-${process.pid}.bin`);
  const fd = fs.openSync(f, 'w');
  fs.writeSync(fd, Buffer.alloc(64 << 20, 7));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.rmSync(f);
  const b = read();
  ok(b && b.w > a.w, `after writing 64 MB the write total went up (${b ? Math.round((b.w - a.w) / 1048576) : '?'} MB)`);
}
console.log(failed ? `mac-disk: ${failed} failed` : 'mac-disk: all checks passed');
process.exit(failed ? 1 : 0);
