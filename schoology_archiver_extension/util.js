export class StoppedError extends Error {
  constructor() { super('Stopped'); this.name = 'StoppedError'; }
}

// Resolves after ms, or rejects right away when the kill switch fires.
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StoppedError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new StoppedError()); }, { once: true });
  });
}

export function throwIfStopped(signal) {
  if (signal?.aborted) throw new StoppedError();
}

// Make a string safe to use as one path component in chrome.downloads.
export function sanitizeName(s, max = 80) {
  s = (s || '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s*[:/\\|]\s*/g, ' - ')
    .replace(/[<>"?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.~\s-]+/, '')
    .replace(/[.\s]+$/, '');
  if (s.length > max) {
    const m = s.match(/\.[A-Za-z0-9]{1,6}$/);
    const ext = m ? m[0] : '';
    s = s.slice(0, max - ext.length).trim().replace(/[.\s]+$/, '') + ext;
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s || 'untitled';
}

export function extOf(pathOrName) {
  const m = (pathOrName || '').match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? m[1].toLowerCase() : '';
}

// "Global Convergence Lecture.pdf" + "pdf" -> unchanged; "Transition Phrases" + "jpeg" -> "Transition Phrases.jpeg"
export function withExt(name, ext) {
  if (!ext) return name;
  return name.toLowerCase().endsWith('.' + ext.toLowerCase()) ? name : `${name}.${ext}`;
}

export function splitExt(path) {
  const m = path.match(/^(.*?)(\.[A-Za-z0-9]{1,6})?$/);
  return [m[1], m[2] || ''];
}

export async function sha256(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Text of an element with hidden screen-reader helpers removed and whitespace collapsed.
export function cleanText(el) {
  if (!el) return '';
  const c = el.cloneNode(true);
  c.querySelectorAll('.visually-hidden, script, style').forEach((n) => n.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
}

// Markdown link target that tolerates spaces and parentheses.
export function mdPath(p) {
  return `<${p.replace(/>/g, '%3E')}>`;
}

export function parseContentDisposition(cd) {
  if (!cd) return '';
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (m) {
    try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  m = cd.match(/filename\s*=\s*"([^"]+)"/) || cd.match(/filename\s*=\s*([^;]+)/);
  return m ? m[1].trim() : '';
}
