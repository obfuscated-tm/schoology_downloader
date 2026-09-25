import { sleep, cleanText, extOf, throwIfStopped } from './util.js';
import { resolveUrl, htmlToMd } from './md.js';

const REQUEST_GAP_MS = 400; // be polite: one Schoology page every ~0.4s

export class LoginError extends Error {
  constructor() { super('Not logged in to Schoology in this browser'); }
}

// Fetches Schoology pages using your normal browser login.
// "direct" mode fetches from the extension page; if Schoology doesn't see the
// login cookie that way, it falls back to fetching from inside an open
// Schoology tab (same-origin, always has your session).
export class SchoologyClient {
  constructor({ host, tabId, log, signal }) {
    this.signal = signal;
    this.host = host;
    this.origin = `https://${host}`;
    this.tabId = tabId ? Number(tabId) : null;
    this.log = log;
    this.mode = 'direct';
    this.lastRequest = 0;
  }

  abs(u) { return new URL(u, this.origin).href; }

  async init(courseId) {
    const url = `${this.origin}/course/${courseId}/materials`;
    try {
      const res = await this.getDoc(url);
      this.verified = true;
      return res;
    } catch (e) {
      if (!(e instanceof LoginError) && !(e instanceof TypeError)) throw e;
    }
    const tabId = await this.findSchoologyTab();
    if (!tabId) throw new LoginError();
    this.mode = 'tab';
    this.tabId = tabId;
    this.log('Using your open Schoology tab to read pages (tab mode).');
    const res = await this.getDoc(url);
    this.verified = true;
    return res;
  }

  async findSchoologyTab() {
    if (this.tabId) {
      try {
        const t = await chrome.tabs.get(this.tabId);
        if (t.url && new URL(t.url).host === this.host) return t.id;
      } catch { /* tab closed */ }
    }
    const tabs = await chrome.tabs.query({ url: `${this.origin}/*` });
    return tabs[0]?.id ?? null;
  }

