// Claude accounts: see who is signed in on each profile, sign in or out, add another account or remove one.
// Signing in is Claude Code's own browser sign-in (`claude auth login`), started by the server for the
// chosen profile; nothing is typed into this app. Accounts are independent of each other.
import { html, Modal, Button, Icon } from './common.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { get, post } from '../core/api.js';
import { app } from '../core/app.js';
import { openDialog, notify, dialogCaller } from '../core/notify.js';
import { confirmDialog } from './dialogs.js';

const PLAN = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

// signIn: a profile folder to start signing in to right away (e.g. the one a chat just failed on)
export function AccountsDialog({ close, onBack, signIn }) {
  const [accounts, setAccounts] = useState(null);
  const [login, setLogin] = useState(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const load = (fresh) => get(`/api/accounts${fresh ? '?fresh=1' : ''}`).then((r) => { setAccounts(r.accounts); return r.accounts; })
    .catch((e) => { notify(e.message, 'error'); setAccounts((a) => a || []); return []; });
  const refreshApp = async () => { try { app.set({ server: await get('/api/state') }); } catch { /* offline */ } };

  const begin = async (dir) => {
    setCode('');
    try { setLogin((await post('/api/accounts/login', { dir })).login); } catch (err) { notify(err.message, 'error'); }
  };
  useEffect(() => {
    load(true).then((list) => {
      if (!signIn || started.current) return;
      started.current = true;
      const same = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const a = (list || []).find((x) => same(x.dir) === same(signIn));
      if (a && !a.loggedIn) begin(a.dir);
    });
  }, []);

  // follow a running sign-in until Claude Code reports the result
  useEffect(() => {
    if (login?.state !== 'waiting') return undefined;
    const t = setInterval(async () => {
      try {
        const l = (await get(`/api/accounts/login/${login.id}`)).login;
        if (l.state === 'waiting') { if (l.url !== login.url || l.wantsCode !== login.wantsCode) setLogin(l); return; }
        setLogin(l);
        if (l.state === 'done') {
          notify(`Signed in${l.account?.email ? ` as ${l.account.email}` : ''}. Start a new chat to use it.`, 'success');
          setLogin(null);
        }
        await load(true);
        refreshApp();
      } catch { /* the server went away: the socket banner says so */ }
    }, 1000);
    return () => clearInterval(t);
  }, [login?.id, login?.state, login?.url, login?.wantsCode]);

  const cancel = async () => {
    if (login?.state === 'waiting') await post(`/api/accounts/login/${login.id}/cancel`).catch(() => {});
    setLogin(null);
  };
  const add = async () => {
    if (busy || notInstalled || !name.trim()) return;
    setBusy(true);
    try {
      const r = await post('/api/accounts', { name });
      setName('');
      await load(true);
      await refreshApp();
      await begin(r.account.dir);
    } catch (err) { notify(err.message, 'error'); }
    setBusy(false);
  };
  const signOut = async (a) => {
    setBusy(true);
    try { await post('/api/accounts/logout', { dir: a.dir }); notify(`Signed out of ${a.name}`, 'info'); await load(true); } catch (err) { notify(err.message, 'error'); }
    setBusy(false);
  };
  // Removing steps aside for the confirmation (one dialog at a time), then this window opens again.
  const remove = async (a) => {
    const caller = dialogCaller();
    const isWin = /Win/.test(navigator.platform || '');
    const bin = isWin ? 'Recycle Bin' : 'Trash';
    const yes = await confirmDialog(`Remove the account "${a.name}"?`,
      `${a.loggedIn ? `It is signed out${a.email ? ` (${a.email})` : ''}, its` : 'Its'} claude-${a.name} command is taken out of your ${isWin ? 'PowerShell profile ($PROFILE)' : 'shell profile (~/.zshrc)'}, and its folder ${a.dir}, with this account's chat history, goes to the ${bin}. Chats running on it stop, and projects that used it switch to the default account.`,
      'Remove account');
    if (yes) {
      try {
        const r = await post('/api/accounts/remove', { dir: a.dir });
        notify(`Removed ${a.name}${r.account?.shortcuts?.length ? ', and its claude-' + a.name + ' command' : ''}. Its folder is in the ${bin}.`, 'success');
        await refreshApp();
      } catch (err) { notify(err.message, 'error'); }
    }
    openDialog(AccountsDialog, { onBack }).then(caller);
  };
  const submitCode = async () => {
    if (!code.trim()) return;
    try { await post(`/api/accounts/login/${login.id}/code`, { code }); setCode(''); } catch (err) { notify(err.message, 'error'); }
  };
  const done = async () => { await cancel(); close(null); onBack?.(); };
  const waitingFor = login?.state === 'waiting' ? accounts?.find((a) => a.dir === login.dir) : null;
  const notInstalled = accounts?.length && accounts.every((a) => a.installed === false);

  return html`<${Modal} title="Claude accounts" onClose=${done} width=${560}
    footer=${html`<span class="muted">Each project uses the account picked for it in the Claude panel.</span><div class="spacer"></div><${Button} onClick=${done}>Done</${Button}>`}>
    ${!accounts ? html`<div class="loading-inline"><span class="spinner"></span> Checking accounts…</div>` : html`<div class="form accounts">
      ${notInstalled ? html`<div class="error-box">Claude Code isn't installed on this computer (the <code>claude</code> command was not found). Install Claude Code (claude.com/claude-code) and open this again.</div>` : null}
      ${accounts.map((a) => html`<div class="acct-row" key=${a.dir}>
        <span class=${`acct-dot${a.loggedIn ? ' is-on' : ''}`}></span>
        <span class="acct-text"><b>${a.name}</b>
          <span class="muted">${a.loggedIn ? `${a.email || 'Signed in'}${a.plan ? ` · ${PLAN[a.plan] || a.plan}` : ''}${a.org && !(a.email && a.org.includes(a.email)) ? ` · ${a.org}` : ''}` : 'Not signed in'}</span>
          <span class="acct-path" title=${a.dir}>${a.dir}</span></span>
        <span class="acct-actions">
          ${a.loggedIn
            ? html`<${Button} disabled=${busy || !!waitingFor} onClick=${() => signOut(a)}>Sign out</${Button}>`
            : html`<${Button} kind="primary" disabled=${busy || !!waitingFor || a.installed === false} onClick=${() => begin(a.dir)}>Sign in</${Button}>`}
          ${a.isDefault ? null : html`<${Button} icon="trash" class="acct-remove" disabled=${busy || !!waitingFor} title=${`Remove ${a.name} from this computer`} onClick=${() => remove(a)}>Remove</${Button}>`}
        </span>
      </div>`)}

      ${waitingFor ? html`<div class="acct-login">
        <div class="acct-login-head"><span class="spinner spinner-xs"></span><b>Signing in to ${waitingFor.name}…</b></div>
        <div>Claude's sign-in page opened in your browser. Approve it there and this window updates by itself.</div>
        ${login.url ? html`<div><button class="link-btn" onClick=${() => window.open(login.url, '_blank', 'noopener')}><${Icon} name="external" size=${12} /> The page didn't open? Open it here</button></div>` : null}
        ${login.wantsCode ? html`<div class="field-row" style=${{ gap: '6px', alignItems: 'center' }}>
          <input class="input" placeholder="Only if the page shows a code: paste it here" value=${code} onInput=${(e) => setCode(e.target.value)}
            onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') submitCode(); }} />
          <${Button} disabled=${!code.trim()} onClick=${submitCode}>Submit</${Button}></div>` : null}
        <div><${Button} onClick=${cancel}>Cancel sign-in</${Button}></div>
      </div>` : null}
      ${login?.state === 'error' ? html`<div class="error-box">${login.message} <button class="link-btn" onClick=${() => begin(login.dir)}>Try again</button></div>` : null}

      <div class="storage-head">Add another account</div>
      <div class="field-row" style=${{ gap: '6px', alignItems: 'center' }}>
        <input class="input" placeholder="Name it, e.g. work or personal" value=${name} disabled=${!!waitingFor} onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} />
        <span style=${{ flex: 'none' }}><${Button} icon="plus" disabled=${busy || !name.trim() || !!waitingFor || notInstalled} onClick=${add}>Add and sign in</${Button}></span>
      </div>
      <div class="dialog-hint">Accounts are kept apart: each has its own sign-in, chat history and usage limits, and a project only ever uses the one you pick for it. Each added account also gets a <code>claude-name</code> command for terminals. Signing in happens on Claude's own page in your browser; nothing is entered here.</div>
    </div>`}
  </${Modal}>`;
}

export const openAccounts = (opts = {}) => openDialog(AccountsDialog, opts);
