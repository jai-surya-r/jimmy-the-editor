// A new user's first start: (1) the coding agents — Claude Code and Codex — installed and signed in, asked once on
// the first start and only when none is ready to work (afterwards it is in Settings › Getting started), and (2) a guided tour of the screen: the home screen on
// first start, the editor the first time a project opens. Both can be run again from Settings › Getting started.
import { html, Icon, Button, Modal } from './common.js';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { get, post } from '../core/api.js';
import { app, activeTab } from '../core/app.js';
import { openDialog, overlays, notify } from '../core/notify.js';
import { openAccounts } from './accounts.js';

const KEY = { skipSetup: 'jimmy.setup.skip', home: 'jimmy.tour.home', editor: 'jimmy.tour.editor' };
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private */ } } };

// ------------------------------------------------------------------ agents
export async function agentsReady() {
  const r = await get('/api/agents');
  const claudeIn = (r.accounts || []).some((a) => a.loggedIn);
  return { ...r, claudeIn, ready: claudeIn || !!r.agents?.codex?.loggedIn };
}

export function SetupDialog({ close, then }) {
  const [st, setSt] = useState(null);
  const [jobs, setJobs] = useState({});
  const [codexLogin, setCodexLogin] = useState(null);
  const load = () => agentsReady().then(setSt).catch((e) => notify(e.message, 'error'));
  useEffect(() => { load(); }, []);
  // follow running installs and the Codex sign-in
  useEffect(() => {
    const running = Object.entries(jobs).filter(([, j]) => j?.state === 'running');
    if (!running.length && codexLogin?.state !== 'running') return undefined;
    const id = setInterval(async () => {
      for (const [a] of running) {
        const j = (await get(`/api/agents/install/${a}`).catch(() => null))?.job;
        if (j) setJobs((x) => ({ ...x, [a]: j }));
        if (j && j.state !== 'running') load();
      }
      if (codexLogin?.state === 'running') {
        const l = (await get('/api/agents/codex/login').catch(() => null))?.login;
        if (l) setCodexLogin(l);
        if (l && l.state !== 'running') load();
      }
    }, 1200);
    return () => clearInterval(id);
  }, [JSON.stringify(jobs), codexLogin?.state]);
  const install = async (agent) => {
    try { const { job } = await post('/api/agents/install', { agent }); setJobs((x) => ({ ...x, [agent]: job })); } catch (e) { notify(e.message, 'error'); }
  };
  const signInCodex = async () => {
    try { setCodexLogin(await post('/api/agents/codex/login')); } catch (e) { notify(e.message, 'error'); }
  };
  const finish = () => { close(true); then?.(); };
  const claude = st?.agents?.claude, codex = st?.agents?.codex;
  const card = (name, logo, info, signedIn, who, agent, signIn, blurb) => {
    const job = jobs[agent];
    return html`<div class=${`setup-card ${signedIn ? 'is-ready' : ''}`} data-agent=${agent}>
      <div class="setup-card-head"><span class="setup-logo">${logo}</span><b>${name}</b>
        <span class=${`setup-state ${signedIn ? 'is-ok' : info?.installed ? 'is-half' : ''}`}>${!st ? 'Checking…' : signedIn ? 'Ready' : info?.installed ? 'Installed · not signed in' : 'Not installed'}</span></div>
      <p class="setup-blurb">${blurb}</p>
      ${info?.version ? html`<div class="setup-meta">Version ${info.version}${who ? ` · ${who}` : ''}</div>` : null}
      ${job?.state === 'running' ? html`<div class="setup-job"><span class="spinner spinner-xs"></span>Installing… <span class="muted">${job.log.at(-1) || ''}</span></div>` : null}
      ${job?.state === 'error' ? html`<div class="setup-err">${job.error}${job.log?.length ? html`<pre>${job.log.slice(-4).join('\n')}</pre>` : null}</div>` : null}
      ${job?.state === 'done' ? html`<div class="setup-ok"><${Icon} name="checkCircle" size=${13} /> Installed.</div>` : null}
      <div class="setup-btns">
        ${st && !info?.installed ? html`<${Button} kind="primary" icon="download" disabled=${job?.state === 'running'} onClick=${() => install(agent)}>Install ${name}</${Button}>` : null}
        ${st && info?.installed && !signedIn ? html`<${Button} kind="primary" icon="external" onClick=${signIn}>Sign in</${Button}>` : null}
      </div>
    </div>`;
  };
  const who = (st?.accounts || []).filter((a) => a.loggedIn).map((a) => a.email || a.name).join(', ');
  return html`<${Modal} title="Welcome to Jimmy" onClose=${finish} width=${620} class="setup-dialog"
    footer=${html`<span class="setup-skip">You can come back to this in Settings › Getting started.</span>
      <div class="spacer"></div><${Button} kind=${st?.ready ? 'primary' : 'default'} onClick=${finish}>${st?.ready ? 'Continue' : 'Not now'}</${Button}>`}>
    <p class="setup-intro">Jimmy edits video together with an AI coding agent: you ask in the chat, the agent changes the project, and
      you see every change live. Sign in to <b>one</b> of these to use the chat. Editing by hand, exports and review work without one.</p>
    <div class="setup-cards">
      ${card('Claude Code', 'C', claude, !!st?.claudeIn, who, 'claude', () => { close(true); openAccounts({ onBack: () => openDialog(SetupDialog, { then }) }); },
        'Anthropic\'s agent. Needs a Claude account (Pro or Max) or an Anthropic API key. Recommended: Jimmy is built around it.')}
      ${card('Codex', 'X', codex, !!codex?.loggedIn, codex?.loggedIn ? 'signed in' : '', 'codex', signInCodex,
        'OpenAI\'s agent. Needs a ChatGPT account (Plus or above). Pick it per project in the chat panel.')}
    </div>
    ${codexLogin?.state === 'running' ? html`<div class="setup-job"><span class="spinner spinner-xs"></span>Finish signing in to Codex in your browser…</div>` : null}
    <div class="dialog-hint">Install runs the maker's own installer (it isn't bundled with Jimmy: it updates itself). Signing in happens in your
      browser; Jimmy never sees your email, password or key.</div>
  </${Modal}>`;
}

