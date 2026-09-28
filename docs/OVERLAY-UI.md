# Overlay UI: grades, materials, assignment pages

Agreed with Owen on 2026-09-26. The reference render is `docs/overlay-demo.html`
(open it in a browser). This file is the spec: where the demo and this file
disagree, this file wins.

## Principle

The overlay **supplements Schoology; it never replaces it.** Schoology's own
tables, buttons and layout stay as they are. The extension only adds small
elements next to them, and only information Schoology doesn't already show.
Never repeat what's on the page (course %, category %, due date, score,
instructions).

- Turning work in happens **only with Schoology's own Submit button**. The
  extension has no Turn in button on Schoology pages. Submit detection (already
  built) clears the item in neo-plan.
- Everything the extension adds sits in its own shadow DOM (as now) and uses the
  overlay's own look (below), not neo-plan's DESIGN.md.
- **Overlay switch.** One on/off setting, kept in `chrome.storage.local` and applied on
  every Schoology page. Toggled by a small switch placed on the page, and by
  Alt+S. Off means every added element is hidden and Schoology looks untouched.

## Look (the overlay's own, themeable)

| Token | Value | Use |
|---|---|---|
| `--accent` | `#1D5EA8` (per theme, see below) | everything the extension adds that isn't a state: links, what-if inputs, projections |
| `--accent-soft` | `#E7EFF8` (per theme) | filled what-if input, a row with a what-if score |
| `--ink` / `--dim` / `--faint` | `#1F2429` / `#5E6670` / `#8A929B` | text |
| `--line` / `--sunk` | `#DCE0E5` / `#F6F7F9` | borders, strips |
| `--bad` / `--bad-soft` | `#B8430F` / `#FBEDE5` | Missing, negative impact |
| `--good` / `--good-soft` | `#23794A` / `#E6F3EC` | Submitted, positive impact |

Type: Instrument Sans for text, JetBrains Mono for every number (tabular-nums).
Bundle both as local `.woff2` (400/500/600), not a Google Fonts link. 6px radius. No shadows.

Only `--accent` and `--accent-soft` change with the theme (`overlays/theme.js`); everything
else above is constant regardless of theme, light or dark — a dark theme gets its dark
look from inverting the whole page (below), not from swapping these tokens.

## Archive button and settings

Beside the Overlay switch (bottom left, shown only while the overlay is on) sit two
square buttons: **Archive**, then a gear.

The Archive button (`overlays/switch.js`) opens `overlays/archive.js`'s card —
dimmed page, inset card, ×/Esc/click-outside closes, closed shadow root via
`createHost`, same pattern as `overlays/launcher.js`. The card is only a UI: the
archive job itself runs in the extension's offscreen document (it needs
`DOMParser`, same as the neo-plan sync's `offscreen/parse.js`; `offscreen/archive.js`
shares that one document, routed by message `target`), owned by `background.js` as
a single job at a time, mutually exclusive with the neo-plan sync. Closing the card
or navigating away from Schoology does not stop the job — reopening the card on any
Schoology page (even a different course, even a different tab) shows the live
status, count and log, pushed over a `chrome.runtime.connect({ name: 'archive-card'
})` port and mirrored in `chrome.storage.session` so a freshly opened card catches
up immediately. On a course page (`/course/(\d+)`) the card knows its `courseId`
from the URL; the course name comes from the page (falling back to `Course
123`). The card's own message contract: `archiveStart {courseId, options}` (the
course's host comes from `sender.url`, not anything the page claims),
`archiveStop`, `archiveState`. Alt+Shift+K / `killEverything()` stops a running
archive job too.

Because the offscreen document only has `chrome.runtime`, everything else
(`chrome.downloads.*`, `chrome.scripting.executeScript`, `chrome.tabs.*`,
`chrome.storage.*`) is proxied to the service worker through
`outputs/archive/chrome-bridge.js`: the same exported functions take a "direct"
branch when called from the service worker and a `chrome.runtime.sendMessage`
proxy branch otherwise, so `background.js`'s `archiveProxy` handler is just an
allowlist (`PROXY_OPS`) of those same functions, accepted only from the offscreen
document's own URL.

Files default to the Downloads folder, as before (no picker). A custom folder
(File System Access handle, kept in IndexedDB — `outputs/archive/folder.js`) can be
chosen from Settings, in its own tab only (the picker is refused in a
cross-origin iframe): a "Save archives to" row there shows Downloads or the chosen
folder's name, with Choose/Change and Clear. The offscreen document reads the same
IndexedDB handle (same extension origin) and uses it only if
`queryPermission({ mode: 'readwrite' })` is already `'granted'` — there is no user
gesture in an offscreen document to call `requestPermission`, so a folder that has
lost permission just falls back to Downloads with one log line, not a prompt.

