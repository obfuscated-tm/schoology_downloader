// A live walk of a course's whole Materials tree: every folder opened
// through the extension's `materials` op, a few at a time (the extension's
// shared limiter still paces the actual Schoology requests), each row tagged
// with the folder path it sits in. Walks are kept in memory for WALK_TTL_MS,
// so a find_material across courses and a follow-up list are one walk, not two.

export const WALK_TTL_MS = 10 * 60 * 1000;
const MAX_FOLDERS = 200;
const CONCURRENCY = 4;

// Per bridge, `${section_id}:${folder_id||""}:${depth}` -> { at, promise }.
const walksByBridge = new WeakMap();

/**
 * Walk from `folder_id` (default root) down `depth` levels (1 = just that
 * folder). Resolves `{ rows, folders, truncated }`; each row is a `materials`
 * row plus `path` ("Unit 1 / Notes"; "" at the start folder). Throws only if
 * the start folder itself can't be listed.
 */
export function walkMaterials(bridge, section_id, { folder_id = null, depth = 6 } = {}) {
  if (!walksByBridge.has(bridge)) walksByBridge.set(bridge, new Map());
  const walks = walksByBridge.get(bridge);
  const key = `${section_id}:${folder_id || ""}:${depth}`;
  const hit = walks.get(key);
  if (hit && Date.now() - hit.at < WALK_TTL_MS) return hit.promise;
  const promise = doWalk(bridge, section_id, folder_id, depth);
  walks.set(key, { at: Date.now(), promise });
  promise.catch(() => walks.delete(key));
  return promise;
}

async function doWalk(bridge, section_id, folder_id, depth) {
  const rows = [];
  const failed = [];
  let folders = 0;
  let truncated = false;
  // Breadth-first queue of folders still to open.
  let level = [{ folder_id, path: "", d: 1 }];
  let first = true;
  while (level.length) {
    const next = [];
    for (let i = 0; i < level.length; i += CONCURRENCY) {
      const batch = level.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((f) => bridge.request("materials", { section_id, folder_id: f.folder_id || undefined })),
      );
      for (let j = 0; j < batch.length; j++) {
        const f = batch[j];
        const r = results[j];
        if (r.status === "rejected") {
          if (first) throw r.reason;
          failed.push({ path: f.path, error: r.reason?.message || String(r.reason) });
          continue;
        }
        folders++;
        for (const row of r.value?.rows || []) {
          rows.push({ ...row, path: f.path });
          if (row.kind !== "folder" || !row.id) continue;
          if (f.d >= depth) continue;
          if (folders + next.length >= MAX_FOLDERS) { truncated = true; continue; }
          next.push({ folder_id: row.id, path: f.path ? `${f.path} / ${row.title}` : row.title, d: f.d + 1 });
        }
      }
      first = false;
    }
    level = next;
  }
  return { rows, folders, truncated, ...(failed.length ? { failed } : {}) };
}

/** Case-insensitive: every word of `query` appears in the row's title or folder path. */
export function matchesQuery(row, query) {
  const hay = `${row.title || ""} ${row.path || ""}`.toLowerCase();
  return String(query).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
