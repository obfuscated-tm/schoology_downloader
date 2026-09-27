// node --test test/   (from schoology_archiver_extension/)
//
// The numbers are AP Comp Sci A's gradebook as the archive saved it on
// 9/24/2026 (fixtures/apcs-grades.md). Schoology showed: Labs & Homework
// 100%, Tests & Quizzes 95.9%, course 97%. The weights (25 / 75) are the
// category rows' .percentage-contrib, read in DevTools on 2026-09-26;
// grades.md doesn't carry them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseScore, parseDue, weightFromText, periodsFromRows, currentPeriod,
  grade, impact, history, categoryFloor, needFor, letter,
} from '../overlays/grademath.js';

const L = 'Labs & Homework', T = 'Tests & Quizzes';
const WEIGHTS = { [L]: 25, [T]: 75 };

/** grades.md's table → parseGrades()-shaped rows. */
function rowsFromMd(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$/);
    if (!m || m[1] === 'Item' || m[1].startsWith('---')) continue;
    const cell = m[1];
    const bare = cell.replace(/^↳ /, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
    const level = cell.startsWith('↳') ? 'category' : !cell.startsWith('**') ? 'item' : rows.length === 0 ? 'course' : 'period';
    rows.push({ level, title: bare, due: m[2].trim(), grade: m[3].trim(), comment: m[4].trim() });
  }
  return rows;
}

const ROWS = rowsFromMd(readFileSync(new URL('./fixtures/apcs-grades.md', import.meta.url), 'utf8'));
const PERIODS = periodsFromRows(ROWS);
const COURSE = currentPeriod(PERIODS);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const id = (title) => COURSE.categories.flatMap((c) => c.items).find((it) => it.title === title).id;

test('reading Schoology text', () => {
  assert.deepEqual(parseScore('19.05 / 20'), { earned: 19.05, possible: 20 });
  assert.deepEqual(parseScore('—'), { earned: null, possible: null });
  assert.equal(parseDue('8/17/26 11:59pm'), '2026-08-17T23:59');
  assert.equal(parseDue('9/01/26 10:05am'), '2026-09-01T10:05');
  assert.equal(parseDue('9/29/26 12:30am'), '2026-09-29T00:30');
  assert.equal(parseDue('9/29/26 12:30pm'), '2026-09-29T12:30');
  assert.equal(parseDue(''), null);
  assert.equal(weightFromText('Labs & Homework — Category (25%)'), 25);
  assert.equal(weightFromText('Tests (Unit 1) — Category (72.5 %)'), 72.5);
  assert.equal(weightFromText('Labs & Homework'), null);
});

test('rows → periods: T1 is current, the empty period is skipped', () => {
  assert.deepEqual(PERIODS.map((p) => p.title), ['26-27 T1', '(no grading period)']);
  assert.equal(COURSE.title, '26-27 T1');
  assert.deepEqual(COURSE.categories.map((c) => [c.title, c.items.length]), [[L, 31], [T, 7]]);
});

test('category % matches Schoology: 100% and 95.9%, "—" left out', () => {
  const g = grade(COURSE, { weights: WEIGHTS });
  const [labs, tests] = g.categories;
  assert.deepEqual([labs.earned, labs.possible], [220, 220]);
  close(labs.pct, 100);
  close(tests.earned, 105.49);
  assert.equal(tests.possible, 110);
  assert.equal(tests.pct.toFixed(1), '95.9');
});

test('course % with the 25/75 weights rounds to Schoology\'s 97%', () => {
  const g = grade(COURSE, { weights: WEIGHTS });
  assert.equal(g.mode, 'weighted');
  close(g.pct, 96.925);
  assert.equal(Math.round(g.pct), 97);
  assert.equal(letter(g.pct), 'A');
});

test('weights on the category rows work the same as typed ones', () => {
  const withRowWeights = { ...COURSE, categories: COURSE.categories.map((c) => ({ ...c, weight: WEIGHTS[c.title] })) };
  close(grade(withRowWeights).pct, 96.925);
});

test('no weights → total points, which is not what Schoology shows', () => {
  const g = grade(COURSE);
  assert.equal(g.mode, 'points');
  close(g.pct, (325.49 / 330) * 100);
  assert.notEqual(Math.round(g.pct), 97);
});

test('weights are renormalized over categories that have grades', () => {
  const labsOnly = { categories: COURSE.categories.map((c) => (c.title === T ? { ...c, items: [] } : c)) };
  close(grade(labsOnly, { weights: WEIGHTS }).pct, 100);
  assert.equal(grade({ categories: [] }).pct, null);
});

test('impact = with − without', () => {
  close(impact(COURSE, id('Lesson 0-4 Test'), { weights: WEIGHTS }), 96.925 - (25 + 0.75 * (58.05 / 60) * 100));
  close(impact(COURSE, id('Lesson 0-4 Test'), { weights: WEIGHTS }), -0.6375);
  close(impact(COURSE, id('Lesson 0 Quiz'), { weights: WEIGHTS }), 96.925 - (25 + 0.75 * (86.44 / 90) * 100));
  close(impact(COURSE, id('Lab 5.2 Illusions'), { weights: WEIGHTS }), 0);
  assert.equal(impact(COURSE, id('Lab 6.1 Taxes'), { weights: WEIGHTS }), null); // ungraded
});

