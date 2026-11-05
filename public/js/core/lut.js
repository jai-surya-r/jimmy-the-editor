// LUTs (.cube) for the compositor: loaded once per file, applied per layer with WebGL2 (hardware
// trilinear 3D texture) or, where WebGL isn't available (e.g. some headless exports), on the CPU.
// clip.lut = { path, intensity } — path is absolute or relative to the project folder.

const cache = new Map(); // key -> { status: 'loading'|'ready'|'error', lut?, error?, promise }
const listeners = new Set();
export function onLutLoaded(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const lutKey = (projectId, path) => `${projectId}|${path}`;
const lutUrl = (projectId, path) => `/api/lut?project=${encodeURIComponent(projectId || '')}&path=${encodeURIComponent(path)}`;

// Parse a .cube file (3D, or 1D expanded to 3D). Red changes fastest in the data, as in the spec.
export function parseCube(text) {
  let size3 = 0, size1 = 0, dmin = [0, 0, 0], dmax = [1, 1, 1], title = '';
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size3 = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) { size1 = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('LUT_')) continue; // other LUT_* keywords (input ranges)
    const p = line.split(/\s+/);
    if (p.length >= 3 && /^[-+.\deE]/.test(p[0])) vals.push(+p[0], +p[1], +p[2]);
  }
  if (size3) {
    if (vals.length < size3 ** 3 * 3) throw new Error(`LUT data is incomplete (${vals.length / 3} of ${size3 ** 3} entries)`);
    return { size: size3, data: Float32Array.from(vals.slice(0, size3 ** 3 * 3)), dmin, dmax, title };
  }
  if (size1) {
    if (vals.length < size1 * 3) throw new Error('1D LUT data is incomplete');
    const N = 33, data = new Float32Array(N * N * N * 3);
    const look = (ch, x) => { const f = x * (size1 - 1), i = Math.min(size1 - 2, Math.floor(f)), t = f - i; return vals[i * 3 + ch] * (1 - t) + vals[(i + 1) * 3 + ch] * t; };
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const o = (r + g * N + b * N * N) * 3;
      data[o] = look(0, r / (N - 1)); data[o + 1] = look(1, g / (N - 1)); data[o + 2] = look(2, b / (N - 1));
    }
    return { size: N, data, dmin, dmax, title };
  }
  throw new Error('Not a .cube LUT (no LUT_3D_SIZE)');
}

export function loadLut(projectId, path) {
  const key = lutKey(projectId, path);
  let e = cache.get(key);
  if (e) return e.promise;
  e = { status: 'loading' };
  e.promise = fetch(lutUrl(projectId, path)).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `LUT not found (${r.status})`);
    return parseCube(await r.text());
  }).then((lut) => { e.status = 'ready'; e.lut = lut; listeners.forEach((fn) => fn(key)); return lut; },
    (err) => { e.status = 'error'; e.error = err.message; listeners.forEach((fn) => fn(key)); return null; });
  cache.set(key, e);
  return e.promise;
}
export function lutState(projectId, path) { return cache.get(lutKey(projectId, path)) || null; }
export function forgetLut(projectId, path) { cache.delete(lutKey(projectId, path)); }

// Resolve every LUT a sequence uses (the exporter waits for this before the first frame).
export function prepareLutsForSequence(projectId, seq) {
  const paths = [...new Set(seq.clips.filter((c) => c.lut?.path).map((c) => c.lut.path))];
  return Promise.all(paths.map((p) => loadLut(projectId, p)));
}

// ------------------------------------------------------------------ WebGL2 path

