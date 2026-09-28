// node --test test/   (from schoology_archiver_extension/)
//
// outputs/mcp/ops.js: id validation, op dispatch, and the quiz/login/ratelimit
// guard, all against a fake { client, parse } (no chrome.*, no real network,
// no DOMParser — ops.js itself never touches the DOM; that's the offscreen
// document's job via the injected `parse`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validId, runMcpOp } from '../outputs/mcp/ops.js';
import { LoginError } from '../reader/client.js';
import { RateLimitError } from '../reader/ratelimit.js';

// A fake SchoologyClient: getText(path, opts) is scripted per test via `texts`
// (a Map path -> { text, url, redirected? } | Error to throw).
function fakeClient({ texts = new Map(), findSchoologyTab = async () => null } = {}) {
  return {
    mode: 'direct',
    abs: (u) => (u.startsWith('http') ? u : `https://x.schoology.com${u}`),
    findSchoologyTab,
    getText: async (path) => {
      const entry = texts.get(path);
      if (entry === undefined) throw new Error(`unscripted path ${path}`);
      if (entry instanceof Error) throw entry;
      return { text: entry.text ?? '', url: entry.url ?? `https://x.schoology.com${path}`, redirected: !!entry.redirected };
    },
  };
}

test('validId: numeric strings up to 20 digits, nothing else', () => {
  assert.equal(validId('123'), '123');
  assert.equal(validId(123), '123');
  assert.throws(() => validId('12a'), /bad_args/);
  assert.throws(() => validId(''), /bad_args/);
  assert.throws(() => validId('1'.repeat(21)), /bad_args/);
});

test('runMcpOp: an unknown op is `error: "op"`, no fetch attempted', async () => {
  const r = await runMcpOp('nope', {}, { client: fakeClient(), parse: async () => { throw new Error('should not be called'); } });
  assert.deepEqual(r, { ok: false, error: 'op' });
});

test('opCourses (via runMcpOp): success passes parseKind\'s data straight through', async () => {
  const client = fakeClient({ texts: new Map([['/iapi/course/active', { text: '{}' }]]) });
  const parse = async (kind) => (kind === 'courses' ? { data: [{ section_id: '1', title: 'A', section_title: 'B' }] } : null);
  const r = await runMcpOp('courses', {}, { client, parse });
  assert.deepEqual(r, { ok: true, data: [{ section_id: '1', title: 'A', section_title: 'B' }] });
});

test('grades: bad_args for a non-numeric section_id, before any fetch', async () => {
  const r = await runMcpOp('grades', { section_id: 'abc' }, { client: fakeClient(), parse: async () => { throw new Error('no'); } });
  assert.deepEqual(r, { ok: false, error: 'bad_args' });
});

test('grades: a login page (parse returns { login: true }) is error: "login"', async () => {
  const client = fakeClient({ texts: new Map([['/course/1/student_grades', { text: '<html></html>' }]]) });
  const parse = async () => ({ login: true });
  const r = await runMcpOp('grades', { section_id: '1' }, { client, parse });
  assert.deepEqual(r, { ok: false, error: 'login' });
});

test('grades: success', async () => {
  const client = fakeClient({ texts: new Map([['/course/42/student_grades', { text: '<html></html>' }]]) });
  const parse = async () => ({ data: [{ level: 'item', title: 'HW 1', grade: '9/10' }] });
  const r = await runMcpOp('grades', { section_id: '42' }, { client, parse });
  assert.deepEqual(r, { ok: true, data: { section_id: '42', rows: [{ level: 'item', title: 'HW 1', grade: '9/10' }] } });
});

test('quiz: a redirect into the page (r.redirected true) is error: "quiz", the response is not parsed', async () => {
  const client = fakeClient({ texts: new Map([['/assignment/5', { text: 'should not be parsed', redirected: true }]]) });
  const r = await runMcpOp('assignment', { id: '5' }, { client, parse: async () => { throw new Error('must not parse a redirected response'); } });
  assert.deepEqual(r, { ok: false, error: 'quiz' });
});

test('quiz: the final URL landing on /assessments/ is error: "quiz"', async () => {
  const client = fakeClient({ texts: new Map([['/assignment/5', { text: 'quiz html', url: 'https://x.schoology.com/course/1/assessments/9' }]]) });
  const r = await runMcpOp('assignment', { id: '5' }, { client, parse: async () => { throw new Error('must not parse a quiz page'); } });
  assert.deepEqual(r, { ok: false, error: 'quiz' });
});

test('login: LoginError from the client, no open Schoology tab to fall back to', async () => {
  const client = fakeClient({ texts: new Map([['/assignment/5', new LoginError()]]), findSchoologyTab: async () => null });
  const r = await runMcpOp('assignment', { id: '5' }, { client, parse: async () => ({ data: {} }) });
  assert.deepEqual(r, { ok: false, error: 'login' });
});

test('login: LoginError falls back to an open Schoology tab, and that retry succeeds', async () => {
  let calls = 0;
  const client = fakeClient({ findSchoologyTab: async () => 77 });
  client.getText = async (path) => {
    calls++;
    if (calls === 1) throw new LoginError();
    return { text: 'ok', url: `https://x.schoology.com${path}` };
  };
  const parse = async () => ({ data: { title: 'X', type: 'assignment', due: null, instructions_md: '', attachments: [], submission: null, dropboxUrl: null } });
  const r = await runMcpOp('assignment', { id: '5' }, { client, parse });
  assert.equal(r.ok, true);
  assert.equal(client.mode, 'tab');
  assert.equal(client.tabId, 77);
  assert.equal(calls, 2);
});

