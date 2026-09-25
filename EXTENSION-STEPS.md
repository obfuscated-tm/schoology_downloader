# Unified Schoology extension — build steps

Written 2026-09-25 in a planning conversation. The canonical copy is
`neo-plan/docs/EXTENSION-STEPS.md`; `schoology_downloader/EXTENSION-STEPS.md`
is a copy.

Two Claude Code sessions share this work:

- **ext**: runs in `Programs/schoology_downloader`. Owns the Chrome
  extension (`schoology_archiver_extension/`).
- **neo**: runs in `Programs/neo-plan`. Owns the web app and database.

Goal: merge the existing Schoology Course Archiver and the planned neo-plan
extension (`docs/EXTENSION.md`) into one extension. It has five features:
enrichment for neo-plan, overlays on Schoology pages, a grades overlay,
an easy-to-reach digest of teacher updates, and study support for Claude.

## Rules for every step

- Read neo-plan's `CLAUDE.md`, `DESIGN.md`, `docs/ROADMAP.md` and
  `docs/EXTENSION.md` first. They are binding.
- The Schoology REST API is blocked. Everything runs in Owen's logged-in
  Chrome. Prefer the JSON Schoology's own pages fetch. Read page HTML (as
  the archiver does now) only where no JSON exists, and keep those reads
  in one module.
- Never put the Supabase service-role key in the extension. Never overwrite
  a user-owned field. The calendar feed stays the source that always runs.
- Materials, grades and announcements stay in the extension and the local
  archive, never in neo-plan's database.
- Do only the step you were given. When it's done, stop and tell Owen how
  to test it.

## Steps

**0. Git and plan** (ext, no feature code)
Run `git init` in `schoology_downloader`, add a .gitignore (`.DS_Store`,
`Schoology Archive/`), and make a first commit. Read the archiver and
neo-plan's importer. Then write `docs/EXTENSION-PLAN.md` in neo-plan
covering: the module layout (one shared Schoology reader with outputs
for neo-plan, the archive and the overlays), how the extension signs in
to neo-plan (its own revocable token), and the enrich payload contract.

**1. Endpoint discovery** (ext, with Owen in Chrome)
List every URL the archiver fetches and what it parses. Find JSON
sources for course per assignment, submission status, missing/late
flags, grades and announcements. Walk Owen through the DevTools Network
tab where needed. Record the results in `docs/schoology-endpoints.md`,
with IDs and tokens removed.

**2. Merge** (ext)
Restructure into the planned module layout. Archive output must stay
byte-for-byte the same, so compare a sync before and after.

**3. Enrichment** (in parallel, once the contract from step 0 is fixed)
- neo: build `POST /api/import/schoology/enrich`: the token table,
  CORS for the extension origin, a dry-run mode, and upserts on
  source_id. Anything cleared because Schoology says submitted must say
  so and be undoable.
- ext: send course, submitted status and bodies after each sync.

**4. Submit detection and missing flags**
- ext: on a Schoology submit, post it immediately.
- neo: when the gradebook says missing but the item is cleared, flag it.
  Add a DESIGN.md entry first.

**5. Overlays** (ext)
On Schoology assignment pages, add a chip in a shadow DOM: Owen's date,
ready state, a Turn in button, and "Add to neo-plan" on anything not
tracked. Follow DESIGN.md.

**6. Grades overlay** (ext)
A what-if calculator on grades pages using category weights, plus an
alert when a new grade posts. Check what Schoology Plus already does
first so this doesn't duplicate it.

**7. Teacher updates** (ext)
A digest in the side panel, grouped by class and newest first, with
unread markers. Keep writing `updates.md` to the archive.

**8. Study and Claude** (neo)
A local MCP server over neo-plan's database (read-only) and the Schoology
Archive folder. Tools: upcoming exams, a unit's materials for an exam,
and grades by class. Hide answer keys until Owen has tried. Exam cards
link to the unit's archive folder.
