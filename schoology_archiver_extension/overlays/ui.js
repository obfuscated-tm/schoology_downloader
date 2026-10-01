// Shared by the overlays: a shadow-rooted host of our own in the overlay's
// look (docs/OVERLAY-UI.md: one 6px radius, no shadows, Instrument Sans +
// JetBrains Mono bundled here — themeable, see "Themes and settings"), the
// Overlay on/off switch every host obeys, and the message to the service
// worker. Content scripts never see the neo-plan token.

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
  if (typeof r.data?.problem === 'string' && r.data.problem) return r.data.problem; // neo-plan's own words: "Set a date first"
  return 'Not saved';
}

// Fonts: the FontFace API adds them to the document's font set without adding
// a node to Schoology's page. Families are prefixed so nothing on the page
// picks them up by accident.
const FONTS = [
  ['ov Instrument Sans', 'instrument-sans-latin'],
  ['ov JetBrains Mono', 'jetbrains-mono-latin'],
];
let fontsLoaded = false;
export function loadFonts() {
  if (fontsLoaded || !document.fonts || typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;
  fontsLoaded = true;
  for (const [family, file] of FONTS) {
    for (const weight of ['400', '500', '600']) {
      const f = new FontFace(family, `url("${chrome.runtime.getURL(`overlays/fonts/${file}-${weight}.woff2`)}") format("woff2")`, { weight });
      document.fonts.add(f);
      f.load().catch(() => {});
    }
  }
}

const OFF_ATTR = 'data-overlay-off'; // on a host: the Overlay switch is off

export const BASE_CSS = `
:host {
  all: initial;
  --accent: #1D5EA8; --accent-soft: #E7EFF8;
  --ink: #1F2429; --dim: #5E6670; --faint: #8A929B;
  --line: #DCE0E5; --sunk: #F6F7F9; --surface: #FFFFFF;
  --bad: #B8430F; --bad-soft: #FBEDE5;
  --good: #23794A; --good-soft: #E6F3EC;
  --class-1: #2f6f4e; --class-2: #1f5d8c; --class-3: #6b4a2f; --class-4: #6b3fa0;
  --class-5: #a02c4a; --class-6: #3c6e71; --class-7: #7a6a1f; --class-8: #4a4e69; --class-none: #a8a49b;
  --sans: "ov Instrument Sans", "Instrument Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "ov JetBrains Mono", "JetBrains Mono", ui-monospace, Menlo, monospace;
  --radius: 6px;
  font-family: var(--sans);
  font-size: 13px;
  line-height: 18px;
  color: var(--ink);
}
:host([${OFF_ATTR}]) { display: none !important; }
:host([hidden]) { display: none !important; }
* { box-sizing: border-box; }
button {
  font: inherit; color: inherit; background: none; border: 0; border-radius: 0;
  padding: 0; margin: 0; cursor: pointer;
}
button:disabled { cursor: default; color: var(--dim); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mono { font-family: var(--mono); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
.dim { color: var(--dim); }
.bad { color: var(--bad); }
.good { color: var(--good); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
[hidden] { display: none !important; }
`;

// ── The Overlay switch ──────────────────────────────────────────────────
// One setting in chrome.storage.local, for every Schoology page. Off puts
// OFF_ATTR on every host createHost made, and BASE_CSS hides it; the switch
// itself (keep: true) stays so it can be turned back on. Until the setting
// is read, hosts start hidden, so an off page never flashes the overlay.
export const OVERLAY_KEY = 'overlayOn';
const hosts = new Set(); // { host, keep }
const listeners = new Set();
let overlayOn = null; // null: not read yet

function applyOverlay() {
  for (const { host, keep } of hosts) host.toggleAttribute(OFF_ATTR, !keep && overlayOn !== true);
  for (const fn of listeners) fn(overlayOn !== false);
}

// ── Per-host theme tokens ───────────────────────────────────────────────
// theme.js owns THEMES and hands us a (themeKey) => css function, so this
// file doesn't need to import theme.js (no cycle: theme.js imports this one
// for onOverlay/onSettings). Each host gets a second <style data-np-theme>
// holding :host { --accent; --accent-soft } and, in dark themes, the same
// media re-invert rule theme.js writes on the page (a page stylesheet can't
// reach into a shadow root).
let themeProvider = null;

function hostThemeCss() {
  return themeProvider ? themeProvider(settings.theme) || '' : '';
}

function refreshHostThemes() {
  const css = hostThemeCss();
  for (const { themeStyle } of hosts) themeStyle.textContent = css;
}

/** theme.js registers its (themeKey) => css function here once, on import. */
export function setThemeProvider(fn) {
  themeProvider = fn;
  refreshHostThemes();
}

function setLocal(on) {
  if (overlayOn === on) return;
  overlayOn = on;
  applyOverlay();
}

try {
  chrome.storage.local.get(OVERLAY_KEY).then((got) => setLocal(got?.[OVERLAY_KEY] !== false), () => setLocal(true));
  // Another tab (or this one) changed it: every open Schoology page follows.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && OVERLAY_KEY in changes) setLocal(changes[OVERLAY_KEY].newValue !== false);
  });
} catch {
  overlayOn = true; // not in the extension (tests)
}

