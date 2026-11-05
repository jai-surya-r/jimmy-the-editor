// Extra Claude Code settings for the editor's own sessions (chat panel and built-in terminal), passed with
// --settings so the user's Claude settings stay untouched. They add one hook: images Claude reads are shrunk
// to check size (bin/check-image.mjs), and the folder holding the shrunk copies is readable without asking.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, DATA_DIR } from './util.js';
import { FFMPEG } from './ffmpeg.js';
import { checksDir } from './cachedir.js';

const FILE = path.join(DATA_DIR, 'claude-session-settings.json');
let written = null; // the checks folder the file was written for

export function sessionSettingsFile() {
  const checks = checksDir();
  if (written === checks) return FILE;
  const q = (s) => `"${s}"`;
  const settings = {
    permissions: { additionalDirectories: [checks] },
    hooks: {
      PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', timeout: 30,
        command: [process.execPath, path.join(APP_DIR, 'bin', 'check-image.mjs'), FFMPEG || 'ffmpeg', checks].map(q).join(' ') }] }],
    },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  written = checks;
  return FILE;
}
