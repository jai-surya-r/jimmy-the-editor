#!/usr/bin/env node
// Renders the golden frames (tests/golden/frames.json) with one engine, as full-size PNGs.
//   node tests/golden/capture.mjs            → tests/.work/golden-out/<engine>/   (ENGINE env, default classic)
//   node tests/golden/capture.mjs --ref      → tests/golden/ref/ (the references; classic only)
// It runs its own Jimmy test server on port 4455 (see tests/lib/server.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, WORK, GOLDEN_DIR, startServer, openGolden, api } from '../lib/server.mjs';

export const ENGINES = ['classic'];
export const REF_DIR = path.join(ROOT, 'tests', 'golden', 'ref');
export const frameList = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'golden', 'frames.json'), 'utf8')).frames
  .map(([seq, t, kind, what]) => ({ seq, t, kind, what }));
// file name: sequence and frame number, so a time typo can't silently pick a different frame
export const frameFile = (f, fps) => `${f.seq}-${String(Math.round(f.t * fps)).padStart(5, '0')}.png`;

export async function capture({ engine = 'classic', ref = false } = {}) {
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine "${engine}" (available: ${ENGINES.join(', ')})`);
  if (ref && engine !== 'classic') throw new Error('references are made with the classic engine');
  const outDir = ref ? REF_DIR : path.join(WORK, 'golden-out', engine);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer();
  try {
    const { id, doc, warnings } = await openGolden();
    if (warnings.length) console.warn(`warnings:\n  ${warnings.join('\n  ')}`);
    const fpsOf = Object.fromEntries(doc.sequences.map((s) => [s.id, s.fps]));
    const frames = frameList();
    const t0 = Date.now();
    for (const [i, f] of frames.entries()) {
      if (!fpsOf[f.seq]) throw new Error(`frames.json names sequence "${f.seq}", which the golden project doesn't have`);
      const out = path.join(outDir, frameFile(f, fpsOf[f.seq]));
      const r = await api('POST', `/api/p/${id}/still`, { sequenceId: f.seq, time: f.t, out, scale: 1 });
      if (r.error) throw new Error(`${f.seq} @ ${f.t}s: ${r.error}`);
      process.stdout.write(`\r  ${engine}: ${i + 1}/${frames.length} frames`);
    }
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s) → ${path.relative(ROOT, outDir)}`);
    fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify({ engine, at: new Date().toISOString(), fps: fpsOf }, null, 2) + '\n');
    return { outDir, fps: fpsOf };
  } finally {
    await server.stop();
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const engine = process.env.ENGINE || 'classic';
  capture({ engine, ref: process.argv.includes('--ref') }).catch((e) => { console.error(`\ncapture: ${e.message}`); process.exit(1); });
}
