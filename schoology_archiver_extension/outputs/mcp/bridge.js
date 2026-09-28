// The extension side of the local MCP bridge (docs/MCP-BRIDGE.md, binding —
// don't change without updating it there too): a WebSocket client, in the
// service worker, to each free port among 47815-47819 a local MCP server may
// be listening on. One socket per port; an already-open port is left alone.
// background.js calls connectBridge() when the worker starts and on its
// 1-minute `mcp-connect` alarm (MV3 kills this worker at will, so the alarm —
// not just the one call at startup — is what actually keeps reconnecting).
// A port is probed with a plain fetch before any WebSocket is opened: Chrome
// files every refused WebSocket on chrome://extensions → Errors (it can't be
// caught), while a refused fetch just rejects. So with Claude Desktop closed,
// the once-a-minute check leaves nothing behind.

import { SchoologyClient } from '../../reader/client.js';
import { limiter, persistPausedUntil } from '../../sync/limiter.js';
import { schoologyHost, offscreenParse } from '../../sync/runner.js';
import { KEY_SNAPSHOT } from '../../sync/sync.js';
import { runMcpOp } from './ops.js';

const PORTS = [47815, 47816, 47817, 47818, 47819];
const PING_MS = 20_000;

const sockets = new Map(); // port -> WebSocket
let pingTimer = null;
let paused = false; // quiz quiet mode (sync/quiet.js): no sockets at all

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* socket just closed under us */ }
}

async function helloMessage() {
  return { type: 'hello', version: chrome.runtime.getManifest().version, host: await schoologyHost() };
}

async function snapshotMessage() {
  const got = await chrome.storage.local.get(KEY_SNAPSHOT);
  return { type: 'snapshot', snapshot: got[KEY_SNAPSHOT] || null };
}

function ensurePing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    if (!sockets.size) { clearInterval(pingTimer); pingTimer = null; return; }
    for (const ws of sockets.values()) send(ws, { type: 'ping' });
    // While the worker is up anyway, pick up a newly started server (Claude
    // Desktop relaunched) now rather than on the next 1-minute alarm.
    connectBridge();
  }, PING_MS);
}

// A fresh SchoologyClient per request, on the shared limiter — the same
// construction sync/runner.js's requestSync uses, tab-mode fallback included
// (ops.js falls back to an open Schoology tab itself when a direct fetch
// isn't signed in). `fetch` is the plain global one — only `opFile` (raw
// attachment/Google bytes) uses it, on the same shared limiter via
// client.throttle().
async function newDeps() {
  const client = new SchoologyClient({
    host: await schoologyHost(),
    log: () => {},
    acquire: (s) => limiter.acquire(s),
    onRateLimited: () => { limiter.pause(); persistPausedUntil(); },
  });
  return { client, parse: offscreenParse, fetch: (...args) => fetch(...args) };
}

async function respond(ws, id, r) {
  const msg = { type: 'response', id, ok: !!r.ok };
  if (r.ok) msg.data = r.data;
  else {
    msg.error = r.error;
    if (r.message) msg.message = r.message;
  }
  send(ws, msg);
}

function onMessage(ws, ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg?.type !== 'request' || typeof msg.id === 'undefined') return; // 'pong' and anything else: nothing to do
  if (paused) { respond(ws, msg.id, { ok: false, error: 'quiz', message: 'A Schoology quiz is open; the extension is paused.' }); return; }
  newDeps()
    .then((deps) => runMcpOp(msg.op, msg.args, deps))
    .then((r) => respond(ws, msg.id, r), (e) => respond(ws, msg.id, { ok: false, error: 'schoology', message: String(e?.message || e) }));
}

const probing = new Set();

// Is anything listening on `port`? The MCP server's WebSocket server answers
// a plain GET (426 Upgrade Required); no-cors, since only reachability matters.
async function listening(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function connectPort(port) {
  if (sockets.has(port) || probing.has(port)) return;
  probing.add(port);
  const up = await listening(port);
  probing.delete(port);
  if (!up || paused || sockets.has(port)) return;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    return; // a bad port number or similar; nothing to connect to
  }
  sockets.set(port, ws);
  const drop = () => { if (sockets.get(port) === ws) sockets.delete(port); };
  ws.addEventListener('open', async () => {
    ensurePing();
    send(ws, await helloMessage());
    send(ws, await snapshotMessage());
  });
  ws.addEventListener('message', (ev) => onMessage(ws, ev));
  // The server went away (not closeBridge, which unregisters first): retry soon.
  ws.addEventListener('close', () => { if (sockets.get(port) === ws) { drop(); scheduleRetry(); } });
  ws.addEventListener('error', () => { const ours = sockets.get(port) === ws; try { ws.close(); } catch { /* already closing */ } drop(); if (ours) scheduleRetry(); });
}

// A server that just went away is usually being restarted: look again after
// a few seconds instead of waiting up to a minute for the alarm.
const RETRY_MS = [2_000, 5_000, 10_000, 20_000];
let retryTimer = null;
function scheduleRetry(i = 0) {
  if (retryTimer || i >= RETRY_MS.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectBridge();
    // Ports connect asynchronously; check once more on the next step.
    setTimeout(() => { if (!sockets.size) scheduleRetry(i + 1); }, 3_000);
  }, RETRY_MS[i]);
}

/** Connect to every port in range not already connected. Worker start + the `mcp-connect` alarm. */
export function connectBridge() {
  if (paused) return;
  for (const port of PORTS) connectPort(port).catch(() => {});
}

/** Push the latest Snapshot to every open socket. Called after each sync run finishes. */
export async function pushSnapshot() {
  if (!sockets.size) return;
  const m = await snapshotMessage();
  for (const ws of sockets.values()) send(ws, m);
}

/** Kill switch: close every socket now. The next `mcp-connect` alarm reconnects. */
export function closeBridge() {
  const open = [...sockets.values()];
  sockets.clear();
  for (const ws of open) { try { ws.close(); } catch { /* already closed */ } }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

/** Quiz quiet mode: close every socket and stay closed until unpaused. */
export function setBridgePaused(p) {
  paused = !!p;
  if (paused) closeBridge();
}

/** Whether any MCP server is connected right now — the Settings "Claude" row. */
export function bridgeConnected() {
  return sockets.size > 0;
}