The gear opens a small popover, three groups:

1. **Theme** — a grid of themes (below).
2. **Grades** — the "Percent beside scores" checkbox.
3. **neo-plan** — everything that used to live in the extension's side panel (now
   removed): server, token, the Schoology last-read line with a Check now button,
   and the Courses mapping, plus a "Save archives to" row (below). This group is an `<iframe>` of the
   extension's own `panel/settings.html?embed=1`, not inline controls — a Schoology
   page must never see the neo-plan token, so it stays behind the frame boundary (the
   same precedent as `overlays/launcher.js`'s card, which frames neo-plan itself).
   The frame is created lazily on first open and then kept, so reopening the popover
   is instant. It posts `{ type: 'np-settings-height', height }` to the parent
   window whenever its content's size changes; `switch.js` accepts that only from
   `e.source === frame.contentWindow` and the extension's own origin, and resizes
   the frame (clamped to 40–600px). The frame is *not* re-inverted under a dark
   theme (`.npframe { filter: none }` outranks the host's plain `iframe`
   re-invert rule): it's our own page, so it goes dark along with the popover.
   For that it paints no surface of its own — embedded, `settings.css` makes the
   body transparent and drops its padding and its "Settings" heading, so the
   popover's surface and labels show through and line up. Below 420px wide
   (always, in the popover) each course's column picker takes its own line.
   `test/settings-page.html` (and `?embed=1`) draws the page with a fake `chrome`.

Theme and Grades are one setting object in `chrome.storage.local`
(`ui.js`: `SETTINGS_KEY`, `getSettings`/`onSettings`/`setSetting`), applied on every
open Schoology tab like the Overlay switch itself. The popover scrolls
(`max-height: calc(100vh - 72px)`) rather than overflow the viewport once the
neo-plan frame is in it.

`overlays/theme.js` owns the theme list (`THEMES`, an ordered object of key →
`{ name, dark, header, headerText?, page, accent, accentSoft }`). Every colour is
the colour as seen, dark themes included; the code pre-inverts for dark themes.
`header` is one colour or gradient stops; `page` is the backdrop behind
Schoology's white cards and past the page's edges):

- `schoology` (default) — no page changes at all. `header` is `null`; `accent`/
  `accentSoft` are the overlay's original blue.
- `ocean`, `forest`, `plum`, `crimson`, `graphite` — light: a coloured header bar
  (white text and icons), a lightly tinted page, a matching accent.
