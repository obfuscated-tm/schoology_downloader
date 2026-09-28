// Themes: a coloured (or dark) Schoology page to go with the overlay's own
// accent. docs/OVERLAY-UI.md ("Themes and settings") is the spec.
//
// The 'schoology' theme makes no page changes at all — additive, per the
// overlay's own principle. Every other theme adds one <style id="np-theme">
// on document.documentElement (light DOM, not a shadow root) while the
// overlay is on; it's removed the moment the overlay switches off or the
// theme changes back to 'schoology'. themeCss() builds that stylesheet and
// is pure, so it's testable in node without a DOM.
//
// Dark themes use "smart invert": html { filter: invert(1) hue-rotate(180deg) }
// plus a re-invert rule on real media so pictures don't look like film
// negatives. A colour we want to *display* under that filter (a header, its
// text) has to be written pre-inverted — preInvert() computes the exact
// pre-image by running the same filter math forward (the combined operation
// is its own inverse).
//
// ui.js keeps a style per host for our own tokens (--accent/--accent-soft)
// and, in dark themes, the same re-invert rule for media inside shadow
// roots (a page stylesheet can't reach into a shadow root). To avoid an
// import cycle, ui.js knows nothing about THEMES: theme.js hands it a
// `hostThemeCss(key)` function via setThemeProvider().

import { onOverlay, onSettings, setThemeProvider } from './ui.js';

// Every colour here is what the eye should see, dark themes included:
// themeCss() and hostThemeCss() pre-invert them for dark themes (paint()).
//   header      one colour, or gradient stops left to right
//   headerText  the header's text and icons (default white)
//   page        the page behind Schoology's white cards, and past its edges
//               (null: Schoology's own grey)
export const THEMES = {
  schoology: { name: 'Schoology', dark: false, header: null, page: null, accent: '#1D5EA8', accentSoft: '#E7EFF8' },
  ocean: { name: 'Ocean', dark: false, header: '#0B5E77', page: '#EEF5F7', accent: '#0B5E77', accentSoft: '#E3F0F4' },
  forest: { name: 'Forest', dark: false, header: '#1E6B3A', page: '#EFF5F0', accent: '#1E6B3A', accentSoft: '#E5F2EA' },
  plum: { name: 'Plum', dark: false, header: '#6B3FA0', page: '#F4F0F9', accent: '#6B3FA0', accentSoft: '#F0E9F7' },
  crimson: { name: 'Crimson', dark: false, header: '#A02C3E', page: '#F9F1F2', accent: '#A02C3E', accentSoft: '#F8E8EA' },
  graphite: { name: 'Graphite', dark: false, header: '#3F4750', page: '#EEF0F2', accent: '#3F4750', accentSoft: '#E9EBEC' },
  sunset: { name: 'Sunset', dark: false, header: ['#B8325A', '#D9573B', '#E08A2E'], page: '#FFF4EC', accent: '#B8431F', accentSoft: '#FCE9DF' },
  aurora: { name: 'Aurora', dark: false, header: ['#0F766E', '#2563EB', '#7C3AED'], page: '#EEF6F8', accent: '#0F766E', accentSoft: '#E2F3F1' },
  sakura: { name: 'Sakura', dark: false, header: ['#B83280', '#D6477F'], page: '#FDF1F6', accent: '#B0306F', accentSoft: '#FBE6EF' },
  matcha: { name: 'Matcha', dark: false, header: ['#3F6212', '#5B7F2A'], page: '#F3F6EA', accent: '#4D6B18', accentSoft: '#EAF1DA' },
  rainbow: { name: 'Rainbow', dark: false, header: ['#D62828', '#E76F24', '#D9A400', '#2A9D48', '#1D6FD1', '#7B3FC4'], page: '#F7F6FB', accent: '#5B3FC4', accentSoft: '#EEEAFA' },
  dark: { name: 'Dark', dark: true, header: '#1F2226', page: '#141619', accent: '#6EA8FE', accentSoft: '#1C2A3D' },
  midnight: { name: 'Midnight', dark: true, header: ['#10244A', '#1B3A7A'], page: '#0E1422', accent: '#7AA2FF', accentSoft: '#1A2440' },
  dracula: { name: 'Dracula', dark: true, header: ['#44475A', '#6272A4'], page: '#22232E', accent: '#BD93F9', accentSoft: '#352E4D' },
  nord: { name: 'Nord', dark: true, header: '#3B4252', page: '#2A2F3A', accent: '#88C0D0', accentSoft: '#2F3E48' },
  synthwave: { name: 'Synthwave', dark: true, header: ['#F72585', '#7209B7', '#3A0CA3'], page: '#170F2B', accent: '#FF5FB0', accentSoft: '#3A1740' },
  ember: { name: 'Ember', dark: true, header: ['#7C2D12', '#C2410C'], page: '#1B1411', accent: '#FB923C', accentSoft: '#3B2418' },
};

