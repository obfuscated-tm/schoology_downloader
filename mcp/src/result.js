// Shared envelope helpers: every tool result states source + as_of, plus an
// optional one-line fallback note.

export function liveResult(data, extra = {}) {
  return { source: "live", as_of: new Date().toISOString(), ...extra, ...data };
}

export function snapshotResult(data, as_of, note, extra = {}) {
  return {
    source: "snapshot",
    as_of: as_of || null,
    ...(note ? { note } : {}),
    ...extra,
    ...data,
  };
}

export function archiveResult(data, as_of, note, extra = {}) {
  return {
    source: "archive",
    as_of: as_of || null,
    ...(note ? { note } : {}),
    ...extra,
    ...data,
  };
}

export function toToolResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function toErrorResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Try a live extension op; on any failure, return null (with the reason)
 * so callers can fall back. On success, also persists the result to cache.
 */
export async function tryLive(ctx, op, args) {
  if (!ctx.bridge || !ctx.bridge.isConnected()) {
    return { ok: false, reason: "no extension connected" };
  }
  try {
    const data = await ctx.bridge.request(op, args);
    await ctx.cache.setLive(op, args, data);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}
