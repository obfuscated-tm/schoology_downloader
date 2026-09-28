// The six ops the MCP bridge answers a `request` with (docs/MCP-BRIDGE.md,
// binding — don't change without updating it there too): courses, todo,
// grades, assignment, updates, materials. Every one is GET-only, through a
// SchoologyClient and the shared limiter (background/bridge.js supplies the
// real one), with the same quiz/assessment guard sync/sync.js's `get()` uses:
// never a quiz-taking URL or an /assessments/ page; a redirect into one is
// reported as `error: 'quiz'`, never followed. Ids are validated
// `^\d{1,20}$` before anything is fetched.
//
// Pure of chrome.*: `{ client, parse }` is passed in (a real SchoologyClient +
// offscreenParse in production, a fake object in tests), the same shape
// sync/sync.js's runSync takes — so this file, like that one, can be tested
// without Chrome.

import { LoginError, isQuizTakingUrl } from '../../reader/client.js';
import { RateLimitError } from '../../reader/ratelimit.js';
import { isAssessmentUrl, parseEventsJson, nextEventsUrl } from '../../reader/parse/sync.js';

const ID_RE = /^\d{1,20}$/;
const MAX_EVENT_PAGES = 20;

function codeError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/** `^\d{1,20}$`, else throws a `bad_args`-coded error. Returns the id as a string. */
export function validId(id) {
  const s = String(id ?? '');
  if (!ID_RE.test(s)) throw codeError('bad_args');
  return s;
}

// One GET through `client`: refuses a quiz-taking URL or an /assessments/
// page before fetching, falls back to an open Schoology tab the same way
// sync/runner.js's SchoologyClient.init does when a direct fetch isn't
// signed in, and — like sync/sync.js's own `get()` — never treats a page
// Schoology redirected into (an /assessments/ URL, or an opaque redirect
// when `opts.noRedirect` asks for one) as real content.
async function fetchViaClient(client, path, opts = {}) {
  if (isQuizTakingUrl(client.abs(path)) || isAssessmentUrl(path)) throw codeError('quiz');
  let r;
  try {
    r = await client.getText(path, opts);
  } catch (e) {
    if (!(e instanceof LoginError) && !(e instanceof TypeError)) throw e;
    const tabId = await client.findSchoologyTab?.();
    if (!tabId) throw e instanceof LoginError ? e : new LoginError();
    client.mode = 'tab';
    client.tabId = tabId;
    r = await client.getText(path, opts);
  }
  if (r.redirected) throw codeError('quiz');
  if (isAssessmentUrl(r.url)) throw codeError('quiz');
  client.verified = true;
  return r;
}

// A GET whose body needs parsing (the offscreen document does it for
// anything DOM-shaped; `parse` is `(kind, text, url) => { data } | { login }`).
async function get(client, parse, path, kind, opts) {
  const r = await fetchViaClient(client, path, opts);
  const p = await parse(kind, r.text, r.url);
  if (p?.login) throw codeError('login');
  return { data: p.data, url: r.url };
}

function errorFor(e) {
  if (e?.code) return e.code;
  if (e instanceof LoginError) return 'login';
  if (e instanceof RateLimitError) return 'ratelimit';
  return 'schoology';
}

async function runOp(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const error = errorFor(e);
    const out = { ok: false, error };
    if (error === 'schoology') out.message = String(e?.message || e);
    return out;
  }
}

// ── The six ops ──────────────────────────────────────────────────────────

export async function opCourses({ client, parse }) {
  return runOp(async () => (await get(client, parse, '/iapi/course/active', 'courses')).data);
}

/** { upcoming, overdue, recent }: /v2/events/{list}, every page (@links.next), parsed by parseEventsJson (pure JSON — no offscreen doc needed). */
export async function opTodo({ client }) {
  return runOp(async () => {
    const lists = {};
    for (const list of ['upcoming', 'overdue', 'recent']) {
      const rows = [];
      let url = `/v2/events/${list}`;
      const seen = new Set();
      for (let page = 0; url && page < MAX_EVENT_PAGES && !seen.has(url); page++) {
        seen.add(url);
        const r = await fetchViaClient(client, url, { headers: { Accept: 'application/json' } });
        rows.push(...parseEventsJson(r.text));
        url = nextEventsUrl(r.text);
      }
      lists[list] = rows;
    }
    return lists;
  });
}

export async function opGrades({ client, parse }, { section_id } = {}) {
  return runOp(async () => {
    const sid = validId(section_id);
    const r = await get(client, parse, `/course/${sid}/student_grades`, 'gradesFull');
    return { section_id: sid, rows: r.data };
  });
}

export async function opAssignment({ client, parse }, { id } = {}) {
  return runOp(async () => {
    const aid = validId(id);
    const r = await get(client, parse, `/assignment/${aid}`, 'assignmentFull');
    let grade = null;
    let comments = [];
    if (r.data.dropboxUrl) {
      try {
        const d = await get(client, parse, `${r.data.dropboxUrl}?revision=1`, 'dropboxFull');
        grade = d.data.grade || null;
        comments = d.data.comments || [];
      } catch { /* no dropbox to read (login/ratelimit would already have surfaced from the assignment page itself) */ }
    }
    return {
      id: aid, url: r.url,
      title: r.data.title ?? null, type: r.data.type ?? null, due: r.data.due ?? null,
      folder: null, // not visible from the assignment page alone; the `materials` op has it
      instructions_md: r.data.instructions_md ?? null,
      grade, comments,
      submission: r.data.submission ?? null,
      attachments: r.data.attachments ?? [],
    };
  });
}

export async function opUpdates({ client, parse }, { section_id, page } = {}) {
  return runOp(async () => {
    const sid = validId(section_id);
    const p = Number.isInteger(page) && page >= 0 ? page : 0;
    const r = await get(client, parse, `/course/${sid}/feed?page=${p}`, 'updatesFeed');
    return { section_id: sid, page: p, posts: r.data };
  });
}

export async function opMaterials({ client, parse }, { section_id, folder_id } = {}) {
  return runOp(async () => {
    const sid = validId(section_id);
    const fid = folder_id === undefined || folder_id === null || folder_id === '' ? null : validId(folder_id);
    const path = `/course/${sid}/materials${fid ? `?f=${fid}` : ''}`;
    const r = await get(client, parse, path, 'materialsFull');
    return { section_id: sid, folder_id: fid, rows: r.data };
  });
}

const OPS = { courses: opCourses, todo: opTodo, grades: opGrades, assignment: opAssignment, updates: opUpdates, materials: opMaterials };

/** Dispatches one `{ op, args }` request. `deps` is `{ client, parse }`. Always resolves. */
export async function runMcpOp(op, args, deps) {
  const fn = OPS[op];
  if (!fn) return { ok: false, error: 'op' };
  return fn(deps, args || {});
}
