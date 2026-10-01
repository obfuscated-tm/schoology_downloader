// The light sync: every course, no files. Reads Schoology (GET only, through
// SchoologyClient so the quiz guard applies), then tells neo-plan what it saw
// with one POST /api/import/schoology/enrich (docs/EXTENSION-CONTRACT-4.md).
//
// One run, in order, sequential, on the client's throttle:
//   neo-plan  GET  /api/extension/courses          which sections map to a class
//   Schoology GET  /iapi/course/active             1
//   Schoology GET  /home/upcoming_submissions_ajax 1
//   Schoology GET  /home/overdue_submissions_ajax  1
//   Schoology GET  /home/upcoming_ajax             1
//   Schoology GET  /course/{id}/student_grades     1 per section mapped to a class
//   neo-plan  GET  /api/extension/items?…          which upcoming/overdue ones it has
//   neo-plan  POST /api/extension/items            1 per one it doesn't, at most ADD_CAP
//   neo-plan  GET  /api/extension/open             open Schoology assignments
//   Schoology GET  /assignment/{id}/info           1 per open id, at most STATUS_CAP,
//                                                  redirects reported, never followed
//   neo-plan  POST /api/import/schoology/enrich
// and leaves a Snapshot in chrome.storage.local for the panel and overlays.
//
// Dependencies are passed in so the harness can run it without Chrome:
//   client  SchoologyClient (getText, findSchoologyTab, mode, tabId)
//   parse   (kind, text, url) → { data } | { login: true }   (reader/parse/sync.js parseKind)
//   np      (op, args) → { ok, status, data }                 (outputs/neoplan/api.js)
//   storage chrome.storage.local-like { get, set }

import { LoginError, isQuizTakingUrl } from '../reader/client.js';
import { RateLimitError } from '../reader/ratelimit.js';
import { sectionsByRealm, realmKey, isAssessmentUrl } from '../reader/parse/sync.js';

export const STATUS_CAP = 10;
export const ADD_CAP = 25; // new items added in one run, at most
const ADD_OVERDUE_DAYS = 14; // overdue work older than this was most likely left out on purpose
const STATUS_MIN_AGE_MS = 30 * 60 * 1000; // an id checked more recently than this is left for next run
export const KEY_SNAPSHOT = 'syncSnapshot';
export const KEY_CHECKED = 'syncStatusChecked'; // { schoology_id: last checked ms }
const SECTION_MEMORY = 3000; // assignment → section pairs kept for submit detection

class NeoplanError extends Error {
  constructor(op, r) {
    super(`neo-plan ${op}: ${r.status || r.data?.error || 'network'}`);
    this.op = op;
    this.status = r.status;
    this.code = r.status === 401 ? 'token' : 'neoplan';
    this.noToken = r.noToken === true; // none saved, as opposed to one neo-plan refused
  }
}

const ID_RE = /^\d{1,20}$/;

/**
 * Open ids, least recently checked first, at most `cap`. An id checked less
 * than `minAgeMs` ago is not picked at all — it's still fresh, so this run
 * leaves it for the next one. Never-checked ids (no `checked[id]`) always
 * come first. Pure.
 */
export function pickForStatus(openIds, checked, cap = STATUS_CAP, minAgeMs = STATUS_MIN_AGE_MS, now = Date.now()) {
  const ids = [...new Set((openIds || []).map(String).filter((x) => ID_RE.test(x)))];
  return ids
    .map((id, i) => ({ id, i, t: Number(checked?.[id]) || 0 }))
    .filter((x) => x.t === 0 || now - x.t >= minAgeMs)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, cap)
    .map((x) => x.id);
}

/**
 * The home-list rows worth adding to neo-plan if it doesn't have them:
 * every upcoming one, and overdue ones due in the last two weeks. One row
 * per id, upcoming first. Pure.
 */
