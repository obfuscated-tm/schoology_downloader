import { handleNeoplan, getConfig, isWorkValue } from './outputs/neoplan/api.js';
import { requestSync, stopSync, syncRunning, reportSubmitted, sectionForRealm, SYNC_LOCK_ID, KEY_HOST } from './sync/runner.js';
import { KEY_SNAPSHOT } from './sync/sync.js';
import { limiter, restorePausedUntil, persistPausedUntil } from './sync/limiter.js';
import { ensureOffscreen, OFFSCREEN_URL } from './offscreen/ensure.js';
import { PROXY_OPS } from './outputs/archive/chrome-bridge.js';
import { isValidCourseId, sanitizeOptions, reduceProgress } from './outputs/archive/state.js';
import { getSavedFolder } from './outputs/archive/folder.js';

const SYNC_ALARM = 'neoplan-sync';
const SYNC_SOON_ALARM = 'neoplan-sync-soon';
const SYNC_EVERY_MIN = 15;
const TAB_SYNC_GAP_MS = 10 * 60_000; // a Schoology page load starts a sync, at most every 10 min
// What a content script on a Schoology page may ask neo-plan. Never the token,
// the server, the course map or a raw enrich. Never Turn in either: on
// Schoology's pages work is turned in only with Schoology's own Submit button.
// 'work' (marking studied/done, or back) is the one write besides add/remove.
const CONTENT_OPS = new Set(['items', 'addItem', 'remove', 'restore', 'work']);

// ── The archive job: one at a time, in the offscreen document ───────────────
// There is no side panel and no tab any more — the Archive button opens a
// card (overlays/archive.js) that is only a view. Closing it, or navigating
// away, never stops the job: it runs in the offscreen document, and its
// progress is kept here (chrome.storage.session) so any card, on any
// Schoology page, shows it live. `archiveActive` mirrors the stored state's
// `running` so requestSync can check it without an extra read; it's restored
// below in case this service worker was restarted mid-run (the offscreen
// document survives that).
const ARCHIVE_LOCK_ID = 'archive';
const KEY_ARCHIVE_STATE = 'archiveState';
let archiveActive = false;
chrome.storage.session.get(KEY_ARCHIVE_STATE).then(({ [KEY_ARCHIVE_STATE]: state }) => {
  if (state?.running) archiveActive = true;
}).catch(() => {});

const isArchiveRunning = (running) => running.id === ARCHIVE_LOCK_ID && archiveActive;

// Cards on any Schoology page hold a port open to be pushed live updates
// (chrome.storage.session isn't readable from a content script, and we don't
// want to grant that broadly just for this).
const archivePorts = new Set();
function broadcastArchiveState(state) {
  for (const p of archivePorts) { try { p.postMessage({ type: 'archiveState', state }); } catch { /* gone */ } }
}

let offscreenUrl = null;
function isOffscreenSender(sender) {
  offscreenUrl ||= chrome.runtime.getURL(OFFSCREEN_URL);
  return sender.id === chrome.runtime.id && sender.url === offscreenUrl;
}

// The settings page is a normal tab, one apiece: find an already-open one and
// focus it instead of piling up duplicates.
async function focusOrOpen(path, { openerTabId } = {}) {
  const url = chrome.runtime.getURL(path);
  // getContexts sees our own pages without the "tabs" permission. Top frames
  // only: settings.html framed in the gear popover is not a settings tab.
  const ctx = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] }))
    .find((c) => c.frameId === 0 && c.tabId >= 0 && c.documentUrl?.startsWith(url));
  if (ctx) {
    const tab = await chrome.tabs.update(ctx.tabId, { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab, opened: false };
  }
  const tab = await chrome.tabs.create({ url, openerTabId });
  return { tab, opened: true };
}

// The toolbar icon opens the settings page as a tab (options_ui also points here).
chrome.action.onClicked.addListener(() => { focusOrOpen('panel/settings.html').catch(() => {}); });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'archive-card') return;
  archivePorts.add(port);
  chrome.storage.session.get(KEY_ARCHIVE_STATE).then(({ [KEY_ARCHIVE_STATE]: state }) => {
    try { port.postMessage({ type: 'archiveState', state: state || null }); } catch { /* already gone */ }
  });
  port.onDisconnect.addListener(() => archivePorts.delete(port));
});

