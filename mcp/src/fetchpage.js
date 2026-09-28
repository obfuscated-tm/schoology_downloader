// fetch_page: public http(s) GET of course-website pages the extension has
// no reach into (see "Course websites" in docs/MCP-BRIDGE.md). No cookies,
// a 15s timeout, a 15MB cap, at most 5 redirects (each re-checked against
// the address guard), and a 1-hour disk cache shared with the `file` op's
// cache dir.
import { getDocumentProxy, extractText } from "unpdf";
import { readCachedFile, writeCachedFile } from "./filecache.js";
import { assertPublicHost } from "./netguard.js";
import { htmlToText } from "./htmltext.js";

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const CACHE_TTL_MS = 60 * 60 * 1000;
const LINK_CAP = 200;

async function fetchWithTimeout(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "schoology-mcp/1.0 (+local, read-only)" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${maxBytes} byte cap`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// What the server says it sent wins over the URL's extension: a site can serve
// a rendered HTML page at a .md URL (apcs.tinocs.com does). The extension only
// decides when the content type is missing or generic.
function classify(finalUrl, contentType, buf) {
  const lowerUrl = finalUrl.toLowerCase().split(/[?#]/)[0];
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (/^image\/(png|jpe?g|gif|webp)/.test(ct) || /\.(png|jpe?g|gif|webp)$/.test(lowerUrl)) return "image";
  if (ct.includes("html")) return "html";
  if (ct.includes("markdown")) return "markdown";
  if (ct.includes("text/plain")) return "text";
  if (lowerUrl.endsWith(".pdf") || buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (/^\s*<(!doctype html|html)/i.test(buf.subarray(0, 512).toString("utf8"))) return "html";
  if (lowerUrl.endsWith(".md")) return "markdown";
  if (lowerUrl.endsWith(".txt")) return "text";
  return "html";
}

const IMAGE_CAP = 5 * 1024 * 1024;

async function buildResult(finalUrl, contentType, buf) {
  const kind = classify(finalUrl, contentType, buf);
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
    const { text } = await extractText(pdf, { mergePages: true });
    return { kind, text: Array.isArray(text) ? text.join("\n") : String(text) };
  }
  if (kind === "image") {
    if (buf.length > IMAGE_CAP) return { kind, note: `image is ${buf.length} bytes, over the ${IMAGE_CAP}-byte cap` };
    const ext = finalUrl.toLowerCase().split(/[?#]/)[0].split(".").pop();
    const fromCt = ((contentType || "").match(/image\/(png|jpeg|gif|webp)/i) || [])[0];
    const mimeType = fromCt || { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "image/png";
    return { kind, mimeType, data: buf.toString("base64") };
  }
  if (kind === "markdown" || kind === "text") {
    return { kind, text: buf.toString("utf8") };
  }
  const html = buf.toString("utf8");
  const { text: whole, links, images } = htmlToText(html, finalUrl);
  // Lesson and article pages put their menus before the first <h1>
  // (apcs.tinocs.com: ~2,500 lines of sidebar). Read from there when that
  // still leaves real content; the links still come from the whole page.
  const h1 = html.search(/<h1[\s>]/i);
  const body = h1 > 0 ? htmlToText(html.slice(h1), finalUrl).text : "";
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  const text = body.trim().length >= 200 ? body : whole;
  return { kind, title, text, links: links.slice(0, LINK_CAP), images: images.slice(0, LINK_CAP) };
}

/**
 * Fetch a public web page (or .md/.txt/.pdf) and return readable content.
 * `guard` (default: the real DNS-backed address guard) and `fetchImpl`
 * (default: global fetch) are injectable for tests.
 */
export async function fetchPage(url, { guard = assertPublicHost, fetchImpl = fetch } = {}) {
  const cached = await readCachedFile(url);
  if (cached && Date.now() - new Date(cached.meta.fetchedAt).getTime() < CACHE_TTL_MS) {
    const result = await buildResult(cached.meta.finalUrl, cached.meta.contentType, cached.data);
    return { url, final_url: cached.meta.finalUrl, fetched_at: cached.meta.fetchedAt, cached: true, ...result };
  }

  let current = url;
  let res;
  for (let redirects = 0; ; redirects++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    await guard(parsed.hostname);

    res = await fetchWithTimeout(fetchImpl, current);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects fetching ${url}`);
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect from ${current} had no Location header`);
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }

  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);

  const buf = await readCapped(res, MAX_BYTES);
  const contentType = res.headers.get("content-type") || "";
  const finalUrl = current;
  const fetchedAt = new Date().toISOString();

  await writeCachedFile(url, { finalUrl, contentType, fetchedAt }, buf);

  const result = await buildResult(finalUrl, contentType, buf);
  return { url, final_url: finalUrl, fetched_at: fetchedAt, cached: false, ...result };
}
