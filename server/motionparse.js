// What the Motion tab can read straight out of a composition's HTML, without asking Claude to write it any
// particular way:
//   code values  simple constants in the page's scripts (const HITS = [12, 72]; let SPEED = 1.4; FPS = 25 …)
//   css vars     custom properties in its <style> blocks (--accent: #7c5cff)
// The user's changes live in the media item's motion.edit (consts / vars) and are applied when the page is
// served, so the file Claude wrote stays untouched.

const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i;
const COLOR = /^['"]#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})['"]$/i;

// A number, string, boolean, or a one-line array of those (nested at most two deep) — a tiny scanner.
export function isLiteral(src) {
  const s = String(src ?? '').trim();
  if (!s || s.length > 4000) return false;
  let i = 0, depth = 0, expectValue = true;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  while (i < s.length) {
    ws();
    if (i >= s.length) break;
    const c = s[i];
    if (c === '[') { if (!expectValue || ++depth > 2) return false; i++; continue; }
    if (c === ']') {
      if (--depth < 0) return false;
      i++;
      expectValue = false;
      if (depth === 0) { ws(); return i === s.length; }
      continue;
    }
    if (c === ',') { if (depth === 0 || expectValue) return false; i++; expectValue = true; continue; }
    if (!expectValue) return false;
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\n') return false; i += s[i] === '\\' ? 2 : 1; }
      if (i >= s.length) return false;
      i++;
    } else if (s.startsWith('true', i)) i += 4;
    else if (s.startsWith('false', i)) i += 5;
    else {
      const m = NUM_RE.exec(s.slice(i, i + 40));
      if (!m) return false;
      i += m[0].length;
    }
    expectValue = false;
    if (depth === 0) { ws(); return i === s.length; }
  }
  return false;
}

function scriptRanges(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs) || /type\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(attrs)) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    out.push([start, start + m[2].length]);
  }
  return out;
}

// Split "A = 1, B = [2, 3]" at top-level commas, keeping offsets.
function declarators(text, base) {
  const out = [];
  let depth = 0, from = 0, q = null;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if ((c === ',' && depth === 0) || i === text.length) { out.push({ text: text.slice(from, i), at: base + from }); from = i + 1; }
  }
  return out;
}

// Cut a trailing // comment (outside strings); returns [code, comment].
function splitComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '/' && line[i + 1] === '/') return [line.slice(0, i), line.slice(i + 2).trim()];
  }
  return [line, ''];
}

export function parseCodeValues(html) {
  const out = [];
  if (!html) return out;
  const seen = new Map();
  for (const [s, e] of scriptRanges(html)) {
    const code = html.slice(s, e);
    const lineRe = /^([ \t]*)(const|let|var)[ \t]+([^\n]*)$/gm;
    let m;
    while ((m = lineRe.exec(code))) {
      const indent = m[1].replace(/\t/g, '  ').length;
      const [body, comment] = splitComment(m[3]);
      const declText = body.replace(/[\s;]+$/, '');
      const declAt = s + m.index + m[0].indexOf(m[3]);
      for (const d of declarators(declText, declAt)) {
        const dm = /^\s*([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?)\s*$/.exec(d.text);
        if (!dm || !isLiteral(dm[2])) continue;
        const name = dm[1];
        // settings, not state: const, or an UPPER_CASE let/var; no empty arrays or URLs
        if ((m[2] !== 'const' && !/^[A-Z][A-Z0-9_]*$/.test(name)) || /^\[\s*\]$/.test(dm[2]) || /^['"](https?:|\/\/)/.test(dm[2])) continue;
        const n = (seen.get(name) || 0) + 1;
        seen.set(name, n);
        const raw = dm[2];
        const start = html.indexOf(raw, d.at + d.text.indexOf('=') + 1);
        const kind = raw.startsWith('[') ? 'array' : COLOR.test(raw) ? 'color' : /^['"]/.test(raw) ? 'string' : /^(true|false)$/.test(raw) ? 'boolean' : 'number';
        out.push({ key: n > 1 ? `${name}#${n}` : name, name, value: raw, kind, label: comment, inner: indent > 0, start, end: start + raw.length });
        if (out.length >= 400) return out;
      }
    }
  }
  return out;
}

export function parseCssVars(html) {
  const out = [];
  const seen = new Set();
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const vr = /(--[\w-]+)\s*:\s*([^;}{]+?)\s*(?:;|(?=}))/g;
    let v;
    while ((v = vr.exec(m[1]))) {
      if (seen.has(v[1])) continue;
      seen.add(v[1]);
      out.push({ name: v[1], value: v[2].trim() });
    }
  }
  return out;
}

// The page with the user's code values swapped in (unknown or invalid ones are ignored).
export function applyCodeValues(html, consts) {
  if (!html || !consts || !Object.keys(consts).length) return html;
  const edits = parseCodeValues(html).filter((c) => c.key in consts && isLiteral(consts[c.key])).sort((a, b) => b.start - a.start);
  let out = html;
  for (const c of edits) out = out.slice(0, c.start) + String(consts[c.key]).trim() + out.slice(c.end);
  return out;
}
