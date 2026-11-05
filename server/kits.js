// IP kits: per-IP skills and design references, stored locally in the app folder (kits/<IP>/).
// A project records which kit it belongs to in project.json ("ip": "<kit id>").
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, DATA_DIR, readJsonSafe, writeFileAtomic, sanitizeFolderName, uniqueFileName, saveUpload } from './util.js';

// in the desktop app's data folder (its own folder is read-only once installed); next to the app in the browser version
export const KITS_DIR = process.env.JIMMY_DATA_DIR ? path.join(DATA_DIR, 'kits') : path.join(APP_DIR, 'kits');
export const KIT_PARTS = ['skills', 'references', 'rules', 'notes'];

// Each kit is also a local Claude Code plugin (kits/<IP>/.claude-plugin/plugin.json + skills/<name>/SKILL.md).
// The editor loads it with --plugin-dir only into sessions of projects that belong to this IP, so its
// skills show up as /<ip>:<skill> there and nowhere else.
export const pluginName = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ip';

async function ensurePlugin(id, name) {
  const dir = path.join(KITS_DIR, id, '.claude-plugin');
  const file = path.join(dir, 'plugin.json');
  if (fs.existsSync(file)) return;
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ name: pluginName(id), description: `Skills for the ${name || id} IP (Jimmy IP kit)`, version: '1.0.0' }, null, 2) + '\n');
}

