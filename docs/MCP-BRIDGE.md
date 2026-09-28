# Schoology MCP ↔ extension bridge

A local MCP server (`mcp/`, Node) that lets Claude Desktop read Owen's
Schoology. Read-only. It answers from three sources, best first:

1. **live**: the extension fetches Schoology right now, through Owen's
   logged-in Chrome. Needs Chrome open and the extension connected.
2. **snapshot**: the last thing the extension pushed (its 15-minute
   background sync), cached by the MCP on disk so it survives Chrome closing.
3. **archive**: the `Schoology Archive/` folder the Archiver writes
   (`schoology_downloader/Schoology Archive/` on this Mac).

Every tool result says which source it came from and how old it is.
No answer-key hiding: the MCP returns everything it is asked for.

## Transport

- The MCP server listens on a WebSocket at `ws://127.0.0.1:{port}`, first
  free port in **47815–47819** (Claude Desktop can run more than one copy).
- The extension's service worker connects **out** to every port in that
  range that answers, when the worker starts and on a 1-minute alarm
  (`mcp-connect`). One socket per port; already-open ports are skipped.
- The server accepts a connection only if the handshake's `Origin` header
  starts with `chrome-extension://` (web pages cannot forge it). If the env
  var `SCHOOLOGY_EXT_ID` is set, the origin must be exactly
  `chrome-extension://{SCHOOLOGY_EXT_ID}`.
- Every message is one JSON object, one per WebSocket text frame.

## Messages

Extension → MCP:

| `type` | fields | when |
|---|---|---|
| `hello` | `version` (manifest version), `host` (e.g. `fuhsd.schoology.com`) | first message after open |
| `snapshot` | `snapshot` (the `syncSnapshot` object, see below) | right after `hello`, and after every sync run |
| `ping` | — | every 20 s (keeps the MV3 worker alive) |
| `response` | `id`, `ok`, `data` or `error`, optional `message` | answer to a `request` |

MCP → extension:

| `type` | fields |
|---|---|
| `pong` | — (answer to `ping`) |
| `request` | `id` (string), `op`, `args` (object) |

`error` codes: `login` (not signed in to Schoology), `ratelimit`,
`bad_args`, `op` (unknown op), `quiz` (the page is a quiz/assessment and was
not followed), `schoology` (anything else; `message` says what).

The MCP times a request out after 45 s and then falls back as if no
extension were connected.

## Ops (all GET-only, through `SchoologyClient` and the shared limiter)

Every Schoology read obeys the same guard `sync/sync.js` uses: never a quiz
taking URL (`isQuizTakingUrl`), never an `/assessments/` page, redirects to
one are reported as `error: 'quiz'` and never followed. Parsing happens in
the offscreen document (new `parseKind` kinds as needed). No DOM nodes in
results; everything is plain JSON.

| `op` | `args` | `data` |
|---|---|---|
| `courses` | — | `[{ section_id, title, section_title, … }]` as `parseCourses` returns |
| `todo` | — | `{ upcoming: [...], overdue: [...], recent: [...] }`; rows carry at least `schoology_id, title, course, section_id, due, url` (the same source the To Do column uses) |
| `grades` | `section_id` | `{ section_id, rows }`, rows as `parseGrades` returns (no `el`) |
| `assignment` | `id` | `{ id, url, title, type, due, folder, instructions_md, grade, comments, submission: { state, late? }, attachments: [{ title, url }] }`, whatever the page shows; fields it can't find are `null` |
| `updates` | `section_id`, `page` (default 0) | `{ section_id, page, posts: [{ author, date, body_md }] }` |
| `materials` | `section_id`, `folder_id` (optional, default root) | `{ section_id, folder_id, rows: [{ kind, title, id, url, due? }] }` (folders, files, assignments, pages, links…) |

`args` ids are validated as `^\d{1,20}$`; anything else is `bad_args`.

## The snapshot

`syncSnapshot` as `sync/sync.js` already writes it, plus:

- `lists: { upcoming, overdue, events }`: the rows the sync read, with
  titles, course and due dates (not just ids), so the MCP can answer
  "what's due" with Chrome closed.
- `neoplan: true | false`: whether this run talked to neo-plan.

The sync now runs **without a neo-plan token**: with no token configured it
reads the Schoology parts (courses, home lists, events) and skips every
neo-plan step (course map, gradebooks, open ids, status checks, enrich).
With a token, behaviour is unchanged.

## MCP disk state

`~/.schoology-mcp/cache.json`: the last snapshot and the last live result
per (op, args), each with the time it was fetched. PDF text extracted for
search/read is cached under `~/.schoology-mcp/pdftext/`, keyed by path and
mtime.

## Course identity

Live data names a course by `section_id`. An archive course folder's
`INDEX.md` links `…/course/{section_id}/materials`, which is how the MCP
maps between them. Tools take a course as a `section_id` or any
case-insensitive fragment of its name.
