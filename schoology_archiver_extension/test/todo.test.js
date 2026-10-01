// node --test test/   (from schoology_archiver_extension/)
//
// The To Do sidebar's pure logic (overlays/todo.js): matching a Course
// Dashboard card to an event's `course`, class vs. non-class cards, grouping
// and sorting, the "Other" bucket, due-date formatting, and the cap/+N more
// split. Rendering and DOM wiring are covered by opening test/home-page.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isClassCard, shortName, cardKey, groupEvents, formatDue, formatOverdue, visibleItems, fetchEvents,
  cacheIsFresh, cacheSkipsFetch, tagFor,
} from '../overlays/todo.js';

const NOW = new Date('2026-09-27T12:00:00');

const CARDS = [
  { name: 'Pre-Calculus H - 2420: JaehnigS p1 T1' },
  { name: 'AP Comp Sci A - 2350: McLeodT p2 T1' },
  { name: 'World Lit/Writ - 1020: Phelps McQuaideA p3 T1' },
  { name: 'French 2 - 4120: AggounI p4 T1' },
  { name: 'AP Physics 1 - 3750: AgarwalA p5 T1' },
  { name: 'World History - 1620: Santa Cruz RayM p7 T1' },
  { name: 'Closed Tutorial - 9100: McLeodT pCTut' },
  { name: 'CHS Hub: Gr10' },
];

test('isClassCard: a course code before a colon says class; a hub or advisory does not', () => {
  assert.equal(isClassCard('Pre-Calculus H - 2420: JaehnigS p1 T1'), true);
  assert.equal(isClassCard('Closed Tutorial - 9100: McLeodT pCTut'), true); // matches the code pattern, even though it isn't graded work
  assert.equal(isClassCard('CHS Hub: Gr10'), false);
  assert.equal(isClassCard('CHS_Counseling: Class of 2029'), false);
  assert.equal(isClassCard('Jackson,A Advisees: Class of 2029'), false);
});

test('shortName: strips the course code and everything after the colon', () => {
  assert.equal(shortName('Pre-Calculus H - 2420: JaehnigS p1 T1'), 'Pre-Calculus H');
  assert.equal(shortName('Closed Tutorial - 9100: McLeodT pCTut'), 'Closed Tutorial');
  assert.equal(shortName('CHS Hub: Gr10'), 'CHS Hub');
  assert.equal(shortName('Jackson,A Advisees: Class of 2029'), 'Jackson,A Advisees');
});

test('cardKey: matches a card to an event whose course has no section suffix', () => {
  assert.equal(cardKey('Pre-Calculus H - 2420: JaehnigS p1 T1'), cardKey('Pre-Calculus H - 2420'));
  assert.notEqual(cardKey('Pre-Calculus H - 2420: JaehnigS p1 T1'), cardKey('AP Comp Sci A - 2350'));
});

