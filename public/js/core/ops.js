// Timeline editing operations. They mutate a draft project/sequence in place (the caller clones).
import {
  uid, clipEnd, fitScale, usesSourceTime, deepClone, videoTracks, audioTracks,
  DEFAULT_TRANSFORM, CAPTION_STYLE, DEFAULT_TEXT_STYLE, normalizeTextStyle, isAnimated, propAt, staticValue,
  FX_PROPS, CROP_PROPS, DEFAULT_EFFECTS, DEFAULT_CROP, clamp, segmentHandles, DEFAULT_BELOW, BELOW_PROPS, findSequence, sequenceDuration,
  isNestAudio, sequenceHasSound,
} from './model.js';

const EPS = 1e-6;

// Stretch keyframe times by r; bezier handle speeds (units/second) shrink by the same factor.
const scaleSide = (h, r) => (h ? { ...h, speed: h.speed / r } : h);
function scaleKeys(list, r) {
  return list.map((k) => {
    const o = { ...k, t: k.t * r };
    if (k.in) o.in = scaleSide(k.in, r);
    if (k.out) o.out = scaleSide(k.out, r);
    return o;
  });
}

export function shiftKeyframes(c, dt) {
  if (!c.keyframes) return;
  for (const p of Object.keys(c.keyframes)) c.keyframes[p] = c.keyframes[p].map((k) => ({ ...k, t: k.t + dt }));
}

// Move a clip's head later by `delta` seconds (timeline) keeping its content in place.
export function trimHead(c, delta) {
  c.start += delta;
  c.duration -= delta;
  if (usesSourceTime(c)) c.in = Math.max(0, (c.in || 0) + delta * (c.speed || 1));
  shiftKeyframes(c, -delta);
  return c;
}

// Overwrite: remove/trim/split whatever sits on `trackId` inside [start, end).
export function clearRange(seq, trackId, start, end, exclude = new Set()) {
  const out = [];
  for (const c of seq.clips) {
    if (c.track !== trackId || exclude.has(c.id)) { out.push(c); continue; }
    const cs = c.start, ce = clipEnd(c);
    if (ce <= start + EPS || cs >= end - EPS) { out.push(c); continue; }
    if (cs >= start - EPS && ce <= end + EPS) continue;
    if (cs < start && ce > end) {
      const left = deepClone(c);
      left.duration = start - cs;
      left.transitionOut = null;
      if (left.type === 'audio') left.fadeOut = 0;
      const right = trimHead(deepClone(c), end - cs);
      right.id = uid('c');
      right.link = null;
      right.transitionIn = null;
      if (right.type === 'audio') right.fadeIn = 0;
      out.push(left, right);
      continue;
    }
    if (cs < start) {
      const left = deepClone(c);
      left.duration = start - cs;
      out.push(left);
      continue;
    }
    out.push(trimHead(deepClone(c), end - cs));
  }
  seq.clips = out;
}

// Safety net run after every edit: no two clips on one track may overlap. Where they do, the
// clip that starts later wins and the earlier one is cut short (or dropped if nothing is left).
export function resolveOverlaps(seq) {
  const byTrack = new Map();
  for (const c of seq.clips) {
    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track).push(c);
  }
  const drop = new Set();
  for (const list of byTrack.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.start - b.start);
    let prev = list[0];
    for (let i = 1; i < list.length; i++) {
      const c = list[i];
      if (c.start < clipEnd(prev) - EPS) {
        prev.duration = c.start - prev.start;
        if (prev.duration <= EPS) drop.add(prev.id);
        else {
          if (prev.transitionOut && prev.transitionOut.duration > prev.duration) prev.transitionOut = null;
          if (prev.fadeOut) prev.fadeOut = Math.min(prev.fadeOut, prev.duration);
        }
      }
      prev = c;
    }
  }
  if (drop.size) seq.clips = seq.clips.filter((c) => !drop.has(c.id));
  return drop.size;
}

export function linkedIds(seq, ids) {
  const set = new Set(ids);
  const links = new Set(seq.clips.filter((c) => set.has(c.id) && c.link).map((c) => c.link));
  for (const c of seq.clips) if (c.link && links.has(c.link)) set.add(c.id);
  return set;
}

