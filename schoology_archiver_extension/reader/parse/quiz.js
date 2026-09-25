import { cleanText } from '../../util.js';
import { htmlToMd } from '../md.js';

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
