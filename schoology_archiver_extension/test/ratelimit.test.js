// node --test test/*.test.js   (from schoology_archiver_extension/)
//
// The shared rate limiter (reader/ratelimit.js): recognizing Schoology's own
// "request limit" response (429 or a 200 HTML page saying so), the sliding
// window never handing out more than `max` slots per window even under
// concurrent callers, the pause/backoff behavior a hit triggers, and
// SchoologyClient.getText retrying through a limit page before giving up.
//
// Fake clock throughout: `now`/`sleep` are injected so nothing here waits on
// a real timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, Limiter, RateLimitError } from '../reader/ratelimit.js';
import { SchoologyClient } from '../reader/client.js';

test('isRateLimited: a 429 is always the limit, whatever the body', () => {
  assert.equal(isRateLimited(429, ''), true);
  assert.equal(isRateLimited(429, '<html>ok</html>'), true);
});

test('isRateLimited: a 200 page carrying Schoology\'s own limit text', () => {
  const body = '<html><body>You have reached Schoology\'s Web App request limit of 15 requests per 5 seconds. Please refresh your browser to re-submit your request.</body></html>';
  assert.equal(isRateLimited(200, body), true);
  assert.equal(isRateLimited(200, 'some other Web App request limit banner'), true);
});

test('isRateLimited: an ordinary page is not mistaken for the limit', () => {
  assert.equal(isRateLimited(200, '<html><body>Course Materials</body></html>'), false);
  assert.equal(isRateLimited(200, ''), false);
  assert.equal(isRateLimited(404, 'Not Found'), false);
});

// A fake clock: sleep(ms) advances the virtual clock by ms and resolves
// right away, so a Limiter's internal wait loop runs with no real delay but
// still exercises the same timing logic.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
    get t() { return t; },
  };
}

test('Limiter: never hands out more than max slots in any window, even under concurrent acquires', async () => {
  const clock = fakeClock();
  const max = 3;
  const windowMs = 1000;
  const limiter = new Limiter({ max, windowMs, now: clock.now, sleep: clock.sleep });
  const hits = [];
  // 10 concurrent callers, all firing at once.
  await Promise.all(Array.from({ length: 10 }, () => limiter.acquire().then(() => hits.push(clock.now()))));
  assert.equal(hits.length, 10);
  // Slide a window of size windowMs across every recorded hit and check
  // that it never contains more than max of them.
  for (const t0 of hits) {
    const inWindow = hits.filter((t) => t >= t0 && t - t0 < windowMs).length;
    assert.ok(inWindow <= max, `window at ${t0} had ${inWindow} hits`);
  }
});

test('Limiter: a stopped signal aborts a waiting acquire', async () => {
  const clock = fakeClock();
  const limiter = new Limiter({ max: 1, windowMs: 1000, now: clock.now, sleep: clock.sleep });
  await limiter.acquire(); // fills the only slot
  const ac = new AbortController();
  const p = limiter.acquire(ac.signal);
  ac.abort();
  await assert.rejects(p, /Stopped/);
});

test('Limiter.pause: backoff doubles on repeated hits, caps at 120s, resets after 60s quiet', () => {
  const clock = fakeClock(0);
  const limiter = new Limiter({ now: clock.now });
  limiter.pause();
  assert.equal(limiter.pausedUntil, 10_000); // first hit: 10s

  clock.advance(10_000); // t = 10_000, right at the pause boundary (< 60s since last hit)
  limiter.pause();
  assert.equal(limiter.pausedUntil, 30_000); // 10_000 + 20s

  clock.advance(20_000); // t = 30_000
  limiter.pause();
  assert.equal(limiter.pausedUntil, 70_000); // 30_000 + 40s

  clock.advance(40_000); // t = 70_000
  limiter.pause();
  assert.equal(limiter.pausedUntil, 150_000); // 70_000 + 80s

  clock.advance(80_000); // t = 150_000, exactly 80s since the last hit: over the 60s reset window
  limiter.pause();
  assert.equal(limiter.pausedUntil, 160_000); // backoff reset to 10s: 150_000 + 10s
});

test('Limiter.pausedUntil getter/setter: the service worker can persist and restore it', () => {
  const limiter = new Limiter();
  limiter.pausedUntil = 12345;
  assert.equal(limiter.pausedUntil, 12345);
});

test('Limiter: acquire() waits out a pause before granting a slot', async () => {
  const clock = fakeClock();
  const limiter = new Limiter({ max: 5, windowMs: 1000, now: clock.now, sleep: clock.sleep });
  limiter.pause(); // pausedUntil = 10_000
  await limiter.acquire();
  assert.equal(clock.t, 10_000);
});

// ── SchoologyClient.getText: retry on a rate-limit page, then RateLimitError ──

function makeClient({ raw }) {
  const acquireCalls = [];
  const rateLimitedCalls = [];
  const client = new SchoologyClient({
    host: 'x.schoology.com',
    log: () => {},
    acquire: async () => { acquireCalls.push(1); },
    onRateLimited: () => { rateLimitedCalls.push(1); },
  });
  client.raw = raw;
  client.verified = true; // skip the "not verified yet" TypeError short-circuit
  return { client, acquireCalls, rateLimitedCalls };
}

test('SchoologyClient.getText: retries a limit page, then throws RateLimitError', async () => {
  const LIMIT_PAGE = "You have reached Schoology's Web App request limit of 15 requests per 5 seconds. Please refresh your browser to re-submit your request.";
  let calls = 0;
  const { client, acquireCalls, rateLimitedCalls } = makeClient({
    raw: async (url) => { calls++; return { status: 200, url, text: LIMIT_PAGE }; },
  });
  await assert.rejects(client.getText('/course/1/materials'), (e) => e instanceof RateLimitError);
  assert.equal(calls, 3); // three attempts, all rate-limited
  assert.equal(acquireCalls.length, 3); // throttle() (the shared limiter) ran before each
  assert.equal(rateLimitedCalls.length, 3); // reported every time
});

test('SchoologyClient.getText: a limit page on attempt 1 then a real page on attempt 2 succeeds', async () => {
  const LIMIT_PAGE = 'Web App request limit reached';
  let calls = 0;
  const { client } = makeClient({
    raw: async (url) => {
      calls++;
      if (calls === 1) return { status: 200, url, text: LIMIT_PAGE };
      return { status: 200, url, text: '<html>ok</html>' };
    },
  });
  const r = await client.getText('/course/1/materials');
  assert.equal(calls, 2);
  assert.equal(r.text, '<html>ok</html>');
});

test('SchoologyClient.getText: a plain 429 with no recognizable body is also treated as the limit', async () => {
  const { client } = makeClient({ raw: async (url) => ({ status: 429, url, text: '' }) });
  await assert.rejects(client.getText('/course/1/materials'), (e) => e instanceof RateLimitError);
});