// Split one clip at timeline time t. Returns the new right-hand clip (or null).
export function splitClip(seq, clip, t, linkMap) {
  if (t <= clip.start + EPS || t >= clipEnd(clip) - EPS) return null;
  const right = trimHead(deepClone(clip), t - clip.start);
  right.id = uid('c');
  right.transitionIn = null;
  clip.duration = t - clip.start;
  clip.transitionOut = null;
  if (clip.type === 'audio') { clip.fadeOut = 0; right.fadeIn = 0; }
  if (clip.link && linkMap) {
    if (!linkMap.has(clip.link)) linkMap.set(clip.link, uid('l'));
    right.link = linkMap.get(clip.link);
  }
  seq.clips.push(right);
  return right;
}

// Split at t: the given clip ids (plus linked partners), or every clip on unlocked tracks.
export function splitAt(seq, t, ids) {
  const locked = new Set(seq.tracks.filter((tr) => tr.locked).map((tr) => tr.id));
  const targets = ids && ids.size ? linkedIds(seq, ids) : null;
  const linkMap = new Map();
  const created = [];
  for (const c of [...seq.clips]) {
    if (locked.has(c.track)) continue;
    if (targets && !targets.has(c.id)) continue;
    const r = splitClip(seq, c, t, linkMap);
    if (r) created.push(r.id);
  }
  return created;
}

export function deleteClips(seq, ids, { ripple = false } = {}) {
  const removed = seq.clips.filter((c) => ids.has(c.id));
  seq.clips = seq.clips.filter((c) => !ids.has(c.id));
  if (!ripple) return;
  // close the gaps on each affected track (latest first so earlier shifts don't disturb later ones)
  for (const r of removed.sort((a, b) => b.start - a.start)) {
    const end = clipEnd(r);
    for (const c of seq.clips) if (c.track === r.track && c.start >= end - EPS) c.start = Math.max(0, c.start - r.duration);
  }
}

// Premiere's Ripple Trim Previous / Next Edit to Playhead (Q / W). The clips under the playhead (the selected ones
// among them, if any) give the nearest edit before it ('prev') or after it ('next'); the time between that edit and
// the playhead is cut out of every unlocked track and everything after it closes up, so the tracks stay in sync.
// Returns the range removed, or null when the playhead isn't over a clip.
export function rippleTrimToPlayhead(seq, t, dir, ids) {
  const locked = new Set(seq.tracks.filter((tr) => tr.locked).map((tr) => tr.id));
  const under = seq.clips.filter((c) => !locked.has(c.track) && c.start < t - EPS && clipEnd(c) > t + EPS);
  const picked = ids?.size ? under.filter((c) => ids.has(c.id)) : [];
  const from = picked.length ? picked : under;
  if (!from.length) return null;
  const a = dir === 'prev' ? Math.max(...from.map((c) => c.start)) : t;
  const b = dir === 'prev' ? t : Math.min(...from.map(clipEnd));
  if (b - a < EPS) return null;
  for (const tr of seq.tracks) {
    if (locked.has(tr.id)) continue;
    clearRange(seq, tr.id, a, b);
    for (const c of seq.clips) if (c.track === tr.id && c.start >= b - EPS) c.start -= b - a;
  }
  return [a, b];
}

export function gapAt(seq, trackId, t) {
  const cs = seq.clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const c of cs) {
    if (t < c.start) return t >= prevEnd ? { start: prevEnd, end: c.start } : null;
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  return null; // after the last clip is not a gap
}

// Ripple delete a gap (Premiere's way): the gap is on one track, but every unlocked track moves left by its length,
// so the sequence stays in sync. A clip on another unlocked track inside the gap's time would be run over, so then
// nothing moves and the answer names that track ({ blocked: trackId }); otherwise { moved: n }.
export function closeGap(seq, trackId, gap) {
  const len = gap.end - gap.start;
  if (!(len > EPS)) return { moved: 0 };
  const open = new Set(seq.tracks.filter((t) => !t.locked).map((t) => t.id));
  const inTheWay = seq.clips.find((c) => c.track !== trackId && open.has(c.track) && c.start < gap.end - EPS && clipEnd(c) > gap.start + EPS);
  if (inTheWay) return { blocked: inTheWay.track };
  let moved = 0;
  for (const c of seq.clips) if (open.has(c.track) && c.start >= gap.end - EPS) { c.start -= len; moved++; }
  return { moved };
}

