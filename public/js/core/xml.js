// Sequence → Final Cut Pro 7 XML (xmeml v4), the interchange format Premiere Pro (File > Import),
// DaVinci Resolve and Final Cut import. Includes video/audio/image clips with their cuts, source
// in/out, speed (time remap), scale, position, rotation, opacity and clip volume, and each file's start timecode
// (camera clips start at e.g. 20:53:15:09, and editors link clips to files by it). Text, colour mattes,
// effects, LUTs and transitions have no portable equivalent and are listed in the result's `skipped`.
import { videoTracks, audioTracks, sequenceDuration, clipEnd, uid, deepClone } from './model.js';

const fileName = (p) => String(p || '').split(/[\\/]/).pop();
const esc = (s) =>String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function duplicateSequence(d, id) {
  const src = d.sequences.find((s) => s.id === id);
  if (!src) return null;
  const c = deepClone(src);
  c.id = uid('s');
  const base = src.name.replace(/ copy( \d+)?$/, '');
  let name = `${base} copy`, n = 2;
  while (d.sequences.some((s) => s.name === name)) name = `${base} copy ${n++}`;
  c.name = name;
  // fresh link groups so the copy's linked clips don't pair with the original's
  const links = new Map();
  for (const cl of c.clips) {
    cl.id = uid('c');
    if (cl.link) { if (!links.has(cl.link)) links.set(cl.link, uid('l')); cl.link = links.get(cl.link); }
  }
  d.sequences.splice(d.sequences.indexOf(src) + 1, 0, c);
  return c;
}

