// XML exports carry each file's start timecode, so Resolve and Premiere can link clips to camera footage (Resolve said
// "failed to link because the timecode extents do not match any clip in the Media Pool" for Sony camera clips,
// whose timecode starts at e.g. 20:53:15:09). Media probed before timecodes were read are probed again.
//   node tests/xml-timecode.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startServer, api, WORK, ROOT } from './lib/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };
const DIR = path.join(WORK, 'xml-timecode');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'media'), { recursive: true });
const { sequenceToXml, timecodeXml } = await import(pathToFileURL(path.join(ROOT, 'public/js/core/xml.js')).href);

// camera-like clips: 25 fps with a start timecode (like a Sony camera's C0004.MP4), 29.97 drop-frame, and one without
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const make = (name, rate, tc) => {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...(tc ? ['-timecode', tc] : []), path.join(DIR, 'media', name)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};
make('C0004.MP4', 25, '20:53:15:09');
make('C0110.MOV', '30000/1001', '01:00:00;00');
make('phone.mp4', 30, null);

const project = {
  format: 'claude-edit/1', name: 'XML timecode', settings: { originalNames: 1 }, folders: [],
  media: [
    { id: 'm_sony', path: 'media/C0004.MP4' },
    { id: 'm_df', path: 'media/C0110.MOV' },
    { id: 'm_phone', path: 'media/phone.mp4' },
  ],
  sequences: [{
    id: 's1', name: 'Color Grade - Raw', width: 1920, height: 1080, fps: 25, tracks: [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }],
    clips: [
      { id: 'c1', type: 'video', track: 'v1', media: 'm_sony', start: 0, duration: 2, in: 2, link: 'l1' },
      { id: 'c1a', type: 'audio', track: 'a1', media: 'm_sony', start: 0, duration: 2, in: 2, link: 'l1' },
      { id: 'c2', type: 'video', track: 'v1', media: 'm_df', start: 2, duration: 1, in: 1 },
      { id: 'c3', type: 'video', track: 'v1', media: 'm_phone', start: 3, duration: 1, in: 0 },
    ],
  }],
};
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(project, null, 2));

// ------------------------------------------------------------ the timecode maths
ok(timecodeXml('20:53:15:09', 25).includes('<frame>1879884</frame>') && timecodeXml('20:53:15:09', 25).includes('<displayformat>NDF</displayformat>'), '20:53:15:09 at 25 fps is frame 1879884');
ok(timecodeXml('01:00:00;00', 29.97).includes('<frame>107892</frame>') && timecodeXml('01:00:00;00', 29.97).includes('DF</displayformat>') && timecodeXml('01:00:00;00', 29.97).includes('<ntsc>TRUE</ntsc>'), '01:00:00;00 drop-frame at 29.97 is frame 107892');
ok(timecodeXml('00:10:00;00', 29.97).includes('<frame>17982</frame>'), '00:10:00;00 drop-frame is frame 17982');
ok(timecodeXml(null, 25) === '' && timecodeXml('garbage', 25) === '', 'no or bad timecode: no element');

const waitProbed = async (id) => {
  for (let i = 0; i < 150; i++) {
    const { doc } = await api('GET', `/api/p/${id}`);
    if (doc.media.every((m) => m.duration != null) && doc.media.find((m) => m.id === 'm_sony').timecode) return doc;
    await sleep(200);
  }
  return (await api('GET', `/api/p/${id}`)).doc;
};
const fileXml = (xml, name) => (new RegExp(`<file id="[^"]+"><name>${name.replace('.', '\\.')}</name>.*?</file>`).exec(xml) || [''])[0];

let srv = await startServer();
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  const doc = await waitProbed(id);
  const media = Object.fromEntries(doc.media.map((m) => [m.id, m]));
  ok(media.m_sony.timecode === '20:53:15:09', `the Sony-like clip's start timecode is read (${media.m_sony.timecode})`);
  ok(media.m_df.timecode === '01:00:00;00', `a drop-frame start timecode keeps its ";" (${media.m_df.timecode})`);
  ok(!('timecode' in media.m_phone), 'a clip without timecode gets none');

  const { xml } = sequenceToXml(doc, doc.sequences[0], DIR);
  fs.writeFileSync(path.join(DIR, 'export.xml'), xml);
  const sony = fileXml(xml, 'C0004.MP4');
  ok(/<timecode><rate><timebase>25<\/timebase><ntsc>FALSE<\/ntsc><\/rate><string>20:53:15:09<\/string><frame>1879884<\/frame><displayformat>NDF<\/displayformat><\/timecode>/.test(sony), 'the XML gives C0004.MP4 its start timecode');
  ok(/<duration>150<\/duration>/.test(sony), '…and its length in its own frames (6 s at 25 fps = 150)');
  ok(/<string>01:00:00;00<\/string><frame>107892<\/frame><displayformat>DF/.test(fileXml(xml, 'C0110.MOV')), 'the drop-frame clip is written as drop-frame');
  ok(!/<timecode>/.test(fileXml(xml, 'phone.mp4')), 'the clip without timecode has no <timecode>');
  ok((xml.match(/<clipitem /g) || []).length === 4 && /<in>50<\/in><out>100<\/out>/.test(xml), 'clip in/out stay counted from the file\'s start (2 s in at 25 fps = 50)');
  // well-formed: every tag closes in order
  const stack = [];
  let bad = false;
  for (const m of xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (!m[1]) stack.push(m[2]); else if (stack.pop() !== m[2]) { bad = true; break; }
  }
  ok(!bad && !stack.length, 'the XML is well-formed');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await srv.stop();
}

// ------------------------------------------------------------ media probed by an earlier version are probed again
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch { return {}; } })();
const metas = [];
const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.meta.json')) metas.push(p); } };
walk(path.join(DIR, '.cache'));
if (cfg.cacheDir) walk(path.join(cfg.cacheDir, 'projects'));
let stripped = 0;
for (const f of metas) {
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (m.type === 'video' && 'timecode' in m) { delete m.timecode; fs.writeFileSync(f, JSON.stringify(m)); stripped++; }
}
const pj = JSON.parse(fs.readFileSync(path.join(DIR, 'project.json'), 'utf8'));
for (const m of pj.media) delete m.timecode;
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(pj, null, 2));
ok(stripped >= 3, `cached probe results made to look like an earlier version's (${stripped})`);
srv = await startServer();
try {
  const { id } = await api('POST', '/api/projects/open', { path: DIR });
  const doc = await waitProbed(id);
  ok(doc.media.find((m) => m.id === 'm_sony').timecode === '20:53:15:09', 'opened again, the old cache entry is probed again and the timecode is filled in');
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await srv.stop();
}
console.log(failed ? `xml-timecode: ${failed} failed` : 'xml-timecode: all checks passed');
process.exit(failed ? 1 : 0);
