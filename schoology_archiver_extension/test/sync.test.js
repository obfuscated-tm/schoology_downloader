// node --test test/   (from schoology_archiver_extension/)
//
// sync/sync.js's pure step-6 picker: pickForStatus. The full runSync loop is
// exercised by hand against a live token; this covers only the pure logic.
// Ids are numeric strings throughout: pickForStatus's ID_RE only accepts
// `\d{1,20}`, matching Schoology's own assignment ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickForStatus, STATUS_CAP } from '../sync/sync.js';

test('STATUS_CAP is 10 (fewer /assignment/{id}/info requests per run)', () => {
  assert.equal(STATUS_CAP, 10);
});

test('pickForStatus: never-checked ids first, then oldest-checked', () => {
  const now = 1_000_000;
  const checked = { 1: 100, 2: 50 }; // both far older than any minAgeMs below
  const picked = pickForStatus(['1', '2', '3'], checked, 10, 0, now);
  assert.deepEqual(picked, ['3', '2', '1']); // 3 never checked, then 2 (oldest), then 1
});

test('pickForStatus: an id checked less than minAgeMs ago is dropped entirely, not just deprioritized', () => {
  const now = 1_000_000;
  const minAgeMs = 30 * 60 * 1000;
  const checked = { 1: now - minAgeMs + 1000, 2: now - minAgeMs - 1000 }; // 1: too recent; 2: old enough
  const picked = pickForStatus(['1', '2'], checked, 10, minAgeMs, now);
  assert.deepEqual(picked, ['2']);
});

test('pickForStatus: never-checked ids are always picked regardless of minAgeMs', () => {
  const now = 1_000_000;
  const picked = pickForStatus(['1'], {}, 10, 30 * 60 * 1000, now);
  assert.deepEqual(picked, ['1']);
});

test('pickForStatus: caps at `cap`', () => {
  const ids = Array.from({ length: 15 }, (_, i) => String(i + 1));
  const picked = pickForStatus(ids, {}, 10, 0, 1000);
  assert.equal(picked.length, 10);
});

test('pickForStatus: default minAgeMs is 30 minutes', () => {
  const now = 1_000_000;
  const checked = { 1: now - 1000 }; // checked 1s ago: well under 30 min
  assert.deepEqual(pickForStatus(['1'], checked, 10, undefined, now), []);
});

test('pickForStatus: ignores malformed ids and de-dupes, as before', () => {
  assert.deepEqual(pickForStatus(['1', '1', 'abc', '2'], {}, 10, 0, 1000), ['1', '2']);
});