function firstTrack(seq, kind) {
  return (kind === 'audio' ? audioTracks(seq) : videoTracks(seq))[0];
}

// Insert (overwrite) a bin item at `start`. Video with audio becomes a linked V+A pair.
export function insertMedia(project, seq, media, { start, trackId, scaling, duration, inPoint = 0 }) {
  const ids = [];
  const target = seq.tracks.find((t) => t.id === trackId);
  const scale = fitScale(media.width, media.height, seq, scaling || project.settings.defaultScaling || 'fit');
  if (media.type === 'image') {
    const tr = target?.kind === 'video' ? target : firstTrack(seq, 'video');
    const c = { id: uid('c'), type: 'image', track: tr.id, media: media.id, start, duration: duration || project.settings.stillDuration || 5, transform: { ...DEFAULT_TRANSFORM, scale } };
    clearRange(seq, tr.id, c.start, clipEnd(c));
    seq.clips.push(c);
    ids.push(c.id);
    return ids;
  }
  const full = Math.max(0.04, (media.duration || 5) - inPoint);
  const dur = Math.min(duration || full, full);
  if (media.type === 'audio') {
    const tr = target?.kind === 'audio' ? target : firstTrack(seq, 'audio');
    const c = { id: uid('c'), type: 'audio', track: tr.id, media: media.id, start, duration: dur, in: inPoint, volume: 1 };
    clearRange(seq, tr.id, c.start, clipEnd(c));
    seq.clips.push(c);
    ids.push(c.id);
    return ids;
  }
  const vt = target?.kind === 'video' ? target : firstTrack(seq, 'video');
  const link = media.hasAudio !== false ? uid('l') : null;
  const v = { id: uid('c'), type: 'video', track: vt.id, media: media.id, start, duration: dur, in: inPoint, transform: { ...DEFAULT_TRANSFORM, scale }, link };
  clearRange(seq, vt.id, v.start, clipEnd(v));
  seq.clips.push(v);
  ids.push(v.id);
  if (link) {
    const at = target?.kind === 'audio' ? target : firstTrack(seq, 'audio');
    const a = { id: uid('c'), type: 'audio', track: at.id, media: media.id, start, duration: dur, in: inPoint, volume: 1, link };
    clearRange(seq, at.id, a.start, clipEnd(a));
    seq.clips.push(a);
    ids.push(a.id);
  }
  return ids;
}

export function addTrack(seq, kind, { name = '' } = {}) {
  const prefix = kind === 'audio' ? 'a' : 'v';
  let n = seq.tracks.filter((t) => t.kind === kind).length + 1;
  while (seq.tracks.some((t) => t.id === `${prefix}${n}`)) n++;
  const tr = { id: `${prefix}${n}`, kind, name, hidden: false, muted: false, locked: false, solo: false, volume: 1 };
  if (kind === 'video') {
    const lastVideo = seq.tracks.map((t) => t.kind).lastIndexOf('video');
    seq.tracks.splice(lastVideo + 1, 0, tr);
  } else seq.tracks.push(tr);
  return tr;
}

// Topmost video track that is free over [start, end); creates one if needed.
export function freeVideoTrack(seq, start, end) {
  const vts = videoTracks(seq);
  const top = vts[vts.length - 1];
  const busy = seq.clips.some((c) => c.track === top.id && c.start < end - EPS && clipEnd(c) > start + EPS);
  return busy ? addTrack(seq, 'video') : top;
}

export function textStyleFor(seq, base = DEFAULT_TEXT_STYLE) {
  const k = Math.min(seq.width, seq.height) / 1080;
  return normalizeTextStyle({ ...base, size: Math.round(base.size * k) });
}

export function addText(seq, { start, duration = 3, text = 'Your text here', style, y = 0 } = {}) {
  const tr = freeVideoTrack(seq, start, start + duration);
  const c = {
    id: uid('c'), type: 'text', track: tr.id, start, duration, text,
    style: style || textStyleFor(seq), transform: { ...DEFAULT_TRANSFORM, y },
    transitionIn: { type: 'fade', duration: 0.25 }, transitionOut: { type: 'fade', duration: 0.25 },
  };
  seq.clips.push(c);
  return c;
}

export function addSolid(seq, { start, duration = 5, color = '#111111' } = {}) {
  const tr = freeVideoTrack(seq, start, start + duration);
  const c = { id: uid('c'), type: 'solid', track: tr.id, start, duration, color, transform: { ...DEFAULT_TRANSFORM } };
  seq.clips.push(c);
  return c;
}

