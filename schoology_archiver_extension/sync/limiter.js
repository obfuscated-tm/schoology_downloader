// The one Limiter shared by background.js (answering schoologySlot /
// schoologyRateLimited from panels and content scripts) and sync/runner.js
// (the background sync uses the same instance directly — the service worker
// can't sendMessage to itself). Its own module so both can import it without
// background.js and sync/runner.js importing each other.

import { Limiter } from '../reader/ratelimit.js';

export const limiter = new Limiter();

const KEY_PAUSED_UNTIL = 'rateLimitPausedUntil';

// MV3 workers are killed and restarted at will; pausedUntil is persisted to
// chrome.storage.session (cleared when Chrome fully closes, kept across a
// worker restart) so a pause survives the worker being torn down mid-pause.
export async function restorePausedUntil() {
  try {
    const got = await chrome.storage.session.get(KEY_PAUSED_UNTIL);
    if (got?.[KEY_PAUSED_UNTIL]) limiter.pausedUntil = got[KEY_PAUSED_UNTIL];
  } catch { /* no chrome.storage.session (tests) */ }
}

export async function persistPausedUntil() {
  try { await chrome.storage.session.set({ [KEY_PAUSED_UNTIL]: limiter.pausedUntil }); } catch { /* tests */ }
}