test('what-if: a zero on HW Quiz 7-8 costs −5.99', () => {
  const opts = { weights: WEIGHTS, whatIf: { [id('HW Quiz 7-8')]: { earned: 0, possible: 10 } } };
  close(grade(COURSE, opts).pct, 25 + 0.75 * (105.49 / 120) * 100);
  close(impact(COURSE, id('HW Quiz 7-8'), opts), -5.99375);
  // "—" rows don't say their points, so a bare score without possible is ignored.
  close(grade(COURSE, { weights: WEIGHTS, whatIf: { [id('HW Quiz 7-8')]: 0 } }).pct, 96.925);
});

test('what-if overrides a graded item too: earned, and possible if given', () => {
  const tId = id('Lesson 0-4 Test'); // real: 47.44 / 50
  // A bare number overrides earned only; possible (and every other item) stands.
  close(grade(COURSE, { weights: WEIGHTS, whatIf: { [tId]: 0 } }).pct, 25 + 0.75 * (58.05 / 110) * 100);
  // { earned, possible } overrides both.
  close(grade(COURSE, { weights: WEIGHTS, whatIf: { [tId]: { earned: 50, possible: 55 } } }).pct,
    25 + 0.75 * ((105.49 - 47.44 + 50) / (110 - 50 + 55)) * 100);
  // impact() sees the overridden score too.
  const opts = { weights: WEIGHTS, whatIf: { [tId]: 0 } };
  close(impact(COURSE, tId, opts), grade(COURSE, opts).pct - (25 + 0.75 * (58.05 / 60) * 100));
});

test('history replays graded items by due date, one point per day', () => {
  const h = history(COURSE, { weights: WEIGHTS });
  assert.deepEqual(h[0], { day: '2026-08-17', pct: 100, items: ['Academic Integrity Policy', 'Course Information Agreement', 'Sign Up For College Board Class P2'] });
  const aug27 = h.find((p) => p.day === '2026-08-27');
  assert.deepEqual(aug27.items, ['Lesson 0 Quiz']);
  close(aug27.pct, 25 + 0.75 * (29.05 / 30) * 100);
  const last = h[h.length - 1];
  assert.equal(last.day, '2026-09-23');
  close(last.pct, 96.925);
  const days = h.map((p) => p.day);
  assert.deepEqual(days, [...days].sort());
  assert.equal(new Set(days).size, days.length);
  assert.equal(h.flatMap((p) => p.items).length, 25 + 6); // 31 labs and 7 tests, minus seven "—"
});

test('"A holds down to": the lowest a category can go and keep 93', () => {
  close(categoryFloor(COURSE, T, 93, { weights: WEIGHTS }), (9300 - 2500) / 75); // 90.67
  close(categoryFloor(COURSE, L, 93, { weights: WEIGHTS }), (9300 - 75 * (105.49 / 110) * 100) / 25); // 84.3
  assert.ok(categoryFloor(COURSE, L, 70, { weights: WEIGHTS }) <= 0); // any Labs score keeps a C-
  assert.equal(categoryFloor(COURSE, 'Nope', 93, { weights: WEIGHTS }), null);
});

test('"need X for an A" on a planned item', () => {
  const r = needFor(COURSE, { category: T, possible: 50, target: 93 }, { weights: WEIGHTS });
  assert.equal(r.status, 'need');
  close(r.need, 160 * (68 / 75) - 105.49); // 39.58 / 50
  close(grade(COURSE, { weights: WEIGHTS, extra: [{ category: T, earned: r.need, possible: 50 }] }).pct, 93);
  assert.deepEqual(needFor(COURSE, { category: L, possible: 10, target: 93 }, { weights: WEIGHTS }), { status: 'any' });
  assert.deepEqual(needFor(COURSE, { category: T, possible: 10, target: 99 }, { weights: WEIGHTS }), { status: 'out' });
});

test('drop excludes an item from grade/impact/categoryFloor/needFor, like removing it from the course', () => {
  const tId = id('Lesson 0-4 Test'); // in Tests & Quizzes
  const without = { ...COURSE, categories: COURSE.categories.map((c) => ({ ...c, items: c.items.filter((it) => it.id !== tId) })) };
  const dropOpts = { weights: WEIGHTS, drop: [tId] };
  const wOpts = { weights: WEIGHTS };
  close(grade(COURSE, dropOpts).pct, grade(without, wOpts).pct);
  assert.equal(impact(COURSE, tId, dropOpts), null); // dropped: doesn't count, so no impact
  // categoryFloor(L) and needFor(L) depend on the other category's (T's) pct,
  // which the drop changes — same as computing them on the item-less course.
  close(categoryFloor(COURSE, L, 93, dropOpts), categoryFloor(without, L, 93, wOpts));
  assert.deepEqual(needFor(COURSE, { category: L, possible: 10, target: 93 }, dropOpts),
    needFor(without, { category: L, possible: 10, target: 93 }, wOpts));
  // a Set works the same as an array
  close(grade(COURSE, { weights: WEIGHTS, drop: new Set([tId]) }).pct, grade(without, wOpts).pct);
});

test('history ignores both what-ifs and drops: it is the real term', () => {
  const tId = id('Lesson 0-4 Test');
  const h1 = history(COURSE, { weights: WEIGHTS });
  const h2 = history(COURSE, { weights: WEIGHTS, whatIf: { [tId]: 0 }, drop: [tId] });
  assert.deepEqual(h1, h2);
});

test('points mode: floor and need still solve', () => {
  const r = needFor(COURSE, { category: T, possible: 50, target: 98 });
  assert.equal(r.status, 'need');
  close(grade(COURSE, { extra: [{ category: T, earned: r.need, possible: 50 }] }).pct, 98);
  const f = categoryFloor(COURSE, T, 93);
  close(((220 + (f / 100) * 110) / 330) * 100, 93);
});
