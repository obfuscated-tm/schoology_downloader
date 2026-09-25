// Minimal HTML -> Markdown converter, good enough for Schoology rich text
// (instructions, pages, discussion posts). Output is meant for people and AI
// to read, not to round-trip back to HTML.

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'FORM', 'FIGURE', 'FIGCAPTION', 'CENTER']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG']);

// Schoology wraps outbound links as /link?path=<encoded url>; unwrap them.
export function resolveUrl(href, origin) {
  if (!href) return '';
  try {
    const u = new URL(href, origin);
    if (u.pathname === '/link' && u.searchParams.get('path')) return u.searchParams.get('path');
    return u.href;
  } catch {
    return href;
  }
}

// keepHidden: include screen-reader-only text (quiz reviews use it to mark "Selected" / "correct").
export function htmlToMd(root, origin, { keepHidden = false } = {}) {
  if (!root) return '';
  const out = convert(root, { origin, listDepth: 0, keepHidden });
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convert(node, ctx) {
  let s = '';
  for (const n of node.childNodes) s += one(n, ctx);
  return s;
}

function one(n, ctx) {
  if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ');
  if (n.nodeType !== 1) return '';
  const tag = n.tagName.toUpperCase();
  if (SKIP.has(tag)) return '';
  if (n.classList.contains('visually-hidden')) return ctx.keepHidden ? ` _${n.textContent.trim()}_ ` : '';

  switch (tag) {
    case 'BR': return '  \n';
    case 'HR': return '\n\n---\n\n';
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const t = convert(n, ctx).trim();
      return t ? `\n\n${'#'.repeat(Math.min(6, Number(tag[1]) + 1))} ${t}\n\n` : '';
    }
    case 'STRONG': case 'B': {
      const t = convert(n, ctx).trim();
      return t ? ` **${t}** ` : '';
    }
    case 'EM': case 'I': {
      const t = convert(n, ctx).trim();
      return t ? ` *${t}* ` : '';
    }
    case 'U': return convert(n, ctx);
    case 'CODE': return '`' + n.textContent + '`';
    case 'PRE': return '\n\n```\n' + n.textContent + '\n```\n\n';
    case 'A': {
      const url = resolveUrl(n.getAttribute('href'), ctx.origin);
      const t = convert(n, ctx).trim() || url;
      if (!url || url.startsWith('javascript:') || url.startsWith('#')) return t;
      return t === url ? `<${url}>` : `[${t}](${url})`;
    }
    case 'IMG': {
      const src = resolveUrl(n.getAttribute('src'), ctx.origin);
      const alt = (n.getAttribute('alt') || 'image').trim();
      return src ? `![${alt}](${src})` : '';
    }
    case 'IFRAME': {
      const src = resolveUrl(n.getAttribute('src'), ctx.origin);
      return src ? `\n\n[Embedded content](${src})\n\n` : '';
    }
    case 'UL': case 'OL': {
      const inner = { ...ctx, listDepth: ctx.listDepth + 1 };
      let i = 0;
      let s = '\n';
      for (const li of n.children) {
        if (li.tagName.toUpperCase() !== 'LI') continue;
        i++;
        const bullet = tag === 'OL' ? `${i}.` : '-';
        const body = convert(li, inner).trim().replace(/\n/g, '\n' + '  '.repeat(ctx.listDepth + 1));
        s += `${'  '.repeat(ctx.listDepth)}${bullet} ${body}\n`;
      }
      return s + '\n';
    }
    case 'BLOCKQUOTE': {
      const t = convert(n, ctx).trim();
      return t ? '\n\n' + t.split('\n').map((l) => '> ' + l).join('\n') + '\n\n' : '';
    }
    case 'TABLE': return table(n, ctx);
    default:
      if (BLOCK.has(tag) || tag === 'LI') {
        const t = convert(n, ctx);
        return t.trim() ? `\n\n${t.trim()}\n\n` : '';
      }
      return convert(n, ctx);
  }
}

function table(t, ctx) {
  const rows = [...t.querySelectorAll('tr')].map((tr) =>
    [...tr.children].map((c) => convert(c, ctx).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim())
  ).filter((r) => r.some((c) => c));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const lines = [
    '| ' + pad(rows[0]).join(' | ') + ' |',
    '| ' + Array(width).fill('---').join(' | ') + ' |',
    ...rows.slice(1).map((r) => '| ' + pad(r).join(' | ') + ' |'),
  ];
  return '\n\n' + lines.join('\n') + '\n\n';
}
