// `claude-<name>` shortcuts in the user's shell start-up files, one per extra Claude account, so `claude-work` in a
// terminal starts Claude Code on that account. Adding an account writes one; removing it takes it out again.
// - Windows: a PowerShell function in $PROFILE (Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1, plus
//   PowerShell 7's Documents\PowerShell one when it exists), written the way people write their own.
// - macOS/Linux: an alias in ~/.zshrc (plus ~/.bashrc when it exists).
// The files keep their encoding and line endings; before a file is changed, its previous text is kept next to it
// as <file>.jimmy-backup. JIMMY_SHELL_PROFILES (paths joined by path.delimiter) replaces the list, for tests.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const isWin = process.platform === 'win32';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let documents = null;
function documentsDir() {
  // Documents may be moved (OneDrive): ask Windows where it is
  if (!documents) {
    documents = new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { windowsHide: true, timeout: 15000 },
        (err, out) => resolve((!err && String(out).trim()) || path.join(os.homedir(), 'Documents')));
    });
  }
  return documents;
}

// [{ file, main, add }]: the files to look in. New shortcuts go into `add` ones: the main file (made if missing) and
// the other shell's own file when the user has one.
async function profileFiles() {
  if (process.env.JIMMY_SHELL_PROFILES) return process.env.JIMMY_SHELL_PROFILES.split(path.delimiter).filter(Boolean).map((file, i) => ({ file, main: i === 0, add: i < 2 }));
  if (isWin) {
    const docs = await documentsDir();
    return [
      { file: path.join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'), main: true, add: true },
      { file: path.join(docs, 'WindowsPowerShell', 'profile.ps1') },
      { file: path.join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'), add: true },
      { file: path.join(docs, 'PowerShell', 'profile.ps1') },
    ];
  }
  const home = os.homedir();
  return [{ file: path.join(home, '.zshrc'), main: true, add: true }, { file: path.join(home, '.bashrc'), add: true }, { file: path.join(home, '.bash_profile') }, { file: path.join(home, '.zprofile') }];
}
const isPowerShell = (file) => /\.ps1$/i.test(file);

// text + how to write it back (BOM, UTF-16, line ending)
async function readText(file) {
  let buf;
  try { buf = await fsp.readFile(file); } catch { return null; }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le', bom: true };
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: buf.subarray(bom ? 3 : 0).toString('utf8'), enc: 'utf8', bom };
}
async function writeText(file, { text, enc, bom }, before) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (before != null) await fsp.writeFile(`${file}.jimmy-backup`, encode(before, enc, bom));
  const tmp = `${file}.jimmy-tmp`;
  await fsp.writeFile(tmp, encode(text, enc, bom));
  await fsp.rename(tmp, file);
}
function encode(text, enc, bom) {
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
}

// The folder as the shortcut names it: under the home folder it is written from $env:USERPROFILE / $HOME.
function dirExpr(dir, ps) {
  const rel = path.relative(os.homedir(), dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return ps ? `$env:USERPROFILE\\${rel}` : `$HOME/${rel.split(path.sep).join('/')}`;
  return dir;
}
function block(fn, dir, ps, eol) {
  if (ps) {
    return [`function ${fn} {`, '    $prev = $env:CLAUDE_CONFIG_DIR', `    $env:CLAUDE_CONFIG_DIR = "${dirExpr(dir, true)}"`, '    try { claude @args } finally { $env:CLAUDE_CONFIG_DIR = $prev }', '}'].join(eol);
  }
  return `alias ${fn}='CLAUDE_CONFIG_DIR="${dirExpr(dir, false)}" claude'`;
}

// Does the text already define this command?
const definesPs = (text, fn) => new RegExp(`^\\s*function\\s+${escRe(fn)}\\s*(\\{|$)`, 'im').test(text);
const definesSh = (text, fn) => new RegExp(`^\\s*(alias\\s+${escRe(fn)}=|(function\\s+)?${escRe(fn)}\\s*\\(\\))`, 'm').test(text);

// Adds `claude-<name>` for an account folder. Returns the files written.
export async function addShortcut(name, dir) {
  const fn = `claude-${name}`;
  const written = [];
  for (const { file, main, add } of await profileFiles()) {
    if (!add) continue;
    const cur = await readText(file);
    if (!cur && !main) continue;
    const ps = isPowerShell(file);
    const t = cur || { text: '', enc: 'utf8', bom: ps && isWin };
    if (ps ? definesPs(t.text, fn) : definesSh(t.text, fn)) continue;
    const eol = t.text.includes('\r\n') || (!t.text && isWin && ps) ? '\r\n' : '\n';
    const sep = !t.text ? '' : t.text.endsWith('\n') ? eol : eol + eol;
    await writeText(file, { ...t, text: `${t.text}${sep}${block(fn, dir, ps, eol)}${eol}` }, cur ? cur.text : null);
    written.push(file);
  }
  return written;
}

// Removes every shortcut that is called claude-<name> or points at the folder. Returns the files changed.
export async function removeShortcuts(name, dir) {
  const fn = `claude-${name}`;
  const folder = path.basename(dir);
  // the folder named in a path, not a longer one starting the same (.claude-work-1 but not .claude-work-10)
  const mentions = (s) => new RegExp(`${escRe(folder)}(?![\\w.-])`, 'i').test(s) && /CLAUDE_CONFIG_DIR/.test(s);
  const changed = [];
  for (const { file } of await profileFiles()) {
    const cur = await readText(file);
    if (!cur) continue;
    const next = isPowerShell(file) ? dropPs(cur.text, fn, mentions) : dropSh(cur.text, fn, mentions);
    if (next === cur.text) continue;
    await writeText(file, { ...cur, text: next }, cur.text);
    changed.push(file);
  }
  return changed;
}

// PowerShell: whole `function name { … }` blocks (braces counted), with the blank line before them
function dropPs(text, fn, mentions) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*function\s+([\w-]+)/i.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    let depth = 0, seen = false, j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
      if (seen && depth <= 0) break;
    }
    const body = lines.slice(i, j + 1).join('');
    if (m[1].toLowerCase() === fn.toLowerCase() || mentions(body)) {
      if (out.length && !out[out.length - 1].trim()) out.pop();
      i = j;
    } else out.push(lines[i]);
  }
  return out.join('');
}
// sh: `alias name=…` lines and `name() { … }` blocks
function dropSh(text, fn, mentions) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  const head = new RegExp(`^\\s*(function\\s+)?${escRe(fn)}\\s*\\(\\)`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (new RegExp(`^\\s*alias\\s+${escRe(fn)}=`).test(l) || (/^\s*alias\s+[\w-]+=/.test(l) && mentions(l))) continue;
    if (head.test(l)) {
      let depth = 0, seen = false, j = i;
      for (; j < lines.length; j++) {
        for (const ch of lines[j]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
        if (seen && depth <= 0) break;
      }
      i = j;
      continue;
    }
    out.push(l);
  }
  return out.join('');
}
