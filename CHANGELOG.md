# Changelog

The extension and the MCP server are versioned separately (see [Versioning and releases](README.md#versioning-and-releases)). Newest first.

Entries before extension 1.10.0 / MCP 1.1.0 were reconstructed from the git history. Apart from MCP 1.0.0 (tag `mcp-v1.0.0`), those versions were never tagged, so they're listed by date.

## 2026-09-28 — Extension 1.11.0

Tag: `ext-v1.11.0`

### Extension
- To Do sidebars (home and course): each row keeps its status under the due date and gets stacked buttons at its right: **✓ Done** / **↶ Not done**, then **↑ Turn in** on an open assignment or **↶ Undo** on a turned-in one.
- Grades: the overlay no longer squeezes the title column. Grades sit where plain Schoology puts them; the empty comment column gives up the room instead.
- Content scripts may now ask neo-plan to turn in and put back (only the To Do panels offer it; an assignment page still turns in only through Schoology's Submit).

### Repo
- MIT license.
- README rewritten as a friendly, picture-first guide with screenshots (`docs/images/`); technical detail moved to a collapsible reference at the bottom.
- Repo README and this changelog, written for anyone setting it up (any school's Schoology, neo-plan optional, recommended archive location, grading-scale note).
- Removed the legacy Python downloader (`schoology_downloader.py`, `HOW_TO_RUN.txt`); the extension replaces it.

## 2026-09-27 — Extension 1.10.0 · MCP 1.1.0

Tags: `ext-v1.10.0`, `mcp-v1.1.0`

### Extension
- **Quiz quiet mode:** while any tab is on a Schoology Test/Quiz page, no sync, no MCP bridge, and no archive run. Opening a quiz stops everything as Alt+Shift+K does; it resumes when the quiz tab closes. Overlays are now kept off every `*assessment*` page.
- Find materials across courses, deep live listing, Google Drive folders, faster reconnect to the MCP server.

### MCP server
- `list_materials` / `open_material` read course materials live; `fetch_page` reads public course websites listed in `sites.json`.
- Reads the Pre-Calc textbook site (framesets, image-only pages).
- Live data is preferred over the snapshot and archive.
- The bridge probes a port with `fetch` before opening a WebSocket.

## 2026-09-27 — MCP server 1.0.0

- First version: a local, read-only MCP server so Claude Desktop can read Schoology, live through the extension, with a snapshot cache and archive fallback.

## 2026-09-25 to 2026-09-27 — Extension (unified)

- The Archiver moves into an in-page card; neo-plan settings move into the gear. No side panel.
- Themes and a settings menu; what-ifs, dropping a grade, and percents on the Grades page.
- Our own To Do column on the Schoology home page with type tags and clickable Studied / Done; a course's own To Do in place of Schoology's Upcoming column.
- Overlays on Grades, Materials, and assignment pages that only add to Schoology.
- neo-plan reads Schoology in the background; a neo-plan card on Schoology's pages with Remove / Add back.
- The quiz guard also refuses `/assessments/{id}/take|start|resume` and the dropbox submit form.
- The archiver is split into reader, archive output, and panel, with no behaviour change.

## Before 2026-09-25

- The original Schoology Course Archiver extension and the Python downloader (`schoology_downloader.py`), as they were before the unified extension.
