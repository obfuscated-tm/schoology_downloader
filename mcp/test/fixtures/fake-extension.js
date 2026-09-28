// A fake Chrome extension: connects to the bridge over ws with a
// chrome-extension:// Origin header and answers `request` messages.
import WebSocket from "ws";

export class FakeExtension {
  /**
   * @param {number} port
   * @param {object} opts
   * @param {string} [opts.origin] defaults to a plausible chrome-extension origin
   * @param {(op: string, args: object) => any} [opts.handler] returns data, or throws {code, message}
   */
  constructor(port, { origin = "chrome-extension://test", handler } = {}) {
    this.port = port;
    this.origin = origin;
    this.handler = handler || (() => ({}));
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, {
        headers: { Origin: this.origin },
      });
      this.ws = ws;
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "hello", version: "1.0", host: "fuhsd.schoology.com" }));
        resolve(this);
      });
      ws.once("error", reject);
      ws.once("unexpected-response", (req, res) => {
        reject(Object.assign(new Error(`handshake rejected: ${res.statusCode}`), { statusCode: res.statusCode }));
      });
      ws.on("message", (raw) => this._onMessage(raw));
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "ping") {
      this.ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "request") {
      Promise.resolve()
        .then(() => this.handler(msg.op, msg.args))
        .then((data) => {
          this.ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, data }));
        })
        .catch((err) => {
          this.ws.send(
            JSON.stringify({
              type: "response",
              id: msg.id,
              ok: false,
              error: err.code || "schoology",
              message: err.message,
            }),
          );
        });
    }
  }

  sendSnapshot(snapshot) {
    this.ws.send(JSON.stringify({ type: "snapshot", snapshot }));
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}
