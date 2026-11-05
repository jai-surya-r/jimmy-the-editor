// Nested sound (model.js and ops.js, no app needed): a nested sequence's sound is one audio clip on the outer
// timeline, linked to the nested video clip, and plays (and is gained, faded, muted) through it.
//   node tests/nest-audio.mjs
import { normalizeProject, flattenSequence, audioGainAt, audibleTracks, findSequence, isNestAudio } from '../public/js/core/model.js';
import { nestClips, insertSequence, nestsItself } from '../public/js/core/ops.js';

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const inner = () => ({
  id: 's_in', name: 'Inner', width: 1920, height: 1080, fps: 25,
  tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio', volume: 0.8 }, { id: 'a2', kind: 'audio' }],
  clips: [
    { id: 'c_v', type: 'video', media: 'm_cam', track: 'v1', start: 0, duration: 10, in: 0, link: 'l1' },
    { id: 'c_a', type: 'audio', media: 'm_cam', track: 'a1', start: 0, duration: 10, in: 0, link: 'l1' },
    { id: 'c_m', type: 'audio', media: 'm_music', track: 'a2', start: 2, duration: 6, in: 0, volume: 0.5 },
  ],
});
const media = [{ id: 'm_cam', name: 'cam.mp4', path: 'cam.mp4', type: 'video', duration: 60, width: 1920, height: 1080 },
  { id: 'm_music', name: 'music.wav', path: 'music.wav', type: 'audio', duration: 60 }];
const outerSeq = (clips, tracks = [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }]) => ({ id: 's_main', name: 'Main', width: 1920, height: 1080, fps: 25, tracks, clips });
const sounding = (flat) => {
  const ids = new Set(audibleTracks(flat).map((t) => t.id));
  return flat.clips.filter((c) => c.type === 'audio' && c.media && c.enabled !== false && ids.has(c.track));
};

// 1. A project from before: a nested clip with no sound clip gets one when the project is read, linked to it
{
  const raw = { name: 'Old', media, sequences: [inner(), outerSeq([{ id: 'c_n', type: 'sequence', sequence: 's_in', track: 'v1', start: 4, duration: 6, in: 3 }])] };
  const { project } = normalizeProject(raw);
  const main = findSequence(project, 's_main');
  const nest = main.clips.find((c) => c.id === 'c_n');
  const snd = main.clips.find(isNestAudio);
  ok(!!snd && snd.sequence === 's_in' && snd.track === 'a1' && snd.start === 4 && snd.duration === 6 && snd.in === 3, 'an old nested clip gets its sound clip, same place and window');
  ok(nest.link && snd.link === nest.link && nest.audioClip === true, '…linked to the nested clip, which leaves its sound to it');
  ok(project.settings.nestAudio === 1, '…once per project (settings.nestAudio)');
  const again = normalizeProject(JSON.parse(JSON.stringify(raw))).project;
  ok(findSequence(again, 's_main').clips.find(isNestAudio)?.id === snd.id, 'every reader of the same file makes the same clip (same id)');
  const twice = normalizeProject(project).project;
  ok(findSequence(twice, 's_main').clips.filter(isNestAudio).length === 1, 'reading it again adds nothing');

  // the sound plays once, through the sound clip: inner window 3..9 shown at 4..10
  const flat = flattenSequence(project, main);
  const s = sounding(flat);
  ok(s.length === 2, `the inner sound plays once (${s.length} clips, not twice)`);
  ok(!flat.clips.some(isNestAudio), 'the sound clip itself is replaced by what it stands for');
  const cam = s.find((c) => c.media === 'm_cam'), mus = s.find((c) => c.media === 'm_music');
  ok(near(cam.start, 4) && near(cam.in, 3) && near(cam.duration, 6), 'camera sound placed where the nest shows it');
  ok(near(mus.start, 4) && near(mus.in, 1) && near(mus.duration, 5), 'music trimmed to the window (starts 2 s into the inner, 1 s into the file)');
  const trackOf = (c) => flat.tracks.find((t) => t.id === c.track);
  ok(near(trackOf(cam).volume, 0.8), 'inner track volume kept');

  // its gain: the sound clip's volume and fades on top of the inner clip's own
  const d = JSON.parse(JSON.stringify(project));
  const dm = findSequence(d, 's_main');
  Object.assign(dm.clips.find(isNestAudio), { volume: 0.5, fadeIn: 2 });
  const f2 = flattenSequence(d, dm);
  const m2 = sounding(f2).find((c) => c.media === 'm_music');
  ok(near(audioGainAt(m2, 7), 0.5 * 0.5), `volume multiplies (${audioGainAt(m2, 7)})`);
  ok(near(audioGainAt(m2, 5), 0.5 * 0.5 * 0.5), `fade-in of the sound clip applies (${audioGainAt(m2, 5)} at 1 s of 2)`);

  // mute and disable
  const d2 = JSON.parse(JSON.stringify(project));
  findSequence(d2, 's_main').tracks.find((t) => t.id === 'a1').muted = true;
  ok(sounding(flattenSequence(d2, findSequence(d2, 's_main'))).length === 0, 'muting the sound clip\'s track silences the nest');
  const d3 = JSON.parse(JSON.stringify(project));
  findSequence(d3, 's_main').clips.find(isNestAudio).enabled = false;
  ok(sounding(flattenSequence(d3, findSequence(d3, 's_main'))).length === 0, 'disabling the sound clip silences it');
  const d4 = JSON.parse(JSON.stringify(project));
  const m4 = findSequence(d4, 's_main');
  m4.clips = m4.clips.filter((c) => !isNestAudio(c));
  ok(sounding(flattenSequence(d4, m4)).length === 0, 'deleting the sound clip silences it (the picture stays)');
  ok(flattenSequence(d4, m4).clips.some((c) => c.type === 'video' && c.media === 'm_cam'), '…and the picture still plays');
}

