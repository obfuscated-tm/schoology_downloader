import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuizPageUrl } from '../sync/quiet.js';

const H = 'https://fuhsd.schoology.com';

test('quiz pages: taking, attempts, review, newer assessments', () => {
  for (const p of [
    '/assignment/8580019138/assessment',
    '/assignment/8580019138/assessment_view/2429939407',
    '/assignment/8580019138/assessment_view',
    '/course/41/assessments/2',
    '/course/41/assessments/2/take',
    '/assessment/5/start',
  ]) assert.equal(isQuizPageUrl(H + p), true, p);
});

test('not quiz pages', () => {
  for (const u of [
    `${H}/assignment/8580019138`,
    `${H}/course/41/materials`,
    `${H}/home`,
    'https://example.com/assessment',
    '',
    undefined,
  ]) assert.equal(isQuizPageUrl(u), false, String(u));
});
