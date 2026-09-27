// node --test test/   (from schoology_archiver_extension/)
//
// What the assignment page's overlay says (overlays/asgstate.js), and how it
// finds the folder an assignment is in (overlays/coursedata.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chipState, findItem, signed, zeroCost, whatIfGrade, rankIn, rankText, lateDays, lateText, pointsFromText, inArchive,
} from '../overlays/asgstate.js';
import { folderHolding, folderName } from '../overlays/coursedata.js';

test('the chip: the gradebook first, then neo-plan, then the page', () => {
  assert.equal(chipState({ earned: 9, possible: 10 }, { removed: true }, false), 'graded');
  assert.equal(chipState({ earned: null, possible: null }, { removed: true }, true), 'removed');
  assert.equal(chipState(undefined, { work: 'todo' }, true), 'submitted');
  assert.equal(chipState(undefined, { cleared: true }, false), 'submitted');
  assert.equal(chipState(undefined, null, true), 'submitted');
  assert.equal(chipState(undefined, null, false), 'none');
  assert.equal(chipState(undefined, undefined, false), 'unknown');
  assert.equal(chipState(undefined, { missing: true }, false), 'open');
});

// Labs 25%, Tests 75%. Labs 18/20 (90%), Tests 95/100 (95%) → 93.75%.
const COURSE = {
  categories: [
    { title: 'Labs', weight: 25, items: [
      { id: 'l1', earned: 10, possible: 10 },
      { id: 'l2', earned: 8, possible: 10 },
      { id: 'l3', earned: null, possible: null },
    ] },
    { title: 'Tests', weight: 75, items: [
      { id: 't1', earned: 45, possible: 50 },
      { id: 't2', earned: 50, possible: 50 },
      { id: 't3', earned: 45, possible: 50 },
    ] },
  ],
};

test('finding an item in the gradebook periods', () => {
  const f = findItem([{ title: 'T1', categories: [] }, COURSE], 't2');
  assert.equal(f.course, COURSE);
  assert.equal(f.category.title, 'Tests');
  assert.equal(findItem([COURSE], 'nope'), null);
});

test('a zero on an ungraded lab, and a what-if', () => {
  // Labs with a 0/10: 18/30 = 60% → 0.25·60 + 0.75·93.33 = 85 vs 0.25·90 + 0.75·93.33 = 92.5
  const z = zeroCost(COURSE, 'l3', 10);
  assert.ok(Math.abs(z - -7.5) < 1e-9, z);
  assert.equal(zeroCost(COURSE, 'l3', null), null);
  const w = whatIfGrade(COURSE, 'l3', 10, 10);
  assert.ok(Math.abs(w.pct - (0.25 * (28 / 30) * 100 + 0.75 * (140 / 150) * 100)) < 1e-9);
  assert.ok(w.delta > 0);
  assert.equal(whatIfGrade(COURSE, 'l3', null, 10), null);
  assert.equal(whatIfGrade(COURSE, 'l3', 5, null), null);
  assert.equal(signed(-7.5), '−7.50');
  assert.equal(signed(0.4), '+0.40');
});

test('rank in a category, lowest first; ties share', () => {
  const tests = COURSE.categories[1];
  assert.deepEqual(rankIn(tests, 't1'), { rank: 1, of: 3 });
  assert.deepEqual(rankIn(tests, 't3'), { rank: 1, of: 3 });
  assert.deepEqual(rankIn(tests, 't2'), { rank: 3, of: 3 });
  assert.equal(rankIn({ items: [{ id: 'a', earned: 1, possible: 1 }] }, 'a'), null);
  assert.equal(rankText({ rank: 1, of: 3 }, 'Tests'), 'Lowest of 3 in Tests');
  assert.equal(rankText({ rank: 2, of: 5 }, 'Tests'), '2nd lowest of 5 in Tests');
  assert.equal(rankText({ rank: 3, of: 5 }, 'Tests'), '3rd lowest of 5 in Tests');
  assert.equal(rankText({ rank: 11, of: 12 }, 'Labs'), '11th lowest of 12 in Labs');
  assert.equal(rankText({ rank: 22, of: 30 }, 'Labs'), '22nd lowest of 30 in Labs');
});

test('late by whole days, rounded up', () => {
  const due = '2026-09-23T06:59:00.000Z';
  assert.equal(lateDays(due, Date.parse('2026-09-23T06:00:00Z')), 0);
  assert.equal(lateDays(due, Date.parse('2026-09-23T08:00:00Z')), 1);
  assert.equal(lateDays(due, Date.parse('2026-09-26T06:00:00Z')), 3);
  assert.equal(lateDays(null, Date.now()), 0);
  assert.equal(lateText(0), 'Late');
  assert.equal(lateText(1), 'Late by 1 day');
  assert.equal(lateText(3), 'Late by 3 days');
});

test('points from the page, never from a date', () => {
  assert.equal(pointsFromText('Grade — / 10'), 10);
  assert.equal(pointsFromText('Max Points: 20'), 20);
  assert.equal(pointsFromText('Worth 12.5 points'), 12.5);
  assert.equal(pointsFromText('Due 9/26/2026 at 11:59 pm'), null);
  assert.equal(pointsFromText(''), null);
});

test('in the archive: saved files under the row key, not removed', () => {
  const m = { items: { 'n-1': { files: ['a.pdf'] }, 'n-2': { files: [] }, 'n-3': { files: ['b.pdf'], removed: true } } };
  assert.equal(inArchive(m, 'n-1'), true);
  assert.equal(inArchive(m, 'n-2'), false);
  assert.equal(inArchive(m, 'n-3'), false);
  assert.equal(inArchive(m, 'n-4'), false);
  assert.equal(inArchive(null, 'n-1'), false);
});

test('the folder holding an assignment, and its name from the parent row', () => {
  const tree = {
    root: { a: [], f: ['8'], i: [{ k: 'folder', fid: '8', title: 'Lesson 8' }] },
    8: { a: [{ id: '802' }], f: [], i: [{ k: 'assignment', id: '802', title: 'Lab 8.1' }] },
  };
  assert.equal(folderHolding(tree, '802'), '8');
  assert.equal(folderHolding(tree, '999'), null);
  assert.equal(folderName(tree, '8'), 'Lesson 8');
  assert.equal(folderName(tree, 'root'), 'Materials');
  assert.equal(folderName(tree, 'x'), null);
});