// An adjustment layer over everything below it (top video track, a new one if that is busy)
export function addAdjust(seq, { start, duration = 5 } = {}) {
  const tr = freeVideoTrack(seq, start, start + duration);
  const c = { id: uid('c'), type: 'adjust', track: tr.id, start, duration, transform: { ...DEFAULT_TRANSFORM }, below: { ...DEFAULT_BELOW }, effects: { ...DEFAULT_EFFECTS }, crop: { ...DEFAULT_CROP } };
  seq.clips.push(c);
  return c;
}

// Would putting sequence `innerId` inside `outerId` make a sequence contain itself (at any depth)?
export function nestsItself(project, outerId, innerId, seen = new Set()) {
  if (innerId === outerId) return true;
  if (seen.has(innerId)) return false;
  seen.add(innerId);
  const s = findSequence(project, innerId);
  return !!s && s.clips.some((c) => (c.type === 'sequence' || isNestAudio(c)) && nestsItself(project, outerId, c.sequence, seen));
}

// A nested sequence clip of sequence `innerId` at `start` on a video track, over what is there (like dropping media).
export function insertSequence(project, seq, innerId, { start, trackId }) {
  const inner = findSequence(project, innerId);
  if (!inner || nestsItself(project, seq.id, innerId)) return null;
  const target = seq.tracks.find((t) => t.id === trackId && t.kind === 'video') || videoTracks(seq)[0];
  const duration = Math.max(1 / (seq.fps || 30), sequenceDuration(inner) || 5);
  const c = { id: uid('c'), type: 'sequence', sequence: innerId, track: target.id, start, duration, in: 0, speed: 1, transform: { ...DEFAULT_TRANSFORM } };
  clearRange(seq, target.id, start, start + duration);
  seq.clips.push(c);
  addNestedSound(project, seq, c, audioTracks(seq)[0], true);
  return c;
}

// The nested clip's sound as one audio clip linked to it (as a video file's sound is), when its sequence has any:
// on `track` (over what is there, like dropping media) or, with overwrite false, on the first audio track free
// there (or a new one).
function addNestedSound(project, seq, v, track, overwrite) {
  if (!sequenceHasSound(project, v.sequence)) return null;
  const end = clipEnd(v);
  const free = (t) => !seq.clips.some((c) => c.track === t.id && c.start < end - EPS && clipEnd(c) > v.start + EPS);
  if (!track || (!overwrite && !free(track))) track = audioTracks(seq).find(free) || addTrack(seq, 'audio');
  v.link = v.link || uid('l');
  v.audioClip = true;
  const a = { id: uid('c'), type: 'audio', sequence: v.sequence, track: track.id, start: v.start, duration: v.duration, in: v.in || 0, speed: v.speed || 1, volume: 1, link: v.link };
  if (overwrite) clearRange(seq, track.id, a.start, end);
  seq.clips.push(a);
  return a;
}

// Premiere's Nest: the clips move into a new sequence (same frame, same tracks, starting at 0) and one nested clip
// takes their place, on the lowest video track they were on. Returns { sequence, clip }.
export function nestClips(project, seq, ids, name) {
  const set = new Set(ids);
  const moving = seq.clips.filter((c) => set.has(c.id));
  if (!moving.length) return null;
  const t0 = Math.min(...moving.map((c) => c.start)), t1 = Math.max(...moving.map(clipEnd));
  const used = new Set(moving.map((c) => c.track));
  const inner = {
    id: uid('s'), name, width: seq.width, height: seq.height, fps: seq.fps, background: seq.background, folder: seq.folder || null,
    tracks: seq.tracks.filter((t) => used.has(t.id) || t === videoTracks(seq)[0] || t === audioTracks(seq)[0]).map((t) => ({ ...deepClone(t), hidden: false, muted: false, locked: false, solo: false })),
    clips: moving.map((c) => ({ ...deepClone(c), start: c.start - t0 })), markers: [],
  };
  project.sequences.push(inner);
  seq.clips = seq.clips.filter((c) => !set.has(c.id));
  const vids = videoTracks(seq).filter((t) => used.has(t.id));
  let track = vids[0];
  if (!track) track = videoTracks(seq).find((t) => !seq.clips.some((c) => c.track === t.id && c.start < t1 - EPS && clipEnd(c) > t0 + EPS)) || addTrack(seq, 'video');
  const clip = { id: uid('c'), type: 'sequence', sequence: inner.id, track: track.id, start: t0, duration: t1 - t0, in: 0, speed: 1, transform: { ...DEFAULT_TRANSFORM } };
  seq.clips.push(clip);
  // its sound: one audio clip, on the lowest audio track the moved sound was on (free now) or the first free one
  addNestedSound(project, seq, clip, audioTracks(seq).find((t) => used.has(t.id)), false);
  return { sequence: inner, clip };
}

