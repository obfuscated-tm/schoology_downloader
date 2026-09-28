// Tool implementations. Each returns a plain JS object (the envelope); the
// server wraps it into an MCP tool result. All read-only.
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_ROOT,
  listArchivedCourses,
  walkAssignmentFiles,
  walkAllAssignmentFiles,
  parseAssignmentMd,
  parseDueDate,
  listAttachmentFolder,
  listDirTree,
} from "./archive.js";
import { resolveCourseRef } from "./courses.js";
import { resolveArchivePath, PathEscapeError } from "./safepath.js";
import { extractPdfText } from "./pdftext.js";
import { tryLive } from "./result.js";
import { AmbiguousCourseError, CourseNotFoundError } from "./archive.js";

const TEXT_EXTS = new Set([".md", ".txt", ".html", ".htm", ".json"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SEARCH_FILE_CAP = 4000;
const SEARCH_RESULT_CAP = 50;
const SEARCH_PDF_CAP = 60; // max PDFs to extract per search, to bound latency

function snapshotAsOf(ctx) {
  return ctx.cache.getSnapshot()?.receivedAt || null;
}

export async function statusTool(ctx) {
  const courses = await listArchivedCourses();
  return {
    source: ctx.bridge && ctx.bridge.isConnected() ? "live" : "archive",
    as_of: new Date().toISOString(),
    extension_connected: !!(ctx.bridge && ctx.bridge.isConnected()),
    connection: ctx.bridge ? ctx.bridge.connectionInfo() : null,
    bridge_port: ctx.bridge ? ctx.bridge.port : null,
    bridge_active: !!(ctx.bridge && ctx.bridge.port),
    last_snapshot_at: ctx.cache.getSnapshot()?.receivedAt || null,
    archive_path: ARCHIVE_ROOT,
    archived_courses: courses.map((c) => ({
      name: c.name,
      section_id: c.section_id,
      last_synced: c.last_synced,
    })),
  };
}

export async function listCoursesTool(ctx) {
  const archiveCourses = await listArchivedCourses();
  const archiveBySection = new Map(archiveCourses.map((c) => [c.section_id, c]));

  const live = await tryLive(ctx, "courses", {});
  if (live.ok) {
    const courses = (live.data || []).map((c) => ({
      section_id: c.section_id != null ? String(c.section_id) : null,
      title: c.title,
      section_title: c.section_title,
      has_archive: archiveBySection.has(c.section_id != null ? String(c.section_id) : null),
    }));
    return { source: "live", as_of: new Date().toISOString(), courses };
  }

  const snap = ctx.cache.getSnapshot();
  if (snap?.snapshot?.courses) {
    const courses = snap.snapshot.courses.map((c) => ({
      section_id: c.section_id != null ? String(c.section_id) : null,
      title: c.title,
      section_title: c.section_title,
      has_archive: archiveBySection.has(c.section_id != null ? String(c.section_id) : null),
    }));
    return {
      source: "snapshot",
      as_of: snap.receivedAt,
      note: `live unavailable (${live.reason}); using last snapshot`,
      courses,
    };
  }

  return {
    source: "archive",
    as_of: null,
    note: `live unavailable (${live.reason}); no snapshot cached; listing archive folders`,
    courses: archiveCourses.map((c) => ({
      section_id: c.section_id,
      title: c.name,
      last_synced: c.last_synced,
      has_archive: true,
    })),
  };
}

export async function getTodoTool(ctx) {
  const live = await tryLive(ctx, "todo", {});
  if (live.ok) {
    return { source: "live", as_of: new Date().toISOString(), ...live.data };
  }

  const snap = ctx.cache.getSnapshot();
  if (snap?.snapshot?.lists) {
    return {
      source: "snapshot",
      as_of: snap.receivedAt,
      note: `live unavailable (${live.reason}); using last snapshot's lists`,
      ...snap.snapshot.lists,
    };
  }

  const all = await walkAllAssignmentFiles();
  const now = Date.now();
  const upcoming = [];
  for (const { course, file } of all) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const meta = parseAssignmentMd(text);
    const due = parseDueDate(meta.due);
    if (due && due.getTime() > now) {
      upcoming.push({
        title: meta.title,
        due: meta.due,
        due_iso: due.toISOString(),
        course: course.name,
        section_id: course.section_id,
        url: meta.url,
        id: meta.id,
        path: path.relative(ARCHIVE_ROOT, file),
      });
    }
  }
  upcoming.sort((a, b) => new Date(a.due_iso) - new Date(b.due_iso));
  return {
    source: "archive",
    as_of: null,
    note: `live unavailable (${live.reason}); no snapshot cached; scanned archive assignment files for future due dates`,
    upcoming,
  };
}

export async function getGradesTool(ctx, { course }) {
  const ref = await resolveCourseRef(ctx, course);

  if (ref.section_id) {
    const live = await tryLive(ctx, "grades", { section_id: ref.section_id });
    if (live.ok) {
      return { source: "live", as_of: new Date().toISOString(), course: ref.name, ...live.data };
    }
    if (!ref.has_archive) {
      throw new Error(`No grades available: live unavailable (${live.reason}) and course is not archived`);
    }
  }

  const gradesPath = path.join(ref.dir, "grades.md");
  let text;
  try {
    text = await fs.readFile(gradesPath, "utf8");
  } catch {
    throw new Error(`No grades.md found for "${ref.name}"`);
  }
  return {
    source: "archive",
    as_of: ref.last_synced || null,
    note: ref.section_id ? "live unavailable; using archived grades.md" : undefined,
    course: ref.name,
    markdown: text,
  };
}

export async function getAssignmentTool(ctx, { course, id, title }) {
  if (!id && !title) {
    throw new Error("get_assignment needs either id or title");
  }

  if (id) {
    const live = await tryLive(ctx, "assignment", { id: String(id) });
    if (live.ok) {
      return { source: "live", as_of: new Date().toISOString(), ...live.data };
    }
  }

  // Archive fallback: search assignment/quiz .md files by id (Schoology link) or title fragment.
  let candidates;
  if (course) {
    const ref = await resolveCourseRef(ctx, course);
    if (!ref.has_archive) throw new Error(`Course "${ref.name}" has no archive to search`);
    candidates = (await walkAssignmentFiles(ref.dir)).map((file) => ({ course: ref, file }));
  } else {
    candidates = await walkAllAssignmentFiles();
  }

  const matches = [];
  for (const { course: c, file } of candidates) {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (!text) continue;
    const meta = parseAssignmentMd(text);
    const idMatch = id && meta.id === String(id);
    const titleMatch =
      title && meta.title && meta.title.toLowerCase().includes(String(title).toLowerCase());
    if (idMatch || titleMatch) {
      matches.push({ course: c, file, text, meta });
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No archived assignment found matching ${id ? `id "${id}"` : `title "${title}"`}${
        course ? ` in course "${course}"` : ""
      }`,
    );
  }
  if (matches.length > 1 && id) {
    // ids should be unique; if not, just take the first but note it.
  }
  if (matches.length > 1 && !id) {
    throw new Error(
      `Ambiguous title "${title}"; candidates: ${matches
        .map((m) => `${m.meta.title} (${m.course.name})`)
        .join(", ")}`,
    );
  }

  const m = matches[0];
  const attachments = await listAttachmentFolder(m.file);
  return {
    source: "archive",
    as_of: m.course.last_synced || null,
    course: m.course.name,
    path: path.relative(ARCHIVE_ROOT, m.file),
    title: m.meta.title,
    due: m.meta.due,
    url: m.meta.url,
    id: m.meta.id,
    markdown: m.text,
    attachments: attachments
      ? { folder: path.relative(ARCHIVE_ROOT, attachments.folder), files: attachments.files }
      : null,
  };
}

export async function getUpdatesTool(ctx, { course, page = 0 }) {
  const ref = await resolveCourseRef(ctx, course);

  if (ref.section_id) {
    const live = await tryLive(ctx, "updates", { section_id: ref.section_id, page });
    if (live.ok) {
      return { source: "live", as_of: new Date().toISOString(), course: ref.name, ...live.data };
    }
  }

  if (!ref.has_archive) {
    throw new Error(`No updates available for "${ref.name}" (not archived, and live unavailable)`);
  }
  const updatesPath = path.join(ref.dir, "updates.md");
  let text = null;
  try {
    text = await fs.readFile(updatesPath, "utf8");
  } catch {
    return {
      source: "archive",
      as_of: ref.last_synced || null,
      note: "no updates.md in this course's archive (no announcements were captured)",
      course: ref.name,
      markdown: null,
    };
  }
  return {
    source: "archive",
    as_of: ref.last_synced || null,
    note: "live unavailable; using archived updates.md",
    course: ref.name,
    markdown: text,
  };
}

export async function listMaterialsTool(ctx, { course, folder_id, path: subPath, depth = 1 }) {
  const ref = await resolveCourseRef(ctx, course);

  if (ref.section_id) {
    const live = await tryLive(ctx, "materials", { section_id: ref.section_id, folder_id });
    if (live.ok) {
      return { source: "live", as_of: new Date().toISOString(), course: ref.name, ...live.data };
    }
  }

  if (!ref.has_archive) {
    throw new Error(`No materials available for "${ref.name}" (not archived, and live unavailable)`);
  }

  let baseDir = ref.dir;
  if (subPath) {
    const resolved = await resolveArchivePath(path.join(path.relative(ARCHIVE_ROOT, ref.dir), subPath));
    baseDir = resolved;
  }
  const tree = await listDirTree(baseDir, depth);
  return {
    source: "archive",
    as_of: ref.last_synced || null,
    note: "live unavailable; listing archive directory tree",
    course: ref.name,
    path: path.relative(ARCHIVE_ROOT, baseDir),
    entries: tree.map(stripAbs),
  };
}

function stripAbs(row) {
  const out = { name: row.name, type: row.type, path: path.relative(ARCHIVE_ROOT, row.path) };
  if (row.size != null) out.size = row.size;
  if (row.children) out.children = row.children.map(stripAbs);
  return out;
}

export async function readFileTool(ctx, { path: relPath }) {
  let abs;
  try {
    abs = await resolveArchivePath(relPath);
  } catch (err) {
    if (err instanceof PathEscapeError) throw new Error(err.message);
    throw err;
  }

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`File not found: ${relPath}`);
  }
  if (stat.isDirectory()) {
    const tree = await listDirTree(abs, 1);
    return {
      source: "archive",
      as_of: null,
      kind: "directory",
      path: relPath,
      entries: tree.map(stripAbs),
    };
  }

  const ext = path.extname(abs).toLowerCase();

  if (ext === ".pdf") {
    const { text, pages } = await extractPdfText(abs);
    return {
      source: "archive",
      as_of: null,
      kind: "pdf",
      path: relPath,
      pages: pages.length,
      text,
    };
  }

  if (ext === ".url") {
    const text = await fs.readFile(abs, "utf8");
    const match = text.match(/URL=(\S+)/i) || text.match(/(https?:\/\/\S+)/i);
    return {
      source: "archive",
      as_of: null,
      kind: "url",
      path: relPath,
      url: match ? match[1].trim() : text.trim(),
    };
  }

  if (IMAGE_EXTS.has(ext)) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return {
        source: "archive",
        as_of: null,
        kind: "file",
        path: relPath,
        name: path.basename(abs),
        size: stat.size,
        note: `image exceeds 5MB cap (${stat.size} bytes); not returned as image content`,
        absolute_path: abs,
      };
    }
    const buf = await fs.readFile(abs);
    const mime =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
          ? "image/png"
          : ext === ".gif"
            ? "image/gif"
            : "image/webp";
    return {
      source: "archive",
      as_of: null,
      kind: "image",
      path: relPath,
      mimeType: mime,
      data: buf.toString("base64"),
    };
  }

  if (TEXT_EXTS.has(ext)) {
    const truncated = stat.size > MAX_TEXT_BYTES;
    const fh = await fs.open(abs, "r");
    let text;
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES));
      await fh.read(buf, 0, buf.length, 0);
      text = buf.toString("utf8");
    } finally {
      await fh.close();
    }
    return {
      source: "archive",
      as_of: null,
      kind: "text",
      path: relPath,
      truncated,
      text,
    };
  }

  return {
    source: "archive",
    as_of: null,
    kind: "file",
    path: relPath,
    name: path.basename(abs),
    size: stat.size,
    absolute_path: abs,
    note: "binary/unsupported file type; returning metadata only",
  };
}

async function collectSearchableFiles(baseDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".DS_Store" || e.name === "_archive" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
      if (out.length > SEARCH_FILE_CAP) return;
    }
  }
  await walk(baseDir);
  return out;
}

function snippetAround(text, idx, query) {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${
    end < text.length ? "…" : ""
  }`;
}

export async function searchTool(ctx, { query, course }) {
  if (!query || !query.trim()) throw new Error("search needs a non-empty query");
  const qLower = query.toLowerCase();

  let baseDir = ARCHIVE_ROOT;
  let courseName = null;
  if (course) {
    const ref = await resolveCourseRef(ctx, course);
    if (!ref.has_archive) throw new Error(`Course "${ref.name}" has no archive to search`);
    baseDir = ref.dir;
    courseName = ref.name;
  }

  const files = await collectSearchableFiles(baseDir);
  const results = [];
  let pdfsExtracted = 0;
  const skipped = [];

  for (const file of files) {
    if (results.length >= SEARCH_RESULT_CAP) break;
    const rel = path.relative(ARCHIVE_ROOT, file);
    const base = path.basename(file).toLowerCase();
    const ext = path.extname(file).toLowerCase();

    if (base.includes(qLower)) {
      results.push({ path: rel, match: "filename", snippet: path.basename(file) });
      continue;
    }

    if (ext === ".md" || ext === ".txt" || ext === ".html" || ext === ".json") {
      let text;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const idx = text.toLowerCase().indexOf(qLower);
      if (idx !== -1) {
        results.push({ path: rel, match: "content", snippet: snippetAround(text, idx, query) });
      }
      continue;
    }

    if (ext === ".pdf") {
      if (pdfsExtracted >= SEARCH_PDF_CAP) {
        skipped.push(rel);
        continue;
      }
      try {
        pdfsExtracted++;
        const { text } = await extractPdfText(file);
        const idx = text.toLowerCase().indexOf(qLower);
        if (idx !== -1) {
          results.push({ path: rel, match: "pdf", snippet: snippetAround(text, idx, query) });
        }
      } catch {
        skipped.push(rel);
      }
    }
  }

  return {
    source: "archive",
    as_of: null,
    course: courseName,
    query,
    results,
    truncated: results.length >= SEARCH_RESULT_CAP,
    pdfs_extracted: pdfsExtracted,
    skipped_pdfs: skipped.length,
  };
}

export function isCourseResolutionError(err) {
  return err instanceof AmbiguousCourseError || err instanceof CourseNotFoundError;
}
