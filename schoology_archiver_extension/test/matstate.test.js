// node --test test/   (from schoology_archiver_extension/)
//
// What the Materials overlay says about a row or a folder (overlays/matstate.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowState, folderTotals, summaryParts, pctText, scoreText, shortDue, ago } from '../overlays/matstate.js';

test('a row: the gradebook first, then neo-plan', () => {
  assert.deepEqual(rowState({ earned: 10, possible: 10 }, { work: 'todo' }), { kind: 'graded', earned: 10, possible: 10 });
  assert.equal(rowState({ earned: null, possible: null }, undefined).kind, 'unknown');
  assert.equal(rowState(undefined, null).kind, 'none');
  assert.equal(rowState(undefined, { removed: true, cleared: true }).kind, 'removed');
  assert.deepEqual(rowState(undefined, { cleared: true, cleared_by: 'schoology' }), { kind: 'submitted', word: 'Submitted' });
  assert.deepEqual(rowState(undefined, { cleared: true, type: 'assignment' }), { kind: 'submitted', word: 'Turned in' });
  assert.equal(rowState(undefined, { missing: true, work: 'ready' }).kind, 'missing');
  assert.equal(rowState(undefined, { work: 'ready' }).kind, 'ready');
  assert.equal(rowState(undefined, { work: 'todo' }).kind, 'todo');
});

// root ─ Lesson 8 (3 assignments) ─ Extra (1)
//      └ Course Information (1, graded)
const TREE = {
  root: { a: [], f: ['8', 'info'] },
  8: { a: [{ id: 'checkmail' }, { id: 'happy' }, { id: 'quiz' }], f: ['extra'] },
  extra: { a: [{ id: 'madlibs' }], f: [] },
  info: { a: [{ id: 'agree' }], f: [] },
};
const GRADES = { quiz: { earned: 9, possible: 10 }, agree: { earned: 5, possible: 5 } };
const ITEMS = { checkmail: { missing: true }, happy: { work: 'ready' }, madlibs: { work: 'todo' }, quiz: { cleared: true } };
const gradeOf = (id) => GRADES[id];
const stateOf = (id) => rowState(GRADES[id], id in ITEMS ? ITEMS[id] : null);

test('a folder counts its subfolders, and scores only what is graded', () => {
  const t = folderTotals(TREE, '8', stateOf, gradeOf);
  assert.equal(t.missing, 1);
  assert.equal(t.ready, 1);
  assert.equal(t.todo, 1);
  assert.equal(t.open, 3);
  assert.equal(t.assignments, 4);
  assert.equal(t.pct, 90);
  assert.equal(t.known, true);
  assert.deepEqual(summaryParts(t), [{ text: '1 missing', bad: true }, { text: '1 to turn in' }, { text: '1 to do' }]);

  const info = folderTotals(TREE, 'info', stateOf, gradeOf);
  assert.deepEqual(summaryParts(info), [{ text: 'All turned in' }]);
  assert.equal(pctText(info.pct), '100.0%');
  assert.equal(folderTotals(TREE, 'root', stateOf, gradeOf).open, 3);
});

test('a folder is not "All turned in" until everything in it is known', () => {
  const unread = folderTotals({ root: { a: [], f: ['x'] } }, 'root', stateOf, gradeOf);
  assert.equal(unread.known, false);
  assert.deepEqual(summaryParts(unread), []);
  const waiting = folderTotals(TREE, 'info', () => ({ kind: 'unknown' }), () => undefined);
  assert.deepEqual(summaryParts(waiting), []);
  assert.equal(pctText(waiting.pct), '');
  assert.deepEqual(summaryParts(folderTotals({ e: { a: [], f: [] } }, 'e', stateOf, gradeOf)), []);
  // Not in neo-plan and not turned in: not "All turned in".
  assert.deepEqual(summaryParts(folderTotals({ n: { a: [{ id: 'agree' }, { id: 'nope' }], f: [] } }, 'n', stateOf, gradeOf)), []);
});

test('a folder that contains itself is counted once', () => {
  const t = folderTotals({ a: { a: [{ id: 'madlibs' }], f: ['a'] } }, 'a', stateOf, gradeOf);
  assert.equal(t.todo, 1);
});

test('text', () => {
  assert.equal(scoreText(19.05, 20), '19.05 / 20');
  assert.equal(pctText(96.66), '96.7%');
  assert.equal(shortDue({ due: { on: '2026-09-23' } }), 'Wed, 9/23');
  assert.equal(shortDue(null, new Date(2026, 8, 25, 23, 59).toISOString()), 'Fri, 9/25');
  assert.equal(shortDue(null, null), '');
  const now = Date.parse('2026-09-26T12:00:00Z');
  assert.equal(ago('2026-09-26T11:59:30Z', now), 'just now');
  assert.equal(ago('2026-09-26T11:15:00Z', now), '45 min ago');
  assert.equal(ago('2026-09-26T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-09-25T09:00:00Z', now), 'yesterday');
  assert.equal(ago('2026-09-24T12:00:00Z', now), '2 days ago');
  assert.equal(ago('nope', now), '');
});
