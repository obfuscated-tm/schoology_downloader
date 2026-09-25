import { cleanText } from '../../util.js';

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
