// The service worker's side of the sync: when it may run (run lock, not
// twice at once, not while an Archive runs), which Schoology site, the
// offscreen parser, and the keep-alive. sync.js is the run itself.

import { SchoologyClient } from '../reader/client.js';
import { handleNeoplan } from '../outputs/neoplan/api.js';
import { runSync, KEY_SNAPSHOT, submittedPayload } from './sync.js';

export const SYNC_LOCK_ID = 'sync';
export const KEY_HOST = 'schoologyHost';
export const DEFAULT_HOST = 'fuhsd.schoology.com';
const KEY_REPORTED = 'submittedReported'; // { schoology_id: ms } — one enrich per submit is enough
const OFFSCREEN_URL = 'offscreen/parse.html';

let current = null; // the running sync's promise, in this service worker
let controller = null;

export const syncRunning = () => current;

/** Abort a running sync (kill switch). */
export function stopSync() {
  controller?.abort();
}

// ── Offscreen parser ─────────────────────────────────────────────────────
let creating = null;
async function ensureOffscreen() {
  const have = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)] });
  if (have?.length) return;
  creating ||= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Read Schoology pages (HTML) for the neo-plan sync',
  }).catch((e) => { if (!/single offscreen|already/i.test(String(e?.message))) throw e; }).finally(() => { creating = null; });
  await creating;
}

export async function offscreenParse(kind, text, url) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ type: 'parse', target: 'offscreen', kind, text, url });
  if (!r?.ok) throw new Error(r?.error || 'parser did not answer');
  return r.result;
}

// ── Which Schoology ──────────────────────────────────────────────────────
export async function schoologyHost() {
  const got = await chrome.storage.local.get([KEY_HOST, 'options']);
  const h = got[KEY_HOST] || got.options?.host || DEFAULT_HOST;
  return /^[a-z0-9-]+\.schoology\.com$/i.test(h) ? h : DEFAULT_HOST;
}

// ── One run ──────────────────────────────────────────────────────────────
/**
 * Runs a sync unless one is running (returns that one) or an Archive holds
 * the run lock (returns { skipped: 'busy' }). `isArchiveRunning(running)`
 * says whether the lock's holder is a live archive panel.
 */
export function requestSync({ isArchiveRunning, parse = offscreenParse, np = handleNeoplan, reason = '' } = {}) {
  if (current) return current;
  current = (async () => {
    const { running } = await chrome.storage.session.get('running');
    if (running?.id && running.id !== SYNC_LOCK_ID && isArchiveRunning(running)) return { skipped: 'busy' };
    await chrome.storage.session.set({ running: { id: SYNC_LOCK_ID, since: Date.now(), reason } });
    controller = new AbortController();
    const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo?.().catch?.(() => {}); }, 20_000);
    try {
      const client = new SchoologyClient({ host: await schoologyHost(), log: () => {}, signal: controller.signal });
      return await runSync({
        client,
        parse,
        np: (op, args = {}) => np({ type: 'neoplan', op, ...args }),
        storage: chrome.storage.local,
      });
    } finally {
      clearInterval(keepAlive);
      controller = null;
      const { running: r } = await chrome.storage.session.get('running');
      if (r?.id === SYNC_LOCK_ID) await chrome.storage.session.remove('running');
    }
  })().finally(() => { current = null; });
  return current;
}

// ── Submit detection ─────────────────────────────────────────────────────
/** The assignment page saw "submitted": one enrich for that item, once. */
export async function reportSubmitted({ schoology_id, late }, np = handleNeoplan) {
  const id = String(schoology_id ?? '');
  if (!/^\d{1,20}$/.test(id)) return { ok: false, status: 400, data: { error: 'body' } };
  const got = await chrome.storage.local.get([KEY_REPORTED, KEY_SNAPSHOT]);
  const reported = got[KEY_REPORTED] || {};
  if (reported[id]) return { ok: true, status: 200, data: { already: true } };
  const section_id = got[KEY_SNAPSHOT]?.sectionOf?.[id] || null;
  const r = await np({ type: 'neoplan', op: 'enrich', body: submittedPayload({ schoology_id: id, late, section_id }, new Date().toISOString()) });
  // Remembered only once neo-plan knew the item: one added later still gets its enrich.
  const known = r.ok && !(r.data?.results || []).some((x) => (x.did || []).includes('unknown'));
  if (known) {
    reported[id] = Date.now();
    const keys = Object.keys(reported);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete reported[k];
    await chrome.storage.local.set({ [KEY_REPORTED]: reported });
  }
  return r;
}

/** Realm "Course : Section" → section_id, from the last Snapshot. */
export async function sectionForRealm(realm) {
  const snap = (await chrome.storage.local.get(KEY_SNAPSHOT))[KEY_SNAPSHOT];
  const key = String(realm || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) return null;
  const c = (snap?.courses || []).find((x) => `${x.title} : ${x.section_title}`.replace(/\s+/g, ' ').trim().toLowerCase() === key);
  return c?.section_id || null;
}
