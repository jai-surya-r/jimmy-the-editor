// The power tiers (server/machine.js measures which one this computer is) and what each asks of it. Read by the
// code whose limits they set: ffmpeg.js (render slots), media.js (which footage gets a proxy), motion.js (pages).
import { getConfig } from './config.js';

export const TIERS = ['light', 'balanced', 'full'];
// what each tier sets (Settings can still change each one afterwards)
export const TIER_SETTINGS = {
  light: { performance: { usage: 50, priority: 'idle', jobs: 1 }, prerender: { enabled: false, light: true } },
  balanced: { performance: { usage: 70, priority: 'low', jobs: 2 }, prerender: { enabled: true, light: true } },
  full: { performance: { usage: 70, priority: 'low', jobs: 2 }, prerender: { enabled: true, light: true } },
};
// limits that have no setting of their own
export const TIER_LIMITS = {
  light: { renderSlots: 1, motionPages: 2, proxyAbove: 1920 * 1200, proxyFps: { above: 1280 * 720, fps: 31 }, previewCap: 0.5 },
  balanced: { renderSlots: 3, motionPages: 4, proxyAbove: 1920 * 1200, proxyFps: null, previewCap: 1 },
  full: { renderSlots: 8, motionPages: 6, proxyAbove: 2560 * 1600, proxyFps: null, previewCap: 1 },
};
// the tier in use: the profile picked in Settings, or the measured one ('full' until measured). Windows only for
// now: a Mac always works as it did ('full').
export function currentTier(cfg = getConfig()) {
  if (process.platform !== 'win32' && !process.env.JIMMY_TIERS_ANYWHERE) return 'full';
  const pick = cfg.performance?.profile;
  if (TIERS.includes(pick)) return pick;
  return TIERS.includes(cfg.machine?.tier) ? cfg.machine.tier : 'full';
}
export const tierLimits = (cfg) => TIER_LIMITS[currentTier(cfg)];
