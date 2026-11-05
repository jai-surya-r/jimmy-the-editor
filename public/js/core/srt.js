// SRT / WebVTT caption parsing and SRT export.

function parseStamp(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/.exec(s.trim());
  if (!m) return null;
  return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
}

export function parseSubtitles(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').replace(/^WEBVTT.*\n/, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseStamp(a), end = parseStamp(b);
    if (start == null || end == null) continue;
    const body = lines.slice(i + 1).join('\n').replace(/<\/?[a-z][^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function stamp(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(clips) {
  return clips
    .filter((c) => c.type === 'text')
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.start + c.duration)}\n${c.text}\n`)
    .join('\n');
}
