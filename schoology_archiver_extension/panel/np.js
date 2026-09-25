// The panel's only way to reach neo-plan: a message to the service worker,
// which holds the token and does the fetch (outputs/neoplan/api.js).
// Always resolves to { ok, status, data }.
export async function np(op, args = {}) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'neoplan', op, ...args });
    return r && typeof r === 'object' ? r : { ok: false, status: 0, data: { error: 'extension' } };
  } catch {
    return { ok: false, status: 0, data: { error: 'extension' } };
  }
}
