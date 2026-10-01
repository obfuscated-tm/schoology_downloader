// Shared by overlays/todo.js (the home page's To Do sidebar, grouped by
// class) and overlays/coursetodo.js (a single course's own To Do panel, in
// place of that course's Upcoming column): the look and pure logic of one
// "To Do" panel of rows — the panel/heading chrome, the row grid (rotated
// type tag, title, due-date sub line with a marker slot), and the annotate
// + sort that turns overdue/upcoming events into due-first-then-soonest
// items. Grouping by class, the Course Dashboard's card order, and the
// "+N more" cap are home.js-only concerns and stay in todo.js.

import { el } from './ui.js';

// ── Pure date helpers ────────────────────────────────────────────────────

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const calendarDays = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86_400_000);

/** "12 d overdue" (days is always ≥ 0; the caller only calls this for overdue items). */
export function formatOverdue(days) {
  return `${Math.max(0, Math.round(days))} d overdue`;
}

function formatTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Tue Sep 29, 8:30 am": always the full specific date and time, no relative
 * words ("Today"/"Tomorrow") and never dropping the time far out — the grid
 * layout gives every row the room for it. "No due date" when there is none;
 * '' only for a due string that fails to parse.
 */
export function formatDue(due, now = new Date()) {
  if (!due) return 'No due date';
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return '';
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${formatTime(d)}`;
}

/**
 * overdue + upcoming events, each tagged `{ overdue, days? }` (days: how many
 * calendar days overdue, for formatOverdue). Order is not meaningful yet —
 * sortDueItems does that. Pure.
 */
export function annotateItems({ overdue = [], upcoming = [], now = new Date() } = {}) {
  const out = [];
  for (const e of overdue) {
    const days = e.due ? calendarDays(now, new Date(e.due)) : 0;
    out.push({ ...e, overdue: true, days });
  }
  for (const e of upcoming) out.push({ ...e, overdue: false });
  return out;
}

/** Overdue first (oldest due first), then upcoming (soonest first). Pure, non-mutating. */
export function sortDueItems(items) {
  return [...items].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.overdue) return (b.days ?? 0) - (a.days ?? 0); // oldest (most days overdue) first
    return new Date(a.due || 0) - new Date(b.due || 0); // soonest first
  });
}

// ── CSS shared by every "To Do" panel ────────────────────────────────────

export const ROW_CSS = `
:host { display: block; }
.panel { background: var(--sunk); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin: 0 0 16px; }
.todo-h { font-size: 15px; font-weight: 600; padding: 0 0 6px; margin: 0 0 10px; border-bottom: 1px solid var(--line); }
.nothing { color: var(--faint); padding: 8px 0 2px; }
.row {
  display: grid; grid-template-columns: 14px 1fr auto; grid-template-rows: auto auto auto;
  align-items: stretch; column-gap: 8px; row-gap: 2px; padding: 6px 0; border-bottom: 1px solid #E9ECF0;
}
.row:last-child { border-bottom: 0; }
.tag {
  grid-row: 1 / span 3; grid-column: 1;
  writing-mode: vertical-rl; transform: rotate(180deg);
  display: flex; align-items: center; justify-content: center;
  width: 14px; font-family: var(--mono); font-size: 9px; font-weight: 600; letter-spacing: .04em;
  border-radius: 3px; white-space: nowrap;
}
.tag-solid { background: var(--ink); color: #fff; }
.tag-outline { border: 1px solid var(--line); color: var(--dim); background: var(--surface); }
.tag-empty { border: 1px dashed var(--line); }
.tag-faint { border: 1px solid var(--line); color: var(--faint); background: var(--surface); }
.title-wrap { grid-column: 2; grid-row: 1; min-width: 0; }
a.title {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  color: var(--ink); text-decoration: none; font-weight: 500;
}
a.title:hover { color: var(--accent); text-decoration: underline; }
a.title.exam { font-weight: 700; }
.sub {
  grid-column: 2; grid-row: 2; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0;
  font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums;
}
.due { white-space: nowrap; }
.due.over { color: var(--bad); }
.status { grid-column: 2; grid-row: 3; min-width: 0; font-size: 12px; }
.status[hidden] { display: none; }
.mark-col { grid-column: 3; grid-row: 1 / span 3; align-self: center; padding-left: 8px; }
.mark-col:empty, .mark-col[hidden] { display: none; }
.more { display: block; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; margin-top: 4px; font-size: 12px; }
.err { color: var(--dim); padding: 8px 0; }
`;

// ── The rotated type tag (column 1) ─────────────────────────────────────────

export const TYPE_LABEL = { exam: 'TEST', assignment: 'HW', classwork: 'CW', task: 'TASK', meeting: 'MEET' };

/**
 * The type tag's text and CSS class, from the Item marks.js knows about (or
 * null: not in neo-plan; or undefined: not known yet). Pure — item.type wins
 * even when marks.js's own rowState() says 'unknown' (a graded row still
 * knows its item, just not its open/done state).
 */
export function tagFor(item) {
  if (item) {
    const text = TYPE_LABEL[item.type] || '';
    if (!text) return { text: '', cls: '' };
    return { text, cls: item.removed ? 'tag-faint' : item.type === 'exam' ? 'tag-solid' : 'tag-outline' };
  }
  if (item === null) return { text: '', cls: 'tag-empty' }; // not in neo-plan: the dashed prompt to add
  return { text: '', cls: '' }; // unknown/still loading: no border
}

/** How far overdue an item can be and still be added to neo-plan by itself. */
export const AUTO_ADD_OVERDUE_DAYS = 14;

/**
 * Whether a To Do item goes into neo-plan without a click when it isn't there
 * yet: anything upcoming, and overdue work from the last two weeks (older
 * overdue work was most likely left out on purpose). A graded item is done
 * with. One already in neo-plan, or removed from it, is never added again
 * (marks.js only auto-adds a row neo-plan doesn't know at all). Pure.
 */
export function autoAddable(item) {
  if (item.graded) return false;
  return !item.overdue || (item.days ?? 0) <= AUTO_ADD_OVERDUE_DAYS;
}

/** A quiz links to /course/{c}/assessments/{id}: neo-plan files it as a test. Pure. */
export function typeFor(item) {
  return /\/assessments?\//.test(String(item.url || '')) ? 'exam' : undefined;
}

/** One item row, as an object marks.js's rowsIn can hand straight to startMarks. */
export function buildRow(item) {
  const rowEl = el('div', 'row');
  const tag = el('div', 'tag');
  const wrap = el('div', 'title-wrap');
  const a = el('a', 'title', item.title);
  a.href = item.url || `/assignment/${item.schoology_id}`;
  a.title = item.title;
  wrap.append(a);
  const sub = el('div', 'sub');
  if (item.overdue) {
    sub.append(el('span', 'due over', formatDue(item.due)), document.createTextNode(` · ${formatOverdue(item.days)}`));
  } else {
    sub.append(el('span', 'due', formatDue(item.due)));
  }
  // The state's words ("○ To do", "● Done, not submitted", "✓ Turned in") on
  // a line under the due date; its buttons (Done, Turn in, Undo) stacked in a
  // column at the row's right (marks.js, marker.js's `actions`).
  const statusSlot = el('div', 'status');
  const markSlot = el('div', 'mark-col');
  rowEl.append(tag, wrap, sub, statusSlot, markSlot);
  const onState = (state, planItem) => {
    const { text, cls } = tagFor(planItem);
    tag.className = `tag ${cls}`.trim();
    tag.textContent = text;
    a.classList.toggle('exam', !!(planItem && planItem.type === 'exam'));
    // 'unknown' (a graded row, or neo-plan hasn't answered yet) draws nothing:
    // no empty column.
    statusSlot.hidden = markSlot.hidden = state.kind === 'unknown';
  };
  return {
    el: rowEl, titleEl: a, markSlot, statusSlot, onState,
    schoology_id: item.schoology_id, title: item.title, section_id: item.section_id || null, graded: item.graded,
    due: item.due || null, type: typeFor(item), autoAdd: autoAddable(item),
    turnIn: true, // the sidebars' rows: icon buttons for done / Turn in / its undo (marks.js)
  };
}
