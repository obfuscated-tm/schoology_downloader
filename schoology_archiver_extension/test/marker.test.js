// node --test test/   (from schoology_archiver_extension/)
//
// overlays/marker.js's pure toggle-label logic. markerFor itself builds real
// DOM nodes (via overlays/ui.js's el(), document.createElement), so it needs
// a browser — covered by opening test/home-page.html or
// test/materials-page.html by hand, not by node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleLabel } from '../overlays/marker.js';

test('toggleLabel: the action a click on the state offers, from the state it leaves', () => {
  assert.equal(toggleLabel('todo', true), 'Mark studied'); // □ Not studied → click studies it
  assert.equal(toggleLabel('todo', false), 'Mark done'); // ○ To do → click marks it done
  assert.equal(toggleLabel('ready', true), 'Mark not studied'); // ■ Studied → click undoes it
  assert.equal(toggleLabel('ready', false), 'Mark not done'); // ● Done, not submitted → click undoes it
});
