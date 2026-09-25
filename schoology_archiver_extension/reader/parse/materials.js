import { cleanText, extOf } from '../../util.js';
import { resolveUrl } from '../md.js';

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