// Who sent a message: one of this extension's own pages (panel), or one of its
// content scripts on a Schoology page. Anything else is ignored.
function origin(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  if (sender.url?.startsWith(chrome.runtime.getURL(''))) return 'page';
  if (sender.tab && /^https:\/\/[a-z0-9-]+\.schoology\.com\//i.test(sender.url || '')) return 'content';
  return null;
}

async function contentNeoplan(msg) {
  if (!CONTENT_OPS.has(msg.op)) return { ok: false, status: 403, data: { error: 'op' } };
  // A content script may only flip work between the two states the marker shows; never Turn in.
  if (msg.op === 'work' && !isWorkValue(msg.work)) return { ok: false, status: 400, data: { error: 'work' } };
  if (msg.op === 'addItem' && msg.item && !msg.item.section_id && msg.item.realm) {
    msg = { ...msg, item: { ...msg.item, section_id: await sectionForRealm(msg.item.realm) } };
  }
  return handleNeoplan(msg);
}

async function syncState() {
  const snap = (await chrome.storage.local.get(KEY_SNAPSHOT))[KEY_SNAPSHOT] || null;
  return { running: !!syncRunning(), snapshot: snap };
}

// Start an archive job for `courseId` on `host` (from the content script's
// own tab), unless a sync or another archive already holds the run lock.
async function startArchive({ host, courseId, options, tabId }, reply) {
  const s = syncRunning();
  if (s) await s.catch(() => {});
  const { running } = await chrome.storage.session.get('running');
  if (running?.id && running.id !== ARCHIVE_LOCK_ID && running.id !== SYNC_LOCK_ID) { reply({ ok: false, error: 'busy' }); return; }
  if (archiveActive) { reply({ ok: false, error: 'busy' }); return; }
  archiveActive = true;
  await chrome.storage.session.set({ running: { id: ARCHIVE_LOCK_ID, courseId } });
  try {
    await ensureOffscreen();
  } catch {
    archiveActive = false;
    await chrome.storage.session.remove('running');
    reply({ ok: false, error: 'offscreen' });
    return;
  }
  const jobId = crypto.randomUUID();
  const state = {
    jobId, running: true, host, courseId, courseName: null, status: 'Starting…',
    log: [], counts: 0, startedAt: Date.now(), finishedAt: null, error: null, summary: null, stopped: false,
  };
  await chrome.storage.session.set({ [KEY_ARCHIVE_STATE]: state });
  broadcastArchiveState(state);
  reply({ ok: true, jobId });
  chrome.runtime.sendMessage({ type: 'archiveRun', target: 'offscreen', jobId, host, courseId, tabId, options }).catch(() => {});
}

async function finishArchiveLock() {
  archiveActive = false;
  const { running } = await chrome.storage.session.get('running');
  if (running?.id === ARCHIVE_LOCK_ID) await chrome.storage.session.remove('running');
}

// Only one run at a time, across all windows: an Archive, or a sync.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const from = origin(sender);
  if (msg?.type === 'neoplan') {
    // Only this extension's own pages drive neo-plan with the stored token;
    // content scripts get a few item ops, through here.
    if (from === 'page') handleNeoplan(msg).then(reply);
    else if (from === 'content') contentNeoplan(msg).then(reply);
    else return false;
    return true; // async reply
  }
  if (msg?.type === 'submitted') {
    if (from !== 'content') return false;
    reportSubmitted(msg).then(reply, (e) => reply({ ok: false, status: 0, data: { error: String(e?.message || e) } }));
    return true;
  }
  if (msg?.type === 'neoplanServer') {
    // Where the neo-plan card's frame points. The server, never the token.
    if (from !== 'content' && from !== 'page') return false;
    getConfig().then(({ server }) => reply({ ok: true, server }), () => reply({ ok: false }));
    return true;
  }
  if (msg?.type === 'openSettings') {
    // The card's "Change in Settings" link, or the gear's neo-plan group.
    if (from !== 'content' && from !== 'page') return false;
    focusOrOpen('panel/settings.html', { openerTabId: sender.tab?.id }).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
  if (msg?.type === 'archiveFolderInfo') {
    // Where the card says archives are saved: Downloads, or a chosen folder
    // (and whether Chrome still has permission for it).
    if (from !== 'content' && from !== 'page') return false;
    (async () => {
      try {
        const folder = await getSavedFolder();
        if (!folder) { reply({ ok: true, custom: false, name: null, granted: false }); return; }
        const granted = (await folder.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted';
        reply({ ok: true, custom: true, name: folder.name, granted });
      } catch { reply({ ok: true, custom: false, name: null, granted: false }); }
    })();
    return true;
  }
  if (msg?.type === 'archiveStart') {
    if (from !== 'content' || !sender.tab || !isValidCourseId(msg.courseId)) { reply({ ok: false, error: 'course' }); return false; }
    const host = new URL(sender.url).host.toLowerCase();
    startArchive({ host, courseId: String(msg.courseId), options: sanitizeOptions(msg.options), tabId: sender.tab.id }, reply);
    return true;
  }
  if (msg?.type === 'archiveStop') {
    if (from !== 'content' && from !== 'page') return false;
    chrome.runtime.sendMessage({ type: 'archiveStop', target: 'offscreen' }).catch(() => {});
    reply({ ok: true });
    return true;
  }
  if (msg?.type === 'archiveState') {
    if (from !== 'content' && from !== 'page') return false;
    chrome.storage.session.get(KEY_ARCHIVE_STATE).then(({ [KEY_ARCHIVE_STATE]: state }) => reply({ ok: true, state: state || null }));
    return true;
  }
  if (msg?.type === 'archiveProgress') {
    // Pushed by the offscreen job, never a content script: never trust this
    // from anywhere but that one page.
    if (!isOffscreenSender(sender)) return false;
    (async () => {
      const { [KEY_ARCHIVE_STATE]: state } = await chrome.storage.session.get(KEY_ARCHIVE_STATE);
      const next = reduceProgress(state, msg);
      if (!next || next === state) return;
      await chrome.storage.session.set({ [KEY_ARCHIVE_STATE]: next });
      broadcastArchiveState(next);
      if (msg.done) await finishArchiveLock();
    })();
    return false;
  }
  if (msg?.type === 'archivePing') {
    return false; // just keeps this service worker alive by arriving
  }
  if (msg?.type === 'archiveProxy') {
    // Everything the offscreen Archiver needs besides chrome.runtime
    // (storage, downloads, tabs, scripting) — an exact allowlist, only from
    // the offscreen document itself. See outputs/archive/chrome-bridge.js.
    if (!isOffscreenSender(sender)) { reply({ ok: false, error: 'forbidden' }); return false; }
    const fn = PROXY_OPS[msg.op];
    if (!fn) { reply({ ok: false, error: 'op' }); return false; }
    fn(msg.args || {}).then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'sync') {
    if (from !== 'page') return false;
    if (msg.op === 'now') {
      requestSync({ isArchiveRunning, reason: 'panel' }).then(async (r) => reply({ ...(await syncState()), skipped: r?.skipped || null }));
    } else {
      syncState().then(reply);
    }
    return true;
  }
  // The shared rate limiter: a panel or content script asks for a slot before
  // it fetches Schoology, and reports when it hit the limit. Never the token
  // or the server — this is just pacing.
  if (msg?.type === 'schoologySlot') {
    if (from !== 'page' && from !== 'content') return false;
    limiter.acquire().then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.type === 'schoologyRateLimited') {
    if (from !== 'page' && from !== 'content') return false;
    limiter.pause();
    persistPausedUntil();
    return false;
  }
  return false;
});

// Kill switch: Alt+Shift+K from any tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'kill-archiver') return;
  chrome.runtime.sendMessage({ type: 'kill' }).catch(() => {});
  await killEverything();
});

