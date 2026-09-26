// /home: a marker at the end of each upcoming/overdue submission row
// (overlays/marks.js says what it shows).

import { homeRowsIn } from '../reader/parse/sync.js';
import { startMarks } from './marks.js';

export function start({ doc = document, loc = location, call } = {}) {
  return startMarks({ rowsIn: homeRowsIn, doc, loc, ...(call ? { call } : {}) });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
