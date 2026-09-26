// Dates for the Today view, in the zone the server names — never the
// browser's own. Pure (Intl only), so it runs under node for the harness.
// Formats follow neo-plan's src/lib/dates.ts: "Fri 26", "Fri 26 Sep", "15:10".

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// neo-plan's card labels (src/lib/types.ts TYPE_LABEL). A task has none.
export const TYPE_LABEL = { assignment: 'HW', exam: 'TEST', classwork: 'CW', task: '', meeting: 'MEET' };

/**
 * What a cleared item says it is, outside neo-plan: Submitted when Schoology
 * cleared it, Turned in for an assignment, Finished for anything else.
 */
export function clearedWord(it) {
  if (it?.cleared_by === 'schoology') return 'Submitted';
  return it?.type === 'assignment' ? 'Turned in' : 'Finished';
}

const fmts = new Map();
function fmt(zone) {
  if (!fmts.has(zone)) {
    fmts.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }));
  }
  return fmts.get(zone);
}

/** Calendar parts of an instant in a zone. */
export function partsIn(iso, zone) {
  const out = {};
  for (const p of fmt(zone).formatToParts(new Date(iso))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  if (out.hour === 24) out.hour = 0;
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of an instant in a zone. */
export function dayOf(iso, zone) {
  const p = partsIn(iso, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Weekday of a calendar day, zone-free (it already names a day). */
function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Fri 26" for a "YYYY-MM-DD". */
export function shortDay(day) {
  return `${DAY[weekday(day)]} ${Number(day.slice(8, 10))}`;
}

/** "Fri 26 Sep" for a "YYYY-MM-DD". */
export function longDay(day) {
  return `${shortDay(day)} ${MONTH[Number(day.slice(5, 7)) - 1]}`;
}

/** "15:10" for an instant in a zone. */
export function clock(iso, zone) {
  const p = partsIn(iso, zone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The instant an item happens at. An exam or a meeting has a start and never a
 * due (DESIGN.md §9: an exam never has a due_at); everything else has a due.
 */
function instantOf(item) {
  if ((item.type === 'exam' || item.type === 'meeting') && item.starts_at) return item.starts_at;
  return item.due?.at || item.starts_at || null;
}

/** The day an item belongs to, for grouping Upcoming. Null when undated. */
export function itemDay(item, zone) {
  if ((item.type === 'exam' || item.type === 'meeting') && item.starts_at) return dayOf(item.starts_at, zone);
  if (item.due?.on) return item.due.on;
  const at = instantOf(item);
  return at ? dayOf(at, zone) : null;
}

/**
 * The mono half of the meta line: type label, then (only where asked) the
 * day, then the time. Time shows for a specific time, an exam or meeting
 * start, and for class_time (the period label if the server ever sends one,
 * else the resolved clock time). A day-only item ("none") shows no time.
 */
export function metaText(item, zone, { withDay = false } = {}) {
  const parts = [];
  const label = TYPE_LABEL[item.type] ?? '';
  if (label) parts.push(label);
  const day = itemDay(item, zone);
  if (withDay && day) parts.push(shortDay(day));

  let time = '';
  if ((item.type === 'exam' || item.type === 'meeting') && item.starts_at) {
    time = item.period_label || clock(item.starts_at, zone);
  } else if (item.due?.mode === 'specific' && item.due.at) {
    time = clock(item.due.at, zone);
  } else if (item.due?.mode === 'class_time') {
    time = item.period_label || (item.due.at ? clock(item.due.at, zone) : '');
  }
  if (!time) return parts.join(' ');
  // "HW Tue 23 · 15:10" — the · separates the day from the time, as on a card.
  return parts.length && withDay && day ? `${parts.join(' ')} · ${time}` : [...parts, time].join(' ');
}