// ── Colour math ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** `a` moved `amount` (0–1) of the way towards `b`, per channel. */
function mix(a, b, amount) {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return rgbToHex(x.map((c, i) => c + (y[i] - c) * amount));
}

// The CSS Filter Effects hue-rotate() matrix (deg), applied to invert(1)'s
// output — i.e. exactly what `filter: invert(1) hue-rotate(180deg)` does.
function invertThenHueRotate(hex, deg) {
  const [r, g, b] = hexToRgb(hex).map((c) => 1 - c / 255); // invert(1)
  const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const m = [
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
  ];
  const out = m.map(([a, bb, cc]) => clamp01(a * r + bb * g + cc * b));
  return rgbToHex(out.map((c) => c * 255));
}

/**
 * The colour that, once the page applies `invert(1) hue-rotate(180deg)`,
 * displays as `hex`. The filter is its own inverse, so running it forward
 * on `hex` gives its own pre-image.
 */
export function preInvert(hex) {
  return invertThenHueRotate(hex, 180);
}

// Real media inside an inverted page needs re-inverting so it looks normal.
// `:not(picture) > img` (not a blanket `img`) so a `picture > img` isn't
// inverted twice — the `picture` selector already re-inverts it once.
const REINVERT_SELECTOR = ':not(picture) > img, video, iframe, canvas, picture, svg image, embed, object, [style*="background-image"]';
export const REINVERT_CSS = `${REINVERT_SELECTOR} { filter: invert(1) hue-rotate(180deg); }`;

/** A colour as the page must write it: pre-inverted under a dark theme. */
export const paint = (hex, dark) => (dark ? preInvert(hex) : hex);

/** A theme's header as a CSS background, painted for a page that is (or isn't) dark. */
export function headerBackground(t, dark = t.dark) {
  const stops = [].concat(t.header || t.accent).map((c) => paint(c, dark));
  return stops.length === 1 ? stops[0] : `linear-gradient(90deg, ${stops.join(', ')})`;
}

// Schoology's header (checked on fuhsd.schoology.com, 2026-09-27): #header
// (the district's colour strip) > header (white) > nav > ul > li, each li
// holding either the <a>/<button> itself or a <div> around it (Courses,
// Groups, Apps and the user menu, which carry their own white background).
// Its classes are hashed, so only structure is used. Dropdown panels sit
// deeper than li > div > button and aren't touched.
const HEADER = '#header, #header > header'; // nav: transparent, so a gradient isn't painted twice
const ITEMS = ['#header > header nav > ul > li > :is(a, button)', '#header > header nav > ul > li > div > :is(a, button)'];
const each = (suffix) => ITEMS.map((s) => s + suffix).join(',\n');