export function addCandidates({ upcoming = [], overdue = [] }, now = Date.now()) {
  const out = new Map();
  for (const r of upcoming) if (ID_RE.test(String(r.schoology_id))) out.set(String(r.schoology_id), r);
  for (const r of overdue) {
    const id = String(r.schoology_id);
    if (!ID_RE.test(id) || out.has(id)) continue;
    const due = Date.parse(r.due || '');
    if (Number.isNaN(due) || now - due <= ADD_OVERDUE_DAYS * 86_400_000) out.set(id, r);
  }
  return [...out.values()];
}

export async function runSync({ client, parse, np, storage, now = () => new Date(), log = () => {} }) {
  const started = now();
  const fetchedAt = started.toISOString();
  const prev = (await storage.get(KEY_SNAPSHOT))[KEY_SNAPSHOT] || null;
  const snap = {
    at: fetchedAt,
    finished_at: null,
    ok: false,
    error: null, // null | 'login' | 'token' | 'neoplan' | 'schoology' | 'ratelimit' | 'stopped'
    mode: null,
    counts: { courses: 0, upcoming: 0, overdue: 0, events: 0, gradebooks: 0, gradebook_rows: 0, missing: 0, added: 0, open: 0, checked: 0, submitted: 0, redirected: 0, items: 0 },
    requests: { schoology: 0, neoplan: 0 },
    did: {},
    courses: [],
    errors: [],
    sectionOf: { ...(prev?.sectionOf || {}) },
    neoplan: false, // whether this run talked to neo-plan at all (docs/MCP-BRIDGE.md)
    lists: { upcoming: [], overdue: [], events: [] }, // the rows this run read, for the MCP with Chrome closed
  };
  const stored = (await storage.get(KEY_CHECKED))[KEY_CHECKED] || {};

  const npCall = async (op, args) => {
    snap.requests.neoplan++;
    const r = await np(op, args);
    if (!r.ok) throw new NeoplanError(op, r);
    return r.data;
  };

  // Every Schoology read goes through here: GET, through the client, never a
  // quiz page or an /assessments/ page, whatever a list or redirect says.
  const get = async (path, kind, opts = {}) => {
    if (isQuizTakingUrl(client.abs(path)) || isAssessmentUrl(path)) throw new Error(`refused ${path}`);
    snap.requests.schoology++;
    const r = await client.getText(path, opts);
    if (r.redirected) return { redirected: true };
    if (isAssessmentUrl(r.url)) return { data: { state: 'unknown', quiz: true } };
    const p = await parse(kind, r.text, r.url);
    if (p?.login) throw new LoginError();
    client.verified = true;
    return p;
  };

  try {
    // 1. neo-plan's course map first. No token configured is not an error:
    //    the rest of the run still reads Schoology (courses, home lists,
    //    events) for the MCP snapshot; every neo-plan-dependent step below
    //    (gradebooks, open ids, status checks, enrich) is skipped instead.
    let map = null;
    let noToken = false;
    try {
      map = await npCall('courses');
    } catch (e) {
      if (e instanceof NeoplanError && e.noToken) noToken = true;
      else throw e;
    }
    const classOf = new Map((map?.courses || []).map((c) => [String(c.section_id), c.class_id ?? null]));

    // 2. Courses. Direct fetch first; if Schoology doesn't see the session that
    //    way, an open Schoology tab reads for us; with no tab, stop quietly.
    let courses;
    try {
      courses = (await get('/iapi/course/active', 'courses')).data;
    } catch (e) {
      if (!(e instanceof LoginError) && !(e instanceof TypeError)) throw e;
      const tabId = await client.findSchoologyTab?.();
      if (!tabId) throw new LoginError();
      client.mode = 'tab';
      client.tabId = tabId;
      courses = (await get('/iapi/course/active', 'courses')).data;
    }
    snap.mode = client.mode;
    snap.counts.courses = courses.length;
    const byRealm = sectionsByRealm(courses);
    const sectionForRealm = (realm) => (realm ? byRealm.get(realmKey(realm)) ?? null : null);

    const items = new Map(); // "kind:id" → item
    const itemFor = (kind, id, section) => {
      const k = `${kind}:${id}`;
      if (!items.has(k)) items.set(k, { kind, schoology_id: id, section_id: null });
      const it = items.get(k);
      if (!it.section_id && section) it.section_id = section;
      return it;
    };

    // 3. The home lists: course per open assignment, across every course.
    for (const [key, path] of [['upcoming', '/home/upcoming_submissions_ajax'], ['overdue', '/home/overdue_submissions_ajax']]) {
      const rows = (await get(path, 'homeList')).data;
      snap.counts[key] = rows.length;
      snap.lists[key] = rows;
      for (const r of rows) itemFor('assignment', r.schoology_id, sectionForRealm(r.realm));
    }

    // 4. Upcoming events.
    const events = (await get('/home/upcoming_ajax', 'events')).data;
    snap.counts.events = events.length;
    snap.lists.events = events;
    for (const ev of events) itemFor('event', ev.schoology_id, sectionForRealm(ev.realm));

    // 5. Gradebooks, only for sections neo-plan maps to a column.
    for (const c of courses) {
      const row = { ...c, class_id: classOf.get(c.section_id) ?? null, auto: false, gradebook: 'skipped', rows: 0, missing: 0 };
      snap.courses.push(row);
      if (!row.class_id) continue;
      try {
        const rows = (await get(`/course/${c.section_id}/student_grades`, 'gradebook')).data;
        row.gradebook = 'ok';
        row.rows = rows.length;
        snap.counts.gradebooks++;
        snap.counts.gradebook_rows += rows.length;
        for (const g of rows) {
          const it = itemFor('assignment', g.schoology_id, c.section_id);
          it.gradebook = { missing: g.missing === true ? true : null };
          if (g.missing === true) { row.missing++; snap.counts.missing++; }
        }
      } catch (e) {
        if (e instanceof LoginError || e instanceof RateLimitError || e?.name === 'StoppedError' || e?.name === 'AbortError') throw e;
        row.gradebook = 'error';
        snap.errors.push(`gradebook ${c.section_id}: ${e.message || e}`);
      }
    }

    // 5b. New work goes into neo-plan without a click: an upcoming (or
    //     recently overdue) assignment neo-plan has no item for at all. One
    //     it has, removed or not, is left alone. A refused add (no column to
    //     put it in) is noted and the run goes on.
    if (!noToken) {
      const cands = addCandidates(snap.lists, started.getTime());
      const have = new Set();
      for (let i = 0; i < cands.length; i += 100) {
        const ids = cands.slice(i, i + 100).map((r) => String(r.schoology_id));
        for (const it of (await npCall('items', { schoology_ids: ids }))?.items || []) have.add(String(it.source_id));
      }
      for (const r of cands.filter((c) => !have.has(String(c.schoology_id))).slice(0, ADD_CAP)) {
        snap.requests.neoplan++;
        const res = await np('addItem', {
          item: {
            schoology_id: String(r.schoology_id),
            section_id: sectionForRealm(r.realm),
            title: r.title,
            due_at: r.due || null,
            source_url: client.abs(`/assignment/${r.schoology_id}`),
          },
        });
        if (res.ok) snap.counts.added++;
        else if (res.status === 401) throw new NeoplanError('addItem', res);
        else snap.errors.push(`add ${r.schoology_id}: ${res.status || res.data?.error || 'network'}`);
      }
    }

    // 6. Submission status, only for what neo-plan still has open, oldest-checked first.
    //    Skipped entirely with no token: there is no neo-plan "open" list to check against.
    if (!noToken) {
      const open = (await npCall('open'))?.assignments || [];
      snap.counts.open = open.length;
      const nowMs = started.getTime();
      const pick = pickForStatus(open, stored, STATUS_CAP, STATUS_MIN_AGE_MS, nowMs);
      for (const id of pick) {
        let st;
        try {
          const r = await get(`/assignment/${id}/info`, 'status', { noRedirect: true });
          st = r.redirected ? { state: 'unknown', redirected: true } : r.data;
        } catch (e) {
          if (e instanceof LoginError || e instanceof RateLimitError || e?.name === 'StoppedError' || e?.name === 'AbortError') throw e;
          snap.errors.push(`status ${id}: ${e.message || e}`);
          continue;
        } finally {
          stored[id] = nowMs;
        }
        snap.counts.checked++;
        if (st.redirected || st.quiz) { snap.counts.redirected++; continue; } // a quiz or an external tool: recorded, skipped
        if (st.state === 'unknown') continue;
        const it = itemFor('assignment', id, snap.sectionOf[id] || null);
        it.submission = { state: st.state };
        if (st.state === 'submitted') {
          snap.counts.submitted++;
          if (typeof st.late === 'boolean') it.submission.late = st.late;
        }
      }
      const openSet = new Set(open.map(String));
      for (const id of Object.keys(stored)) if (!openSet.has(id)) delete stored[id];
    }

    // 7. One enrich. Items that carry nothing the server could use are left out.
    //    Skipped entirely with no token: nothing to enrich.
    if (!noToken) {
      const payload = {
        fetched_at: fetchedAt,
        courses: courses.map(({ section_id, title, section_title }) => ({ section_id, title, section_title })),
        items: [...items.values()].filter((i) => i.section_id || i.submission || i.gradebook),
      };
      snap.counts.items = payload.items.length;
      for (const i of payload.items) if (i.kind === 'assignment' && i.section_id) snap.sectionOf[i.schoology_id] = i.section_id;
      const res = await npCall('enrich', { body: payload });
      for (const r of res?.results || []) for (const d of r.did || []) snap.did[d] = (snap.did[d] || 0) + 1;
      const mapped = new Map((res?.courses || []).map((c) => [String(c.section_id), c]));
      for (const row of snap.courses) {
        const m = mapped.get(row.section_id);
        if (m) { row.class_id = m.class_id ?? null; row.auto = !!m.auto; }
      }
      snap.payload = payload; // the last thing sent, for the harness and for debugging
    }
    snap.neoplan = !noToken;
    snap.ok = true;
  } catch (e) {
    if (e instanceof LoginError) snap.error = 'login';
    else if (e instanceof NeoplanError) snap.error = e.code;
    else if (e?.name === 'StoppedError' || e?.name === 'AbortError') snap.error = 'stopped';
    else if (e instanceof RateLimitError) snap.error = 'ratelimit';
    else snap.error = 'schoology';
    snap.errors.push(String(e?.message || e));
    log(`sync stopped: ${e?.message || e}`);
  } finally {
    // A run that stopped before reading courses keeps the last known list, so
    // the overlays can still name a course.
    if (!snap.courses.length && prev?.courses?.length) { snap.courses = prev.courses; snap.coursesFrom = prev.at; }
    const keys = Object.keys(snap.sectionOf);
    if (keys.length > SECTION_MEMORY) for (const k of keys.slice(0, keys.length - SECTION_MEMORY)) delete snap.sectionOf[k];
    snap.finished_at = now().toISOString();
    await storage.set({ [KEY_SNAPSHOT]: snap, [KEY_CHECKED]: stored });
  }
  return snap;
}

/** The one-item enrich the assignment page sends when it sees "submitted". */
export function submittedPayload({ schoology_id, late, section_id }, fetchedAt) {
  const submission = { state: 'submitted' };
  if (typeof late === 'boolean') submission.late = late;
  return {
    fetched_at: fetchedAt,
    courses: [],
    items: [{ kind: 'assignment', schoology_id: String(schoology_id), section_id: section_id || null, submission }],
  };
}
