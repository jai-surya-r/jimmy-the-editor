// Every font installed on this machine — Windows fonts, per-user fonts and Adobe Fonts (Creative Cloud) —
// read straight from the font files and served as @font-face, so the editor and the exporter can use
// all of them, including ones the browser can't see on its own (Adobe Fonts, some per-user installs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, readJsonSafe, writeFileAtomic } from './util.js';

const CACHE = path.join(DATA_DIR, 'sysfonts.json');

function fontDirs() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return [
      path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
      path.join(local, 'Microsoft', 'Windows', 'Fonts'),
      path.join(roaming, 'Adobe', 'CoreSync', 'plugins', 'livetype', 'r'),
    ];
  }
  if (process.platform === 'darwin') {
    const home = os.homedir();
    return [
      '/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts'),
      // Adobe Fonts (Creative Cloud) keeps activated fonts here; browsers can't see them otherwise
      path.join(home, 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype', '.r'),
      path.join(home, 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype', 'r'),
    ];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local', 'share', 'fonts')];
}

function listFiles(dir, depth = 0, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3) listFiles(p, depth + 1, out); }
    else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name) || !path.extname(e.name) || /^\.\d+/.test(e.name)) out.push(p);
  }
  return out;
}

// ---- minimal OpenType reader: family/style names from `name`, weight and italic from `OS/2`
function reader(file) {
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  return { read, close: () => fs.closeSync(fd) };
}
function decode(buf, platform) {
  if (platform === 0 || platform === 3) {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  return buf.toString('latin1');
}
function parseFace(r, off) {
  const head = r.read(off, 12);
  const numTables = head.readUInt16BE(4);
  const dir = r.read(off + 12, numTables * 16);
  const tables = {};
  for (let i = 0; i < numTables; i++) tables[dir.toString('latin1', i * 16, i * 16 + 4)] = { offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) };
  if (!tables.name) return null;
  const nt = r.read(tables.name.offset, Math.min(tables.name.length, 65536));
  const count = nt.readUInt16BE(2), strOff = nt.readUInt16BE(4);
  const names = {};
  const score = {};
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    if (p + 12 > nt.length) break;
    const platform = nt.readUInt16BE(p), lang = nt.readUInt16BE(p + 4), id = nt.readUInt16BE(p + 6);
    const len = nt.readUInt16BE(p + 8), o = nt.readUInt16BE(p + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
    const sc = platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : platform === 1 && lang === 0 ? 1 : 0;
    if (sc === 0 || (score[id] || 0) >= sc) continue;
    const start = strOff + o;
    if (start + len > nt.length) continue;
    names[id] = decode(nt.subarray(start, start + len), platform).replace(/\0/g, '').trim();
    score[id] = sc;
  }
  let weight = 400, italic = /italic|oblique/i.test(names[17] || names[2] || '');
  if (tables['OS/2']) {
    const os2 = r.read(tables['OS/2'].offset, 64);
    weight = os2.readUInt16BE(4) || 400;
    if (os2.length >= 64) italic = italic || !!(os2.readUInt16BE(62) & 1);
  }
  const family = names[16] || names[1];
  if (!family || family.startsWith('.')) return null;
  return { family, style: names[17] || names[2] || 'Regular', full: names[4] || family, ps: names[6] || '', weight: Math.min(1000, Math.max(1, weight)), italic };
}
function parseFile(file) {
  let r = null;
  try {
    r = reader(file); // a font that can't be opened (in use, no access) is skipped like one that can't be parsed
    const magic = r.read(0, 12);
    const tag = magic.toString('latin1', 0, 4);
    if (tag === 'ttcf') {
      const n = Math.min(magic.readUInt32BE(8), 64);
      const offs = r.read(12, n * 4);
      const faces = [];
      for (let i = 0; i < n; i++) { const f = parseFace(r, offs.readUInt32BE(i * 4)); if (f) faces.push({ ...f, index: i, collection: true }); }
      return faces;
    }
    if (!['\0\x01\0\0', 'OTTO', 'true'].includes(tag)) return [];
    const f = parseFace(r, 0);
    return f ? [{ ...f, index: 0, collection: false, ext: tag === 'OTTO' ? 'otf' : 'ttf' }] : [];
  } catch { return []; } finally { r?.close(); }
}

let faces = null;
let scanning = null;

export function scanSystemFonts() {
  if (faces) return Promise.resolve(faces);
  if (scanning) return scanning;
  scanning = new Promise((resolve) => setImmediate(() => {
    const cache = readJsonSafe(CACHE, {}) || {};
    const next = {};
    const out = [];
    for (const dir of fontDirs()) {
      for (const file of listFiles(dir)) {
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        const key = `${file}|${st.size}|${st.mtimeMs}`;
        const parsed = cache[key] || parseFile(file);
        next[key] = parsed;
        for (const f of parsed) out.push({ ...f, file });
      }
    }
    writeFileAtomic(CACHE, JSON.stringify(next)).catch(() => {});
    out.forEach((f, i) => { f.id = i; });
    faces = out;
    scanning = null;
    resolve(out);
  }));
  return scanning;
}

export async function systemFontFamilies() {
  const list = await scanSystemFonts();
  return [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}

export async function systemFontsCss() {
  const list = await scanSystemFonts();
  const q = (s) => s.replace(/["\\]/g, '');
  return list.map((f) => {
    // Faces inside a .ttc collection can't be addressed by URL, so those go by their installed name.
    const src = f.collection
      ? `local("${q(f.full)}")${f.ps ? `, local("${q(f.ps)}")` : ''}`
      : `local("${q(f.full)}"), url("/api/sysfont/${f.id}") format("${f.ext === 'otf' ? 'opentype' : 'truetype'}")`;
    return `@font-face { font-family: "${q(f.family)}"; src: ${src}; font-weight: ${f.weight}; font-style: ${f.italic ? 'italic' : 'normal'}; font-display: block; }`;
  }).join('\n');
}

export async function systemFontFile(id) {
  const list = await scanSystemFonts();
  const f = list[Number(id)];
  return f && !f.collection ? { file: f.file, type: f.ext === 'otf' ? 'font/otf' : 'font/ttf' } : null;
}
