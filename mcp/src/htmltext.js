// Hand-rolled HTML -> readable text + absolute link list. Good enough for
// course-website pages (plain articles, lesson pages), not a general
// browser-grade renderer.
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(str) {
  return str.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const num = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isNaN(num) ? m : String.fromCodePoint(num);
    }
    const key = code.toLowerCase();
    return ENTITIES[key] !== undefined ? ENTITIES[key] : m;
  });
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "");
}

const LINK_CAP = 200;

/**
 * Convert an HTML document to readable plain text plus a capped list of
 * absolute links. Strips <script>/<style>/<nav>/comments, keeps a rough
 * block structure (headings, list items, paragraph/line breaks).
 */
export function htmlToText(html, baseUrl) {
  let cleaned = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|nav|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  const links = [];
  const linkRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(cleaned)) && links.length < LINK_CAP) {
    const href = (m[1] ?? m[2] ?? "").trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) continue;
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    const text = decodeEntities(stripTags(m[3])).replace(/\s+/g, " ").trim();
    links.push({ text: text || abs, url: abs });
  }

  let text = cleaned
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n## ")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  text = decodeEntities(text);
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, links };
}
