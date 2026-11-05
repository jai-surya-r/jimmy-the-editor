// One budget for all heavy background work: motion graphics, exports, pre-rendering and preview files.
// Running them together never asks more of the machine than it has, and the person at the keyboard comes
// first. It also backs off by itself when the machine is under pressure, and comes back once it is calm:
//   - memory running low (the usual cause of a machine that hangs: it starts swapping),
//   - the server itself being starved of CPU (its event loop falls behind),
//   - the preview dropping frames while someone plays it,
//   - the CPU being slowed down for heat (Mac),
// and it uses less on battery. Levels: 0 normal, 1 easing off, 2 low on memory (only the essentials run).
import os from 'node:os';
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { renderSlots } from './ffmpeg.js';
import { getConfig } from './config.js';
import { allocate } from './scheduler.js';

const GB = 1024 ** 3;
// memory thresholds: [share of RAM available, bytes available]; the exit ones are higher so it doesn't flap
const ENTER = { 1: [0.15, 1.2 * GB], 2: [0.08, 0.6 * GB] };
const EXIT = { 1: [0.21, 1.7 * GB], 2: [0.11, 0.9 * GB] };
const RAISE_AFTER = 2; // samples (seconds) in a row before backing off more
const CALM_AFTER = 8; // calm samples in a row before stepping back up one level
const LAG_HOLD = 10000; // a stuttering preview keeps it eased off this long

function memLevel(avail, total, t) {
  if (avail == null) return 0;
  const pct = avail / total;
  if (pct < t[2][0] || avail < t[2][1]) return 2;
  if (pct < t[1][0] || avail < t[1][1]) return 1;
  return 0;
}

class Budget {
  constructor() {
    this.level = 0;
    this.reason = '';
    this.listeners = new Set();
    this.lagUntil = 0;
    this.battery = false;
    this.hot = false;
    this.avail = null; // bytes of RAM available to programs
    this.up = 0;
    this.calm = 0;
    this.started = false;
    // what the services are doing right now (they fill these in)
    this.exportsActive = () => false;
    this.motionRunning = () => 0;
    // One graphic and one export at a time, each at full speed (faster than several sharing the machine). An export
    // encoding on the CPU and a graphic take turns, first come first served; one on the GPU runs beside a graphic.
    this.cpuExportBusy = () => false; // an export on the CPU has started and still has frames to render
    this.exportWaitingSince = () => null; // when the next export on the CPU (not started yet) asked for the CPU
    this.motionWaitingSince = () => null; // when the next graphic in the stack asked for it
    this.workListeners = new Set();
    // The scheduler (scheduler.js, Settings › Performance › Scheduling: smart, the default, or classic): what each
    // kind of work is waiting with (the services fill these in), what the person at the keyboard is doing, and the
    // shares it handed out last.
    this.demand = { motion: () => null, export: () => null, media: () => null, prerender: () => null };
    this.userState = () => ({ playing: false, scrubbing: false });
    this.claudeWorking = () => 0; // chats working (chats.js): Claude comes right after you
    this.lastInput = 0;
    this.plan = null;
  }

  smart() { return getConfig().scheduler !== 'classic'; }

  // a click or a key in an editor window
  noteInput() {
    const wasIdle = !this.lastInput || Date.now() - this.lastInput > 20000;
    this.lastInput = Date.now();
    if (wasIdle) this.replan();
  }

  // Hand the machine out again; when the shares change, the services look at what they may run.
  replan() {
    if (!this.smart()) { this.plan = null; return; }
    const demand = {};
    for (const [k, fn] of Object.entries(this.demand)) { try { demand[k] = fn(); } catch { demand[k] = null; } }
    const plan = allocate({
      slots: renderSlots().slots,
      user: { ...this.userState(), lastInput: this.lastInput },
      pressure: { level: this.level, lagging: Date.now() < this.lagUntil || this.starved, battery: this.battery },
      demand,
      claude: this.claudeWorking(),
    });
    const changed = !this.plan || JSON.stringify(plan.shares) !== JSON.stringify(this.plan.shares) || plan.mode !== this.plan.mode
      || plan.claude !== this.plan.claude || plan.held.join() !== this.plan.held.join();
    this.plan = plan;
    if (changed) for (const fn of this.listeners) { try { fn(this.info()); } catch (err) { console.warn('[budget]', err.message); } }
  }
  share(kind) { return this.plan?.shares[kind] ?? 0; }

