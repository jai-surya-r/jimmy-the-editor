// Jimmy drives Adobe After Effects itself: scripts go to the running After Effects from the command line
// (Windows: AfterFX.exe -r <file>; Mac: osascript … DoScriptFile), and each script writes its answer to a file that
// is read back here. No panel or plugin has to be open. One script runs at a time (After Effects has one scripting
// thread), so several chats share it through a queue, each working on its own composition.
//
// The helper scripts and the motion design rules come from MotionPilot (an After Effects panel, MIT) when it is
// installed: its jsx/bridge.jsx ($._motionPilot: state, digest, renderFrame…), jsx/aekit.jsx (AE.*) and
// brain/bundle.json. Without it, "convert to AE project" falls back to a single generated script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEffectsApp } from './agents.js';
import { getConfig } from './config.js';
import { FFMPEG } from './ffmpeg.js';

const isWin = process.platform === 'win32';

// MotionPilot's folder: "motionPilotDir" in data/config.json, else where Adobe keeps installed panels.
export function motionPilotDir() {
  const dirs = [];
  try { if (getConfig().motionPilotDir) dirs.push(getConfig().motionPilotDir); } catch { /* no config */ }
  const ext = isWin ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
  dirs.push(path.join(ext, 'com.motionpilot'));
  if (!isWin) dirs.push('/Library/Application Support/Adobe/CEP/extensions/com.motionpilot');
  return dirs.find((d) => { try { return fs.existsSync(path.join(d, 'jsx', 'aekit.jsx')) && fs.existsSync(path.join(d, 'brain', 'bundle.json')); } catch { return false; } }) || null;
}

export const aeLive = () => !!(afterEffectsApp() && motionPilotDir());

const WORK = path.join(os.tmpdir(), 'jimmy-ae');
const jsxPath = (p) => p.replace(/\\/g, '/');
const BOM = new RegExp('^' + String.fromCharCode(0xfeff)); // ExtendScript writes UTF-8 files with one
const LS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g'); // ES3 can't take these raw in a string
const jsStr = (s) => JSON.stringify(String(s)).replace(LS, (c) => '\\u' + c.charCodeAt(0).toString(16));
let seq = 0;
let queue = Promise.resolve();
const comps = new Map(); // chat key → the id of the composition it works on

// Scripts reach After Effects through an inbox folder: a small watcher inside After Effects (app.scheduleTask, put
// there once with AfterFX -r / DoScriptFile) runs each job file it finds and writes the answer next to it. Sending
// every script with -r was slower and, after a while, After Effects stopped taking them.
const INBOX = isWin ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Jimmy', 'after-effects')
  : path.join(os.homedir(), 'Library', 'Caches', 'Jimmy', 'after-effects');
const BEAT = path.join(INBOX, 'alive.txt');
const WATCHER = `(function () {
  try { app.preferences.savePrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", 1); } catch (e0) {}
  var J = $.global.__jimmyAE = $.global.__jimmyAE || {};
  J.dir = ${jsStr(jsxPath(INBOX))};
  J.poll = function () {
    if (J.busy) return;
    J.busy = true;
    try {
      var now = new Date().getTime();
      if (!J.beat || now - J.beat > 1000) {
        J.beat = now;
        var b = new File(J.dir + "/alive.txt"); b.open("w"); b.write(String(now)); b.close();
      }
      var list = new Folder(J.dir).getFiles("job-*.jsx");
      list.sort(function (x, y) { return x.name < y.name ? -1 : 1; });
      for (var i = 0; i < list.length; i++) {
        var f = list[i], name = f.name.replace(/\\.jsx$/, ".run");
        if (!f.rename(name)) continue;
        var run = new File(J.dir + "/" + name);
        try { $.evalFile(run); } catch (e1) {}
        run.remove();
      }
    } catch (e) {}
    J.busy = false;
  };
  if (J.task) { try { app.cancelTask(J.task); } catch (e2) {} }
  J.task = app.scheduleTask("$.global.__jimmyAE.poll()", 100, true);
  J.poll();
})();
`;

const beatAge = () => { try { return Date.now() - fs.statSync(BEAT).mtimeMs; } catch { return Infinity; } };

