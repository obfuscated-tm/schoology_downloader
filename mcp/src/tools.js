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
import { extractPdfText, extractPdfTextFromBuffer } from "./pdftext.js";
import { tryLive } from "./result.js";
import { AmbiguousCourseError, CourseNotFoundError } from "./archive.js";
import { siteForCourse } from "./sites.js";
import { readCachedFile, writeCachedFile } from "./filecache.js";
import { fetchPage } from "./fetchpage.js";

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
    sites: ctx.sites || [],
  };
}

function withSite(course, name, sites) {
  const site = siteForCourse(name, sites);
  return site ? { ...course, site } : course;
}

export async function listCoursesTool(ctx) {
  const archiveCourses = await listArchivedCourses();
  const archiveBySection = new Map(archiveCourses.map((c) => [c.section_id, c]));
  const sites = ctx.sites || [];

  const live = await tryLive(ctx, "courses", {});
  if (live.ok) {
    const courses = (live.data || []).map((c) =>
      withSite(
        {
          section_id: c.section_id != null ? String(c.section_id) : null,
          title: c.title,
          section_title: c.section_title,
          has_archive: archiveBySection.has(c.section_id != null ? String(c.section_id) : null),
        },
        c.title || c.section_title,
        sites,
      ),
    );
    return { source: "live", as_of: new Date().toISOString(), courses };
  }

  const snap = ctx.cache.getSnapshot();
  if (snap?.snapshot?.courses) {
    const courses = snap.snapshot.courses.map((c) =>
      withSite(
        {
          section_id: c.section_id != null ? String(c.section_id) : null,
          title: c.title,
          section_title: c.section_title,
          has_archive: archiveBySection.has(c.section_id != null ? String(c.section_id) : null),
        },
        c.title || c.section_title,
        sites,
      ),
    );
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
    courses: archiveCourses.map((c) =>
      withSite(
        {
          section_id: c.section_id,
          title: c.name,
          last_synced: c.last_synced,
          has_archive: true,
        },
        c.name,
        sites,
      ),
    ),
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

/**
 * Resolve a title fragment to a live assignment id using the live to-do
 * lists (upcoming/overdue/recent, all courses) and, when a course is given,
 * that course's live gradebook rows (every gradebook item carries an id).
 * Returns a de-duplicated (by id) array of { id, title, course }.
 */
async function resolveAssignmentIdsLive(ctx, title, course) {
  const qLower = String(title).toLowerCase();
  const candidates = [];

  let ref = null;
  if (course) {
    try {
      ref = await resolveCourseRef(ctx, course);
    } catch {
      ref = null;
    }
  }

  const todoLive = await tryLive(ctx, "todo", {});
  if (todoLive.ok) {
    const rows = [
      ...(todoLive.data.upcoming || []),
      ...(todoLive.data.overdue || []),
      ...(todoLive.data.recent || []),
    ];
    for (const r of rows) {
      if (!r || !r.title || !r.title.toLowerCase().includes(qLower)) continue;
      if (ref?.section_id && r.section_id != null && String(r.section_id) !== String(ref.section_id)) continue;
      const rid = r.schoology_id ?? r.id;
      if (rid != null) candidates.push({ id: String(rid), title: r.title, course: r.course || null });
    }
  }

  if (ref?.section_id) {
    const gradesLive = await tryLive(ctx, "grades", { section_id: ref.section_id });
    if (gradesLive.ok) {
      for (const row of gradesLive.data?.rows || []) {
        const rowTitle = row.title || row.item || row.name;
        if (!rowTitle || !rowTitle.toLowerCase().includes(qLower)) continue;
        if (row.id == null) continue;
        candidates.push({ id: String(row.id), title: rowTitle, course: ref.name });
      }
    }
  }

  const byId = new Map();
  for (const c of candidates) byId.set(c.id, c);
  return [...byId.values()];
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

  if (title && !id) {
    const liveCandidates = await resolveAssignmentIdsLive(ctx, title, course);
    if (liveCandidates.length > 1) {
      throw new Error(
        `Ambiguous title "${title}"; candidates: ${liveCandidates
          .map((c) => `${c.title} (${c.course || "unknown course"})`)
          .join(", ")}`,
      );
    }
    if (liveCandidates.length === 1) {
      const live = await tryLive(ctx, "assignment", { id: liveCandidates[0].id });
      if (live.ok) {
        return { source: "live", as_of: new Date().toISOString(), ...live.data };
      }
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

const MAX_MATERIAL_FILES = 5;
const FILE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const FILE_TEXT_EXTS = new Set([".csv", ".txt", ".md", ".json"]);
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Look for a `materials` row with this id in whatever the cache has, to turn a bare id into a url. */
function findMaterialUrlInCache(ctx, id) {
  for (const entry of ctx.cache.allLiveForOp("materials")) {
    for (const row of entry.data?.rows || []) {
      if (row?.id != null && String(row.id) === String(id)) return row.url;
    }
  }
  return null;
}

async function materializeMaterialFile(f, meta, data) {
  const nameForExt = meta.name || f.title || f.url || "";
  const ext = path.extname(String(nameForExt)).toLowerCase();
  const mime = meta.mime || "";

  if (ext === ".pdf" || mime.includes("pdf")) {
    const { text, pages } = await extractPdfTextFromBuffer(data, f.url);
    return { title: f.title || null, url: f.url, name: meta.name || null, kind: "pdf", pages: pages.length, text };
  }
  if (FILE_IMAGE_EXTS.has(ext) || mime.startsWith("image/")) {
    return {
      title: f.title || null,
      url: f.url,
      name: meta.name || null,
      kind: "image",
      mimeType: mime || MIME_BY_EXT[ext] || "application/octet-stream",
      data: data.toString("base64"),
    };
  }
  if (FILE_TEXT_EXTS.has(ext) || mime.startsWith("text/") || mime.includes("csv")) {
    return {
      title: f.title || null,
      url: f.url,
      name: meta.name || null,
      kind: "text",
      text: data.toString("utf8").slice(0, MAX_TEXT_BYTES),
    };
  }
  return {
    title: f.title || null,
    url: f.url,
    name: meta.name || null,
    kind: "file",
    size: meta.size ?? data.length,
  };
}

async function fetchOneMaterialFile(ctx, f) {
  if (!f?.url) return { title: f?.title || null, url: f?.url || null, kind: "file", error: "no url" };
  const cached = await readCachedFile(f.url);
  if (cached) return materializeMaterialFile(f, cached.meta, cached.data);

  const live = await tryLive(ctx, "file", { url: f.url });
  if (!live.ok) {
    return { title: f.title || null, url: f.url, kind: "error", error: `could not fetch (${live.reason})` };
  }
  const d = live.data || {};
  const data = Buffer.from(d.base64 || "", "base64");
  const meta = { name: d.name || null, mime: d.mime || null, size: d.size ?? data.length, fetchedAt: new Date().toISOString() };
  await writeCachedFile(f.url, meta, data);
  return materializeMaterialFile(f, meta, data);
}

/**
 * Open one materials-folder item (from a `list_materials` row) live: its
 * body/target/links, plus — unless `fetch_files: false` — the content of up
 * to 5 of its attached files (PDF text, CSV/text as text, images as image
 * content, anything else as name/size).
 */
export async function openMaterialTool(ctx, { course, url, id, fetch_files = true }) {
  if (!url && !id) {
    throw new Error("open_material needs a url or id from a list_materials row");
  }
  if (course) {
    // Resolution isn't required to build the request, but surfaces a clear
    // error early if the course itself can't be found.
    await resolveCourseRef(ctx, course).catch(() => null);
  }

  let materialUrl = url;
  if (!materialUrl) {
    materialUrl = findMaterialUrlInCache(ctx, id);
    if (!materialUrl) {
      throw new Error(
        `Could not resolve id "${id}" to a url; call list_materials first (its rows carry both id and url), or pass the row's url directly`,
      );
    }
  }

  if (!ctx.bridge || !ctx.bridge.isConnected()) {
    return {
      source: "unavailable",
      as_of: new Date().toISOString(),
      note:
        "No extension connected; open_material needs live Schoology access to open a materials-folder item. " +
        "Use search/read_file against the archive instead (it may not cover this course or be current).",
      url: materialUrl,
    };
  }

  const live = await tryLive(ctx, "material", { url: materialUrl });
  if (!live.ok) {
    return {
      source: "unavailable",
      as_of: new Date().toISOString(),
      note: `live material fetch failed (${live.reason}); use search/read_file against the archive instead`,
      url: materialUrl,
    };
  }

  const material = live.data || {};
  const files = Array.isArray(material.files) ? material.files : [];
  const notes = [];
  if (material.kind === "link" && material.target) {
    notes.push("This is a link item; read its target page with fetch_page.");
  }

  const result = {
    source: "live",
    as_of: new Date().toISOString(),
    url: material.url || materialUrl,
    kind: material.kind ?? null,
    title: material.title ?? null,
    body_md: material.body_md ?? null,
    target: material.target ?? null,
    links: material.links ?? [],
    files,
  };

  if (fetch_files && files.length > 0) {
    const toFetch = files.slice(0, MAX_MATERIAL_FILES);
    result.file_contents = [];
    for (const f of toFetch) {
      result.file_contents.push(await fetchOneMaterialFile(ctx, f));
    }
    if (files.length > MAX_MATERIAL_FILES) {
      notes.push(`only the first ${MAX_MATERIAL_FILES} of ${files.length} files were fetched`);
    }
  }

  if (notes.length) result.note = notes.join("; ");
  return result;
}

/**
 * Fetch a public course-website page (see docs/MCP-BRIDGE.md "Course
 * websites"): GET only, no cookies, address-guarded, 1h cache. HTML pages
 * come back as readable text + a link list; .md/.txt as is; PDF as text.
 */
const PAGE_IMAGE_MAX = 6;

/**
 * fetch_page. A page with (almost) no text of its own but images — old
 * textbook sites draw every exercise and solution as a GIF — also gets its
 * first few images fetched, so Claude can see them. Each goes through
 * fetchPage, so the same address guard and caps apply.
 */
export async function fetchPageTool(ctx, { url, include_images } = {}, { fetchImpl = fetchPage } = {}) {
  if (!url || !url.trim()) throw new Error("fetch_page needs a url");
  const result = await fetchImpl(url.trim());
  const out = { source: "web", as_of: result.fetched_at, ...result };
  const imageOnly = result.kind === "html" && (result.text || "").trim().length < 200 && result.images?.length;
  if (include_images ?? imageOnly) {
    out.image_contents = [];
    for (const src of (result.images || []).slice(0, PAGE_IMAGE_MAX)) {
      try {
        const img = await fetchImpl(src);
        if (img.kind === "image" && img.data) out.image_contents.push({ url: src, mimeType: img.mimeType, data: img.data });
      } catch (err) {
        out.image_contents.push({ url: src, error: err.message || String(err) });
      }
    }
  }
  return out;
}
