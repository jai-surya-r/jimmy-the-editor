// Where the app keeps throwaway data. Settings › Cache folder can move all of it into one folder (on another
// drive, say): project media caches go to <folder>/projects/<id> and temp files to <folder>/temp. Unset, caches
// stay in each project and temp files go to the system temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';

export const cacheRoot = () => getConfig().cacheDir || null;

// the long form of the system temp path: Claude Code asks before reading an 8.3 short name (C:\Users\ABC~1\…)
export function systemTemp() {
  try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
}

export function tempRoot() {
  const root = cacheRoot();
  if (!root) return systemTemp();
  const dir = path.join(root, 'temp');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return systemTemp(); }
  return dir;
}

// shrunk copies of the images Claude checks (bin/check-image.mjs)
export const checksDir = () => path.join(tempRoot(), 'claude-edit-checks');