test('ratelimit: a RateLimitError from the client surfaces as error: "ratelimit"', async () => {
  const client = fakeClient({ texts: new Map([['/iapi/course/active', new RateLimitError()]]) });
  const r = await runMcpOp('courses', {}, { client, parse: async () => ({ data: [] }) });
  assert.deepEqual(r, { ok: false, error: 'ratelimit' });
});

test('an unexpected error is error: "schoology" with a message', async () => {
  const client = fakeClient({ texts: new Map([['/iapi/course/active', new Error('HTTP 500')]]) });
  const r = await runMcpOp('courses', {}, { client, parse: async () => ({ data: [] }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'schoology');
  assert.match(r.message, /HTTP 500/);
});

test('assignment: with a dropbox, grade/comments come from a second fetch; folder is always null', async () => {
  const client = fakeClient({
    texts: new Map([
      ['/assignment/9', { text: 'page' }],
      ['https://x.schoology.com/dropbox/view/1?revision=1', { text: 'dropbox' }],
    ]),
  });
  const parse = async (kind) => {
    if (kind === 'assignmentFull') {
      return {
        data: {
          title: 'Essay', type: 'assignment', due: '2026-09-30T05:00:00.000Z',
          instructions_md: 'Write it.', attachments: [{ url: 'https://x/a.pdf', title: 'a.pdf' }],
          submission: { state: 'submitted', late: false },
          dropboxUrl: 'https://x.schoology.com/dropbox/view/1',
        },
      };
    }
    if (kind === 'dropboxFull') return { data: { grade: '9/10', comments: [{ author: 'T', text: 'Nice' }] } };
    throw new Error(`unexpected kind ${kind}`);
  };
  const r = await runMcpOp('assignment', { id: '9' }, { client, parse });
  assert.equal(r.ok, true);
  assert.equal(r.data.folder, null);
  assert.equal(r.data.grade, '9/10');
  assert.deepEqual(r.data.comments, [{ author: 'T', text: 'Nice' }]);
  assert.equal(r.data.submission.state, 'submitted');
});

test('assignment: a dropbox fetch failure still returns the assignment, with null grade/empty comments', async () => {
  const client = fakeClient({
    texts: new Map([
      ['/assignment/9', { text: 'page' }],
      ['https://x.schoology.com/dropbox/view/1?revision=1', new Error('boom')],
    ]),
  });
  const parse = async (kind) => (kind === 'assignmentFull'
    ? { data: { title: 'Essay', type: 'assignment', due: null, instructions_md: '', attachments: [], submission: null, dropboxUrl: 'https://x.schoology.com/dropbox/view/1' } }
    : (() => { throw new Error('should not reach dropboxFull parse'); })());
  const r = await runMcpOp('assignment', { id: '9' }, { client, parse });
  assert.equal(r.ok, true);
  assert.equal(r.data.grade, null);
  assert.deepEqual(r.data.comments, []);
});

test('todo: follows @links.next across all three lists', async () => {
  const pages = {
    '/v2/events/upcoming': { text: JSON.stringify({ '@extra': [], '@links': { next: '/v2/events/upcoming?page=2' } }) },
    '/v2/events/upcoming?page=2': { text: JSON.stringify({ '@extra': [] }) },
    '/v2/events/overdue': { text: JSON.stringify({ '@extra': [] }) },
    '/v2/events/recent': { text: JSON.stringify({ '@extra': [] }) },
  };
  const client = fakeClient({ texts: new Map(Object.entries(pages)) });
  const seen = [];
  client.getText = async (path) => { seen.push(path); const e = pages[path]; return { text: e.text, url: `https://x.schoology.com${path}` }; };
  const r = await runMcpOp('todo', {}, { client, parse: async () => { throw new Error('todo needs no offscreen parse'); } });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data), ['upcoming', 'overdue', 'recent']);
  assert.deepEqual(seen, ['/v2/events/upcoming', '/v2/events/upcoming?page=2', '/v2/events/overdue', '/v2/events/recent']);
});

test('materials: folder_id is optional and validated the same way as section_id', async () => {
  const r = await runMcpOp('materials', { section_id: '1', folder_id: 'nope' }, { client: fakeClient(), parse: async () => ({ data: [] }) });
  assert.deepEqual(r, { ok: false, error: 'bad_args' });
});

test('materials: no folder_id reads the root materials page', async () => {
  const client = fakeClient({ texts: new Map([['/course/1/materials', { text: 'html' }]]) });
  const r = await runMcpOp('materials', { section_id: '1' }, { client, parse: async () => ({ data: [{ kind: 'folder', title: 'Unit 1', id: 'f1', url: '/course/1/materials?f=f1' }] }) });
  assert.equal(r.ok, true);
  assert.equal(r.data.folder_id, null);
  assert.equal(r.data.rows.length, 1);
});

test('updates: defaults page to 0', async () => {
  const client = fakeClient({ texts: new Map([['/course/1/feed?page=0', { text: '{}' }]]) });
  const r = await runMcpOp('updates', { section_id: '1' }, { client, parse: async () => ({ data: [{ author: 'Ms. X', date: 'Sep 1', body_md: 'Hi' }] }) });
  assert.equal(r.ok, true);
  assert.equal(r.data.page, 0);
  assert.equal(r.data.posts.length, 1);
});
