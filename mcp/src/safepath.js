// Resolve a path relative to the archive root, rejecting traversal and symlink escapes.
import fs from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_ROOT } from "./config.js";

export class PathEscapeError extends Error {
  constructor(p) {
    super(`Path "${p}" escapes the archive root`);
    this.name = "PathEscapeError";
  }
}

/**
 * Resolve `relPath` (relative to ARCHIVE_ROOT) to an absolute, realpath-resolved
 * path guaranteed to be inside ARCHIVE_ROOT. Throws PathEscapeError otherwise.
 * If the target doesn't exist, only lexical containment is checked (realpath
 * is checked on the deepest existing ancestor).
 */
export async function resolveArchivePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathEscapeError(relPath);
  }
  // Reject absolute paths and null bytes outright.
  if (relPath.includes("\0")) throw new PathEscapeError(relPath);
  const normalizedRoot = path.resolve(ARCHIVE_ROOT);
  const candidate = path.resolve(normalizedRoot, relPath);
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
    throw new PathEscapeError(relPath);
  }

  // Walk the path segment by segment, realpath-ing each existing ancestor,
  // to catch a symlink inside the archive that points outside it.
  let real;
  try {
    real = await fs.realpath(normalizedRoot);
  } catch {
    // Archive root itself missing; nothing to resolve against.
    return candidate;
  }

  const rel = path.relative(normalizedRoot, candidate);
  const parts = rel.split(path.sep).filter(Boolean);
  let current = real;
  for (const part of parts) {
    const next = path.join(current, part);
    let resolved;
    try {
      resolved = await fs.realpath(next);
    } catch {
      // Doesn't exist yet (or unreadable) — nothing more can be a symlink below here.
      current = next;
      continue;
    }
    if (resolved !== real && !resolved.startsWith(real + path.sep)) {
      throw new PathEscapeError(relPath);
    }
    current = resolved;
  }
  return candidate;
}
