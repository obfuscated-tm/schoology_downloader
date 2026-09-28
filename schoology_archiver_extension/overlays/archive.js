// The Archiver's card: opened by the Archive button (overlays/switch.js) or a
// Materials page's "Sync now" (overlays/materials.js), built like
// launcher.js's neo-plan card — dimmed page, centered dialog, ×/Esc/click-
// outside closes. The job itself is not here: it runs in the offscreen
// document (background.js/offscreen/archive.js) so closing this card, or
// navigating away, never stops it. This card is only a view: it asks
// background.js for the job's state, keeps a port open for live pushes, and
// shows whatever course is actually running even if it isn't the one on this
// page — including in the Course row (a running job always wins there, even
// if the current page is a different course or no course at all).

import { createHost, el, onClick } from './ui.js';
import { OPTION_KEYS, DEFAULT_OPTIONS } from '../outputs/archive/state.js';

const OPTIONS_KEY = 'archiverOptions';
const OPT_LABELS = {
  google: 'Google Docs / Slides / Sheets linked in the course',
  submissions: 'My submissions, grades and teacher comments',
  quizzes: 'Quiz reviews (view only; never starts an attempt)',
  grades: 'Gradebook (grades.md)',
  updates: 'Announcements (updates.md)',
  redownloadAll: 'Re-check every page and re-download everything',
};

