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

## Look (the overlay's own, light only)

| Token | Value | Use |
|---|---|---|
| `--accent` | `#1D5EA8` | everything the extension adds that isn't a state: links, what-if inputs, projections |
| `--accent-soft` | `#E7EFF8` | filled what-if input, a row with a what-if score |
| `--ink` / `--dim` / `--faint` | `#1F2429` / `#5E6670` / `#8A929B` | text |
| `--line` / `--sunk` | `#DCE0E5` / `#F6F7F9` | borders, strips |
| `--bad` / `--bad-soft` | `#B8430F` / `#FBEDE5` | Missing, negative impact |
| `--good` / `--good-soft` | `#23794A` / `#E6F3EC` | Submitted, positive impact |

Type: Instrument Sans for text, JetBrains Mono for every number (tabular-nums).
Bundle both as local `.woff2` (400/500/600), not a Google Fonts link. 6px radius. No shadows.

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

## 1. Grades page (inline in Schoology's table)

- **Course row:** a small sparkline button ("Graph") that opens a row under it
  with a step chart of the replayed history: y axis around the grade range, a
  dashed A-cutoff line, hover crosshair + tooltip (date, %, item that changed
  it), and a dashed projection when any what-if is set. Right column: "X.XX above A".
  When what-ifs exist, show "→ letter %, ±delta, Reset" beside Schoology's grade.
- **Category rows:** "weight N%" beside the name; right column "A holds down to
  NN.N%" (lowest this category can drop, the others unchanged, and still keep the A).
- **Graded item rows:** an impact tag in a new narrow right column
  (green +, red −; omit when |Δ| < 0.005).
- **Ungraded rows ("—"):** a dashed "what if" number input beside the dash.
  Typing recalculates everything live. The row gets `--accent-soft`.
- **After each category:** "+ Plan an upcoming test/assignment" row. It creates an
  inline editor (name, worth, optional score) that shows "need X/pts for an A"
  (or "any score keeps an A" / "out of reach with this alone").
- What-ifs are per-page-view only. Never saved.
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
- **Below the instructions:** "Also in <folder name>": the folder's other items,
  each with the same marker as on the Materials page; files show "In your archive"
  when the archive has them.
