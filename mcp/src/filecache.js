// Bytes fetched live (the `file` op, or fetch_page's web fetches) cached on
// disk under ~/.schoology-mcp/files/, keyed by a hash of the URL. Each entry
// is a {key}.json sidecar (small metadata) plus a {key}.bin (raw bytes).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { FILES_DIR } from "./config.js";

function keyFor(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex");
}

function pathsFor(url, dir) {
  const key = keyFor(url);
  return {
    metaPath: path.join(dir, `${key}.json`),
    dataPath: path.join(dir, `${key}.bin`),
  };
}

/** Read a cached file by the URL it was fetched from. Returns null if not cached. */
export async function readCachedFile(url, dir = FILES_DIR) {
  const { metaPath, dataPath } = pathsFor(url, dir);
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    const data = await fs.readFile(dataPath);
    return { meta, data };
  } catch {
    return null;
  }
}

/** Write bytes fetched from `url` to the cache, alongside JSON-serializable `meta`. */
export async function writeCachedFile(url, meta, data, dir = FILES_DIR) {
  await fs.mkdir(dir, { recursive: true });
  const { metaPath, dataPath } = pathsFor(url, dir);
  const tmpMeta = `${metaPath}.${process.pid}.tmp`;
  const tmpData = `${dataPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpData, data);
  await fs.rename(tmpData, dataPath);
  await fs.writeFile(tmpMeta, JSON.stringify(meta), "utf8");
  await fs.rename(tmpMeta, metaPath);
}
