// node --test test/   (from schoology_archiver_extension/)
//
// The course To Do panel's pure logic (overlays/coursetodo.js): filtering the
// account-wide overdue/upcoming lists down to one course's section, and
// sorting them the same way overlays/todo.js sorts within a class group
// (overdue oldest-first, then upcoming soonest-first) — but flat, with no
// class grouping and no cap. Rendering and DOM wiring are covered by opening
// test/course-page.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseItems } from '../overlays/coursetodo.js';

const NOW = new Date('2026-09-27T12:00:00');

// The fixture shared with test/todo.test.js and test/home-page.html.
const OVERDUE = [
  { schoology_id: '1', title: 'French Revolution Quick Write', course: 'World History - 1620', section_id: '16', due: '2026-09-15T18:59:00', graded: false, url: '/assignment/1' },
  { schoology_id: '2', title: 'Interro de vocabulaire 1.2', course: 'French 2 - 4120', section_id: '41', due: '2026-09-16T18:59:00', graded: false, url: '/course/41/assessments/2' },
  { schoology_id: '3', title: 'HW #13', course: 'Pre-Calculus H - 2420', section_id: '24', due: '2026-09-21T18:59:00', graded: false, url: '/assignment/3' },
];
const UPCOMING = [
  { schoology_id: '10', title: 'Lab 9.1 Fibonacci', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-27T23:59:00', graded: false, url: '/assignment/10' },
  { schoology_id: '11', title: 'Read Lesson 9', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-27T23:59:00', graded: false, url: '/assignment/11' },
  { schoology_id: '14', title: 'Mini Quiz 1', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-29T10:05:00', graded: false, url: '/assignment/14' },
  { schoology_id: '16', title: 'Chapter 10 Exam', course: 'Pre-Calculus H - 2420', section_id: '24', due: '2026-09-29T23:59:00', graded: false, url: '/assignment/16' },
];

test('courseItems: only this section\'s events, none of the others', () => {
  const items = courseItems({ overdue: OVERDUE, upcoming: UPCOMING, sectionId: '23', now: NOW });
  assert.deepEqual(items.map((i) => i.schoology_id), ['10', '11', '14']);
});

test('courseItems: overdue first (oldest overdue first), then upcoming (soonest first)', () => {
  const items = courseItems({ overdue: OVERDUE, upcoming: UPCOMING, sectionId: '24', now: NOW });
  assert.deepEqual(items.map((i) => i.schoology_id), ['3', '16']);
  assert.equal(items[0].overdue, true);
  assert.equal(items[0].days, 6);
  assert.equal(items[1].overdue, false);
});

test('courseItems: a section with nothing due is an empty list, not an error', () => {
  assert.deepEqual(courseItems({ overdue: OVERDUE, upcoming: UPCOMING, sectionId: '9999', now: NOW }), []);
});

test('courseItems: matches by section id as a string or a number', () => {
  const items = courseItems({ overdue: [], upcoming: UPCOMING, sectionId: 23, now: NOW });
  assert.deepEqual(items.map((i) => i.schoology_id), ['10', '11', '14']);
});

test('courseItems: no section id (not on a course page) is always empty', () => {
  assert.deepEqual(courseItems({ overdue: OVERDUE, upcoming: UPCOMING, sectionId: null, now: NOW }), []);
  assert.deepEqual(courseItems({ overdue: OVERDUE, upcoming: UPCOMING, now: NOW }), []);
});