function headerCss(t) {
  const dark = t.dark;
  const text = paint(t.headerText || '#FFFFFF', dark);
  // Icons are drawn in their own fills, not currentColor: flatten them to
  // the text colour (white, or black before a dark page's inversion).
  const icon = dark ? 'brightness(0)' : 'brightness(0) invert(1)';
  // Three or more stops (rainbow) pass through a light middle: a shadow keeps
  // the white text readable. Light themes only: inverted, it would glow.
  const multi = !dark && Array.isArray(t.header) && t.header.length > 2;
  return `
${HEADER} {
  background: ${headerBackground(t)} !important;
  border-color: transparent !important;
}
#header > header nav { background: transparent !important; }
${each('')} {
  background: transparent !important;
  color: ${text} !important;${multi ? '\n  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);' : ''}
}
${each(':hover')} {
  background: ${dark ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.16)'} !important;
}
${each(' svg')} {
  filter: ${icon};
}`;
}

/** The page-level stylesheet for `key` ('' for 'schoology' — no page changes). */
export function themeCss(key) {
  const t = THEMES[key];
  if (!t || key === 'schoology') return '';
  const parts = [];
  if (t.dark) {
    // html's background paints the canvas: inside the window it's filtered
    // like the page (so it's pre-inverted, as body's is), but the rubber-band
    // area past the page's edges isn't, and would flash light. No colour is
    // right in both, so dark themes turn the bounce off.
    parts.push(`html { filter: invert(1) hue-rotate(180deg); background: ${preInvert(t.page)} !important; overscroll-behavior: none; }`);
    parts.push(`body { background: ${preInvert(t.page)} !important; }`);
    parts.push(REINVERT_CSS);
  } else if (t.page) {
    parts.push(`html, body { background: ${t.page} !important; }`);
  }
  if (t.header) parts.push(headerCss(t));
  return parts.join('\n');
}

// ── Our own hosts' tokens (registered with ui.js; see the comment above) ──

/**
 * Every createHost root's --accent/--accent-soft for `key`, plus (dark
 * themes only) the same re-invert rule as the page, since a shadow root's
 * media (the launcher's iframe) isn't reached by a page stylesheet.
 */
function hostThemeCss(key) {
  const t = THEMES[key];
  if (!t || key === 'schoology') return '';
  // Our hosts get inverted right along with the page: their light tokens
  // (ink, surface…) are what come out dark. The accents are given as seen,
  // so they're pre-inverted like the page's colours.
  let css = `:host { --accent: ${paint(t.accent, t.dark)}; --accent-soft: ${paint(t.accentSoft, t.dark)}; }`;
  if (t.dark) {
    // Inverted as-is, white surfaces come out pure black: harsh against the
    // theme's page. Lift them off the page instead (a card a step lighter
    // than the page, sunk areas at the page itself), as seen, pre-inverted.
    css += `\n:host { --surface: ${preInvert(mix(t.page, '#FFFFFF', 0.07))}; --sunk: ${preInvert(t.page)}; --line: ${preInvert(mix(t.page, '#FFFFFF', 0.16))}; }`;
    css += `\n${REINVERT_CSS}`;
  }
  return css;
}
setThemeProvider(hostThemeCss);

// ── Early apply (theme-early.js calls this at document_start) ─────────────

let styleEl = null;
function applyPageStyle(key, overlayOn) {
  const show = overlayOn && key !== 'schoology' && THEMES[key];
  if (!show) {
    if (styleEl) { styleEl.remove(); styleEl = null; }
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'np-theme';
    document.documentElement.appendChild(styleEl);
  }
  const css = themeCss(key);
  if (styleEl.textContent !== css) styleEl.textContent = css;
}

let started = false;
/** Wait for both the Overlay switch and the settings, then keep np-theme in sync. */
export function start() {
  if (started) return;
  started = true;
  let overlayOn = null;
  let theme = null;
  const update = () => { if (overlayOn === null || theme === null) return; applyPageStyle(theme, overlayOn); };
  onOverlay((on) => { overlayOn = on; update(); });
  onSettings((s) => { theme = s.theme; update(); });
}
