// The Browser tab (desktop app): a real browser inside Jimmy, shared with Claude. The page itself is a web view the
// app lays over the box below the toolbar (electron/browser.js); this draws the toolbar and keeps the view on the
// box. It keeps its own logins, apart from the editor and from the person's own browser. Claude drives the same view
// with `vedit browser …` and the toolbar says when it does.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Icon, IconButton } from './common.js';
import { useStore } from '../core/store.js';
import { overlays } from '../core/notify.js';
import { activeTab } from '../core/app.js';

const bridge = () => window.jimmyApp?.browser || null;
export const hasBrowser = () => !!bridge();

// Claude asking for the browser to be shown (vedit browser show): the active project tab switches to it
export function listenBrowserShow() {
  const B = bridge();
  if (!B) return () => {};
  return B.onShow(() => {
    const t = activeTab();
    if (t?.ui && t.projectId) t.ui.set({ mode: 'browser' });
  });
}

export function BrowserMode() {
  const B = bridge();
  const box = useRef(null);
  const [st, setSt] = useState(null);
  const [addr, setAddr] = useState('');
  const [typing, setTyping] = useState(false);
  const [, tick] = useState(0);
  // a dialog or menu would be hidden under the page: step aside while one is open
  const covered = useStore(overlays, (s) => !!(s.dialog || s.menu));

  useEffect(() => {
    if (!B) return undefined;
    const off = B.onState(setSt);
    B.call('state').then(setSt).catch(() => {});
    return off;
  }, []);
  useEffect(() => { if (!typing && st) setAddr(st.url || ''); }, [st?.url, typing]);
  // the "Claude is using it" note fades after a few seconds
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);

  // keep the web view over the box, and shown while this tab is
  useEffect(() => {
    if (!B) return undefined;
    const el = box.current;
    const place = () => {
      const r = el.getBoundingClientRect();
      B.call('bounds', { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); B.call('show', false); };
  }, []);
  useEffect(() => { if (B) B.call('show', !covered); }, [covered]);

  if (!B) {
    return html`<div class="browser-mode"><div class="review-empty"><div class="empty">
      <${Icon} name="globe" size=${28} /><b>The browser is part of the desktop app</b>
      <p>Open Jimmy as the app (not in a web browser) to browse inside it and let Claude use the same browser.</p></div></div></div>`;
  }
  const call = (op, arg) => B.call(op, arg).then(setSt).catch(() => {});
  const claude = st?.actor?.who === 'claude' && Date.now() - st.actor.at < 8000;
  return html`<div class="browser-mode">
    <div class="browser-bar">
      <${IconButton} icon="chevronLeft" title="Back" disabled=${!st?.canBack} onClick=${() => call('back')} />
      <${IconButton} icon="chevronRight" title="Forward" disabled=${!st?.canForward} onClick=${() => call('forward')} />
      <${IconButton} icon=${st?.loading ? 'x' : 'refresh'} title=${st?.loading ? 'Stop' : 'Reload'} onClick=${() => call(st?.loading ? 'stop' : 'reload')} />
      <${IconButton} icon="home" title="Start page" onClick=${() => call('home')} />
      <input class="input browser-address" value=${addr} placeholder="Search or type an address"
        onFocus=${(e) => { setTyping(true); e.currentTarget.select(); }} onBlur=${() => setTyping(false)}
        onInput=${(e) => setAddr(e.currentTarget.value)}
        onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') { call('go', addr); e.currentTarget.blur(); } if (e.key === 'Escape') { setAddr(st?.url || ''); e.currentTarget.blur(); } }} />
      ${claude ? html`<span class="browser-claude" title="Claude is using this browser (vedit browser ${st.actor.what})"><${Icon} name="sparkle" size=${12} />Claude: ${st.actor.what}</span>` : null}
      ${st?.loading ? html`<span class="spinner spinner-xs"></span>` : null}
    </div>
    <div class="browser-page" ref=${box}>${covered ? html`<div class="browser-covered">${st?.title || ''}</div>` : null}</div>
  </div>`;
}