let gl = null, glCanvas = null, glProg = null, glFailed = false;
const glLuts = new WeakMap(); // lut -> WebGLTexture
let srcTex = null;

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler3D lut;
uniform float n; uniform float k; uniform vec3 dmin; uniform vec3 dmax;
void main() {
  vec4 c = texture(src, uv);
  vec3 x = clamp((c.rgb - dmin) / (dmax - dmin), 0.0, 1.0);
  vec3 g = texture(lut, x * ((n - 1.0) / n) + 0.5 / n).rgb;
  o = vec4(mix(c.rgb, g, k), c.a);
}`;

function initGl() {
  if (gl || glFailed) return gl;
  try {
    glCanvas = document.createElement('canvas');
    gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
    if (!gl) throw new Error('no webgl2');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    glProg = gl.createProgram();
    gl.attachShader(glProg, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(glProg, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(glProg);
    if (!gl.getProgramParameter(glProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(glProg));
    gl.useProgram(glProg);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(glProg, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(glProg, 'src'), 0);
    gl.uniform1i(gl.getUniformLocation(glProg, 'lut'), 1);
    srcTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
  } catch {
    gl = null; glFailed = true;
  }
  return gl;
}

function glLutTexture(lut) {
  let t = glLuts.get(lut);
  if (t) return t;
  const N = lut.size, bytes = new Uint8Array(N * N * N * 4);
  for (let i = 0, j = 0; i < N * N * N; i++, j += 3) {
    bytes[i * 4] = Math.round(Math.min(1, Math.max(0, lut.data[j])) * 255);
    bytes[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, lut.data[j + 1])) * 255);
    bytes[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, lut.data[j + 2])) * 255);
    bytes[i * 4 + 3] = 255;
  }
  t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
  glLuts.set(lut, t);
  return t;
}

// ------------------------------------------------------------------ CPU fallback

let cpuCanvas = null;
function applyCpu(src, w, h, lut, k) {
  if (!cpuCanvas) cpuCanvas = document.createElement('canvas');
  if (cpuCanvas.width !== w || cpuCanvas.height !== h) { cpuCanvas.width = w; cpuCanvas.height = h; }
  const ctx = cpuCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data, N = lut.size, D = lut.data, M = N - 1, NN = N * N;
  const [r0, g0, b0] = lut.dmin, [r1, g1, b1] = lut.dmax;
  for (let i = 0; i < px.length; i += 4) {
    const r = Math.min(1, Math.max(0, (px[i] / 255 - r0) / (r1 - r0))) * M;
    const g = Math.min(1, Math.max(0, (px[i + 1] / 255 - g0) / (g1 - g0))) * M;
    const b = Math.min(1, Math.max(0, (px[i + 2] / 255 - b0) / (b1 - b0))) * M;
    const ri = Math.min(M - 1, r | 0), gi = Math.min(M - 1, g | 0), bi = Math.min(M - 1, b | 0);
    const fr = r - ri, fg = g - gi, fb = b - bi;
    for (let ch = 0; ch < 3; ch++) {
      const at = (x, y, z) => D[(x + y * N + z * NN) * 3 + ch];
      const c00 = at(ri, gi, bi) * (1 - fr) + at(ri + 1, gi, bi) * fr;
      const c10 = at(ri, gi + 1, bi) * (1 - fr) + at(ri + 1, gi + 1, bi) * fr;
      const c01 = at(ri, gi, bi + 1) * (1 - fr) + at(ri + 1, gi, bi + 1) * fr;
      const c11 = at(ri, gi + 1, bi + 1) * (1 - fr) + at(ri + 1, gi + 1, bi + 1) * fr;
      const v = (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb;
      px[i + ch] = px[i + ch] * (1 - k) + Math.min(1, Math.max(0, v)) * 255 * k;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cpuCanvas;
}

// Returns a drawable with the LUT applied (same pixel size as the source), or the source itself
// when the LUT isn't loaded yet. The result is only valid until the next applyLut call.
export function applyLut(src, lut, intensity = 1) {
  const w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
  const k = Math.min(1, Math.max(0, intensity));
  if (!lut || !w || !h || k <= 0) return src;
  const g = initGl();
  if (!g) return applyCpu(src, w, h, lut, k);
  try {
    if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
    g.viewport(0, 0, w, h);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, srcTex);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
    const t = glLutTexture(lut);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_3D, t);
    g.uniform1f(g.getUniformLocation(glProg, 'n'), lut.size);
    g.uniform1f(g.getUniformLocation(glProg, 'k'), k);
    g.uniform3fv(g.getUniformLocation(glProg, 'dmin'), lut.dmin);
    g.uniform3fv(g.getUniformLocation(glProg, 'dmax'), lut.dmax);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    return glCanvas;
  } catch {
    return applyCpu(src, w, h, lut, k);
  }
}
