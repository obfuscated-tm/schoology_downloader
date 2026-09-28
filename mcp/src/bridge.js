// The WebSocket bridge to the Chrome extension. See docs/MCP-BRIDGE.md.
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { BRIDGE_PORT_RANGE, EXT_ID, REQUEST_TIMEOUT_MS } from "./config.js";
import { log } from "./log.js";

function originAllowed(origin) {
  if (!origin || !origin.startsWith("chrome-extension://")) return false;
  if (EXT_ID) return origin === `chrome-extension://${EXT_ID}`;
  return true;
}

export class Bridge {
  /**
   * @param {object} opts
   * @param {(snapshot: object) => void} opts.onSnapshot called whenever the
   *   extension pushes a `snapshot` message.
   */
  constructor({ onSnapshot, timeoutMs, portRange } = {}) {
    this.onSnapshot = onSnapshot || (() => {});
    this.timeoutMs = timeoutMs || REQUEST_TIMEOUT_MS;
    this.portRange = portRange || BRIDGE_PORT_RANGE;
    this.server = null;
    this.port = null;
    /** @type {Map<string, {socket: import('ws').WebSocket, connectedAt: number, host?: string, version?: string}>} */
    this.sockets = new Map();
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.lastSnapshotAt = null;
  }

  /** Bind the first free port in BRIDGE_PORT_RANGE. Returns the port, or null if none are free. */
  async start() {
    for (const port of this.portRange) {
      const ok = await this._tryBind(port);
      if (ok) {
        this.port = port;
        log(`bridge: listening on ws://127.0.0.1:${port}`);
        return port;
      }
    }
    log("bridge: no free port in 47815-47819; running archive/snapshot-only");
    return null;
  }

  _tryBind(port) {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port,
        verifyClient: (info, cb) => {
          const origin = info.req.headers.origin;
          if (originAllowed(origin)) return cb(true);
          log(`bridge: rejected handshake from origin ${origin}`);
          cb(false, 403, "Forbidden origin");
        },
      });
      wss.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          resolve(false);
        } else {
          log(`bridge: error binding port ${port}: ${err.message}`);
          resolve(false);
        }
      });
      wss.once("listening", () => {
        this.server = wss;
        this._wire(wss);
        resolve(true);
      });
    });
  }

  _wire(wss) {
    wss.on("connection", (socket) => {
      const id = randomUUID();
      const entry = { socket, connectedAt: Date.now() };
      this.sockets.set(id, entry);
      log(`bridge: extension connected (${id})`);

      socket.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this._handleMessage(id, entry, msg);
      });

      socket.on("close", () => {
        this.sockets.delete(id);
        log(`bridge: extension disconnected (${id})`);
      });

      socket.on("error", (err) => {
        log(`bridge: socket error (${id}): ${err.message}`);
      });
    });
  }

  _handleMessage(id, entry, msg) {
    switch (msg.type) {
      case "hello":
        entry.host = msg.host;
        entry.version = msg.version;
        break;
      case "snapshot":
        this.lastSnapshotAt = new Date().toISOString();
        this.onSnapshot(msg.snapshot);
        break;
      case "ping":
        try {
          entry.socket.send(JSON.stringify({ type: "pong" }));
        } catch {
          /* ignore */
        }
        break;
      case "response": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(Object.assign(new Error(msg.message || msg.error || "schoology"), { code: msg.error }));
        break;
      }
      default:
        break;
    }
  }

  /** The most recently connected extension socket, or null if none. */
  _mostRecentSocket() {
    let best = null;
    for (const entry of this.sockets.values()) {
      if (!best || entry.connectedAt > best.connectedAt) best = entry;
    }
    return best;
  }

  isConnected() {
    return this.sockets.size > 0;
  }

  connectionInfo() {
    const entry = this._mostRecentSocket();
    if (!entry) return null;
    return {
      host: entry.host || null,
      version: entry.version || null,
      connectedAt: new Date(entry.connectedAt).toISOString(),
    };
  }

  /**
   * Send a request op to the extension and await its response.
   * Rejects if no extension is connected, or after REQUEST_TIMEOUT_MS.
   */
  request(op, args = {}) {
    const entry = this._mostRecentSocket();
    if (!entry) {
      return Promise.reject(Object.assign(new Error("no extension connected"), { code: "no_extension" }));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("extension request timed out"), { code: "timeout" }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        entry.socket.send(JSON.stringify({ type: "request", id, op, args }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}