  // a graphic or an export started, finished or was paused: the other side looks whether it's its turn
  workChanged() {
    if (this.workTimer) return;
    this.workTimer = setImmediate(() => {
      this.workTimer = null;
      this.replan();
      for (const fn of this.workListeners) { try { fn(); } catch (err) { console.warn('[budget]', err.message); } }
    });
  }
  onWork(fn) { this.workListeners.add(fn); return () => this.workListeners.delete(fn); }

  start() {
    if (this.started) return;
    this.started = true;
    this.eld = monitorEventLoopDelay({ resolution: 20 });
    this.eld.enable();
    setInterval(() => this.sample(), 1000).unref();
    if (process.platform === 'darwin') {
      const therm = () => execFile('pmset', ['-g', 'therm'], { timeout: 4000 }, (err, out) => {
        const m = !err && /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out || '');
        this.hot = !!m && Number(m[1]) < 80;
      });
      therm();
      setInterval(therm, 20000).unref();
    }
  }

  // Memory the system can hand out without swapping. Windows and Linux report it as free memory; macOS
  // counts its file cache as used, so ask the kernel for its own "memory available" level instead.
  readMemory() {
    if (process.platform !== 'darwin') { this.avail = os.freemem(); return; }
    execFile('sysctl', ['-n', 'kern.memorystatus_level'], { timeout: 2000 }, (err, out) => {
      const pct = Number(String(out || '').trim());
      this.avail = !err && pct > 0 && pct <= 100 ? (os.totalmem() * pct) / 100 : null;
    });
  }

  sample() {
    this.readMemory();
    const total = os.totalmem();
    const loopLag = this.eld.percentile(95) / 1e6; // ms
    this.eld.reset();
    const lag = Date.now() < this.lagUntil;
    // how far it should back off now, and how far it could come back
    let want = memLevel(this.avail, total, ENTER);
    let reason = want === 2 ? 'memory is very low' : want === 1 ? 'memory is getting low' : '';
    const starved = loopLag > 250;
    this.starved = loopLag > 100;
    this.replan();
    if (want < 1 && (starved || lag || this.hot)) { want = 1; reason = lag ? 'the preview was stuttering' : starved ? 'the computer is overloaded' : 'the computer is running hot'; }
    let calmTo = memLevel(this.avail, total, EXIT);
    if (starved || lag || this.hot) calmTo = Math.max(calmTo, 1);

    if (want > this.level) {
      this.calm = 0;
      if (++this.up >= RAISE_AFTER || want === 2) this.set(want, reason);
    } else {
      this.up = 0;
      if (calmTo < this.level) {
        if (++this.calm >= CALM_AFTER) { this.calm = 0; this.set(this.level - 1, this.level === 1 ? '' : reason || 'memory is getting low'); }
      } else this.calm = 0;
      if (this.level && want === this.level && reason && reason !== this.reason) this.set(this.level, reason);
    }
  }

  set(level, reason) {
    if (level === this.level && reason === this.reason) return;
    const changed = level !== this.level;
    this.level = level;
    this.reason = reason;
    if (changed) console.log(`[budget] ${level ? `backing off (level ${level}): ${reason}` : 'back to normal'}${this.avail != null ? `, ${(this.avail / GB).toFixed(1)} GB free` : ''}`);
    for (const fn of this.listeners) { try { fn(this.info()); } catch (err) { console.warn('[budget]', err.message); } }
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // the editor saw its preview drop frames while playing
  reportLag() {
    this.lagUntil = Date.now() + LAG_HOLD;
    if (this.level < 1) { this.up = RAISE_AFTER; this.sample(); }
  }
  setBattery(v) {
    if (this.battery === !!v) return;
    this.battery = !!v;
    for (const fn of this.listeners) { try { fn(this.info()); } catch (err) { console.warn('[budget]', err.message); } }
  }

  info() {
    const total = this.capacity();
    return {
      level: this.level, reason: this.reason, battery: this.battery, slots: total, full: renderSlots().slots,
      ...(this.plan ? { mode: this.plan.mode, headroom: this.plan.headroom, shares: this.plan.shares, order: this.plan.order, claude: this.plan.claude, held: this.plan.held } : {}),
    };
  }

  // ------------------------------------------------------------ limits

  // Slots for heavy work right now. One slot is one render page (or chunk) with its decoders and encoder.
  capacity() {
    const full = renderSlots().slots;
    const half = Math.max(1, Math.floor(full / 2));
    let n = this.level === 2 ? 1 : this.level === 1 ? half : full;
    if (this.battery) n = Math.min(n, half);
    return n;
  }
  // A graphic gets every slot: an export on the CPU never renders beside it (they take turns).
  // A graphic page uses about one core (a chunk about four), so a graphic gets a third more pages than chunk slots.
  motionSlots() {
    if (this.plan) return Math.max(1, this.share('motion'));
    const n = this.capacity();
    return Math.max(n, Math.floor((n * 4) / 3));
  }
  // One graphic at a time: one at full speed finishes sooner than several sharing the machine.
  motionJobs() {
    return 1;
  }
  // Pages one running motion graphic may use.
  motionPages() {
    return Math.max(1, Math.floor(this.motionSlots() / Math.max(1, this.motionRunning())));
  }
  // Chunks (exports, then pre-rendering) that may render at once, per pool. GPU chunks encode (and decode heavy
  // sources) on the graphics card, so they don't compete with graphics for the CPU: their own slots, bounded by
  // memory and pressure like everything else, one fewer while a graphic renders (they still draw frames).
  chunkSlots(pool = 'cpu') {
    const busy = this.motionRunning();
    const gpuFull = Math.min(4, Math.max(1, Math.floor(os.totalmem() / (3 * GB))));
    // the scheduler's share for exports and pre-rendering, within what the pool can hold (memory: ~3 GB a GPU chunk)
    if (this.plan) return Math.min(pool === 'gpu' ? gpuFull : renderSlots().slots, this.share('export') + this.share('prerender'));
    if (pool === 'gpu') {
      if (this.level === 2 && busy) return 0;
      const full = gpuFull;
      const half = Math.max(1, Math.floor(full / 2));
      let n = this.level === 2 ? 1 : this.level === 1 ? half : full;
      if (this.battery) n = Math.min(n, half);
      return busy ? Math.max(1, n - 1) : n;
    }
    return busy ? 0 : this.capacity(); // a graphic has the CPU: an export on the CPU waits (its chunks pause)
  }
  // Preview files, thumbnails and waveforms.
  mediaJobs(base) {
    // smart: the scheduler's share, up to a quarter of the cores' worth of jobs when nothing renders
    if (this.plan) return Math.max(1, Math.min(this.share('media'), Math.max(base, Math.floor(os.cpus().length / 4))));
    return this.level || this.battery ? 1 : base;
  }
  // Pre-rendering only runs when nothing is under pressure (smart: and while it has a share).
  backgroundAllowed() {
    return this.level === 0 && (!this.plan || this.share('prerender') > 0);
  }
  // You are playing or scrubbing: a graphic that is rendering waits between two frames (smart scheduling).
  motionHeld() {
    return !!this.plan?.held?.includes('motion');
  }
  // A graphic may start (smart: it has a share; it outranks exports, so it does whenever one waits).
  motionMayStart() {
    return this.plan ? this.share('motion') > 0 : null;
  }
}

export const budget = new Budget();
