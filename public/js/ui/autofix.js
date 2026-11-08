// Auto-fix: comments on a sequence's live Timeline go to Claude in batches of five, each sequence on its own: a
// batch never mixes sequences. It goes to the chat linked to that sequence (see chatlinks.js), which works in the
// background, so several sequences' chats fix their comments side by side; a sequence without a chat uses the
// chat shown in the panel (one batch at a time there). Once five are waiting and no new one has come in for ten
// seconds, the five oldest are sent in one turn; Claude fixes them one at a time and resolves each with
// `vedit reply --resolve`. Fewer than five wait for the editor's "Send to Claude" (sendNow, per sequence), which
// sends whatever is waiting. A comment still open when its turn ends is tagged "needs you" and isn't retried
// until the editor re-runs it, replies to it or presses Send (when Claude never answered it). Between batches, a
// Claude chat past 150k tokens of context is compacted first. Claude running in the terminal view pauses the
// batches meant for the shown chat.
import { createStore, loadPref, savePref } from '../core/store.js';
import { get, post } from '../core/api.js';
import { app } from '../core/app.js';
import { findSequence } from '../core/model.js';
import { chatSession, sendChatPrompt } from './ClaudeChat.js';

export const BATCH = 5;
const COOLDOWN_MS = 10000;
const COMPACT_AT = 150000;
const START_MS = 60000; // a sent prompt that never shows Claude working counts as ended after this

// the latest round of each sequence: the live Timeline in Review
export function liveRounds(reviews) {
  const top = new Map();
  for (const v of reviews?.versions || []) if (v.kind === 'timeline' && !(top.get(v.sequence)?.number >= v.number)) top.set(v.sequence, v);
  return [...top.values()];
}
// open comments by the editor on a live Timeline, waiting for Claude (oldest first); seqId: that sequence's only
export function queued(reviews, seqId) {
  const live = new Map(liveRounds(reviews).filter((v) => !seqId || v.sequence === seqId).map((v) => [v.id, v]));
  return (reviews?.comments || []).filter((c) => live.has(c.version) && !c.resolved && c.author !== 'Claude' && !c.auto)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
// "needs you" comments Claude never answered (its turn was stopped or failed before it got to them): the
// editor's "Send to Claude" sends these again too; ones Claude asked about wait for the editor's reply
export function stalled(reviews, seqId) {
  const live = new Map(liveRounds(reviews).filter((v) => !seqId || v.sequence === seqId).map((v) => [v.id, v]));
  return (reviews?.comments || []).filter((c) => live.has(c.version) && !c.resolved && c.author !== 'Claude' && c.auto?.state === 'needs'
    && (c.replies || []).at(-1)?.author !== 'Claude');
}
const byAge = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));

const runs = new Map(); // projectId -> loop state
export function autoFixStore(projectId) {
  let r = runs.get(projectId);
  if (!r) {
    // bySeq: { [sequenceId]: { phase, note, comments } } for the sequences with comments waiting or being fixed
    // loaded: the server's setting has been read (nothing is sent before that: a switch turned off stays off)
    r = { store: createStore({ on: loadPref(`autofix.${projectId}`, true), loaded: false, bySeq: {} }), cur: new Map(), timer: 0, force: new Map() };
    runs.set(projectId, r);
    const store = r.store;
    const read = (n) => get(`/api/p/${projectId}/autofix`).then((res) => {
      if (typeof res.on === 'boolean') store.set({ on: res.on, loaded: true });
      else post(`/api/p/${projectId}/autofix`, { on: store.get().on }).then(() => store.set({ loaded: true })); // first time: keep the window's setting
    }).catch(() => { if (n < 5) setTimeout(() => read(n + 1), 2000); });
    read(0);
  }
  return r.store;
}
export function setAutoFix(projectId, on) {
  savePref(`autofix.${projectId}`, !!on);
  autoFixStore(projectId).set({ on: !!on });
  post(`/api/p/${projectId}/autofix`, { on: !!on }).catch(() => {});
}
// "Send to Claude": send what's waiting on this sequence now, without waiting for five (after its chat's
// current turn, if any)
export function sendNow(projectId, seqId) {
  autoFixStore(projectId);
  if (seqId) runs.get(projectId).force.set(seqId, Date.now());
}

