// Runs tests one after another, each with a time limit, keeps every log in tests/.work/suite/ and prints a summary
// (also as a table on the GitHub Actions run page when GITHUB_STEP_SUMMARY is set). Exits 1 if any failed.
//   node tests/run-suite.mjs <title> <test.mjs | "npm run x">...
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WORK, ROOT } from './lib/server.mjs';

const [title, ...tests] = process.argv.slice(2);
const OUT = path.join(WORK, 'suite');
fs.mkdirSync(OUT, { recursive: true });
const LIMIT = Number(process.env.SUITE_TEST_MINUTES || 20) * 60000;
const results = [];
for (const t of tests) {
  const name = path.basename(t).replace(/\.mjs$/, '').replace(/[^\w.-]+/g, '-');
  const log = path.join(OUT, `${title.replace(/\W+/g, '-')}-${name}.log`);
  const [cmd, args] = t.startsWith('npm ') ? ['npm', t.slice(4).split(' ')] : [process.execPath, [t]];
  const t0 = Date.now();
  console.log(`\n=== ${title}: ${t}`);
  const out = fs.createWriteStream(log);
  const code = await new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env, shell: cmd === 'npm' && process.platform === 'win32' });
    const timer = setTimeout(() => { out.write(`\n[run-suite] stopped after ${LIMIT / 60000} min\n`); p.kill('SIGKILL'); }, LIMIT);
    for (const s of [p.stdout, p.stderr]) s.on('data', (d) => { process.stdout.write(d); out.write(d); });
    p.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1); });
  });
  out.end();
  // the app's own log for this test (the next test starts a new one)
  try { fs.copyFileSync(path.join(WORK, 'server.log'), log.replace(/\.log$/, '.server.log')); } catch { /* none */ }
  const text = fs.readFileSync(log, 'utf8');
  const fails = text.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim().replace(/^FAIL\s+/, ''));
  results.push({ t, ok: code === 0, s: Math.round((Date.now() - t0) / 1000), fails, tail: code === 0 ? '' : text.trim().split('\n').slice(-4).join(' / ') });
}
console.log(`\n=== ${title}: summary`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.t}  (${r.s} s)${r.fails.length ? `\n      ${r.fails.join('\n      ')}` : ''}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`### ${title}`, '', '| Test | Result | Time | Failed checks |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.t} | ${r.ok ? '✅' : '❌'} | ${r.s} s | ${(r.fails.join('<br>') || (r.ok ? '' : r.tail)).replace(/\|/g, '\\|').slice(0, 900)} |`), ''];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