// A card that sizes to its content instead of stretching the viewport: a
// centered dialog with a fixed header and footer, and a body that scrolls
// internally once its content is taller than the available space. Only
// tokens from ui.js's BASE_CSS are used (never a hardcoded light-only
// colour) so the card still reads correctly once a dark theme inverts the
// whole page (docs/OVERLAY-UI.md, "Dark themes").
const CSS = `
.dim-page { position: fixed; inset: 0; z-index: 2147483001; background: rgba(31, 36, 41, 0.4); }
.card {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2147483002;
  width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  overflow: hidden;
}
.bar {
  display: flex; align-items: center; gap: 10px; flex: none;
  min-height: 48px; padding: 8px 8px 8px 14px; background: var(--sunk); border-bottom: 1px solid var(--line);
}
.bar .titles { display: flex; flex-direction: column; min-width: 0; margin-right: auto; gap: 1px; }
.bar .brand { font-weight: 600; font-size: 14px; }
.bar .sub { color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close {
  flex: none; width: 32px; height: 32px; border-radius: var(--radius);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 18px; line-height: 1; color: var(--dim);
}
.close:hover { color: var(--ink); background: var(--line); }
.body > * { flex: none; }
.body { flex: 1; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; row-gap: 2px; }
.row .label {
  flex: none; min-width: 60px; font-size: 11px; color: var(--dim);
  text-transform: uppercase; letter-spacing: .03em;
}
.row .value { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.row .value.muted { font-weight: 400; color: var(--dim); }
.elsewhere { margin: -6px 0 0; font-size: 12px; color: var(--dim); }
.link {
  background: none; border: 0; padding: 0; font: inherit; font-weight: 600;
  color: var(--accent); text-decoration: none; cursor: pointer; min-height: 20px;
}
.link:hover, .link:focus-visible { text-decoration: underline; text-underline-offset: 2px; }
details { border: 1px solid var(--line); border-radius: var(--radius); }
details summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; gap: 7px;
  min-height: 32px; padding: 7px 10px; font-weight: 600; font-size: 13px;
}
details summary::-webkit-details-marker { display: none; }
details summary::before {
  content: ""; flex: none; width: 0; height: 0;
  border-style: solid; border-width: 4px 0 4px 5px;
  border-color: transparent transparent transparent var(--dim);
  transition: transform .15s ease;
}
details[open] summary { border-bottom: 1px solid var(--line); }
details[open] summary::before { transform: rotate(90deg); }
fieldset { border: 0; padding: 10px; margin: 0; display: flex; flex-direction: column; gap: 8px; }
fieldset label { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; font-size: 13px; cursor: pointer; }
fieldset input[type="checkbox"] { width: 16px; height: 16px; min-width: 16px; margin-top: 1px; accent-color: var(--accent); }
.warn-box { padding: 8px 10px; background: var(--bad-soft); border: 1px solid var(--bad); border-radius: var(--radius); }
.warn-box label { color: var(--bad); font-weight: 600; }
.warn-box input[type="checkbox"] { accent-color: var(--bad); }
.warn-hint { margin: 4px 0 0 24px; font-size: 12px; color: var(--bad); }
.empty p { margin: 0; color: var(--ink); font-size: 13px; }
.empty p + p { margin-top: 6px; color: var(--dim); font-size: 12px; }
.result { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; font-weight: 600; }
.result.good { color: var(--good); }
.result.bad { color: var(--bad); }
.result.dim { color: var(--dim); }
.result .meta { font-weight: 400; color: var(--dim); font-size: 12px; }
.progress { position: relative; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.progress .fill {
  position: absolute; top: 0; left: -40%; width: 40%; height: 100%;
  background: var(--accent); border-radius: 2px;
  animation: np-arc-indeterminate 1.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .progress .fill { animation: none; left: 0; width: 100%; opacity: .35; }
}
@keyframes np-arc-indeterminate { 0% { left: -40%; } 100% { left: 100%; } }
.statusRow { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 8px; }
.statusRow strong { font-size: 13px; }
.statusRow .counts { color: var(--dim); font-size: 12px; white-space: nowrap; }
.log {
  margin: 8px 0 0; background: var(--sunk); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 8px 10px; height: 200px; flex: none; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--mono); font-size: 12px; line-height: 16px;
}
.log div + div { margin-top: 2px; }
.log .warn { color: var(--np-warn); }
.log .error { color: var(--bad); font-weight: 600; }
.log .done { color: var(--good); font-weight: 600; }
.history ul { list-style: none; margin: 0; padding: 0; }
.history { margin: 4px 0 0; }
.history h3 { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .03em; }
.history li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
.history li:first-child { border-top: 0; }
.history .meta { color: var(--dim); font-size: 12px; }
.foot { flex: none; padding: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.foot .hint { color: var(--bad); font-size: 12px; }
.foot .row2 { display: flex; gap: 8px; }
.primary, .stop, .secondary {
  flex: 1; min-height: 36px; padding: 8px 14px; border-radius: var(--radius); font-weight: 600; font-size: 13px;
}
.primary { background: var(--accent); color: var(--surface); border: 1px solid var(--accent); }
.primary:disabled { opacity: .5; cursor: default; }
.stop { background: var(--bad-soft); color: var(--bad); border: 1px solid var(--bad); }
.secondary { background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
.secondary:hover { border-color: var(--dim); }
@media (max-width: 600px) {
  .card { left: 8px; right: 8px; width: auto; transform: translateY(-50%); max-height: calc(100vh - 16px); }
}
`;

const courseIdOf = (pathname) => (String(pathname || '').match(/^\/course\/(\d+)/) || [])[1] || null;

// chrome.storage.local is readable straight from a content script (unlike
// storage.session). Wrapped so a harness page with no `chrome` at all (tests)
// gets an empty store instead of a ReferenceError.
const localStore = {
  get: (k) => (typeof chrome !== 'undefined' ? chrome.storage.local.get(k) : Promise.resolve({})),
  set: (o) => (typeof chrome !== 'undefined' ? chrome.storage.local.set(o) : Promise.resolve()),
};

async function readOptions(storage) {
  const got = await storage.get(OPTIONS_KEY).catch(() => ({}));
  const saved = got?.[OPTIONS_KEY] || {};
  return { ...DEFAULT_OPTIONS, ...saved };
}

// Focusable elements inside the card, for the Tab trap. Hidden/disabled ones
// are excluded (a closed <details> already removes its own content from this
// list — no need to special-case the checkboxes).
const FOCUSABLE_SEL = 'button:not([hidden]), a[href]:not([hidden]), input:not([hidden]):not([type="hidden"]), summary, [tabindex]:not([tabindex="-1"])';

let singleton = null;

