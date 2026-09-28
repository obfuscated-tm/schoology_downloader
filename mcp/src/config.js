// Configuration: env vars with defaults, per docs/MCP-BRIDGE.md and the task spec.
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(__dirname, ".."); // mcp/

export const ARCHIVE_ROOT = path.resolve(
  MCP_DIR,
  process.env.SCHOOLOGY_ARCHIVE || "../Schoology Archive",
);

export const EXT_ID = process.env.SCHOOLOGY_EXT_ID || null;

export const MCP_HOME = path.resolve(
  (process.env.SCHOOLOGY_MCP_HOME || "").trim() ||
    path.join(os.homedir(), ".schoology-mcp"),
);

export const CACHE_PATH = path.join(MCP_HOME, "cache.json");
export const PDFTEXT_DIR = path.join(MCP_HOME, "pdftext");

export const BRIDGE_PORT_RANGE = [47815, 47816, 47817, 47818, 47819];

export const REQUEST_TIMEOUT_MS = 45_000;