// The fixture from the task: today is Sun Sep 27 2026.
const OVERDUE = [
  { schoology_id: '1', title: 'French Revolution Quick Write', course: 'World History - 1620', section_id: '16', due: '2026-09-15T18:59:00', graded: false, url: '/assignment/1' },
  { schoology_id: '2', title: 'Interro de vocabulaire 1.2', course: 'French 2 - 4120', section_id: '41', due: '2026-09-16T18:59:00', graded: false, url: '/course/41/assessments/2' },
  { schoology_id: '3', title: 'HW #13: Pg. 648 # 29-37(odd), Pg. 655 # 15, 21, 33, 43, 56, 69, 73, Pg. 663 # 9, 11, 17, 42, 51, 103, 107', course: 'Pre-Calculus H - 2420', section_id: '24', due: '2026-09-21T18:59:00', graded: false, url: '/assignment/3' },
];
const UPCOMING = [
  { schoology_id: '10', title: 'Lab 9.1 Fibonacci', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-27T23:59:00', graded: false, url: '/assignment/10' },
  { schoology_id: '11', title: 'Read Lesson 9', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-27T23:59:00', graded: false, url: '/assignment/11' },
  { schoology_id: '12', title: 'HW 9/25 FBDs', course: 'AP Physics 1 - 3750', section_id: '37', due: '2026-09-28T08:30:00', graded: false, url: '/assignment/12' },
  { schoology_id: '13', title: 'Reminder: Quiz 2- NEED LOCKDOWN BROWSER', course: 'AP Physics 1 - 3750', section_id: '37', due: '2026-09-28T08:30:00', graded: false, url: '/assignment/13' },
  { schoology_id: '14', title: 'Mini Quiz 1 - Ternary Operator and If-Else logic', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-29T10:05:00', graded: false, url: '/assignment/14' },
  { schoology_id: '15', title: 'In-class Lab 6.2 - Static Review', course: 'AP Comp Sci A - 2350', section_id: '23', due: '2026-09-29T16:00:00', graded: false, url: '/assignment/15' },
  { schoology_id: '16', title: 'Chapter 10 Exam (points to be determined)', course: 'Pre-Calculus H - 2420', section_id: '24', due: '2026-09-29T23:59:00', graded: false, url: '/assignment/16' },
];

test('groupEvents: class order follows the dashboard cards; classes with nothing due still show', () => {
  const groups = groupEvents({ overdue: OVERDUE, upcoming: UPCOMING, cards: CARDS, now: NOW });
  assert.deepEqual(groups.map((g) => g.name), [
    'Pre-Calculus H', 'AP Comp Sci A', 'World Lit/Writ', 'French 2', 'AP Physics 1', 'World History', 'Closed Tutorial',
  ]);
});

test('groupEvents: every class card shows, even with nothing due; a non-class card only with items', () => {
  const groups = groupEvents({ overdue: OVERDUE, upcoming: UPCOMING, cards: CARDS, now: NOW });
  const worldLit = groups.find((g) => g.name === 'World Lit/Writ');
  assert.ok(worldLit, 'a class with nothing due still gets a group');
  assert.equal(worldLit.items.length, 0);
  const closedTutorial = groups.find((g) => g.name === 'Closed Tutorial');
  assert.ok(closedTutorial, 'Closed Tutorial matches the class heuristic (a code before the colon)');
  assert.equal(closedTutorial.items.length, 0);
  assert.equal(groups.some((g) => g.name === 'CHS Hub'), false, 'a non-class card with nothing due is left out entirely');
});

test('groupEvents: an item whose course matches no card goes to Other, at the bottom', () => {
  const stray = { schoology_id: '99', title: 'Mystery worksheet', course: 'Some Other Class - 9999', section_id: '99', due: '2026-09-30T23:59:00', graded: false, url: '/assignment/99' };
  const groups = groupEvents({ overdue: [], upcoming: [...UPCOMING, stray], cards: CARDS, now: NOW });
  assert.equal(groups[groups.length - 1].name, 'Other');
  assert.deepEqual(groups[groups.length - 1].items.map((i) => i.schoology_id), ['99']);
});

test('groupEvents: within a class, overdue first (oldest overdue first), then upcoming soonest first', () => {
  const groups = groupEvents({ overdue: OVERDUE, upcoming: UPCOMING, cards: CARDS, now: NOW });
  const precalc = groups.find((g) => g.name === 'Pre-Calculus H');
  assert.deepEqual(precalc.items.map((i) => i.schoology_id), ['3', '16']); // the 6-day-overdue HW, then Tuesday's exam
  assert.equal(precalc.items[0].overdue, true);
  assert.equal(precalc.items[0].days, 6);
  const apcs = groups.find((g) => g.name === 'AP Comp Sci A');
  assert.deepEqual(apcs.items.map((i) => i.schoology_id), ['10', '11', '14', '15']); // both Sunday items, then Tue 10:05, then Tue 4pm
});

test('groupEvents: "Due today" shows on a group with anything due today', () => {
  const groups = groupEvents({ overdue: OVERDUE, upcoming: UPCOMING, cards: CARDS, now: NOW });
  assert.equal(groups.find((g) => g.name === 'AP Comp Sci A').dueToday, true);
  assert.equal(groups.find((g) => g.name === 'AP Physics 1').dueToday, false);
});

test('formatOverdue and formatDue: always the full specific date, no relative words', () => {
  assert.equal(formatOverdue(12), '12 d overdue');
  assert.equal(formatOverdue(11), '11 d overdue');
  assert.equal(formatOverdue(6), '6 d overdue');
  assert.equal(formatDue('2026-09-27T23:59:00', NOW), 'Sun Sep 27, 11:59 pm'); // today, but still specific
  assert.equal(formatDue('2026-09-28T08:30:00', NOW), 'Mon Sep 28, 8:30 am'); // tomorrow, but still specific
  assert.equal(formatDue('2026-09-29T10:05:00', NOW), 'Tue Sep 29, 10:05 am');
  assert.equal(formatDue('2026-09-29T16:00:00', NOW), 'Tue Sep 29, 4:00 pm');
  assert.equal(formatDue('2026-10-05T23:59:00', NOW), 'Mon Oct 5, 11:59 pm'); // further out: the time never drops
  assert.equal(formatDue('2026-09-16T18:59:00', NOW), 'Wed Sep 16, 6:59 pm'); // an overdue item's own due date, red in the row
});

test('formatDue: no due date at all, and an unparseable one', () => {
  assert.equal(formatDue(null), 'No due date');
  assert.equal(formatDue(undefined), 'No due date');
  assert.equal(formatDue(''), 'No due date');
  assert.equal(formatDue('not a date'), '');
});

test('tagFor: the rotated type tag by neo-plan item, from marks.js\'s onState(state, item)', () => {
  assert.deepEqual(tagFor({ type: 'exam' }), { text: 'TEST', cls: 'tag-solid' });
  assert.deepEqual(tagFor({ type: 'assignment' }), { text: 'HW', cls: 'tag-outline' });
  assert.deepEqual(tagFor({ type: 'classwork' }), { text: 'CW', cls: 'tag-outline' });
  assert.deepEqual(tagFor({ type: 'task' }), { text: 'TASK', cls: 'tag-outline' });
  assert.deepEqual(tagFor({ type: 'meeting' }), { text: 'MEET', cls: 'tag-outline' });
  assert.deepEqual(tagFor({ type: 'assignment', removed: true }), { text: 'HW', cls: 'tag-faint' }); // removed: its type, but faint
  assert.deepEqual(tagFor(null), { text: '', cls: 'tag-empty' }); // not in neo-plan: dashed, the "+ Add" prompt
  assert.deepEqual(tagFor(undefined), { text: '', cls: '' }); // unknown/still loading: empty, no border
});

test('visibleItems: caps at 5, else everything once expanded', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ schoology_id: String(i) }));
  const capped = visibleItems(items);
  assert.equal(capped.shown.length, 5);
  assert.equal(capped.more, 3);
  const open = visibleItems(items, { expanded: true });
  assert.equal(open.shown.length, 8);
  assert.equal(open.more, 0);
  const short = visibleItems(items.slice(0, 3));
  assert.equal(short.shown.length, 3);
  assert.equal(short.more, 0);
});

