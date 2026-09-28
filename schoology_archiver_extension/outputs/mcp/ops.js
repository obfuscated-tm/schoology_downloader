// The eight ops the MCP bridge answers a `request` with (docs/MCP-BRIDGE.md,
// binding — don't change without updating it there too): courses, todo,
// grades, assignment, updates, materials, material, file. Every one is
// GET-only, through a SchoologyClient and the shared limiter
// (background/bridge.js supplies the real one), with the same
// quiz/assessment guard sync/sync.js's `get()` uses: never a quiz-taking URL
// or an /assessments/ page; a redirect into one is reported as
// `error: 'quiz'`, never followed. Ids are validated `^\d{1,20}$` before
// anything is fetched.
//
// Pure of chrome.*: `{ client, parse, fetch }` is passed in (a real
// SchoologyClient + offscreenParse + the global fetch in production, fakes in
// tests), the same shape sync/sync.js's runSync takes for `{ client, parse }`
// — so this file, like that one, can be tested without Chrome. `fetch` is
// only used by `opFile` (raw bytes; `client`/`parse` are DOM-page-shaped and
// don't fit downloading a binary attachment).

import { LoginError, isQuizTakingUrl } from '../../reader/client.js';
import { RateLimitError } from '../../reader/ratelimit.js';
import { isAssessmentUrl, parseEventsJson, nextEventsUrl } from '../../reader/parse/sync.js';
import { classifyLink } from '../archive/google.js';
import { extOf, parseContentDisposition } from '../../util.js';

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

// ── material / file ─────────────────────────────────────────────────────

// The exact path shapes docs/MCP-BRIDGE.md's `material` row lists. Order
// doesn't matter; each is checked against the pathname only (no query string).
const MATERIAL_SHAPES = [
  { kind: 'gp', re: /^\/course\/\d{1,20}\/materials\/gp\/\d{1,20}$/ },
  { kind: 'link_view', re: /^\/course\/\d{1,20}\/materials\/link\/view\/\d{1,20}$/ },
  { kind: 'page', re: /^\/page\/\d{1,20}$/ },
  { kind: 'discussion', re: /^\/discussion\/\d{1,20}$/ },
  { kind: 'assignment', re: /^\/assignment\/\d{1,20}$/ },
];

// The Schoology host a client talks to, derived the same way client.abs()
// resolves a relative URL — works for both the real SchoologyClient and the
// fake ones in tests.
function hostOf(client) {
  try { return new URL(client.abs('/')).host; } catch { return null; }
}

// Accepts a bare Schoology path or an absolute `https://{same host}/…` URL;
// anything else (a relative path that isn't rooted, another host, garbage) is
// `bad_args`. Returns the path (+ query, unused here) to fetch through the
// client.
function materialPath(urlArg, client) {
  const raw = String(urlArg ?? '');
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { throw codeError('bad_args'); }
    if (u.protocol !== 'https:' || u.host !== hostOf(client)) throw codeError('bad_args');
    return u.pathname + u.search;
  }
  if (!raw.startsWith('/')) throw codeError('bad_args');
  let u;
  try { u = new URL(raw, client.abs('/')); } catch { throw codeError('bad_args'); }
  return u.pathname + u.search;
}