export function addCaptions(seq, cues, { style } = {}) {
  const tr = addTrack(seq, 'video', { name: 'Captions' });
  const st = style || textStyleFor(seq, { ...CAPTION_STYLE, maxWidth: Math.round(seq.width * 0.82) });
  const y = Math.round(seq.height * (seq.height > seq.width ? 0.18 : 0.32));
  const ids = [];
  for (const cue of cues) {
    if (!(cue.end > cue.start)) continue;
    const c = { id: uid('c'), type: 'text', track: tr.id, start: cue.start, duration: cue.end - cue.start, text: cue.text, style: deepClone(st), transform: { ...DEFAULT_TRANSFORM, y } };
    seq.clips.push(c);
    ids.push(c.id);
  }
  return { track: tr, ids };
}

// ------------------------------------------------------------- keyframes / properties

export function upsertKeyframe(clip, prop, t, v, fps = 30) {
  if (!clip.keyframes) clip.keyframes = {};
  const list = clip.keyframes[prop] || (clip.keyframes[prop] = []);
  const tol = 0.5 / fps;
  const k = list.find((x) => Math.abs(x.t - t) < tol);
  if (k) k.v = v;
  else {
    list.push({ t, v, ease: 'linear' });
    list.sort((a, b) => a.t - b.t);
  }
}

export function removeKeyframeAt(clip, prop, t, fps = 30) {
  const list = clip.keyframes?.[prop];
  if (!list) return;
  const tol = 0.5 / fps;
  const next = list.filter((k) => Math.abs(k.t - t) >= tol);
  if (next.length) clip.keyframes[prop] = next;
  else {
    // removing the last key freezes the property at that value
    setStatic(clip, prop, list[0].v);
    delete clip.keyframes[prop];
  }
}

export function keyframeAt(clip, prop, t, fps = 30) {
  const tol = 0.5 / fps;
  return clip.keyframes?.[prop]?.find((k) => Math.abs(k.t - t) < tol) || null;
}

function setStatic(clip, prop, v) {
  if (prop === 'volume') clip.volume = v;
  else if (FX_PROPS.includes(prop)) clip.effects = { ...DEFAULT_EFFECTS, ...(clip.effects || {}), [prop]: v };
  else if (CROP_PROPS[prop]) clip.crop = { ...DEFAULT_CROP, ...(clip.crop || {}), [CROP_PROPS[prop]]: clamp(v, 0, 0.95) };
  else if (BELOW_PROPS[prop]) clip.below = { ...DEFAULT_BELOW, ...(clip.below || {}), [BELOW_PROPS[prop]]: v };
  else {
    if (!clip.transform) clip.transform = { ...DEFAULT_TRANSFORM };
    clip.transform[prop] = v;
  }
}

// Set a property at clip-local time t: writes a keyframe if the property is animated.
export function setPropAt(clip, prop, value, t, fps) {
  if (isAnimated(clip, prop)) upsertKeyframe(clip, prop, t, value, fps);
  else setStatic(clip, prop, value);
}

export function toggleAnimation(clip, prop, t) {
  if (isAnimated(clip, prop)) {
    setStatic(clip, prop, propAt(clip, prop, t));
    delete clip.keyframes[prop];
  } else {
    if (!clip.keyframes) clip.keyframes = {};
    clip.keyframes[prop] = [{ t, v: staticValue(clip, prop), ease: 'linear' }];
  }
}

export function keyframeTimes(clip) {
  const s = new Set();
  for (const list of Object.values(clip.keyframes || {})) for (const k of list) s.add(Math.round(k.t * 1e4) / 1e4);
  return [...s].sort((a, b) => a - b);
}