// ── neo-plan sync: every 15 minutes, when a Schoology page loads, or from the panel ──
async function ensureAlarm() {
  const a = await chrome.alarms.get(SYNC_ALARM);
  if (!a || a.periodInMinutes !== SYNC_EVERY_MIN) {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MIN, delayInMinutes: 1 });
  }
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); restorePausedUntil(); });
ensureAlarm().catch(() => {}); // and whenever the worker starts, in case the alarm was lost
restorePausedUntil().catch(() => {}); // the worker may have been killed mid-pause; pick it back up

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) requestSync({ isArchiveRunning, reason: 'alarm' }).catch(() => {});
  if (alarm.name === SYNC_SOON_ALARM) requestSync({ isArchiveRunning, reason: 'tab' }).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const m = (tab?.url || '').match(/^https:\/\/([a-z0-9-]+\.schoology\.com)\//i);
  if (!m || m[1].toLowerCase() === 'app.schoology.com') return;
  await chrome.storage.local.set({ [KEY_HOST]: m[1].toLowerCase() });
  if (syncRunning()) return;
  const snap = (await chrome.storage.local.get(KEY_SNAPSHOT))[KEY_SNAPSHOT];
  if (snap?.at && Date.now() - Date.parse(snap.at) < TAB_SYNC_GAP_MS) return;
  // Don't start a sync the instant the page finishes loading — that collides
  // with Schoology's own page-load burst against the same 15-per-5s limit.
  // A short one-shot alarm lets that burst finish first.
  if (await chrome.alarms.get(SYNC_SOON_ALARM)) return;
  await chrome.alarms.create(SYNC_SOON_ALARM, { delayInMinutes: 0.5 });
});

async function killEverything() {
  stopSync();
  if (archiveActive) chrome.runtime.sendMessage({ type: 'archiveStop', target: 'offscreen' }).catch(() => {});
  const running = await chrome.downloads.search({ state: 'in_progress' });
  await Promise.all(running.filter((d) => d.byExtensionId === chrome.runtime.id)
    .map((d) => chrome.downloads.cancel(d.id).catch(() => {})));
  const { reviewTabs = [] } = await chrome.storage.session.get('reviewTabs');
  await Promise.all(reviewTabs.map((id) => chrome.tabs.remove(id).catch(() => {})));
  await chrome.storage.session.remove('reviewTabs');
  try { await chrome.downloads.setUiOptions({ enabled: true }); } catch { /* ignore */ }
}
