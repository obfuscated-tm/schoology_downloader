import { splitExt, today, StoppedError, throwIfStopped } from '../../util.js';

export const ARCHIVE_ROOT = 'Schoology Archive';

// Change tracking on top of a "writer" (where files physically go).
//
// Every saved file lives in a "slot" (e.g. "the 1st file of material n-123").
// The manifest remembers each slot's fingerprint (Schoology attachment path, or
// a content hash). On later runs:
//   same fingerprint + file still on disk  -> skipped
//   same fingerprint + file deleted        -> saved again at the same path
//   different fingerprint (teacher edited) -> saved as "name (updated DATE).ext",
//                                             the older copy is kept
export class Saver {
  constructor({ manifest, redownloadAll, log, signal, writer }) {
    this.writer = writer;
    this.signal = signal;
    this.manifest = manifest;
    this.redownloadAll = redownloadAll;
    this.log = log;
    this.stats = { added: [], updated: [], unchanged: 0, failed: [] };
    this.usedPaths = new Set();
    for (const slot of Object.values(manifest.files)) {
      for (const v of slot.versions || []) this.usedPaths.add(v.path.toLowerCase());
    }
    this.claimedThisRun = new Set();
  }

  // Reserve a path nothing else in the archive uses (stable across runs via the manifest).
  uniquePath(rel) {
    const [stem, ext] = splitExt(rel);
    let p = rel;
    for (let i = 2; this.usedPaths.has(p.toLowerCase()) || this.claimedThisRun.has(p.toLowerCase()); i++) {
      p = `${stem} (${i})${ext}`;
    }
    this.claimedThisRun.add(p.toLowerCase());
    return p;
  }

  // opts: { slot, relPath, fingerprint, getSource: async () => ({url}|{blob}), versioned=true, allowHtml=false }
  // Returns the relative path of the current copy.
  async save({ slot, relPath, fingerprint, getSource, versioned = true, allowHtml = false }) {
    const rec = this.manifest.files[slot];
    if (rec) {
      this.claimedThisRun.add(rec.path.toLowerCase());
      rec.lastSeen = this.manifest.currentRun;
      if (rec.fingerprint === fingerprint && !this.redownloadAll && (await this.writer.exists(rec.path, rec))) {
        this.stats.unchanged++;
        return rec.path;
      }
    }

    let path;
    let change;
    if (!rec) {
      path = this.uniquePath(relPath);
      change = 'added';
    } else if (rec.fingerprint === fingerprint || !versioned) {
      path = rec.path;
      change = rec.fingerprint === fingerprint ? 'resaved' : 'updated';
    } else {
      const [stem, ext] = splitExt(rec.originalPath || rec.path);
      path = this.uniquePath(`${stem} (updated ${today()})${ext}`);
      change = 'updated';
    }

    throwIfStopped(this.signal);
    const src = await getSource();
    const result = await this.writer.write(path, src, { allowHtml });

    const entry = rec || { versions: [], originalPath: path };
    entry.path = path;
    entry.fingerprint = fingerprint;
    entry.downloadId = result?.downloadId ?? null;
    entry.lastSeen = this.manifest.currentRun;
    entry.savedAt = new Date().toISOString();
    if (!entry.versions.some((v) => v.path === path)) entry.versions.push({ path, savedAt: entry.savedAt });
    this.manifest.files[slot] = entry;
    this.usedPaths.add(path.toLowerCase());

    if (change === 'added') this.stats.added.push(path);
    else if (change === 'updated') this.stats.updated.push(path);
    return path;
  }

  async saveText(slot, relPath, text, fingerprint) {
    return this.save({
      slot, relPath, fingerprint, versioned: false, allowHtml: true,
      getSource: async () => ({ blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }) }),
    });
  }

  // Always (re)write a generated file, e.g. INDEX.md. Not counted in stats.
  async writeFile(relPath, text, type = 'text/markdown') {
    this.claimedThisRun.add(relPath.toLowerCase());
    await this.writer.write(relPath, { blob: new Blob([text], { type: `${type};charset=utf-8` }) }, { allowHtml: true });
  }
}

const notAFileError = () => new Error('got a web page instead of the file (no access, or not logged in)');

// ── Folder writer: writes straight into the folder you picked. No Save dialogs,
// no downloads bubble. Each file is committed only when fully written, so a
// stop or error never leaves a half-written file behind.
export class FolderWriter {
  constructor({ root, courseDir, signal, log, fallback }) {
    this.root = root;
    this.courseDir = courseDir;
    this.signal = signal;
    this.log = log;
    this.fallback = fallback; // DownloadsWriter, used only if a file can't be fetched directly
    this.dirCache = new Map();
  }

  async dir(parts, create) {
    const key = parts.join('/');
    if (this.dirCache.has(key)) return this.dirCache.get(key);
    let d = this.root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    this.dirCache.set(key, d);
    return d;
  }