export function setSpeed(seq, ids, speed) {
  for (const c of seq.clips) {
    if (!ids.has(c.id) || !usesSourceTime(c)) continue;
    const old = c.speed || 1;
    c.duration = (c.duration * old) / speed;
    c.speed = speed;
    if (c.keyframes) for (const p of Object.keys(c.keyframes)) c.keyframes[p] = scaleKeys(c.keyframes[p], old / speed);
  }
}

// Speed / Duration (Premiere's Ctrl+R) and the Rate Stretch tool. Give either `speed` (1 = 100%) or
// `duration` (timeline seconds). Source in-points stay put, so each clip shows the same content, faster
// or slower; keyframes stay on the same content. Without ripple a clip can't grow into the next clip
// on its track (it's trimmed there, as in Premiere); with ripple later clips on that track shift.
// anchor 'end' keeps the clip's end fixed (rate-stretching its left edge).
export function retimeClips(seq, ids, { speed, duration, ripple = false, fps = 30, mediaById = {}, anchor = 'start' }) {
  const changed = seq.clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start);
  for (const c of changed) {
    const old = c.speed || 1, oldDur = c.duration, oldEnd = clipEnd(c);
    let nd, ns = null;
    if (usesSourceTime(c)) {
      ns = clamp(duration != null ? (old * oldDur) / Math.max(1e-3, duration) : speed, 0.05, 16);
      nd = (old * oldDur) / ns;
      const m = mediaById[c.media];
      if (m?.duration) nd = Math.min(nd, Math.max(1 / fps, (m.duration - (c.in || 0)) / ns));
    } else nd = duration != null ? duration : oldDur / (speed || 1);
    nd = Math.max(1 / fps, Math.round(nd * fps) / fps);
    if (!ripple) {
      const others = seq.clips.filter((x) => x.track === c.track && !ids.has(x.id));
      if (anchor === 'end') {
        const prevEnd = Math.max(0, ...others.filter((x) => clipEnd(x) <= c.start + EPS).map(clipEnd));
        nd = Math.min(nd, oldEnd - prevEnd);
      } else {
        const next = Math.min(Infinity, ...others.filter((x) => x.start >= oldEnd - EPS).map((x) => x.start));
        nd = Math.min(nd, next - c.start);
      }
    }
    if (ns != null) {
      if (c.keyframes) for (const p of Object.keys(c.keyframes)) c.keyframes[p] = scaleKeys(c.keyframes[p], old / ns);
      c.speed = ns;
    }
    c.duration = nd;
    if (anchor === 'end') c.start = Math.max(0, oldEnd - nd);
    if (c.fadeIn) c.fadeIn = Math.min(c.fadeIn, nd);
    if (c.fadeOut) c.fadeOut = Math.min(c.fadeOut, nd);
    if (ripple && anchor !== 'end') {
      const delta = nd - oldDur;
      // later selected clips were retimed already (latest first); they still shift with everything after this one
      for (const x of seq.clips) if (x !== c && x.track === c.track && x.start >= oldEnd - EPS) x.start = Math.max(0, x.start + delta);
    }
  }
}

export function fitClip(clip, media, seq, mode) {
  const w = media?.width || seq.width, h = media?.height || seq.height;
  if (!clip.transform) clip.transform = { ...DEFAULT_TRANSFORM };
  clip.transform.scale = fitScale(w, h, seq, mode);
  clip.transform.x = 0;
  clip.transform.y = 0;
  if (clip.keyframes) { delete clip.keyframes.scale; delete clip.keyframes.x; delete clip.keyframes.y; }
}

// Paste copied clips at time t, keeping relative timing/tracks; new ids and link groups.
export function pasteClips(seq, clips, t) {
  if (!clips.length) return [];
  const min = Math.min(...clips.map((c) => c.start));
  const linkMap = new Map();
  const ids = [];
  const pasted = clips.map((src) => {
    const c = deepClone(src);
    c.id = uid('c');
    c.start = t + (src.start - min);
    if (c.link) {
      if (!linkMap.has(c.link)) linkMap.set(c.link, uid('l'));
      c.link = linkMap.get(c.link);
    }
    if (!seq.tracks.some((tr) => tr.id === c.track)) c.track = (c.type === 'audio' ? audioTracks(seq) : videoTracks(seq))[0].id;
    return c;
  });
  for (const c of pasted) clearRange(seq, c.track, c.start, clipEnd(c));
  seq.clips.push(...pasted);
  for (const c of pasted) ids.push(c.id);
  return ids;
}

