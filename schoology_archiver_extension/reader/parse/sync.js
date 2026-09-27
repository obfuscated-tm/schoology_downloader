// Parsers for the light sync and the overlays: courses, the home page's
// upcoming/overdue submission lists, the gradebook's rows, an assignment's
// submission status, upcoming events, and the assignment page itself.
// Pure: (doc | text) → plain data. Selectors are the ones measured in
// neo-plan's docs/schoology-endpoints.md. Nothing outside reader/ knows them.
//
// Every parser reports what it can see and nothing more: "missing" is true or
// null (can't tell), never false; a status it can't read is "unknown".

import { cleanText } from '../../util.js';

const ASSIGNMENT_RE = /\/assignment\/(\d+)(?:[/?#]|$)/;
const EVENT_RE = /\/event\/(\d+)\/profile(?:[/?#]|$)/;
const COURSE_RE = /^\/course\/(\d+)(?:[/?#]|$)/;

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Parse a JSON body, or pass an object through. Null when it isn't JSON. */
export function asJson(textOrObj) {
  if (textOrObj && typeof textOrObj === 'object') return textOrObj;
  try { return JSON.parse(textOrObj); } catch { return null; }
}

/** The html inside a `{ html }` (home lists) or `{ output }` (feed) wrapper. */
export function wrappedHtml(text) {
  const j = asJson(text);
  if (j && typeof j === 'object') return String(j.html ?? j.output ?? '');
  return String(text ?? '');
}

// ── Courses: GET /iapi/course/active ─────────────────────────────────────

/** → [{ section_id, title, section_title }] — every section, class or not. */
export function parseCourses(textOrObj) {
  const j = asJson(textOrObj);
  const box = j?.body?.courses ?? j?.courses ?? {};
  const sections = Array.isArray(box.sections) ? box.sections : [];
  const courses = Array.isArray(box.courses) ? box.courses : [];
  const titleOf = new Map(courses.map((c) => [String(c?.nid), squash(c?.course_title ?? c?.title)]));
  const out = [];
  const seen = new Set();
  for (const s of sections) {
    const id = String(s?.nid ?? '');
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      section_id: id,
      title: titleOf.get(String(s.course_nid)) || squash(s.course_title ?? s.title),
      section_title: squash(s.section_title),
    });
  }
  return out;
}

/** "Course title : Section title" → section_id, as the home lists name a realm. */
export function realmKey(s) {
  return squash(s).toLowerCase();
}
export function sectionsByRealm(courses) {
  const m = new Map();
  for (const c of courses || []) m.set(realmKey(`${c.title} : ${c.section_title}`), c.section_id);
  return m;
}

// ── Home lists: /home/upcoming_submissions_ajax, /home/overdue_submissions_ajax ──

/** data-start → ISO. Schoology writes a unix time (seconds); ms is tolerated. */
export function startToIso(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{9,13}$/.test(s)) return null;
  const n = Number(s);
  const d = new Date(s.length > 11 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The submission rows under `root` (a parsed ajax doc, the live /home page, or
 * a course page's Upcoming column). Each: { el, schoology_id, realm, title,
 * due }. `el` is the row element, for the overlay to sit beside; the sync
 * drops it. An id is listed once, unless `everyRow`: the live page can show
 * one assignment in more than one list (and in the "N more overdue" popup),
 * and the overlay marks each of them.
 */
export function homeRowsIn(root, { everyRow = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of root.querySelectorAll('.upcoming-event')) {
    const a = [...row.querySelectorAll('a[href]')].find((x) => ASSIGNMENT_RE.test(x.getAttribute('href')));
    if (!a) continue;
    const id = a.getAttribute('href').match(ASSIGNMENT_RE)[1];
    if (!everyRow && seen.has(id)) continue;
    seen.add(id);
    const startEl = row.hasAttribute('data-start') ? row : row.querySelector('[data-start]');
    const due = startToIso(startEl?.getAttribute('data-start'));
    const realm = cleanText(row.querySelector('.realm-title-course'));
    out.push({ el: row, schoology_id: id, realm, title: cleanText(a), ...(due ? { due } : {}) });
  }
  return out;
}

/**
 * The assignment rows of a course's Materials page (table#folder-contents-table,
 * as reader/parse/materials.js reads it). Each: { el, tr, schoology_id,
 * section_id, title, due? }. `el` is the row's title element, for the overlay
 * to sit after; `tr` the whole row. A folder Schoology opened in place (its ›)
 * shows its rows in a table inside the folder's row: those are left out
 * unless `nested`. Newer quizzes (/assessments/) are not assignments and are left out.
 */
export function materialRowsIn(root, url = '', { nested = false } = {}) {
  let section = null;
  try { section = (new URL(url, 'https://x.schoology.com').pathname.match(COURSE_RE) || [])[1] || null; } catch { /* no section */ }
  const out = [];
  const seen = new Set();
  const table = root.querySelector('table#folder-contents-table');
  if (!table) return out;
  for (const tr of table.querySelectorAll('tr.dr')) {
    if (tr.classList.contains('material-row-folder')) continue; // a folder opened in place holds rows of its own
    if (!nested && tr.closest('table') !== table) continue;
    const a = ownLink(tr, '.item-title a[href]');
    const m = (a?.getAttribute('href') || '').match(ASSIGNMENT_RE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    // "Due Monday, August 31, 2026 at 11:59 pm" is in .item-subtitle on the live
    // page; older markup had it in .item-body.
    const due = parseDueText(cleanText(tr.querySelector('.item-subtitle')) || '') || parseDueText(cleanText(tr.querySelector('.item-body')) || '');
    out.push({ el: a.closest('.item-title') || a.parentElement, tr, schoology_id: m[1], section_id: section, title: cleanText(a), ...(due ? { due } : {}) });
  }
  return out;
}

/** The first `sel` in this row itself, not in a folder opened in place inside it. */
function ownLink(tr, sel) {
  return [...tr.querySelectorAll(sel)].find((a) => a.closest('tr') === tr) || null;
}

/** The f= of a folder link (/course/{id}/materials?f={folder}), or null. */
export function folderIdOf(href) {
  try { return new URL(href, 'https://x.schoology.com').searchParams.get('f') || null; } catch { return null; }
}

/**
 * The folder rows of a Materials page or folder (the same table, with the
 * selectors reader/parse/materials.js uses). Each: { tr, el, folder_id, title }.
 * `el` is the folder's title element, for the overlay to sit in. Folders
 * inside a folder opened in place are left out unless `nested`.
 */
export function folderRowsIn(root, { nested = false } = {}) {
  const out = [];
  const table = root.querySelector('table#folder-contents-table');
  if (!table) return out;
  for (const tr of table.querySelectorAll('tr.material-row-folder')) {
    if (!nested && tr.closest('table') !== table) continue;
    const a = ownLink(tr, '.folder-title a[href]');
    const id = folderIdOf(a?.getAttribute('href'));
    if (!id) continue;
    out.push({ tr, el: a.closest('.folder-title') || a.parentElement, folder_id: id, title: cleanText(a) });
  }
  return out;
}

/**
 * Every row of the table, those of folders opened in place included:
 * { tr, kind: 'folder' | 'assignment' | 'other', id }. `id` is the folder's
 * f= or the assignment's id (null for the rest).
 */
export function materialTableRows(root) {
  const table = root.querySelector('table#folder-contents-table');
  if (!table) return [];
  const out = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (!/\b(dr|material-row-folder)\b/.test(tr.className || '')) continue;
    if (tr.classList.contains('material-row-folder')) {
      out.push({ tr, kind: 'folder', id: folderIdOf(ownLink(tr, '.folder-title a[href]')?.getAttribute('href')) });
      continue;
    }
    const m = (ownLink(tr, '.item-title a[href]')?.getAttribute('href') || '').match(ASSIGNMENT_RE);
    out.push({ tr, kind: m ? 'assignment' : 'other', id: m ? m[1] : null });
  }
  return out;
}

export function parseHomeList(doc) {
  return homeRowsIn(doc).map(({ el, ...r }) => r);
}

// ── /home/assignments: the Upcoming / Recent / Missing list ──────────────
// A newer view: each row is a clickable <div> with no link, labelled
// "Assignment: {title} for {course} with category {category}". Its data comes
// from /v2/events/{upcoming,recent,overdue} (JSON-LD: the assignments, their
// sections and courses, all in @extra), which is where the ids are.

export const EVENT_LISTS = ['upcoming', 'recent', 'overdue'];

const ASSESSMENT_URL_RE = /\/course\/\d+\/assessments\/(\d+)(?:[/?#]|$)/;
const lastId = (u) => (String(u || '').match(/(\d+)\/?$/) || [])[1] || null;

/**
 * /v2/events/{list} JSON → [{ schoology_id, title, course, section_id, due, graded }].
 * What links to /assignment/{id}, and newer quizzes, which link to
 * /course/{c}/assessments/{id}: the same id the To Do column links as
 * /assignment/{id} (seen 2026-09-26). `course` is the course's title, as the
 * row says it.
 */
export function parseEventsJson(textOrObj) {
  const j = asJson(textOrObj);
  const extra = Array.isArray(j?.['@extra']) ? j['@extra'] : [];
  const byId = new Map(extra.map((e) => [e?.['@id'], e]));
  const out = [];
  const seen = new Set();
  for (const e of extra) {
    const m = String(e?.url || '').match(ASSIGNMENT_RE) || String(e?.url || '').match(ASSESSMENT_URL_RE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const sectionRef = e['@links']?.parent?.['@id'] || null;
    const section = byId.get(sectionRef);
    const course = byId.get(section?.['@links']?.course?.['@id']); // an assignment's section links its course as `course`
    out.push({
      schoology_id: m[1],
      title: squash(e.title),
      course: squash(course?.title),
      section_id: lastId(sectionRef),
      due: e.dueDateInUTCISO || null,
      graded: e.studentGrade?.grade != null, // the row shows the grade itself
    });
  }
  return out;
}

const CARD = '.mfe-sgy-assignments-detail-view-assignment-details';

/**
 * The rows of the /home/assignments list: [{ el, titleEl, title, course }].
 * `el` is the flex cell holding the title (the overlay sits at its end),
 * `titleEl` the title itself.
 */
export function assignmentCardsIn(root) {
  const out = [];
  for (const card of root.querySelectorAll(CARD)) {
    const titleEl = card.querySelector('.mfe-sgy-assignments-detail-view-assignment-title-text');
    const title = squash(titleEl?.getAttribute('title') || titleEl?.textContent);
    if (!title) continue;
    const label = squash(card.getAttribute('aria-label'));
    const after = label.slice(label.indexOf(`${title} for `) + title.length + 5);
    const course = label.includes(`${title} for `) ? after.replace(/\s+with category\b.*$/, '').trim() : '';
    out.push({ el: titleEl.parentElement, titleEl, title, course });
  }
  return out;
}

// ── Upcoming events: /home/upcoming_ajax ─────────────────────────────────

export function parseUpcomingEvents(doc) {
  const out = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/event/"]')) {
    const m = a.getAttribute('href').match(EVENT_RE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const row = a.closest('.upcoming-event') || a.parentElement;
    out.push({ schoology_id: m[1], realm: cleanText(row?.querySelector('.realm-title-course')) });
  }
  return out;
}

// ── Gradebook: /course/{id}/student_grades ───────────────────────────────

/**
 * → [{ schoology_id, missing: true | null }]. `missing` is true only when the
 * row visibly says so (the word "Missing" outside the title, or a class with
 * "missing" in it). Never false: no missing marker has been seen yet, so its
 * absence proves nothing.
 */
export function parseGradebookRows(doc) {
  const out = [];
  const seen = new Set();
  for (const tr of doc.querySelectorAll('tr.item-row[data-id]')) {
    const m = (tr.getAttribute('data-id') || '').match(/^I-(\d+)$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ schoology_id: m[1], missing: rowSaysMissing(tr) ? true : null });
  }
  return out;
}

function rowSaysMissing(tr) {
  if (/\bmissing\b/i.test(tr.getAttribute('class') || '')) return true;
  if (tr.querySelector('[class*="missing"], [class*="Missing"]')) return true;
  // The word itself, anywhere but the title cell (a title may say "missing").
  for (const cell of tr.querySelectorAll('td')) {
    if (cell.matches('.title-column') || cell.querySelector('.title')) continue;
    if (/\bmissing\b/i.test(cell.textContent || '')) return true;
  }
  return false;
}

// ── Submission status: /assignment/{id}/info ─────────────────────────────

/** A page Schoology sent us to instead of the assignment: a newer quiz. */
export function isAssessmentUrl(url) {
  try { return /\/assessments?\//.test(new URL(url, 'https://x.schoology.com').pathname); } catch { return false; }
}

/**
 * → { state: 'submitted' | 'not_submitted' | 'no_dropbox' | 'unknown', late?, quiz? }
 * Only a dropbox can say "submitted"; most work has none, and then Schoology
 * never knows. A quiz (the page redirected to /assessments/) is unknown.
 */
export function parseSubmissionStatus(doc, finalUrl = '') {
  if (isAssessmentUrl(finalUrl)) return { state: 'unknown', quiz: true };
  const status = doc.querySelector('.submission-status');
  const view = doc.querySelector('a[href*="/dropbox/view/"]');
  if (status || (view && /submitted/i.test(cleanText(view)))) {
    const out = { state: 'submitted' };
    if (status) out.late = status.classList.contains('late');
    return out;
  }
  const submit = doc.querySelector('a.dropbox-submit');
  const label = cleanText(submit);
  if (submit && /\bsubmit assignment\b/i.test(label) && !/re-?\s*submit/i.test(label)) return { state: 'not_submitted' };
  return { state: 'no_dropbox' };
}

// ── The assignment page itself (for the overlay) ─────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "Due Friday, September 26, 2026 at 11:59 pm" (or "Sep 26, 2026 11:59pm") →
 * ISO, read in the browser's own zone. Null unless every part is there: a date
 * without a year or a time is not reliable enough to send.
 */
export function parseDueText(text) {
  const t = squash(text);
  const m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap])\.?m\.?(?![a-z])/i);
  if (!m) return null;
  let h = Number(m[4]);
  const min = Number(m[5]);
  if (h < 1 || h > 12 || min > 59) return null;
  if (m[6].toLowerCase() === 'p' && h !== 12) h += 12;
  if (m[6].toLowerCase() === 'a' && h === 12) h = 0;
  const d = new Date(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]), h, min);
  if (d.getDate() !== Number(m[2])) return null; // Feb 31 and friends
  return d.toISOString();
}

/** The id in /assignment/{id}/…, or null. */
export function assignmentIdOf(url) {
  try { return (new URL(url, 'https://x.schoology.com').pathname.match(/^\/assignment\/(\d+)(?:\/|$)/) || [])[1] || null; } catch { return null; }
}

/**
 * What the overlay needs from an assignment page: { schoology_id, title,
 * section_id, due_at, anchor }. `anchor` is the title element (null when not
 * found; the overlay then floats). section_id comes only from a course link in
 * the page's own header/breadcrumb, never the site-wide menus.
 */
export function parseAssignmentPage(doc, url) {
  const top = doc.querySelector('#center-top') || doc.querySelector('#main-inner') || null;
  const anchor = doc.querySelector('#center-top .page-title, #center-top h2, h2.page-title');
  let section = null;
  for (const scope of [doc.querySelector('.breadcrumb, .breadcrumbs'), top]) {
    if (!scope || section) continue;
    for (const a of scope.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(COURSE_RE);
      if (m) { section = m[1]; break; }
    }
  }
  const dueEl = doc.querySelector('.assignment-details .due-date, p.due-date');
  const title = cleanText(anchor) || squash((doc.querySelector('title')?.textContent || '').split(' | ')[0]);
  return {
    schoology_id: assignmentIdOf(url),
    title,
    section_id: section,
    due_at: dueEl ? parseDueText(dueEl.textContent) : null,
    anchor,
  };
}

// ── One entry point for text that arrives over the wire (the offscreen parser) ──

const DOC_KINDS = new Set(['homeList', 'events', 'gradebook', 'status']);

/** Pages Schoology serves when the session has ended. */
export function isLoginPage(doc) {
  return !!doc.querySelector('form#s-user-login-form, #login-container');
}

/**
 * kind + response text → plain, structured-cloneable data. Needs a global
 * DOMParser (the offscreen document, a page, or the harness's linkedom).
 * Returns { login: true } for a sign-in page.
 */
export function parseKind(kind, text, url = '') {
  if (kind === 'courses') {
    const j = asJson(text);
    if (j) return { data: parseCourses(j) };
    if (/s-user-login-form|login-container/.test(String(text))) return { login: true };
    throw new Error('course list was not JSON');
  }
  if (!DOC_KINDS.has(kind)) throw new Error(`unknown parse kind: ${kind}`);
  const html = kind === 'homeList' || kind === 'events' ? wrappedHtml(text) : String(text ?? '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (isLoginPage(doc)) return { login: true };
  if (kind === 'homeList') return { data: parseHomeList(doc) };
  if (kind === 'events') return { data: parseUpcomingEvents(doc) };
  if (kind === 'gradebook') return { data: parseGradebookRows(doc) };
  return { data: parseSubmissionStatus(doc, url) };
}