  async raw(url) {
    if (this.mode === 'direct') {
      const r = await fetch(url, { credentials: 'include', signal: this.signal });
      return { status: r.status, url: r.url, text: await r.text() };
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        return { status: r.status, url: r.url, text: await r.text() };
      },
      args: [url],
    });
    if (!res || !res.result) throw new Error('Could not read page through the Schoology tab (was it closed?)');
    return res.result;
  }

  async throttle() {
    const wait = this.lastRequest + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait, this.signal);
    this.lastRequest = Date.now();
  }

  // Returns { doc, url }. Throws LoginError / Error('HTTP ...').
  async getDoc(url) {
    const r = await this.getText(url);
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    if (doc.querySelector('form#s-user-login-form, #login-container')) throw new LoginError();
    return { doc, url: r.url };
  }

  async getText(url) {
    url = this.abs(url);
    if (isQuizTakingUrl(url)) throw new Error(`refused to open a quiz-taking page (${new URL(url).pathname})`);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfStopped(this.signal);
      await this.throttle();
      let r;
      try {
        r = await this.raw(url);
      } catch (e) {
        throwIfStopped(this.signal);
        // A redirect to Google sign-in shows up as a CORS TypeError.
        lastErr = e;
        if (e instanceof TypeError && !this.verified) throw e;
        await sleep(1500 * (attempt + 1), this.signal);
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`HTTP ${r.status}`);
        await sleep(3000 * (attempt + 1), this.signal);
        continue;
      }
      const final = new URL(r.url || url);
      if (final.host !== this.host || final.pathname.startsWith('/login')) throw new LoginError();
      if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${final.pathname}`);
      return { text: r.text, url: r.url || url };
    }
    throw lastErr || new Error('request failed');
  }
}

// VIEW ONLY safety net: pages that take/start/resume a quiz are never requested.
// /assignment/ID/assessment is the Test/Quiz "take" tab (/assessment_view is the read-only history).
export function isQuizTakingUrl(url) {
  const p = new URL(url).pathname;
  return /\/assessment\/?$/.test(p) || /\/assessment\/(start|take|resume|attempt|submit)/.test(p)
    || /\/(start|take|resume)[_-]?(attempt|assessment|quiz)/i.test(p);
}

// ── Parsing ──────────────────────────────────────────────────────────────

export function courseNameFrom(doc) {
  const t = (doc.querySelector('title')?.textContent || '').split(' | ')[0].trim();
  return t || null;
}

// Rows of a materials/folder page, classified.
export function parseFolderRows(doc, client) {
  const table = doc.querySelector('table#folder-contents-table');
  if (!table) return null;
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cls = tr.className || '';
    if (!/\bdr\b|material-row-folder/.test(cls)) continue;
    const key = tr.id || '';

    if (cls.includes('material-row-folder')) {
      const a = tr.querySelector('.folder-title a[href], a[href*="f="]');
      if (!a) continue;
      rows.push({ kind: 'folder', key: key || a.getAttribute('href'), title: cleanText(a), url: client.abs(a.getAttribute('href')) });
      continue;
    }

    const type = (cls.match(/type-([\w-]+)/) || [])[1] || 'unknown';
    const titleA = tr.querySelector('.item-title a[href]');
    const base = { type, key, rowText: cleanText(tr.querySelector('.item-body')) };

    if (type === 'document') {
      const files = [...tr.querySelectorAll('.attachments-file-name a[href]')].map((a) => {
        const tip = a.querySelector('.infotip-content');
        const filename = tip ? tip.textContent.trim() : cleanText(a);
        let title = filename;
        const infotip = a.querySelector('.infotip');
        if (infotip) {
          const c = infotip.cloneNode(true);
          c.querySelectorAll('.infotip-content').forEach((n) => n.remove());
          title = cleanText(c) || filename;
        }
        return { url: client.abs(a.getAttribute('href')), title, filename };
      });
      const links = [...tr.querySelectorAll('.attachments-link a[href]')].map((a) => ({
        href: a.getAttribute('href'),
        url: client.abs(a.getAttribute('href')),
        title: cleanText(a),
      }));
      const other = [...tr.querySelectorAll('.item-body a[href]')].filter(
        (a) => !a.closest('.attachments-file-name, .attachments-link')
      );
      const title = files[0]?.title || links[0]?.title || cleanText(titleA) || cleanText(other[0]) || 'Untitled';
      rows.push({
        ...base, kind: 'document', title, files, links,
        externalTool: !!tr.querySelector('.attachments-external-tool'),
        otherUrl: !files.length && !links.length && other[0] ? client.abs(other[0].getAttribute('href')) : null,
        key: key || files[0]?.url || links[0]?.url || title,
      });
      continue;
    }

    const a = titleA || tr.querySelector('.item-info a[href]');
    if (!a) continue;
    const href = a.getAttribute('href');
    let kind = 'other';
    if (/\/assignment\/\d+/.test(href)) kind = 'assignment';
    else if (/assessment/.test(href) || /assessment/.test(type)) kind = 'quiz';
    else if (/\/page\/\d+/.test(href)) kind = 'page';
    else if (/\/discussion\/\d+/.test(href)) kind = 'discussion';
    rows.push({ ...base, kind, title: cleanText(a) || 'Untitled', url: client.abs(href), key: key || href });
  }
  return rows;
}

// Main content area of a Schoology page, without navigation chrome.
export function contentRoot(doc) {
  const root = (doc.querySelector('#center-inner') || doc.querySelector('#main-inner') || doc.body).cloneNode(true);
  root.querySelectorAll(
    '#center-top, script, style, form, .s-tinymce-hidden-form, #right-column, .course-material-navigator, ' +
    '.lesson-plan-wrapper, .visually-hidden, .edit-post-btn, .action-links, .like-btn, .s-like-sentence'
  ).forEach((n) => n.remove());
  return root;
}

// On a /materials/gp/ID file viewer: the real file(s) at /attachment/ID/source/HASH.ext
export function findSourceAttachments(doc, client) {
  const root = contentRoot(doc);
  const seen = new Set();
  const out = [];
  for (const el of root.querySelectorAll('a[href*="/attachment/"], img[src*="/attachment/"]')) {
    const raw = el.getAttribute('href') || el.getAttribute('src');
    if (!/\/source\//.test(raw)) continue;
    const u = new URL(raw, client.origin);
    if (seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    out.push({ url: u.href, fingerprint: u.pathname, ext: extOf(u.pathname) });
  }
  return out;
}

// /course/X/materials/link/view/ID wraps an external site in an iframe.
export function findLinkViewTarget(doc, client) {
  const root = contentRoot(doc);
  const iframe = [...root.querySelectorAll('iframe[src]')].find((f) => !/schoology\.com/.test(new URL(f.getAttribute('src'), client.origin).host));
  if (iframe) return resolveUrl(iframe.getAttribute('src'), client.origin);
  const a = root.querySelector('a[href*="/link?"], a.ext[href^="http"]');
  return a ? resolveUrl(a.getAttribute('href'), client.origin) : null;
}

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

// ── Quizzes ──────────────────────────────────────────────────────────────

// Newer "common assessment" quizzes (/course/X/assessments/Y) embed their data as
// JSON: {"initialization": {title, instructions, score, pointsTotal, submissions: [...]}}
export function parseCommonAssessment(html) {
  const start = html.indexOf('{"initialization"');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, k + 1)).initialization; } catch { return null; }
    }
  }
  return null;
}

// Assignment-based Test/Quiz: /assignment/ID/assessment_view lists your attempts with "view assessment" links.
export function parseLegacyQuizAttempts(doc, client) {
  return [...doc.querySelectorAll('a[href*="/assessment_view/"]')]
    .filter((a) => /view/i.test(a.textContent))
    .map((a) => client.abs(a.getAttribute('href')));
}

// Review page of one attempt: every question with your answer. Screen-reader text
// ("Selected:", "This answer is correct.") is kept because it marks your choices.
export function parseLegacyQuizReview(doc, client) {
  const questions = [...doc.querySelectorAll('.question-view')].map((qv, i) => {
    const box = qv.parentElement;
    const number = cleanText(box?.querySelector('.question-number')) || `Question ${i + 1}`;
    const score = cleanText(box?.querySelector('.score-grade-score'));
    return { number, score, md: htmlToMd(qv, client.origin, { keepHidden: true }) };
  });
  // "Submission #:1 Started:… Completed:… Time taken:… Total score:20/20" (skip the name/ID before it)
  const t = (doc.querySelector('#main-inner') || doc.body).textContent.replace(/\s+/g, ' ');
  const m = t.match(/Submission #:?\s*\d+.*?Total score:\s*[\d.]+\s*\/\s*[\d.]+/);
  return { summary: m ? m[0] : '', questions };
}

export function parseGrades(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('tr.report-row')) {
    const level = (tr.className.match(/\b(course|period|category|item)-row\b/) || [])[1] || 'item';
    const th = tr.querySelector('th, .title-column');
    const titleEl = th?.querySelector('.title') || th;
    const title = cleanText(titleEl).replace(/\s*(assignment|assessment|discussion)$/i, '');
    const due = cleanText(th?.querySelector('.due-date'));
    const grade = cleanText(tr.querySelector('.grade-column')).replace(/\s+/g, ' ');
    const comment = cleanText(tr.querySelector('.comment-column'));
    rows.push({ level, title: due ? title.replace(due, '').trim() : title, due, grade, comment });
  }
  return rows;
}

// Course updates feed: /course/ID/feed?page=N returns JSON { output: html }.
export function parseFeedPage(text) {
  let html = text;
  try { html = JSON.parse(text).output || ''; } catch { /* plain HTML */ }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('li')]
    .filter((li) => li.querySelector('.update-body, .update-sentence-inner'))
    .map((li) => ({
      author: cleanText(li.querySelector('.update-sentence-inner a, .edge-sentence a')),
      date: cleanText(li.querySelector('.small.gray, .edge-footer .created')),
      bodyEl: li.querySelector('.update-body'),
    }));
}
