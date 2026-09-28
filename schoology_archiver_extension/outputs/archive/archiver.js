import { sanitizeName, withExt, extOf, sha256, mdPath, sleep, StoppedError, throwIfStopped } from '../../util.js';
import { htmlToMd, resolveUrl } from '../../reader/md.js';
import { SchoologyClient, isQuizTakingUrl } from '../../reader/client.js';
import { courseNameFrom, parseFolderRows, contentRoot, findSourceAttachments, findLinkViewTarget } from '../../reader/parse/materials.js';
import { parseAssignment, parseDropbox, findSubmissionSources, submissionId } from '../../reader/parse/assignment.js';
import { parseCommonAssessment, parseLegacyQuizAttempts, parseLegacyQuizReview } from '../../reader/parse/quiz.js';
import { parseGrades } from '../../reader/parse/grades.js';
import { parseFeedPage } from '../../reader/parse/feed.js';
import { nextEventsUrl } from '../../reader/parse/sync.js';
import { rowSignature, eventChangeKeys, shouldSkip } from '../../reader/changes.js';
import { Saver, FolderWriter, DownloadsWriter, ARCHIVE_ROOT } from './saver.js';
import { classifyLink, prepareGoogle } from './google.js';
import * as bridge from './chrome-bridge.js';

const MAX_DEPTH = 20;
const join = (...parts) => parts.filter(Boolean).join('/');
const basename = (p) => p.split('/').pop();

export class Archiver {
  constructor({ host, courseId, tabId, folder, options, log, progress, onCourseName }) {
    this.folder = folder; // FileSystemDirectoryHandle, or null to use Chrome downloads
    this.host = host;
    this.courseId = courseId;
    this.options = options;
    this.log = log;
    this.progress = progress;
    this.onCourseName = onCourseName || (() => {});
    this.ctrl = new AbortController();
    this.signal = this.ctrl.signal;
    this.client = new SchoologyClient({ host, tabId, log, signal: this.signal });
    this.stopped = false;
    this.entries = [];
    this.errors = [];
    this.crawlComplete = true;
  }

