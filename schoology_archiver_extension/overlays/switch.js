// The Overlay switch: a small on/off at the bottom left of every Schoology
// page the extension adds anything to (boot.js decides), and Alt+S. Off hides
// every element the extension adds, on every Schoology page, so Schoology
// looks untouched; the switch itself stays, reading "Schoology only".
// The setting lives in chrome.storage.local (ui.js keeps it).

import { createHost, el, onClick, isOverlayOn, onOverlay, setOverlay } from './ui.js';

const CSS = `
.sw {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
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
`;

/** Alt+S, but not while Owen is typing in one of Schoology's fields. */
function isToggleKey(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== 'KeyS') return false;
  const t = e.target;
  return !(t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.localName || '')));
}

export function start({ doc = document } = {}) {
  const { host, root } = createHost('np-overlay-switch', CSS, { keep: true });
  const b = el('button', 'sw');
  b.title = 'Switch between the overlay and plain Schoology (Alt+S)';
  const label = el('span');
  b.append(el('span', 'track'), label);
  root.append(b);

  const draw = (on) => {
    b.setAttribute('aria-pressed', String(on));
    label.textContent = on ? 'Overlay' : 'Schoology only';
  };
  draw(isOverlayOn());
  onOverlay(draw);
  onClick(b, () => setOverlay(!isOverlayOn()));
  doc.addEventListener('keydown', (e) => {
    if (!isToggleKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setOverlay(!isOverlayOn());
  }, true);

  doc.body.append(host);
  return { host, root, button: b };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
