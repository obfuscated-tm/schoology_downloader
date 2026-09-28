import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

let mcpHome;
let cachePath;
let DiskCache;

before(async () => {
  mcpHome = await fs.mkdtemp(path.join(os.tmpdir(), "schoology-mcp-cache-"));
  cachePath = path.join(mcpHome, "cache.json");
  ({ DiskCache } = await import("../src/cache.js"));
});

after(async () => {
  await fs.rm(mcpHome, { recursive: true, force: true });
});

test("snapshot persists to disk and survives a fresh DiskCache instance (simulated restart)", async () => {
  const cache1 = new DiskCache(cachePath);
  await cache1.load();
  await cache1.setSnapshot({ courses: [{ section_id: "1", title: "A" }], lists: { upcoming: [] } });

  // Simulate a restart: a brand new process would construct a fresh DiskCache
  // and load() it from the same path.
  const cache2 = new DiskCache(cachePath);
  await cache2.load();
  const snap = cache2.getSnapshot();
  assert.ok(snap);
  assert.equal(snap.snapshot.courses[0].title, "A");
  assert.ok(snap.receivedAt);
});

test("live results are cached per (op, args) key and survive reload", async () => {
  const cache1 = new DiskCache(cachePath);
  await cache1.load();
  await cache1.setLive("grades", { section_id: "42" }, { rows: [{ item: "HW1" }] });

  const cache2 = new DiskCache(cachePath);
  await cache2.load();
  const live = cache2.getLive("grades", { section_id: "42" });
  assert.ok(live);
  assert.equal(live.data.rows[0].item, "HW1");

  // A different args object hits a different key.
  assert.equal(cache2.getLive("grades", { section_id: "99" }), null);
});

test("cache.json is written atomically (no partial file left behind under concurrent writes)", async () => {
  const cache = new DiskCache(cachePath);
  await cache.load();
  await Promise.all([
    cache.setLive("todo", {}, { a: 1 }),
    cache.setLive("courses", {}, { b: 2 }),
    cache.setSnapshot({ c: 3 }),
  ]);
  const raw = await fs.readFile(cachePath, "utf8");
  const parsed = JSON.parse(raw); // must not throw on a half-written file
  assert.ok(parsed.snapshot);
  assert.ok(parsed.live);
});
