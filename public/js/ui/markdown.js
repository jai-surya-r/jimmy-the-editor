// Small, safe Markdown → HTML for chat messages (everything is escaped first; links are http(s) only).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  const codes = [];
  const links = [];
  const link = (href, label) => { links.push(`<a href="${href}" target="_blank" rel="noopener">${label}</a>`); return `\u0001${links.length - 1}\u0001`; };
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => link(href, label))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, (_, pre, href) => pre + link(href, href))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]).replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));

export function markdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const [, indent, mark, lang] = fence; // a block under a list item is indented with it: that indent is not code
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(mark)) { const l = lines[i++]; body.push(l.startsWith(indent) ? l.slice(indent.length) : l); }
      i++;
      out.push(`<div class="md-code"><div class="md-code-head"><span>${esc(lang || 'code')}</span><button class="md-copy" data-copy>Copy</button></div><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { const n = Math.min(6, h[1].length + 2); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      // a list, with nested items by indentation
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
        if (m) { items.push({ ind: m[1].length, ol: /\d/.test(m[2]), n: parseInt(m[2], 10), text: m[3] }); i++; continue; }
        if (/^\s*(```|~~~)/.test(lines[i])) break; // a code block under an item is shown as one, below the list
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      out.push(list(items, 0, items.length));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

function list(items, a, b) {
  const base = items[a].ind;
  const tag = items[a].ol ? 'ol' : 'ul';
  let html = tag === 'ol' && items[a].n > 1 ? `<ol start="${items[a].n}">` : `<${tag}>`;
  for (let i = a; i < b;) {
    let j = i + 1;
    while (j < b && items[j].ind > base) j++;
    const task = items[i].text.match(/^\[([ xX])\]\s+(.*)/);
    const body = task ? `<span class="md-task ${task[1] !== ' ' ? 'is-done' : ''}">${inline(task[2])}</span>` : inline(items[i].text);
    html += `<li>${body}${j > i + 1 ? list(items, i + 1, j) : ''}</li>`;
    i = j;
  }
  return `${html}</${tag}>`;
}
