import { handleNeoplan, getConfig } from './outputs/neoplan/api.js';
import { requestSync, stopSync, syncRunning, reportSubmitted, sectionForRealm, SYNC_LOCK_ID, KEY_HOST } from './sync/runner.js';
import { KEY_SNAPSHOT } from './sync/sync.js';

const SYNC_ALARM = 'neoplan-sync';
const SYNC_EVERY_MIN = 15;
const TAB_SYNC_GAP_MS = 5 * 60_000; // a Schoology page load starts a sync, at most every 5 min
// What a content script on a Schoology page may ask neo-plan. Never the token,
// the server, the course map or a raw enrich.
const CONTENT_OPS = new Set(['items', 'addItem', 'turnIn', 'putBack', 'remove', 'restore']);

// The archiver lives in Chrome's side panel so Schoology stays visible next to it.
// (A regular popup would close, and stop the archive, as soon as you click the page.)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Each open archiver panel keeps a port open. If the panel that is running an
// archive is closed, everything it started is cancelled (kill switch).
const panels = new Map(); // panelId -> port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'archiver-panel') return;
  let panelId = null;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'hello') {
      panelId = msg.id;
      panels.set(panelId, port);
    }
    // 'ping' messages just keep this service worker awake during long runs.
  });
  port.onDisconnect.addListener(async () => {
    if (panelId) panels.delete(panelId);
    const { running } = await chrome.storage.session.get('running');
    if (running?.id && running.id === panelId) {
      await killEverything();
      await chrome.storage.session.remove('running');
    }
  });
});

const isArchiveRunning = (running) => panels.has(running.id);

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
  if (msg.op === 'addItem' && msg.item && !msg.item.section_id && msg.item.realm) {
    msg = { ...msg, item: { ...msg.item, section_id: await sectionForRealm(msg.item.realm) } };
  }
  return handleNeoplan(msg);
}

async function syncState() {
  const snap = (await chrome.storage.local.get(KEY_SNAPSHOT))[KEY_SNAPSHOT] || null;
  return { running: !!syncRunning(), snapshot: snap };
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
  if (msg?.type === 'sync') {
    if (from !== 'page') return false;
    if (msg.op === 'now') {
      requestSync({ isArchiveRunning, reason: 'panel' }).then(async (r) => reply({ ...(await syncState()), skipped: r?.skipped || null }));
    } else {
      syncState().then(reply);
    }
    return true;
  }
  if (msg?.type === 'claim') {
    (async () => {
      // A sync holds the lock for a few seconds: the archive waits for it.
      const s = syncRunning();
      if (s) await s.catch(() => {});
      const { running } = await chrome.storage.session.get('running');
      if (running?.id && running.id !== msg.id && running.id !== SYNC_LOCK_ID && panels.has(running.id)) {
        reply({ ok: false });
      } else {
        await chrome.storage.session.set({ running: { id: msg.id, courseId: msg.courseId } });
        reply({ ok: true });
      }
    })();
    return true; // async reply
  }
  if (msg?.type === 'release') {
    chrome.storage.session.get('running').then(({ running }) => {
      if (running?.id === msg.id) chrome.storage.session.remove('running');
    });
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
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); });
ensureAlarm().catch(() => {}); // and whenever the worker starts, in case the alarm was lost

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) requestSync({ isArchiveRunning, reason: 'alarm' }).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const m = (tab?.url || '').match(/^https:\/\/([a-z0-9-]+\.schoology\.com)\//i);
  if (!m || m[1].toLowerCase() === 'app.schoology.com') return;
  await chrome.storage.local.set({ [KEY_HOST]: m[1].toLowerCase() });
  if (syncRunning()) return;
  const snap = (await chrome.storage.local.get(KEY_SNAPSHOT))[KEY_SNAPSHOT];
  if (snap?.at && Date.now() - Date.parse(snap.at) < TAB_SYNC_GAP_MS) return;
  requestSync({ isArchiveRunning, reason: 'tab' }).catch(() => {});
});

async function killEverything() {
  stopSync();
  const running = await chrome.downloads.search({ state: 'in_progress' });
  await Promise.all(running.filter((d) => d.byExtensionId === chrome.runtime.id)
    .map((d) => chrome.downloads.cancel(d.id).catch(() => {})));
  const { reviewTabs = [] } = await chrome.storage.session.get('reviewTabs');
  await Promise.all(reviewTabs.map((id) => chrome.tabs.remove(id).catch(() => {})));
  await chrome.storage.session.remove('reviewTabs');
  try { await chrome.downloads.setUiOptions({ enabled: true }); } catch { /* ignore */ }
}
