// The performance recorder: what made Jimmy slow, written down while it happens.
//   - freezes: the server's thread (in the desktop app also the window's: Windows says "Not responding") stuck for
//     50 ms or more, with the code that held it, taken from a light sampling profiler that runs all the time;
//   - every 5 s: CPU (this process and the whole machine), memory, and what is running (exports, chunks, graphics,
//     preview files, pre-rendering, open projects, playback);
//   - events: exports, graphics and preview files starting and ending;
//   - from the editor: long tasks, slow requests and slow clicks (POST /api/perf);
//   - disk traffic: the whole machine's (local disks, and network shares such as a NAS) from the system's own
//     counters (typeperf on Windows, iostat on macOS), and the app's share of it by kind (chunks, proxies,
//     exports, saves written; files served to the editor).
// One JSON line each, in <data>/logs/perf-YYYY-MM-DD.jsonl, kept 7 days. `node bin/perf-report.mjs` sums one up.
// The log lives in the app's data folder on this computer, never next to the footage: a NAS going away doesn't
// take it along. A line that can't be written stays in memory and goes out with the next write.
// Off unless asked for: config.json "perfLog": true or JIMMY_PERFLOG=1 (its 50 Hz freeze check and the profiler
// it starts after a freeze cost the app time themselves). JIMMY_PERFLOG=0 keeps it off either way.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import inspector from 'node:inspector';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const TICK_MS = 20;
const STALL_MS = 50; // a freeze worth writing down
const WINDOW_MS = 15000; // the profiler restarts this often (its samples are read when a freeze fell in the window)
const ARMED_MS = 60000; // it runs this long after a freeze (only then: reading it out is a short freeze itself)
const SAMPLE_US = 4000; // profiler sampling interval
const KEEP_DAYS = 7;
const MAX_BYTES = 200 * 1024 * 1024; // a day's file stops growing past this
const APP_CODE = /[\\/](server|electron)[\\/][^\\/]+\.js/;

// Bytes read and written so far, all disks, from `ioreg -r -c IOBlockStorageDriver`; null when it holds no figures.
export function parseIoreg(text) {
  let r = 0, w = 0, seen = false;
  for (const m of String(text).matchAll(/"Statistics"\s*=\s*\{([^}]*)\}/g)) {
    const read = /"Bytes \(Read\)"\s*=\s*(\d+)/.exec(m[1]), written = /"Bytes \(Write\)"\s*=\s*(\d+)/.exec(m[1]);
    if (!read || !written) continue;
    r += Number(read[1]);
    w += Number(written[1]);
    seen = true;
  }
  return seen ? { r, w } : null;
}

class PerfLog {
  constructor() {
    this.on = false;
    this.lines = [];
    this.stalls = []; // freezes of the current profiler window, not yet written
    this.activity = () => ({});
    this.bytes = {}; // the app's own disk traffic since the last sample, by kind
    this.disk = null; // the machine's, from the system counters: latest bytes/s
  }

  // The app read or wrote this many bytes (kind: chunkW, proxyW, exportW, saveW, servedR ...).
  io(kind, bytes) {
    if (this.on && bytes > 0) this.bytes[kind] = (this.bytes[kind] || 0) + bytes;
  }

