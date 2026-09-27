// /home and /home/assignments: a marker at the end of each upcoming/overdue
// row of the To Do column, the "N more overdue" popup's included, and on
// /home/assignments each row of the Upcoming / Recent / Missing list
// (overlays/marks.js says what it shows).
//
// That list's rows carry no link, so their ids come from the JSON the list
// itself is built from (/v2/events/{upcoming,recent,overdue}, GET, same
// origin), matched by title and course. Read once, and again (at most once a
// minute) when a row turns up that isn't in it.

import { homeRowsIn, assignmentCardsIn, parseEventsJson, EVENT_LISTS } from '../reader/parse/sync.js';
import { startMarks } from './marks.js';

const REREAD_MS = 60_000;

async function fetchEvents(list) {
  const r = await fetch(`/v2/events/${list}`, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseEventsJson(await r.text());
}

export function start({ doc = document, loc = location, call, getEvents = fetchEvents } = {}) {
  const withList = /^\/home\/assignments\/?$/.test(loc.pathname);
  const events = new Map(); // "title\u0000course" → { schoology_id, section_id, due }
  const key = (title, course) => `${title}\u0000${course}`.toLowerCase();
  let readAt = 0;
  let reading = null;
  let marks = null;

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

  const rowsIn = (d) => homeRowsIn(d, { everyRow: true }).concat(withList ? cardRows(d) : []);
  marks = startMarks({ rowsIn, doc, loc, ...(call ? { call } : {}) });
  return marks;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
