// What the assignment page's overlay says (docs/OVERLAY-UI.md §3). Pure: no
// DOM, no chrome.*; `now` is passed in. overlays/assignment.js draws it.
//
// The chip's state, first match wins:
//   graded     the gradebook has a score     Graded · Moved your course grade ±N.NN · Nth lowest of M in <category>
//   removed    taken off neo-plan            Removed · Add back
//   submitted  the page shows a submission,  Submitted · Cleared in neo-plan · Late by N days
//              or neo-plan cleared it
//   none       not in neo-plan               Add to neo-plan
//   open       in neo-plan, not submitted    class · Missing · A zero costs −N.NN · Remove from neo-plan
//   unknown    neo-plan hasn't answered      (nothing yet)

import { impact, grade } from './grademath.js';

/** grade: { earned } | undefined. item: Item, null or undefined. pageSubmitted: the page shows a submission. */
export function chipState(grade, item, pageSubmitted) {
  if (grade && grade.earned != null) return 'graded';
  if (item?.removed) return 'removed';
  if (pageSubmitted || item?.cleared) return 'submitted';
  if (item === null) return 'none';
  if (item === undefined) return 'unknown';
  return 'open';
}

/** The period (grademath's course shape) and category holding item `id`, or null. */
export function findItem(periods, id) {
  for (const p of periods) {
    for (const c of p.categories) {
      const item = c.items.find((it) => it.id === id);
      if (item) return { course: p, category: c, item };
    }
  }
  return null;
}

/** "−1.26" / "+0.40": the signed two-decimal delta the overlay uses everywhere. */
export const signed = (d) => (d < 0 ? '−' : '+') + Math.abs(d).toFixed(2);

/** Course % if this item scored 0 − course % now (ungraded items only). null when it can't be said. */
export function zeroCost(course, id, possible, weights) {
  if (!possible) return null;
  return impact(course, id, { weights, whatIf: { [id]: { earned: 0, possible } } });
}

/** → { pct, delta } for a what-if score on an ungraded item, or null. */
export function whatIfGrade(course, id, earned, possible, weights) {
  if (earned == null || !possible) return null;
  const now = grade(course, { weights }).pct;
  const pct = grade(course, { weights, whatIf: { [id]: { earned, possible } } }).pct;
  if (pct == null) return null;
  return { pct, delta: now == null ? null : pct - now };
}

/**
 * Where a graded item sits among the graded items of its category, by
 * percent, lowest first: { rank, of }. Ties share the better rank. null when
 * it's the only one graded.
 */
export function rankIn(category, id) {
  const pct = (it) => (it.possible > 0 ? it.earned / it.possible : null);
  const graded = category.items.filter((it) => it.earned != null && pct(it) != null);
  const me = graded.find((it) => it.id === id);
  if (!me || graded.length < 2) return null;
  return { rank: 1 + graded.filter((it) => pct(it) < pct(me)).length, of: graded.length };
}

function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/** "Lowest of 5 in Tests & Quizzes", "2nd lowest of 5 in …". */
export function rankText({ rank, of }, category) {
  return `${rank === 1 ? 'Lowest' : `${ordinal(rank)} lowest`} of ${of} in ${category}`;
}

/** Whole days past due (rounded up), or 0. */
export function lateDays(dueIso, atMs) {
  const due = Date.parse(dueIso || '');
  if (Number.isNaN(due) || atMs == null || atMs <= due) return 0;
  return Math.ceil((atMs - due) / 86_400_000);
}

/** "Late by 3 days" / "Late by 1 day" / "Late" (late, but by how much isn't known). */
export function lateText(days) {
  if (!days) return 'Late';
  return `Late by ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The points an assignment is out of, from text on its page: "— / 10",
 * "10 points", "Max Points: 10". null when none of those is there.
 */
export function pointsFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  // Not "9 / 10": a bare "a / b" can be a date (9/26).
  const m = t.match(/(?:—|–|-)\s*\/\s*(\d+(?:\.\d+)?)\b/)
    || t.match(/\bmax(?:imum)?\s+points?\s*:?\s*(\d+(?:\.\d+)?)/i)
    || t.match(/\b(\d+(?:\.\d+)?)\s*(?:points?|pts)\b/i);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 ? n : null;
}

/** The archive has something saved for this Materials row (its key is the row's id). */
export function inArchive(manifest, key) {
  const it = key && manifest?.items?.[key];
  return !!(it && !it.removed && it.files?.length);
}
