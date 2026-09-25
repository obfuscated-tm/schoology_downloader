import { Archiver } from '../outputs/archive/archiver.js';
import { LoginError } from '../reader/client.js';
import { getSavedFolder, pickFolder, ensureWritable } from '../outputs/archive/folder.js';

const $ = (id) => document.getElementById(id);
const OPTS = ['google', 'submissions', 'quizzes', 'grades', 'updates', 'redownloadAll'];
const panelId = crypto.randomUUID();
const isSetupTab = new URLSearchParams(location.search).has('setup');

let archiver = null;
let folder = null;          // FileSystemDirectoryHandle
let courseTabId = null;     // Schoology tab the course was detected from

// ── Connection to the background worker (kill switch + keep-alive) ──────
let port;
function connect() {
  port = chrome.runtime.connect({ name: 'archiver-panel' });
  port.postMessage({ type: 'hello', id: panelId });
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}
connect();
setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { /* reconnecting */ } }, 20_000);

function log(msg, level = '') {
  const line = document.createElement('div');
  if (level) line.className = level;
  line.textContent = msg;
  const el = $('log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.appendChild(line);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── Course detection: follows whichever Schoology course tab you're looking at ──
async function detectCourse() {
  if (archiver) return; // don't change course mid-run
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const m = (tab?.url || '').match(/^https:\/\/([^/]+\.schoology\.com)\/course\/(\d+)/);
  if (m) {
    courseTabId = tab.id;
    $('host').value = m[1];
    $('course').value = m[2];
    const name = (tab.title || '').split(' | ')[0];
    $('courseName').textContent = name && !/^\d+$/.test(name) ? name : `Course ${m[2]}`;
    $('courseName').classList.remove('muted');
  } else if (!$('course').value) {
    $('courseName').textContent = 'Open a course in Schoology…';
    $('courseName').classList.add('muted');
  }
  $('start').disabled = !$('course').value;
}

// ── Folder ────────────────────────────────────────────────────────────────
async function showFolder() {
  folder = await getSavedFolder().catch(() => null);
  if (folder) {
    const perm = await folder.queryPermission({ mode: 'readwrite' });
    $('folderName').textContent = folder.name + (perm === 'granted' ? '' : ' (will ask to allow)');
    $('folderName').classList.remove('muted');
    $('pickFolder').textContent = 'Change…';
  }
}

async function choose() {
  try {
    folder = await pickFolder();
    await showFolder();
    if (isSetupTab) $('folderHint').textContent = 'Folder saved. You can close this tab and use the side panel.';
    return true;
  } catch (e) {
    if (e?.name === 'AbortError') return false; // picker cancelled
    // If Chrome won't show the picker inside the side panel, do it in a tab instead.
    $('folderHint').innerHTML = 'Chrome didn’t allow the folder picker here. <a href="#" id="openSetup">Choose the folder in a tab</a>, then come back.';
    $('openSetup').onclick = (ev) => {
      ev.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('panel/archive.html?setup=1') });
    };
    return false;
  }
}

