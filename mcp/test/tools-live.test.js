// Exercises tool logic that talks to a (fake) live extension bridge:
// title -> id -> live assignment resolution, open_material fetching a live
// material + file, and the no-extension fallback message.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildArchive, cleanupArchive } from "./fixtures/build-archive.js";
import { makeMinimalPdf } from "./fixtures/make-pdf.js";

let fixture;
let mcpHome;
let toolsMod;
let cacheMod;

before(async () => {
  fixture = await buildArchive();
  mcpHome = await fs.mkdtemp(path.join(os.tmpdir(), "schoology-mcp-live-"));
  process.env.SCHOOLOGY_ARCHIVE = fixture.root;
  process.env.SCHOOLOGY_MCP_HOME = mcpHome;
  delete process.env.SCHOOLOGY_EXT_ID;

  toolsMod = await import("../src/tools.js");
  cacheMod = await import("../src/cache.js");
});

after(async () => {
  await cleanupArchive(fixture.root);
  await fs.rm(mcpHome, { recursive: true, force: true });
});

/** A fake bridge that answers ops from a handler, like the real extension would. */
class FakeBridge {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }
  isConnected() {
    return true;
  }
  async request(op, args) {
    this.calls.push({ op, args });
    return this.handler(op, args);
  }
}

function fakeCtx(bridge) {
  return { bridge, cache: new cacheMod.DiskCache(path.join(mcpHome, `cache-${Math.random()}.json`)) };
}

test("get_assignment resolves a title to an id via the live to-do list, then fetches it live", async () => {
  const bridge = new FakeBridge((op, args) => {
    if (op === "todo") {
      return {
        upcoming: [{ schoology_id: "555", title: "HW 1: Kinematics Worksheet", course: "Physics", section_id: "1111111111" }],
        overdue: [],
        recent: [],
      };
    }
    if (op === "assignment") {
      assert.equal(args.id, "555");
      return { id: "555", title: "HW 1: Kinematics Worksheet", instructions_md: "Do it" };
    }
    throw Object.assign(new Error("unexpected op"), { code: "bad_args" });
  });
  const ctx = fakeCtx(bridge);
  const result = await toolsMod.getAssignmentTool(ctx, { title: "kinematics" });
  assert.equal(result.source, "live");
  assert.equal(result.id, "555");
  assert.equal(result.instructions_md, "Do it");
});

test("get_assignment scopes title resolution to a course via the live gradebook", async () => {
  const bridge = new FakeBridge((op, args) => {
    if (op === "todo") return { upcoming: [], overdue: [], recent: [] };
    if (op === "grades") {
      assert.equal(args.section_id, "1111111111");
      return { section_id: args.section_id, rows: [{ id: "777", title: "Special HW", grade: "A" }] };
    }
    if (op === "assignment") {
      assert.equal(args.id, "777");
      return { id: "777", title: "Special HW" };
    }
    throw Object.assign(new Error("unexpected op"), { code: "bad_args" });
  });
  const ctx = fakeCtx(bridge);
  const result = await toolsMod.getAssignmentTool(ctx, { title: "special", course: "1111111111" });
  assert.equal(result.source, "live");
  assert.equal(result.id, "777");
});

test("get_assignment falls back to the archive when live resolution finds nothing", async () => {
  const bridge = new FakeBridge((op) => {
    if (op === "todo") return { upcoming: [], overdue: [], recent: [] };
    throw Object.assign(new Error("unexpected op"), { code: "bad_args" });
  });
  const ctx = fakeCtx(bridge);
  const result = await toolsMod.getAssignmentTool(ctx, { title: "kinematics" });
  assert.equal(result.source, "archive");
});

test("open_material with no extension connected says so and points at the archive", async () => {
  const ctx = { bridge: null, cache: new cacheMod.DiskCache(path.join(mcpHome, `cache-noext.json`)) };
  const result = await toolsMod.openMaterialTool(ctx, { url: "https://fuhsd.schoology.com/course/1/materials/gp/2" });
  assert.equal(result.source, "unavailable");
  assert.match(result.note, /search/);
  assert.match(result.note, /read_file/);
});

