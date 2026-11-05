// One clip's frames from ffmpeg: decoded, timed to the sequence's frame rate, scaled (and cropped) and handed out
// as RGBA, each frame with 4 spare bytes up front (the render worker puts its request id there). The server uses it
// to send frames to a render page over its WebSocket; the app's own render pages (electron/worker-preload.cjs) use
// it to read ffmpeg themselves, which is about three times faster. Only Node built-ins here: the preload loads it.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HW_UNREADABLE = new Set(); // files the GPU decoder failed on: decoded on the CPU from then on

function fpsRational(fps) {
  const ntsc = [[23.976, '24000/1001'], [29.97, '30000/1001'], [47.952, '48000/1001'], [59.94, '60000/1001'], [119.88, '120000/1001']];
  for (const [f, r] of ntsc) if (Math.abs(fps - f) < 0.01) return r;
  if (Math.abs(fps - Math.round(fps)) < 1e-6) return String(Math.round(fps));
  return `${Math.round(fps * 1000)}/1000`;
}

export class DecodeStream {
  // ffmpeg: the binary; hw: { hwaccel, cuda } from decodePlan, or null for the CPU; priority: Settings ›
  // Performance › priority ('normal', 'low' or 'idle'); crop: [x, y, w, h] of the w × h picture, all that is sent
  constructor({ ffmpeg, file, srcStart, speed, fps, w, h, crop = null, threads = 2, hw = null, priority = 'low' }) {
    Object.assign(this, { ffmpeg, file, srcStart, speed, fps, w, h, crop, threads, priority });
    this.hw = hw && !HW_UNREADABLE.has(file) ? hw : null;
    this.frameSize = (crop ? crop[2] * crop[3] : w * h) * 4;
    this.frames = [];
    this.base = 0;
    this.ended = false;
    this.last = null;
    this.waiters = [];
    this.pending = []; // frame indexes being waited for (several are requested ahead; the same one may be asked for twice)
    this.proc = null;
    this.started = false; // decoding starts at the first frame that is asked for
  }
  spawn(startIndex) {
    this.kill();
    this.started = true;
    this.frames = [];
    this.base = startIndex;
    this.ended = false;
    this.cur = null;
    this.curOff = 0;
    const ss = Math.max(0, this.srcStart + (startIndex * this.speed) / this.fps);
    const timing = `setpts=(PTS-STARTPTS)/${this.speed},fps=${fpsRational(this.fps)}`;
    // NVIDIA: decode and scale on the GPU, bringing back full-resolution colour (more accurate than scaling
    // 4:2:0 on the CPU); other GPUs decode there and the CPU scales.
    const hw = this.hw;
    // cropped after scaling, so the pixels sent are exactly those of the whole picture
    const cut = this.crop ? `,crop=${this.crop[2]}:${this.crop[3]}:${this.crop[0]}:${this.crop[1]}` : '';
    const vf = hw?.cuda
      ? `${timing},scale_cuda=${this.w}:${this.h}:interp_algo=bicubic:format=yuv444p,hwdownload,format=yuv444p${cut},format=rgba`
      : `${timing},scale=${this.w}:${this.h}:flags=bicubic,format=rgba${cut}`;
    const pre = hw ? ['-hwaccel', hw.hwaccel, ...(hw.cuda ? ['-hwaccel_output_format', 'cuda'] : [])] : [];
    const n = String(this.threads);
    const p = spawn(this.ffmpeg, ['-threads', n, '-filter_threads', n, '-v', 'error', ...pre, '-ss', ss.toFixed(6), '-i', this.file,
      '-an', '-sn', '-dn', '-vf', vf, '-f', 'rawvideo', '-threads', n, 'pipe:1'], { windowsHide: true });
    if (p.pid && this.priority !== 'normal') {
      const P = os.constants.priority;
      try { os.setPriority(p.pid, this.priority === 'idle' ? P.PRIORITY_LOW : P.PRIORITY_BELOW_NORMAL); } catch { /* already gone */ }
    }
    this.proc = p;
    let got = false;
    p.stdout.on('data', (chunk) => { got = true; this.onData(p, chunk); });
    p.stderr.on('data', (d) => { this.stderr = ((this.stderr || '') + d).slice(-4000); });
    p.on('close', (code) => {
      if (this.proc !== p) return;
      // the GPU could not read this file (a codec or profile it doesn't support): the CPU decodes it instead
      if (hw && !got && code !== 0) {
        HW_UNREADABLE.add(this.file);
        console.warn(`[render] GPU decoding failed for ${path.basename(this.file)}; using the CPU: ${(this.stderr || '').trim().split('\n').pop()}`);
        this.hw = null;
        this.proc = null;
        this.spawn(startIndex);
        return;
      }
      this.ended = true;
      this.notify();
    });
    p.on('error', () => { if (this.proc === p) { this.ended = true; this.notify(); } });
  }
  onData(p, chunk) {
    if (this.proc !== p) return;
    let off = 0;
    while (off < chunk.length) {
      if (!this.cur) { this.cur = Buffer.allocUnsafeSlow(4 + this.frameSize); this.curOff = 4; }
      const n = Math.min(chunk.length - off, this.cur.length - this.curOff);
      chunk.copy(this.cur, this.curOff, off, off + n);
      this.curOff += n;
      off += n;
      if (this.curOff === this.cur.length) {
        this.frames.push(this.cur);
        this.last = this.cur;
        this.cur = null;
      }
    }
    if (this.frames.length > 6) p.stdout.pause();
    this.notify();
  }
  notify() {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }
  async get(index) {
    this.pending.push(index);
    try {
      for (;;) {
        // everything is decided from the lowest frame still wanted, so requests may overlap in any order
        const lowest = Math.min(...this.pending);
        // behind us, or far ahead: restart there instead of decoding everything in between
        if (!this.started || lowest < this.base || lowest - (this.base + this.frames.length) > this.fps * 5) this.spawn(lowest);
        const drop = Math.min(lowest - this.base, this.frames.length);
        if (drop > 0) { this.frames.splice(0, drop); this.base += drop; }
        const at = index - this.base;
        if (at < this.frames.length) {
          if (this.frames.length < 4 && this.proc?.stdout.isPaused()) this.proc.stdout.resume();
          return this.frames[at];
        }
        // hold the last frame past the end of the media
        if (this.ended) return this.frames[this.frames.length - 1] || this.last || Buffer.alloc(4 + this.frameSize);
        if (this.proc?.stdout.isPaused()) this.proc.stdout.resume();
        await new Promise((r) => this.waiters.push(r));
      }
    } finally {
      this.pending.splice(this.pending.indexOf(index), 1);
    }
  }
  // done with it: anything still waiting gets an empty frame
  close() {
    this.kill();
    this.started = true;
    this.ended = true;
    this.notify();
  }
  kill() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}
