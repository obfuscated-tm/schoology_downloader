// The service worker has no DOMParser, so the sync hands page text here and
// gets plain data back. Parse only: this page never fetches anything.
import { parseKind } from '../reader/parse/sync.js';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'parse' || msg.target !== 'offscreen') return false;
  if (sender.id !== chrome.runtime.id) return false;
  try {
    reply({ ok: true, result: parseKind(msg.kind, msg.text, msg.url) });
  } catch (e) {
    reply({ ok: false, error: String(e?.message || e) });
  }
  return false;
});
