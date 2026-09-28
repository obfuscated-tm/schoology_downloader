import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildArchive, cleanupArchive } from "./fixtures/build-archive.js";

let fixture;
let mcpHome;
let archiveMod, safepathMod, coursesMod, toolsMod, cacheMod;

before(async () => {
  fixture = await buildArchive();
  mcpHome = await fs.mkdtemp(path.join(os.tmpdir(), "schoology-mcp-home-"));
  process.env.SCHOOLOGY_ARCHIVE = fixture.root;
  process.env.SCHOOLOGY_MCP_HOME = mcpHome;
  delete process.env.SCHOOLOGY_EXT_ID;

  archiveMod = await import("../src/archive.js");
  safepathMod = await import("../src/safepath.js");
  coursesMod = await import("../src/courses.js");
  toolsMod = await import("../src/tools.js");
  cacheMod = await import("../src/cache.js");
});

after(async () => {
  await cleanupArchive(fixture.root);
  await fs.rm(mcpHome, { recursive: true, force: true });
});

function fakeCtx() {
  return { bridge: null, cache: new cacheMod.DiskCache(path.join(mcpHome, "cache.json")) };
}

test("lists archived course folders", async () => {
  const dirs = await archiveMod.listCourseDirs();
  assert.deepEqual(
    dirs.sort(),
    ["History 9 - 2222 - TeacherB p2 T1", "Physics 101 - 1111 - TeacherA p1 T1"].sort(),
  );
});

test("resolves a course by exact section_id", async () => {
  const ctx = fakeCtx();
  const ref = await coursesMod.resolveCourseRef(ctx, "1111111111");
  assert.equal(ref.name, "Physics 101 - 1111: TeacherA p1 T1");
  assert.equal(ref.has_archive, true);
});

test("resolves a course by case-insensitive name fragment", async () => {
  const ctx = fakeCtx();
  const ref = await coursesMod.resolveCourseRef(ctx, "physics");
  assert.equal(ref.section_id, "1111111111");
});

test("ambiguous course fragment throws AmbiguousCourseError with candidates", async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    () => coursesMod.resolveCourseRef(ctx, "T1"), // matches both course names ("p1 T1" / "p2 T1")
    (err) => {
      assert.ok(err instanceof archiveMod.AmbiguousCourseError);
      assert.equal(err.candidates.length, 2);
      return true;
    },
  );
});

test("unknown course fragment throws CourseNotFoundError", async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    () => coursesMod.resolveCourseRef(ctx, "nonexistent-course-xyz"),
    (err) => err instanceof archiveMod.CourseNotFoundError,
  );
});

test("path traversal is rejected", async () => {
  await assert.rejects(
    () => safepathMod.resolveArchivePath("../../etc/passwd"),
    (err) => err instanceof safepathMod.PathEscapeError,
  );
  await assert.rejects(
    () => safepathMod.resolveArchivePath("Unit 1/../../../../etc/passwd"),
    (err) => err instanceof safepathMod.PathEscapeError,
  );
});

test("a plain relative path within the archive resolves fine", async () => {
  const abs = await safepathMod.resolveArchivePath(
    path.join("Physics 101 - 1111 - TeacherA p1 T1", "grades.md"),
  );
  assert.ok(abs.startsWith(fixture.root));
});

test("symlink escape is rejected", async () => {
  const linkPath = path.join(fixture.course1, "escape-link");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  await fs.symlink(outsideDir, linkPath, "dir");
  try {
    await assert.rejects(
      () =>
        safepathMod.resolveArchivePath(
          path.join("Physics 101 - 1111 - TeacherA p1 T1", "escape-link", "secret.txt"),
        ),
      (err) => err instanceof safepathMod.PathEscapeError,
    );
  } finally {
    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("read_file reads a markdown file as text", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.readFileTool(ctx, {
    path: path.join("Physics 101 - 1111 - TeacherA p1 T1", "grades.md"),
  });
  assert.equal(result.kind, "text");
  assert.match(result.text, /Course Grade/);
  assert.equal(result.truncated, false);
});

test("read_file extracts text from a PDF", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.readFileTool(ctx, {
    path: path.join("Physics 101 - 1111 - TeacherA p1 T1", "Unit 1", "HW 1 files", "worksheet.pdf"),
  });
  assert.equal(result.kind, "pdf");
  assert.match(result.text, /UniqueMarkerABC/);
  assert.equal(result.pages, 1);
});

test("read_file returns the URL inside a .url file", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.readFileTool(ctx, {
    path: path.join("Physics 101 - 1111 - TeacherA p1 T1", "Unit 1", "link.url"),
  });
  assert.equal(result.kind, "url");
  assert.equal(result.url, "https://example.com/some-video");
});

test("read_file rejects a traversal attempt", async () => {
  const ctx = fakeCtx();
  await assert.rejects(() => toolsMod.readFileTool(ctx, { path: "../../etc/passwd" }));
});

test("get_grades falls back to archive grades.md", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.getGradesTool(ctx, { course: "physics" });
  assert.equal(result.source, "archive");
  assert.match(result.markdown, /Course Grade/);
});

test("get_todo scans archive for future due dates", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.getTodoTool(ctx);
  assert.equal(result.source, "archive");
  assert.ok(result.upcoming.some((a) => a.title.includes("Kinematics")));
  // the History course's assignment is due in 2001 and must not appear
  assert.ok(!result.upcoming.some((a) => a.title === "Old HW"));
});

test("get_assignment finds an archived assignment by title fragment", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.getAssignmentTool(ctx, { title: "kinematics" });
  assert.equal(result.source, "archive");
  assert.match(result.markdown, /Solve problems/);
  assert.ok(result.attachments);
  assert.ok(result.attachments.files.some((f) => f.name === "worksheet.pdf"));
});

test("get_assignment finds an archived assignment by Schoology id", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.getAssignmentTool(ctx, { id: "9991112222" });
  assert.equal(result.title, "HW 1: Kinematics Worksheet");
});

test("get_updates returns archived updates.md", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.getUpdatesTool(ctx, { course: "physics" });
  assert.match(result.markdown, /Welcome to class/);
});

test("get_updates notes a missing updates.md gracefully", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.getUpdatesTool(ctx, { course: "history" });
  assert.equal(result.markdown, null);
  assert.match(result.note, /no updates\.md/);
});

test("list_materials lists the archive directory tree, skipping .DS_Store and _archive", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.listMaterialsTool(ctx, { course: "physics" });
  const names = result.entries.map((e) => e.name);
  assert.ok(names.includes("Unit 1"));
  assert.ok(!names.includes(".DS_Store"));
  assert.ok(!names.includes("_archive"));
});

test("search finds a hit by markdown content", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.searchTool(ctx, { query: "projectile motion" });
  assert.ok(result.results.some((r) => r.path.includes("HW 1 (assignment).md")));
});

test("search finds a hit inside PDF text", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.searchTool(ctx, { query: "UniqueMarkerABC" });
  assert.ok(result.results.some((r) => r.path.endsWith("worksheet.pdf")));
});

test("search scoped to a course does not see the other course's files", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.searchTool(ctx, { query: "kinematics", course: "history" });
  assert.equal(result.results.length, 0);
});

test("status reports archive path and archived courses", async () => {
  const ctx = fakeCtx();
  const result = await toolsMod.statusTool(ctx);
  assert.equal(result.extension_connected, false);
  assert.equal(result.archived_courses.length, 2);
  assert.equal(result.archive_path, fixture.root);
});