test("open_material fetches a live material and its PDF file, returning extracted text", async () => {
  const pdfBytes = makeMinimalPdf("Live Material Marker XYZ");
  const fileUrl = "https://fuhsd.schoology.com/attachment/123/source/456";
  const bridge = new FakeBridge((op, args) => {
    if (op === "material") {
      assert.equal(args.url, "https://fuhsd.schoology.com/course/1/materials/gp/2");
      return {
        url: args.url,
        kind: "file",
        title: "Worksheet",
        body_md: null,
        target: null,
        links: [],
        files: [{ title: "worksheet.pdf", url: fileUrl, ext: "pdf" }],
      };
    }
    if (op === "file") {
      assert.equal(args.url, fileUrl);
      return { url: fileUrl, name: "worksheet.pdf", mime: "application/pdf", size: pdfBytes.length, base64: pdfBytes.toString("base64") };
    }
    throw Object.assign(new Error("unexpected op"), { code: "bad_args" });
  });
  const ctx = fakeCtx(bridge);
  const result = await toolsMod.openMaterialTool(ctx, { url: "https://fuhsd.schoology.com/course/1/materials/gp/2" });
  assert.equal(result.source, "live");
  assert.equal(result.title, "Worksheet");
  assert.equal(result.file_contents.length, 1);
  assert.equal(result.file_contents[0].kind, "pdf");
  assert.match(result.file_contents[0].text, /Live Material Marker XYZ/);
});

test("open_material caps file fetches at 5 and skips fetching when fetch_files is false", async () => {
  const files = Array.from({ length: 7 }, (_, i) => ({
    title: `f${i}`,
    url: `https://fuhsd.schoology.com/attachment/${i}/source/${i}`,
    ext: "txt",
  }));
  let fileFetches = 0;
  const bridge = new FakeBridge((op, args) => {
    if (op === "material") {
      return { url: args.url, kind: "file", title: "Many files", body_md: null, target: null, links: [], files };
    }
    if (op === "file") {
      fileFetches++;
      return { url: args.url, name: "f.txt", mime: "text/plain", size: 3, base64: Buffer.from("hi!").toString("base64") };
    }
    throw new Error("unexpected op");
  });
  const ctx = fakeCtx(bridge);
  const withFetch = await toolsMod.openMaterialTool(ctx, { url: "https://x/materials/gp/9" });
  assert.equal(withFetch.file_contents.length, 5);
  assert.equal(fileFetches, 5);
  assert.match(withFetch.note, /only the first 5 of 7/);

  fileFetches = 0;
  const ctx2 = fakeCtx(bridge);
  const noFetch = await toolsMod.openMaterialTool(ctx2, { url: "https://x/materials/gp/9", fetch_files: false });
  assert.equal(noFetch.file_contents, undefined);
  assert.equal(fileFetches, 0);
});

// A two-course Materials tree: Physics root -> "Unit 1" -> "Notes" -> a PDF item.
function treeBridge() {
  const tree = {
    "1111111111:": [
      { kind: "folder", title: "Unit 1", id: "10", url: "https://x/course/1111111111/materials?f=10" },
      { kind: "assignment", title: "Lab Report", id: "77", url: "https://x/assignment/77" },
    ],
    "1111111111:10": [{ kind: "folder", title: "Notes", id: "11", url: "https://x/course/1111111111/materials?f=11" }],
    "1111111111:11": [{ kind: "document", title: "Vectors Answer Key", id: "12", url: "https://x/attachment/12/source/a" }],
    "2222222222:": [{ kind: "document", title: "Syllabus", id: "20", url: "https://x/attachment/20/source/b" }],
  };
  return new FakeBridge((op, args) => {
    if (op === "courses") return [
      { section_id: "1111111111", title: "Physics" },
      { section_id: "2222222222", title: "World History" },
    ];
    if (op === "materials") return { section_id: args.section_id, folder_id: args.folder_id || null, rows: tree[`${args.section_id}:${args.folder_id || ""}`] || [] };
    throw new Error(`unexpected op ${op}`);
  });
}

