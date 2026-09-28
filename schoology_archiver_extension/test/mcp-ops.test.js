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

// ── material ────────────────────────────────────────────────────────────

test('material: accepts every documented path shape, relative or absolute (same host)', async () => {
  const shapes = [
    '/course/1/materials/gp/2',
    'https://x.schoology.com/course/1/materials/gp/2',
    '/course/1/materials/link/view/2',
    '/page/9',
    '/discussion/9',
  ];
  for (const url of shapes) {
    const client = fakeClient({ texts: new Map([[new URL(url, 'https://x.schoology.com').pathname, { text: 'html' }]]) });
    const r = await runMcpOp('material', { url }, { client, parse: async () => ({ data: { url, kind: 'x', title: null, body_md: null, target: null, files: [], links: [] } }) });
    assert.equal(r.ok, true, `${url}: ${JSON.stringify(r)}`);
  }
});

test('material: rejects shapes that are not exactly one of the documented ones', async () => {
  const bad = [
    '/course/1/materials', // no gp/id
    '/course/1/materials/gp/2/extra',
    '/assignment/5/assessment', // a quiz-taking path, not the assignment page
    '/something/else',
    'not a url at all',
  ];
  for (const url of bad) {
    const r = await runMcpOp('material', { url }, { client: fakeClient(), parse: async () => { throw new Error('should not fetch'); } });
    assert.deepEqual(r, { ok: false, error: 'bad_args' }, url);
  }
});

test('material: an absolute URL on another host is bad_args, even with a valid-looking path', async () => {
  const r = await runMcpOp('material', { url: 'https://evil.example.com/course/1/materials/gp/2' }, { client: fakeClient(), parse: async () => { throw new Error('should not fetch'); } });
  assert.deepEqual(r, { ok: false, error: 'bad_args' });
});

test('material: gp shape fetches through fetchViaClient (quiz guard applies) and returns the parsed shape', async () => {
  const client = fakeClient({ texts: new Map([['/course/1/materials/gp/2', { text: 'html' }]]) });
  const parsed = { url: 'https://x.schoology.com/course/1/materials/gp/2', kind: 'gp', title: 'Syllabus', body_md: 'hi', target: null, files: [{ title: 'a.pdf', url: 'https://x.schoology.com/attachment/1/source/h.pdf', ext: 'pdf' }], links: [] };
  const r = await runMcpOp('material', { url: '/course/1/materials/gp/2' }, { client, parse: async () => ({ data: parsed }) });
  assert.deepEqual(r, { ok: true, data: parsed });
});

test('material: a redirect into an assessment page is error: "quiz", not parsed', async () => {
  const client = fakeClient({ texts: new Map([['/page/9', { text: 'x', url: 'https://x.schoology.com/course/1/assessments/9' }]]) });
  const r = await runMcpOp('material', { url: '/page/9' }, { client, parse: async () => { throw new Error('must not parse a quiz page'); } });
  assert.deepEqual(r, { ok: false, error: 'quiz' });
});

test('material: assignment shape delegates to the assignment op and reshapes its attachments', async () => {
  const client = fakeClient({ texts: new Map([['/assignment/9', { text: 'page' }]]) });
  const parse = async (kind) => (kind === 'assignmentFull'
    ? { data: { title: 'Essay', type: 'assignment', due: null, instructions_md: 'Write it.', attachments: [{ url: 'https://x.schoology.com/attachment/1/source/h.pdf', title: 'a.pdf' }], submission: null, dropboxUrl: null } }
    : (() => { throw new Error('unexpected kind'); })());
  const r = await runMcpOp('material', { url: '/assignment/9' }, { client, parse });
  assert.equal(r.ok, true);
  assert.equal(r.data.kind, 'assignment');
  assert.equal(r.data.title, 'Essay');
  assert.equal(r.data.body_md, 'Write it.');
  assert.equal(r.data.target, null);
  assert.deepEqual(r.data.files, [{ title: 'a.pdf', url: 'https://x.schoology.com/attachment/1/source/h.pdf', ext: 'pdf' }]);
  assert.deepEqual(r.data.links, []);
});

test('material: assignment shape surfaces the assignment op\'s error (e.g. login)', async () => {
  const client = fakeClient({ texts: new Map([['/assignment/9', new LoginError()]]) });
  const r = await runMcpOp('material', { url: '/assignment/9' }, { client, parse: async () => { throw new Error('n/a'); } });
  assert.deepEqual(r, { ok: false, error: 'login' });
});

// ── file ────────────────────────────────────────────────────────────────

function fakeRes({ status = 200, headers = {}, body = new Uint8Array([1, 2, 3]).buffer, url } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status, ok: status >= 200 && status < 300, url,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () => body,
  };
}

test('file: bad_args for anything that is not a Schoology attachment/source URL or a Google host', async () => {
  const client = fakeClient();
  const bad = [
    'https://x.schoology.com/attachment/1/download/h.pdf', // not /source/
    'https://x.schoology.com/course/1/materials', // schoology, but not an attachment
    'https://evil.example.com/attachment/1/source/h.pdf', // other host
    'http://x.schoology.com/attachment/1/source/h.pdf', // not https
    'not a url',
  ];
  for (const url of bad) {
    const r = await runMcpOp('file', { url }, { client, fetch: async () => { throw new Error('should not fetch'); } });
    assert.deepEqual(r, { ok: false, error: 'bad_args' }, url);
  }
});

