// Change tracking so a re-archive of a course can skip opening a detail page
// when nothing about it has changed, instead of re-fetching every folder,
// document, assignment and dropbox revision on every run.
//
// Two independent signals:
//  - rowSignature: what the folder list itself shows for a row (cheap — the
//    folder page is already fetched every run to list its rows).
//  - eventChangeKeys: a hash of what /v2/events/{upcoming,overdue} says about
//    an assignment (title, description, due date, points, category,
//    submitted state). The "@cache.etag" Schoology sends is folded in too,
//    but never trusted alone — we could not confirm it changes on a teacher
//    edit, only that it's stable across repeated requests.
// shouldSkip combines both (plus how long ago the detail page was actually
// opened) into the one decision the archiver needs before each doX call.

import { asJson } from './parse/sync.js';
import { sha256 } from '../util.js';

const ASSIGNMENT_RE = /\/assignment\/(\d+)(?:[/?#]|$)/;

// A stable string built from what the folder row shows — title, url, and
// (for documents) every file and link. Two rows with the same signature
// looked identical in the folder listing on this run and the last one.
// Pure, synchronous: a plain fingerprint, not a hash (nothing here needs it
// to be short or opaque).
export function rowSignature(row) {
  const parts = [row.kind, row.title || '', row.url || '', row.rowText || ''];
  for (const f of row.files || []) parts.push('file', f.url || '', f.filename || '', f.title || '');
  for (const l of row.links || []) parts.push('link', l.href || '', l.url || '', l.title || '');
  if (row.otherUrl) parts.push('other', row.otherUrl);
  if (row.externalTool) parts.push('externalTool');
  return parts.join('\u0001');
}

// /v2/events/{upcoming,overdue} JSON → Map<assignmentId, changeKey>.
// changeKey = sha256(etag + title + description + due + maxPoints + category + submitted).
// `submitted` is included on purpose: a new submission means the dropbox page
// has new content (files/comments) to archive, even if nothing else changed.
export async function eventChangeKeys(textOrObj) {
  const j = asJson(textOrObj);
  const extra = Array.isArray(j?.['@extra']) ? j['@extra'] : [];
  const map = new Map();
  for (const e of extra) {
    const url = String(e?.url || '');
    const m = url.match(ASSIGNMENT_RE);
    if (!m) continue;
    const etag = e?.['@cache']?.etag || '';
    const parts = [etag, e.title, e.description, e.dueDateInUTCISO, e.maxPoints, e.category, e.submitted]
      .map((v) => (v == null ? '' : String(v)));
    map.set(m[1], await sha256(parts.join('\u0001')));
  }
  return map;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Whether an item's detail pages can be skipped on this run, reusing what was
// saved last time. Pure: every input the caller already has in hand.
//   stored: this.manifest.items[row.key] from the previous run (or undefined)
//   sig: rowSignature(row) for the current run
//   kind: row.kind
//   assignmentId: the assignment id (only for kind === 'assignment'), else null
//   eventKeys: Map<assignmentId, changeKey> from eventChangeKeys, for this run
//   eventsAvailable: false if the /v2/events fetch failed this run
//   now: Date.now() (or a fixed number, for tests)
//   redownloadAll: the "re-check every page" option
export function shouldSkip({ stored, row, sig, kind, assignmentId, eventKeys, eventsAvailable, now, redownloadAll }) {
  if (redownloadAll) return false;
  if (!stored || stored.ok !== true || !stored.entry) return false;
  if (stored.sig !== sig) return false;
  const checkedAt = Date.parse(stored.checkedAt || '');
  if (Number.isNaN(checkedAt)) return false;
  const age = now - checkedAt;

  if (kind === 'assignment') {
    if (assignmentId && eventKeys && eventKeys.has(assignmentId)) {
      return stored.changeKey === eventKeys.get(assignmentId);
    }
    // Not upcoming/overdue (past or undated): rare edits, weekly re-check —
    // but only when we actually know it's absent from the events lists.
    if (eventsAvailable) return age < WEEK_MS;
    // Events unreadable this run: fall back to a tighter, daily re-check.
    return age < DAY_MS;
  }
  // Document / link / page / discussion / quiz / other: the row signature
  // already catches added/renamed/removed files and links; re-check weekly
  // for changes to the page body itself.
  return age < WEEK_MS;
}
