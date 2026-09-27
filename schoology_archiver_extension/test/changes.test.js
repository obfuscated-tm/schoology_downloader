// node --test test/*.test.js   (from schoology_archiver_extension/)
//
// reader/changes.js: the folder-row signature that lets a re-archive skip a
// document/link/page whose row hasn't moved, the assignment change key built
// from /v2/events (etag never trusted alone), and the shouldSkip decision
// that combines both with how long ago a detail page was last opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowSignature, eventChangeKeys, shouldSkip } from '../reader/changes.js';

// ── rowSignature ──────────────────────────────────────────────────────────

const baseRow = {
  kind: 'document', title: 'Lecture notes', url: 'https://x.schoology.com/materials/gp/1',
  rowText: '',
  files: [{ url: 'https://x.schoology.com/attachment/1/source/abc.pdf', filename: 'notes.pdf', title: 'notes.pdf' }],
  links: [],
};

test('rowSignature: identical rows (rebuilt from scratch) match', () => {
  const a = rowSignature(baseRow);
  const b = rowSignature(JSON.parse(JSON.stringify(baseRow)));
  assert.equal(a, b);
});

test('rowSignature: a title change is a different signature', () => {
  const changed = { ...baseRow, title: 'Lecture notes (updated)' };
  assert.notEqual(rowSignature(baseRow), rowSignature(changed));
});

test('rowSignature: an added file is a different signature', () => {
  const changed = { ...baseRow, files: [...baseRow.files, { url: 'https://x.schoology.com/attachment/2/source/def.pdf', filename: 'extra.pdf', title: 'extra.pdf' }] };
  assert.notEqual(rowSignature(baseRow), rowSignature(changed));
});

test('rowSignature: a renamed file (same url, new filename) is a different signature', () => {
  const changed = { ...baseRow, files: [{ ...baseRow.files[0], filename: 'renamed.pdf' }] };
  assert.notEqual(rowSignature(baseRow), rowSignature(changed));
});

test('rowSignature: a renamed link title is a different signature', () => {
  const withLink = { ...baseRow, links: [{ href: '/x', url: 'https://x.schoology.com/x', title: 'Old title' }] };
  const renamed = { ...baseRow, links: [{ href: '/x', url: 'https://x.schoology.com/x', title: 'New title' }] };
  assert.notEqual(rowSignature(withLink), rowSignature(renamed));
});

test('rowSignature: unrelated rows (different kind/url) never collide', () => {
  const assignment = { kind: 'assignment', title: 'Lecture notes', url: 'https://x.schoology.com/assignment/9', rowText: '' };
  assert.notEqual(rowSignature(baseRow), rowSignature(assignment));
});

// ── eventChangeKeys ───────────────────────────────────────────────────────

const H = 'https://x.schoology.com';
function eventsJson(assignments) {
  return JSON.stringify({ '@extra': assignments });
}

test('eventChangeKeys: only assignment urls (/assignment/{id}) produce a key; others are ignored', async () => {
  const json = eventsJson([
    { '@id': 'a', url: `${H}/assignment/101`, title: 'Lab 1', '@cache': { etag: 'e'.repeat(64) } },
    { '@id': 'b', url: `${H}/course/12/assessments/202`, title: 'Quiz 1' }, // not an /assignment/ url
    { '@id': 'c', title: 'no url at all' },
  ]);
  const keys = await eventChangeKeys(json);
  assert.equal(keys.size, 1);
  assert.ok(keys.has('101'));
  assert.ok(!keys.has('202'));
});

test('eventChangeKeys: same etag, changed description -> different key (etag alone is never trusted)', async () => {
  const etag = 'e'.repeat(64);
  const before = eventsJson([{ url: `${H}/assignment/101`, title: 'Lab 1', description: '<p>Do the thing</p>', dueDateInUTCISO: '2026-09-28T06:59:00Z', maxPoints: 10, category: 'Labs', submitted: false, '@cache': { etag } }]);
  const after = eventsJson([{ url: `${H}/assignment/101`, title: 'Lab 1', description: '<p>Do the OTHER thing</p>', dueDateInUTCISO: '2026-09-28T06:59:00Z', maxPoints: 10, category: 'Labs', submitted: false, '@cache': { etag } }]);
  const k1 = (await eventChangeKeys(before)).get('101');
  const k2 = (await eventChangeKeys(after)).get('101');
  assert.notEqual(k1, k2);
});

test('eventChangeKeys: identical content produces the same key even with no etag at all', async () => {
  const json = eventsJson([{ url: `${H}/assignment/101`, title: 'Lab 1', description: 'x', dueDateInUTCISO: '2026-09-28T06:59:00Z', maxPoints: 10, category: 'Labs', submitted: false }]);
  const k1 = (await eventChangeKeys(json)).get('101');
  const k2 = (await eventChangeKeys(json)).get('101');
  assert.equal(k1, k2);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.length > 0);
});

