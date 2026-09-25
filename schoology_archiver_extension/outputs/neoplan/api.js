// neo-plan, from the service worker only. The panel (and, later, content
// scripts) send chrome.runtime.sendMessage({ type: 'neoplan', op, ... }) and get
// back { ok, status, data }. Nothing else in the extension fetches neo-plan or
// sees the raw token: the panel only ever gets it masked.
//
// No CORS: an MV3 service worker with host_permissions for the origin is not
// subject to it, and the neo-plan routes deliberately send no CORS headers.

// The only origins the manifest grants. Anything else would fail at fetch time,
// so it is refused when saved instead.
export const SERVERS = ['https://neo-plan.vercel.app', 'http://localhost:3000'];
export const DEFAULT_SERVER = SERVERS[0];

const KEY_SERVER = 'neoplanServer';
const KEY_TOKEN = 'neoplanToken';
const TIMEOUT_MS = 15_000;

export async function getConfig() {
  const got = await chrome.storage.local.get([KEY_SERVER, KEY_TOKEN]);
  const server = SERVERS.includes(got[KEY_SERVER]) ? got[KEY_SERVER] : DEFAULT_SERVER;
  return { server, token: typeof got[KEY_TOKEN] === 'string' ? got[KEY_TOKEN] : '' };
}

/** "np_••••••••a1b2": enough to recognise which token, never enough to use it. */
export function maskToken(token) {
  if (!token) return '';
  return `${token.slice(0, 3)}••••••••${token.slice(-4)}`;
}

export function validToken(token) {
  return /^np_\S{8,}$/.test(token);
}

/**
 * The request for one API op, as data — pure, so it can be tested without
 * Chrome. Returns null for an op that is not an API call.
 */
export function buildRequest(server, token, msg) {
  const base = `${server}/api/extension`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const item = (suffix) => `${base}/items/${encodeURIComponent(String(msg.id ?? ''))}/${suffix}`;
  switch (msg.op) {
    case 'today':
      return { url: `${base}/today`, init: { method: 'GET', headers } };
    case 'work':
      if (msg.work !== 'todo' && msg.work !== 'ready') throw new Error(`bad work value: ${msg.work}`);
      return {
        url: item('work'),
        init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ work: msg.work }) },
      };
    case 'turnIn':
      return { url: item('turn-in'), init: { method: 'POST', headers } };
    case 'putBack':
      return { url: item('put-back'), init: { method: 'POST', headers } };
    default:
      return null;
  }
}

async function call(msg) {
  const { server, token } = await getConfig();
  // No token is the same state as a refused one: the panel shows setup.
  if (!token) return { ok: false, status: 401, data: { error: 'token' } };
  if (msg.op !== 'today' && !msg.id) return { ok: false, status: 400, data: { error: 'no_id' } };
  const req = buildRequest(server, token, msg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(req.url, { ...req.init, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    let data = null;
    try { data = await res.json(); } catch { /* empty or not JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e?.name === 'AbortError' ? 'timeout' : 'network' } };
  } finally {
    clearTimeout(timer);
  }
}

async function settings() {
  const { server, token } = await getConfig();
  return { ok: true, status: 200, data: { server, servers: SERVERS, hasToken: !!token, masked: maskToken(token) } };
}

/** Handles one { type: 'neoplan', op, ... } message. Always resolves. */
export async function handleNeoplan(msg) {
  try {
    switch (msg?.op) {
      case 'settings':
        return settings();
      case 'setServer':
        if (!SERVERS.includes(msg.server)) return { ok: false, status: 400, data: { error: 'server' } };
        await chrome.storage.local.set({ [KEY_SERVER]: msg.server });
        return settings();
      case 'setToken': {
        const token = String(msg.token ?? '').trim();
        if (!validToken(token)) return { ok: false, status: 400, data: { error: 'token_format' } };
        await chrome.storage.local.set({ [KEY_TOKEN]: token });
        return settings();
      }
      case 'removeToken':
        await chrome.storage.local.remove(KEY_TOKEN);
        return settings();
      case 'today':
      case 'work':
      case 'turnIn':
      case 'putBack':
        return await call(msg);
      default:
        return { ok: false, status: 400, data: { error: 'op' } };
    }
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e?.message || e) } };
  }
}