// 2. A nested clip whose sequence has no sound gets no sound clip
{
  const silent = { ...inner(), clips: inner().clips.filter((c) => c.type === 'video') };
  const { project } = normalizeProject({ name: 'Silent', media, sequences: [silent, outerSeq([{ id: 'c_n', type: 'sequence', sequence: 's_in', track: 'v1', start: 0, duration: 10 }])] });
  ok(!findSequence(project, 's_main').clips.some(isNestAudio), 'no sound in the nested sequence: no sound clip');
}

// 3. No free audio track: a new one
{
  const { project } = normalizeProject({ name: 'Busy', media, sequences: [inner(), outerSeq([
    { id: 'c_n', type: 'sequence', sequence: 's_in', track: 'v1', start: 0, duration: 10 },
    { id: 'c_bed', type: 'audio', media: 'm_music', track: 'a1', start: 0, duration: 30 },
  ])] });
  const main = findSequence(project, 's_main');
  const snd = main.clips.find(isNestAudio);
  ok(snd && snd.track !== 'a1' && main.tracks.some((t) => t.id === snd.track && t.kind === 'audio'), `the music bed stays; the sound goes on a new track (${snd?.track})`);
}

// 4. Nest… and dragging a sequence in make the sound clip too
{
  const { project } = normalizeProject({ name: 'Ops', media, settings: { nestAudio: 1 }, sequences: [inner(), outerSeq([], [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }])] });
  const main = findSequence(project, 's_main');
  const c = insertSequence(project, main, 's_in', { start: 5 });
  const snd = main.clips.find(isNestAudio);
  ok(c && snd && snd.link === c.link && c.audioClip && snd.start === 5 && snd.duration === 10, 'a sequence dropped on the timeline comes with its sound, linked');
  const inn = findSequence(project, 's_in');
  const made = nestClips(project, inn, ['c_v', 'c_a'], 'Cam');
  const s2 = inn.clips.find(isNestAudio);
  ok(made && s2 && s2.link === made.clip.link && s2.track === 'a1' && made.clip.audioClip, 'Nest… leaves one picture clip and one sound clip, linked, on the sound\'s track');
  ok(nestsItself(project, 's_in', 's_main'), 'a sequence can\'t contain itself through a sound clip either');
  // deeper: Main ▸ Inner ▸ Cam, the music and the camera both still sound once, through both sound clips
  const flat = flattenSequence(project, main);
  const s = sounding(flat);
  ok(s.length === 2 && s.every((x) => x.gains?.length >= 1), `two levels deep: each sound once (${s.length}), through the sound clips (${s.map((x) => x.gains?.length).join(',')})`);
}

// 5. Old files read with the marker already set (or hand-written nests without a sound clip) still sound
{
  const { project } = normalizeProject({ name: 'Hand', media, settings: { nestAudio: 1 }, sequences: [inner(), outerSeq([{ id: 'c_n', type: 'sequence', sequence: 's_in', track: 'v1', start: 0, duration: 10 }])] });
  ok(sounding(flattenSequence(project, findSequence(project, 's_main'))).length === 2, 'a nested clip with no sound clip of its own still plays its sound');
}

console.log(failed ? `nest-audio: ${failed} failed` : 'nest-audio: all checks passed');
process.exit(failed ? 1 : 0);
