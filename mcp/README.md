# schoology-mcp

A local, read-only [MCP](https://modelcontextprotocol.io) server that lets
Claude Desktop read your Schoology coursework. It runs entirely on your
computer, over stdio — no data leaves the machine except what Claude Desktop
itself does with it.

It answers from three sources, best first, and every tool result says which
one it used and how old the data is:

1. **live** — the `schoology_archiver_extension` Chrome extension fetches
   Schoology right now, through your logged-in Chrome, over a local
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
      "args": ["/Users/you/path/to/schoology_downloader/mcp/server.js"]
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
| `SCHOOLOGY_MCP_HOME` | `~/.schoology-mcp` | Where `cache.json` (snapshot + live cache), `pdftext/` (PDF text-extraction cache), and `files/` (downloaded file / fetched page cache) live |

## Course websites (`sites.json`)

`mcp/sites.json` maps a course to a public website outside Schoology, so
Claude knows it exists and can read it with `fetch_page`:

```json
[
  { "course": "AP Comp Sci", "url": "https://apcs.tinocs.com/", "note": "Lessons are plain .md pages, e.g. https://apcs.tinocs.com/lesson/A1/A.md" }
]
```

`course` is matched as a case-insensitive fragment against the course's
name/title (either direction), the same way tool arguments resolve a
course. A missing `sites.json` just means no sites are configured. It's
read once at startup — restart the server after editing it.

The math course's site is still TBD; add it the same way once known (a
plain `{ "course": "...", "url": "...", "note": "..." }` entry — `note` is
optional and worth using if the site has a quirk like APCS's, e.g. where
per-unit PDFs live or a fixed URL pattern for lesson pages).

## Tools

All tools are read-only and return `{ source: "live" | "snapshot" | "archive", as_of, ... }`, plus a one-line `note` when they fell back and why.

- **`status`** — is the extension connected, host, bridge port, last snapshot time, archive path, archived courses with their last-synced time, and any course websites from `sites.json`.
- **`list_courses`** — live course list → snapshot → archive folders; notes which have an archive, and attaches a `site` to courses with one.
- **`get_todo`** — what's due: live → snapshot's lists → a scan of the archive's assignment files for future due dates (soonest first).
- **`get_grades(course)`** — live grades → archived `grades.md`.
- **`get_assignment(course?, id?, title?)`** — live by id; by title, resolves to an id live via the to-do lists and (course-scoped) gradebook, then fetches it live; otherwise falls back to an archive search by id/title fragment (optionally scoped to a course). Several title matches → an error listing the candidates. Returns instructions, due date, grade, and the `… files/` attachment listing (archive) or `attachments` (live).
- **`get_updates(course, page?)`** — live announcements → archived `updates.md` (if any were captured).
- **`list_materials(course, folder_id?, path?, depth?)`** — live materials folder → the archive's directory tree (one level, or `depth` levels), skipping `.DS_Store` and `_archive`. Live rows are Schoology wrapper URLs — open one with `open_material`, not by visiting the URL.
- **`open_material(course?, url?, id?, fetch_files?)`** — **live only.** Opens one `list_materials` row: its body/target/links, then (unless `fetch_files: false`) the content of up to 5 of its attached files, in order — PDF → extracted text, CSV/text → text, images → image content, anything else → name/size. A link item's `target` page can be read with `fetch_page`. Files are cached under `~/.schoology-mcp/files/` by a hash of their URL. With no extension connected, says so and points at `search`/`read_file`.
- **`fetch_page(url)`** — fetch a public course website page (see "Course websites" below): plain `http(s)` GET, no cookies, a 15s timeout, a 15MB cap, at most 5 redirects (each re-checked against the address guard — no loopback/private/link-local/CGNAT/IPv6 ULA or link-local targets). HTML → readable text plus a capped absolute-link list; `.md`/`.txt` → as is; PDF → extracted text. Cached for 1 hour under `~/.schoology-mcp/files/`.
- **`read_file(path)`** — **archive only.** Read one file from the archive by path relative to the archive root (rejects traversal/symlink escape). `.md`/`.txt`/`.html`/`.json` → text (~200KB cap, says if truncated); `.pdf` → extracted text (cached by mtime, with page markers); images → MCP image content (5MB cap); `.url` → the URL inside; anything else (`.xlsx`, `.docx`, video, …) → name/size/path only. May be stale and doesn't cover every course — for current course content use `list_materials` → `open_material` instead.
- **`search(query, course?)`** — **archive only.** Case-insensitive search over file names, markdown/text/html/json contents, and PDF text (lazily extracted and cached); returns path + snippet per hit, capped. Same staleness/coverage caveat as `read_file`.

A `course` argument accepts a `section_id` or a case-insensitive fragment of the course's name; an ambiguous fragment returns an error listing the matching candidates.

The server also sets MCP `instructions` (surfaced to Claude at connect time) explaining the live-vs-archive tradeoff and pointing at `sites.json` course websites, so this isn't just a README note.

## Tests

```sh
npm test
```

Runs `node --test` over `test/`: a temp archive fixture, a fake extension
(a `ws` client presenting a `chrome-extension://` origin), and a real
`server.js` process spawned over stdio against the actual archive on disk.
