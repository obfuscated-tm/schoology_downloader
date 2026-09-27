import { cleanText } from '../../util.js';
import { weightFromText } from '../../overlays/grademath.js';

/**
 * The gradebook's rows, in page order. `root` is a document or an element.
 * With `els`, each row also carries `el`, its <tr>, for the grades overlay
 * (a DOM node can't be cloned into a message, so it's opt-in). Rows Schoology
 * Plus adds for its own what-if grades are skipped.
 */
export function parseGrades(root, { els = false } = {}) {
  const rows = [];
  for (const tr of root.querySelectorAll('tr.report-row')) {
    if (tr.matches('.grade-add-indicator, .added-fake-assignment')) continue;
    const level = (tr.className.match(/\b(course|period|category|item)-row\b/) || [])[1] || 'item';
    const th = tr.querySelector('th, .title-column');
    const titleEl = th?.querySelector('.title') || th;
    const title = cleanText(titleEl).replace(/\s*(assignment|assessment|discussion)$/i, '');
    const due = cleanText(th?.querySelector('.due-date'));
    const grade = cleanText(tr.querySelector('.grade-column')).replace(/\s+/g, ' ');
    const comment = cleanText(tr.querySelector('.comment-column'));
    const row = { level, title: due ? title.replace(due, '').trim() : title, due, grade, comment };
    // A category's weight is a sibling of .title in the title cell:
    // <span class="percentage-contrib">(25%)</span>. An item row's data-id is
    // I-{assignment id}.
    if (level === 'category') row.weight = weightFromText((th?.querySelector('.percentage-contrib') || th)?.textContent);
    if (level === 'item') row.id = ((tr.getAttribute('data-id') || '').match(/^I-(\d+)$/) || [])[1] || null;
    if (els) row.el = tr;
    rows.push(row);
  }
  return rows;
}
