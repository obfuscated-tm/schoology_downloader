// Pure pieces of the archive job's state, kept apart from background.js and
// offscreen/archive.js so they can run under `node --test` with no chrome.

export const OPTION_KEYS = ['google', 'submissions', 'quizzes', 'grades', 'updates', 'redownloadAll'];
export const DEFAULT_OPTIONS = { google: true, submissions: true, quizzes: true, grades: true, updates: true, redownloadAll: false };
export const MAX_LOG_LINES = 200;

/** A course id a content script sent us: digits only, never trusted as-is. */
export function isValidCourseId(id) {
  return /^\d{1,20}$/.test(String(id ?? ''));
}

/** Only the known boolean options, coerced — never whatever else a message carried. */
export function sanitizeOptions(input) {
  const out = { ...DEFAULT_OPTIONS };
  if (input && typeof input === 'object') {
    for (const k of OPTION_KEYS) if (k in input) out[k] = !!input[k];
  }
  return out;
}

/** Append one log line, keeping at most `max` (the oldest drop off first). */
export function appendLog(log, line, max = MAX_LOG_LINES) {
  const next = [...(log || []), line];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Fold one progress message from the offscreen job into the stored archive
 * state. Pure: callers persist the result themselves.
 */
export function reduceProgress(state, msg) {
  if (!state || state.jobId !== msg.jobId) return state;
  let next = state;
  if (msg.log) next = { ...next, log: appendLog(next.log, { text: String(msg.log), level: msg.level || '' }) };
  if (msg.count != null) next = { ...next, counts: msg.count };
  if (msg.status) next = { ...next, status: msg.status };
  if (msg.courseName) next = { ...next, courseName: msg.courseName };
  if (msg.done) {
    next = {
      ...next, running: false, finishedAt: Date.now(),
      error: msg.error || null, summary: msg.summary || null, stopped: !!msg.stopped,
    };
  }
  return next;
}
