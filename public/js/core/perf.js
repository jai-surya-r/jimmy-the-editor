// The editor's half of the performance recorder (server/perflog.js): the page's long tasks, clicks and key presses
// that took long to show their result, and slow requests to the server. Sent in batches every 10 s.
import { clientId } from './api.js';

const items = [];
const push = (it) => { if (items.length < 500) items.push(it); };

export function noteRequest(method, url, ms) {
  if (ms >= 300 && !url.startsWith('/api/perf')) push({ kind: 'fetch', t: Date.now() - Math.round(ms), ms, what: `${method} ${url.replace(/\?.*$/, '')}` });
}

// what a Ctrl or Alt wheel did on the timeline (the log shows what the app really received)
export const noteWheel = (what) => push({ kind: 'wheel', t: Date.now(), ms: 0, what });

// counts other modules report for the 'mem' line (caches, players): registerStats('textCache', () => n)
const statFns = new Map();
export function registerStats(name, fn) { statFns.set(name, fn); }

// server messages: handling time and size per type, sent as one summary per batch (and each one over 50 ms)
const msgs = new Map();
export function noteMessage(type, ms, bytes) {
  const m = msgs.get(type) || { n: 0, ms: 0, kb: 0 };
  m.n++; m.ms += ms; m.kb += bytes / 1024;
  msgs.set(type, m);
  if (ms >= 50) push({ kind: 'msg', t: Date.now() - Math.round(ms), ms, what: type });
}

export function startPerf() {
  const observe = (opts, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe(opts); } catch { /* not supported */ } };
  const at = (e) => Math.round(performance.timeOrigin + e.startTime);
  observe({ type: 'longtask', buffered: true }, (e) => push({ kind: 'longtask', t: at(e), ms: e.duration, what: e.attribution?.[0]?.containerType || '' }));
  // input to the next frame painted: what a click or a key press feels like
  observe({ type: 'event', durationThreshold: 104, buffered: true }, (e) => {
    if (!/^(click|pointerdown|pointerup|keydown|mousedown|mouseup)$/.test(e.name)) return;
    const el = e.target;
    const what = el ? `${el.tagName?.toLowerCase() || ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} ${(el.textContent || '').trim().slice(0, 30)}` : '';
    push({ kind: e.name, t: at(e), ms: e.duration, what });
  });
  setInterval(() => {
    // what the page holds (what grows when its memory runs away)
    try {
      const canvases = [...document.querySelectorAll('canvas')];
      const stats = {
        heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 2 ** 20), nodes: document.getElementsByTagName('*').length,
        canvases: canvases.length, canvasMpx: Math.round(canvases.reduce((s, c) => s + c.width * c.height, 0) / 1e6),
        imgs: document.images.length, videos: document.querySelectorAll('video, audio').length,
      };
      for (const [k, fn] of statFns) { try { stats[k] = fn(); } catch { /* ignore */ } }
      push({ kind: 'mem', t: Date.now(), ms: stats.heapMB, what: JSON.stringify(stats) });
    } catch { /* ignore */ }
    if (msgs.size) {
      push({ kind: 'msgs', t: Date.now(), ms: Math.round([...msgs.values()].reduce((s, m) => s + m.ms, 0)),
        what: [...msgs].sort((a, b) => b[1].ms - a[1].ms).map(([k, m]) => `${k} ${m.n}× ${Math.round(m.ms)}ms ${Math.round(m.kb)}KB`).join(', ') });
      msgs.clear();
    }
    if (!items.length) return;
    const batch = items.splice(0);
    fetch('/api/perf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: clientId, items: batch }) }).catch(() => {});
  }, 10000);
}