// Windows: After Effects' main window title, '' while it starts or shows a dialog, null when it isn't running.
function aeWindow() {
  const r = spawnSync('tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq AfterFX.exe'], { encoding: 'utf8', windowsHide: true });
  const rows = String(r.stdout || '').split(/\r?\n/).filter((l) => /^"AfterFX\.exe"/i.test(l));
  if (!rows.length) return null;
  return rows.map((l) => l.split('","').pop().replace(/"$/, '')).find((t) => /After Effects/i.test(t)) || '';
}

// Windows: the short (8.3) form of a path: AfterFX -r doesn't take a script path with spaces, quoted or not.
function shortPath(p) {
  if (!/\s/.test(p)) return p;
  const r = spawnSync('cmd', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const s = String(r.stdout || '').trim().split(/\r?\n/).pop();
  return s && !/\s/.test(s) && fs.existsSync(s) ? s : p;
}

// Run a script file in the running After Effects from outside.
function runFile(exe, file) {
  if (isWin) {
    file = shortPath(file);
    // the user's own temp folder: AfterFX -r finds the running After Effects through it
    const tmp = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp');
    spawn(exe, ['-r', file], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, TEMP: tmp, TMP: tmp } }).unref();
  } else {
    const name = path.basename(exe, '.app');
    spawn('osascript', ['-e', `tell application ${JSON.stringify(name)} to DoScriptFile ${JSON.stringify(file)}`], { detached: true, stdio: 'ignore' }).unref();
  }
}

// The watcher is running in After Effects. After Effects is started first when it isn't running: on its own, then
// the watcher once its window is up (started by AfterFX -r, After Effects can't render frames: error 517).
let installing = null;
async function ensureWatcher(exe) {
  if (beatAge() < 3000) return;
  if (installing) return installing;
  installing = (async () => {
    fs.mkdirSync(INBOX, { recursive: true });
    const file = path.join(INBOX, 'watcher.jsx');
    fs.writeFileSync(file, String.fromCharCode(0xfeff) + WATCHER);
    if (isWin) {
      let w = aeWindow();
      if (w === null) {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        const t1 = Date.now();
        while (!(w = aeWindow())) {
          if (Date.now() - t1 > 4 * 60000) throw new Error(w === null ? 'After Effects did not start.' : 'After Effects is waiting on a dialog: answer it in After Effects, then try again.');
          await new Promise((r) => setTimeout(r, 1000));
        }
        await new Promise((r) => setTimeout(r, 4000)); // its panels finish loading
      }
    }
    runFile(exe, file);
    const t0 = Date.now();
    const limit = isWin ? 20000 : 4 * 60000; // a Mac starts After Effects with the script
    while (beatAge() >= 3000) {
      if (Date.now() - t0 > limit) {
        const w = isWin ? aeWindow() : 'running';
        throw new Error(w === null ? 'After Effects did not start.'
          : w === '' ? 'After Effects is waiting on a dialog: answer it in After Effects, then try again.'
            : 'After Effects did not take Jimmy\'s script. Close any dialog in After Effects; if that doesn\'t help, restart After Effects.');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })().finally(() => { installing = null; });
  return installing;
}

// Send one script to After Effects and wait for its answer.
async function sendScript(body, { timeout = 10 * 60000 } = {}) {
  const exe = afterEffectsApp();
  if (!exe) throw new Error('After Effects is not installed on this computer');
  await ensureWatcher(exe);
  const id = `${Date.now()}-${String(++seq).padStart(6, '0')}-${process.pid}`;
  const file = path.join(INBOX, `job-${id}.jsx`);
  const out = path.join(INBOX, `job-${id}.txt`);
  const mp = motionPilotDir();
  const load = mp ? `if (typeof $._motionPilot === "undefined" || typeof AE === "undefined" || !AE.__mp) { $.evalFile(new File(${jsStr(jsxPath(path.join(mp, 'jsx', 'bridge.jsx')))})); $.evalFile(new File(${jsStr(jsxPath(path.join(mp, 'jsx', 'aekit.jsx')))})); }` : '';
  const src = `(function () {
  var __r;
  try { app.beginSuppressDialogs(); } catch (e1) {}
  try { ${load}
${body}
  } catch (e) { __r = "ERR::" + e.toString() + (e.line ? " (line " + e.line + ")" : ""); }
  try { app.endSuppressDialogs(false); } catch (e2) {}
  var __f = new File(${jsStr(jsxPath(out + '.part'))});
  __f.encoding = "UTF-8"; __f.lineFeed = "Unix"; __f.open("w"); __f.write(String(__r)); __f.close();
  __f.rename(${jsStr(path.basename(out))});
})();
`;
  // written under another name first: the watcher must not pick up half a file
  fs.writeFileSync(`${file}.part`, String.fromCharCode(0xfeff) + src);
  fs.renameSync(`${file}.part`, file);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let text = null;
      try { text = fs.readFileSync(out, 'utf8').replace(BOM, ''); } catch { /* not yet */ }
      if (text != null) {
        fs.rm(out, { force: true }, () => {});
        return resolve(text);
      }
      // not picked up and no heartbeat: the watcher is gone (After Effects restarted)
      if (fs.existsSync(file) && Date.now() - t0 > 3000 && beatAge() > 3000) {
        fs.rmSync(file, { force: true });
        return ensureWatcher(afterEffectsApp()).then(() => sendScript(body, { timeout }), reject).then(resolve, reject);
      }
      if (Date.now() - t0 > timeout) {
        fs.rm(file, { force: true }, () => {});
        return reject(new Error('After Effects did not answer. Is a dialog open in After Effects?'));
      }
      setTimeout(tick, Date.now() - t0 < 2000 ? 25 : 150);
    };
    tick();
  });
}

