// Chats linked to sequences (server/chatlinks.js): a sequence's messages and review comments go to its own chat,
// which works in the background; the Claude panel keeps showing whichever chat is being read.
import { post } from '../core/api.js';
import { notify } from '../core/notify.js';
import { findSequence } from '../core/model.js';

// the sequence the editor is on: the version being reviewed in Review, else the open sequence
export function currentSeqId(tab) {
  const ui = tab.ui.get();
  if (ui.mode === 'review' && ui.reviewVersion) {
    const v = tab.reviews?.versions?.find((x) => x.id === ui.reviewVersion);
    if (v?.sequence) return v.sequence;
  }
  return tab.seq?.id || null;
}

export const linksOf = (tab) => tab.store.get().chatLinks || {};
// the chat a sequence is linked to (only while the sequence exists)
export function chatFor(tab, seqId) {
  const sid = seqId ? linksOf(tab)[seqId] : null;
  return sid && findSequence(tab.doc, seqId) ? sid : null;
}
// the sequence a chat is linked to
export function seqForChat(tab, sid) {
  if (!sid) return null;
  const links = linksOf(tab);
  const seqId = Object.keys(links).find((k) => links[k] === sid);
  return (seqId && tab.doc && findSequence(tab.doc, seqId)) || null;
}

// a chat's state from the live list: { live, busy, waiting, context } (live false: not running right now)
export function liveState(tab, sid) {
  const l = (tab.store.get().chatsLive || []).find((x) => x.sessionId === sid);
  return l ? { live: true, busy: !!(l.busy || l.compacting), waiting: !!l.waiting, shown: !!l.shown, context: l.context, turnStart: l.turnStart } : { live: false, busy: false };
}

// sequence context-menu entries: open its chat / start one for it / link it to the chat that's open
export function chatMenuItems(tab, seqId) {
  const sid = chatFor(tab, seqId);
  const shown = tab.store.get().chat;
  const shownSid = shown?.running && shown.agent !== 'codex' ? shown.sessionId : null;
  if (shown?.agent === 'codex') return [];
  const start = async (...args) => {
    tab.ui.set({ claudeOpen: true });
    try { await (await import('./ClaudeChat.js')).startChat(tab.projectId, ...args); } catch (err) { notify(err.message, 'error'); }
  };
  return [
    { separator: true },
    sid ? { label: 'Show its chat', icon: 'sparkle', disabled: sid === shownSid, action: () => start('resume', sid) }
      : { label: 'New chat for this sequence', icon: 'sparkle', action: () => start('new', null, { linkSequence: seqId }) },
    shownSid && shownSid !== sid ? { label: sid ? 'Link to the open chat instead' : 'Link to the open chat', icon: 'link', action: () => linkChat(tab, seqId, shownSid) } : null,
    sid ? { label: 'Unlink its chat', icon: 'x', action: () => linkChat(tab, seqId, null) } : null,
  ].filter(Boolean);
}

export async function linkChat(tab, seqId, sid) {
  try {
    const r = await post(`/api/p/${tab.projectId}/chat-links`, { sequenceId: seqId, sessionId: sid || null });
    tab.store.set({ chatLinks: r.links || {} });
    return true;
  } catch (err) { notify(err.message, 'error'); return false; }
}