// ------------------------------------------------------------------ tour
// Each step points at a part of the screen (sel; missing ones are explained in the middle) and says what it is for,
// what it can do and what it can't.
const TOURS = {
  home: [
    { title: 'Welcome to Jimmy', body: 'A video editor you edit together with Claude (or Codex). Everything stays on this computer: projects are folders, media is never uploaded. This short tour shows where things are. You can run it again any time from Settings › Getting started.' },
    { sel: '.home-create', title: 'Start a project', body: 'New project makes a folder for your media and edits. Open folder… opens any folder as a project, including one Claude or someone else made.', cant: 'Jimmy can\'t open Premiere or After Effects projects directly; bring the media in instead. (It can send a timeline to Premiere or Resolve as XML.)' },
    { sel: '.home-section-title.home-projects-head', title: 'Your projects', body: 'Recent projects, newest first. Click one to open it in this tab; the + at the top opens another tab, so several projects can be open side by side.' },
    { sel: '.topbar-right [title="Settings"]', title: 'Settings', body: 'Accounts (Claude sign-in), theme, how much of the computer exports may use, the graphics card, pre-rendering and the cache folder. Getting started has this tour and the agent setup.' },
    { title: 'Next: the editor', body: 'Open or create a project and the tour carries on inside the editor.' },
  ],
  editor: [
    { sel: '.mode-switch', title: 'Three workspaces', body: 'Edit: cut, arrange and adjust. Motion: animated graphics (titles, lower thirds…) layer by layer. Review: watch exports and leave comments on exact frames.' },
    { sel: '.panel.bin', title: 'Project bin', body: 'Your media, sequences and folders. Upload files or link them from disk without copying, drag them onto the timeline, double-click to preview and mark in / out.', cant: 'It shows files on this computer and connected drives, not cloud storage.' },
    { sel: '.panel.viewer', title: 'Viewer', body: 'The program as it plays. Click a layer to select it, drag to move, drag a corner to scale, the top handle to rotate. Guides and safe areas are in its bar.' },
    { sel: '.panel.inspector', title: 'Inspector', body: 'Everything about the selected clip: timing, position and scale, crop, text, colour, effects, transitions, audio. The clock next to a property animates it with keyframes.' },
    { sel: '.panel.timeline', title: 'Timeline', body: 'Tracks with your clips. Trim by dragging edges, C cuts, S snaps, M adds a marker. Right-click a clip for more: labels, speed, nest, unlink and so on.' },
    { sel: '.panel.claude', title: 'Claude (or Codex)', body: 'Ask in plain words: "remove the silences", "add captions", "make a 30-second cut", "make a lower third". The agent edits this project and you see it change live. Ctrl+Z undoes anything it did.', cant: 'It needs to be signed in and online. It works inside this project\'s folder, and it can get things wrong, so check its work.' },
    { sel: '.topbar-right .btn-primary', title: 'Export', body: 'Renders the sequence to a video file (H.264, H.265, ProRes…), with a fast Draft quality for checks. Exports run in the background; follow them in the jobs list next to it.' },
    { sel: '.topbar-right [title^="Keyboard shortcuts"]', title: 'Shortcuts', body: 'Every shortcut, and you can change them. Space plays, J K L shuttle, I / O mark in and out.' },
    { title: 'That\'s the tour', body: 'Run it again any time from Settings › Getting started. Happy editing!' },
  ],
};

