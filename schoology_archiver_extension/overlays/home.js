// /home and /home/assignments. Two things live here:
//   /home (and its other Course Dashboard / Recent Activity tabs): the To Do
//     sidebar of overlays/todo.js, grouped by class, in place of Schoology's
//     own flat OVERDUE / UPCOMING lists.
//   /home/assignments: a marker at the end of each row of the Upcoming /
//     Recent / Missing list (overlays/marks.js says what it shows). That
//     list's rows carry no link, so their ids come from the JSON the list
//     itself is built from (/v2/events/{upcoming,recent,overdue}), matched by
//     title and course. Read once, and again (at most once a minute) when a
//     row turns up that isn't in it.
// Both read the same events endpoint (overlays/todo.js's fetchEvents, reused
// here rather than fetched twice); only one of the two runs on any one load.
//
// Marks on /home: our sidebar's rows are real elements in our own shadow
// root, so marks.js draws straight into them (todo.js calls marks.scan()
// itself after every render, since marks.js's own MutationObserver watches
// document.body and can't see inside a shadow root). If the sidebar's data
// hasn't loaded yet (or the overlay is off, or the page isn't /home at all),
// marks fall back to Schoology's own visible rows so the marker feature never
// goes dark.

import { homeRowsIn, assignmentCardsIn, EVENT_LISTS } from '../reader/parse/sync.js';
import { startMarks } from './marks.js';
import { start as startTodo, fetchEvents } from './todo.js';

const REREAD_MS = 180_000; // Schoology's own response says `@cache.max_age: 180` for these lists
export { fetchEvents };

export function start({
  doc = document, loc = location, call, getEvents = fetchEvents, todoStore, now,
} = {}) {
  const withList = /^\/home\/assignments\/?$/.test(loc.pathname);
  const events = new Map(); // "title\u0000course" → { schoology_id, section_id, due }
  const key = (title, course) => `${title}\u0000${course}`.toLowerCase();
  let readAt = 0;
  let reading = null;
  let marks = null;
  let todo = null;

  function read() {
    if (reading || Date.now() - readAt < REREAD_MS) return;
    readAt = Date.now();
    reading = (async () => {
      for (const list of EVENT_LISTS) {
        try {
          for (const e of await getEvents(list)) events.set(key(e.title, e.course), e);
        } catch { /* signed out, or the list moved: the To Do column still works */ }
      }
    })().finally(() => { reading = null; marks?.scan(); });
  }

  function cardRows(d) {
    const out = [];
    let unknown = false;
    for (const c of assignmentCardsIn(d)) {
      const e = events.get(key(c.title, c.course));
      if (!e) { unknown = true; continue; }
      out.push({ el: c.el, titleEl: c.titleEl, schoology_id: e.schoology_id, section_id: e.section_id, title: c.title, graded: e.graded, ...(e.due ? { due: e.due } : {}) });
    }
    if (unknown) read();
    return out;
  }

  if (!withList) todo = startTodo({ doc, loc, getEvents, ...(todoStore ? { store: todoStore } : {}), ...(now ? { now } : {}) });

  const rowsIn = (d) => {
    if (withList) return cardRows(d);
    if (todo?.active()) return todo.rowsIn();
    return homeRowsIn(d, { everyRow: true });
  };
  marks = startMarks({ rowsIn, doc, loc, ...(call ? { call } : {}) });
  todo?.setMarks(marks);
  return marks;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
