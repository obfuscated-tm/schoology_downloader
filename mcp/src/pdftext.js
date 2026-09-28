// PDF text extraction, cached on disk keyed by (path, mtime).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDocumentProxy, extractText } from "unpdf";
import { PDFTEXT_DIR } from "./config.js";
import { log } from "./log.js";

function cacheKeyFor(absPath, mtimeMs) {
  const hash = crypto.createHash("sha1").update(absPath).digest("hex");
  return path.join(PDFTEXT_DIR, `${hash}-${Math.floor(mtimeMs)}.json`);
}

/**
 * Extract text from a PDF file, with page markers, using a disk cache keyed
 * by absolute path + mtime so re-extraction only happens when the file changes.
 * Returns { pages: string[], text: string (joined with page markers) }.
 */
export async function extractPdfText(absPath) {
  const stat = await fs.stat(absPath);
  const cacheFile = cacheKeyFor(absPath, stat.mtimeMs);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (cached && Array.isArray(cached.pages)) return cached;
  } catch {
    /* not cached yet */
  }

  const buf = await fs.readFile(absPath);
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const result = {
    pages,
    text: pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join("\n\n"),
  };

  try {
    await fs.mkdir(PDFTEXT_DIR, { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(result), "utf8");
    await fs.rename(tmp, cacheFile);
  } catch (err) {
    log(`pdftext: could not write cache for ${absPath}: ${err.message}`);
  }

  return result;
}

/**
 * Extract text from PDF bytes that didn't come from a file on disk (e.g. a
 * live `file`/`fetch_page` download). Cached by a hash of `cacheKey` (the
 * source URL) when given, so repeat opens of the same material don't
 * re-extract.
 * Returns { pages: string[], text: string (joined with page markers) }.
 */
export async function extractPdfTextFromBuffer(buf, cacheKey) {
  const cacheFile = cacheKey
    ? path.join(PDFTEXT_DIR, `url-${crypto.createHash("sha1").update(String(cacheKey)).digest("hex")}.json`)
    : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      if (cached && Array.isArray(cached.pages)) return cached;
    } catch {
      /* not cached yet */
    }
  }

  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const result = {
    pages,
    text: pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join("\n\n"),
  };

  if (cacheFile) {
    try {
      await fs.mkdir(PDFTEXT_DIR, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(result), "utf8");
      await fs.rename(tmp, cacheFile);
    } catch (err) {
      log(`pdftext: could not write cache for ${cacheKey}: ${err.message}`);
    }
  }

  return result;
}