test('fetchEvents: follows @links.next until the last page', async () => {
  const pages = {
    '/v2/events/overdue': { '@extra': [], '@links': { next: '/v2/events/overdue?start=25' } },
    '/v2/events/overdue?start=25': { '@extra': [], '@links': {} },
  };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, text: async () => JSON.stringify(pages[url]) };
  };
  await fetchEvents('overdue', { fetchImpl });
  assert.deepEqual(seen, ['/v2/events/overdue', '/v2/events/overdue?start=25']);
});

test('fetchEvents: a failed request throws (the caller falls back to Schoology\'s own block)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => fetchEvents('overdue', { fetchImpl }));
});

test('cacheIsFresh: same host and under 24h old', () => {
  const now = 1_000_000_000;
  const cache = { at: now - 1000, overdue: [], upcoming: [], host: 'x.schoology.com' };
  assert.equal(cacheIsFresh(cache, 'x.schoology.com', now), true);
});

test('cacheIsFresh: rejects a cache from another host (another school, or another tab)', () => {
  const now = 1_000_000_000;
  const cache = { at: now - 1000, overdue: [], upcoming: [], host: 'y.schoology.com' };
  assert.equal(cacheIsFresh(cache, 'x.schoology.com', now), false);
});

test('cacheIsFresh: rejects a cache 24h old or older', () => {
  const now = 1_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  assert.equal(cacheIsFresh({ at: now - day + 1, host: 'x' }, 'x', now), true);
  assert.equal(cacheIsFresh({ at: now - day, host: 'x' }, 'x', now), false);
});

test('cacheIsFresh: no cache, or a malformed one, is never fresh', () => {
  assert.equal(cacheIsFresh(null, 'x', 1000), false);
  assert.equal(cacheIsFresh({ host: 'x' }, 'x', 1000), false); // no `at`
});

test('cacheSkipsFetch: only when fresh AND younger than REREAD_MS', () => {
  const now = 1_000_000_000;
  const rereadMs = 180_000;
  assert.equal(cacheSkipsFetch({ at: now - 1000, host: 'x' }, 'x', now, rereadMs), true);
  assert.equal(cacheSkipsFetch({ at: now - rereadMs - 1, host: 'x' }, 'x', now, rereadMs), false); // fresh, but old enough to refetch
  assert.equal(cacheSkipsFetch({ at: now - 1000, host: 'y' }, 'x', now, rereadMs), false); // wrong host
});

test('groupEvents: a card\'s section id wins over its name (renamed or duplicate course titles)', () => {
  const cards = [{ name: 'Pre-Calculus H - 2420: JaehnigS p1 T1', section_id: '100' }, { name: 'Pre-Calculus H - 2420: OtherT p3 T1', section_id: '200' }];
  const groups = groupEvents({ upcoming: [{ schoology_id: '1', title: 'x', course: 'Pre-Calculus H - 2420', section_id: '200', due: '2026-09-28T10:00:00' }], cards, now: new Date('2026-09-27T12:00:00') });
  assert.deepEqual(groups.map((g) => g.items.length), [0, 1]);
});

test('autoAddable / typeFor: what the To Do rows add by themselves, and as what', async () => {
  const { autoAddable, typeFor, AUTO_ADD_OVERDUE_DAYS } = await import('../overlays/todorows.js');
  assert.equal(autoAddable({ overdue: false }), true);
  assert.equal(autoAddable({ overdue: true, days: AUTO_ADD_OVERDUE_DAYS }), true);
  assert.equal(autoAddable({ overdue: true, days: AUTO_ADD_OVERDUE_DAYS + 1 }), false);
  assert.equal(autoAddable({ overdue: false, graded: true }), false);
  assert.equal(typeFor({ url: '/course/44/assessments/700' }), 'exam');
  assert.equal(typeFor({ url: '/assignment/700' }), undefined);
  assert.equal(typeFor({}), undefined);
});