- `sunset`, `aurora`, `sakura`, `matcha`, `rainbow` — light, with gradient headers
  (rainbow's text gets a shadow to stay readable on its yellow).
- `dark`, `midnight`, `dracula`, `nord`, `synthwave`, `ember` — dark: the whole
  page inverted ("smart invert", below), each with its own header and page tint.

**Page styling.** `themeCss(key)` (pure, testable in node) returns the CSS for one
`<style id="np-theme">` appended to `document.documentElement` — additive, present
only while the overlay is on and the theme isn't `schoology`, removed the instant
either stops being true. It targets Schoology's header with structural selectors,
not its (hashed, versioned) class names. Checked on fuhsd.schoology.com
(2026-09-27): `#header` is the district's colour strip, `#header > header` the
white bar, then `nav > ul > li`, each li holding its `<a>`/`<button>` directly or
inside a `<div>` (Courses, Groups, Apps and the user menu, which have their own
white background). So: `#header, #header > header, #header > header nav` get the
bar colour; `nav > ul > li > :is(a, button)` and `nav > ul > li > div > :is(a,
button)` go transparent with the header text colour and a subtle hover, and their
`svg` icons (drawn in fixed fills, not currentColor) are flattened to that colour
with a filter. Dropdown panels sit deeper and are left alone.

**Dark themes ("smart invert").** Schoology's markup is large and changes often, so
rather than reskin it, dark themes invert the whole page: `html { filter: invert(1)
hue-rotate(180deg) }`. A filter on the root element is exempt from the rule
that a filtered ancestor becomes the containing block for `position: fixed`
(Filter Effects spec), so the switch bar, the launcher and the Archiver card stay
put while the page scrolls — checked in Chromium on `test/theme-page.html`, 3000px
tall, at several scroll positions. Keep the filter on `html`: moving it to `body`
or a wrapper would lose that exemption.
html's background paints the canvas: inside the window it's filtered like the
page, but the rubber-band area past the page's edges isn't, so no single colour is
right for both. html and body get the theme's `page` colour pre-inverted, and dark
themes set `overscroll-behavior: none` so the light bounce never shows. Real media would look like a film negative under that, so
a second rule re-inverts it: `img, video, iframe, canvas, picture, svg image, embed,
object, [style*="background-image"]` — except a blanket `img` would double-invert
one nested in a `picture` (the `picture` selector already re-inverts it once), so
the image part of that selector is `:not(picture) > img`.

A colour we want the *page* to display under that filter — the header, its text —
has to be written pre-inverted, since the filter runs on top of it. `preInvert(hex)`
(pure) computes the exact pre-image by running the same filter math forward: invert
per channel, then the CSS hue-rotate(180deg) matrix from the Filter Effects spec.
The combined operation is its own inverse, so `preInvert` and "apply the filter" are
the same function.

Our own hosts get inverted right along with the page (they're real DOM, just in a
shadow root), which is exactly what makes their light tokens (ink, surface…) come
out dark; `accent`/`accentSoft` are given as seen, so they're pre-inverted for
dark themes like the page's colours (`paint(hex, dark)`). Inverted as-is, white
surfaces come out pure black, harsh against the theme's page, so dark themes also
set `--surface` (the page mixed 7% towards white), `--sunk` (the page) and
`--line` (16% towards white), pre-inverted: our cards sit a step above the page. The settings menu's
swatches, and the grades page's what-if bar (an inline style on Schoology's cell),
are painted the same way.
Every `createHost` root gets a second `<style data-np-theme>` (kept in sync by
`ui.js`, which learns the current theme's CSS from a small hook `theme.js`
registers — no import cycle) holding `:host { --accent; --accent-soft }` and, in
dark themes only, the same media re-invert rule — a page stylesheet can't reach
into a shadow root, so without this an `<img>`/`<iframe>` inside one (the
neo-plan launcher's card) would come out negative.

**Early apply.** A second content script, `overlays/theme-early.js`
(`document_start`, same matches as `boot.js`), dynamic-imports `theme.js` and calls
its `start()` as soon as possible, so a dark theme doesn't flash white before
`boot.js` and the rest of the overlay load at `document_idle`. `start()` waits for
both the Overlay switch (`onOverlay`) and the settings (`onSettings`) before
touching the page.

**Caveats.** The header selectors are written against Schoology Plus's reference
CSS and a hand-built stand-in page (`test/theme-page.html`), not real Schoology
markup — if `#header > header` changes shape, the header colouring quietly does
nothing (additive-by-default: worst case is a plain white/black header, never a
broken page). Smart invert is a blunt instrument: anything Schoology draws as a
CSS gradient, a background-image on a non-`img` element without an inline `style`
attribute, or canvas-drawn UI may invert incorrectly or not re-invert at all; we
accept that trade for not having to track Schoology's markup.

## Grade math

- Category % = points earned / points possible for graded items in that category.
- Course % = Σ(weight × category %) / Σ(weights of categories that have grades).
- **Weights must come from the gradebook page.** Find where Schoology shows
  them (category row text or the page's JSON) and record it in
  `docs/schoology-endpoints.md`. If a course has no weights, fall back to total
  points and let Owen type weights in (saved per course).
- Items with no grade ("—") are left out, not counted as zero.
- Impact of an item = course % with it − course % without it.
- History = replay graded items in due-date order, recomputing after each day.
  What-ifs, planned items and drops (below) are hypothetical or a page-view-only
  decision; history is the real term, so it ignores all three.
- **What-if** (`grademath.js` opts.whatIf) used to only cover ungraded ("—")
  rows. It now also overrides a graded item's score (and its points, if given)
  — Schoology Plus lets you edit any grade, and the overlay's what-if follows
  suit.
- **Drop** (opts.drop, an array or `Set` of item ids) excludes an item from the
  math entirely, as if it weren't in the gradebook — a real decision the
  student is making, not a hypothetical, so `grade`/`impact`/`categoryFloor`/
  `needFor` all respect it and only `history` doesn't.

## 1. Grades page (inline in Schoology's table)

The first cut of this had every control always on screen — a dashed input on
every ungraded row, a full-row blue fill for any what-if, a permanent "+ Plan…"
row under each category. Owen found it too loud. It's now quiet by default:
nothing but the percent shows until a row is hovered or focused, and an active
what-if marks its row with a thin bar instead of a fill.

- **Course row:** a small sparkline button ("Graph") that opens a row under it
  with a step chart of the replayed history: y axis around the grade range, a
  dashed A-cutoff line, hover crosshair + tooltip (date, %, item that changed
  it), and a dashed projection when any what-if or drop is set. Right column:
  "X.XX above A". When any what-if or drop exists, show "→ letter %, ±delta,
  Reset" beside Schoology's grade; Reset clears every what-if, drop and planned
  item.
- **Category rows:** "weight N%" beside the name, only when Schoology shows no
  (N%) itself; right column "A holds down to NN.N%" (lowest this category can
  drop, the others unchanged, and still keep the A). A faint "+ plan" text
  button, shown only while the row is hovered or focused (`:host-context(tr:hover)`
  plus `:focus-within`, so Tab still reaches it — opacity 0, not `display: none`),
  opens a row of our own under the category: the same name/worth/score/"need
  X/pts for an A" (or "any score keeps an A" / "out of reach with this alone")
  editor as before, but it exists only while planning is open — Remove closes
  it again rather than just clearing its score.
- **Graded item rows:** a small percent beside Schoology's own score (mono,
  faint; Settings → "Percent beside scores" hides it). Hovering or focusing the
  row reveals two faint text buttons beside the percent:
  - **edit** — Schoology Plus lets you edit any grade, so the overlay does too.
    Swaps in a score input prefilled with the real earned value ("/ possible"
    beside it, not editable). Typing overrides that item in the math and the
    impact tag updates for it; the percent shown updates to the what-if value
    too. Clearing the box and blurring, or Esc, restores the real score.
  - **drop** — excludes the item from the math entirely (grade, impact,
    category floor, "need for an A" all skip it), as a real decision rather
    than a hypothetical. Schoology's own score in that row is struck through
    and faded; the right column shows "dropped · undo" instead of an impact
    tag. Reset undrops everything.
  - The impact tag itself is unchanged for an untouched row; a row with an
    active what-if shows its impact recomputed under every other what-if and
    drop currently set, not just its own.
- **Ungraded rows ("—"):** hovering or focused reveals a faint "what if" text
  button beside the dash (same hover/focus mechanism as "+ plan" and "edit").
  Clicking it swaps in a score input (and a points input too, when the row
  doesn't say what it's out of), focused. Typing recalculates everything live
  and marks the row (below). Clearing the box(es) and blurring collapses it
  back to the hidden button; while a value is set the input stays visible even
  unfocused and unhovered.
- **Row marker:** a row with an active what-if gets a 3px inset left bar on its
  first cell (not the old full-row fill — too loud), only while the overlay is on.
- What-ifs, drops and planned items are per-page-view only. Never saved.
- Check what Schoology Plus already does here first (EXTENSION-STEPS step 6), and tell Owen if this duplicates it.

## 2. Materials page and folders

- A one-line strip above the list: "Only open work" checkbox, "N open in this
  course", and on the right "Archive saved <when> · Sync now".
- **Folder rows**, right side: a short status ("1 missing · 1 to turn in · 1 to do",
  or "All turned in"), then the folder's scored % (points earned / graded points in
  it) in mono. Folders keep opening the Schoology way (their own page).
