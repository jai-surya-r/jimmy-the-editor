// Jimmy drives After Effects itself ("vedit ae …", server/aehost.js). Needs After Effects and MotionPilot on this
// computer, so it runs here only (not on GitHub): skipped when either is missing.
//   • guide: MotionPilot's rules with Jimmy's command names
//   • two chats build their own compositions at the same time; each chat's commands land on its own composition
//   • a script error comes back as an error, with the line
//   • frame: full-size PNGs and one proof sheet
//   • save: one chat's composition as its own .aep; the other chat's composition is still there after
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, PORT, ROOT, WORK } from './lib/server.mjs';
import { afterEffectsApp } from '../server/agents.js';
import { motionPilotDir } from '../server/aehost.js';

if (!afterEffectsApp() || !motionPilotDir()) { console.log('SKIP  After Effects or MotionPilot is not on this computer'); process.exit(0); }

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const out = path.join(WORK, 'ae-live');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// one vedit command as a chat would run it (its own chat key), script on stdin
const vedit = (chat, args, stdin) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'vedit.mjs'), 'ae', ...args], {
    cwd: out, env: { ...process.env, CLAUDE_EDIT_URL: `http://127.0.0.1:${PORT}`, CLAUDE_EDIT_CHAT: chat },
  });
  let text = '';
  p.stdout.on('data', (d) => { text += d; });
  p.stderr.on('data', (d) => { text += d; });
  p.on('close', (code) => resolve({ code, text }));
  p.stdin.end(stdin || '');
});

const srv = await startServer();
try {
  const g = await vedit('a', ['guide']);
  ok(g.code === 0 && /vedit ae run/.test(g.text) && /Motion rules/.test(g.text), 'guide: MotionPilot\'s rules with Jimmy\'s commands');

  const stamp = Date.now();
  const A = `Live A ${stamp}`, B = `Live B ${stamp}`;
  const t0 = Date.now();
  const [ra, rb] = await Promise.all([
    vedit('a', ['run'], `var c = app.project.items.addComp(${JSON.stringify(A)}, 960, 540, 1, 2, 30); c.openInViewer();
var t = c.layers.addText("Hello"); t.name = "Title"; "made A"`),
    vedit('b', ['run'], `var c = app.project.items.addComp(${JSON.stringify(B)}, 540, 540, 1, 2, 30); c.openInViewer();
var s = c.layers.addSolid([0.2, 0.4, 0.9], "Ground", 540, 540, 1); "made B"`),
  ]);
  ok(ra.code === 0 && /made A/.test(ra.text) && rb.code === 0 && /made B/.test(rb.text), `two chats at once (${Date.now() - t0} ms)`);

  const sa = await vedit('a', ['state']);
  ok(sa.text.includes(`COMP "${A}"`) && /"Title"/.test(sa.text), 'chat a\'s state is its own composition');
  const sb = await vedit('b', ['run'], 'app.project.activeItem.name');
  ok(sb.text.startsWith(B), 'chat b\'s script runs in its own composition');

  const bad = await vedit('a', ['run'], 'var x = 1;\nnope.bad();');
  ok(bad.code === 1 && /ReferenceError/.test(bad.text) && /line 2/.test(bad.text), 'a script error comes back with its line');

  const fr = await vedit('a', ['frame', '0', '1', '1.9']);
  const pngs = [...fr.text.matchAll(/((?:[A-Za-z]:\\|\/)[^\n]*?\.png)$/gm)].map((m) => m[1]);
  ok(fr.code === 0 && /Proof sheet/.test(fr.text) && pngs.length === 4 && pngs.every((p) => fs.existsSync(p)), 'frame: three frames and one proof sheet');

  const file = path.join(out, `${A}.aep`);
  const sv = await vedit('a', ['save', file]);
  ok(sv.code === 0 && fs.existsSync(file), 'save: chat a\'s composition as its own .aep');
  const after = await vedit('b', ['run'], 'app.project.activeItem.name');
  ok(after.text.startsWith(B), 'chat b still has its composition after the save');

  // tidy the shared project
  await vedit('b', ['run'], `for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i); if (it.name === ${JSON.stringify(A)} || it.name === ${JSON.stringify(B)}) it.remove(); } "tidy"`);
} finally {
  await srv.stop();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
