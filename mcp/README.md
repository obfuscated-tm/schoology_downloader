# schoology-mcp

A local, read-only [MCP](https://modelcontextprotocol.io) server that lets
Claude Desktop read Owen's Schoology coursework. It runs entirely on this
Mac, over stdio — no data leaves the machine except what Claude Desktop
itself does with it.

It answers from three sources, best first, and every tool result says which
one it used and how old the data is:

1. **live** — the `schoology_archiver_extension` Chrome extension fetches
   Schoology right now, through Owen's logged-in Chrome, over a local
   WebSocket bridge. Needs Chrome open and the extension connected.
2. **snapshot** — the last thing the extension pushed (its background sync),
   cached on disk so it survives Chrome closing.
3. **archive** — the `Schoology Archive/` folder the Archiver writes to disk.

The full extension↔MCP contract (message types, ops, snapshot shape) is
documented in `../docs/MCP-BRIDGE.md`.

## Install

```sh
cd mcp
npm install
```

## Run it standalone (for testing)

```sh
node server.js
```

It logs to stderr only (stdout is the MCP channel) and will print which port
it bound for the extension bridge, e.g.:

```
[schoology-mcp] bridge: listening on ws://127.0.0.1:47815
[schoology-mcp] MCP server connected over stdio
```

If none of ports 47815–47819 are free, it logs that and runs in
archive/snapshot-only mode — every tool still works, just without `live`.

## Claude Desktop config

Add this to Claude Desktop's `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`),
using the **absolute path** to `server.js` on this machine:

```json
{
  "mcpServers": {
    "schoology": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/owenleung/Documents/Programs/schoology_downloader/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

## Environment variables

All optional; defaults shown.

| Var | Default | Meaning |
| --- | --- | --- |
| `SCHOOLOGY_ARCHIVE` | `../Schoology Archive` (relative to `mcp/`) | Path to the Schoology Archive folder |
| `SCHOOLOGY_EXT_ID` | unset | If set, only accept a WebSocket handshake from `chrome-extension://{this id}` (otherwise any `chrome-extension://` origin is accepted) |
| `SCHOOLOGY_MCP_HOME` | `~/.schoology-mcp` | Where `cache.json` (snapshot + live cache) and `pdftext/` (PDF text-extraction cache) live |

## Tools

All tools are read-only and return `{ source: "live" | "snapshot" | "archive", as_of, ... }`, plus a one-line `note` when they fell back and why.

- **`status`** — is the extension connected, host, bridge port, last snapshot time, archive path, and archived courses with their last-synced time.
- **`list_courses`** — live course list → snapshot → archive folders; notes which have an archive.
- **`get_todo`** — what's due: live → snapshot's lists → a scan of the archive's assignment files for future due dates (soonest first).
- **`get_grades(course)`** — live grades → archived `grades.md`.
- **`get_assignment(course?, id?, title?)`** — live by id, or an archive search by id/title fragment (optionally scoped to a course); returns instructions, due date, grade, and the `… files/` attachment listing.
- **`get_updates(course, page?)`** — live announcements → archived `updates.md` (if any were captured).
- **`list_materials(course, folder_id?, path?, depth?)`** — live materials folder → the archive's directory tree (one level, or `depth` levels), skipping `.DS_Store` and `_archive`.
- **`read_file(path)`** — read one file from the archive by path relative to the archive root (rejects traversal/symlink escape). `.md`/`.txt`/`.html`/`.json` → text (~200KB cap, says if truncated); `.pdf` → extracted text (cached by mtime, with page markers); images → MCP image content (5MB cap); `.url` → the URL inside; anything else (`.xlsx`, `.docx`, video, …) → name/size/path only.
- **`search(query, course?)`** — case-insensitive search over file names, markdown/text/html/json contents, and PDF text (lazily extracted and cached); returns path + snippet per hit, capped.

A `course` argument accepts a `section_id` or a case-insensitive fragment of the course's name; an ambiguous fragment returns an error listing the matching candidates.

## Tests

```sh
npm test
```

Runs `node --test` over `test/`: a temp archive fixture, a fake extension
(a `ws` client presenting a `chrome-extension://` origin), and a real
`server.js` process spawned over stdio against the actual archive on disk.
