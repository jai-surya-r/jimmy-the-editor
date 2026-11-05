// The maths of audio sync, in a worker thread so the server's main thread never waits on it (server/audiosync.js).
// Two jobs:
//   coarse: cross-correlate two onset envelopes (200 per second): where sounds start lines up whatever the mics and
//           levels; gives the lag to ±5 ms over the whole length of both recordings.
//   fine:   GCC-PHAT (phase transform, weighted) of two 48 kHz windows that the coarse lag has already lined up; a sharp
//           peak within a small search range, refined between samples by a parabola.
import { parentPort } from 'node:worker_threads';

// in-place iterative radix-2 complex FFT (inverse: conjugate, FFT, conjugate, scale)
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
const normalize = (x) => {
  let m = 0; for (const v of x) m += v; m /= x.length || 1;
  let s = 0; for (const v of x) s += (v - m) ** 2; s = Math.sqrt(s / (x.length || 1)) || 1;
  const out = new Float64Array(x.length); for (let i = 0; i < x.length; i++) out[i] = (x[i] - m) / s; return out;
};

// Correlation of b against a for every lag: corr[k] = sum a[n]·b[n+k] (k may be negative). phat: weight β.
function correlate(a, b, phat = 0) {
  const n = pow2(a.length + b.length);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) {
    // conj(A)·B
    let r = ar[i] * br[i] + ai[i] * bi[i];
    let im = ar[i] * bi[i] - ai[i] * br[i];
    if (phat) { const m = Math.hypot(r, im) ** phat || 1; r /= m; im /= m; }
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  return { corr: ar, n }; // lag k ≥ 0 at index k, lag k < 0 at index n + k
}
const at = (c, n, k) => c[k >= 0 ? k : n + k];

// best lag in [lo, hi], its value, and how far it stands above the next best peak (outside ±guard)
function peak(corr, n, lo, hi, guard) {
  let best = -Infinity, bk = 0;
  for (let k = lo; k <= hi; k++) { const v = at(corr, n, k); if (v > best) { best = v; bk = k; } }
  let second = -Infinity;
  for (let k = lo; k <= hi; k++) if (Math.abs(k - bk) > guard) second = Math.max(second, at(corr, n, k));
  // parabola through the peak and its neighbours: where between the samples the true peak is
  const y0 = at(corr, n, bk - 1), y1 = best, y2 = at(corr, n, bk + 1);
  const den = y0 - 2 * y1 + y2;
  const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  return { lag: bk + frac, value: best, ratio: second > 0 ? best / second : Infinity };
}

parentPort.on('message', ({ id, job, a, b, lo, hi, guard, phat }) => {
  try {
    const A = normalize(a), B = normalize(b);
    const { corr, n } = correlate(A, B, phat || 0);
    const r = peak(corr, n, Math.max(lo ?? -(A.length - 1), -(n - 1)), Math.min(hi ?? (B.length - 1), n - 1), guard || 1);
    parentPort.postMessage({ id, ok: true, job, ...r });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