export async function opMaterial(deps, { url } = {}) {
  const { client, parse } = deps;
  return runOp(async () => {
    const path = materialPath(url, client);
    const pathname = path.split('?')[0];
    const shape = MATERIAL_SHAPES.find((s) => s.re.test(pathname));
    if (!shape) throw codeError('bad_args');

    if (shape.kind === 'assignment') {
      const id = (pathname.match(/\d{1,20}/) || [])[0];
      const a = await opAssignment(deps, { id });
      if (!a.ok) {
        const e = new Error(a.message || a.error);
        e.code = a.error;
        throw e;
      }
      return {
        url: a.data.url, kind: 'assignment', title: a.data.title,
        body_md: a.data.instructions_md, target: null,
        files: (a.data.attachments || []).map((f) => ({ title: f.title, url: f.url, ext: extOf(f.url) || null })),
        links: [],
      };
    }

    const r = await get(client, parse, path, 'materialFull');
    return r.data;
  });
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;

// docs/MCP-BRIDGE.md's `file` row: a Schoology attachment source URL (same
// host as the client, exact shape), or a docs.google.com/drive.google.com
// link. Anything else is `bad_args`.
function fileTarget(urlArg, client) {
  const raw = String(urlArg ?? '');
  let u;
  try { u = new URL(raw); } catch { throw codeError('bad_args'); }
  if (u.protocol !== 'https:') throw codeError('bad_args');
  if (u.host === hostOf(client)) {
    if (!/^\/attachment\/[^/]+\/source\/.+/.test(u.pathname)) throw codeError('bad_args');
    return { kind: 'schoology', url: u.href };
  }
  if (u.hostname === 'docs.google.com' || u.hostname === 'drive.google.com') return { kind: 'google', url: u.href };
  throw codeError('bad_args');
}

// Base64-encode without spreading the whole buffer into String.fromCharCode
// (blows the call stack / is needlessly slow on anything but tiny files).
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function bytesFromResponse(res, url) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_FILE_BYTES) throw codeError('too_large');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FILE_BYTES) throw codeError('too_large');
  return {
    url,
    name: parseContentDisposition(res.headers.get('content-disposition')) || url,
    mime: res.headers.get('content-type') || 'application/octet-stream',
    size: buf.byteLength,
    base64: toBase64(buf),
  };
}

// Sheets export as .xlsx everywhere else in this extension (google.js,
// for the archive); the MCP's `file` op returns CSV instead so Claude gets
// plain text it can read without an xlsx parser.
function googleExportUrl(info) {
  return info.label === 'Google Sheet' ? info.exportUrl.replace('format=xlsx', 'format=csv') : info.exportUrl;
}

export async function opFile({ client, fetch: fetchFn } = {}, { url } = {}) {
  return runOp(async () => {
    const target = fileTarget(url, client);
    const doFetch = fetchFn || fetch;

    if (target.kind === 'schoology') {
      await client.throttle?.();
      let res;
      try {
        res = await doFetch(target.url, { credentials: 'include' });
      } catch (e) {
        throw e instanceof TypeError ? codeError('login') : e;
      }
      let finalUrl;
      try { finalUrl = new URL(res.url || target.url); } catch { finalUrl = new URL(target.url); }
      // A source attachment normally redirects to Schoology's file host, so a
      // different final host is fine; a sign-in page (or any HTML where a
      // file should be) is not.
      const onLogin = /(^|\.)schoology\.com$/i.test(finalUrl.host) && finalUrl.pathname.startsWith('/login');
      if (res.status === 401 || res.status === 403 || onLogin || /text\/html/i.test(res.headers?.get?.('content-type') || '')) {
        throw codeError('login');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await bytesFromResponse(res, target.url);
    }

    const info = classifyLink(target.url);
    if (info.kind !== 'google' && info.kind !== 'drivefile') throw codeError('bad_args');
    const res = await doFetch(googleExportUrl(info), { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (/text\/html/i.test(res.headers.get('content-type') || '')) {
      const e = codeError('schoology');
      e.message = 'Google showed a page instead of the file (no access, or too large to export)';
      throw e;
    }
    return await bytesFromResponse(res, target.url);
  });
}

const OPS = {
  courses: opCourses, todo: opTodo, grades: opGrades, assignment: opAssignment, updates: opUpdates,
  materials: opMaterials, material: opMaterial, file: opFile,
};

/** Dispatches one `{ op, args }` request. `deps` is `{ client, parse }`. Always resolves. */
export async function runMcpOp(op, args, deps) {
  const fn = OPS[op];
  if (!fn) return { ok: false, error: 'op' };
  return fn(deps, args || {});
}
