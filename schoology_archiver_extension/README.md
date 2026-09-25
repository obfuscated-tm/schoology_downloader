# Schoology Course Archiver (Chrome extension)

Saves a whole Schoology course to `Downloads/Schoology Archive/<Course name>/` so it survives when the course is deleted at the end of the term, and so you can hand the folder to Claude (Cowork) for quizzes and study help.

Replaces `../schoology_downloader.py`. No cookies to copy: it uses your normal Schoology login in Chrome.

## Install (once)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this `schoology_archiver_extension` folder
4. Pin the extension (puzzle-piece icon → pin "Schoology Course Archiver")

After editing any file here, click the ↻ reload button on the extension's card.

## Use

1. Open a course in Schoology.
2. Click the extension icon. The archiver opens in Chrome's **side panel** on the right, so Schoology stays visible. It picks up whichever course tab you're on.
3. The first time, click **Choose folder…** and pick (or create) `Downloads/Schoology Archive`. If Chrome asks, choose **Allow on every visit**.
4. Click **Archive this course**.

Files are written straight into that folder: no Save dialogs and no downloads bubble, whatever your "Ask where to save each file" setting is. Run it again whenever you like (weekly, and definitely before the term ends). Only new or changed things are saved. Previous courses are listed at the bottom with a **Sync** button.

## What gets saved

| In Schoology | In the archive |
|---|---|
| Folders | Same folder tree |
| Uploaded files (PDF, slides, images) | The original file, named after its Schoology title |
| Google Docs / Slides / Drawings linked in the course | Exported PDF |
| Google Sheets | .xlsx |
| Google Drive files | The file |
| Assignments | `Title (assignment).md`: instructions, due date, grade, teacher comments + a `Title files/` folder with attachments and **your submissions** (every revision; photos, PDFs, audio/video recordings with their original names) |
| Test/Quiz assignments (older Schoology quizzes) | Every question, the choices, **what you picked, and whether it was correct**, for each finished attempt |
| Quizzes (newer "assessments") | Description, grade, attempts. If the teacher allows reviewing answers: every question with your answers |
| External-tool (LTI) assignments/materials | Title, due date, grade; marked as external (the work lives in another app) |
| Pages, discussions | `.md` text |
| Gradebook | `grades.md` |
| Announcements | `updates.md` |
| Google Forms, Drive folders, YouTube, websites | Listed in `INDEX.md` with their link (can't be downloaded) |

`INDEX.md` at the top of the course folder lists everything, what changed in the last sync, and anything that failed.

## neo-plan Today view

The side panel has two views, switched from the menu at the top right: **Today** (your neo-plan items) and **Archive** (everything above). It remembers the last one.

1. In neo-plan, open Settings and make a new extension token (it starts with `np_`).
2. In the side panel click **Settings**, paste it into **Token**, **Save**, then **Done**. **Server** is `neo-plan.vercel.app` (or `localhost:3000` while developing neo-plan).
3. **Today** lists Overdue, Today and Upcoming. The circle on the left marks work done (the square on a test marks it studied). **Turn in** clears an assignment; its place shows **Undo** for a few seconds. Clicking a title opens it in the current tab.

It refreshes when the panel opens, when you come back to it, and every minute while it's showing. The token is kept in the extension and only the background worker sends it to neo-plan.

## Stopping (kill switch)

Any of these stops a run **immediately**: page loads are aborted, file writes in progress are discarded (no half-written files) and quiz-review tabs are closed.

- **■ Stop now** button, pinned to the top of the side panel while it runs
- **Esc** in the side panel
- **Alt+Shift+K** from any tab (change it at `chrome://extensions/shortcuts`)
- **Close the side panel**

Everything saved before the stop is remembered, so the next run continues where it left off. Only one archive can run at a time, across all Chrome windows.

## View only: quizzes are never started

The archiver only reads. It never requests a quiz-taking page (it refuses `/assignment/…/assessment` outright) and never presses Start, Resume, Continue or Submit. To read answer reviews on newer quizzes it opens the quiz page in a background tab and clicks only links whose whole text is exactly **View** in your Previous Attempts table, the same as clicking View yourself.

## Edits and deletions

- **Teacher replaced or edited a file:** the new version is saved next to the old one as `name (updated 2026-10-01).pdf`. Nothing is overwritten.
- **Teacher removed something:** your copy stays, listed under "Removed from Schoology" in `INDEX.md`.
- **You deleted a file from the archive:** it's downloaded again next run.
- **"Re-download everything"** ignores the history and fetches it all again.

Change tracking is stored in the extension (and copied to `_archive/manifest.json`). If you remove the extension, that history is lost and the next run starts fresh, but the files you already have stay put.

## Using it with Claude (Cowork)

Point Cowork at your archive folder's `<Course>/` subfolder and start with something like:

> Read INDEX.md first. Then quiz me on Unit 2 using the lecture slides and guided notes. Don't show me answer keys until I've answered.

## Code layout

- `manifest.json`, `background.js` (run lock, kill switch), `util.js` (shared helpers)
- `reader/`: everything that reads Schoology. `client.js` fetches pages (and refuses quiz-taking URLs); `parse/` turns pages into data (`materials`, `assignment`, `quiz`, `grades`, `feed`); `md.js` converts HTML to Markdown.
- `outputs/archive/`: the archive run (`archiver.js`), file writing and change tracking (`saver.js`), the chosen folder (`folder.js`), Google exports (`google.js`).
- `outputs/neoplan/api.js`: every call to neo-plan (token, server, fetch). Only the background worker imports it; the panel asks it by message.
- `panel/`: the side panel. `archive.html` is the page; `archive.js`/`archive.css` are the Archive view; `shell.js` is the view switcher and Settings; `today.js` (+ `today-format.js`, `np.js`) is the Today view; `neoplan.css` and `fonts/` are neo-plan's look (Public Sans and IBM Plex Mono, bundled).

## Known limits

- **Quizzes:** questions and answers are saved only where the teacher allows reviewing them. Otherwise the file has the description, grade and attempts. Unfinished or never-taken quizzes are left alone.
- **Google files you can't open** (not shared with you) are listed as links with the error.
- **Very large Drive files** hit Google's "can't scan for viruses" page and are listed as links instead.
- If a file can't be fetched directly (rare), the archiver falls back to a normal Chrome download for it, which goes to `Downloads/Schoology Archive` and can show a Save dialog if "Ask where to save each file" is on.
- **Announcements (`updates.md`)** haven't been tested against a course that has posts yet (none of the current courses have any).
- **Discussions, media albums, SCORM/web packages** exist in Schoology but none of the current courses use them. They're saved as page text as a fallback; untested.
- Schoology API keys are disabled for students in this district, so the archiver reads the normal pages.