export function start({
  doc = document, loc = location,
  send = (m) => chrome.runtime.sendMessage(m),
  connect = () => chrome.runtime.connect({ name: 'archive-card' }),
  storage = localStore,
} = {}) {
  if (singleton) return singleton;

  const { host, root } = createHost('np-archive-card', CSS);
  // The old amber warning colour, kept as a token local to this card (ui.js
  // doesn't define one) so the log's `.warn` rule can reference it once. Like
  // every other hardcoded colour in BASE_CSS (--bad, --good…), it's inside
  // the shadow host, so a dark theme's page-wide invert filter still turns it
  // into the right on-screen colour automatically.
  host.style.setProperty('--np-warn', '#9a6700');

  const shade = el('div', 'dim-page');
  shade.hidden = true;
  const card = el('div', 'card');
  card.hidden = true;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'np-arc-title');

  const sub = el('span', 'sub');
  const titles = el('div', 'titles');
  titles.append(el('span', 'brand', 'Archive'), sub);
  titles.firstChild.id = 'np-arc-title';
  const close = el('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close (Esc)';
  const bar = el('div', 'bar');
  bar.append(titles, close);

  const body = el('div', 'body');

  const courseRow = el('div', 'row');
  const courseValue = el('span', 'value muted');
  courseRow.append(el('span', 'label', 'Course'), courseValue);
  const elsewhereHint = el('p', 'elsewhere');
  elsewhereHint.hidden = true;

  const folderRow = el('div', 'row');
  const folderValue = el('span', 'value');
  const changeFolder = el('button', 'link', 'Change');
  changeFolder.type = 'button';
  folderRow.append(el('span', 'label', 'Save to'), folderValue, changeFolder);

  const details = el('details');
  const summary = el('summary', null, 'Options');
  const fieldset = el('fieldset');
  const checks = {};
  for (const k of OPTION_KEYS) {
    const cb = doc.createElement('input');
    cb.type = 'checkbox';
    checks[k] = cb;
    if (k === 'redownloadAll') {
      const box = el('div', 'warn-box');
      const label = el('label');
      label.append(cb, doc.createTextNode(' ' + OPT_LABELS[k]));
      box.append(label, el('p', 'warn-hint', 'Downloads everything again, even files that have not changed. Only use this if something looks stale or missing.'));
      fieldset.append(box);
    } else {
      const label = el('label');
      label.append(cb, doc.createTextNode(' ' + OPT_LABELS[k]));
      fieldset.append(label);
    }
  }
  details.append(summary, fieldset);

  const emptyState = el('div', 'empty');
  emptyState.append(
    el('p', null, 'Open a course in Schoology, then press Archive to save its files, assignments and grades.'),
  );

  const resultBlock = el('div', 'result');
  resultBlock.hidden = true;
  const resultText = el('strong');
  const resultMeta = el('span', 'meta');
  resultBlock.append(resultText, resultMeta);

  const statusSection = el('div');
  statusSection.hidden = true;
  const progress = el('div', 'progress');
  progress.append(el('div', 'fill'));
  const statusRow = el('div', 'statusRow');
  const statusText = el('strong');
  statusText.setAttribute('role', 'status');
  const counts = el('span', 'counts');
  statusRow.append(statusText, counts);
  statusSection.append(progress, statusRow);

  const log = el('pre', 'log');
  log.hidden = true;
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  let logJobKey = undefined;
  let logLen = 0;

  const historySection = el('div', 'history');
  historySection.hidden = true;
  historySection.append(el('h3', null, 'Archived courses'));
  const historyList = el('ul');
  historySection.append(historyList);
  let historyCount = 0;

  body.append(courseRow, elsewhereHint, folderRow, details, resultBlock, statusSection, log, emptyState, historySection);

  const hint = el('p', 'hint');
  hint.hidden = true;
  const startBtn = el('button', 'primary', 'Archive this course');
  startBtn.type = 'button';
  const stopBtn = el('button', 'stop', '■ Stop now');
  stopBtn.type = 'button';
  const closeFootBtn = el('button', 'secondary', 'Close');
  closeFootBtn.type = 'button';
  const row2 = el('div', 'row2');
  row2.append(startBtn, stopBtn, closeFootBtn);
  const foot = el('div', 'foot');
  foot.append(hint, row2);

  card.append(bar, body, foot);
  root.append(shade, card);
  doc.body.append(host);

  let isOpen = false;
  let courseId = null;
  let jobState = null;
  let openerEl = null;

  function pageCourseName() {
    const name = (doc.title || '').split(' | ')[0];
    return name && !/^\d+$/.test(name) ? name : `Course ${courseId}`;
  }

  function renderLog(lines, jobKey) {
    if (jobKey !== logJobKey) {
      log.replaceChildren();
      logJobKey = jobKey;
      logLen = 0;
    }
    // Only the appended lines are added, so the aria-live region announces
    // what's new rather than re-reading the whole log on every push.
    for (let i = logLen; i < lines.length; i++) {
      const l = lines[i];
      log.append(el('div', l.level || null, l.text));
    }
    logLen = lines.length;
    log.scrollTop = log.scrollHeight;
  }

  function draw() {
    const running = !!jobState?.running;
    const finished = !!jobState && !running;
    const sameCourse = running && String(jobState.courseId) === String(courseId) && jobState.host === loc.host.toLowerCase();

    // A running job always wins the Course row and the header subtitle, even
    // if it isn't the one on this page — there's only ever one job.
    const rowCourseName = running
      ? (jobState.courseName || `Course ${jobState.courseId}`)
      : (courseId ? pageCourseName() : null);
    courseValue.textContent = rowCourseName || 'No course open';
    courseValue.classList.toggle('muted', !rowCourseName);

    courseRow.hidden = !rowCourseName;
    details.hidden = running || !courseId;
    elsewhereHint.hidden = !(running && !sameCourse);
    if (running && !sameCourse) elsewhereHint.textContent = `Running on ${jobState.host}.`;

    sub.textContent = running ? 'Archiving…'
      : finished ? (jobState.error ? 'Error' : jobState.stopped ? 'Stopped' : 'Done')
      : (courseId ? pageCourseName() : '');

    resultBlock.hidden = !finished;
    if (finished) {
      const kind = jobState.error ? 'bad' : jobState.stopped ? 'dim' : 'good';
      resultBlock.className = `result ${kind}`;
      const icon = jobState.error ? '✕' : jobState.stopped ? '■' : '✓';
      resultText.textContent = jobState.error ? `${icon} ${jobState.error}` : `${icon} ${jobState.stopped ? 'Stopped.' : (jobState.summary || 'Done.')}`;
      resultMeta.textContent = [
        jobState.courseName || (jobState.courseId ? `Course ${jobState.courseId}` : null),
        jobState.counts ? `${jobState.counts} items` : null,
      ].filter(Boolean).join(' · ');
    }

    statusSection.hidden = !running;
    if (running) {
      statusText.textContent = jobState.status || 'Archiving…';
      counts.textContent = jobState.counts ? `${jobState.counts} items` : '';
    }

    log.hidden = !(running || finished);
    if (running || finished) renderLog(jobState.log || [], jobState.jobId);

    const showEmpty = !courseId && !running && !finished;
    emptyState.hidden = !showEmpty;

    historySection.hidden = !(historyCount > 0 && !running);

    // Footer.
    stopBtn.hidden = !running;
    stopBtn.disabled = false;
    startBtn.hidden = running || !courseId;
    startBtn.disabled = false;
    startBtn.textContent = finished ? 'Archive again' : 'Archive this course';
    closeFootBtn.hidden = !finished;
    foot.hidden = !(running || finished || courseId);
  }

  async function refreshFolder() {
    let r = null;
    try { r = await send({ type: 'archiveFolderInfo' }); } catch { /* worker gone */ }
    if (!r?.ok) { folderValue.textContent = 'Unknown (reload the extension)'; return; }
    folderValue.textContent = r.custom
      ? r.name + (r.granted ? '' : ' (permission lost — using Downloads)')
      : 'Downloads › Schoology Archive';
  }

  async function refreshHistory() {
    const all = await storage.get(null).catch(() => ({}));
    const courses = Object.entries(all).filter(([k]) => k.startsWith('course:')).map(([, v]) => v);
    historyCount = courses.length;
    historyList.replaceChildren();
    for (const c of courses.sort((a, b) => (b.runs?.at?.(-1)?.at || '').localeCompare(a.runs?.at?.(-1)?.at || '')).slice(0, 10)) {
      const li = el('li');
      const last = c.runs?.at?.(-1);
      const meta = `${Object.keys(c.files || {}).length} items · ${last ? new Date(last.at).toLocaleDateString() : 'never'}${last?.stopped ? ' (stopped)' : ''}`;
      li.append(el('span', null, c.courseName), el('span', 'meta', meta));
      historyList.append(li);
    }
    draw();
  }

  function getFocusable() {
    return Array.from(root.querySelectorAll(FOCUSABLE_SEL)).filter((e) => !e.disabled && e.getClientRects().length > 0);
  }

  async function open() {
    courseId = courseIdOf(loc.pathname);
    const saved = await readOptions(storage);
    for (const k of OPTION_KEYS) checks[k].checked = saved[k];
    draw();
    refreshFolder();
    refreshHistory();
    if (!isOpen) {
      isOpen = true;
      openerEl = doc.activeElement;
      shade.hidden = false;
      card.hidden = false;
      close.focus();
    }
  }

  function shut() {
    if (!isOpen) return;
    isOpen = false;
    shade.hidden = true;
    card.hidden = true;
    if (openerEl && typeof openerEl.focus === 'function') openerEl.focus();
    openerEl = null;
  }

  function currentOptions() {
    const out = {};
    for (const k of OPTION_KEYS) out[k] = checks[k].checked;
    return out;
  }

  async function startNow() {
    if (!courseId) return;
    const options = currentOptions();
    storage.set({ [OPTIONS_KEY]: options }).catch(() => {});
    startBtn.disabled = true;
    hint.hidden = true;
    hint.textContent = '';
    let r = null;
    try { r = await send({ type: 'archiveStart', courseId, options }); } catch { /* worker gone */ }
    if (!r?.ok) {
      hint.textContent = r?.error === 'busy'
        ? 'An archive is already running. Stop it first.'
        : r?.error === 'quiz'
          ? 'A quiz is open in another tab. Finish it first.'
          : 'Reload the extension, then this page.';
      hint.hidden = false;
      draw();
    }
  }
  onClick(startBtn, startNow);
  onClick(stopBtn, async () => {
    stopBtn.disabled = true;
    try { await send({ type: 'archiveStop' }); } catch { /* worker gone */ }
  });
  onClick(closeFootBtn, shut);
  onClick(changeFolder, async () => {
    try { await send({ type: 'openSettings' }); } catch { /* worker gone */ }
  });
  onClick(close, shut);
  onClick(shade, shut);
  shade.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  doc.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') { e.stopPropagation(); shut(); return; }
    if (e.key === 'Tab') {
      const items = getFocusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const activeInHost = root.activeElement;
      if (e.shiftKey) {
        if (activeInHost === first || !items.includes(activeInHost)) { e.preventDefault(); last.focus(); }
      } else if (activeInHost === last || !items.includes(activeInHost)) {
        e.preventDefault(); first.focus();
      }
    }
  }, true);

  // A live view onto the job wherever it's actually running: a port push,
  // not polling — the offscreen job keeps going whether or not this card, or
  // even this tab, is open.
  let port = null;
  function connectPort() {
    try {
      port = connect();
      port.onMessage.addListener((msg) => {
        if (msg?.type !== 'archiveState') return;
        jobState = msg.state;
        if (isOpen) draw();
      });
      port.onDisconnect.addListener(() => { port = null; setTimeout(connectPort, 1000); });
    } catch { /* no chrome: tests */ }
  }
  connectPort();

  singleton = { host, root, open, startNow, close: shut, get isOpen() { return isOpen; } };
  return singleton;
}

/** For tests: drop the cached card so a fresh start() builds a new one. */
export function resetForTests() { singleton = null; }
