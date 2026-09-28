// Quiz quiet mode: while any Schoology tab is on a Test/Quiz page, the
// extension does nothing in the background — no sync (alarm or tab-load), no
// MCP bridge, no archive. background.js checks `quizTabOpen()` before each of
// those and stops everything when a tab enters a quiz page; the content
// scripts are kept off these pages by the manifest's exclude_matches.
//
// "Quiz page" is deliberately broad: anything with "assessment" in the path
// (/assignment/ID/assessment, /assignment/ID/assessment_view/…,
// /course/ID/assessments/ID/…) plus the take/start/resume URLs
// reader/client.js's isQuizTakingUrl never fetches.

import { isQuizTakingUrl } from '../reader/client.js';

const SCHOOLOGY_RE = /^https:\/\/[a-z0-9-]+\.schoology\.com\//i;

/** Is `url` a Schoology Test/Quiz page (taking it, or its attempts/review)? */
export function isQuizPageUrl(url) {
  if (!url || !SCHOOLOGY_RE.test(url)) return false;
  try {
    return /assessment/i.test(new URL(url).pathname) || isQuizTakingUrl(url);
  } catch {
    return false;
  }
}

/**
 * Is any tab open on a quiz page? The archiver's own quiz-review tabs
 * (storage.session `reviewTabs`) don't count — those are its read-only
 * /assessment_view visits, not the student in a quiz.
 */
export async function quizTabOpen() {
  const tabs = await chrome.tabs.query({ url: 'https://*.schoology.com/*' }).catch(() => []);
  const { reviewTabs = [] } = await chrome.storage.session.get('reviewTabs').catch(() => ({}));
  const ours = new Set(reviewTabs);
  return tabs.some((t) => !ours.has(t.id) && (isQuizPageUrl(t.url) || isQuizPageUrl(t.pendingUrl)));
}