export function clipLabel(clip, mediaById, project = null) {
  if (clip.name) return clip.name;
  if (clip.type === 'adjust') return 'Adjustment layer';
  if (clip.type === 'sequence' || isNestAudio(clip)) return (project && findSequence(project, clip.sequence)?.name) || 'Nested sequence';
  if (clip.type === 'text') return (clip.text || 'Text').split('\n')[0];
  if (clip.type === 'solid') return 'Color matte';
  return mediaById[clip.media]?.name || 'Missing media';
}

export function editPoints(seq) {
  const s = new Set([0]);
  for (const c of seq.clips) { s.add(c.start); s.add(clipEnd(c)); }
  return [...s].sort((a, b) => a - b);
}

// ------------------------------------------------------------- keyframe editing (timeline diamonds + graph editor)

const sameT = (a, b, fps) => Math.abs(a - b) < 0.5 / fps;

// Move keyframes by dt. `sel` is [{ prop, t }] (t = original time); props of other keyframes that land on
// a moved one are replaced. Times stay inside the clip.
export function moveKeyframes(clip, sel, dt, fps = 30) {
  if (!clip.keyframes || !sel.length) return;
  const byProp = {};
  for (const s of sel) (byProp[s.prop] || (byProp[s.prop] = [])).push(s.t);
  for (const [prop, times] of Object.entries(byProp)) {
    const list = clip.keyframes[prop];
    if (!list) continue;
    const moving = list.filter((k) => times.some((t) => sameT(k.t, t, fps)));
    const staying = list.filter((k) => !moving.includes(k));
    const moved = moving.map((k) => ({ ...k, t: clamp(k.t + dt, 0, clip.duration) }));
    const kept = staying.filter((k) => !moved.some((m) => sameT(m.t, k.t, fps)));
    clip.keyframes[prop] = [...kept, ...moved].sort((a, b) => a.t - b.t);
  }
}

// Biggest |dt| that keeps every selected keyframe inside the clip.
export function clampKeyframeShift(clip, sel, dt) {
  if (!sel.length) return 0;
  const lo = Math.min(...sel.map((s) => s.t)), hi = Math.max(...sel.map((s) => s.t));
  return clamp(dt, -lo, clip.duration - hi);
}

export function deleteKeyframes(clip, sel, fps = 30) {
  for (const s of sel) removeKeyframeAt(clip, s.prop, s.t, fps);
}

// Every keyframe of the clip at the given times (timeline diamonds stand for all properties at a time).
export function keysAtTimes(clip, times, fps = 30) {
  const out = [];
  for (const [prop, list] of Object.entries(clip.keyframes || {})) {
    for (const k of list) if (times.some((t) => sameT(k.t, t, fps))) out.push({ prop, t: k.t });
  }
  return out;
}

// Give the segment list[i] → list[i+1] explicit bezier handles that reproduce its current shape, so one
// side can then be edited without the other changing (named eases describe both sides at once).
export function bakeSegment(list, i) {
  const a = list[i], b = list[i + 1];
  if (!a || !b || a.ease === 'hold') return;
  const h = segmentHandles(a, b);
  a.out = { ...h.out };
  b.in = { ...h.in };
  a.ease = 'linear';
}

// After Effects style keyframe assists. 'easy' = Easy Ease (F9), 'easyIn' / 'easyOut' = one side only.
export function setKeyframeInterp(clip, sel, kind, fps = 30) {
  const EASY = { speed: 0, influence: 1 / 3 };
  for (const s of sel) {
    const k = keyframeAt(clip, s.prop, s.t, fps);
    if (!k) continue;
    const list = clip.keyframes[s.prop];
    const i = list.indexOf(k);
    if (kind !== 'hold') { bakeSegment(list, i - 1); bakeSegment(list, i); }
    if (kind === 'linear') { delete k.in; delete k.out; k.ease = 'linear'; }
    else if (kind === 'hold') { delete k.out; k.ease = 'hold'; }
    else {
      if (k.ease === 'hold') k.ease = 'linear';
      if (kind === 'easy' || kind === 'easyIn') k.in = { ...EASY };
      if (kind === 'easy' || kind === 'easyOut') k.out = { ...EASY };
    }
  }
}
