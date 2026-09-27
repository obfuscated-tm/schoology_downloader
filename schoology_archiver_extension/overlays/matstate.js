// What the Materials overlay says about a row or a folder (docs/OVERLAY-UI.md
// §2). Pure: no DOM, no chrome.*; `now` is passed in. overlays/materials.js
// draws it.
//
// A row's state, first match wins:
//   graded     the gradebook has a score                 "10 / 10"
//   submitted  neo-plan cleared it                        "Submitted" (or Turned in / Finished)
//   removed    taken off neo-plan                         "Removed · Add back"
//   missing    neo-plan says Missing                      Missing pill + ○
//   ready      done in neo-plan, not submitted            ● "Done, not submitted" (a test: ■ "Studied")
//   todo       in neo-plan, not done                      ○ short due date (a test: □ "Not studied")
//   none       not in neo-plan                            "+ Add to neo-plan"
//   unknown    neo-plan hasn't answered (or can't)        nothing
// Open work is missing, ready and todo.

import { clearedWord } from '../panel/today-format.js';

export const OPEN = new Set(['missing', 'ready', 'todo']);

/**
 * grade: { earned, possible } | undefined (from the gradebook).
 * item: neo-plan's Item, null (not in neo-plan) or undefined (not known).
 */
export function rowState(grade, item) {
  if (grade && grade.earned != null) return { kind: 'graded', earned: grade.earned, possible: grade.possible };
  if (item === undefined) return { kind: 'unknown' };
  if (item === null) return { kind: 'none' };
  if (item.removed) return { kind: 'removed' };
  if (item.cleared) return { kind: 'submitted', word: clearedWord(item) };
  // A test is studied rather than done: neo-plan's work: 'ready' on an exam.
  const exam = item.type === 'exam';
  if (item.missing) return { kind: 'missing', exam };
  if (item.work === 'ready') return { kind: 'ready', exam };
  return { kind: 'todo', exam };
}

/**
 * A folder's totals, its subfolders' included. tree: { [folder id]: { a: [{ id }],
 * f: [folder id] } }; stateOf(id) → rowState(); gradeOf(id) → { earned, possible }.
 * `known` is false while any assignment in it has no answer yet, or a
 * subfolder hasn't been read.
 */
export function folderTotals(tree, folderId, stateOf, gradeOf) {
  const t = { missing: 0, ready: 0, todo: 0, open: 0, finished: 0, assignments: 0, earned: 0, possible: 0, known: true };
  const seen = new Set();
  const walk = (fid) => {
    if (seen.has(fid)) return;
    seen.add(fid);
    const f = tree[fid];
    if (!f) { t.known = false; return; }
    for (const a of f.a) {
      t.assignments++;
      const s = stateOf(a.id);
      if (s.kind === 'unknown') t.known = false;
      if (OPEN.has(s.kind)) { t[s.kind]++; t.open++; }
      if (s.kind === 'graded' || s.kind === 'submitted') t.finished++;
      const g = gradeOf(a.id);
      if (g && g.earned != null && g.possible > 0) { t.earned += g.earned; t.possible += g.possible; }
    }
    for (const sub of f.f) walk(sub);
  };
  walk(folderId);
  t.pct = t.possible > 0 ? (t.earned / t.possible) * 100 : null;
  return t;
}

/**
 * [{ text, bad? }] for a folder's status: "1 missing · 1 to turn in · 1 to do",
 * or "All turned in" when every assignment in it is graded or submitted (one
 * that's neither, and not in neo-plan, leaves the status empty).
 */
export function summaryParts(t) {
  const parts = [];
  if (t.missing) parts.push({ text: `${t.missing} missing`, bad: true });
  if (t.ready) parts.push({ text: `${t.ready} to turn in` });
  if (t.todo) parts.push({ text: `${t.todo} to do` });
  if (!parts.length && t.assignments && t.known && t.finished === t.assignments) parts.push({ text: 'All turned in' });
  return parts;
}

/** "96.7%" (one decimal), or '' when nothing in it is graded. */
export function pctText(pct) {
  return pct == null ? '' : `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
}

/** "10 / 10", with Schoology's own decimals ("19.05 / 20"). */
export function scoreText(earned, possible) {
  return possible == null ? String(earned) : `${earned} / ${possible}`;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The short due date, "Wed, 9/23", in this browser's zone: neo-plan's due
 * (an instant, or a day) first, else the one Schoology's row shows.
 */
export function shortDue(item, rowDue) {
  let d = null;
  if (item?.due?.on && /^\d{4}-\d{2}-\d{2}$/.test(item.due.on)) {
    const [y, m, day] = item.due.on.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    const iso = item?.due?.at || rowDue || null;
    if (iso) d = new Date(iso);
  }
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${DAY[d.getDay()]}, ${d.getMonth() + 1}/${d.getDate()}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then "9/12/2026". */
export function ago(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
