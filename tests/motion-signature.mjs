// A graphic's render key (server/motion.js signature) on its own: `node tests/motion-signature.mjs`.
// The fast version must give exactly the old answer (or every graphic would render again after an update),
// and a big folder (500 files, a 7 MB script many compositions load) must not hold the app up.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MotionService } from '../server/motion.js';
import { sha1 } from '../server/util.js';
import { WORK } from './lib/server.mjs';

let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };

// the version before Step 84, kept here as the reference
const ASSET_EXT = /\.(html?|css|m?js|json|svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf|mp4|webm|mov|mp3|wav|m4a|ogg|glsl|txt|csv)$/i;
async function oldSignature(d) {
  const parts = [d.text, JSON.stringify(d.params), JSON.stringify(d.spec), ...(d.edit ? [JSON.stringify(d.edit)] : []), 'runtime-2', 'v1'];
  const dir = path.dirname(d.file);
  const files = [];
  const walk = async (p, depth) => {
    let ents = [];
    try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'renders' || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = path.join(p, e.name);
      if (e.isDirectory()) { if (depth < 2 && files.length < 2000) await walk(f, depth + 1); }
      else if (ASSET_EXT.test(e.name) && f !== d.file) files.push(f);
    }
  };
  await walk(dir, 0);
  const texts = [d.text, JSON.stringify(d.params)];
  const refs = new Set();
  const mention = (f) => texts.some((t) => t.includes(path.basename(f)));
  for (let pass = 0; pass < 2; pass++) {
    for (const f of files) {
      if (refs.has(f) || !mention(f)) continue;
      refs.add(f);
      if (/\.(css|m?js)$/i.test(f)) { try { texts.push(await fsp.readFile(f, 'utf8')); } catch { /* gone */ } }
    }
  }
  for (const f of [...refs].sort()) {
    try { const st = await fsp.stat(f); parts.push(`${path.relative(dir, f)}|${st.size}|${st.mtimeMs}`); } catch { /* gone */ }
  }
  return sha1(parts.join('\n')).slice(0, 12);
}

const dir = path.join(WORK, 'motion-sig');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
const put = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);

// small cases: chains through css/js, names inside other names, upper-case extensions, sub folders, the renders folder
put('a.png', 'x'); put('aa.png', 'x'); put('IMG.PNG', 'x'); put('b.jpg', 'x'); put('font.woff2', 'x');
put('style.css', 'body{background:url(b.jpg)} @font-face{src:url(font.woff2)}');
put('lib.js', 'load("chain.js")');
put('chain.js', 'load("sub/deep/far.png")');
put('sub/deep/far.png', 'x'); put('sub/near.svg', 'x'); put('renders/a.png', 'x');
put('data.json', '{"img":"aa.png"}');
put('notes.txt', 'unused');
put('one.html', '<link href="style.css"><img src="a.png"><script src="lib.js"></script>');
put('two.html', '<img src="IMG.PNG"><img src="sub/near.svg"> data.json');
put('three.html', 'nothing named');
put('four.html', '<script src="lib.js"></script> one.html');

const svc = new MotionService({ media: null, port: 0, emitAll: () => {} });
const desc = (file, extra = {}) => ({ file: path.join(dir, file), text: fs.readFileSync(path.join(dir, file), 'utf8'), params: { t: 'aa.png' }, spec: { width: 1920, height: 1080, fps: 30, duration: 5 }, edit: null, ...extra });
for (const f of ['one.html', 'two.html', 'three.html', 'four.html']) {
  const d = desc(f);
  ok((await svc.signature(d)) === (await oldSignature(d)), `${f}: same key as before`);
}
const withEdit = desc('one.html', { edit: { a: 1 }, params: { img: 'b.jpg' } });
ok((await svc.signature(withEdit)) === (await oldSignature(withEdit)), 'params and edits: same key as before');

// a referenced file changes: the key changes (after the watcher drops the listing, or straight away for a text it names)
const before = await svc.signature(desc('one.html'));
await new Promise((r) => setTimeout(r, 30));
put('b.jpg', 'changed!');
const after = await svc.signature(desc('one.html'));
ok(after !== before && after === (await oldSignature(desc('one.html'))), 'a file the page uses changes: a new key');
// a new file named by a script: found once the folder's listing is dropped (what the folder watcher does)
put('lib.js', 'load("chain.js"); load("added.webp")');
put('added.webp', 'x');
svc.forgetListing(dir);
ok((await svc.signature(desc('one.html'))) === (await oldSignature(desc('one.html'))), 'a file added and named: same key as before');

// the big folder: 500 files, a 7 MB script, 120 compositions that load it
const big = path.join(WORK, 'motion-sig-big');
fs.rmSync(big, { recursive: true, force: true });
fs.mkdirSync(big, { recursive: true });
for (let i = 0; i < 180; i++) fs.writeFileSync(path.join(big, `img_${i}.png`), 'x');
for (let i = 0; i < 160; i++) fs.writeFileSync(path.join(big, `photo_${i}.jpg`), 'x');
let mapJs = 'var M=[';
while (mapJs.length < 7_000_000) mapJs += `[${(Math.random() * 1000).toFixed(4)},${(Math.random() * 1000).toFixed(4)}],`;
mapJs += '0]; var flag="img_3.png";';
fs.writeFileSync(path.join(big, 'map.js'), mapJs);
fs.writeFileSync(path.join(big, 'gsap.min.js'), 'x'.repeat(70000));
const comps = [];
for (let i = 0; i < 120; i++) {
  const f = path.join(big, `MG_${i}.html`);
  fs.writeFileSync(f, `<script src="gsap.min.js"></script><script src="map.js"></script><img src="photo_${i}.jpg">`);
  comps.push(f);
}
const d0 = { file: comps[7], text: fs.readFileSync(comps[7], 'utf8'), params: {}, spec: { width: 1920, height: 1080, fps: 30, duration: 5 }, edit: null };
ok((await svc.signature(d0)) === (await oldSignature(d0)), 'big folder: same key as before');
// time every composition's key, as one check after a change does, and the longest the app is held up meanwhile
let longest = 0;
let last = performance.now();
const lag = setInterval(() => { const n = performance.now(); longest = Math.max(longest, n - last - 10); last = n; }, 10);
const t0 = performance.now();
svc.forgetListing(big);
for (const f of comps) await svc.signature({ ...d0, file: f, text: fs.readFileSync(f, 'utf8') });
const ms = performance.now() - t0;
clearInterval(lag);
console.log(`      120 keys in ${Math.round(ms)} ms, longest hold-up ${Math.round(longest)} ms`);
ok(ms < 3000, `120 graphics in a 500-file folder checked in ${Math.round(ms)} ms (was tens of seconds)`);
ok(longest < 150, `the app is never held up long meanwhile (${Math.round(longest)} ms)`);

process.exit(failed ? 1 : 0);