test("list_materials with depth walks subfolders live, tagging each row with its folder path", async () => {
  const bridge = treeBridge();
  const r = await toolsMod.listMaterialsTool(fakeCtx(bridge), { course: "1111111111", depth: 3 });
  assert.equal(r.source, "live");
  assert.equal(r.folders, 3);
  const key = r.rows.find((x) => x.title === "Vectors Answer Key");
  assert.equal(key.path, "Unit 1 / Notes");
  const shallow = await toolsMod.listMaterialsTool(fakeCtx(treeBridge()), { course: "1111111111", depth: 2 });
  assert.ok(!shallow.rows.some((x) => x.title === "Vectors Answer Key"));
});

test("find_material searches every course's tree in one call, and caches the walk", async () => {
  const bridge = treeBridge();
  const ctx = fakeCtx(bridge);
  const r = await toolsMod.findMaterialTool(ctx, { query: "answer key" });
  assert.equal(r.source, "live");
  assert.equal(r.courses_searched, 2);
  assert.deepEqual(r.hits.map((h) => [h.course, h.title, h.path]), [["Physics", "Vectors Answer Key", "Unit 1 / Notes"]]);
  const before = bridge.calls.filter((c) => c.op === "materials").length;
  const again = await toolsMod.findMaterialTool(ctx, { query: "syllabus" });
  assert.equal(again.hits[0].course, "World History");
  assert.equal(bridge.calls.filter((c) => c.op === "materials").length, before, "second search reuses the walk");
  const byPath = await toolsMod.findMaterialTool(ctx, { query: "notes", kind: "document" });
  assert.equal(byPath.hits[0].title, "Vectors Answer Key");
});

test("fetch_page lists a Drive folder through the extension", async () => {
  const html = `<div class="flip-entries"><div class="flip-entry" id="entry-a"><a href="https://drive.google.com/file/d/a1/view?usp=drive_web" target="_blank"><div class="flip-entry-info"><div class="flip-entry-title">Chapter 1 &amp; 2.pdf</div></div></a></div><div class="flip-entry" id="entry-b"><a href="https://drive.google.com/drive/folders/b2"><div class="flip-entry-title">Unit 2</div></a></div></div>`;
  const bridge = new FakeBridge((op, args) => {
    if (op === "file") return { url: args.url, name: null, mime: "text/html", size: html.length, base64: Buffer.from(html).toString("base64") };
    throw new Error("unexpected op");
  });
  const r = await toolsMod.fetchPageTool(fakeCtx(bridge), { url: "https://drive.google.com/drive/folders/zzz?resourcekey=0-k" });
  assert.equal(r.kind, "drive_folder");
  assert.deepEqual(r.entries, [
    { title: "Chapter 1 & 2.pdf", url: "https://drive.google.com/file/d/a1/view?usp=drive_web", kind: "file" },
    { title: "Unit 2", url: "https://drive.google.com/drive/folders/b2", kind: "folder" },
  ]);
});

test("fetch_page reads a Google Doc through the extension as PDF text", async () => {
  const pdf = await makeMinimalPdf("Doc Export Marker QRS");
  const bridge = new FakeBridge((op, args) => {
    if (op === "file") return { url: args.url, name: "doc.pdf", mime: "application/pdf", size: pdf.length, base64: Buffer.from(pdf).toString("base64") };
    throw new Error("unexpected op");
  });
  const r = await toolsMod.fetchPageTool(fakeCtx(bridge), { url: "https://docs.google.com/document/d/docid123/edit" });
  assert.equal(r.kind, "pdf");
  assert.match(r.text, /Doc Export Marker QRS/);
});
