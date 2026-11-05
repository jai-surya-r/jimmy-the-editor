// Footage keeps its own name. Claude used to give clips names of its own ("C1", "C4a") and could rename footage in the
// bin, so the timeline no longer said which file a clip was. The rule: a clip of footage (video, audio or image, not a
// motion graphic) shows its media item's name, and a media item shows its file's name.
// - Names set in the editor (Inspector, clip menu, bin) are the user's and stay.
// - Names written into project.json from outside (a Claude chat) are put back as they were (keepNames).
// - Once per project, names given before this rule are cleared (resetNames), marked by settings.originalNames.
// Motion graphics, text, solids, sequences and folders keep whatever names they are given.
export const fileName = (p) => String(p || '').split(/[\\/]/).pop() || '';
const FOOTAGE = new Set(['video', 'audio', 'image']);
const isFootageClip = (c, mediaById) => FOOTAGE.has(c.type) && !!c.media && !mediaById.get(c.media)?.motion;

// An outside edit turned `prev` into `next`: put back the names footage had (or the file's name for new media, and no
// name for new clips). Returns how many names it changed.
export function keepNames(prev, next) {
  let n = 0;
  const prevMedia = new Map((prev?.media || []).map((m) => [m.id, m]));
  for (const m of next.media) {
    if (m.motion || !m.path) continue;
    const p = prevMedia.get(m.id);
    const want = p && !p.motion && p.path === m.path ? p.name : fileName(m.path);
    if (want && m.name !== want) { m.name = want; n++; }
  }
  const mediaById = new Map(next.media.map((m) => [m.id, m]));
  const prevClips = new Map();
  for (const s of prev?.sequences || []) for (const c of s.clips) prevClips.set(c.id, c);
  for (const s of next.sequences) {
    for (const c of s.clips) {
      if (!isFootageClip(c, mediaById)) continue;
      const want = prevClips.get(c.id)?.name || '';
      if ((c.name || '') !== want) { c.name = want; n++; }
    }
  }
  // the one-time clean-up is done for good, even if the outside copy dropped the mark
  if (prev?.settings?.originalNames && !next.settings?.originalNames) { next.settings = { ...next.settings, originalNames: 1 }; n++; }
  return n;
}

// Once per project: footage clips lose their own names and media items get their file's name back. Returns how many
// names it changed, or -1 if the project was already done (nothing to save).
export function resetNames(doc) {
  if (doc.settings?.originalNames) return -1;
  let n = 0;
  for (const m of doc.media) {
    if (m.motion || !m.path) continue;
    const want = fileName(m.path);
    if (want && m.name !== want) { m.name = want; n++; }
  }
  const mediaById = new Map(doc.media.map((m) => [m.id, m]));
  for (const s of doc.sequences) for (const c of s.clips) if (isFootageClip(c, mediaById) && c.name) { c.name = ''; n++; }
  doc.settings = { ...doc.settings, originalNames: 1 };
  return n;
}