// Skill folders (skills/<name>/SKILL.md) plus any loose files.
async function skillsIn(dir) {
  const out = [];
  let ents = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const st = await fsp.stat(path.join(p, 'SKILL.md')).catch(() => null);
      out.push({ name: e.name, size: st?.size || 0, mtime: st?.mtime.toISOString() || null, skill: !!st, folder: true });
    } else if (e.isFile()) {
      const st = await fsp.stat(p);
      out.push({ name: e.name, size: st.size, mtime: st.mtime.toISOString(), skill: false });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
function frontmatterName(text) {
  const m = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/.exec(text);
  const n = m && /^name:\s*["']?([^"'\r\n]+)/m.exec(m[1]);
  return n ? n[1].trim() : null;
}

// Put an uploaded skill where Claude Code finds it: a .md becomes skills/<name>/SKILL.md (name from its
// frontmatter or the file name); a .zip/.skill archive is unpacked into skills/.
async function placeSkill(dir, file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md') {
    const text = await fsp.readFile(file, 'utf8');
    const base = path.basename(file, ext);
    const name = slug(frontmatterName(text) || (base.toUpperCase() === 'SKILL' ? 'skill' : base));
    const target = path.join(dir, name);
    await fsp.mkdir(target, { recursive: true });
    await fsp.rename(file, path.join(target, 'SKILL.md'));
    return name;
  }
  if (ext === '.zip' || ext === '.skill') {
    const tmp = path.join(dir, `.unpack-${Date.now()}`);
    await fsp.mkdir(tmp, { recursive: true });
    // Windows' own tar (bsdtar) reads .zip; a Git/GNU tar earlier on PATH would not.
    const tar = process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    try {
      await new Promise((resolve, reject) => execFile(tar, ['-xf', file, '-C', tmp], (err) => (err ? reject(err) : resolve())));
    } catch {
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.unlink(file).catch(() => {});
      throw Object.assign(new Error(`Could not unpack ${path.basename(file)}`), { status: 400 });
    }
    await fsp.unlink(file).catch(() => {});
    const top = (await fsp.readdir(tmp)).filter((n) => !n.startsWith('__MACOSX'));
    let names = [];
    if (top.includes('SKILL.md')) {
      // archive of a single skill's contents: wrap it in a folder named after the skill
      const name = slug(frontmatterName(await fsp.readFile(path.join(tmp, 'SKILL.md'), 'utf8')) || path.basename(file, ext));
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
      await fsp.rename(tmp, path.join(dir, name));
      return name;
    }
    for (const n of top) {
      await fsp.rm(path.join(dir, n), { recursive: true, force: true });
      await fsp.rename(path.join(tmp, n), path.join(dir, n));
      names.push(n);
    }
    await fsp.rm(tmp, { recursive: true, force: true });
    return names.join(', ');
  }
  return path.basename(file);
}

function kitDir(id) {
  const dir = path.join(KITS_DIR, path.basename(String(id || '')));
  if (!id || path.dirname(dir) !== KITS_DIR) throw Object.assign(new Error('Bad IP kit'), { status: 400 });
  return dir;
}

async function filesIn(dir) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of ents) {
      if (!e.isFile()) continue;
      const st = await fsp.stat(path.join(dir, e.name));
      out.push({ name: e.name, size: st.size, mtime: st.mtime.toISOString() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

export async function listKits() {
  let ents = [];
  try { ents = await fsp.readdir(KITS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(KITS_DIR, e.name);
    const meta = readJsonSafe(path.join(dir, 'kit.json'), {}) || {};
    await ensurePlugin(e.name, meta.name).catch(() => {});
    out.push({
      id: e.name, name: meta.name || e.name, createdAt: meta.createdAt || null, dir, plugin: pluginName(e.name),
      skills: await skillsIn(path.join(dir, 'skills')),
      references: await filesIn(path.join(dir, 'references')),
      rules: await filesIn(path.join(dir, 'rules')),
      notes: await filesIn(path.join(dir, 'notes')),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getKit(id) {
  return (await listKits()).find((k) => k.id === id) || null;
}

export async function createKit(name) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('Give the IP a name'), { status: 400 });
  const id = sanitizeFolderName(clean);
  const dir = path.join(KITS_DIR, id);
  if (fs.existsSync(dir)) throw Object.assign(new Error(`An IP kit called "${clean}" already exists`), { status: 409 });
  for (const part of KIT_PARTS) await fsp.mkdir(path.join(dir, part), { recursive: true });
  await writeFileAtomic(path.join(dir, 'kit.json'), JSON.stringify({ name: clean, createdAt: new Date().toISOString() }, null, 2) + '\n');
  await ensurePlugin(id, clean);
  return getKit(id);
}

// Stream an uploaded file into kits/<id>/<part>/.
export async function addKitFile(id, part, name, req) {
  if (!KIT_PARTS.includes(part)) throw Object.assign(new Error('Bad kit folder'), { status: 400 });
  const dir = path.join(kitDir(id), part);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, uniqueFileName(dir, path.basename(String(name || 'file'))));
  await saveUpload(req, file);
  if (part === 'skills') return placeSkill(dir, file);
  return path.basename(file);
}

export async function removeKitFile(id, part, name) {
  if (!KIT_PARTS.includes(part)) throw Object.assign(new Error('Bad kit folder'), { status: 400 });
  // an empty name, "." or ".." would point at the whole folder (or the whole kit)
  const file = path.basename(String(name || ''));
  if (!file || file === '.' || file === '..') throw Object.assign(new Error('Bad file name'), { status: 400 });
  await fsp.rm(path.join(kitDir(id), part, file), { recursive: true, force: true });
}

export function kitPath(id, part, name) {
  const base = kitDir(id);
  if (part && !KIT_PARTS.includes(part)) throw Object.assign(new Error('Bad kit folder'), { status: 400 });
  return part ? path.join(base, part, ...(name ? [path.basename(String(name))] : [])) : base;
}

// Launch arguments that scope a Claude session to its project's IP: load only this kit's plugin, and
// tell Claude to take skills from it (not from other IPs' skills installed on the account).
export async function kitLaunch(id) {
  const kit = id ? await getKit(id) : null;
  if (!kit) return null;
  const guard = path.join(kit.dir, '.claude-plugin', 'session-note.md');
  await writeFileAtomic(guard, `This project belongs to the IP "${kit.name}". Its IP kit is at ${kit.dir.split(path.sep).join('/')} (skills/, references/, rules/, notes/).
When you need a skill, use only skills from the "${kit.plugin}" plugin (/${kit.plugin}:<skill>) — never skills made for other IPs or pods, unless the user explicitly invokes one by name.\n`);
  return { pluginDir: kit.dir, promptFile: guard };
}
