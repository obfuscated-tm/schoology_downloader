import { cleanText } from '../../util.js';
import { resolveUrl } from '../md.js';

export function parseAssignment(doc, client, finalUrl = '') {
  const main = doc.querySelector('#main-inner') || doc;
  const due = cleanText(main.querySelector('.assignment-details .due-date, p.due-date')).replace(/^Due:?\s*/i, '');
  const body = main.querySelector('.info-body');
  const attachments = [];
  const seen = new Set();
  for (const a of main.querySelectorAll('.attachments a[href]')) {
    if (a.closest('#right-column')) continue;
    const href = a.getAttribute('href');
    if (a.classList.contains('view-file-popup') || /\/docviewer/.test(href)) continue;
    const url = client.abs(href);
    if (seen.has(url)) continue;
    seen.add(url);
    attachments.push({ href, url, title: cleanText(a) || 'attachment' });
  }
  const dropbox = doc.querySelector('a[href*="/dropbox/view/"]');
  const tabs = [...doc.querySelectorAll('ul.tabs a[href]')].map((a) => ({ text: cleanText(a), href: a.getAttribute('href') }));
  // Assignment-based Test/Quiz: has "My Submissions" (/assessment_view) and "Test/Quiz" (/assessment) tabs.
  // We only ever read /assessment_view. /assessment is the quiz-taking page and must never be opened.
  const isQuiz = tabs.some((t) => /\/assessment$/.test(t.href.split('?')[0]) || /test\/quiz/i.test(t.text));
  // External-tool (LTI) assignments redirect to /assignments/ID/info and have no Schoology instructions.
  const isExternalTool = /\/assignments\/\d+/.test(finalUrl) || (!body && !!doc.querySelector('a[href*="external_tool"]'));
  return {
    due,
    bodyEl: body,
    attachments,
    isQuiz,
    isExternalTool,
    dropboxUrl: dropbox ? client.abs(dropbox.getAttribute('href').replace(/\?.*$/, '')) : null,
  };
}

// One revision of a submission. Files show up in three ways:
//  - a "Download File" link:           /submission/ID/source
//  - a document viewer iframe:         /submission/ID/docviewer  (file path inside its HTML)
//  - an audio/video player iframe:     /submission/ID/mediaplayer (converted video inside its HTML)
export function parseDropbox(doc, client) {
  const w = doc.querySelector('#dropbox-viewer-wrapper') || doc;
  const revisions = [...w.querySelectorAll('#dropbox-viewer-revision-select option')]
    .map((o) => Number(o.value))
    .filter((n) => Number.isInteger(n) && n > 0);
  const grade = cleanText(w.querySelector('.grading-grade')).replace(/^Grade:\s*/i, '');
  const comments = [...w.querySelectorAll('#dropbox-viewer-comments .comment')].map((c) => ({
    author: cleanText(c.querySelector('.comment-author')),
    text: cleanText(c.querySelector('.comment-body-wrapper')),
  })).filter((c) => c.text);
  const viewers = [...w.querySelectorAll('iframe[src*="/submission/"]')]
    .map((f) => client.abs(f.getAttribute('src')));
  const names = {};
  for (const item of w.querySelectorAll('.dropbox-viewer-item-wrapper, .dropbox-viewer-item')) {
    const a = item.querySelector('a[href*="/submission/"]');
    const id = a && (a.getAttribute('href').match(/\/submission\/(\d+)/) || [])[1];
    const name = cleanText(item.querySelector('.file-name a, .file-name'))?.replace(/\s*\d+(\.\d+)?\s*[KMG]?B$/i, '');
    if (id && name) names[id] = name;
  }
  const directFiles = [...w.querySelectorAll('a[href*="/submission/"][href*="/source"]')]
    .map((a) => client.abs(a.getAttribute('href')));
  const links = [...w.querySelectorAll('a[href*="/link?"]')]
    .map((a) => ({ title: cleanText(a), url: resolveUrl(a.getAttribute('href'), client.origin) }));
  return { revisions, grade, comments, viewers, directFiles, names, links };
}

// Viewer pages embed the file path in (multiply) escaped JSON, e.g. \\\/submission\\\/ID\\\/source\\\/HASH.ext
// or \\\/submission\\\/ID\\\/conversion\\\/h264 for recorded audio/video.
export function findSubmissionSources(html, client) {
  const found = new Set();
  const re = /\\*\/submission\\*\/(\d+)\\*\/(source|conversion)\\*\/([A-Za-z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(html))) found.add(client.abs(`/submission/${m[1]}/${m[2]}/${m[3]}`));
  return [...found];
}

export function submissionId(url) {
  return (url.match(/\/submission\/(\d+)/) || [])[1] || url;
}
