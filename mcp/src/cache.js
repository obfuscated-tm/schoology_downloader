// Disk cache: last snapshot + last live result per (op, args), atomic writes.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { CACHE_PATH } from "./config.js";
import { log } from "./log.js";

function emptyCache() {
  return {
    snapshot: null, // { snapshot, receivedAt }
    live: {}, // key -> { data, fetchedAt }
  };
}

export class DiskCache {
  constructor(cachePath = CACHE_PATH) {
    this.cachePath = cachePath;
    this.state = emptyCache();
    this._writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = { ...emptyCache(), ...parsed };
    } catch (err) {
      if (err.code !== "ENOENT") {
        log(`cache: could not read ${this.cachePath}: ${err.message}`);
      }
      this.state = emptyCache();
    }
    return this.state;
  }

  _persist() {
    // Serialize writes so concurrent updates don't race on the temp file.
    this._writeQueue = this._writeQueue
      .then(() => this._writeNow())
      .catch((err) => log(`cache: write failed: ${err.message}`));
    return this._writeQueue;
  }

  async _writeNow() {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tmp, this.cachePath);
  }

  setSnapshot(snapshot) {
    this.state.snapshot = { snapshot, receivedAt: new Date().toISOString() };
    return this._persist();
  }

  getSnapshot() {
    return this.state.snapshot;
  }

  liveKey(op, args) {
    return `${op}:${JSON.stringify(args || {}, Object.keys(args || {}).sort())}`;
  }

  setLive(op, args, data) {
    const key = this.liveKey(op, args);
    this.state.live[key] = { data, fetchedAt: new Date().toISOString() };
    return this._persist();
  }

  getLive(op, args) {
    return this.state.live[this.liveKey(op, args)] || null;
  }
}

export function cacheExistsSync(cachePath = CACHE_PATH) {
  return fsSync.existsSync(cachePath);
}
