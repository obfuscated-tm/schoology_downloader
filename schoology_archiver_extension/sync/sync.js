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
import { sectionsByRealm, realmKey, isAssessmentUrl } from '../reader/parse/sync.js';

export const STATUS_CAP = 40;
export const KEY_SNAPSHOT = 'syncSnapshot';
export const KEY_CHECKED = 'syncStatusChecked'; // { schoology_id: last checked ms }
const SECTION_MEMORY = 3000; // assignment → section pairs kept for submit detection

class NeoplanError extends Error {
  constructor(op, r) {
    super(`neo-plan ${op}: ${r.status || r.data?.error || 'network'}`);
    this.op = op;
    this.status = r.status;
    this.code = r.status === 401 ? 'token' : 'neoplan';
  }
}

const ID_RE = /^\d{1,20}$/;

/** Open ids, least recently checked first, at most `cap`. Pure. */
export function pickForStatus(openIds, checked, cap = STATUS_CAP) {
  const ids = [...new Set((openIds || []).map(String).filter((x) => ID_RE.test(x)))];
  return ids
    .map((id, i) => ({ id, i, t: Number(checked?.[id]) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, cap)
    .map((x) => x.id);
}

export async function runSync({ client, parse, np, storage, now = () => new Date(), log = () => {} }) {
  const started = now();
  const fetchedAt = started.toISOString();
  const prev = (await storage.get(KEY_SNAPSHOT))[KEY_SNAPSHOT] || null;
  const snap = {
    at: fetchedAt,
    finished_at: null,
    ok: false,
    error: null, // null | 'login' | 'token' | 'neoplan' | 'schoology' | 'stopped'
    mode: null,
    counts: { courses: 0, upcoming: 0, overdue: 0, events: 0, gradebooks: 0, gradebook_rows: 0, missing: 0, open: 0, checked: 0, submitted: 0, redirected: 0, items: 0 },
    requests: { schoology: 0, neoplan: 0 },
    did: {},
    courses: [],
    errors: [],
    sectionOf: { ...(prev?.sectionOf || {}) },
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
    // 1. neo-plan's course map first: no token means no Schoology request at all.
    const map = await npCall('courses');
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
      for (const r of rows) itemFor('assignment', r.schoology_id, sectionForRealm(r.realm));
    }

    // 4. Upcoming events.
    const events = (await get('/home/upcoming_ajax', 'events')).data;
    snap.counts.events = events.length;
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
        if (e instanceof LoginError || e?.name === 'StoppedError' || e?.name === 'AbortError') throw e;
        row.gradebook = 'error';
        snap.errors.push(`gradebook ${c.section_id}: ${e.message || e}`);
      }
    }

    // 6. Submission status, only for what neo-plan still has open, oldest-checked first.
    const open = (await npCall('open'))?.assignments || [];
    snap.counts.open = open.length;
    const pick = pickForStatus(open, stored, STATUS_CAP);
    const nowMs = started.getTime();
    for (const id of pick) {
      let st;
      try {
        const r = await get(`/assignment/${id}/info`, 'status', { noRedirect: true });
        st = r.redirected ? { state: 'unknown', redirected: true } : r.data;
      } catch (e) {
        if (e instanceof LoginError || e?.name === 'StoppedError' || e?.name === 'AbortError') throw e;
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

    // 7. One enrich. Items that carry nothing the server could use are left out.
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
    snap.ok = true;
    snap.payload = payload; // the last thing sent, for the harness and for debugging
  } catch (e) {
    if (e instanceof LoginError) snap.error = 'login';
    else if (e instanceof NeoplanError) snap.error = e.code;
    else if (e?.name === 'StoppedError' || e?.name === 'AbortError') snap.error = 'stopped';
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
