// A render page's direct line to ffmpeg (desktop app only). The page decodes its clips itself (server/decodestream.js)
// and writes the frames it renders straight to the encoder the server started for the chunk (it listens on a local
// TCP port), so no frame passes through the app's main process or the page's WebSocket: about three times the
// throughput. The server still decides everything (which files, GPU decoding, threads, the encoder) and runs the
// encoder; public/js/render-worker.js uses this when the server's job says so.
const { contextBridge } = require('electron');
const net = require('node:net');

const ffmpeg = (process.argv.find((a) => a.startsWith('--jimmy-ffmpeg=')) || '').slice('--jimmy-ffmpeg='.length);
let DecodeStream = null; // loaded on first use
const streams = new Map(); // clip key -> DecodeStream
let out = null; // { sock, error }
let outGen = 0; // a connection that lands after its job was stopped is dropped

function streamFor(o) {
  DecodeStream ??= require('../server/decodestream.js').DecodeStream;
  let s = streams.get(o.key);
  if (!s || s.w !== o.w || s.h !== o.h || String(s.crop) !== String(o.crop || null)) {
    s?.kill();
    s = new DecodeStream({
      ffmpeg, file: String(o.file), srcStart: +o.srcStart || 0, speed: +o.speed || 1, fps: +o.fps, w: o.w | 0, h: o.h | 0,
      crop: Array.isArray(o.crop) ? o.crop.map((v) => v | 0) : null, threads: o.threads | 0 || 2, hw: o.hw || null, priority: o.priority,
    });
    streams.set(o.key, s);
  }
  return s;
}

function closeOutput() {
  outGen++;
  if (out) { try { out.sock.destroy(); } catch { /* gone */ } }
  out = null;
}

contextBridge.exposeInMainWorld('jimmyDirect', {
  available: !!ffmpeg,
  // the frame (4 spare bytes, then RGBA) as an ArrayBuffer
  async frame(o, index) {
    const buf = await streamFor(o).get(index | 0);
    return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  // start decoding where a clip will first be needed
  prefetch(o, index) { streamFor(o).get(index | 0).catch(() => {}); },
  close(key) { streams.get(key)?.close(); streams.delete(key); },
  closeAll() {
    for (const s of streams.values()) s.close();
    streams.clear();
    closeOutput();
  },
  // the chunk's encoder: it listens on this port of this machine (it may take a moment to start)
  async openOutput(port) {
    closeOutput();
    const gen = outGen;
    const t0 = Date.now();
    for (;;) {
      try {
        const sock = await new Promise((resolve, reject) => {
          const s = net.connect(port | 0, '127.0.0.1');
          s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
          s.once('error', reject);
        });
        if (gen !== outGen) { sock.destroy(); throw Object.assign(new Error('stopped'), { stopped: true }); }
        out = { sock, error: null };
        sock.setNoDelay(true);
        sock.on('error', (err) => { if (out?.sock === sock) out.error = err; });
        return;
      } catch (err) {
        if (err.stopped || gen !== outGen) throw new Error('stopped');
        if (Date.now() - t0 > 30000) throw new Error(`The encoder did not start: ${err.message}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  },
  async write(ab) {
    const o = out;
    if (!o) throw new Error('The encoder is gone');
    if (o.error) throw o.error;
    if (!o.sock.write(Buffer.from(ab))) {
      await new Promise((resolve, reject) => {
        const done = (err) => { o.sock.off('drain', done); o.sock.off('close', gone); err ? reject(err) : resolve(); };
        const gone = () => done(o.error || new Error('The encoder closed its input'));
        o.sock.on('drain', done);
        o.sock.on('close', gone);
      });
    }
  },
  // all frames written: the encoder sees the end of its input and finishes the file
  async endOutput() {
    const o = out;
    out = null;
    if (!o) return;
    await new Promise((resolve) => { o.sock.end(resolve); o.sock.once('error', resolve); });
  },
});
