// Shared by the overlays: a shadow-rooted host of our own, neo-plan's look
// (DESIGN.md: light only, 1px borders, one 6px radius, no shadows, Public Sans
// + IBM Plex Mono, class colour only as an 8px dot), and the message to the
// service worker. Content scripts never see the neo-plan token.

export const UNDO_MS = 6000; // neo-plan --duration-undo

/** { ok, status, data } from the service worker; never throws. */
export async function np(op, args = {}) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'neoplan', op, ...args });
    return r && typeof r === 'object' ? r : { ok: false, status: 0, data: { error: 'extension' } };
  } catch {
    return { ok: false, status: 0, data: { error: 'extension' } };
  }
}

/**
 * A failed change, in a few words. A 404 with no JSON body is a route neo-plan
 * doesn't have yet (its own 404s answer {error:"not_found"}).
 */
export function failText(r) {
  if (r.status === 401) return 'Token needed';
  if (r.status === 0) return 'Can’t reach neo-plan';
  if ((r.status === 404 || r.status === 405) && !r.data?.error) return 'neo-plan needs an update';
  return 'Not saved';
}

// Fonts: the FontFace API adds them to the document's font set without adding
// a node to Schoology's page. Families are prefixed so nothing on the page
// picks them up by accident.
let fontsLoaded = false;
export function loadFonts() {
  if (fontsLoaded || !document.fonts) return;
  fontsLoaded = true;
  const faces = [
    new FontFace('np Public Sans', `url("${chrome.runtime.getURL('panel/fonts/public-sans-latin.woff2')}") format("woff2")`, { weight: '400 600' }),
    new FontFace('np Plex Mono', `url("${chrome.runtime.getURL('panel/fonts/ibm-plex-mono-latin-400.woff2')}") format("woff2")`, { weight: '400' }),
  ];
  for (const f of faces) { document.fonts.add(f); f.load().catch(() => {}); }
}

export const BASE_CSS = `
:host {
  all: initial;
  --bg: #f6f5f1; --surface: #ffffff; --ink: #1b1c1e; --ink-dim: #5c5f66; --line: #e2e0da;
  --ready: #ffd400; --time: #d9480f;
  --class-1: #2f6f4e; --class-2: #1f5d8c; --class-3: #6b4a2f; --class-4: #6b3fa0;
  --class-5: #a02c4a; --class-6: #3c6e71; --class-7: #7a6a1f; --class-8: #4a4e69; --class-none: #a8a49b;
  --sans: "np Public Sans", "Public Sans", ui-sans-serif, system-ui, sans-serif;
  --mono: "np Plex Mono", "IBM Plex Mono", ui-monospace, monospace;
  --radius: 6px;
  font-family: var(--sans);
  font-size: 13px;
  line-height: 18px;
  color: var(--ink);
}
* { box-sizing: border-box; }
button {
  font: inherit; color: inherit; background: none; border: 0; border-radius: 0;
  padding: 0; margin: 0; cursor: pointer;
}
button:disabled { cursor: default; color: var(--ink-dim); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.mono { font-family: var(--mono); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
.dim { color: var(--ink-dim); }
.time { color: var(--time); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.link { text-decoration: underline; text-underline-offset: 2px; }
.box { display: inline-block; width: 16px; height: 16px; background: var(--ready); border: 1px solid var(--ink-dim); flex: none; }
[hidden] { display: none !important; }
`;

/** A host element of our own with a closed shadow root and the base CSS. */
export function createHost(tag, css) {
  loadFonts();
  const host = document.createElement(tag);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = BASE_CSS + (css || '');
  root.append(style);
  return { host, root };
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** The 8px class dot, in the class's colour (1–8), or the none colour. */
export function classDot(cls) {
  const d = el('span', 'dot');
  const n = Number(cls?.colour_index);
  d.style.background = `var(--class-${n >= 1 && n <= 8 ? n : 'none'})`;
  d.setAttribute('aria-hidden', 'true');
  return d;
}

/** A click on our control stays ours: Schoology's row never sees it. */
export function onClick(button, fn) {
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  });
}

/** Run fn at most once per `ms`, after the last call. */
export function debounce(fn, ms) {
  let t = 0;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
