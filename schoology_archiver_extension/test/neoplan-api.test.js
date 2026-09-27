// node --test test/   (from schoology_archiver_extension/)
//
// outputs/neoplan/api.js's pure request building: in particular isWorkValue,
// the validator background.js's content-script gate (CONTENT_OPS) uses to
// keep a content script from sending anything but 'todo'/'ready' through the
// 'work' op — background.js itself talks to chrome.* at import time, so it
// isn't importable here (no test imports it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkValue, buildRequest } from '../outputs/neoplan/api.js';

test('isWorkValue: only the two states the marker toggles between', () => {
  assert.equal(isWorkValue('todo'), true);
  assert.equal(isWorkValue('ready'), true);
  assert.equal(isWorkValue('done'), false);
  assert.equal(isWorkValue(''), false);
  assert.equal(isWorkValue(undefined), false);
  assert.equal(isWorkValue(null), false);
});

test('buildRequest: the work op posts { work } to the item, and refuses any other value', () => {
  const req = buildRequest('https://neo-plan.vercel.app', 'np_tok', { op: 'work', id: '9', work: 'ready' });
  assert.equal(req.url, 'https://neo-plan.vercel.app/api/extension/items/9/work');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.body, JSON.stringify({ work: 'ready' }));
  assert.throws(() => buildRequest('https://neo-plan.vercel.app', 'np_tok', { op: 'work', id: '9', work: 'turnedIn' }));
});
