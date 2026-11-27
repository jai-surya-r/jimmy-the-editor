// The Browser tab (desktop app): a real browser inside Jimmy, in tabs, shared with Claude. Each page is a web view
// the app lays over the box below the toolbar (electron/browser.js); this draws the tab strip and the toolbar and
// keeps the views on the box. It keeps its own logins, apart from the editor and from the person's own browser.
// Claude drives the tab in front with `vedit browser …` and the toolbar says when it does. Ads are blocked: the
// shield says how many on this page and switches blocking off for a site it breaks; a stopped pop-up can still be
// opened from the note under the toolbar.
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

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function BrowserMode() {
  const B = bridge();
  const box = useRef(null);
  const addrEl = useRef(null);
  const [st, setSt] = useState(null);
  const [addr, setAddr] = useState('');
  const [typing, setTyping] = useState(false);
  const [drag, setDrag] = useState(null);
  const [, tick] = useState(0);
  // a dialog or menu would be hidden under the page: step aside while one is open
  const covered = useStore(overlays, (s) => !!(s.dialog || s.menu));

  useEffect(() => {
    if (!B) return undefined;
    const off = B.onState(setSt);
    B.call('state').then(setSt).catch(() => {});
    return off;
  }, []);
  useEffect(() => { if (!typing && st) setAddr(st.url || ''); }, [st?.url, st?.active, typing]);
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
  const newTab = () => { call('newtab'); setTimeout(() => addrEl.current?.focus(), 60); };
  const claude = st?.actor?.who === 'claude' && Date.now() - st.actor.at < 8000;
  const tabs = st?.tabs || [];
  const ads = st?.ads;
  const site = hostOf(st?.url || '');
  const shieldTitle = !ads?.working ? 'Ad blocking is getting ready (the filter lists are downloading)'
    : ads.off ? `Ad blocking is off for ${site}. Click to switch it back on.`
      : `Ad blocking is on: ${ads.blocked} ad${ads.blocked === 1 ? '' : 's'} and trackers stopped on this page. Click to switch it off for ${site || 'this site'} (if the site doesn't work with it).`;
  return html`<div class="browser-mode"
      onKeyDown=${(e) => { const k = e.key.toLowerCase(); if ((e.ctrlKey || e.metaKey) && k === 't') { e.preventDefault(); newTab(); } else if ((e.ctrlKey || e.metaKey) && k === 'w' && st?.active) { e.preventDefault(); call('close', st.active); } }}>
    <div class="browser-tabs" role="tablist">
      ${tabs.map((t, i) => html`<div key=${t.id} role="tab" aria-selected=${t.id === st.active}
          class="browser-tab ${t.id === st.active ? 'is-active' : ''} ${drag === t.id ? 'is-drag' : ''}" title=${`${t.title}\n${t.url}`}
          draggable="true"
          onDragStart=${(e) => { setDrag(t.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd=${() => setDrag(null)}
          onDragOver=${(e) => { if (drag) e.preventDefault(); }}
          onDrop=${(e) => { e.preventDefault(); if (drag && drag !== t.id) call('move', { id: drag, to: i }); setDrag(null); }}
          onPointerDown=${(e) => { if (e.button === 0 && !e.target.closest('.browser-tab-x')) call('switch', t.id); }}
          onAuxClick=${(e) => { if (e.button === 1) { e.preventDefault(); call('close', t.id); } }}>
        ${t.loading ? html`<span class="spinner spinner-xs"></span>`
          : t.favicon ? html`<img class="browser-fav" src=${t.favicon} alt="" onError=${(e) => { e.currentTarget.style.visibility = 'hidden'; }} />`
            : html`<${Icon} name="globe" size=${12} />`}
        <span class="browser-tab-title">${t.title}</span>
        <button class="browser-tab-x" title="Close tab (Ctrl+W)" onClick=${(e) => { e.stopPropagation(); call('close', t.id); }}><${Icon} name="x" size=${11} /></button>
      </div>`)}
      <button class="browser-tab-new" title="New tab (Ctrl+T)" onClick=${newTab}><${Icon} name="plus" size=${14} /></button>
    </div>
    <div class="browser-bar">
      <${IconButton} icon="chevronLeft" title="Back (Alt+Left)" disabled=${!st?.canBack} onClick=${() => call('back')} />
      <${IconButton} icon="chevronRight" title="Forward (Alt+Right)" disabled=${!st?.canForward} onClick=${() => call('forward')} />
      <${IconButton} icon=${st?.loading ? 'x' : 'refresh'} title=${st?.loading ? 'Stop' : 'Reload (Ctrl+R)'} onClick=${() => call(st?.loading ? 'stop' : 'reload')} />
      <${IconButton} icon="home" title="Start page" onClick=${() => call('home')} />
      <input class="input browser-address" ref=${addrEl} value=${addr} placeholder="Search or type an address"
        onFocus=${(e) => { setTyping(true); e.currentTarget.select(); }} onBlur=${() => setTyping(false)}
        onInput=${(e) => setAddr(e.currentTarget.value)}
        onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') { call('go', addr); e.currentTarget.blur(); } if (e.key === 'Escape') { setAddr(st?.url || ''); e.currentTarget.blur(); } }} />
      ${claude ? html`<span class="browser-claude" title="Claude is using this browser (vedit browser ${st.actor.what})"><${Icon} name="sparkle" size=${12} />Claude: ${st.actor.what}</span>` : null}
      <button class="browser-shield ${!ads?.working ? 'is-waiting' : ads.off ? 'is-off' : ''}" title=${shieldTitle} disabled=${!ads?.working || !site}
        onClick=${() => call('ads', !!ads?.off)}>
        <${Icon} name="shield" size=${14} /><span>${!ads?.working ? '…' : ads.off ? 'off' : ads.blocked > 999 ? '999+' : ads.blocked}</span>
      </button>
    </div>
    ${st?.stopped ? html`<div class="browser-stopped">
      <${Icon} name="shield" size=${13} />
      <span>${st.stopped.page ? 'Stopped this page from going to an ad site' : 'Blocked a pop-up'}: <b>${hostOf(st.stopped.url) || st.stopped.url}</b></span>
      <div class="spacer"></div>
      <button class="link-btn" onClick=${() => call('open-stopped')}>Open it anyway</button>
      <${IconButton} icon="x" size=${12} title="Dismiss" onClick=${() => call('dismiss-stopped')} />
    </div>` : null}
    <div class="browser-page" ref=${box}>${covered ? html`<div class="browser-covered">${st?.title || ''}</div>` : null}</div>
  </div>`;
}
