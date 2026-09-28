// Smoke-tests the real server.js over stdio: spawn it, initialize, list
// tools, and call `status` + `list_courses` against the real Schoology
// Archive on disk (read-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "server.js");

function rpc(child, buffer, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 15_000);
    function onLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === id) {
        buffer.off("line", onLine);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
    buffer.on("line", onLine);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n",
    );
  });
}

// Minimal line-splitter over stdout, since MCP stdio frames are newline-delimited JSON.
function lineEmitter(child) {
  const emitter = new EventEmitter();
  let carry = "";
  child.stdout.on("data", (chunk) => {
    carry += chunk.toString("utf8");
    let idx;
    while ((idx = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, idx);
      carry = carry.slice(idx + 1);
      if (line.trim()) emitter.emit("line", line);
    }
  });
  return emitter;
}

test("real stdio server: initialize, tools/list, tools/call status + list_courses", async () => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const stderrLines = [];
  child.stderr.on("data", (d) => stderrLines.push(d.toString()));

  const emitter = lineEmitter(child);
  let id = 0;

  try {
    const initResult = await rpc(child, emitter, ++id, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    });
    assert.ok(initResult.serverInfo);
    assert.equal(initResult.serverInfo.name, "schoology-mcp");

    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
    );

    const toolsList = await rpc(child, emitter, ++id, "tools/list", {});
    const names = toolsList.tools.map((t) => t.name);
    for (const expected of [
      "status",
      "list_courses",
      "get_todo",
      "get_grades",
      "get_assignment",
      "get_updates",
      "list_materials",
      "read_file",
      "search",
    ]) {
      assert.ok(names.includes(expected), `expected tool ${expected} to be registered`);
    }

    const statusResult = await rpc(child, emitter, ++id, "tools/call", {
      name: "status",
      arguments: {},
    });
    const statusPayload = JSON.parse(statusResult.content[0].text);
    assert.equal(statusPayload.extension_connected, false);
    assert.ok(typeof statusPayload.archive_path === "string");

    const listResult = await rpc(child, emitter, ++id, "tools/call", {
      name: "list_courses",
      arguments: {},
    });
    const listPayload = JSON.parse(listResult.content[0].text);
    assert.ok(Array.isArray(listPayload.courses));
  } finally {
    child.kill();
  }
});
