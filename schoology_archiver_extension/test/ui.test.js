// node --test test/   (from schoology_archiver_extension/)
//
// overlays/ui.js's failText: the words a marker or chip shows when neo-plan
// refuses or can't be reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failText } from '../overlays/ui.js';

test('failText: neo-plan\'s own reason when it gives one, else the generic words', () => {
  assert.equal(failText({ ok: false, status: 409, data: { error: 'type', problem: 'Set a date first' } }), 'Set a date first');
  assert.equal(failText({ ok: false, status: 409, data: { error: 'no_column' } }), 'Not saved');
  assert.equal(failText({ ok: false, status: 401, data: { problem: 'x' } }), 'Token needed');
  assert.equal(failText({ ok: false, status: 0, data: {} }), 'Can’t reach neo-plan');
  assert.equal(failText({ ok: false, status: 404, data: null }), 'neo-plan needs an update');
});