  // Kill switch: abort every in-flight page load, cancel downloads this extension
  // started, and close any quiz-review tab. Progress so far is kept.
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.ctrl.abort();
    await killActiveWork();
  }

  // Errors caused by the kill switch must not be recorded as "problems".
  isStop(e) {
    return this.stopped || e instanceof StoppedError || e?.name === 'AbortError';
  }

  get storageKey() { return `course:${this.host}:${this.courseId}`; }

  async run() {
    const { doc: materials } = await this.client.init(this.courseId);
    const courseName = courseNameFrom(materials) || `Course ${this.courseId}`;
    this.log(`Course: ${courseName}`);
    this.onCourseName(courseName);

    const stored = (await bridge.storageGet(this.storageKey))[this.storageKey];
    this.manifest = stored || {
      version: 1, host: this.host, courseId: this.courseId, courseName,
      courseDir: sanitizeName(courseName, 100), files: {}, items: {}, runs: [],
    };
    this.manifest.courseName = courseName;
    this.manifest.currentRun = new Date().toISOString();

    const courseDir = this.manifest.courseDir;
    const downloads = new DownloadsWriter({ courseDir, signal: this.signal, log: this.log });
    const writer = this.folder
      ? new FolderWriter({ root: this.folder, courseDir, signal: this.signal, log: this.log, fallback: downloads })
      : downloads;
    this.location = this.folder ? `${this.folder.name}/${courseDir}` : `Downloads/${ARCHIVE_ROOT}/${courseDir}`;
    this.saver = new Saver({
      manifest: this.manifest, redownloadAll: this.options.redownloadAll,
      log: this.log, signal: this.signal, writer,
    });

    let uiDisabled = false;
    try {
      await bridge.downloadsSetUiEnabled(false);
      uiDisabled = true;
    } catch { /* not supported */ }

    this.skippedCount = 0;
    this.recheckedCount = 0;
    const { map: eventKeys, available: eventsAvailable } = await this.loadEventChangeKeys();
    this.eventKeys = eventKeys;
    this.eventsAvailable = eventsAvailable;

    try {
      try {
        await this.walkFolder(this.client.abs(`/course/${this.courseId}/materials`), [], new Set(), 0, materials);
        if (this.skippedCount || this.recheckedCount) {
          this.log(`Skipped ${this.skippedCount} unchanged items without opening them (${this.recheckedCount} re-checked).`);
        }
        if (!this.stopped && this.options.grades) await this.saveGrades();
        if (!this.stopped && this.options.updates) await this.saveUpdates();
      } catch (e) {
        if (!this.isStop(e)) throw e;
      }
      if (this.stopped) await this.saveProgressOnly();
      else await this.finish();
    } finally {
      if (uiDisabled) try { await bridge.downloadsSetUiEnabled(true); } catch { /* ignore */ }
    }
    return {
      stats: this.saver.stats, errors: this.errors, stopped: this.stopped, location: this.location,
      skipped: this.skippedCount, rechecked: this.recheckedCount,
    };
  }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.errors.push(msg);
    this.saver.stats.failed.push(msg);
    this.log(msg, 'error');
  }

  // /v2/events/{upcoming,overdue}: change keys for assignments that are
  // still upcoming or overdue (what a teacher is actually likely to edit).
  // Any failure — including a rate limit — makes event info unavailable for
  // the whole run rather than trusting a half-fetched map.
  async loadEventChangeKeys() {
    const map = new Map();
    try {
      for (const list of ['upcoming', 'overdue']) {
        let url = `/v2/events/${list}`;
        for (let page = 0; page < 20 && url; page++) {
          const { text } = await this.client.getText(url, { headers: { Accept: 'application/json' } });
          for (const [id, key] of await eventChangeKeys(text)) map.set(id, key);
          url = nextEventsUrl(text);
        }
      }
      return { map, available: true };
    } catch (e) {
      if (this.isStop(e)) throw e;
      this.log(`Couldn't read upcoming/overdue assignments (${e.message || e}); re-checking assignments more often this run.`, 'warn');
      return { map: new Map(), available: false };
    }
  }

  // ── Folders ───────────────────────────────────────────────────────────
  async walkFolder(url, pathParts, visited, depth, preloaded) {
    if (this.stopped) return;
    if (depth > MAX_DEPTH) { this.fail(pathParts.join(' / '), 'folders nested too deep; skipped'); return; }
    const folderId = new URL(url).searchParams.get('f') || 'root';
    if (visited.has(folderId)) { this.log(`Skipping repeated folder ${pathParts.join(' / ')}`, 'warn'); return; }
    visited.add(folderId);

    let doc;
    try {
      doc = preloaded || (await this.client.getDoc(url)).doc;
    } catch (e) {
      if (this.isStop(e)) throw e;
      this.crawlComplete = false;
      this.fail(`Folder "${pathParts.join(' / ') || 'Materials'}"`, e);
      return;
    }
    const rows = parseFolderRows(doc, this.client);
    const label = pathParts.join(' / ') || 'Materials';
    if (!rows) {
      if (!doc.querySelector('.no-content, .s-empty-state')) this.log(`No materials table in ${label}`, 'warn');
      return;
    }
    this.log(`📁 ${label} (${rows.length} items)`);
    const dir = pathParts.map((p) => sanitizeName(p)).join('/');

    for (const row of rows) {
      if (this.stopped) return;
      if (row.kind === 'folder') {
        await this.walkFolder(row.url, [...pathParts, row.title], visited, depth + 1);
        continue;
      }

      // The options that change what doX saves are part of the signature: a
      // run with Google export or submissions newly ticked re-opens everything.
      const sig = `${rowSignature(row)}\u0002${['google', 'submissions', 'quizzes'].map((k) => (this.options[k] ? 1 : 0)).join('')}`;
      const stored = this.manifest.items[row.key];
      const assignmentId = row.kind === 'assignment' ? ((row.url || '').match(/\/assignment\/(\d+)/) || [])[1] || null : null;
      const skip = shouldSkip({
        stored, row, sig, kind: row.kind, assignmentId,
        eventKeys: this.eventKeys, eventsAvailable: this.eventsAvailable,
        now: Date.now(), redownloadAll: !!this.options.redownloadAll,
      }) && (await this.saver.slotsPresent(`${row.key}#`));

      if (skip) {
        const entry = { ...stored.entry, folder: label, dir };
        this.entries.push(entry);
        this.progress(this.entries.length);
        this.saver.keepItem(row.key);
        this.skippedCount++;
        this.manifest.items[row.key] = {
          ...stored, title: entry.title, kind: entry.kind, folder: label,
          files: entry.files.map((f) => f.path), lastSeen: this.manifest.currentRun, removed: false,
        };
        continue;
      }
      if (stored) this.recheckedCount++;

      const entry = {
        key: row.key, kind: row.kind, title: row.title, folder: label, dir,
        files: [], links: [], notes: [], due: '', grade: '', sourceUrl: row.url || '',
      };
      this.entries.push(entry);
      this.progress(this.entries.length);
      try {
        switch (row.kind) {
          case 'document': await this.doDocument(row, entry, dir); break;
          case 'assignment': await this.doAssignment(row, entry, dir, stored?.ok === true); break;
          case 'quiz': await this.doQuiz(row, entry, dir); break;
          case 'page': await this.doPage(row, entry, dir, ''); break;
          case 'discussion': await this.doPage(row, entry, dir, ' (discussion)'); break;
          default: await this.doPage(row, entry, dir, ` (${row.type})`); break;
        }
      } catch (e) {
        if (this.isStop(e)) throw e;
        entry.notes.push(`Error: ${e.message || e}`);
        this.fail(`"${row.title}" in ${label}`, e);
      }
      const ok = !entry.notes.some((n) => n.startsWith('Error:'));
      this.manifest.items[row.key] = {
        title: entry.title, kind: entry.kind, folder: label,
        files: entry.files.map((f) => f.path), lastSeen: this.manifest.currentRun, removed: false,
        sig, checkedAt: this.manifest.currentRun, ok,
        changeKey: assignmentId && this.eventKeys.has(assignmentId) ? this.eventKeys.get(assignmentId) : undefined,
        entry: {
          kind: entry.kind, title: entry.title, folder: entry.folder, dir: entry.dir,
          files: entry.files, links: entry.links, notes: entry.notes,
          due: entry.due, grade: entry.grade, sourceUrl: entry.sourceUrl,
        },
      };
    }
  }

  // ── Files and links ───────────────────────────────────────────────────
  async doDocument(row, entry, dir) {
    for (const [i, f] of row.files.entries()) {
      entry.sourceUrl ||= f.url;
      const { doc } = await this.client.getDoc(f.url);
      const atts = findSourceAttachments(doc, this.client);
      if (!atts.length) {
        const md = htmlToMd(contentRoot(doc), this.client.origin);
        const path = await this.saver.saveText(`${row.key}#${i}#md`, join(dir, `${sanitizeName(f.title)}.md`), pageMd(f.title, f.url, md), 't:' + (await sha256(md)));
        entry.files.push({ label: f.title, path });
        entry.notes.push('No downloadable file found; saved the page text instead.');
        continue;
      }
      for (const [j, att] of atts.entries()) {
        const ext = att.ext || extOf(f.filename);
        const base = sanitizeName(atts.length > 1 ? `${f.title} ${j + 1}` : f.title, 90);
        const path = await this.saver.save({
          slot: `${row.key}#${i}.${j}`,
          relPath: join(dir, `${withExt(base, ext)}`),
          fingerprint: att.fingerprint,
          getSource: async () => ({ url: att.url }),
        });
        entry.files.push({ label: f.filename || f.title, path });
        this.log(`  ✓ ${path}`);
      }
    }
    for (const [i, l] of row.links.entries()) {
      let target = resolveUrl(l.href, this.client.origin);
      if (/\/materials\/link\/view\//.test(l.url)) {
        entry.sourceUrl ||= l.url;
        const { doc } = await this.client.getDoc(l.url);
        target = findLinkViewTarget(doc, this.client) || l.url;
      }
      await this.saveExternal(target, l.title || row.title, dir, `${row.key}#link${i}`, entry);
    }
    if (row.externalTool) {
      entry.notes.push('External tool (LTI): opens another app from Schoology; nothing to download.');
      if (row.otherUrl) entry.links.push({ label: row.title, url: row.otherUrl, note: 'External tool' });
    } else if (!row.files.length && !row.links.length && row.otherUrl) {
      entry.links.push({ label: row.title, url: row.otherUrl, note: 'Unrecognized material type' });
    }
  }

  // Google Docs/Slides/Sheets/Drive files get exported; anything else is recorded as a link.
  async saveExternal(url, title, dir, slot, entry) {
    const info = classifyLink(url);
    if ((info.kind !== 'google' && info.kind !== 'drivefile') || !this.options.google) {
      entry.links.push({ label: title, url, note: info.label });
      return;
    }
    try {
      let prep;
      try {
        prep = await prepareGoogle(info, this.signal);
      } catch (e) {
        if (this.isStop(e) || !(e instanceof TypeError)) throw e;
        // Extension fetch was blocked; let Chrome download it with your Google login instead.
        prep = { fingerprint: 'url:' + info.exportUrl, getSource: async () => ({ url: info.exportUrl }), filename: '' };
      }
      const ext = info.ext || extOf(prep.filename) || 'bin';
      const path = await this.saver.save({
        slot, relPath: join(dir, `${withExt(sanitizeName(title, 90), ext)}`),
        fingerprint: prep.fingerprint, getSource: prep.getSource,
      });
      entry.files.push({ label: `${title} (${info.label})`, path });
      entry.links.push({ label: `${title} (original)`, url, note: info.label });
      this.log(`  ✓ ${path}`);
    } catch (e) {
      if (this.isStop(e)) throw e;
      entry.links.push({ label: title, url, note: `${info.label}; couldn’t export: ${e.message}` });
      this.log(`  ! ${title}: ${e.message}`, 'warn');
    }
  }

  // ── Assignments ───────────────────────────────────────────────────────
  // prevOk: whether last run's pass over this same assignment finished clean
  // (its manifest item's `ok`) — a precondition for reusing a middle
  // revision's files without reopening that revision's page.
  async doAssignment(row, entry, dir, prevOk = false) {
    const { doc, url: finalUrl } = await this.client.getDoc(row.url);
    const a = parseAssignment(doc, this.client, finalUrl);
    entry.due = a.due;
    const title = sanitizeName(row.title, 70);
    const filesDir = join(dir, `${title} files`);
    const rel = (p) => p.slice(dir.length ? dir.length + 1 : 0);

    const attLines = [];
    for (const [i, att] of a.attachments.entries()) {
      const before = entry.files.length;
      const beforeLinks = entry.links.length;
      if (/\/attachment\/\d+\/source\//.test(att.href)) {
        const path = await this.saver.save({
          slot: `${row.key}#att${i}`, relPath: join(filesDir, `${sanitizeName(att.title, 90)}`),
          fingerprint: new URL(att.url).pathname, getSource: async () => ({ url: att.url }),
        });
        entry.files.push({ label: att.title, path });
      } else if (/\/materials\/gp\//.test(att.href)) {
        const { doc: gp } = await this.client.getDoc(att.url);
        for (const [j, src] of findSourceAttachments(gp, this.client).entries()) {
          const path = await this.saver.save({
            slot: `${row.key}#att${i}.${j}`, relPath: join(filesDir, `${withExt(sanitizeName(att.title, 90), src.ext)}`),
            fingerprint: src.fingerprint, getSource: async () => ({ url: src.url }),
          });
          entry.files.push({ label: att.title, path });
        }
      } else {
        await this.saveExternal(resolveUrl(att.href, this.client.origin), att.title, filesDir, `${row.key}#att${i}`, entry);
      }
      for (const f of entry.files.slice(before)) attLines.push(`- [${f.label}](${mdPath(rel(f.path))})`);
      for (const l of entry.links.slice(beforeLinks)) attLines.push(`- ${l.label}: <${l.url}> — ${l.note}`);
    }

    const subLines = [];
    const commentLines = [];
    if (a.dropboxUrl && this.options.submissions) {
      const { doc: first } = await this.client.getDoc(`${a.dropboxUrl}?revision=1`);
      const d1 = parseDropbox(first, this.client);
      entry.grade = d1.grade;
      for (const c of d1.comments) commentLines.push(`- **${c.author || 'Comment'}:** ${c.text}`);
      const revisions = d1.revisions.length ? d1.revisions : [1];
      const latestRev = revisions[revisions.length - 1];
      for (const rev of revisions) {
        // A past revision's files don't change once graded; skip reopening
        // its page when we already have them saved from a run that finished
        // clean. Revision 1 (for the count above) and the latest revision
        // (new comments/grades can land there) are always re-fetched.
        const prefix = `${row.key}#rev${rev}#`;
        const lines = [];
        if (prevOk && rev !== 1 && rev !== latestRev && this.saver.hasSlots(prefix) && (await this.saver.slotsPresent(prefix))) {
          for (const rec of this.saver.keepSlots(prefix)) {
            entry.files.push({ label: `My submission, revision ${rev}`, path: rec.path });
            lines.push(`- [${basename(rec.path)}](${mdPath(rel(rec.path))})`);
          }
        } else {
          const d = rev === 1 ? d1 : parseDropbox((await this.client.getDoc(`${a.dropboxUrl}?revision=${rev}`)).doc, this.client);
          const files = await this.collectSubmissionFiles(d);
          let k = 0;
          for (const f of files) {
            k++;
            const base = `My submission - revision ${rev}` + (f.name ? ` - ${sanitizeName(f.name, 60)}` : files.length > 1 ? ` (${k})` : '');
            const path = await this.saver.save({
              slot: `${row.key}#rev${rev}#${f.id}`,
              relPath: join(filesDir, withExt(base, f.ext)),
              fingerprint: new URL(f.url).pathname, getSource: async () => ({ url: f.url }),
            });
            entry.files.push({ label: `My submission, revision ${rev}`, path });
            lines.push(`- [${f.name || `File ${k}`}](${mdPath(rel(path))})`);
          }
          for (const l of d.links) lines.push(`- Link: [${l.title || l.url}](${l.url})`);
        }
        if (lines.length) subLines.push(`### Revision ${rev}`, ...lines, '');
      }
      if (!subLines.length) subLines.push('Submitted, but no file could be found (it may be a text entry or a Google Drive submission — check Schoology).');
    }

    let quizLines = [];
    if (a.isQuiz) quizLines = await this.legacyQuizReview(row);
    if (a.isExternalTool) {
      entry.notes.push('External-tool assignment: the work lives in another app, so only the title, due date and grade are saved.');
    }

    const instructions = a.bodyEl ? htmlToMd(a.bodyEl, this.client.origin) : '';
    const md = [
      `# ${row.title}`, '',
      `- **Type:** ${a.isQuiz ? 'Test/Quiz' : a.isExternalTool ? 'Assignment (external tool)' : 'Assignment'}`,
      a.due && `- **Due:** ${a.due}`,
      entry.grade && `- **Grade:** ${entry.grade}`,
      `- **Folder:** ${entry.folder}`,
      `- **Schoology link:** ${row.url}`, '',
      '## Instructions', '', instructions || (a.isExternalTool ? '_This assignment is done in an external tool (not Schoology); its content isn’t available here._' : '_No instructions were posted._'), '',
      ...quizLines,
      attLines.length && '## Attachments', attLines.length && '', ...attLines, attLines.length && '',
      a.dropboxUrl && '## My submission', a.dropboxUrl && '',
      ...(a.dropboxUrl ? (this.options.submissions ? subLines : ['(Submissions not saved; option was off.)']) : []),
      commentLines.length && '## Comments', commentLines.length && '', ...commentLines,
    ].filter((x) => x !== false && x !== undefined && x !== null && x !== 0).join('\n');
    // Fingerprint the whole note so grade/comment changes are picked up.
    const path = await this.saver.saveText(`${row.key}#md`, join(dir, `${title} (assignment).md`), md + '\n', 't:' + (await sha256(md)));
    entry.files.unshift({ label: 'Instructions, grade, comments', path });
    this.log(`  ✓ ${path}`);
  }

  // Find every submitted file in one revision, de-duplicated by submission ID.
  async collectSubmissionFiles(d) {
    const byId = new Map();
    const add = (url, name = '') => {
      const id = submissionId(url);
      if (byId.has(id)) return;
      const path = new URL(url).pathname;
      let ext = extOf(name) || extOf(path);
      if (/\/conversion\//.test(path)) ext = 'mp4'; // recorded audio/video, converted by Schoology
      byId.set(id, { id, url, name, ext });
    };
    for (const url of d.directFiles) add(url, d.names[submissionId(url)] || '');
    for (const v of d.viewers) {
      try {
        const { text } = await this.client.getText(v);
        for (const url of findSubmissionSources(text, this.client)) add(url, d.names[submissionId(url)] || '');
      } catch (e) {
        if (this.isStop(e)) throw e;
        this.log(`  ! submission viewer: ${e.message}`, 'warn');
      }
    }
    return [...byId.values()];
  }

  // ── Quizzes / tests ───────────────────────────────────────────────────
  // VIEW ONLY. Nothing here may start, resume or submit an attempt.

  // Assignment-based Test/Quiz: the review of each finished attempt is plain HTML.
  async legacyQuizReview(row) {
    const id = (row.url.match(/\/assignment\/(\d+)/) || [])[1];
    if (!id || !this.options.quizzes) return [];
    const { doc } = await this.client.getDoc(`/assignment/${id}/assessment_view`);
    const attempts = parseLegacyQuizAttempts(doc, this.client);
    if (!attempts.length) return ['## Quiz review', '', '_No reviewable attempts (not taken yet, or the teacher hasn’t allowed review)._', ''];
    const out = [];
    for (const [i, url] of attempts.entries()) {
      const { doc: rd } = await this.client.getDoc(url);
      const r = parseLegacyQuizReview(rd, this.client);
      out.push(`## Attempt ${attempts.length - i}${r.summary ? ` — ${r.summary}` : ''}`, '');
      for (const q of r.questions) out.push(`### ${q.number}${q.score ? ` (${q.score})` : ''}`, '', q.md, '');
    }
    return out;
  }

  // Newer "common assessment" quizzes: summary from the page's embedded data, plus
  // answer reviews (only where the teacher allows it) read in a background tab.
  async doQuiz(row, entry, dir) {
    const { text: html } = await this.client.getText(row.url);
    const q = parseCommonAssessment(html);
    const lines = [`# ${row.title}`, '', '- **Type:** Quiz / test', `- **Folder:** ${entry.folder}`, `- **Schoology link:** ${row.url}`];
    let reviews = [];
    if (q) {
      const total = q.gradebookPointsTotal ?? q.pointsTotal;
      if (q.scoreRoundedForDisplay) {
        entry.grade = `${q.scoreRoundedForDisplay}${total ? ` / ${total}` : ''}`;
        lines.push(`- **Grade:** ${entry.grade}`);
      }
      lines.push(`- **Attempts:** ${q.numAttemptsTaken ?? (q.submissions || []).length}${q.numAttemptsAllowed ? ` of ${q.numAttemptsAllowed}` : ''}`);
      const instr = q.instructions ? htmlToMd(new DOMParser().parseFromString(q.instructions, 'text/html').body, this.client.origin) : '';
      lines.push('', '## Description', '', instr || '_None._', '');
      const subs = q.submissions || [];
      if (subs.length) {
        lines.push('## Attempts', '', '| # | Time spent | Last modified |', '| --- | --- | --- |');
        subs.forEach((sub, i) => lines.push(`| ${subs.length - i} | ${sub.minutes_elapsed ?? ''} min | ${sub.last_modified_date || ''} ${sub.last_modified_time || ''} |`));
        lines.push('');
      }
      const viewable = subs.filter((sub) => sub.can_student_view).length;
      if (viewable && this.options.quizzes) {
        try {
          reviews = await reviewAttemptsInTab(row.url, viewable, this.signal);
        } catch (e) {
          if (this.isStop(e)) throw e;
          entry.notes.push(`Couldn’t read the quiz review: ${e.message}`);
        }
      } else if (subs.length && !viewable) {
        lines.push('_The teacher hasn’t allowed reviewing answers for this quiz, so only the summary is saved._', '');
      }
    } else {
      lines.push('', '_Couldn’t read this quiz page._');
    }
    for (const r of reviews) lines.push(`## Review: ${r.label}`, '', r.text, '');

    const md = lines.join('\n');
    const path = await this.saver.saveText(`${row.key}#md`, join(dir, `${sanitizeName(row.title, 70)} (quiz).md`), md + '\n', 't:' + (await sha256(md)));
    entry.files.push({ label: reviews.length ? 'Quiz summary + your answers' : 'Quiz summary', path });
    this.log(`  ✓ ${path}${reviews.length ? ` (${reviews.length} attempt review${reviews.length > 1 ? 's' : ''})` : ''}`);
  }

  // ── Pages, discussions, anything else ────────────────────────────────
  async doPage(row, entry, dir, suffix) {
    const { doc } = await this.client.getDoc(row.url);
    const root = contentRoot(doc);
    const md = htmlToMd(root.querySelector('.s-page-content-full') || root, this.client.origin);
    const path = await this.saver.saveText(`${row.key}#md`, join(dir, `${sanitizeName(row.title, 70)}${suffix}.md`), pageMd(row.title, row.url, md), 't:' + (await sha256(md)));
    entry.files.push({ label: row.title, path });
    this.log(`  ✓ ${path}`);
  }

  // ── Grades & updates ─────────────────────────────────────────────────
  async saveGrades() {
    try {
      const { doc } = await this.client.getDoc(`/course/${this.courseId}/student_grades`);
      const rows = parseGrades(doc);
      if (!rows.length) return;
      const indent = { course: '', period: '', category: '↳ ', item: '    ' };
      const lines = [
        `# Grades — ${this.manifest.courseName}`, '', `As of ${new Date().toLocaleString()}.`, '',
        '| Item | Due | Grade | Comment |', '| --- | --- | --- | --- |',
        ...rows.map((r) => {
          const t = r.level === 'item' ? r.title : `**${r.title}**`;
          const c = r.comment === 'No comment' ? '' : r.comment;
          return `| ${indent[r.level]}${t} | ${r.due} | ${r.grade} | ${c.replace(/\|/g, '\\|')} |`;
        }),
      ].join('\n');
      const body = lines.split('\n').slice(4).join('\n');
      await this.saver.saveText('grades', 'grades.md', lines + '\n', 't:' + (await sha256(body)));
      this.log('✓ grades.md');
    } catch (e) { if (this.isStop(e)) throw e; this.fail('Grades', e); }
  }

  async saveUpdates() {
    try {
      const posts = [];
      for (let page = 0; page < 30 && !this.stopped; page++) {
        const { text } = await this.client.getText(`/course/${this.courseId}/feed?page=${page}`);
        const batch = parseFeedPage(text);
        if (!batch.length) break;
        posts.push(...batch);
      }
      if (!posts.length) { this.log('No course updates/announcements.'); return; }
      const md = [`# Course updates — ${this.manifest.courseName}`, '',
        ...posts.map((p) => `## ${p.author || 'Update'}${p.date ? ` — ${p.date}` : ''}\n\n${htmlToMd(p.bodyEl, this.client.origin)}\n`)].join('\n');
      await this.saver.saveText('updates', 'updates.md', md + '\n', 't:' + (await sha256(md)));
      this.log(`✓ updates.md (${posts.length} posts)`);
    } catch (e) { if (this.isStop(e)) throw e; this.fail('Updates', e); }
  }

  // After the kill switch: remember what was saved (so the next run skips it),
  // but don't download anything else — INDEX.md is rebuilt on the next full run.
  async saveProgressOnly() {
    const stats = this.saver.stats;
    this.manifest.runs.push({
      at: this.manifest.currentRun, added: stats.added.length, updated: stats.updated.length,
      unchanged: stats.unchanged, failed: stats.failed.length, stopped: true,
    });
    this.manifest.runs = this.manifest.runs.slice(-50);
    delete this.manifest.currentRun;
    await bridge.storageSet({ [this.storageKey]: this.manifest });
  }

  // ── Wrap-up: removed items, INDEX.md, manifest ───────────────────────
  async finish() {
    const run = this.manifest.currentRun;
    const removed = [];
    if (this.crawlComplete && !this.stopped) {
      for (const [key, it] of Object.entries(this.manifest.items)) {
        if (it.lastSeen !== run) {
          if (!it.removed) { it.removed = true; it.removedAt = run; }
          removed.push(it);
        }
      }
    } else {
      removed.push(...Object.values(this.manifest.items).filter((it) => it.removed));
    }

    const stats = this.saver.stats;
    this.manifest.runs.push({
      at: run, added: stats.added.length, updated: stats.updated.length,
      unchanged: stats.unchanged, failed: stats.failed.length, stopped: this.stopped,
    });
    this.manifest.runs = this.manifest.runs.slice(-50);

    const index = buildIndex(this.manifest, this.entries, removed, stats, this);
    await this.saver.writeFile('INDEX.md', index);
    const snapshot = JSON.stringify({ ...this.manifest, currentRun: undefined }, null, 2);
    await this.saver.writeFile('_archive/manifest.json', snapshot, 'application/json');

    delete this.manifest.currentRun;
    await bridge.storageSet({ [this.storageKey]: this.manifest });
  }
}