  split(relPath) {
    const parts = [this.courseDir, ...relPath.split('/')];
    const name = parts.pop();
    return { parts, name };
  }

  async exists(relPath) {
    const { parts, name } = this.split(relPath);
    try {
      const d = await this.dir(parts, false);
      await d.getFileHandle(name);
      return true;
    } catch {
      this.dirCache.delete(parts.join('/'));
      return false;
    }
  }

  async write(relPath, src, { allowHtml }) {
    throwIfStopped(this.signal);
    let body = src.blob;
    if (!body) {
      let r;
      try {
        r = await fetch(src.url, { credentials: 'include', signal: this.signal });
      } catch (e) {
        throwIfStopped(this.signal);
        if (e instanceof TypeError && this.fallback) {
          if (!this.warnedFallback) {
            this.warnedFallback = true;
            this.log('Some files can’t be fetched directly; using Chrome downloads for those (they go to Downloads/Schoology Archive).', 'warn');
          }
          return this.fallback.write(relPath, src, { allowHtml });
        }
        throw e;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (!allowHtml && /text\/html/i.test(r.headers.get('content-type') || '')) throw notAFileError();
      body = r;
    }

    const { parts, name } = this.split(relPath);
    const d = await this.dir(parts, true);
    const existed = await d.getFileHandle(name).then(() => true, () => false);
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      if (body instanceof Blob) {
        await w.write(body);
        throwIfStopped(this.signal);
        await w.close();
      } else {
        await body.body.pipeTo(w, { signal: this.signal }); // closes (commits) when done
      }
    } catch (e) {
      try { await w.abort(); } catch { /* already closed */ }
      if (!existed) try { await d.removeEntry(name); } catch { /* ignore */ }
      if (e?.name === 'AbortError') throw new StoppedError();
      throw e;
    }
    return {};
  }
}

// ── Downloads writer (fallback): uses chrome.downloads into Downloads/Schoology Archive.
// Chrome shows a Save dialog per file if "Ask where to save each file" is on.
export class DownloadsWriter {
  constructor({ courseDir, signal, log }) {
    this.base = `${ARCHIVE_ROOT}/${courseDir}`;
    this.signal = signal;
    this.log = log;
  }

  async exists(relPath, rec) {
    if (rec?.downloadId == null) return true;
    try {
      const [item] = await chrome.downloads.search({ id: rec.downloadId });
      if (!item) return true; // removed from Chrome's download history; trust the manifest
      return item.exists !== false && item.state === 'complete';
    } catch {
      return true;
    }
  }

  async write(relPath, src, { allowHtml }) {
    let url = src.url;
    let objectUrl = null;
    if (src.blob) url = objectUrl = URL.createObjectURL(src.blob);
    // A download that sits with no filename is almost always Chrome's "Save As" dialog.
    const promptHint = setTimeout(async () => {
      if (this.warnedAboutPrompt) return;
      const [it] = await chrome.downloads.search({ state: 'in_progress', limit: 1, orderBy: ['-startTime'] });
      if (it && !it.filename) {
        this.warnedAboutPrompt = true;
        this.log('Chrome is asking where to save each file. Stop, then choose an archive folder at the top of this panel (or turn off “Ask where to save each file” at chrome://settings/downloads).', 'error');
      }
    }, 4000);
    try {
      const item = await downloadAndWait({
        url,
        filename: `${this.base}/${relPath}`,
        conflictAction: 'overwrite',
        saveAs: false,
      }, this.signal);
      if (!allowHtml && /text\/html/i.test(item.mime || '')) {
        try { await chrome.downloads.removeFile(item.id); } catch { /* ignore */ }
        throw notAFileError();
      }
      return { downloadId: item.id };
    } finally {
      clearTimeout(promptHint);
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    }
  }
}

function downloadAndWait(options, signal, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StoppedError());
    let id = null;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    // Kill switch: cancel this download (also closes a pending Save dialog) and bail out.
    const onAbort = () => {
      if (id != null) chrome.downloads.cancel(id).catch(() => {});
      finish(reject, new StoppedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const check = async () => {
      const [it] = await chrome.downloads.search({ id });
      if (!it) return;
      if (it.state === 'complete') finish(resolve, it);
      else if (it.state === 'interrupted') finish(reject, new Error(`download failed (${it.error || 'interrupted'})`));
    };
    const onChanged = (delta) => {
      if (delta.id === id && delta.state) check();
    };
    const timer = setTimeout(() => finish(reject, new Error('download timed out')), timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.download(options).then((newId) => {
      id = newId;
      if (done) { chrome.downloads.cancel(newId).catch(() => {}); return; }
      check();
    }, (e) => finish(reject, e));
  });
}