test('eventChangeKeys: submitted flipping true is a different key (new content to archive)', async () => {
  const notSubmitted = eventsJson([{ url: `${H}/assignment/101`, title: 'Lab 1', description: 'x', dueDateInUTCISO: '2026-09-28T06:59:00Z', maxPoints: 10, category: 'Labs', submitted: false }]);
  const submitted = eventsJson([{ url: `${H}/assignment/101`, title: 'Lab 1', description: 'x', dueDateInUTCISO: '2026-09-28T06:59:00Z', maxPoints: 10, category: 'Labs', submitted: true }]);
  const k1 = (await eventChangeKeys(notSubmitted)).get('101');
  const k2 = (await eventChangeKeys(submitted)).get('101');
  assert.notEqual(k1, k2);
});

test('eventChangeKeys: not JSON -> empty map', async () => {
  const keys = await eventChangeKeys('not json');
  assert.equal(keys.size, 0);
});

// ── shouldSkip ────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const okStored = (over = {}) => ({
  ok: true, sig: 'sig-1', checkedAt: new Date(NOW - 2 * HOUR).toISOString(),
  entry: { title: 'x' }, changeKey: 'key-1', ...over,
});

test('shouldSkip: redownloadAll always forces a re-check', () => {
  assert.equal(shouldSkip({
    stored: okStored(), row: {}, sig: 'sig-1', kind: 'document',
    assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: true,
  }), false);
});

test('shouldSkip: no stored item (new row) is never skipped', () => {
  assert.equal(shouldSkip({
    stored: undefined, row: {}, sig: 'sig-1', kind: 'document',
    assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: last run errored (ok !== true) is never skipped', () => {
  assert.equal(shouldSkip({
    stored: okStored({ ok: false }), row: {}, sig: 'sig-1', kind: 'document',
    assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: missing stored.entry is never skipped', () => {
  assert.equal(shouldSkip({
    stored: okStored({ entry: undefined }), row: {}, sig: 'sig-1', kind: 'document',
    assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: a changed row signature is never skipped', () => {
  assert.equal(shouldSkip({
    stored: okStored(), row: {}, sig: 'sig-2 (different)', kind: 'document',
    assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: document/link/page/quiz — skipped inside the 7-day re-check window', () => {
  for (const kind of ['document', 'page', 'discussion', 'quiz', 'other']) {
    assert.equal(shouldSkip({
      stored: okStored({ checkedAt: new Date(NOW - 6 * DAY).toISOString() }), row: {}, sig: 'sig-1', kind,
      assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: false,
    }), true, kind);
  }
});

test('shouldSkip: document past the 7-day window is re-checked', () => {
  assert.equal(shouldSkip({
    stored: okStored({ checkedAt: new Date(NOW - 8 * DAY).toISOString() }), row: {}, sig: 'sig-1', kind: 'document',
    assignmentId: null, eventKeys: new Map(), eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: assignment in the event map — skipped only if the change key still matches', () => {
  const eventKeys = new Map([['55', 'key-1']]);
  assert.equal(shouldSkip({
    stored: okStored(), row: {}, sig: 'sig-1', kind: 'assignment',
    assignmentId: '55', eventKeys, eventsAvailable: true, now: NOW, redownloadAll: false,
  }), true);
});

test('shouldSkip: assignment in the event map with a changed key is re-checked, however recent', () => {
  const eventKeys = new Map([['55', 'key-2 (changed)']]);
  assert.equal(shouldSkip({
    stored: okStored({ checkedAt: new Date(NOW - HOUR).toISOString() }), row: {}, sig: 'sig-1', kind: 'assignment',
    assignmentId: '55', eventKeys, eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: assignment not in the event map, events available — weekly re-check (past/undated work)', () => {
  const eventKeys = new Map(); // 55 not upcoming/overdue
  assert.equal(shouldSkip({
    stored: okStored({ checkedAt: new Date(NOW - 6 * DAY).toISOString() }), row: {}, sig: 'sig-1', kind: 'assignment',
    assignmentId: '55', eventKeys, eventsAvailable: true, now: NOW, redownloadAll: false,
  }), true);
  assert.equal(shouldSkip({
    stored: okStored({ checkedAt: new Date(NOW - 8 * DAY).toISOString() }), row: {}, sig: 'sig-1', kind: 'assignment',
    assignmentId: '55', eventKeys, eventsAvailable: true, now: NOW, redownloadAll: false,
  }), false);
});

test('shouldSkip: assignment not in the event map, events unavailable — falls back to a daily re-check', () => {
  const eventKeys = new Map();
  assert.equal(shouldSkip({
    stored: okStored({ checkedAt: new Date(NOW - 12 * HOUR).toISOString() }), row: {}, sig: 'sig-1', kind: 'assignment',
    assignmentId: '55', eventKeys, eventsAvailable: false, now: NOW, redownloadAll: false,
  }), true);
  assert.equal(shouldSkip({
    stored: okStored({ checkedAt: new Date(NOW - 2 * DAY).toISOString() }), row: {}, sig: 'sig-1', kind: 'assignment',
    assignmentId: '55', eventKeys, eventsAvailable: false, now: NOW, redownloadAll: false,
  }), false);
});
