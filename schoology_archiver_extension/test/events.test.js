// node --test test/   (from schoology_archiver_extension/)
//
// /home/assignments' list data, /v2/events/{list}: its shape as seen on
// fuhsd.schoology.com on 2026-09-26 (ids and titles made up).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventsJson } from '../reader/parse/sync.js';

const H = 'https://x.schoology.com';
const JSON_LD = {
  '@items': [],
  '@extra': [
    { '@id': `${H}/v1/sections/11/assignments/101`, '@type': ['sgy:Material', 'sgy:Assignment'], title: 'Lab 9.1 Fibonacci', url: `${H}/assignment/101`, dueDateInUTCISO: '2026-09-28T06:59:00Z', '@links': { parent: { '@id': `${H}/v1/sections/11` } } },
    { '@id': `${H}/v1/sections/12/assessments/202`, '@type': ['sgy:Material', 'sgy:Assessment', 'sgy:CourseAssessment'], title: 'Interro  de vocabulaire 1.2', url: `${H}/course/12/assessments/202`, studentGrade: { grade: '9' }, '@links': { parent: { '@id': `${H}/v1/sections/12` } } },
    { '@id': `${H}/v1/sections/11`, '@type': ['sgy:Section'], title: 'McLeodT p2 T1', '@links': { course: { '@id': `${H}/v1/courses/1` } } },
    { '@id': `${H}/v1/sections/12`, '@type': ['sgy:Section'], title: 'AggounI p4 T1', '@links': { course: { '@id': `${H}/v1/courses/2` } } },
    { '@id': `${H}/v1/courses/1`, '@type': ['sgy:Course'], title: 'AP Comp Sci A - 2350' },
    { '@id': `${H}/v1/courses/2`, '@type': ['sgy:Course'], title: 'French 2 - 4120' },
  ],
};

test('events JSON: assignments and newer quizzes, with their course and section', () => {
  assert.deepEqual(parseEventsJson(JSON.stringify(JSON_LD)), [
    { schoology_id: '101', title: 'Lab 9.1 Fibonacci', course: 'AP Comp Sci A - 2350', section_id: '11', due: '2026-09-28T06:59:00Z', graded: false },
    { schoology_id: '202', title: 'Interro de vocabulaire 1.2', course: 'French 2 - 4120', section_id: '12', due: null, graded: true },
  ]);
  assert.deepEqual(parseEventsJson('not json'), []);
});