function pageMd(title, url, body) {
  return `# ${title}\n\n- **Schoology link:** ${url}\n\n${body || '_No text content._'}\n`;
}

const KIND_LABEL = { document: 'File/link', assignment: 'Assignment', quiz: 'Quiz/test', page: 'Page', discussion: 'Discussion', other: 'Other' };

function buildIndex(manifest, entries, removed, stats, archiver) {
  const L = [];
  const lastRuns = manifest.runs.slice(-5).reverse();
  L.push(`# ${manifest.courseName}`, '');
  L.push(`Archive of the Schoology course at https://${manifest.host}/course/${manifest.courseId}/materials`);
  L.push(`Last synced: ${new Date().toLocaleString()}${archiver.stopped ? ' (stopped early — incomplete)' : ''}`, '');
  L.push('## How this archive is organized', '');
  L.push('- Folders mirror the course’s Materials folders in Schoology.');
  L.push('- `… (assignment).md` files hold the instructions, due date, grade and teacher comments. Attachments and my submitted work are in the matching `… files/` folder.');
  L.push('- Google Docs/Slides were exported to PDF; Google Sheets to .xlsx.');
  L.push('- Items that couldn’t be downloaded (Google Forms, Drive folders, videos, websites) are listed below with their link.');
  L.push('- If a teacher changed a file, the newer copy is saved next to the old one as `… (updated YYYY-MM-DD).ext`.');
  L.push('- `grades.md` has the gradebook; `updates.md` has course announcements (if any).');
  L.push('- Files named “key”, “solutions” or “answers” contain answers. When quizzing me, don’t show these until I’ve tried.', '');

  L.push('## Changes in the last sync', '');
  if (stats.added.length) L.push(`**New (${stats.added.length}):**`, ...stats.added.map((p) => `- ${p}`), '');
  if (stats.updated.length) L.push(`**Updated (${stats.updated.length}):**`, ...stats.updated.map((p) => `- ${p}`), '');
  if (stats.failed.length) L.push(`**Problems (${stats.failed.length}):**`, ...stats.failed.map((p) => `- ${p}`), '');
  if (!stats.added.length && !stats.updated.length && !stats.failed.length) L.push('No changes.', '');
  L.push('Recent syncs: ' + lastRuns.map((r) => `${r.at.slice(0, 10)} (+${r.added} new, ${r.updated} updated${r.failed ? `, ${r.failed} problems` : ''})`).join('; '), '');

  L.push('## Contents', '');
  let folder = null;
  for (const e of entries) {
    if (e.folder !== folder) {
      folder = e.folder;
      L.push(`### ${folder}`, '');
    }
    const meta = [KIND_LABEL[e.kind] || e.kind, e.due && `due ${e.due}`, e.grade && `grade ${e.grade}`].filter(Boolean).join(' · ');
    L.push(`- **${e.title}** — ${meta}`);
    for (const f of e.files) L.push(`  - [${f.label}](${mdPath(f.path)})`);
    for (const l of e.links) L.push(`  - ${l.note}: <${l.url}>`);
    for (const n of e.notes) L.push(`  - _${n}_`);
  }
  L.push('');

  if (removed.length) {
    L.push('## Removed from Schoology (still kept here)', '');
    for (const it of removed) {
      L.push(`- **${it.title}** (was in ${it.folder}; gone since ${String(it.removedAt || '').slice(0, 10)})`);
      for (const p of it.files || []) L.push(`  - [file](${mdPath(p)})`);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

// Read quiz reviews in a background tab. VIEW ONLY:
// the only element ever clicked is a link whose entire text is exactly "View"
// in the Previous Attempts table. Anything else (Start / Resume / Submit…) is never touched.
// Tabs opened for quiz reviews, so the kill switch can close them.
const reviewTabs = new Set();

// Cancel every download this extension still has running and close review tabs.
export async function killActiveWork() {
  try {
    const running = await bridge.downloadsSearch({ state: 'in_progress' });
    await Promise.all(running.filter((d) => d.byExtensionId === chrome.runtime.id)
      .map((d) => bridge.downloadsCancel(d.id).catch(() => {})));
  } catch { /* ignore */ }
  await Promise.all([...reviewTabs].map((id) => bridge.tabsRemove(id).catch(() => {})));
  reviewTabs.clear();
}

async function reviewAttemptsInTab(url, count, signal) {
  if (isQuizTakingUrl(url)) throw new Error("refused to open a quiz-taking page");
  const reviews = [];
  for (let i = 0; i < count; i++) {
    throwIfStopped(signal);
    const tab = await bridge.tabsCreate({ url, active: false });
    reviewTabs.add(tab.id);
    bridge.reviewTabsSet([...reviewTabs]).catch(() => {});
    try {
      await bridge.tabsWaitLoaded(tab.id, signal, 45_000);
      const clicked = await pollInTab(tab.id, (id) => bridge.tabClickView(id, i), (r) => r && (r.clicked || r.fatal), 20_000, signal);
      if (!clicked?.clicked) throw new Error(clicked?.fatal || 'no "View" link found');
      const got = await pollInTab(tab.id, (id) => bridge.tabReadReview(id), (r) => r && r.count > 0 && r.stable, 30_000, signal);
      if (!got?.count) throw new Error('review did not load');
      reviews.push({ label: clicked.label || `Attempt ${i + 1}`, text: got.text });
    } finally {
      reviewTabs.delete(tab.id);
      bridge.reviewTabsSet([...reviewTabs]).catch(() => {});
      try { await bridge.tabsRemove(tab.id); } catch { /* closed */ }
    }
  }
  return reviews;
}

async function pollInTab(tabId, run, done, timeoutMs, signal) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    throwIfStopped(signal);
    last = await run(tabId);
    if (done(last)) return last;
    await sleep(1000, signal);
  }
  return last;
}
