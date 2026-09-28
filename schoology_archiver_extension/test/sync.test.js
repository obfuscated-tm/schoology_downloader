// node --test test/   (from schoology_archiver_extension/)
//
// sync/sync.js's pure step-6 picker: pickForStatus. The full runSync loop is
// exercised by hand against a live token; this covers only the pure logic.
// Ids are numeric strings throughout: pickForStatus's ID_RE only accepts
// `\d{1,20}`, matching Schoology's own assignment ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickForStatus, STATUS_CAP, runSync, KEY_SNAPSHOT } from '../sync/sync.js';

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

// ── runSync: no neo-plan token configured (docs/MCP-BRIDGE.md) ─────────────
// With no token, neo-plan's course map ('courses') answers 401/token, same as
// outputs/neoplan/api.js's handleNeoplan does with nothing stored. The run
// should still read Schoology (courses, home lists, events) and fill
// snap.lists, but skip gradebooks, open ids, status checks and enrich —
// there's nothing for them to map against.

function fakeStorage() {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (obj) => Object.assign(data, obj) };
}

function fakeGetText(byPath) {
  return async (path) => {
    const e = byPath.get(path);
    if (e === undefined) throw new Error(`unscripted path ${path}`);
    return { text: e.text ?? 'ok', url: `https://x.schoology.com${path}` };
  };
}

const HOME_LIST_ROW = { schoology_id: '5', realm: 'Course : Sec', title: 'HW 1', due: '2026-09-30T00:00:00.000Z' };
const EVENT_ROW = { schoology_id: '9', realm: 'Course : Sec' };

function fakeSyncParse() {
  return async (kind) => {
    if (kind === 'courses') return { data: [{ section_id: '1', title: 'Course', section_title: 'Sec' }] };
    if (kind === 'homeList') return { data: [HOME_LIST_ROW] };
    if (kind === 'events') return { data: [EVENT_ROW] };
    throw new Error(`unexpected parse kind ${kind}`);
  };
}

test('runSync: no token — Schoology steps run, neo-plan steps skipped, lists filled, ok', async () => {
  const client = {
    mode: 'direct',
    abs: (p) => `https://x.schoology.com${p}`,
    findSchoologyTab: async () => null,
    getText: fakeGetText(new Map([
      ['/iapi/course/active', {}],
      ['/home/upcoming_submissions_ajax', {}],
      ['/home/overdue_submissions_ajax', {}],
      ['/home/upcoming_ajax', {}],
    ])),
  };
  const npCalls = [];
  const np = async (op) => {
    npCalls.push(op);
    if (op === 'courses') return { ok: false, status: 401, noToken: true, data: { error: 'token' } };
    throw new Error(`neo-plan should not be called with no token: ${op}`);
  };
  const storage = fakeStorage();
  const snap = await runSync({ client, parse: fakeSyncParse(), np, storage });

  assert.equal(snap.ok, true);
  assert.equal(snap.error, null);
  assert.equal(snap.neoplan, false);
  assert.deepEqual(npCalls, ['courses']); // only the one call that revealed there's no token
  assert.equal(snap.counts.courses, 1);
  assert.equal(snap.counts.gradebooks, 0);
  assert.equal(snap.counts.open, 0);
  assert.equal(snap.payload, undefined); // step 7 (enrich) never ran
  assert.deepEqual(snap.lists.upcoming, [HOME_LIST_ROW]);
  assert.deepEqual(snap.lists.overdue, [HOME_LIST_ROW]);
  assert.deepEqual(snap.lists.events, [EVENT_ROW]);
  assert.equal(storage.data[KEY_SNAPSHOT], snap); // written to storage same as the token path
});

test('runSync: with a token, neoplan stays true and lists are still filled', async () => {
  const client = {
    mode: 'direct',
    abs: (p) => `https://x.schoology.com${p}`,
    findSchoologyTab: async () => null,
    getText: fakeGetText(new Map([
      ['/iapi/course/active', {}],
      ['/home/upcoming_submissions_ajax', {}],
      ['/home/overdue_submissions_ajax', {}],
      ['/home/upcoming_ajax', {}],
    ])),
  };
  const np = async (op) => {
    if (op === 'courses') return { ok: true, data: { courses: [{ section_id: '1', class_id: null }] } };
    if (op === 'open') return { ok: true, data: { assignments: [] } };
    if (op === 'enrich') return { ok: true, data: { results: [], courses: [] } };
    throw new Error(`unexpected neo-plan op ${op}`);
  };
  const storage = fakeStorage();
  const snap = await runSync({ client, parse: fakeSyncParse(), np, storage });

  assert.equal(snap.ok, true);
  assert.equal(snap.neoplan, true);
  assert.ok(snap.payload); // step 7 ran
  assert.deepEqual(snap.lists.upcoming, [HOME_LIST_ROW]);
});

test('runSync: a token neo-plan refuses is still a token error, not the no-token path', async () => {
  const client = {
    mode: 'direct',
    abs: (p) => `https://x.schoology.com${p}`,
    findSchoologyTab: async () => null,
    getText: async (path) => { throw new Error(`no Schoology request with a refused token: ${path}`); },
  };
  const np = async () => ({ ok: false, status: 401, data: { error: 'unauthorized' } });
  const snap = await runSync({ client, parse: fakeSyncParse(), np, storage: fakeStorage() });

  assert.equal(snap.ok, false);
  assert.equal(snap.error, 'token');
  assert.equal(snap.neoplan, false);
});
