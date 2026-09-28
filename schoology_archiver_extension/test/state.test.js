// node --test test/   (from schoology_archiver_extension/)
//
// outputs/archive/state.js's pure pieces: the archive job's state lives in
// chrome.storage.session (background.js) and is folded from progress
// messages the offscreen job posts — none of that needs a browser to test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCourseId, sanitizeOptions, appendLog, reduceProgress, DEFAULT_OPTIONS, OPTION_KEYS } from '../outputs/archive/state.js';

test('isValidCourseId: digits only, 1-20 of them', () => {
  assert.equal(isValidCourseId('12345'), true);
  assert.equal(isValidCourseId(12345), true);
  assert.equal(isValidCourseId('1'), true);
  assert.equal(isValidCourseId('1'.repeat(20)), true);
});

test('isValidCourseId: refuses anything else', () => {
  assert.equal(isValidCourseId('1'.repeat(21)), false);
  assert.equal(isValidCourseId('12a45'), false);
  assert.equal(isValidCourseId(''), false);
  assert.equal(isValidCourseId(undefined), false);
  assert.equal(isValidCourseId(null), false);
  assert.equal(isValidCourseId('-5'), false);
  assert.equal(isValidCourseId('12345; DROP TABLE'), false);
});

test('sanitizeOptions: only the known keys, coerced to booleans', () => {
  const out = sanitizeOptions({ google: 1, submissions: 0, quizzes: 'yes', extra: true, __proto__: { polluted: true } });
  assert.deepEqual(Object.keys(out).sort(), [...OPTION_KEYS].sort());
  assert.equal(out.google, true);
  assert.equal(out.submissions, false);
  assert.equal(out.quizzes, true);
  assert.equal('extra' in out, false);
  assert.equal('polluted' in out, false);
});

test('sanitizeOptions: garbage input falls back to the defaults', () => {
  assert.deepEqual(sanitizeOptions(null), DEFAULT_OPTIONS);
  assert.deepEqual(sanitizeOptions(undefined), DEFAULT_OPTIONS);
  assert.deepEqual(sanitizeOptions('nope'), DEFAULT_OPTIONS);
  assert.deepEqual(sanitizeOptions(42), DEFAULT_OPTIONS);
});

test('appendLog: appends in order', () => {
  assert.deepEqual(appendLog(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(appendLog(undefined, 'a'), ['a']);
  assert.deepEqual(appendLog(null, 'a'), ['a']);
});

test('appendLog: drops the oldest lines past max', () => {
  const log = ['1', '2', '3'];
  assert.deepEqual(appendLog(log, '4', 3), ['2', '3', '4']);
  assert.deepEqual(appendLog([], 'x', 0), []);
});

test('reduceProgress: ignores a message for a different (stale) job', () => {
  const state = { jobId: 'a', log: [], running: true };
  const next = reduceProgress(state, { jobId: 'b', log: 'hi' });
  assert.equal(next, state); // same reference: untouched
});

test('reduceProgress: folds a log line, count and status', () => {
  const state = { jobId: 'a', log: [], counts: 0, status: 'Starting…', running: true };
  const next = reduceProgress(state, { jobId: 'a', log: '📁 Materials (3 items)', count: 1 });
  assert.deepEqual(next.log, [{ text: '📁 Materials (3 items)', level: '' }]);
  assert.equal(next.counts, 1);
  assert.equal(next.status, 'Starting…'); // unchanged: no status in this message
});

test('reduceProgress: a warn/error level line is kept', () => {
  const state = { jobId: 'a', log: [] };
  const next = reduceProgress(state, { jobId: 'a', log: 'uh oh', level: 'error' });
  assert.deepEqual(next.log, [{ text: 'uh oh', level: 'error' }]);
});

test('reduceProgress: courseName arrives once the Archiver reads it', () => {
  const state = { jobId: 'a', log: [], courseName: null };
  const next = reduceProgress(state, { jobId: 'a', courseName: 'AP Biology' });
  assert.equal(next.courseName, 'AP Biology');
});

test('reduceProgress: done finalizes the job', () => {
  const state = { jobId: 'a', log: [], running: true };
  const next = reduceProgress(state, { jobId: 'a', done: true, summary: '3 new', stopped: false });
  assert.equal(next.running, false);
  assert.equal(next.summary, '3 new');
  assert.equal(next.stopped, false);
  assert.equal(next.error, null);
  assert.ok(next.finishedAt > 0);
});

test('reduceProgress: done with an error records it', () => {
  const state = { jobId: 'a', log: [], running: true };
  const next = reduceProgress(state, { jobId: 'a', done: true, error: 'Not logged in.' });
  assert.equal(next.running, false);
  assert.equal(next.error, 'Not logged in.');
});

test('reduceProgress: a null state (nothing stored yet) stays null', () => {
  assert.equal(reduceProgress(null, { jobId: 'a', log: 'x' }), null);
});
