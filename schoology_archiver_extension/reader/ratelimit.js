// One shared rate limit for the whole extension. Schoology caps "15
// requests per 5 seconds" per user across the whole browser (its own page
// loads included), and shows either a 429 or — we don't know which — a 200
// HTML page reading "You have reached Schoology's Web App request limit of
// 15 requests per 5 seconds. Please refresh your browser to re-submit your
// request." Every context (service worker, panel, content scripts) shares
// one budget, through the service worker, so the background sync + overlays
// + archiver together never exceed what Schoology allows.

// True if `status`/`text` look like Schoology's own rate-limit response,
// whichever shape it takes. Pure.
export function isRateLimited(status, text) {
  if (status === 429) return true;
  const s = String(text || '');
  return /request limit of \d+ requests? per \d+ seconds?/i.test(s) || /Web App request limit/i.test(s);
}

export class RateLimitError extends Error {
  constructor(msg = 'Schoology rate limit hit') {
    super(msg);
    this.name = 'RateLimitError';
  }
}

const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const BACKOFF_RESET_MS = 60_000; // no hit for this long: back off to BASE again next time

// Sliding-window limiter: at most `max` acquisitions per `windowMs`. Leaves
// Schoology's own page loads (and the user's own clicking around) headroom
// out of its 15-per-5s limit. `now`/`sleep` are injectable for tests.
export class Limiter {
  constructor({ max = 8, windowMs = 5000, now = () => Date.now(), sleep: sleepFn } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleepFn || ((ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeAbortError());
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(makeAbortError()); }, { once: true });
    }));
    this.hits = []; // timestamps of acquisitions still inside the window
    this._pausedUntil = 0;
    this.backoffMs = BASE_BACKOFF_MS;
    this.lastPauseAt = 0;
    this.chain = Promise.resolve(); // serializes acquire() so concurrent callers never both slip through
  }

  get pausedUntil() { return this._pausedUntil; }
  set pausedUntil(v) { this._pausedUntil = v || 0; }

  // Called on a rate-limit hit: pause every acquisition, with doubling
  // backoff (10s, 20s, 40s… capped at 120s); the level resets to 10s once
  // 60s pass with no further hit.
  pause() {
    const now = this.now();
    if (this.lastPauseAt && now - this.lastPauseAt > BACKOFF_RESET_MS) this.backoffMs = BASE_BACKOFF_MS;
    this._pausedUntil = Math.max(this._pausedUntil, now + this.backoffMs);
    this.lastPauseAt = now;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  // Waits until a slot is free and the limiter isn't paused, then records
  // the acquisition. Concurrency-safe: queued behind a promise chain so many
  // concurrent acquire() calls never together exceed `max` in any window.
  async acquire(signal) {
    const run = this.chain.then(() => this._acquireOne(signal));
    // Keep the chain alive even if this acquire rejects (stopped signal).
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async _acquireOne(signal) {
    for (;;) {
      if (signal?.aborted) throw makeAbortError();
      const now = this.now();
      if (now < this._pausedUntil) {
        await this.sleep(this._pausedUntil - now, signal);
        continue;
      }
      this.hits = this.hits.filter((t) => now - t < this.windowMs);
      if (this.hits.length < this.max) {
        this.hits.push(now);
        return;
      }
      const wait = this.hits[0] + this.windowMs - now;
      await this.sleep(Math.max(wait, 1), signal);
    }
  }
}

function makeAbortError() {
  const e = new Error('Stopped');
  e.name = 'StoppedError';
  return e;
}

// ── Client helpers (extension panel page, content scripts — not the service worker) ──

const FALLBACK_MAX = 3;
const FALLBACK_WINDOW_MS = 5000;
// Longer than the longest pause (120s) plus a window: a slow answer is the
// service worker waiting out a pause, and falling back then would fetch
// mid-pause. A worker that's gone fails at once, not by timing out.
const SLOT_TIMEOUT_MS = 150_000;
let fallback = null; // only built if the service worker can't be reached
function fallbackLimiter() {
  return fallback ||= new Limiter({ max: FALLBACK_MAX, windowMs: FALLBACK_WINDOW_MS });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** A slot from the shared service-worker limiter, or a local fallback if it can't be reached. */
export async function acquireSlot(signal) {
  try {
    const r = await withTimeout(globalThis.chrome?.runtime?.sendMessage({ type: 'schoologySlot' }), SLOT_TIMEOUT_MS);
    if (r?.ok) return;
    throw new Error('no answer');
  } catch {
    return fallbackLimiter().acquire(signal);
  }
}

/** Tell the service worker (fire-and-forget) that a rate limit was hit, and pause the local fallback too. */
export function reportRateLimited() {
  try { globalThis.chrome?.runtime?.sendMessage({ type: 'schoologyRateLimited' })?.catch?.(() => {}); } catch { /* no chrome */ }
  fallbackLimiter().pause();
}

/**
 * fetch(), but through the shared limiter, and never handing back a
 * rate-limit page as if it were real content.
 */
export async function limitedFetch(url, init = {}, { signal } = {}) {
  await acquireSlot(signal);
  const r = await fetch(url, init);
  const text = await r.text();
  if (isRateLimited(r.status, text)) {
    reportRateLimited();
    throw new RateLimitError();
  }
  return {
    ok: r.ok,
    status: r.status,
    url: r.url,
    headers: r.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
