// stdout is the MCP channel (stdio transport) — every log line goes to stderr.
export function log(...args) {
  console.error("[schoology-mcp]", ...args);
}