- **Assignment rows**, right side (one marker, replaces today's ○ ✓ × markers):
  - graded → score `10 / 10`
  - submitted, not graded → "Submitted"
  - neo-plan done, not submitted → filled circle + "Done, not submitted"
  - not done → empty circle + short due date
  - missing → red "Missing" pill + empty circle
  - not in neo-plan → "+ Add to neo-plan"
- "Only open work" hides everything except missing / done-not-submitted / not-done
  rows and folders that contain them. On a Materials root page, that requires reading
  folder contents (reuse the reader's folder parsing, cached).

## 3. Assignment page

- **Chip** (one line, under Schoology's due date), replacing the current chip:
  - not submitted: class dot + name · Missing (if missing) · "A zero costs −N.NN" ·
    "Remove from neo-plan". No Turn in button.
  - after a Schoology submit: "Submitted" (green) · "Cleared in neo-plan" · "Late by N days" if late.
  - graded: "Graded" · "Moved your course grade ±N.NN" · "Nth lowest of M in <category>".
  - not in neo-plan: "Add to neo-plan"; removed: "Removed · Add back" (as now).
- **Sidebar**, under Schoology's Grade box, only when ungraded: "What if I get [ ] / pts" →
  "Course grade NN.NN% ±delta".
- No "Also in <folder name>" list below the instructions (removed 2026-09-27:
  Owen found it cluttered the page without adding much).