// ── History ───────────────────────────────────────────────────────────────
async function renderHistory() {
  const all = await chrome.storage.local.get(null);
  const courses = Object.entries(all).filter(([k]) => k.startsWith('course:')).map(([, v]) => v);
  $('historyCard').hidden = !courses.length;
  const ul = $('history');
  ul.replaceChildren();
  for (const c of courses.sort((a, b) => (b.runs.at(-1)?.at || '').localeCompare(a.runs.at(-1)?.at || ''))) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = c.courseName;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const last = c.runs.at(-1);
    meta.textContent = `${Object.keys(c.files).length} items · ${last ? new Date(last.at).toLocaleDateString() : 'never'}${last?.stopped ? ' (stopped)' : ''}`;
    info.append(name, meta);
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = 'Sync';
    btn.onclick = () => {
      $('host').value = c.host;
      $('course').value = c.courseId;
      $('courseName').textContent = c.courseName;
      courseTabId = null;
      start();
    };
    li.append(info, btn);
    ul.append(li);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────
async function start() {
  if (archiver) return;
  const host = $('host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const courseId = ($('course').value.match(/\d{6,}/) || [])[0];
  if (!/\.schoology\.com$/.test(host) || !courseId) {
    alert('Open a course in Schoology first (or fill in the site and course ID under Options).');
    return;
  }

  // Folder first, while Chrome still counts this as a click (the picker/permission prompt need that).
  if (!folder && !(await choose())) return;
  const writable = await ensureWritable(folder).catch(() => null);
  if (!writable) {
    alert('Chrome needs permission to save into the archive folder. Click Archive again and choose Allow.');
    return;
  }

  const claim = await chrome.runtime.sendMessage({ type: 'claim', id: panelId, courseId });
  if (!claim?.ok) { alert('An archive is already running in another window. Stop it first.'); return; }

  const options = Object.fromEntries(OPTS.map((k) => [k, $(`opt-${k}`).checked]));
  await chrome.storage.local.set({ options: { ...options, host } });

  $('statusCard').hidden = false;
  $('log').replaceChildren();
  $('start').disabled = true;
  $('killbar').hidden = false;
  $('kill').disabled = false;
  $('killText').textContent = `Archiving ${$('courseName').textContent}…`;
  $('statusText').textContent = 'Archiving…';
  $('counts').textContent = '';

  archiver = new Archiver({
    host, courseId, tabId: courseTabId, folder, options, log,
    progress: (n) => { $('counts').textContent = `${n} items`; },
  });

  try {
    const r = await archiver.run();
    const s = r.stats;
    const summary = `${s.added.length} new, ${s.updated.length} updated, ${s.unchanged} unchanged, ${s.failed.length} problems`;
    if (r.stopped) {
      $('statusText').textContent = `Stopped — ${s.added.length + s.updated.length} files saved`;
      log(`\nStopped. ${summary}.`, 'warn');
      log('Saved files are remembered; run again to continue. (INDEX.md updates on the next full run.)', 'warn');
    } else {
      $('statusText').textContent = `Done — ${summary}`;
      log(`\nDone: ${summary}`, 'done');
      log(`Saved to ${r.location}/ (open INDEX.md there).`, 'done');
      if (s.failed.length) log('Problems are listed at the top of INDEX.md.', 'warn');
    }
  } catch (e) {
    if (e?.name === 'StoppedError' || e?.name === 'AbortError') {
      $('statusText').textContent = 'Stopped';
      log('Stopped before anything was saved.', 'warn');
    } else {
      $('statusText').textContent = 'Failed';
      log(e instanceof LoginError
        ? 'Not logged in. Sign in to Schoology in this Chrome window and try again.'
        : `Stopped with an error: ${e.message || e}`, 'error');
      console.error(e);
    }
  } finally {
    chrome.runtime.sendMessage({ type: 'release', id: panelId }).catch(() => {});
    $('killbar').hidden = true;
    archiver = null;
    await detectCourse();
    await renderHistory();
  }
}

function kill() {
  if (!archiver || archiver.stopped) return;
  $('kill').disabled = true;
  $('killText').textContent = 'Stopping…';
  $('statusText').textContent = 'Stopping…';
  log('■ Stop pressed: cancelling…', 'warn');
  archiver.stop();
}

// ── Wiring ────────────────────────────────────────────────────────────────
$('start').addEventListener('click', start);
$('pickFolder').addEventListener('click', choose);
$('kill').addEventListener('click', kill);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') kill(); });
chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'kill') kill(); });
$('course').addEventListener('input', () => { $('start').disabled = !$('course').value; });
chrome.tabs.onActivated.addListener(detectCourse);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.status === 'complete') detectCourse(); });

(async function init() {
  const saved = (await chrome.storage.local.get('options')).options || {};
  for (const k of OPTS) if (k in saved && k !== 'redownloadAll') $(`opt-${k}`).checked = saved[k];
  $('host').value = saved.host || 'fuhsd.schoology.com';
  if (isSetupTab) {
    document.querySelector('.actions').hidden = true;
    $('folderHint').textContent = 'Choose the archive folder here, then close this tab.';
  }
  await showFolder();
  await detectCourse();
  await renderHistory();
})();
