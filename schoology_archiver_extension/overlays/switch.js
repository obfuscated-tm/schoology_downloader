// The Overlay switch: a small on/off at the bottom left of every Schoology
// page the extension adds anything to (boot.js decides), and Alt+S. Off hides
// every element the extension adds, on every Schoology page, so Schoology
// looks untouched; the switch itself stays, reading "Schoology only".
// The setting lives in chrome.storage.local (ui.js keeps it).
//
// Beside it, while the overlay is on: a gear that opens the settings popover
// (docs/OVERLAY-UI.md, "Themes and settings") — theme (a THEMES swatch grid,
// theme.js) and the grades "Percent beside scores" checkbox, both bound
// straight to ui.js's setSetting so every open tab follows.

import { createHost, el, onClick, keepEvents, isOverlayOn, onOverlay, setOverlay, getSettings, onSettings, setSetting } from './ui.js';
import { THEMES, headerBackground, paint } from './theme.js';

const GEAR_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle>'
  + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

const CSS = `
.wrap {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
}
.sw {
  display: inline-flex; align-items: center; gap: 8px;
  height: 28px; padding: 0 10px 0 6px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
  font-size: 12px; color: var(--dim);
}
.sw:hover { border-color: var(--dim); color: var(--ink); }
.track {
  position: relative; width: 28px; height: 16px; border-radius: 8px; flex: none;
  background: var(--line);
}
.track::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%; background: var(--surface);
}
.sw[aria-pressed="true"] { color: var(--accent); }
.sw[aria-pressed="true"] .track { background: var(--accent); }
.sw[aria-pressed="true"] .track::after { left: 14px; }
.gear {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; flex: none; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius); color: var(--dim);
}
.gear:hover { border-color: var(--dim); color: var(--ink); }
.gear[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); }
.pop {
  position: fixed; left: 16px; bottom: 56px; z-index: 2147483000;
  width: 296px; padding: 12px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.pop h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; }
.group + .group { margin-top: 14px; }
.label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 6px; }
.themes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.theme-btn {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 6px 2px; border-radius: var(--radius); border: 1px solid transparent;
  font-size: 11px; color: var(--dim); text-align: center;
}
.theme-btn:hover { background: var(--sunk); color: var(--ink); }
.theme-btn[aria-pressed="true"] { color: var(--ink); box-shadow: 0 0 0 2px var(--accent); }
.swatch {
  width: 36px; height: 18px; border-radius: 4px; display: flex; overflow: hidden;
  border: 1px solid var(--line); flex: none;
}
.swatch span { flex: 1; }
.pct-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink); }
.pct-row input { width: 14px; height: 14px; }
`;

/** Alt+S, but not while Owen is typing in one of Schoology's fields. */
function isToggleKey(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== 'KeyS') return false;
  const t = e.target;
  return !(t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.localName || '')));
}

/**
 * A theme's swatch: its header, then its page with the accent. Painted for
 * the page it sits on: under a dark theme this menu is inverted too, so the
 * colours are pre-inverted to still show as they will look.
 */
function paintSwatch(s, theme, pageDark) {
  const [left, right] = s.children;
  left.style.background = headerBackground(theme, pageDark);
  right.style.background = paint(theme.accent, pageDark);
  right.style.boxShadow = `inset 0 -6px 0 ${paint(theme.page || '#F1F4F4', pageDark)}`;
}

export function start({ doc = document } = {}) {
  const { host, root } = createHost('np-overlay-switch', CSS, { keep: true });
  keepEvents(host);
  const wrap = el('div', 'wrap');

  const b = el('button', 'sw');
  b.title = 'Switch between the overlay and plain Schoology (Alt+S)';
  const label = el('span');
  b.append(el('span', 'track'), label);

  const gear = el('button', 'gear');
  gear.type = 'button';
  gear.title = 'Settings';
  gear.setAttribute('aria-label', 'Settings');
  gear.setAttribute('aria-haspopup', 'dialog');
  gear.setAttribute('aria-expanded', 'false');
  gear.innerHTML = GEAR_SVG;

  const pop = el('div', 'pop');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Settings');
  pop.append(el('h3', null, 'Settings'));

  const themeGroup = el('div', 'group');
  themeGroup.append(el('div', 'label', 'Theme'));
  const grid = el('div', 'themes');
  const themeBtns = new Map();
  for (const [key, theme] of Object.entries(THEMES)) {
    const tb = el('button', 'theme-btn');
    tb.type = 'button';
    tb.setAttribute('aria-pressed', 'false');
    const sw = el('span', 'swatch');
    sw.append(el('span'), el('span'));
    tb.append(sw, el('span', null, theme.name));
    onClick(tb, () => setSetting('theme', key));
    themeBtns.set(key, tb);
    grid.append(tb);
  }
  themeGroup.append(grid);
  pop.append(themeGroup);

  const gradesGroup = el('div', 'group');
  gradesGroup.append(el('div', 'label', 'Grades'));
  const pctRow = el('label', 'pct-row');
  const percentBox = doc.createElement('input');
  percentBox.type = 'checkbox';
  pctRow.append(percentBox, doc.createTextNode('Percent beside scores'));
  gradesGroup.append(pctRow);
  pop.append(gradesGroup);

  wrap.append(b, gear);
  root.append(wrap, pop);

  const draw = (on) => {
    b.setAttribute('aria-pressed', String(on));
    label.textContent = on ? 'Overlay' : 'Schoology only';
    gear.hidden = !on;
    if (!on) closePop();
  };
  draw(isOverlayOn());
  onOverlay(draw);
  onClick(b, () => setOverlay(!isOverlayOn()));

  const drawSettings = (s) => {
    const pageDark = !!THEMES[s.theme]?.dark;
    for (const [key, tb] of themeBtns) {
      tb.setAttribute('aria-pressed', String(s.theme === key));
      paintSwatch(tb.firstChild, THEMES[key], pageDark);
    }
    percentBox.checked = !!s.percent;
  };
  drawSettings(getSettings());
  onSettings(drawSettings);
  percentBox.addEventListener('change', () => setSetting('percent', percentBox.checked));

  let popOpen = false;
  function openPop() {
    if (popOpen) return;
    popOpen = true;
    pop.hidden = false;
    gear.setAttribute('aria-expanded', 'true');
    themeBtns.get(getSettings().theme)?.focus();
  }
  function closePop() {
    if (!popOpen) return;
    popOpen = false;
    pop.hidden = true;
    gear.setAttribute('aria-expanded', 'false');
    gear.focus();
  }
  onClick(gear, () => (popOpen ? closePop() : openPop()));

  doc.addEventListener('keydown', (e) => {
    if (isToggleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      setOverlay(!isOverlayOn());
      return;
    }
    if (popOpen && e.key === 'Escape') {
      e.stopPropagation();
      closePop();
    }
  }, true);
  // A click outside the popover closes it. Clicks inside our closed shadow
  // root are retargeted to `host` by the time they reach document, so this
  // never fires for our own controls.
  doc.addEventListener('pointerdown', (e) => {
    if (popOpen && e.target !== host) closePop();
  }, true);

  doc.body.append(host);
  return { host, root, button: b, gear, pop };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
