import { handleNeoplan } from './outputs/neoplan/api.js';

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

// Only one archive at a time, across all windows.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'neoplan') {
    // Only this extension's own pages may drive neo-plan with the stored token.
    if (sender.id !== chrome.runtime.id) return false;
    handleNeoplan(msg).then(reply);
    return true; // async reply
  }
  if (msg?.type === 'claim') {
    chrome.storage.session.get('running').then(async ({ running }) => {
      if (running?.id && running.id !== msg.id && panels.has(running.id)) {
        reply({ ok: false });
      } else {
        await chrome.storage.session.set({ running: { id: msg.id, courseId: msg.courseId } });
        reply({ ok: true });
      }
    });
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

async function killEverything() {
  const running = await chrome.downloads.search({ state: 'in_progress' });
  await Promise.all(running.filter((d) => d.byExtensionId === chrome.runtime.id)
    .map((d) => chrome.downloads.cancel(d.id).catch(() => {})));
  const { reviewTabs = [] } = await chrome.storage.session.get('reviewTabs');
  await Promise.all(reviewTabs.map((id) => chrome.tabs.remove(id).catch(() => {})));
  await chrome.storage.session.remove('reviewTabs');
  try { await chrome.downloads.setUiOptions({ enabled: true }); } catch { /* ignore */ }
}