// Queue a job: it runs alone in After Effects, on the chat's composition (opened in the viewer first, so "the active
// composition" is the chat's own). The answer is "OK::…" or "ERR::…" text.
function job(chat, body, { comp } = {}) {
  const run = async () => {
    const cid = comps.get(chat) || 0;
    const pick = `var __pick = null;
  ${comp ? `for (var __i = 1; __i <= app.project.numItems; __i++) { var __it = app.project.item(__i); if (__it instanceof CompItem && __it.name === ${jsStr(comp)}) { __pick = __it; break; } }` : ''}
  if (!__pick && ${cid}) { try { __pick = app.project.itemByID(${cid}); } catch (eid) {} }
  if (__pick && __pick instanceof CompItem && app.project.activeItem !== __pick) __pick.openInViewer();`;
    const text = await sendScript(`${pick}
${body}
  var __a = app.project.activeItem; __r = ((__a && __a instanceof CompItem) ? __a.id : 0) + "\\n" + __r;`);
    const nl = text.indexOf('\n');
    if (/^\d+$/.test(text.slice(0, nl))) {
      const id = Number(text.slice(0, nl));
      if (id && chat) comps.set(chat, id);
      return text.slice(nl + 1);
    }
    return text;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const strip = (r) => String(r).replace(/^(OK|ERR)::/, '');
const ok = (r) => !String(r).startsWith('ERR::');

// One labelled-by-order sheet of several frames (ffmpeg's tile filter), so a check is one picture to look at.
function proofSheet(files, out) {
  if (!FFMPEG || files.length < 2) return null;
  const dir = fs.mkdtempSync(path.join(WORK, 'sheet-'));
  try {
    files.forEach((f, i) => fs.copyFileSync(f, path.join(dir, `f${String(i).padStart(3, '0')}.png`)));
    const cols = files.length <= 4 ? 2 : files.length <= 9 ? 3 : 4;
    const rows = Math.ceil(files.length / cols);
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(dir, 'f%03d.png'), // frames are transparent where nothing is: on dark grey, so white type shows
'-filter_complex', `[0:v]scale=640:-2,format=rgba[a];color=c=0x262626[c];[c][a]scale2ref[bg][a2];[bg][a2]overlay=shortest=1,format=rgb24,pad=iw+8:ih+8:4:4:white,tile=${cols}x${rows}`, '-frames:v', '1', out], { windowsHide: true });
    return r.status === 0 && fs.existsSync(out) ? out : null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The commands behind "vedit ae …" (POST /api/ae).
export async function aeCall({ chat = '', op, script, comp, layer, full, times, out, query, path: lpath, depth, file } = {}) {
  if (!afterEffectsApp()) throw new Error('After Effects is not installed on this computer');
  if (!motionPilotDir()) throw new Error('MotionPilot was not found (its helper scripts are needed). Set "motionPilotDir" in data/config.json.');
  if (op === 'guide') return { ok: true, text: guide() };
  if (op === 'skill') return skill(query, lpath);
  if (op === 'run') {
    if (!script) throw new Error('no script');
    const r = await job(chat, `app.beginUndoGroup("Jimmy");
  try { __r = "OK::" + String(eval(${jsStr(script)})); } finally { app.endUndoGroup(); }
  try { __r += "\\nState now: " + $._motionPilot.digest(); } catch (ed) {}`, { comp });
    return { ok: ok(r), text: ok(r) ? strip(r) : `After Effects threw an error: ${strip(r)} — fix the script and run it again.` };
  }
  if (op === 'state') {
    const r = await job(chat, `__r = $._motionPilot.state(${Math.floor(Number(layer) || 0)}, ${jsStr(full ? 'full' : 'summary')});`, { comp });
    return { ok: ok(r), text: strip(r) };
  }
  if (op === 'info') {
    const q = query ? String(query) : '';
    const r = await job(chat, `__r = $._motionPilot.caps()${q ? ` + "\\n\\n" + $._motionPilot.effectsList(${jsStr(q === '*' ? '' : q)}, 160)` : ''};`, { comp });
    return { ok: ok(r), text: strip(r) };
  }
  if (op === 'inspect') {
    const li = Number.isFinite(Number(layer)) ? Math.floor(Number(layer)) : 0;
    const ln = Number.isFinite(Number(layer)) ? '' : String(layer || '');
    const r = await job(chat, `__r = $._motionPilot.inspect(${li}, ${jsStr(ln)}, ${jsStr(lpath || '')}, ${Math.max(1, Math.min(6, Math.floor(Number(depth) || 3)))});`, { comp });
    return { ok: ok(r), text: strip(r) };
  }
  if (op === 'frame') {
    const list = (times?.length ? times : [-1]).map(Number).filter(Number.isFinite).slice(0, 12);
    const dir = out || path.join(WORK, 'frames');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${++seq}`;
    const files = list.map((t, i) => path.join(dir, `ae-${stamp}-${i + 1}.png`));
    const r = await job(chat, `var __o = [];
  function __frame(c, t, p) {
    try {
      if (t < 0) t = c.time;
      if (t > c.duration) t = c.duration;
      var w = c.saveFrameToPng(t, new File(p));
      if (w && typeof w.wait === "function") w.wait();
      return "OK::" + t.toFixed(3);
    } catch (e) { return "ERR::" + e.toString(); }
  }
  var __c = app.project.activeItem;
  if (!(__c && __c instanceof CompItem)) throw new Error("No active composition.");
  ${list.map((t, i) => `__o.push(${t} + "|" + __frame(__c, ${t}, ${jsStr(jsxPath(files[i]))}));`).join('\n  ')}
  __r = "OK::" + __o.join("\\n");`, { comp });
    if (!ok(r)) return { ok: false, text: strip(r) };
    const lines = strip(r).split('\n').map((l, i) => {
      const [t, res] = [l.slice(0, l.indexOf('|')), l.slice(l.indexOf('|') + 1)];
      return res.startsWith('OK::') ? { t: res.slice(4), file: files[i] } : { t, err: strip(res) };
    });
    // After Effects finishes writing the PNGs a moment after the script returns
    const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    const want = lines.filter((x) => x.file).map((x) => x.file);
    let last = '';
    for (let i = 0; i < 60; i++) {
      const now = want.map(size).join(',');
      if (!now.split(',').includes('0') && now === last) break;
      last = now;
      await new Promise((r) => setTimeout(r, 100));
    }
    const good = lines.filter((x) => x.file && size(x.file) > 0);
    const sheet = good.length > 1 ? proofSheet(good.map((x) => x.file), path.join(dir, `ae-${stamp}-sheet.png`)) : null;
    const text = [
      sheet ? `Proof sheet (${good.length} frames, left to right, top to bottom, in the order below): ${sheet}` : null,
      ...lines.map((x) => (x.file ? `  t=${x.t}s  ${x.file}` : `  t=${x.t}s  failed: ${x.err}`)),
    ].filter(Boolean).join('\n');
    return { ok: good.length > 0, text, sheet, files: good.map((x) => x.file) };
  }
  if (op === 'save') {
    // The chat's composition (and what it uses) saved as its own .aep; the shared workspace project, with every other
    // chat's work, is saved first and opened again after.
    if (!file) throw new Error('no file');
    const ws = path.join(WORK, 'Jimmy workspace.aep');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await job(chat, `var __c = app.project.activeItem;
  if (!(__c && __c instanceof CompItem)) throw new Error("No composition to save: build one first.");
  var __name = __c.name;
  app.project.save(new File(${jsStr(jsxPath(ws))}));
  app.project.reduceProject([__c]);
  app.project.save(new File(${jsStr(jsxPath(file))}));
  app.open(new File(${jsStr(jsxPath(ws))}));
  for (var __j = 1; __j <= app.project.numItems; __j++) { var __k = app.project.item(__j); if (__k instanceof CompItem && __k.name === __name) { __k.openInViewer(); break; } }
  __r = "OK::saved " + __name;`, { comp });
    return { ok: ok(r), text: ok(r) ? `${strip(r)} to ${file}` : strip(r) };
  }
  throw new Error(`unknown After Effects command "${op}"`);
}

// MotionPilot's rules and skills, for "vedit ae guide" / "vedit ae skill".
export function brain() {
  const d = motionPilotDir();
  if (!d) return null;
  try { return JSON.parse(fs.readFileSync(path.join(d, 'brain', 'bundle.json'), 'utf8')); } catch { return null; }
}

// MotionPilot's tools have other names in Jimmy: the same rules with Jimmy's commands.
const TOOLS = `## Jimmy's After Effects commands (they stand in for the "ae" tools the rules below name)
- get_state → \`vedit ae state [--full] [--layer <n>]\`
- run_script → \`vedit ae run <<'JSX'\` … \`JSX\` (ExtendScript on stdin; or \`vedit ae run file.jsx\`). One undo group each, the AE.* helpers preloaded; the answer is the script's last expression plus a one-line comp digest.
- render_frame → \`vedit ae frame <seconds…>\` (up to 12 times in ONE call: one proof sheet + each full-size PNG; Read the sheet)
- get_skill → \`vedit ae skill <name> [section]\` (moves, flow, effects, animation-principles, kinetic-type, ui-motion, editable-rig, 3d, html-to-scene…)
- ae_info → \`vedit ae info [effect search]\`; inspect_properties → \`vedit ae inspect <layer index|name> [--path "Effects>Blur"] [--depth 3]\`
- save → \`vedit ae save <file.aep>\`: your composition and what it uses, as its own project file.
After Effects is shared: other chats may be building their own compositions in the same project at the same time. Work ONLY on your own composition (the commands open it for you once you made it active with openInViewer, or pass --comp "<name>"), never close, open, save or clear the project yourself, never touch other compositions, and don't use the render queue.
`;

function guide() {
  const b = brain();
  if (!b) return 'MotionPilot was not found.';
  return [TOOLS, b.pre.replace('{{SKILLHINT}}', ''), b.cheat, b.rules].join('\n\n');
}

function skill(name, section) {
  const b = brain();
  if (!b) return { ok: false, text: 'MotionPilot was not found.' };
  const packs = { effects: b.fx, 'animation-principles': b.principles, ...(b.skills || {}) };
  const text = packs[name];
  if (!text) return { ok: false, text: `Unknown skill "${name}". Available: ${Object.keys(packs).join(', ')}` };
  // long packs: an index of their "## " sections first
  const parts = text.split(/\n(?=## )/);
  if (parts.length < 3 || text.length < 6000 || section === 'all') return { ok: true, text };
  if (!section) return { ok: true, text: `${parts[0]}\n\nSECTIONS (vedit ae skill ${name} "<section>", or all): ${parts.slice(1).map((p) => p.split('\n')[0].replace(/^##\s*/, '')).join(' · ')}` };
  const hit = parts.slice(1).filter((p) => p.split('\n')[0].toLowerCase().includes(String(section).toLowerCase()));
  return hit.length ? { ok: true, text: hit.join('\n\n') } : { ok: false, text: `No section "${section}" in ${name}.` };
}