let host = null;
export function startTour(kind) {
  const steps = TOURS[kind];
  if (!steps) return;
  ls.set(KEY[kind], '1');
  if (host) { render(null, host); host.remove(); }
  host = document.createElement('div');
  host.className = 'tour-host';
  document.body.appendChild(host);
  const end = () => { if (!host) return; render(null, host); host.remove(); host = null; };
  render(html`<${Tour} steps=${steps} end=${end} />`, host);
}
export const tourRunning = () => !!host;

function Tour({ steps, end }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = steps[i];
  const place = () => {
    const el = step.sel ? document.querySelector(step.sel) : null;
    const r = el?.getBoundingClientRect();
    setRect(r && r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
  };
  useLayoutEffect(place, [i]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); end(); } else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(); } else if (e.key === 'ArrowLeft') { e.stopPropagation(); setI((x) => Math.max(0, x - 1)); }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place); };
  });
  const next = () => (i < steps.length - 1 ? setI(i + 1) : end());
  // the card goes beside the highlighted part where there's room, else in the middle
  const W = 340, pad = 14, vw = window.innerWidth, vh = window.innerHeight;
  let pos = { left: `${(vw - W) / 2}px`, top: `${vh / 2 - 110}px` };
  if (rect) {
    const below = rect.y + rect.h + pad, right = rect.x + rect.w + pad;
    if (below + 200 < vh) pos = { left: `${Math.min(vw - W - pad, Math.max(pad, rect.x))}px`, top: `${below}px` };
    else if (right + W < vw) pos = { left: `${right}px`, top: `${Math.max(pad, Math.min(vh - 240, rect.y))}px` };
    else if (rect.x - W - pad > 0) pos = { left: `${rect.x - W - pad}px`, top: `${Math.max(pad, Math.min(vh - 240, rect.y))}px` };
    else pos = { left: `${Math.min(vw - W - pad, Math.max(pad, rect.x))}px`, top: `${Math.max(pad, rect.y - 220)}px` };
  }
  return html`<div class="tour" role="dialog" aria-label="Tour">
    ${rect ? html`<div class="tour-spot" style=${{ left: `${rect.x - 6}px`, top: `${rect.y - 6}px`, width: `${rect.w + 12}px`, height: `${rect.h + 12}px` }}></div>` : html`<div class="tour-dim"></div>`}
    <div class="tour-card" style=${{ ...pos, width: `${W}px` }}>
      <div class="tour-count">${i + 1} / ${steps.length}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      ${step.cant ? html`<p class="tour-cant"><b>Can't:</b> ${step.cant}</p>` : null}
      <div class="tour-btns">
        <button class="link-btn" onClick=${end}>Skip tour</button>
        <div class="spacer"></div>
        ${i > 0 ? html`<${Button} onClick=${() => setI(i - 1)}>Back</${Button}>` : null}
        <${Button} kind="primary" onClick=${next}>${i < steps.length - 1 ? 'Next' : 'Done'}</${Button}>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ first start
// Waits for the server, then: the agent setup when nothing can work yet (unless dismissed for good), then the home
// tour once; the editor tour the first time a project is open in Edit with nothing else on screen.
export function firstRun() {
  let asked = false;
  const tick = async () => {
    const s = app.get().server;
    if (!s || s.welcome === false || overlays.get().dialog || tourRunning()) return;
    if (!asked) {
      asked = true;
      let needSetup = false;
      if (!ls.get(KEY.skipSetup)) {
        try { needSetup = !(await agentsReady()).ready; } catch { return; } // offline: try again
        ls.set(KEY.skipSetup, '1'); // asked on the first start only
      }
      if (needSetup) { openDialog(SetupDialog, { then: () => { if (!ls.get(KEY.home)) setTimeout(() => startTour('home'), 300); } }); return; }
      if (!ls.get(KEY.home) && !activeTab()?.projectId) { startTour('home'); return; }
    }
    const t = activeTab();
    if (!ls.get(KEY.editor) && ls.get(KEY.home) && t?.projectId && t.store.get().status === 'ready' && (t.ui.get().mode || 'edit') === 'edit' && document.querySelector('.panel.timeline')) startTour('editor');
  };
  setInterval(tick, 1000);
}
