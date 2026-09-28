#!/usr/bin/env node
// Local, read-only MCP server exposing the user's Schoology coursework to Claude
// Desktop. Stdio transport — stdout is the MCP channel, so all logging goes
// to stderr (see src/log.js). See docs/MCP-BRIDGE.md for the extension
// contract and README.md for setup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// stdout carries MCP messages only: anything a library logs goes to stderr.
console.log = console.info = console.warn = console.debug = console.error;

import { Bridge } from "./src/bridge.js";
import { DiskCache } from "./src/cache.js";
import { log } from "./src/log.js";
import { toToolResult, toErrorResult } from "./src/result.js";
import { loadSites } from "./src/sites.js";
import {
  statusTool,
  listCoursesTool,
  getTodoTool,
  getGradesTool,
  getAssignmentTool,
  getUpdatesTool,
  listMaterialsTool,
  readFileTool,
  searchTool,
  openMaterialTool,
  fetchPageTool,
  findMaterialTool,
} from "./src/tools.js";

const INSTRUCTIONS = `Schoology data comes from two places, and every tool result says which one answered plus how old it is (\`source\`, \`as_of\`).

- **live**: fetched right now through the user's logged-in Chrome via the extension bridge. Current as of the call. Needs Chrome open with the extension connected (check \`status\`).
- **archive**: a local, disk-based copy of Schoology. Only as fresh as its last-synced time (see \`status\`'s \`archived_courses\`), and doesn't cover every course.

Prefer live tools (\`get_todo\`, \`get_grades\`, \`find_material\` / \`list_materials\` -> \`open_material\`, \`get_assignment\`, \`get_updates\`) for anything current: what's due, grades, assignments, or what's in a course right now. \`search\` and \`read_file\` only ever look at the archive — use them for older material, full-text search, or when live is unavailable, not as a first stop for current coursework. Always tell the user when an answer came from the archive or a cached snapshot, and how old it is.

To find something by name, use \`find_material\` (every course's whole Materials tree, one call) rather than opening folders one by one; to see a course's whole layout, \`list_materials\` with \`depth\`.

Some courses also have a public website outside Schoology (listed in \`status\`/\`list_courses\` as \`site\`, from \`sites.json\` — e.g. AP Comp Sci's lesson pages at apcs.tinocs.com). Use \`fetch_page\` to read those directly. \`fetch_page\` also opens Google Docs/Slides/Sheets, Drive files and Drive folders (through the user's signed-in Chrome), so it's the tool for any link found in a material, assignment or page.`;