test('file: a Schoology attachment is fetched directly with credentials included', async () => {
  const client = fakeClient();
  let seenOpts;
  const fetchFn = async (url, opts) => { seenOpts = opts; return fakeRes({ url, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="notes.pdf"' } }); };
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.pdf' }, { client, fetch: fetchFn });
  assert.equal(r.ok, true);
  assert.equal(seenOpts.credentials, 'include');
  assert.equal(r.data.name, 'notes.pdf');
  assert.equal(r.data.mime, 'application/pdf');
  assert.equal(r.data.size, 3);
});

test('file: base64 correctness on a small byte array', async () => {
  const client = fakeClient();
  const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const fetchFn = async (url) => fakeRes({ url, body: bytes.buffer });
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.bin' }, { client, fetch: fetchFn });
  assert.equal(r.ok, true);
  assert.equal(r.data.base64, Buffer.from(bytes).toString('base64'));
});

test('file: a redirect to Schoology\'s file host (another host) is the file, not a login', async () => {
  const client = fakeClient();
  const fetchFn = async () => fakeRes({ url: 'https://files-cdn.schoology.com/abc/h.pdf?sig=1', headers: { 'content-type': 'application/pdf' } });
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.pdf' }, { client, fetch: fetchFn });
  assert.equal(r.ok, true);
});

test('file: an HTML page where the file should be is error: "login"', async () => {
  const client = fakeClient();
  const fetchFn = async (url) => fakeRes({ url, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.pdf' }, { client, fetch: fetchFn });
  assert.deepEqual(r, { ok: false, error: 'login' });
});

test('file: a Schoology fetch that lands on /login is error: "login" (no tab fallback attempted)', async () => {
  const client = fakeClient();
  const fetchFn = async () => fakeRes({ url: 'https://x.schoology.com/login?redir=/attachment/1/source/h.pdf' });
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.pdf' }, { client, fetch: fetchFn });
  assert.deepEqual(r, { ok: false, error: 'login' });
});

test('file: Content-Length over 15MB is too_large before the body is read', async () => {
  const client = fakeClient();
  let read = false;
  const fetchFn = async (url) => ({
    status: 200, ok: true, url,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(16 * 1024 * 1024) : null) },
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
  });
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.bin' }, { client, fetch: fetchFn });
  assert.deepEqual(r, { ok: false, error: 'too_large' });
  assert.equal(read, false);
});

test('file: an oversized body with no (or a wrong) Content-Length is still caught by the actual byte length', async () => {
  const client = fakeClient();
  const big = new ArrayBuffer(16 * 1024 * 1024);
  const fetchFn = async (url) => fakeRes({ url, body: big });
  const r = await runMcpOp('file', { url: 'https://x.schoology.com/attachment/1/source/h.bin' }, { client, fetch: fetchFn });
  assert.deepEqual(r, { ok: false, error: 'too_large' });
});

test('file: Google Docs/Slides/Drawings export to PDF, Sheets export to CSV (not xlsx)', async () => {
  const client = fakeClient();
  const cases = [
    ['https://docs.google.com/document/d/abc123/edit', /\/export\?format=pdf$/],
    ['https://docs.google.com/presentation/d/abc123/edit', /\/export\/pdf$/],
    ['https://docs.google.com/drawings/d/abc123/edit', /\/export\/pdf$/],
    ['https://docs.google.com/spreadsheets/d/abc123/edit', /format=csv$/],
  ];
  for (const [url, expected] of cases) {
    let seenUrl;
    const fetchFn = async (u) => { seenUrl = u; return fakeRes({ url: u, headers: { 'content-type': 'application/octet-stream' } }); };
    const r = await runMcpOp('file', { url }, { client, fetch: fetchFn });
    assert.equal(r.ok, true, url);
    assert.match(seenUrl, expected, url);
  }
});

test('file: a Drive file downloads from the uc?export=download URL', async () => {
  const client = fakeClient();
  let seenUrl;
  const fetchFn = async (u) => { seenUrl = u; return fakeRes({ url: u }); };
  const r = await runMcpOp('file', { url: 'https://drive.google.com/file/d/xyz789/view' }, { client, fetch: fetchFn });
  assert.equal(r.ok, true);
  assert.match(seenUrl, /uc\?export=download&id=xyz789/);
});

test('file: Google returning HTML instead of the file is error: "schoology" with a clear message', async () => {
  const client = fakeClient();
  const fetchFn = async (u) => fakeRes({ url: u, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const r = await runMcpOp('file', { url: 'https://docs.google.com/document/d/abc123/edit' }, { client, fetch: fetchFn });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'schoology');
  assert.match(r.message, /no access|too large/i);
});

test('file: a Drive folder is fetched as its embedded folder view', async () => {
  const client = fakeClient();
  let seenUrl;
  const fetchFn = async (u) => { seenUrl = u; return fakeRes({ url: u, headers: { 'content-type': 'text/html' } }); };
  const r = await runMcpOp('file', { url: 'https://drive.google.com/drive/folders/abc123?resourcekey=0-rk&usp=sharing' }, { client, fetch: fetchFn });
  assert.equal(r.ok, true);
  assert.equal(seenUrl, 'https://drive.google.com/embeddedfolderview?id=abc123&resourcekey=0-rk');
  assert.equal(r.data.url, 'https://drive.google.com/drive/folders/abc123?resourcekey=0-rk&usp=sharing');
});

test('file: a Google Form link is bad_args (nothing to download)', async () => {
  const client = fakeClient();
  const bad = ['https://docs.google.com/forms/d/e/abc/viewform'];
  for (const url of bad) {
    const r = await runMcpOp('file', { url }, { client, fetch: async () => { throw new Error('should not fetch'); } });
    assert.deepEqual(r, { ok: false, error: 'bad_args' }, url);
  }
});
