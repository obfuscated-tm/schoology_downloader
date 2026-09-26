// Settings, below the token: the Schoology line (when neo-plan last read
// Schoology, Check now, and any problem in one quiet line) and Courses (each
// Schoology section and the neo-plan column it files into; PUT on change).
// Copy follows neo-plan's DESIGN.md §8: "Schoology", never "sync".

import { np as defaultNp } from './np.js';
import { clock, dayOf, shortDay } from './today-format.js';

const KEY_SNAPSHOT = 'syncSnapshot';

const PROBLEM = {
  login: 'Not signed in',
  token: 'Token refused',
  neoplan: 'Can’t reach neo-plan',
  schoology: 'Can’t read Schoology',
  stopped: 'Stopped',
};

/** "10:42" today, "Thu 24 · 10:42" otherwise, in the browser's zone. */
export function whenText(iso, nowIso = new Date().toISOString(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  if (!iso) return '';
  const day = dayOf(iso, zone);
  return day === dayOf(nowIso, zone) ? clock(iso, zone) : `${shortDay(day)} · ${clock(iso, zone)}`;
}

/** One quiet line for a Snapshot, or '' when all is well. */
export function problemText(snap, skipped) {
  if (skipped === 'busy') return 'Archive running';
  if (!snap) return '';
  if (snap.error) return PROBLEM[snap.error] || 'Can’t read Schoology';
  if (snap.errors?.length) return `${snap.errors.length} ${snap.errors.length === 1 ? 'page' : 'pages'} unread`;
  return '';
}

/** Strip Schoology's trailing course number: "AP Comp Sci A - 2350" → "AP Comp Sci A". */
export const courseName = (t) => String(t || '').replace(/\s+-\s+\d+\s*$/, '').trim() || 'Untitled';

export function createSyncSettings({ doc = document, np = defaultNp, send = (m) => chrome.runtime.sendMessage(m), storage = chrome.storage } = {}) {
  const $ = (id) => doc.getElementById(id);
  let running = false;
  let lastSkipped = null;
  let visible = false;

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function hint(id, text, bad = false) {
    const h = $(id);
    h.textContent = text || '';
    h.hidden = !text;
    h.classList.toggle('bad', bad);
  }

  // ── The Schoology line ────────────────────────────────────────────────
  function drawLine(snap) {
    $('npSyncTime').textContent = running ? '' : snap?.at ? whenText(snap.finished_at || snap.at) : 'Never';
    const b = $('npSyncNow');
    b.textContent = running ? 'Checking' : 'Check now';
    b.disabled = running;
    hint('npSyncHint', running ? '' : problemText(snap, lastSkipped));
  }

  async function state() {
    try { return (await send({ type: 'sync', op: 'state' })) || {}; } catch { return {}; }
  }

  async function checkNow() {
    if (running) return;
    running = true;
    lastSkipped = null;
    drawLine(null);
    let r = {};
    try { r = (await send({ type: 'sync', op: 'now' })) || {}; } catch { /* worker restarting */ }
    running = false;
    lastSkipped = r.skipped || null;
    drawLine(r.snapshot || null);
    drawCourses();
  }

  // ── Courses ───────────────────────────────────────────────────────────
  async function drawCourses() {
    const r = await np('courses');
    if (!r.ok) {
      $('npCourses').hidden = r.status === 401; // no token: nothing to map yet
      if (r.status !== 401) hint('npCoursesHint', r.status === 0 ? 'Can’t reach neo-plan' : 'Can’t load', true);
      return;
    }
    $('npCourses').hidden = false;
    hint('npCoursesHint', '');
    const courses = Array.isArray(r.data?.courses) ? r.data.courses : [];
    const classes = Array.isArray(r.data?.classes) ? r.data.classes : [];
    const list = $('npCourseList');
    if (!courses.length) {
      list.replaceChildren();
      hint('npCoursesHint', 'No courses yet');
      return;
    }
    list.replaceChildren(...courses.map((c) => row(c, classes)));
  }

  function row(c, classes) {
    const li = el('li');
    li.dataset.section = c.section_id;
    const name = el('div', 'name');
    name.append(el('span', null, courseName(c.title)));
    if (c.section_title) name.append(el('span', 'sect', c.section_title));
    const pick = el('div', 'pick');
    const sel = el('select');
    sel.setAttribute('aria-label', `Column for ${courseName(c.title)}`);
    const none = el('option', null, 'None');
    none.value = '';
    sel.append(none);
    for (const k of classes) {
      const o = el('option', null, k.name || 'Untitled');
      o.value = k.id;
      sel.append(o);
    }
    sel.value = c.class_id || '';
    const auto = el('span', 'mono auto', 'auto');
    auto.hidden = !(c.auto && c.class_id);
    sel.addEventListener('change', async () => {
      const before = c.class_id || '';
      const want = sel.value || null;
      sel.disabled = true;
      const res = await np('setCourse', { section_id: c.section_id, class_id: want });
      sel.disabled = false;
      if (!res.ok) {
        sel.value = before; // the old choice stands
        hint('npCoursesHint', res.status === 0 ? 'Can’t reach neo-plan' : 'Try again', true);
        return;
      }
      hint('npCoursesHint', '');
      c.class_id = res.data?.class_id ?? want;
      c.auto = false;
      auto.hidden = true;
    });
    pick.append(sel, auto);
    li.append(name, pick);
    return li;
  }

  // ── Showing it ────────────────────────────────────────────────────────
  async function draw({ hasToken } = {}) {
    visible = true;
    $('npSyncRow').hidden = !hasToken;
    if (!hasToken) { $('npCourses').hidden = true; return; }
    const s = await state();
    running = !!s.running;
    drawLine(s.snapshot || null);
    await drawCourses();
  }

  $('npSyncNow').addEventListener('click', checkNow);
  storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY_SNAPSHOT] || !visible) return;
    running = false; // a Snapshot is written when a run ends
    lastSkipped = null;
    drawLine(changes[KEY_SNAPSHOT].newValue);
  });

  return { draw, hide() { visible = false; }, checkNow, _drawCourses: drawCourses };
}