/** Is the overlay on? (true until the setting says otherwise) */
export const isOverlayOn = () => overlayOn !== false;

/** fn(on) now, and after every change. */
export function onOverlay(fn) {
  listeners.add(fn);
  if (overlayOn !== null) fn(overlayOn);
  return () => listeners.delete(fn);
}

/** Turn the overlay on or off, on this page at once and saved for every page. */
export function setOverlay(on) {
  setLocal(!!on);
  try { chrome.storage.local.set({ [OVERLAY_KEY]: !!on }).catch(() => {}); } catch { /* tests */ }
}

// ── Settings ────────────────────────────────────────────────────────────
// The settings menu's choices (switch.js draws the menu), one object in
// chrome.storage.local, for every Schoology page:
//   theme    a key of THEMES (theme.js)
//   percent  a small "95%" beside each graded score
export const SETTINGS_KEY = 'overlaySettings';
export const SETTINGS_DEFAULTS = { theme: 'schoology', percent: true };
let settings = { ...SETTINGS_DEFAULTS };
let settingsRead = false;
const settingsListeners = new Set();

function applySettings(next) {
  settings = { ...SETTINGS_DEFAULTS, ...(next && typeof next === 'object' ? next : {}) };
  settingsRead = true;
  refreshHostThemes();
  for (const fn of settingsListeners) fn(settings);
}

try {
  chrome.storage.local.get(SETTINGS_KEY).then((got) => applySettings(got?.[SETTINGS_KEY]), () => applySettings(null));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTINGS_KEY in changes) applySettings(changes[SETTINGS_KEY].newValue);
  });
} catch {
  settingsRead = true; // not in the extension (tests): the defaults
}

/** The settings now (the defaults until they're read). */
export const getSettings = () => settings;

/** fn(settings) once they're read, and after every change. */
export function onSettings(fn) {
  settingsListeners.add(fn);
  if (settingsRead) fn(settings);
  return () => settingsListeners.delete(fn);
}

/** Change one setting, on this page at once and saved for every page. */
export function setSetting(key, value) {
  const next = { ...settings, [key]: value };
  applySettings(next);
  try { chrome.storage.local.set({ [SETTINGS_KEY]: next }).catch(() => {}); } catch { /* tests */ }
}

/**
 * A host element of our own with a closed shadow root and the base CSS. It
 * follows the Overlay switch unless `keep` (the switch itself).
 */
export function createHost(tag, css, { keep = false } = {}) {
  loadFonts();
  const host = document.createElement(tag);
  host.toggleAttribute(OFF_ATTR, !keep && overlayOn !== true);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = BASE_CSS + (css || '');
  root.append(style);
  const themeStyle = document.createElement('style');
  themeStyle.setAttribute('data-np-theme', '');
  themeStyle.textContent = hostThemeCss();
  root.append(themeStyle);
  hosts.add({ host, keep, themeStyle });
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

/** Clicks and keys inside our host stay ours: Schoology's row handlers never see them. */
export function keepEvents(host) {
  for (const t of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'change']) {
    host.addEventListener(t, (e) => e.stopPropagation());
  }
}

/** Run fn at most once per `ms`, after the last call. */
export function debounce(fn, ms) {
  let t = 0;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
