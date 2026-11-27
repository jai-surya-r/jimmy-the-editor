// Ad and pop-up blocking for the Browser tab (electron/browser.js), with Ghostery's ad blocker (MPL-2.0) and the
// public filter lists it uses (EasyList, EasyPrivacy, uBlock Origin's lists, Peter Lowe's list). It stops ad and
// tracker requests, hides ad boxes on pages, runs the lists' page fixes (YouTube's ads among them), and knows the
// sites that live off pop-ups (the lists' $popup rules, which the engine itself doesn't read: collected here).
// The compiled lists are kept in the app's data folder and refreshed in the background every few days; until the
// first download is done (a few seconds, first launch only) pages load unblocked. A site can be switched off (the
// shield in the toolbar) when blocking breaks it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app, ipcMain } from 'electron';
import { ElectronBlocker, Request, adsAndTrackingLists, fetchLists, fetchResources } from '@ghostery/adblocker-electron';

const PRELOAD = createRequire(import.meta.url).resolve('@ghostery/adblocker-electron-preload');
const REFRESH_MS = 4 * 24 * 3600e3;
const files = () => {
  const dir = path.join(app.getPath('userData'), 'browser-blocking');
  return { dir, engine: path.join(dir, 'engine.bin'), popups: path.join(dir, 'popup-sites.json'), off: path.join(dir, 'sites-off.json') };
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const under = (host, set) => { for (let h = host; h; h = h.slice(h.indexOf('.') + 1 || h.length)) { if (set.has(h)) return true; if (!h.includes('.')) break; } return false; };

// `||host^$popup` rules (no other conditions): sites a pop-up should never open
function popupHosts(lists) {
  const out = new Set();
  for (const line of lists.join('\n').split('\n')) {
    const m = /^\|\|([a-z0-9.-]+)\^?\$([^#\s]+)$/i.exec(line.trim());
    if (!m) continue;
    const opts = m[2].split(',');
    if (opts.includes('popup') && !opts.some((o) => /^(domain|from|~popup)/.test(o))) out.add(m[1].toLowerCase().replace(/^www\./, ''));
  }
  return [...out];
}

export function createAdblock() {
  let engine = null;
  let popups = new Set();
  let off = new Set();
  const counts = new Map(); // webContents id → requests blocked since its page loaded
  const F = files();
  try { off = new Set(JSON.parse(fs.readFileSync(F.off, 'utf8'))); } catch { /* none switched off */ }

  async function build() {
    const [lists, resources] = await Promise.all([fetchLists(fetch, adsAndTrackingLists), fetchResources(fetch)]);
    const e = ElectronBlocker.parse(lists.join('\n'));
    if (resources) e.updateResources(resources, String(resources.length));
    const p = popupHosts(lists);
    fs.mkdirSync(F.dir, { recursive: true });
    fs.writeFileSync(F.engine, e.serialize());
    fs.writeFileSync(F.popups, JSON.stringify(p));
    return { e, p };
  }
  let ready = Promise.resolve(false);
  const start = () => (async () => {
    try {
      engine = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(F.engine)));
      popups = new Set(JSON.parse(fs.readFileSync(F.popups, 'utf8')));
      if (Date.now() - fs.statSync(F.engine).mtimeMs > REFRESH_MS) {
        build().then(({ e, p }) => { engine = e; popups = new Set(p); }).catch((err) => console.warn('[browser] filter lists not refreshed:', err.message));
      }
    } catch {
      try { const { e, p } = await build(); engine = e; popups = new Set(p); } catch (err) { console.warn('[browser] ad blocking is off for now (the filter lists did not download):', err.message); }
    }
    return !!engine;
  })();

  // the page a request belongs to: the tab's (or pop-up window's) top page
  const pageOf = (details) => { try { return details.webContents?.getURL() || details.referrer || ''; } catch { return ''; } };
  const isOff = (pageUrl) => under(hostOf(pageUrl), off);

  return {
    get ready() { return ready; },
    attach(ses) {
      ready = start();
      ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
      // the preload asks for the page's hiding rules and fixes (the channel names are the package's)
      ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
        if (!engine || isOff(event.sender.getURL())) return undefined;
        return engine.onInjectCosmeticFilters(event, url, msg);
      });
      ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => (engine ? engine.onIsMutationObserverEnabled(event) : false));
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
        if (!engine || isOff(pageOf(details))) return cb({});
        engine.onBeforeRequest(details, (r) => {
          if (r.cancel || r.redirectURL) { const id = details.webContentsId; if (id != null) counts.set(id, (counts.get(id) || 0) + 1); }
          cb(r);
        });
      });
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, cb) => {
        if (!engine || isOff(pageOf(details))) return cb({});
        engine.onHeadersReceived(details, cb);
      });
    },
    // a pop-up or a page change to somewhere only ads live (`from`: the page it came from)
    isAdPage(url, from) {
      if (!engine || isOff(from)) return false;
      const host = hostOf(url);
      if (!host || host === hostOf(from)) return false;
      if (under(host, popups)) return true;
      const { match } = engine.match(Request.fromRawDetails({ url, sourceUrl: from, type: 'sub_frame' }));
      return !!match;
    },
    blocked: (id) => counts.get(id) || 0,
    resetCount: (id) => counts.delete(id),
    working: () => !!engine,
    siteOff: (url) => isOff(url),
    setSiteOff(url, value) {
      const h = hostOf(url);
      if (!h) return;
      if (value) off.add(h); else for (const x of [...off]) if (h === x || h.endsWith(`.${x}`)) off.delete(x);
      try { fs.mkdirSync(F.dir, { recursive: true }); fs.writeFileSync(F.off, JSON.stringify([...off])); } catch { /* kept for this run */ }
    },
  };
}

// YouTube, second line: when an ad still starts (the lists' fixes lag YouTube's changes now and then), it is muted
// and played at 16x to its end, and skipped as soon as YouTube offers a skip button; the video's own sound and speed
// come back after it. (No jumping to the ad's end: YouTube refuses seeks in ads, and when it stitches the ad into the
// video itself, the end would be the video's.)
export const YOUTUBE_SKIP = `(() => { if (window.__jimmyAdSkip) return; window.__jimmyAdSkip = true;
  let mine = null;
  setInterval(() => {
    const p = document.querySelector('#movie_player'); const v = p && p.querySelector('video'); if (!v) return;
    if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) {
      if (!mine) mine = { muted: v.muted, rate: v.playbackRate === 16 ? 1 : v.playbackRate };
      v.muted = true;
      if (v.playbackRate !== 16) v.playbackRate = 16;
      const skip = p.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"]');
      if (skip) skip.click();
    } else if (mine) { v.muted = mine.muted; v.playbackRate = mine.rate; mine = null; }
  }, 250);
})()`;
