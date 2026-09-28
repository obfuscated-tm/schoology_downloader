#!/usr/bin/env node
// Local, read-only MCP server exposing Owen's Schoology coursework to Claude
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
} from "./src/tools.js";

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

  const ctx = { bridge, cache };

  const server = new McpServer({ name: "schoology-mcp", version: "1.0.0" });

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
        "Is the Chrome extension connected? Host, bridge port, last snapshot time, archive path, and archived courses with their last-synced time.",
      inputSchema: {},
    },
    wrap(statusTool),
  );

  server.registerTool(
    "list_courses",
    {
      title: "List Schoology courses",
      description:
        "List the user's Schoology courses: live course list, else the last snapshot, else the archive folders. Notes which courses have an archive.",
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
        "Fetch an assignment/quiz by Schoology id (live-capable) or by a title fragment (archive search). Optionally scope the title search to one course. Returns instructions, due date, grade, and the attachment folder listing.",
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
        "List a course's materials folder: live, else the archive's directory tree (one level by default, or `depth` levels), skipping .DS_Store and _archive.",
      inputSchema: {
        course: z.string().describe("section_id or case-insensitive name fragment"),
        folder_id: z.string().optional().describe("Schoology folder id (live only); default root"),
        path: z
          .string()
          .optional()
          .describe("sub-path within the course's archive folder (archive fallback only)"),
        depth: z.number().int().min(1).max(6).optional().describe("archive listing depth, default 1"),
      },
    },
    wrap((ctxArg, args) => listMaterialsTool(ctxArg, args)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file from the archive",
      description:
        "Read one file from the Schoology Archive by path (relative to the archive root). Markdown/text/html/json return as text (~200KB cap); PDFs return extracted text (cached, page-marked); images return as image content (5MB cap); .url files return the URL; other types (xlsx, docx, video, …) return name/size/path only.",
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
        "Case-insensitive search over file names, markdown/text/html/json contents, and PDF text (cached extraction) in the Schoology Archive. Optionally scoped to one course. Returns path + snippet per hit, capped.",
      inputSchema: {
        query: z.string().describe("search text"),
        course: z.string().optional().describe("section_id or case-insensitive name fragment"),
      },
    },
    wrap((ctxArg, args) => searchTool(ctxArg, args)),
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
