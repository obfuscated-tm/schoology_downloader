// A course's pages (Materials, Updates, …): on Materials and its folders, the
// strip, folder totals and row markers of overlays/materials.js; on every
// course page, a marker at the end of each row of the Upcoming column
// (overlays/marks.js says what it shows).

import { homeRowsIn } from '../reader/parse/sync.js';
import { startMarks } from './marks.js';
import { start as startMaterials } from './materials.js';

export function start({ doc = document, loc = location, call } = {}) {
  const section = (loc.pathname.match(/^\/course\/(\d+)/) || [])[1] || null;
  const rowsIn = (d) => homeRowsIn(d, { everyRow: true }).map((r) => ({ ...r, section_id: section }));
  const withCall = call ? { call } : {};
  return {
    upcoming: startMarks({ rowsIn, doc, loc, ...withCall }),
    materials: startMaterials({ doc, loc, ...withCall }),
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
