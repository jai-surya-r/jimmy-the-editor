#!/usr/bin/env node
// npm run golden: render the golden frames with the selected engine (ENGINE env, default classic) and
// compare them with the references. Makes the references first (classic) if there are none yet.
import fs from 'node:fs';
import path from 'node:path';
import { capture, REF_DIR } from './capture.mjs';
import { compare, printTable } from './compare.mjs';

const engine = process.env.ENGINE || 'classic';
try {
  if (!fs.existsSync(path.join(REF_DIR, 'capture.json'))) {
    console.log('No references yet: rendering them with the classic engine.');
    await capture({ engine: 'classic', ref: true });
  }
  await capture({ engine });
  const rows = compare(engine);
  printTable(engine, rows);
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
} catch (e) {
  console.error(`\ngolden: ${e.message}`);
  process.exit(1);
}
