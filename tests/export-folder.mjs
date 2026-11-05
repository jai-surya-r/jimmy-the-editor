// A template project's exports go to the Premiere exports folder it already has, however it is spelled.
//   node tests/export-folder.mjs
import fs from 'node:fs';
import path from 'node:path';
import { WORK } from './lib/server.mjs';

process.env.JIMMY_DATA_DIR = path.join(WORK, 'export-folder-data');
const { defaultLayout } = await import('../server/layout.js');
const BASE = path.join(WORK, 'export-folder');
fs.rmSync(BASE, { recursive: true, force: true });
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

const project = (name, folders) => {
  const dir = path.join(BASE, name);
  for (const d of ['1_Assets', '2_Audio', '3_Exports', '4_Footage', '5_Projects']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of folders) fs.mkdirSync(path.join(dir, '3_Exports', f), { recursive: true });
  const rel = path.relative(path.join(dir, '3_Exports'), defaultLayout(dir).renders).split(path.sep).join('/');
  return rel;
};
const STD = '3_Premier_Pro_Exports/1_Internal_QC';
ok(project('none', []) === STD, 'no folder yet: the template\'s own name');
ok(project('standard', ['3_Premier_Pro_Exports']) === STD, 'the template\'s spelling');
ok(project('spaces', ['3_Premier Pro Exports']) === '3_Premier Pro Exports/1_Internal_QC', 'spelled with spaces');
ok(project('premiere', ['3 Premiere Pro Export']) === '3 Premiere Pro Export/1_Internal_QC', '"Premiere", singular');
ok(project('both', ['3_Premier Pro Exports', '3_Premier_Pro_Exports']) === '3_Premier Pro Exports/1_Internal_QC', 'both: the project\'s own, not the one Jimmy added');
ok(project('qc', ['3_Premier Pro Exports/1_Internal QC']) === '3_Premier Pro Exports/1_Internal QC', 'the QC folder\'s spelling too');
ok(project('other', ['2_Audio Exports']) === STD, 'other folders are left alone');

fs.rmSync(BASE, { recursive: true, force: true });
fs.rmSync(process.env.JIMMY_DATA_DIR, { recursive: true, force: true });
console.log(failed ? `export-folder: ${failed} failed` : 'export-folder: all checks passed');
process.exit(failed ? 1 : 0);
