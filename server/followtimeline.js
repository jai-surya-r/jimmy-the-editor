// Review comments follow the timeline. When a sequence changes (a clip moves, a motion graphic gets longer or
// shorter), the open comments on its live Timeline round move with the moment they were left on:
//   - on a clip that still exists: same place in the clip. A clip that got longer or shorter stretches its
//     comments with it (a motion graphic retimed from 40 s to 50 s: a comment at 30 s goes to 37.5 s);
//   - in a gap or past the end: they move with the end of the clip before them.
// Resolved comments, and comments on rendered versions (a fixed video file), stay where they are.

const r3 = (x) => Math.round(x * 1000) / 1000;
const end = (c) => c.start + c.duration;
const isVideo = (c) => !/^A/i.test(String(c.track || ''));

// the clip a moment belongs to: the topmost video clip under it (else any clip), that still exists
function under(seq0, ids1, t) {
  const hits = seq0.clips.filter((c) => ids1.has(c.id) && c.start <= t + 1e-6 && t < end(c) - 1e-6);
  hits.sort((a, b) => (isVideo(b) - isVideo(a)) || String(b.track).localeCompare(String(a.track), undefined, { numeric: true }));
  return hits[0] || null;
}

export function mapTime(seq0, seq1, t) {
  const by1 = new Map(seq1.clips.map((c) => [c.id, c]));
  const ids1 = new Set(by1.keys());
  const c0 = under(seq0, ids1, t);
  if (c0) {
    const c1 = by1.get(c0.id);
    const same = Math.abs((c1.in || 0) - (c0.in || 0)) < 1e-6;
    const o = t - c0.start;
    const o1 = same && c0.duration > 0 ? o * (c1.duration / c0.duration) : Math.min(o, c1.duration);
    return r3(c1.start + o1);
  }
  // a gap or past the end: with the end of the clip before it
  const before = seq0.clips.filter((c) => ids1.has(c.id) && end(c) <= t + 1e-6).sort((a, b) => end(b) - end(a))[0];
  if (before) return r3(Math.max(0, t + end(by1.get(before.id)) - end(before)));
  return t;
}

const sig = (s) => JSON.stringify((s?.clips || []).map((c) => [c.id, c.start, c.duration, c.in || 0]));

// Returns the number of comments moved (reviews is changed in place).
export function followTimeline(doc0, doc1, reviews) {
  if (!doc0 || !doc1 || !reviews?.comments?.length) return 0;
  const live = new Map();
  for (const v of reviews.versions || []) if (v.kind === 'timeline' && !(live.get(v.sequence)?.number >= v.number)) live.set(v.sequence, v);
  let moved = 0;
  for (const [seqId, v] of live) {
    const s0 = doc0.sequences?.find((s) => s.id === seqId);
    const s1 = doc1.sequences?.find((s) => s.id === seqId);
    if (!s0 || !s1 || sig(s0) === sig(s1)) continue;
    for (const c of reviews.comments) {
      if (c.version !== v.id || c.resolved) continue;
      const t = mapTime(s0, s1, c.t);
      const tEnd = c.tEnd != null ? Math.max(t, mapTime(s0, s1, c.tEnd)) : c.tEnd;
      if (t !== c.t || tEnd !== c.tEnd) { c.t = t; c.tEnd = tEnd; moved++; }
    }
  }
  return moved;
}
