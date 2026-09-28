// The MCP bridge's page parsers (docs/MCP-BRIDGE.md): the full gradebook, an
// assignment, its dropbox, a course's updates and a Materials folder, as plain
// JSON. Loaded only by the offscreen parser (offscreen/parse.js), never by an
// overlay: its imports (assignment.js, feed.js, …) aren't web-accessible, so
// pulling this into reader/parse/sync.js would break every overlay's import.
// Needs a global DOMParser.

import { cleanText } from '../../util.js';
import { htmlToMd, resolveUrl } from '../md.js';
import { parseGrades } from './grades.js';
import { parseAssignment, parseDropbox } from './assignment.js';
import { parseFolderRows, contentRoot, findSourceAttachments, findLinkViewTarget } from './materials.js';
import { parseFeedPage } from './feed.js';
import { folderIdOf, parseSubmissionStatus, parseDueText, isLoginPage } from './sync.js';
import { classifyLink } from '../../outputs/archive/google.js';

export const MCP_KINDS = new Set(['gradesFull', 'assignmentFull', 'dropboxFull', 'materialsFull', 'updatesFeed', 'materialFull']);

const ASSIGNMENT_RE = /\/assignment\/(\d+)(?:[/?#]|$)/;
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// A materials page title carries Schoology's lesson-plan counter ("Textbook 0 lesson plans").
const pageTitle = (anchor, doc) => (cleanText(anchor) || squash((doc.querySelector('title')?.textContent || '').split(' | ')[0]))
  .replace(/\s*\d+\s+lesson plans?$/i, '') || null;
const LOGIN_RE = /s-user-login-form|login-container/;

// A stand-in for SchoologyClient, for the pure DOM parsers (assignment.js,
// materials.js) that only ever call client.abs()/client.origin to resolve a
// relative href — never client.getText/getDoc. `url` is the page's own final
// URL (offscreen/parse.js's third argument), used as the base.
function urlStub(url) {
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* no url given (tests) */ }
  return { origin, abs: (u) => { try { return new URL(u, url || origin || undefined).href; } catch { return u; } } };
}

// The MCP `materials` op's flatter shape: { kind, title, id, url }, from
// parseFolderRows' richer per-kind rows (materials.js).
function materialsRows(doc, url) {
  const rows = parseFolderRows(doc, urlStub(url)) || [];
  return rows.map((r) => {
    if (r.kind === 'folder') return { kind: 'folder', title: r.title, id: folderIdOf(r.url) || r.key || null, url: r.url || null };
    if (r.kind === 'document') {
      const first = r.files?.[0] || r.links?.[0];
      return { kind: 'document', title: r.title, id: r.key || null, url: first?.url || r.otherUrl || null };
    }
    if (r.kind === 'quiz') return { kind: 'quiz', title: r.title, id: r.key || null, url: r.url || null };
    const idFrom = (re) => (String(r.url || '').match(re) || [])[1] || null;
    if (r.kind === 'assignment') return { kind: 'assignment', title: r.title, id: idFrom(ASSIGNMENT_RE), url: r.url || null };
    if (r.kind === 'page') return { kind: 'page', title: r.title, id: idFrom(/\/page\/(\d+)/), url: r.url || null };
    if (r.kind === 'discussion') return { kind: 'discussion', title: r.title, id: idFrom(/\/discussion\/(\d+)/), url: r.url || null };
    return { kind: 'other', title: r.title, id: r.key || null, url: r.url || null };
  });
}

// The `material` op's path shapes, matched against a page's own final URL to
// tell a /page/ from a /materials/gp/ from a /materials/link/view/ (the
// `assignment` shape is handled entirely in ops.js — it delegates to the
// `assignment` op instead of fetching here). Kept in sync with
// outputs/mcp/ops.js's MATERIAL_SHAPES.
const MATERIAL_URL_KIND = [
  { kind: 'gp', re: /\/materials\/gp\/\d{1,20}(?:[/?#]|$)/ },
  { kind: 'link_view', re: /\/materials\/link\/view\/\d{1,20}(?:[/?#]|$)/ },
  { kind: 'page', re: /\/page\/\d{1,20}(?:[/?#]|$)/ },
  { kind: 'discussion', re: /\/discussion\/\d{1,20}(?:[/?#]|$)/ },
];

// Sheets export as .xlsx elsewhere (google.js); the `file` op returns CSV, so
// a `material` row's `files` entries carry the ext `file` would actually
// produce.
function googleFileExt(info) {
  if (info.kind === 'drivefile') return null;
  return info.ext === 'xlsx' ? 'csv' : info.ext || null;
}

// A `material` op result: title/body for whatever the page is, `target` for
// a link/view wrapper, `files` for a gp document's real downloads plus any
// Google Docs/Slides/Sheets/Drive links found in the content, and `links` for
// everything else outbound.
function materialFull(doc, url) {
  const client = urlStub(url);
  let pathname = url || '';
  try { pathname = new URL(url).pathname; } catch { /* tests without a url */ }
  const kind = (MATERIAL_URL_KIND.find((k) => k.re.test(pathname)) || {}).kind || 'other';

  const root = contentRoot(doc);
  const anchor = doc.querySelector('#center-top .page-title, #center-top h2, h2.page-title, .item-title');
  const title = pageTitle(anchor, doc);
  const body_md = htmlToMd(root, client.origin) || null;
  const target = kind === 'link_view' ? (findLinkViewTarget(doc, client) || null) : null;

  const files = [];
  if (kind === 'gp') {
    for (const att of findSourceAttachments(doc, client)) {
      files.push({ title: title || att.fingerprint, url: att.url, ext: att.ext || null });
    }
  }
  const seen = new Set(files.map((f) => f.url));
  const links = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    const resolved = resolveUrl(href, client.origin);
    if (!resolved || seen.has(resolved) || /\/attachment\/[^/]+\/source\//.test(resolved)) continue;
    seen.add(resolved);
    const info = classifyLink(resolved);
    if (info.kind === 'google' || info.kind === 'drivefile') {
      files.push({ title: cleanText(a) || info.label, url: resolved, ext: googleFileExt(info) });
    } else {
      links.push({ title: cleanText(a) || resolved, url: resolved });
    }
  }
  return { url, kind, title, body_md, target, files, links };
}

/** kind (one of MCP_KINDS) + response text → { data } | { login: true }. */
export function parseMcpKind(kind, text, url = '') {
  if (!MCP_KINDS.has(kind)) throw new Error(`unknown parse kind: ${kind}`);
  // The updates feed unwraps its own JSON and parses per post (feed.js).
  if (kind === 'updatesFeed') {
    if (LOGIN_RE.test(String(text))) return { login: true };
    const { origin } = urlStub(url);
    const posts = parseFeedPage(text).map((p) => ({
      author: p.author, date: p.date, body_md: p.bodyEl ? htmlToMd(p.bodyEl, origin) : '',
    }));
    return { data: posts };
  }
  const doc = new DOMParser().parseFromString(String(text ?? ''), 'text/html');
  if (isLoginPage(doc)) return { login: true };
  if (kind === 'gradesFull') return { data: parseGrades(doc) };
  if (kind === 'materialsFull') return { data: materialsRows(doc, url) };
  if (kind === 'materialFull') return { data: materialFull(doc, url) };
  if (kind === 'dropboxFull') {
    const d = parseDropbox(doc, urlStub(url));
    return { data: { grade: d.grade || null, comments: d.comments || [] } };
  }
  // assignmentFull
  const client = urlStub(url);
  const a = parseAssignment(doc, client, url);
  const anchor = doc.querySelector('#center-top .page-title, #center-top h2, h2.page-title');
  const title = pageTitle(anchor, doc);
  const submission = parseSubmissionStatus(doc, url);
  return {
    data: {
      title,
      type: a.isQuiz ? 'quiz' : a.isExternalTool ? 'external_tool' : 'assignment',
      due: a.due ? parseDueText(a.due) : null,
      instructions_md: a.bodyEl ? htmlToMd(a.bodyEl, client.origin) : null,
      attachments: a.attachments.map(({ url: u, title: t }) => ({ url: u, title: t })),
      submission: submission.quiz ? null : { state: submission.state, ...(typeof submission.late === 'boolean' ? { late: submission.late } : {}) },
      dropboxUrl: a.dropboxUrl || null,
    },
  };
}
