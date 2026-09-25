import { cleanText } from '../../util.js';

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
