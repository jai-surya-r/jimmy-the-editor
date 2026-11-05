// Jimmy motion runtime. Injected at the top of every motion-graphic HTML page the editor serves,
// before the page's own scripts. It replaces the page's clock with a virtual one so any animation —
// CSS animations/transitions, Web Animations, GSAP, anime.js, Lottie, canvas/three.js loops driven by
// requestAnimationFrame, setTimeout chains — can be rendered frame by frame, exactly and repeatably.
//
// What a composition can use (all optional):
//   motion.params            values from the editor's Inspector (merged over the defaults the page declares)
//   motion.width / height / fps / duration
//   motion.onSeek(fn)        fn(timeSeconds) is called for every frame — draw the frame for that time
//   motion.timeline = tl     a GSAP timeline (or anything with seek()/pause()) to drive by absolute time
//   motion.wait(promise)     hold rendering until something async is ready (images, fonts, data)
// Elements with data-param="key" get that param as their text; every param is also a CSS variable --key.
(() => {
  if (window.__motion) return;
  const cfg = window.__MOTION_CFG__ || {};
  const mode = cfg.mode || 'live'; // render | preview | live
  const fps = cfg.fps > 0 ? cfg.fps : 30;
  const frameMs = 1000 / fps;
  const real = {
    raf: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    now: performance.now.bind(performance),
    Date: window.Date,
  };

  // ------------------------------------------------------------ virtual clock
  let now = 0; // virtual ms since the composition started
  let stepIndex = 0; // whole frames already stepped (frame-exact times avoid float drift)
  const epoch = real.Date.now();
  const rafs = new Map();
  let rafSeq = 0;
  const timers = new Map();
  let timerSeq = 0;

  window.requestAnimationFrame = (cb) => { rafs.set(++rafSeq, cb); return rafSeq; };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  window.setTimeout = (fn, ms, ...args) => {
    const id = ++timerSeq;
    timers.set(id, { fn, args, due: now + Math.max(0, Number(ms) || 0), every: 0 });
    return id;
  };
  window.setInterval = (fn, ms, ...args) => {
    const id = ++timerSeq;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { fn, args, due: now + every, every });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  try { performance.now = () => now; } catch { /* read-only in some engines */ }
  function VDate(...a) {
    if (!new.target) return new real.Date(epoch + now).toString();
    return a.length ? new real.Date(...a) : new real.Date(epoch + now);
  }
  VDate.prototype = real.Date.prototype;
  VDate.now = () => epoch + now;
  VDate.parse = real.Date.parse;
  VDate.UTC = real.Date.UTC;
  window.Date = VDate;

  // Same random numbers on every run (and in every parallel render page).
  let seed = (Number(cfg.seed) || 0x9e3779b9) >>> 0;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function runTimersUntil(limit) {
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const [id, tm] of timers) if (tm.due <= limit && (!next || tm.due < next[1].due || (tm.due === next[1].due && id < next[0]))) next = [id, tm];
      if (!next) return;
      const [id, tm] = next;
      now = Math.max(now, tm.due);
      if (tm.every) tm.due += tm.every; else timers.delete(id);
      try { typeof tm.fn === 'function' ? tm.fn(...tm.args) : (0, eval)(String(tm.fn)); } catch (e) { report(e); }
    }
  }
  function runRaf() {
    const cbs = [...rafs.values()];
    rafs.clear();
    for (const cb of cbs) { try { cb(now); } catch (e) { report(e); } }
  }

  // CSS animations/transitions and Web Animations run on the document timeline (real time):
  // pause each one and set its time from the virtual clock, counted from when it first appeared.
  const births = new WeakMap();
  function syncAnimations() {
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      if (!births.has(a)) births.set(a, now);
      try { a.pause(); a.currentTime = Math.max(0, now - births.get(a)); } catch { /* ignore */ }
    }
  }
  async function syncMedia(t) {
    const els = [...document.querySelectorAll('video, audio')];
    await Promise.all(els.map((el) => new Promise((resolve) => {
      const start = parseFloat(el.dataset.start || '0') || 0;
      const target = Math.max(0, t - start);
      el.muted = true;
      try { el.pause(); } catch { /* ignore */ }
      if (Math.abs(el.currentTime - target) < 0.5 / fps) { resolve(); return; }
      const done = () => { el.removeEventListener('seeked', done); resolve(); };
      el.addEventListener('seeked', done);
      real.setTimeout(done, 3000);
      try { el.currentTime = target; } catch { done(); }
    })));
  }

  // ------------------------------------------------------------ public API
  const waits = [];
  const errors = [];
  const motion = window.motion = {
    mode,
    params: { ...(cfg.params || {}) },
    width: cfg.width || 1920,
    height: cfg.height || 1080,
    fps,
    duration: cfg.duration || 5,
    time: 0,
    frame: 0,
    timeline: null,
    _seekers: [],
    onSeek(fn) { if (typeof fn === 'function') this._seekers.push(fn); return this; },
    wait(p) { const pr = Promise.resolve(p).catch(report); waits.push(pr); return p; },
    param(key, fallback) { return key in this.params ? this.params[key] : fallback; },
  };

  function report(e) {
    const msg = String(e?.stack || e?.message || e);
    if (errors.length < 20) errors.push(msg);
    if (mode === 'preview') try { parent.postMessage({ type: 'motion-error', message: String(e?.message || e) }, '*'); } catch { /* ignore */ }
  }
  window.addEventListener('error', (e) => report(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason));

  function applyParams() {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(motion.params)) {
      if (v == null || typeof v === 'object') continue;
      try { root.style.setProperty(`--${k}`, String(v)); } catch { /* ignore */ }
    }
    for (const el of document.querySelectorAll('[data-param]')) {
      const v = motion.params[el.dataset.param];
      if (v != null) el.textContent = String(v);
    }
    // data-param-src="logo" → src attribute, data-param-href, data-param-fill …
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        if (!attr.startsWith('data-param-')) continue;
        const v = motion.params[el.getAttribute(attr)];
        if (v != null) el.setAttribute(attr.slice(11), String(v));
      }
    }
  }

  const seekable = () => motion._seekers.length > 0 || !!motion.timeline;
  let ready = null;
  let gsapRoot = null;

  // t: the page's own time; editT: the clip's time, for the Motion tab's edits (differs when its timing is changed)
  async function seek(t, editT = t) {
    t = Math.max(0, Number(t) || 0);
    applyAnims();
    const target = t * 1000;
    if (target + 1e-6 < now) {
      // Going back: absolute hooks can draw any time; loop-driven state can't be rewound.
      now = target;
      stepIndex = Math.floor(target / frameMs + 1e-6);
    }
    // Step whole frames up to the target so rAF loops and timers see every frame, like real playback.
    const lastStep = Math.floor(target / frameMs + 1e-6);
    while (stepIndex < lastStep) {
      stepIndex++;
      const at = stepIndex * frameMs;
      runTimersUntil(at);
      now = at;
      runRaf();
      syncAnimations();
    }
    if (now !== target) { runTimersUntil(target); now = target; }
    runRaf();
    syncAnimations();
    motion.time = t;
    motion.frame = Math.round(t * fps);
    const tl = motion.timeline;
    if (tl) {
      try {
        tl.pause?.();
        if (typeof tl.seek === 'function') tl.seek(t, false);
        else if (typeof tl.time === 'function') tl.time(t);
        else if (typeof tl.goToAndStop === 'function') tl.goToAndStop(t * 1000, false); // lottie-web
      } catch (e) { report(e); }
    }
    for (const fn of motion._seekers) { try { await fn(t); } catch (e) { report(e); } }
    await syncMedia(t);
    curT = editT;
    try { applyEdit(editT); } catch (e) { report(e); }
    if (waits.length) await Promise.all(waits.splice(0));
    void document.body?.offsetHeight; // flush layout
  }

  function whenLoaded() {
    return document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => window.addEventListener('load', r, { once: true }));
  }

  async function init() {
    await whenLoaded();
    applyParams();
    try { await document.fonts?.ready; } catch { /* ignore */ }
    // let setTimeout(…, 0) initialisation and the first rAF run before anything else
    runTimersUntil(0);
    runRaf();
    if (waits.length) await Promise.all(waits.splice(0));
    const g = window.gsap;
    if (g?.ticker) {
      try { g.ticker.lagSmoothing(0); } catch { /* ignore */ }
      // No explicit timeline: drive every GSAP animation created so far by absolute time (seekable both ways).
      if (!motion.timeline && typeof g.exportRoot === 'function') {
        try { gsapRoot = g.exportRoot(); gsapRoot.pause(); motion.timeline = gsapRoot; } catch (e) { report(e); }
      }
    }
    await seek(pageTime(0), 0);
    return info();
  }
  function info() {
    return { width: motion.width, height: motion.height, fps, duration: motion.duration, seekable: seekable(), errors: errors.slice() };
  }

  window.__motion = {
    ready: () => (ready ||= init()),
    seek: async (t) => { await (ready ||= init()); await seek(pageTime(t), t); return errors.length; },
    info,
    errors: () => errors.slice(),
  };

  // ------------------------------------------------------------ Motion tab edits
  // The user's adjustments from the editor's Motion tab (cfg.edit), applied over the page after every frame,
  // so preview and render match and the HTML stays as Claude wrote it:
  //   layers  { [selector]: { props: { x, y, scale, rotation, opacity, blur, color, bg, stroke, fontSize,
  //             fontWeight, fontFamily, letterSpacing, text }, hidden, removed } }   changes to the page's own elements
  //             (removed: deleted in the Motion tab — never drawn, and the other elements stay where they are)
  //   added   [{ id, type: text|rect|ellipse|image, name, start, end, hidden, props }]   layers drawn on top
  //   timing  { offset, speed }   page time = max(0, t − offset) × speed
  //   vars    { '--accent': '#fff' }   CSS variables;  anims { key: { delay, duration } }   animation timings
  // A prop is a value or keyframes { k: [[t, value, ease], …] } (ease: linear | ease | in | out | hold).
  let edit = cfg.edit || null;
  let curT = 0;
  let frameNo = 0;
  function pageTime(t) {
    const tm = edit?.timing;
    if (!tm) return t;
    return Math.max(0, t - (Number(tm.offset) || 0)) * (Number(tm.speed) > 0 ? Number(tm.speed) : 1);
  }

  const EASE = { linear: (x) => x, ease: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2), in: (x) => x * x * x, out: (x) => 1 - (1 - x) ** 3 };
  function rgba(c) {
    const s = String(c).trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map((x) => x + x).join('');
      return [0, 2, 4, 6].map((i, j) => (j === 3 ? (h.length > 6 ? parseInt(h.slice(6, 8), 16) / 255 : 1) : parseInt(h.slice(i, i + 2), 16)));
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    return null;
  }
  function mix(a, b, p) {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
    if (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && a !== '' && b !== '') return Number(a) + (Number(b) - Number(a)) * p;
    const ca = rgba(a), cb = rgba(b);
    if (ca && cb) { const v = ca.map((x, i) => x + (cb[i] - x) * p); return `rgba(${Math.round(v[0])}, ${Math.round(v[1])}, ${Math.round(v[2])}, ${v[3].toFixed(3)})`; }
    return p < 1 ? a : b;
  }
  function valAt(v, t) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.k)) return v;
    const k = v.k;
    if (!k.length) return undefined;
    if (t <= k[0][0]) return k[0][1];
    for (let i = 0; i < k.length - 1; i++) {
      const [t0, v0, e] = k[i];
      const [t1, v1] = k[i + 1];
      if (t < t1) return e === 'hold' ? v0 : mix(v0, v1, (EASE[e] || EASE.linear)((t - t0) / (t1 - t0 || 1)));
    }
    return k[k.length - 1][1];
  }

  // Each changed style property remembers the page's own value, so the change is applied on top of whatever
  // the page sets that frame (and undone when the user removes it). !important also beats CSS animations.
  const tracked = new Map(); // element -> Map(prop -> { base, applied, frame })
  function setProp(el, prop, fn) {
    let m = tracked.get(el);
    if (!m) tracked.set(el, (m = new Map()));
    const tr = m.get(prop);
    if (prop === '#text') {
      const cur = el.textContent;
      const base = tr && cur === tr.applied ? tr.base : cur;
      const v = fn(base);
      if (cur !== v) el.textContent = v;
      m.set(prop, { base, applied: v, frame: frameNo });
      return;
    }
    const cur = el.style.getPropertyValue(prop);
    const base = tr && cur === tr.applied ? tr.base : cur;
    if (base) el.style.setProperty(prop, base); else el.style.removeProperty(prop);
    el.style.setProperty(prop, fn(getComputedStyle(el).getPropertyValue(prop)), 'important');
    m.set(prop, { base, applied: el.style.getPropertyValue(prop), frame: frameNo });
  }
  function restoreUntouched() {
    for (const [el, m] of tracked) {
      for (const [prop, tr] of m) {
        if (tr.frame === frameNo) continue;
        if (prop === '#text') { if (el.textContent === tr.applied) el.textContent = tr.base; }
        else if (el.style.getPropertyValue(prop) === tr.applied) { if (tr.base) el.style.setProperty(prop, tr.base); else el.style.removeProperty(prop); }
        m.delete(prop);
      }
      if (!m.size) tracked.delete(el);
    }
  }

  function applyLayer(el, P, t, hidden, removed) {
    const g = (k) => valAt(P[k], t);
    const has = (k) => P[k] != null && P[k] !== '';
    const svg = el instanceof SVGElement;
    if (has('x') || has('y')) setProp(el, 'translate', () => `${Number(g('x')) || 0}px ${Number(g('y')) || 0}px`);
    if (has('rotation')) setProp(el, 'rotate', () => `${Number(g('rotation')) || 0}deg`);
    if (has('scale')) setProp(el, 'scale', () => String(Number(g('scale')) ?? 1));
    if (svg && (has('rotation') || has('scale'))) { setProp(el, 'transform-box', () => 'fill-box'); setProp(el, 'transform-origin', () => 'center'); }
    if (has('opacity')) setProp(el, 'opacity', (b) => String((b === '' ? 1 : Number(b)) * Number(g('opacity'))));
    if (has('blur')) setProp(el, 'filter', (b) => `${b && b !== 'none' ? `${b} ` : ''}blur(${Number(g('blur')) || 0}px)`);
    if (has('color')) setProp(el, svg ? 'fill' : 'color', () => String(g('color')));
    if (has('bg')) setProp(el, 'background', () => String(g('bg')));
    if (has('stroke')) setProp(el, 'stroke', () => String(g('stroke')));
    if (has('fontSize')) setProp(el, 'font-size', () => `${Number(g('fontSize'))}px`);
    if (has('fontWeight')) setProp(el, 'font-weight', () => String(g('fontWeight')));
    if (has('fontFamily')) setProp(el, 'font-family', () => String(g('fontFamily')));
    if (has('letterSpacing')) setProp(el, 'letter-spacing', () => `${Number(g('letterSpacing'))}px`);
    if (hidden || removed) setProp(el, 'visibility', () => 'hidden');
    if (removed) setProp(el, 'opacity', () => '0'); // its children too, even one that sets its own visibility
    if (has('text') && !el.children.length) setProp(el, '#text', () => String(g('text')));
  }

  // layers the user added on top of the page
  let layerRoot = null;
  const layerEls = new Map();
  function applyAdded(t) {
    const list = edit?.added || [];
    if (!list.length && !layerRoot) return;
    if (!layerRoot) {
      layerRoot = document.createElement('div');
      layerRoot.id = '__pip_layers';
      Object.assign(layerRoot.style, { position: 'fixed', left: '0', top: '0', width: `${motion.width}px`, height: `${motion.height}px`, pointerEvents: 'none', zIndex: '2147483647', overflow: 'hidden' });
      document.body.appendChild(layerRoot);
    }
    const ids = new Set();
    for (const L of list) {
      ids.add(L.id);
      const tag = L.type === 'image' ? 'img' : 'div';
      let el = layerEls.get(L.id);
      if (!el || el.tagName.toLowerCase() !== tag) { el?.remove(); el = document.createElement(tag); el.dataset.pipLayer = L.id; layerEls.set(L.id, el); }
      layerRoot.appendChild(el); // keeps the list's stacking order (later = on top)
      const P = L.props || {};
      const g = (k, d) => { const v = valAt(P[k], t); return v == null || v === '' ? d : v; };
      const s = el.style;
      const on = !L.hidden && t >= (Number(L.start) || 0) && t < (L.end == null ? Infinity : Number(L.end));
      s.position = 'absolute';
      s.display = on ? 'block' : 'none';
      if (!on) continue;
      s.left = `${Number(g('x', motion.width / 2))}px`;
      s.top = `${Number(g('y', motion.height / 2))}px`;
      s.transform = `translate(-50%, -50%) rotate(${Number(g('rotation', 0))}deg) scale(${Number(g('scale', 1))})`;
      s.opacity = String(Number(g('opacity', 1)));
      s.filter = Number(g('blur', 0)) ? `blur(${Number(g('blur', 0))}px)` : '';
      s.boxSizing = 'border-box';
      s.borderRadius = L.type === 'ellipse' ? '50%' : `${Number(g('radius', 0))}px`;
      const sw = Number(g('strokeWidth', 0));
      s.border = sw ? `${sw}px solid ${g('stroke', '#ffffff')}` : 'none';
      if (L.type === 'text') {
        const txt = String(g('text', 'Text'));
        if (el.textContent !== txt) el.textContent = txt;
        Object.assign(s, { color: g('color', '#ffffff'), fontSize: `${Number(g('fontSize', 80))}px`, fontFamily: g('fontFamily', 'Inter, Arial, sans-serif'),
          fontWeight: String(g('fontWeight', 700)), letterSpacing: `${Number(g('letterSpacing', 0))}px`, lineHeight: '1.15', whiteSpace: 'pre',
          textAlign: g('align', 'center'), background: g('bg', 'transparent'), padding: `${Number(g('padding', 0))}px`, width: '', height: '' });
      } else if (L.type === 'image') {
        const src = String(g('src', ''));
        const url = !src ? '' : /^(https?:|data:|\/)/.test(src) ? src : `${cfg.base || ''}${src.split('/').map(encodeURIComponent).join('/')}`;
        if (el.getAttribute('src') !== url) {
          el.setAttribute('src', url);
          if (url) waits.push(new Promise((r) => { el.onload = el.onerror = r; real.setTimeout(r, 5000); }));
        }
        s.width = `${Number(g('w', 400))}px`;
        s.height = 'auto';
      } else {
        s.width = `${Number(g('w', 400))}px`;
        s.height = `${Number(g('h', 200))}px`;
        s.background = g('color', '#7c5cff');
      }
    }
    for (const [id, el] of layerEls) if (!ids.has(id)) { el.remove(); layerEls.delete(id); }
  }

  const rootVars = new Set();
  function applyEdit(t) {
    frameNo++;
    // Google fonts picked in the Motion tab (the editor passes their stylesheet URLs)
    for (const u of edit?.fonts || []) {
      if (document.querySelector(`link[data-pip-font="${CSS.escape(u)}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = u;
      l.dataset.pipFont = u;
      waits.push(new Promise((r) => { l.onload = () => real.setTimeout(() => document.fonts.ready.then(r, r), 0); l.onerror = r; real.setTimeout(r, 5000); }));
      document.head.appendChild(l);
    }
    const vars = edit?.vars || {};
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) { try { root.style.setProperty(k, String(valAt(v, t))); rootVars.add(k); } catch { /* bad name */ } }
    for (const k of [...rootVars]) if (!(k in vars)) { root.style.removeProperty(k); rootVars.delete(k); }
    for (const [sel, L] of Object.entries(edit?.layers || {})) {
      let el = null;
      try { el = document.querySelector(sel); } catch { /* bad selector */ }
      if (el) applyLayer(el, L.props || {}, t, L.hidden, L.removed);
    }
    restoreUntouched();
    applyAdded(t);
  }

  // CSS animations/transitions, Web Animations and GSAP tweens the page made: listed in the Motion tab, and
  // their start and length can be changed there.
  const animOrig = new Map();
  function listAnims() {
    const out = [];
    try {
      document.getAnimations().forEach((a, i) => {
        const tg = a.effect?.target;
        const name = a.animationName || a.transitionProperty || a.id || 'animation';
        const kind = a.animationName ? 'css' : a.transitionProperty ? 'transition' : 'web';
        const tm = a.effect?.getTiming?.() || {};
        out.push({ key: `${kind}:${name}:${tg ? selectorOf(tg) : i}`, kind, name, target: tg ? labelOf(tg) : '', delay: (Number(tm.delay) || 0) / 1000, duration: (Number(tm.duration) || 0) / 1000, a });
      });
    } catch { /* not supported */ }
    const tl = motion.timeline;
    if (tl?.getChildren) {
      try {
        tl.getChildren(true, true, false).forEach((tw, i) => {
          const tg = (tw.targets?.() || [])[0];
          const props = Object.keys(tw.vars || {}).filter((k) => !/^(duration|delay|ease|on[A-Z]\w*|stagger|repeat|repeatDelay|yoyo|immediateRender|overwrite|id|callbackScope|paused)$/.test(k));
          out.push({ key: `gsap:${i}`, kind: 'gsap', name: props.slice(0, 4).join(', ') || 'tween', target: tg?.nodeType === 1 ? labelOf(tg) : '', delay: tw.startTime(), duration: tw.duration(), tw });
        });
      } catch { /* not GSAP 3 */ }
    }
    for (const x of out) if (!animOrig.has(x.key)) animOrig.set(x.key, { delay: x.delay, duration: x.duration });
    return out;
  }
  function applyAnims() {
    const want = edit?.anims;
    if (!want && !animOrig.size) return;
    if (!want || !Object.keys(want).length) { if (![...animOrig.values()].some((o) => o.changed)) return; }
    for (const x of listAnims()) {
      const o = animOrig.get(x.key);
      const w = want?.[x.key] || {};
      const delay = w.delay ?? o.delay, duration = w.duration ?? o.duration;
      if (Math.abs(delay - x.delay) < 1e-6 && Math.abs(duration - x.duration) < 1e-6) continue;
      o.changed = true;
      try {
        if (x.a) x.a.effect.updateTiming({ delay: delay * 1000, duration: Math.max(1, duration * 1000) });
        else if (x.tw) { x.tw.startTime(delay); x.tw.duration(Math.max(0.001, duration)); }
      } catch (e) { report(e); }
    }
  }

  // ------------------------------------------------------------ element info for the Motion tab
  function selectorOf(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el === document.body) { parts.unshift('body'); break; }
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll(`#${el.id}`).length === 1) { parts.unshift(`#${el.id}`); break; }
      const p = el.parentElement;
      parts.unshift(`*:nth-child(${p ? [...p.children].indexOf(el) + 1 : 1})`);
      el = p;
    }
    return parts.join(' > ');
  }
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  function labelOf(el) {
    const txt = ownText(el) || (el.children.length ? '' : (el.textContent || '').trim());
    if (txt) return `“${txt.replace(/\s+/g, ' ').slice(0, 28)}”`;
    if (el.id) return `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : el.getAttribute('class')?.split(/\s+/)[0];
    return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
  }
  function inspect() {
    const out = [];
    const walk = (el, depth) => {
      for (const c of el.children) {
        if (out.length >= 800) return;
        if (c === layerRoot || /^(script|style|link|meta|template|noscript|defs|title)$/i.test(c.tagName)) continue;
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        const tag = c.tagName.toLowerCase();
        const txt = ownText(c);
        const kind = txt ? 'text' : tag === 'img' || tag === 'image' ? 'image' : tag === 'svg' ? 'svg' : tag === 'canvas' ? 'canvas' : tag === 'video' ? 'video' : c.children.length ? 'group' : 'shape';
        const cls = typeof c.className === 'string' ? c.className : c.getAttribute('class') || '';
        const src = kind === 'image' ? String(c.getAttribute('src') || c.getAttribute('href') || '').split(/[?#]/)[0].split('/').pop() : '';
        out.push({ sel: selectorOf(c), depth, tag, kind, label: labelOf(c), id: c.id || '', cls: cls.trim().split(/\s+/)[0] || '', src, text: c.children.length ? null : (c.textContent || ''), svg: c instanceof SVGElement,
          visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01, box: [r.x, r.y, r.width, r.height] });
        walk(c, depth + 1);
      }
    };
    if (document.body) walk(document.body, 0);
    return out;
  }
  function pick(x, y) {
    const st = document.createElement('style');
    st.textContent = '*{pointer-events:auto!important}';
    document.head.appendChild(st);
    let els = [];
    try { els = document.elementsFromPoint(x, y); } finally { st.remove(); }
    for (const el of els) {
      const lay = el.closest?.('[data-pip-layer]');
      if (lay) return { added: lay.dataset.pipLayer };
      if (el === document.documentElement || el === document.body || el === layerRoot) continue;
      return { sel: selectorOf(el) };
    }
    return null;
  }
  let selected = null;
  function boxOf(s) {
    let el = null;
    if (s?.added) el = layerEls.get(s.added);
    else if (s?.sel) { try { el = document.querySelector(s.sel); } catch { /* bad selector */ } }
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  }

  // ------------------------------------------------------------ preview (editor iframe) and live modes
  if (mode === 'preview') {
    let busy = false, pending = null;
    const post = (m) => parent.postMessage(m, '*');
    const pump = async () => {
      if (busy || pending == null) return;
      busy = true;
      const t = pending;
      pending = null;
      try {
        if (pageTime(t) * 1000 + 1e-6 < now && !seekable() && now > 0) {
          // can't rewind this composition: reload and fast-forward to the requested time
          location.hash = `t=${t}`;
          location.reload();
          return;
        }
        await window.__motion.seek(t);
        post({ type: 'motion-frame', t, box: boxOf(selected) });
      } finally { busy = false; }
      pump();
    };
    window.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'motion-seek') { pending = Number(d.t) || 0; pump(); }
      else if (d.type === 'motion-edit') { edit = d.edit || null; if (pending == null) pending = curT; pump(); }
      else if (d.type === 'motion-select') { selected = d.sel || d.added ? { sel: d.sel, added: d.added } : null; post({ type: 'motion-frame', t: curT, box: boxOf(selected) }); }
      else if (d.type === 'motion-pick') post({ type: 'motion-picked', pick: pick(Number(d.x), Number(d.y)) });
      else if (d.type === 'motion-inspect') post({ type: 'motion-layers', layers: inspect(), anims: listAnims().map(({ a, tw, ...x }) => ({ ...x, orig: animOrig.get(x.key) })) });
    });
    window.__motion.ready().then(async (inf) => {
      const m = /t=([\d.]+)/.exec(location.hash);
      if (m) await window.__motion.seek(parseFloat(m[1]));
      post({ type: 'motion-ready', info: inf });
    });
  } else if (mode === 'live') {
    // opened directly in a browser tab: play it in real time, looping
    window.__motion.ready().then(() => {
      let t0 = real.now();
      const tick = async () => {
        let t = (real.now() - t0) / 1000;
        if (t >= motion.duration) {
          if (!seekable()) { location.reload(); return; }
          t0 = real.now();
          t = 0;
        }
        await seek(pageTime(t), t);
        real.raf(tick);
      };
      real.raf(tick);
    });
  }
})();
