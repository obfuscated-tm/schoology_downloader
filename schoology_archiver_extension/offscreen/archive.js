// The Archiver runs here, not in the service worker: it needs DOMParser
// (archiver.js, reader/client.js, reader/parse/*), which a service worker
// doesn't have. This document has no UI of its own — the card
// (overlays/archive.js) is just a view onto background.js's stored job
// state, so it can close, and the run keeps going here.
//
// Everything this needs besides chrome.runtime (storage, downloads, tabs,
// scripting) goes through outputs/archive/chrome-bridge.js, proxied to the
// service worker — see background.js's 'archiveProxy' handler.

import { Archiver } from '../outputs/archive/archiver.js';
import { LoginError } from '../reader/client.js';
import { getSavedFolder } from '../outputs/archive/folder.js';

let archiver = null;
let currentJobId = null;
let heartbeat = 0;

function post(msg) {
  chrome.runtime.sendMessage({ type: 'archiveProgress', jobId: currentJobId, ...msg }).catch(() => {});
}

// A folder chosen in Settings (panel/settings.html) is saved to IndexedDB,
// which this document shares with every extension page (same origin). There
// is no user gesture here to call requestPermission, so a folder that lost
// permission just falls back to Downloads, with one line saying so.
async function resolveFolder() {
  const folder = await getSavedFolder().catch(() => null);
  if (!folder) return null;
  const perm = await folder.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
  if (perm === 'granted') return folder;
  post({ log: `Lost permission for “${folder.name}”; saving to Downloads instead. Re-choose it in Settings.`, level: 'warn' });
  return null;
}

async function runArchive({ jobId, host, courseId, tabId, options }) {
  if (archiver) return { ok: false, error: 'busy' };
  currentJobId = jobId;
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { chrome.runtime.sendMessage({ type: 'archivePing' }).catch(() => {}); }, 20_000);
  try {
    const folder = await resolveFolder();
    archiver = new Archiver({
      host, courseId, tabId, folder, options,
      log: (msg, level) => post({ log: msg, level }),
      progress: (n) => post({ count: n }),
      onCourseName: (courseName) => post({ courseName }),
    });
    const r = await archiver.run();
    const s = r.stats;
    const summary = `${s.added.length} new, ${s.updated.length} updated, ${s.unchanged} unchanged, ${s.failed.length} problems`
      + (r.skipped ? `, ${r.skipped} pages skipped` : '');
    if (r.stopped) {
      post({ status: `Stopped — ${s.added.length + s.updated.length} files saved`, log: `Stopped. ${summary}.`, level: 'warn' });
      post({ log: 'Saved files are remembered; run again to continue. (INDEX.md updates on the next full run.)', level: 'warn' });
      post({ done: true, stopped: true, summary });
    } else {
      post({ status: `Done — ${summary}`, log: `Done: ${summary}` });
      post({ log: `Saved to ${r.location}/ (open INDEX.md there).` });
      if (s.failed.length) post({ log: 'Problems are listed at the top of INDEX.md.', level: 'warn' });
      post({ done: true, summary, location: r.location });
    }
    return { ok: true };
  } catch (e) {
    if (e?.name === 'StoppedError' || e?.name === 'AbortError') {
      post({ status: 'Stopped', log: 'Stopped before anything was saved.', level: 'warn', done: true, stopped: true });
    } else {
      const msg = e instanceof LoginError
        ? 'Not logged in. Sign in to Schoology in this Chrome window and try again.'
        : `Stopped with an error: ${e.message || e}`;
      post({ status: 'Failed', log: msg, level: 'error', done: true, error: msg });
    }
    return { ok: true };
  } finally {
    clearInterval(heartbeat);
    archiver = null;
    currentJobId = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'offscreen') return false;
  if (msg.type === 'archiveRun') {
    runArchive(msg).then(reply);
    return true;
  }
  if (msg.type === 'archiveStop') {
    if (archiver && !archiver.stopped) archiver.stop();
    reply({ ok: true });
    return true;
  }
  return false;
});