function rateXml(fps) {
  const ntsc = Math.abs(fps - Math.round(fps)) > 0.001;
  return `<rate><timebase>${Math.round(fps)}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}
// A file's start timecode ("20:53:15:09", or "…;09" for drop-frame) as FCP XML's <timecode>, its frame count at the
// file's own rate. Resolve and Premiere link a clip to its file by it: without it they take the file to start at
// 00:00:00:00, and Resolve then says "the timecode extents do not match any clip in the Media Pool".
export function timecodeXml(tc, fps) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})([:;.])(\d{2,3})$/.exec(String(tc || '').trim());
  if (!m || !(fps > 0)) return '';
  const [h, mi, s, f] = [m[1], m[2], m[3], m[5]].map(Number);
  const tb = Math.round(fps);
  const drop = m[4] === ';' && Math.abs(fps - tb) > 0.001;
  let frame = ((h * 60 + mi) * 60 + s) * tb + f;
  if (drop) {
    const minutes = h * 60 + mi;
    frame -= Math.round(tb / 15) * (minutes - Math.floor(minutes / 10)); // 2 (29.97) or 4 (59.94) labels skipped a minute
  }
  const str = `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}${drop ? ';' : ':'}${m[5]}`;
  return `<timecode>${rateXml(fps)}<string>${str}</string><frame>${frame}</frame><displayformat>${drop ? 'DF' : 'NDF'}</displayformat></timecode>`;
}
function pathUrl(abs) {
  const p = abs.replace(/\\/g, '/');
  const enc = p.split('/').map((seg, i) => (i === 0 && /^[a-z]:$/i.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return `file://localhost${enc.startsWith('/') ? '' : '/'}${enc}`;
}
const absPath = (dir, p) => (/^[a-z]:[\\/]|^\//i.test(p) ? p : `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${p.replace(/\//g, dir.includes('\\') ? '\\' : '/')}`);

export function sequenceToXml(project, seq, projectDir) {
  const fps = seq.fps;
  const F = (t) => Math.round(t * fps);
  const media = Object.fromEntries(project.media.map((m) => [m.id, m]));
  const fileDone = new Set();
  const skipped = { text: 0, solid: 0, transitions: 0, effects: 0, luts: 0, keyframed: 0, missing: 0 };

  const fileXml = (m) => {
    const id = `file-${m.id}`;
    if (fileDone.has(id)) return `<file id="${id}"/>`;
    fileDone.add(id);
    const rate = m.fps || fps; // the file's own frame rate: its <rate>, <duration> and <timecode> count in it
    const dur = Math.max(1, Math.round((m.duration || 5) * rate)); // unknown length: 5 s
    const v = m.type !== 'audio' ? `<video><samplecharacteristics>${rateXml(rate)}<width>${m.width || seq.width}</width><height>${m.height || seq.height}</height></samplecharacteristics></video>` : '';
    const a = m.type !== 'image' && m.hasAudio !== false ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${m.sampleRate || 48000}</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>` : '';
    const tc = m.type === 'video' ? timecodeXml(m.timecode, rate) : '';
    return `<file id="${id}"><name>${esc(fileName(m.path) || m.name)}</name><pathurl>${esc(pathUrl(absPath(projectDir, m.path)))}</pathurl>${rateXml(rate)}<duration>${m.type === 'image' ? 1 : dur}</duration>${tc}<media>${v}${a}</media></file>`;
  };
  const param = (id, name, value, min, max) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${min != null ? `<valuemin>${min}</valuemin><valuemax>${max}</valuemax>` : ''}<value>${value}</value></parameter>`;

  const clipXml = (c, kind, idx) => {
    const m = media[c.media];
    if (!m) { skipped.missing++; return ''; }
    if (c.keyframes && Object.keys(c.keyframes).length) skipped.keyframed++;
    if (c.lut) skipped.luts++;
    if (c.effects && Object.values(c.effects).some((v) => v)) skipped.effects++;
    if (c.transitionIn || c.transitionOut) skipped.transitions++;
    const speed = c.speed || 1;
    const start = F(c.start), end = F(clipEnd(c));
    const inF = m.type === 'image' ? 0 : F(c.in || 0);
    const outF = m.type === 'image' ? end - start : inF + Math.round((end - start) * speed);
    const mediaDur = m.type === 'image' ? end - start : Math.max(outF, Math.round((m.duration || 0) * fps));
    const filters = [];
    if (speed !== 1) {
      filters.push(`<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${param('variablespeed', 'variablespeed', 0, 0, 1)}${param('speed', 'speed', +(speed * 100).toFixed(4), -100000, 100000)}${param('reverse', 'reverse', 'FALSE')}${param('frameblending', 'frameblending', 'FALSE')}</effect></filter>`);
    }
    if (kind === 'video') {
      const tr = c.transform || {};
      filters.push(`<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>`
        + param('scale', 'Scale', +((tr.scale ?? 1) * 100).toFixed(3), 0, 1000)
        + param('rotation', 'Rotation', +(tr.rotation || 0).toFixed(3), -8640, 8640)
        + `<parameter authoringApp="PremierePro"><parameterid>center</parameterid><name>Center</name><value><horiz>${+((tr.x || 0) / (m.width || seq.width)).toFixed(6)}</horiz><vert>${+((tr.y || 0) / (m.height || seq.height)).toFixed(6)}</vert></value></parameter>`
        + `</effect></filter>`);
      if ((tr.opacity ?? 1) !== 1) filters.push(`<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${param('opacity', 'opacity', +((tr.opacity ?? 1) * 100).toFixed(3), 0, 100)}</effect></filter>`);
    } else if ((c.volume ?? 1) !== 1) {
      filters.push(`<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>${param('level', 'Level', +(c.volume ?? 1).toFixed(4), 0.00003162, 31.622776)}</effect></filter>`);
    }
    return `<clipitem id="clipitem-${idx}"><name>${esc(c.name || m.name)}</name><enabled>${c.enabled === false ? 'FALSE' : 'TRUE'}</enabled><duration>${mediaDur}</duration>${rateXml(fps)}<start>${start}</start><end>${end}</end><in>${inF}</in><out>${outF}</out>${fileXml(m)}${kind === 'audio' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' : ''}${filters.join('')}</clipitem>`;
  };

  let idx = 1;
  const vTracks = videoTracks(seq).map((t) => {
    const items = seq.clips.filter((c) => c.track === t.id).sort((a, b) => a.start - b.start).map((c) => {
      if (c.type === 'text') { skipped.text++; return ''; }
      if (c.type === 'solid') { skipped.solid++; return ''; }
      return clipXml(c, 'video', idx++);
    }).join('');
    return `<track>${items}<enabled>${t.hidden ? 'FALSE' : 'TRUE'}</enabled><locked>${t.locked ? 'TRUE' : 'FALSE'}</locked></track>`;
  }).join('');
  const aTracks = audioTracks(seq).map((t) => {
    const items = seq.clips.filter((c) => c.track === t.id && c.type === 'audio').sort((a, b) => a.start - b.start).map((c) => clipXml(c, 'audio', idx++)).join('');
    return `<track>${items}<enabled>${t.muted ? 'FALSE' : 'TRUE'}</enabled><locked>${t.locked ? 'TRUE' : 'FALSE'}</locked></track>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1"><name>${esc(seq.name)}</name><duration>${F(sequenceDuration(seq))}</duration>${rateXml(fps)}
<timecode>${rateXml(fps)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
<media>
<video><format><samplecharacteristics>${rateXml(fps)}<width>${seq.width}</width><height>${seq.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${vTracks}</video>
<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${aTracks}</audio>
</media>
</sequence>
</xmeml>
`;
  return { xml, skipped };
}

export function downloadSequenceXml(tab, seqId) {
  const doc = tab.doc;
  const seq = doc.sequences.find((s) => s.id === (seqId || tab.seq?.id));
  if (!seq) return null;
  const { xml, skipped } = sequenceToXml(doc, seq, tab.store.get().dir);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
  a.download = `${seq.name.replace(/[\\/:*?"<>|]/g, '_')}.xml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return skipped;
}