async function main() {
  const cache = new DiskCache();
  await cache.load();
  const bridge = new Bridge({
    onSnapshot: (snapshot) => {
      cache.setSnapshot(snapshot);
      log("bridge: snapshot received and cached");
    },
  });
  await bridge.start();

  const sites = await loadSites();

  const ctx = { bridge, cache, sites };

  const server = new McpServer(
    { name: "schoology-mcp", version: "1.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const wrap = (fn) => async (args) => {
    try {
      const data = await fn(ctx, args || {});
      return toToolResult(data);
    } catch (err) {
      log(`tool error: ${err.message}`);
      return toErrorResult(err.message || String(err));
    }
  };

  server.registerTool(
    "status",
    {
      title: "Schoology bridge status",
      description:
        "Is the Chrome extension connected? Host, bridge port, last snapshot time, archive path, archived courses with their last-synced time, and any course websites from sites.json.",
      inputSchema: {},
    },
    wrap(statusTool),
  );

  server.registerTool(
    "list_courses",
    {
      title: "List Schoology courses",
      description:
        "List the user's Schoology courses: live course list, else the last snapshot, else the archive folders. Notes which courses have an archive, and attaches a `site` (from sites.json) for courses with a public website outside Schoology.",
      inputSchema: {},
    },
    wrap(listCoursesTool),
  );

  server.registerTool(
    "get_todo",
    {
      title: "Get to-do / upcoming work",
      description:
        "What's due: live to-do list, else the last snapshot's lists, else a scan of the archive's assignment files for future due dates (sorted soonest first).",
      inputSchema: {},
    },
    wrap(getTodoTool),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get grades for a course",
      description:
        "Gradebook for one course: live grades, else the archived grades.md. Course is a section_id or a case-insensitive name fragment.",
      inputSchema: {
        course: z.string().describe("section_id or case-insensitive name fragment"),
      },
    },
    wrap((ctxArg, args) => getGradesTool(ctxArg, args)),
  );

  server.registerTool(
    "get_assignment",
    {
      title: "Get one assignment or quiz",
      description:
        "Fetch an assignment/quiz by Schoology id (live), or by a title fragment: resolved to an id live via the to-do lists and (course-scoped) gradebook, then fetched live; falls back to an archive search if that fails. Optionally scope the title search to one course. Returns instructions, due date, grade, and the attachment folder listing.",
      inputSchema: {
        course: z.string().optional().describe("section_id or name fragment, to scope a title search"),
        id: z.string().optional().describe("numeric Schoology assignment id"),
        title: z.string().optional().describe("case-insensitive title fragment"),
      },
    },
    wrap((ctxArg, args) => getAssignmentTool(ctxArg, args)),
  );

  server.registerTool(
    "get_updates",
    {
      title: "Get course announcements",
      description:
        "Course announcements/updates: live, else the archived updates.md (if the course had any captured).",
      inputSchema: {
        course: z.string().describe("section_id or case-insensitive name fragment"),
        page: z.number().int().min(0).optional().describe("page number, default 0 (live only)"),
      },
    },
    wrap((ctxArg, args) => getUpdatesTool(ctxArg, args)),
  );

  server.registerTool(
    "list_materials",
    {
      title: "List course materials",
      description:
        "List a course's materials folder: live, else the archive's directory tree, skipping .DS_Store and _archive. One level by default; `depth` N opens subfolders N levels down (live: a flat row list, each row with the `path` of the folder it's in; up to 200 folders).",
      inputSchema: {
        course: z.string().describe("section_id or case-insensitive name fragment"),
        folder_id: z.string().optional().describe("Schoology folder id (live only); default root"),
        path: z
          .string()
          .optional()
          .describe("sub-path within the course's archive folder (archive fallback only)"),
        depth: z.number().int().min(1).max(6).optional().describe("folder levels to open, default 1"),
      },
    },
    wrap((ctxArg, args) => listMaterialsTool(ctxArg, args)),
  );

  server.registerTool(
    "find_material",
    {
      title: "Find a material by name, live",
      description:
        "Search item titles (and the folder path each sits in) across a course's whole Materials tree, or all courses' when `course` is omitted — live, every folder opened for you (cached 10 min). Every word of the query must appear. Returns rows with course, path, kind, title, id and url; open one with open_material (or get_assignment for assignments). Titles only; for full-text search of old material use `search` (archive).",
      inputSchema: {
        query: z.string().describe("words that appear in the title or folder path"),
        course: z.string().optional().describe("section_id or name fragment; default all courses"),
        kind: z
          .enum(["folder", "document", "assignment", "quiz", "page", "discussion", "other"])
          .optional()
          .describe("only rows of this kind"),
      },
    },
    wrap((ctxArg, args) => findMaterialTool(ctxArg, args)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file from the archive",
      description:
        "Read one file from the local Schoology Archive by path (relative to the archive root) — the archive ONLY, which may be stale and doesn't cover every course. For current course content, use list_materials -> open_material instead. Markdown/text/html/json return as text (~200KB cap); PDFs return extracted text (cached, page-marked); images return as image content (5MB cap); .url files return the URL; other types (xlsx, docx, video, …) return name/size/path only.",
      inputSchema: {
        path: z.string().describe("path relative to the archive root"),
      },
    },
    async (args) => {
      try {
        const data = await readFileTool(ctx, args || {});
        if (data.kind === "image") {
          const { data: base64, mimeType, ...meta } = data;
          return {
            content: [
              { type: "text", text: JSON.stringify(meta, null, 2) },
              { type: "image", data: base64, mimeType },
            ],
          };
        }
        return toToolResult(data);
      } catch (err) {
        log(`tool error: ${err.message}`);
        return toErrorResult(err.message || String(err));
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search the archive",
      description:
        "Case-insensitive search over file names, markdown/text/html/json contents, and PDF text (cached extraction) — the local Schoology Archive ONLY, which may be stale and doesn't cover every course. For current course content, use list_materials -> open_material instead. Optionally scoped to one course. Returns path + snippet per hit, capped.",
      inputSchema: {
        query: z.string().describe("search text"),
        course: z.string().optional().describe("section_id or case-insensitive name fragment"),
      },
    },
    wrap((ctxArg, args) => searchTool(ctxArg, args)),
  );

  server.registerTool(
    "open_material",
    {
      title: "Open a materials-folder item, live",
      description:
        "Open one item from a list_materials row live (its body/target/links), and fetch the content of up to 5 of its attached files: PDF text, CSV/text as text, images as image content, anything else as name/size. A link item's target page can then be read with fetch_page. Needs the extension connected; falls back to saying so if not.",
      inputSchema: {
        course: z.string().optional().describe("section_id or case-insensitive name fragment"),
        url: z.string().optional().describe("the url field from a list_materials row"),
        id: z.string().optional().describe("the id field from a list_materials row (used if url is omitted)"),
        fetch_files: z.boolean().optional().describe("fetch attached files' content too (default true)"),
      },
    },
    async (args) => {
      try {
        const data = await openMaterialTool(ctx, args || {});
        const content = [];
        const meta = { ...data };
        if (Array.isArray(meta.file_contents)) {
          meta.file_contents = meta.file_contents.map((fc) => {
            if (fc.kind === "image") {
              content.push({ type: "text", text: `Image file: ${fc.title || fc.name || fc.url}` });
              content.push({ type: "image", data: fc.data, mimeType: fc.mimeType });
              const { data: _omit, ...rest } = fc;
              return rest;
            }
            return fc;
          });
        }
        content.unshift({ type: "text", text: JSON.stringify(meta, null, 2) });
        return { content };
      } catch (err) {
        log(`tool error: ${err.message}`);
        return toErrorResult(err.message || String(err));
      }
    },
  );

  server.registerTool(
    "fetch_page",
    {
      title: "Fetch a web page, Google Doc or Drive folder",
      description:
        "Open a link from outside Schoology. Google Docs/Slides/Sheets and Drive files come back as text (PDF/CSV export) and Drive folders as a file list, fetched through the user's signed-in Chrome (needs the extension). Anything else is a public course website page (see status/list_courses for a course's `site`, e.g. AP Comp Sci's lesson pages) — a plain GET, no cookies, address-guarded, 1h cache. HTML becomes readable text plus links (frames included); a page that is only images (old textbook exercise/solution pages) comes back with its images; an image URL comes back as an image; .md/.txt as is; PDF as text.",
      inputSchema: {
        url: z.string().describe("a public http(s) url"),
        include_images: z.boolean().optional().describe("also return the page's images (default: only when the page is just images)"),
      },
    },
    async (args) => {
      try {
        const { data, image_contents, ...meta } = await fetchPageTool(ctx, args || {});
        const content = [];
        if (meta.kind === "image" && data) content.push({ type: "image", data, mimeType: meta.mimeType });
        for (const img of image_contents || []) {
          if (img.data) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
        if (image_contents) meta.images_shown = image_contents.map(({ data: _d, ...rest }) => rest);
        content.unshift({ type: "text", text: JSON.stringify(meta, null, 2) });
        return { content };
      } catch (err) {
        log(`tool error: ${err.message}`);
        return toErrorResult(err.message || String(err));
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected over stdio");

  const shutdown = async () => {
    log("shutting down");
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Claude Desktop closing its end of stdio: exit, so the port is freed.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
