// A course's pages (Materials, Updates, …): on Materials and its folders, the
// strip, folder totals and row markers of overlays/materials.js; on every
// course page, our own To Do panel in place of Schoology's Upcoming column
// (overlays/coursetodo.js), with a marker at the end of each row
// (overlays/marks.js says what it shows) — Schoology's own Upcoming rows when
// our panel hasn't loaded (or the overlay is off), same as home.js's fallback.

import { homeRowsIn } from '../reader/parse/sync.js';
import { startMarks } from './marks.js';
import { start as startMaterials } from './materials.js';
import { start as startCourseTodo } from './coursetodo.js';

export function start({
  doc = document, loc = location, call, getEvents, store, now,
} = {}) {
  const section = (loc.pathname.match(/^\/course\/(\d+)/) || [])[1] || null;
  const withCall = call ? { call } : {};
  const courseTodo = startCourseTodo({
    doc, loc, ...(getEvents ? { getEvents } : {}), ...(store ? { store } : {}), ...(now ? { now } : {}),
  });
  const rowsIn = (d) => (courseTodo.active() ? courseTodo.rowsIn() : homeRowsIn(d, { everyRow: true }).map((r) => ({ ...r, section_id: section })));
  const marks = startMarks({ rowsIn, doc, loc, ...withCall });
  courseTodo.setMarks(marks);
  return {
    upcoming: marks,
    courseTodo,
    materials: startMaterials({ doc, loc, ...withCall }),
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
