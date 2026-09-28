// Read-only access to the Schoology Archive folder on disk.
import fs from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_ROOT } from "./config.js";

const SECTION_LINK_RE = /schoology\.com\/course\/(\d+)\/materials/i;
const LAST_SYNCED_RE = /Last synced:\s*(.+)/;
const SKIP_ENTRIES = new Set([".DS_Store", "_archive", ".git"]);

/** List course folders directly under the archive root. */
export async function listCourseDirs() {
  let entries;
  try {
    entries = await fs.readdir(ARCHIVE_ROOT, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_ENTRIES.has(e.name))
    .map((e) => e.name)
    .sort();
}

/** Parse a course's INDEX.md for section_id and last-synced time. */
async function readCourseMeta(courseDirName) {
  const dir = path.join(ARCHIVE_ROOT, courseDirName);
  const indexPath = path.join(dir, "INDEX.md");
  let text = "";
  try {
    text = await fs.readFile(indexPath, "utf8");
  } catch {
    return { name: courseDirName, dir, section_id: null, last_synced: null };
  }
  const sectionMatch = text.match(SECTION_LINK_RE);
  const syncMatch = text.match(LAST_SYNCED_RE);
  const titleLine = text.split("\n")[0] || "";
  const title = titleLine.replace(/^#\s*/, "").trim() || courseDirName;
  return {
    name: title,
    dir_name: courseDirName,
    dir,
    section_id: sectionMatch ? sectionMatch[1] : null,
    last_synced: syncMatch ? syncMatch[1].trim() : null,
  };
}

let _coursesCache = null;
let _coursesCacheAt = 0;
const COURSES_CACHE_TTL_MS = 30_000;

/** All archived courses with their metadata. Cached briefly to avoid repeated FS walks. */
export async function listArchivedCourses({ fresh = false } = {}) {
  if (!fresh && _coursesCache && Date.now() - _coursesCacheAt < COURSES_CACHE_TTL_MS) {
    return _coursesCache;
  }
  const dirNames = await listCourseDirs();
  const courses = await Promise.all(dirNames.map(readCourseMeta));
  _coursesCache = courses;
  _coursesCacheAt = Date.now();
  return courses;
}

export class AmbiguousCourseError extends Error {
  constructor(candidates) {
    super(
      `Ambiguous course reference; candidates: ${candidates
        .map((c) => `${c.name} (${c.section_id || "no section_id"})`)
        .join(", ")}`,
    );
    this.name = "AmbiguousCourseError";
    this.candidates = candidates;
  }
}

export class CourseNotFoundError extends Error {
  constructor(query) {
    super(`No archived course matches "${query}"`);
    this.name = "CourseNotFoundError";
  }
}

/**
 * Resolve a course argument (section_id or case-insensitive name fragment)
 * against the archive. Throws AmbiguousCourseError or CourseNotFoundError.
 */
export async function resolveCourse(query) {
  const courses = await listArchivedCourses();
  if (!query) {
    if (courses.length === 1) return courses[0];
    throw new AmbiguousCourseError(courses);
  }
  const q = String(query).trim();
  const bySectionId = courses.filter((c) => c.section_id === q);
  if (bySectionId.length === 1) return bySectionId[0];
  const qLower = q.toLowerCase();
  const byName = courses.filter(
    (c) => c.name.toLowerCase().includes(qLower) || c.dir_name.toLowerCase().includes(qLower),
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new AmbiguousCourseError(byName);
  throw new CourseNotFoundError(query);
}

/** Resolve a course but never throw for "not found" — returns null instead (used by fallback chains). */
export async function tryResolveCourse(query) {
  try {
    return await resolveCourse(query);
  } catch (err) {
    if (err instanceof CourseNotFoundError) return null;
    throw err;
  }
}

/** Recursively walk a course directory for `… (assignment).md` / `… (quiz).md` files. */
export async function walkAssignmentFiles(courseDir) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_ENTRIES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (/\((assignment|quiz)\)\.md$/i.test(e.name)) {
        results.push(full);
      }
    }
  }
  await walk(courseDir);
  return results;
}

/** Recursively walk an entire archive root (all courses) for assignment/quiz files. */
export async function walkAllAssignmentFiles() {
  const courses = await listArchivedCourses();
  const out = [];
  for (const course of courses) {
    const files = await walkAssignmentFiles(course.dir);
    for (const f of files) out.push({ course, file: f });
  }
  return out;
}

const DUE_RE = /\*\*Due:\*\*\s*(.+)/;
const LINK_RE = /\*\*Schoology link:\*\*\s*(\S+)/;
const TITLE_RE = /^#\s*(.+)/m;

/** Parse the small header fields out of an assignment/quiz markdown file's text. */
export function parseAssignmentMd(text) {
  const dueMatch = text.match(DUE_RE);
  const linkMatch = text.match(LINK_RE);
  const titleMatch = text.match(TITLE_RE);
  let id = null;
  if (linkMatch) {
    const idMatch = linkMatch[1].match(/(\d+)\s*$/);
    if (idMatch) id = idMatch[1];
  }
  return {
    title: titleMatch ? titleMatch[1].trim() : null,
    due: dueMatch ? dueMatch[1].trim() : null,
    url: linkMatch ? linkMatch[1].trim() : null,
    id,
  };
}

/** Try to parse a due-date string from the archive into a Date. Returns null if unparseable. */
export function parseDueDate(dueStr) {
  if (!dueStr) return null;
  // e.g. "Monday, September 28, 2026 at 8:30 am"
  const cleaned = dueStr.replace(/^[A-Za-z]+,\s*/, "").replace(/\s+at\s+/i, " ");
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** List the "… files/" sibling folder for an assignment/quiz markdown file, if present. */
export async function listAttachmentFolder(mdFilePath) {
  const base = mdFilePath.replace(/\.md$/i, "");
  const filesDir = `${base.replace(/\s*\((assignment|quiz)\)$/i, "")} files`;
  try {
    const entries = await fs.readdir(filesDir, { withFileTypes: true });
    return {
      folder: filesDir,
      files: entries
        .filter((e) => !SKIP_ENTRIES.has(e.name))
        .map((e) => ({ name: e.name, is_dir: e.isDirectory() })),
    };
  } catch {
    return null;
  }
}

/** One-level (or `depth`-level) directory listing, skipping .DS_Store and _archive. */
export async function listDirTree(dir, depth = 1) {
  async function listLevel(d, remaining) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return [];
    }
    const rows = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_ENTRIES.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const row = { name: e.name, type: "folder", path: full };
        if (remaining > 1) row.children = await listLevel(full, remaining - 1);
        rows.push(row);
      } else {
        let size = null;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          /* ignore */
        }
        rows.push({ name: e.name, type: "file", path: full, size });
      }
    }
    return rows;
  }
  return listLevel(dir, depth);
}

export { ARCHIVE_ROOT };
