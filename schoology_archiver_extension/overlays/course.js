// A course's Materials page (and its folders): a marker after each
// assignment's title, to add it to neo-plan, take it off, or add it back
// (overlays/marks.js says what it shows).

import { materialRowsIn } from '../reader/parse/sync.js';
import { startMarks } from './marks.js';

export function start({ doc = document, loc = location, call } = {}) {
  return startMarks({ rowsIn: (d) => materialRowsIn(d, loc.href), doc, loc, ...(call ? { call } : {}) });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
