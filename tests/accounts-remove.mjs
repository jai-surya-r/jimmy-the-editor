// Claude accounts can be removed from the computer: signed out, their claude-<name> command taken out of the shell
// profile, their folder moved to the Recycle Bin, projects that used them back on the default account. Adding an
// account writes its claude-<name> command. Runs the desktop app with a scratch home folder, scratch shell profiles
// and a scratch "Recycle Bin", so no real account, profile or bin is touched.
//   JIMMY_APP=electron node tests/accounts-remove.mjs [folder for a screenshot]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, WORK, PORT } from './lib/server.mjs';

if (process.env.JIMMY_APP !== 'electron') { console.error('run with JIMMY_APP=electron'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DEBUG_PORT = 9353;
const BASE = path.join(WORK, 'accounts-remove');
const HOME = path.join(BASE, 'home');
const TRASH = path.join(BASE, 'trash');
const PS = path.join(BASE, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
const ZSH = path.join(BASE, '.zshrc');
const CONFIG = path.join(WORK, 'app-data', 'config.json');
fs.rmSync(BASE, { recursive: true, force: true });

// scratch accounts: the default one and two more, each with a settings file and a chat
const account = (name) => {
  const dir = path.join(HOME, name);
  fs.mkdirSync(path.join(dir, 'projects', 'C--x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'projects', 'C--x', 'chat.jsonl'), '{"type":"user"}\n');
  return dir;
};
account('.claude');
const alpha = account('.claude-alpha');
const beta = account('.claude-beta');
// a real-world $PROFILE (CRLF), with a command for each account and something else of theirs
fs.mkdirSync(path.dirname(PS), { recursive: true });
const fn = (n) => [`function claude-${n} {`, '    $prev = $env:CLAUDE_CONFIG_DIR', `    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-${n}"`, '    try { claude @args } finally { $env:CLAUDE_CONFIG_DIR = $prev }', '}'].join('\r\n');
fs.writeFileSync(PS, `function ae { node "C:\\ae.js" $args }\r\n\r\n${fn('alpha')}\r\n\r\n${fn('beta')}\r\n`);
fs.writeFileSync(ZSH, 'alias ll="ls -la"\nalias claude-beta=\'CLAUDE_CONFIG_DIR="$HOME/.claude-beta" claude\'\n');
// projects set to use beta, and beta as the app's default choice
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
const cfg0 = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg0, projectAccounts: { p_one: beta, p_two: alpha }, claudeConfigDir: beta }, null, 2));

const env = { JIMMY_DEBUG_PORT: String(DEBUG_PORT), USERPROFILE: HOME, HOME, JIMMY_TRASH_DIR: TRASH, JIMMY_SHELL_PROFILES: [PS, ZSH].join(path.delimiter) };
const srv = await startServer({ env, visible: true });
let page;
try {
  // ------------------------------------------------------------ adding writes the command
  const { account: g } = await api('POST', '/api/accounts', { name: 'Gamma' });
  ok(fs.existsSync(path.join(HOME, '.claude-gamma', 'settings.json')), 'adding an account makes its folder');
  const ps1 = fs.readFileSync(PS, 'utf8');
  ok(/function claude-gamma \{\r\n    \$prev = \$env:CLAUDE_CONFIG_DIR\r\n    \$env:CLAUDE_CONFIG_DIR = "\$env:USERPROFILE\\\.claude-gamma"/.test(ps1), 'and writes its claude-gamma function into $PROFILE, like the others (CRLF kept)');
  ok(/alias claude-gamma='CLAUDE_CONFIG_DIR="\$HOME\/\.claude-gamma" claude'/.test(fs.readFileSync(ZSH, 'utf8')), '…and an alias into ~/.zshrc');
  ok(g.shortcuts?.length === 2, `the app is told where (${g.shortcuts?.length} files)`);

  // ------------------------------------------------------------ the window
  page = await connectPage();
  await page.call(() => import('/js/ui/accounts.js').then((m) => { m.openAccounts(); }));
  const rows = () => page.call(() => [...document.querySelectorAll('.acct-row')].map((r) => ({ name: r.querySelector('b')?.textContent, remove: !!r.querySelector('.acct-remove') })));
  let list = [];
  for (let i = 0; i < 100; i++) { list = await rows().catch(() => []); if (list.length >= 4) break; await sleep(200); }
  if (process.argv[2]) { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.argv[2], 'accounts.png'), Buffer.from(data, 'base64')); }
  ok(list.length === 4, `the window lists the 4 accounts (${list.map((r) => r.name).join(', ')})`);
  ok(list.find((r) => r.name === 'Default') && !list.find((r) => r.name === 'Default').remove, 'the default account has no Remove button');
  ok(['alpha', 'beta', 'gamma'].every((n) => list.find((r) => r.name === n)?.remove), 'every other account has one');

  // ------------------------------------------------------------ removing beta through the window
  await page.call(() => [...document.querySelectorAll('.acct-row')].find((r) => r.querySelector('b')?.textContent === 'beta').querySelector('.acct-remove').click());
  let text = '';
  for (let i = 0; i < 30; i++) { text = await page.call(() => document.querySelector('.modal')?.textContent || ''); if (/Remove the account/.test(text)) break; await sleep(100); }
  const [binName, profileName] = process.platform === 'win32' ? [/Recycle Bin/, /\$PROFILE/] : [/Trash/, /~\/\.zshrc/];
  ok(/Remove the account "beta"\?/.test(text) && binName.test(text) && profileName.test(text) && /\.claude-beta/.test(text), `a confirmation says what goes where (${binName.source}, ${profileName.source})`);
  // Cancel first: nothing happens
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Cancel').click());
  for (let i = 0; i < 30; i++) { if ((await rows().catch(() => [])).length === 4) break; await sleep(100); }
  ok(fs.existsSync(beta) && (await rows()).length === 4, 'Cancel leaves the account and reopens the window');
  await page.call(() => [...document.querySelectorAll('.acct-row')].find((r) => r.querySelector('b')?.textContent === 'beta').querySelector('.acct-remove').click());
  for (let i = 0; i < 30; i++) { if (await page.call(() => [...document.querySelectorAll('.modal button')].some((b) => b.textContent.trim() === 'Remove account'))) break; await sleep(100); }
  await page.call(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Remove account').click());
  for (let i = 0; i < 100; i++) { list = await rows().catch(() => []); if (list.length === 3) break; await sleep(200); }
  ok(list.length === 3 && !list.some((r) => r.name === 'beta'), 'the window opens again without beta');
  ok(!fs.existsSync(beta) && fs.existsSync(path.join(TRASH, '.claude-beta', 'projects', 'C--x', 'chat.jsonl')), 'its folder, chat history included, is in the Recycle Bin');
  const after = fs.readFileSync(PS, 'utf8');
  ok(!/claude-beta/.test(after) && /function claude-alpha/.test(after) && /function claude-gamma/.test(after) && /function ae/.test(after), 'claude-beta is gone from $PROFILE; the other functions stay');
  ok(!/\n[^\r\n]*\n/.test(after.replace(/\r\n/g, '')) && !/(\r\n){3}/.test(after), '…the file keeps its CRLF line endings and no gap is left');
  ok(fs.existsSync(`${PS}.jimmy-backup`) && /claude-beta/.test(fs.readFileSync(`${PS}.jimmy-backup`, 'utf8')), '…and the previous text is kept as a backup next to it');
  ok(!/claude-beta/.test(fs.readFileSync(ZSH, 'utf8')) && /alias ll=/.test(fs.readFileSync(ZSH, 'utf8')), 'its alias is gone from ~/.zshrc');
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  ok(cfg.projectAccounts.p_one === null && cfg.projectAccounts.p_two === alpha, 'a project that used it is back on the default account; others keep theirs');
  ok(!cfg.claudeConfigDir, 'the app\'s default choice no longer points at it');
  const st = await api('GET', '/api/state');
  ok(!(st.claudeProfiles || []).some((p) => /claude-beta/.test(p.dir || p)), 'the Claude panel\'s account list no longer has it');

  // ------------------------------------------------------------ guards
  const err = await api('POST', '/api/accounts/remove', { dir: path.join(HOME, '.claude') }).then(() => null, (e) => e.message);
  ok(/400/.test(err || '') && fs.existsSync(path.join(HOME, '.claude')), 'the default account can\'t be removed');
  const err2 = await api('POST', '/api/accounts/remove', { dir: path.join(HOME, '.claude-nobody') }).then(() => null, (e) => e.message);
  ok(/404/.test(err2 || ''), 'an unknown folder is refused');
  // removing through the API: an account with a name used as a prefix of another stays apart
  fs.mkdirSync(path.join(HOME, '.claude-alpha-2'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude-alpha-2', 'settings.json'), '{}\n');
  fs.appendFileSync(PS, `\r\n${fn('alpha-2')}\r\n`);
  await api('POST', '/api/accounts/remove', { dir: alpha });
  const last = fs.readFileSync(PS, 'utf8');
  ok(!/function claude-alpha \{/.test(last) && /function claude-alpha-2 \{/.test(last) && fs.existsSync(path.join(HOME, '.claude-alpha-2')), 'removing alpha leaves alpha-2 and its function alone');
} catch (e) {
  console.error(e);
  failed++;
} finally {
  page?.close();
  await srv.stop();
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  for (const k of ['projectAccounts', 'claudeConfigDir']) { if (k in cfg0) cfg[k] = cfg0[k]; else delete cfg[k]; }
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}
console.log(failed ? `accounts-remove: ${failed} failed` : 'accounts-remove: all checks passed');
process.exit(failed ? 1 : 0);

async function connectPage() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}/`) && !/render\.html|motion/.test(t.url)); } catch { /* not yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the editor window did not show up on the DevTools port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++seq; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const call = async (fn, ...a) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await call(() => !!window.__jimmy).catch(() => false)) break; await sleep(200); }
  return { send, call, close: () => ws.close() };
}