  // macOS keeps running totals per disk: asked every 5 s, the difference is the traffic, reads and writes apart.
  // There is no such count for network shares. If ioreg gives nothing, iostat's combined figure is used instead.
  startMacCounters() {
    let last = null;
    const look = () => execFile('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-w', '0'], { maxBuffer: 8 << 20 }, (err, out) => {
      const now = !err && parseIoreg(out);
      if (!now) {
        clearInterval(timer);
        this.macPlain = true;
        this.startDiskCounters(true);
        return;
      }
      const at = Date.now();
      if (last) this.disk = { r: Math.max(0, now.r - last.r) / ((at - last.at) / 1000), w: Math.max(0, now.w - last.w) / ((at - last.at) / 1000) };
      last = { ...now, at };
    });
    const timer = setInterval(look, 5000);
    timer.unref();
    look();
  }

  // The system's disk counters, every 5 s, from a small helper process that runs as long as the app does.
  startDiskCounters(diskOnly = false) {
    if (process.platform === 'darwin' && !this.macPlain) { this.startMacCounters(); return; }
    let cmd, args, parse;
    if (process.platform === 'win32') {
      const c = ['\\PhysicalDisk(_Total)\\Disk Read Bytes/sec', '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec'];
      if (!diskOnly) c.push('\\SMB Client Shares(_Total)\\Read Bytes/sec', '\\SMB Client Shares(_Total)\\Write Bytes/sec');
      cmd = 'typeperf'; args = [...c, '-si', '5', '-sc', '720'];
      // "time","read","write"[,"nas read","nas write"]
      parse = (line) => {
        const v = line.split('","').map((s) => parseFloat(s.replace(/"/g, '')));
        if (v.length < 3 || v.slice(1).some((x) => !Number.isFinite(x))) return null;
        return { r: v[1], w: v[2], ...(v.length >= 5 ? { nasR: v[3], nasW: v[4] } : {}) };
      };
    } else if (process.platform === 'darwin') {
      // per disk: KB/t tps MB/s (reads and writes together): only where ioreg gave no figures (startMacCounters)
      cmd = 'iostat'; args = ['-d', '-w', '5', '-c', '720'];
      parse = (line) => {
        const v = line.trim().split(/\s+/).map(Number);
        if (!v.length || v.length % 3 || v.some((x) => !Number.isFinite(x))) return null;
        let mb = 0;
        for (let i = 2; i < v.length; i += 3) mb += v[i];
        return { rw: mb * 1048576 };
      };
    } else return;
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return; }
    const started = Date.now();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) { const r = parse(l); if (r) this.disk = r; }
    });
    child.on('error', () => {});
    // It stops by itself after an hour (so one left behind by a crash doesn't run for ever) and is started again.
    // The network-share counters are missing on some systems and take it down with them: go on without.
    child.on('exit', () => {
      if (Date.now() - started > 60000) this.startDiskCounters(diskOnly);
      else if (!diskOnly && !this.disk) this.startDiskCounters(true);
    });
    child.unref();
    child.stdout.unref?.();
    if (!this.diskChild) process.on('exit', () => { try { this.diskChild.kill(); } catch { /* gone */ } });
    this.diskChild = child;
  }

  start(dataDir) {
    if (this.on || process.env.JIMMY_PERFLOG === '0') return;
    if (process.env.JIMMY_PERFLOG !== '1' && !this.wanted) return;
    this.on = true;
    this.dir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    this.startDiskCounters();
    this.write({ type: 'start', pid: process.pid, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, ram: os.totalmem(), platform: process.platform, electron: process.versions.electron || null });
    this.eld = monitorEventLoopDelay({ resolution: 10 });
    this.eld.enable();
    this.startProfiler();
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const gap = now - last - TICK_MS;
      if (gap >= STALL_MS) {
        // the recorder's own profiler read-out shows up as a freeze too: marked, and left out of the summaries
        const own = this.ownUntil && last <= this.ownUntil;
        this.stalls.push({ from: last, to: now, ms: Math.round(gap), at: Date.now() - Math.round(gap), own });
        // the profiler runs from the first freeze for ARMED_MS; a calm app isn't profiled at all
        if (!own) this.armedUntil = Date.now() + ARMED_MS;
      }
      last = now;
    }, TICK_MS).unref();
    this.cpu = process.cpuUsage();
    this.sys = sysTimes();
    this.sampledAt = performance.now();
    setInterval(() => this.sample(), 5000).unref();
    setInterval(() => this.rollWindow(), WINDOW_MS).unref();
    setInterval(() => this.flush(), 5000).unref();
    process.on('exit', () => this.flushSync());
  }

  startProfiler() {
    try {
      this.session = new inspector.Session();
      this.session.connect();
      this.session.post('Profiler.enable');
      this.session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
    } catch (err) {
      console.warn('[perf] no profiler:', err.message);
      this.session = null;
    }
    this.profiling = false;
  }

  // Close the profiler's window: when a freeze fell in it, find the code that ran during each one. Then go on
  // profiling while armed (a freeze in the last minute), otherwise stop: it costs nothing while the app is calm.
  rollWindow() {
    const stalls = this.stalls;
    this.stalls = [];
    const armed = Date.now() < (this.armedUntil || 0);
    if (!this.session || (!this.profiling && !armed)) { for (const s of stalls) this.write({ type: 'stall', t: s.at, ms: s.ms, own: s.own || undefined }); return; }
    const t0 = performance.now();
    let profile = null;
    if (this.profiling) this.session.post('Profiler.stop', (err, r) => { if (!err) profile = r.profile; });
    if (armed) this.session.post('Profiler.start');
    this.profiling = armed;
    const cost = performance.now() - t0;
    this.ownUntil = performance.now();
    const top = profile && stalls.length ? attribute(profile, stalls, t0) : [];
    stalls.forEach((s, i) => this.write({ type: 'stall', t: s.at, ms: s.ms, own: s.own || undefined, ...(top[i] || {}) }));
    if (cost > 30) this.write({ type: 'note', t: Date.now(), msg: `profiler restart took ${Math.round(cost)} ms` });
  }

  sample() {
    const now = performance.now();
    const secs = (now - this.sampledAt) / 1000;
    const cpu = process.cpuUsage(this.cpu);
    const sys = sysTimes();
    const busy = sys.busy - this.sys.busy, total = sys.total - this.sys.total;
    this.cpu = process.cpuUsage();
    this.sys = sys;
    this.sampledAt = now;
    const mem = process.memoryUsage();
    let act = {};
    try { act = this.activity(); } catch (err) { act = { error: err.message }; }
    // disk traffic in MB/s: the machine's (r/w local disks, nasR/nasW network shares; rw on macOS) and the app's own
    const mbs = (b) => +(b / 1048576).toFixed(2);
    const io = {};
    if (this.disk) for (const [k, v] of Object.entries(this.disk)) io[k] = mbs(v);
    for (const [k, v] of Object.entries(this.bytes)) io[k] = mbs(v / secs);
    this.bytes = {};
    this.write({
      type: 'sample', t: Date.now(),
      // this process's CPU in cores (1 = one core flat out); the machine's in % of all cores
      cpuMain: +((cpu.user + cpu.system) / 1e6 / secs).toFixed(2),
      cpuAll: total ? Math.round((busy / total) * 100) : null,
      rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
      loopP95: Math.round(this.eld.percentile(95) / 1e6), loopMax: Math.round(this.eld.max / 1e6),
      io, act,
    });
    this.eld.reset();
  }

  event(kind, data = {}) { if (this.on) this.write({ type: 'event', t: Date.now(), kind, ...data }); }

  // what the editor saw: { items: [{ kind: 'longtask'|'fetch'|'click', t, ms, ... }] }
  fromEditor(clientId, items) {
    if (!this.on || !Array.isArray(items)) return;
    for (const it of items.slice(0, 500)) {
      if (!it || typeof it !== 'object') continue;
      this.write({ type: 'ui', client: String(clientId || '').slice(0, 12), kind: String(it.kind || '').slice(0, 20), t: +it.t || Date.now(), ms: Math.round(+it.ms || 0), what: String(it.what || '').slice(0, 600) });
    }
  }

  write(obj) {
    if (!this.on) return;
    this.lines.push(JSON.stringify(obj));
    if (this.lines.length > 5000) this.lines.splice(0, this.lines.length - 5000);
  }

  file() { return path.join(this.dir, `perf-${new Date().toISOString().slice(0, 10)}.jsonl`); }

  flush() {
    if (!this.lines.length || this.flushing) return;
    const lines = this.lines;
    this.lines = [];
    const f = this.file();
    this.flushing = true;
    fsp.mkdir(this.dir, { recursive: true }).then(() => fsp.stat(f)).then((st) => st.size, () => 0)
      .then((size) => (size < MAX_BYTES ? fsp.appendFile(f, `${lines.join('\n')}\n`) : null))
      // not written (disk full, folder locked): keep the lines for the next try, newest 5000 at most
      .catch(() => { this.lines = [...lines, ...this.lines].slice(-5000); })
      .finally(() => { this.flushing = false; });
  }

  flushSync() {
    if (!this.lines.length) return;
    try { fs.appendFileSync(this.file(), `${this.lines.join('\n')}\n`); } catch { /* ignore */ }
    this.lines = [];
  }

  prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const n of fs.readdirSync(this.dir)) {
      if (!/^perf-\d{4}-\d\d-\d\d\.jsonl$/.test(n)) continue;
      const f = path.join(this.dir, n);
      try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

function sysTimes() {
  let busy = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

// For each freeze: the app's own functions (server/, electron/) that were running in it, most samples first, and
// the function at the top of the stack (which may be Node's: JSON.stringify, a sync file call, garbage collection).
function attribute(profile, stalls, stoppedAt) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  // profile times are µs on the profiler's clock: line its end up with when it was stopped
  const offset = stoppedAt - profile.endTime / 1000;
  const times = [];
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) { t += profile.timeDeltas[i]; times.push(t / 1000 + offset); }
  const label = (cf) => `${cf.functionName || '(anonymous)'} ${path.basename(cf.url || '')}${cf.url ? `:${cf.lineNumber + 1}` : ''}`.trim();
  return stalls.map((s) => {
    const app = new Map(), inner = new Map(), leaf = new Map();
    const add = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    let n = 0;
    for (let i = 0; i < times.length; i++) {
      if (times[i] < s.from || times[i] > s.to + SAMPLE_US / 1000) continue;
      n++;
      let id = profile.samples[i];
      const top = nodes.get(id)?.callFrame;
      if (top) add(leaf, label(top));
      const seen = new Set();
      while (id != null) {
        const cf = nodes.get(id)?.callFrame;
        if (cf && APP_CODE.test(cf.url || '') && !/node_modules/.test(cf.url)) {
          const l = label(cf);
          if (!seen.size) add(inner, l); // the app's function nearest the top of the stack
          if (!seen.has(l)) { seen.add(l); add(app, l); }
        }
        id = parent.get(id);
      }
    }
    const best = (m, k = 6) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, v]) => `${f} ×${v}`);
    // inner: where the time went; app: every app function on those stacks (callers too); leaf: the very top
    return { samples: n, inner: best(inner), app: best(app, 10), leaf: best(leaf) };
  });
}

export const perflog = new PerfLog();