function prompt(list, reviews, seqName) {
  const vs = liveRounds(reviews);
  const lines = list.map((c, i) => {
    const again = (c.replies || []).length ? ' (re-run: read the replies on it first)' : '';
    return `${i + 1}. ${c.id} (version ${c.version}) at ${c.t}s${c.tEnd != null ? `–${c.tEnd}s` : ''}: "${String(c.text).replace(/\s+/g, ' ')}"${again}`;
  });
  const versions = [...new Set(list.map((c) => c.version))];
  const name = seqName || vs.find((x) => x.id === list[0]?.version)?.sequenceName || 'the sequence';
  return `${list.length} review comment${list.length > 1 ? 's' : ''} on the live timeline of "${name}":\n${lines.join('\n')}\n\n`
    + `Run ${versions.map((v) => `\`vedit comments --open --version ${v}\``).join(' and ')} for their details, drawings and any reference images/links. `
    + 'Work through them ONE AT A TIME, in this order: fix it in project.json, check it with `vedit frame <t>`, then immediately run `vedit reply <commentId> "what you changed" --resolve` (one short line) before the next. '
    + 'If you can\'t fix one or need my input, run `vedit reply <commentId> "your question"` without --resolve and move on to the next. '
    + 'If a fix changes timing (a graphic gets longer or shorter, clips move), Jimmy moves the other open comments with the timeline, stretching them across a clip that changed length; if you added or removed time at one point, check each remaining comment from this list and put any that now sit on the wrong moment back with `vedit move <commentId> <seconds>`. '
    + `Fix only these comments, only in "${name}". This is the live timeline: do NOT render or export.`;
}

// Start the loop for an open project tab (safe to call again; it stops when the tab closes).
export function startAutoFix(tab) {
  const store = autoFixStore(tab.projectId);
  const r = runs.get(tab.projectId);
  if (r.timer) return;
  const chat = chatSession(tab.projectId).store;
  const mark = (ids, auto) => tab.updateReviews((d) => {
    const cs = d.comments.filter((x) => ids.includes(x.id));
    if (!cs.length) return false;
    for (const c of cs) c.auto = typeof auto === 'function' ? auto(c) : auto;
  });
  const stamp = () => new Date().toISOString();
  // to a sequence's linked chat (in the background), or to the shown chat (sid null)
  const send = (sid, text) => sendChatPrompt(tab.projectId, text, { sessionId: sid || undefined });
  let shownBy = '';
  const tick = () => {
    if (!app.get().tabs.includes(tab.id)) { clearInterval(r.timer); r.timer = 0; return; }
    const st = store.get();
    const reviews = tab.store.get().reviews;
    const doc = tab.doc;
    const now = Date.now();
    if (!reviews || !doc || !st.loaded) return;
    const info = chat.get().info || {};
    const links = tab.store.get().chatLinks || {};
    const live = tab.store.get().chatsLive || [];
    // a chat's state: the shown one from the panel, the others from the live list
    const stateOf = (sid) => {
      if (!sid || (info.running && info.sessionId === sid)) return { busy: !!(info.busy || info.compacting), context: info.context, codex: info.agent === 'codex' };
      const l = live.find((x) => x.sessionId === sid);
      return { busy: !!(l && (l.busy || l.compacting)), context: l?.context || 0, codex: false };
    };
    // where a sequence's comments go: its linked chat, else the shown chat (null)
    const targetOf = (seqId) => (info.agent !== 'codex' && links[seqId] && findSequence(doc, seqId) ? links[seqId] : null);
    const rounds = new Map(liveRounds(reviews).map((v) => [v.id, v.sequence]));

    if (!r.checked) { // comments left "working" (the page was reloaded mid-batch): wait for those turns to end
      r.checked = true;
      for (const c of reviews.comments.filter((x) => x.auto?.state === 'working' && !x.resolved)) {
        const seqId = rounds.get(c.version);
        if (!seqId) continue;
        const sid = targetOf(seqId);
        const key = sid || 'shown';
        const cur = r.cur.get(key) || { phase: 'fixing', comments: [], at: now - START_MS + 8000, sawBusy: false, sid, seqId };
        cur.comments.push(c.id);
        r.cur.set(key, cur);
      }
    }

    // turns in flight: done once their chat has worked and stopped
    for (const [key, cur] of [...r.cur]) {
      const cs = stateOf(cur.sid);
      if (cs.busy) cur.sawBusy = true;
      if (cs.busy || (!cur.sawBusy && now - cur.at <= START_MS)) continue;
      r.cur.delete(key);
      if (cur.phase !== 'fixing') continue;
      mark(cur.comments, (c) => ({ state: c.resolved ? 'done' : 'needs', at: stamp() }));
      // compact between batches once the context is big
      if (!cs.codex && cs.context > COMPACT_AT) {
        r.cur.set(key, { phase: 'compacting', comments: [], at: now, sawBusy: false, sid: cur.sid, seqId: cur.seqId });
        send(cur.sid, '/compact').catch(() => r.cur.delete(key));
      }
    }

    const term = tab.store.get().terminal;
    const termBusy = term?.running && term.mode !== 'shell';
    const bySeq = {};
    const waiting = queued(reviews);
    const stuck = r.force.size ? stalled(reviews).filter((c) => r.force.has(rounds.get(c.version))) : [];
    const seqIds = [...new Set([...waiting, ...stuck].map((c) => rounds.get(c.version)).filter(Boolean))];
    for (const seqId of seqIds) {
      const set = (phase, note = '', comments = []) => { bySeq[seqId] = { phase, note, comments }; };
      const busyHere = [...r.cur.values()].find((x) => x.seqId === seqId);
      if (busyHere) { set(busyHere.phase, '', busyHere.comments); continue; }
      const force = r.force.get(seqId);
      const list = [...waiting, ...(force ? stuck : [])].filter((c) => rounds.get(c.version) === seqId).sort(byAge);
      const sid = targetOf(seqId);
      const key = sid || 'shown';
      if (!st.on && !force) { set('off'); continue; }
      if (!sid && termBusy) { set('paused', 'Claude is running in the terminal: switch to the chat view to auto-fix'); continue; }
      if (r.cur.has(key) || stateOf(sid).busy) { set('waiting', `${list.length} waiting · ${sid ? 'its chat' : 'Claude'} is busy`); continue; }
      let batch;
      if (force) batch = list; // the editor pressed Send: everything that's waiting
      else {
        if (list.length < BATCH) { set('collecting', `${list.length} of ${BATCH} comments`); continue; }
        const last = Math.max(...list.map((c) => Date.parse(c.editedAt || c.createdAt) || 0));
        if (now - last < COOLDOWN_MS) { set('waiting', `Sending ${BATCH} in ${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)}s`); continue; }
        batch = list.slice(0, BATCH);
      }
      r.force.delete(seqId);
      const ids = batch.map((c) => c.id);
      r.cur.set(key, { phase: 'fixing', comments: ids, at: now, sawBusy: false, sid, seqId });
      set('fixing', '', ids);
      mark(ids, { state: 'working', at: stamp() });
      send(sid, prompt(batch, reviews, findSequence(doc, seqId)?.name)).catch((err) => {
        r.cur.delete(key);
        // the editor's own prompt got there first: the batch goes back in the queue
        if (/still working/.test(err.message)) mark(ids, null);
        else mark(ids, { state: 'needs', at: stamp(), error: err.message });
      });
    }
    // sequences being fixed with nothing else waiting
    for (const cur of r.cur.values()) if (cur.seqId && !bySeq[cur.seqId]) bySeq[cur.seqId] = { phase: cur.phase, note: '', comments: cur.comments };
    for (const [seqId, t] of [...r.force]) if (!seqIds.includes(seqId) && now - t > 3000) r.force.delete(seqId);
    const sig = JSON.stringify(bySeq);
    if (sig !== shownBy) { shownBy = sig; store.set({ bySeq }); }
  };
  r.timer = setInterval(tick, 1000);
}

// Send a timeline comment again: reopen it and send it (with anything else waiting on its sequence) as soon as
// that sequence's chat is free.
export function rerun(tab, c) {
  tab.updateReviews((d) => { const x = d.comments.find((y) => y.id === c.id); if (!x) return false; x.resolved = false; x.resolvedAt = null; delete x.auto; });
  const seqId = liveRounds(tab.reviews).find((v) => v.id === c.version)?.sequence;
  sendNow(tab.projectId, seqId);
}
