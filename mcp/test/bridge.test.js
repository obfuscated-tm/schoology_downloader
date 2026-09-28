import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.js";
import { FakeExtension } from "./fixtures/fake-extension.js";

// Use a high, unlikely-to-collide port range for tests so we never fight a
// real schoology-mcp instance bound to 47815-47819.
function testPortRange() {
  const base = 48000 + Math.floor(Math.random() * 1000);
  return [base, base + 1, base + 2];
}

test("rejects a handshake whose Origin is not chrome-extension://", async () => {
  const bridge = new Bridge({ portRange: testPortRange() });
  const port = await bridge.start();
  assert.ok(port, "bridge should bind a port");

  const badExt = new FakeExtension(port, { origin: "https://evil.example.com" });
  await assert.rejects(() => badExt.connect(), /handshake rejected: 403/);

  assert.equal(bridge.isConnected(), false);
  await bridge.stop();
});

test("accepts chrome-extension:// origin and answers request/response", async () => {
  const bridge = new Bridge({ portRange: testPortRange() });
  const port = await bridge.start();

  const ext = new FakeExtension(port, {
    handler: (op, args) => {
      if (op === "courses") return [{ section_id: "42", title: "Test Course" }];
      throw Object.assign(new Error("unexpected op"), { code: "bad_args" });
    },
  });
  await ext.connect();

  // give the server a tick to register the connection
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.isConnected(), true);

  const data = await bridge.request("courses", {});
  assert.deepEqual(data, [{ section_id: "42", title: "Test Course" }]);

  await ext.close();
  await bridge.stop();
});

test("request rejects when no extension is connected", async () => {
  const bridge = new Bridge({ portRange: testPortRange() });
  await bridge.start();
  await assert.rejects(() => bridge.request("courses", {}), /no extension connected/);
  await bridge.stop();
});

test("request times out and can be treated as a fallback trigger", async () => {
  const bridge = new Bridge({ portRange: testPortRange(), timeoutMs: 150 });
  const port = await bridge.start();

  // Extension connects but never answers requests.
  const ext = new FakeExtension(port, { handler: () => new Promise(() => {}) });
  await ext.connect();
  await new Promise((r) => setTimeout(r, 50));

  await assert.rejects(() => bridge.request("todo", {}), /timed out/);

  await ext.close();
  await bridge.stop();
});

test("uses the most recently connected socket when several are open", async () => {
  const bridge = new Bridge({ portRange: testPortRange() });
  const port = await bridge.start();

  const ext1 = new FakeExtension(port, { handler: () => ({ from: "ext1" }) });
  await ext1.connect();
  await new Promise((r) => setTimeout(r, 30));

  const ext2 = new FakeExtension(port, { handler: () => ({ from: "ext2" }) });
  await ext2.connect();
  await new Promise((r) => setTimeout(r, 30));

  const data = await bridge.request("todo", {});
  assert.equal(data.from, "ext2");

  await ext1.close();
  await ext2.close();
  await bridge.stop();
});
