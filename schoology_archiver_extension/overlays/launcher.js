// The neo-plan button: fixed at the bottom right of Schoology's pages (not on
// assignments or tests; boot.js decides). It opens neo-plan itself in a card
// over the page, CARD_MARGIN in from each edge, with the page dimmed behind.
// Close with ×, Esc, or a click on the dimmed page. The frame is kept while
// the page is open, so a second open is instant and keeps neo-plan's place.
//
// neo-plan only sees its sign-in inside the card once its cookie allows being
// framed (docs/EXTENSION-CONTRACT-5.md in neo-plan); "Open in a tab" always works.

import { createHost, el, onClick } from './ui.js';

const CARD_MARGIN = 32;

const CSS = `
.open {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  height: 32px; padding: 0 12px; background: var(--surface);
  border: 1px solid var(--ink-dim); border-radius: var(--radius);
  font-weight: 600;
}
.open:hover { border-color: var(--ink); }
.open .mono { font-weight: 400; color: var(--ink-dim); }
.dim-page {
  position: fixed; inset: 0; z-index: 2147483001;
  background: rgba(27, 28, 30, 0.4);
}
.card {
  position: fixed; inset: ${CARD_MARGIN}px; z-index: 2147483002;
  display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius);
  overflow: hidden;
}
.bar {
  display: flex; align-items: center; gap: 16px; flex: none;
  height: 40px; padding: 0 12px; background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.bar .brand { font-weight: 600; margin-right: auto; }
.bar a { color: var(--ink-dim); text-decoration: underline; text-underline-offset: 2px; }
.bar a:hover, .close:hover { color: var(--ink); }
.close { font-size: 18px; line-height: 18px; color: var(--ink-dim); min-width: 24px; height: 24px; }
iframe { flex: 1; width: 100%; border: 0; background: var(--bg); }
.err { padding: 16px; color: var(--time); }
@media (max-width: 600px) { .card { inset: 8px; } }
`;

export function start({ doc = document, send = (m) => chrome.runtime.sendMessage(m) } = {}) {
  const { host, root } = createHost('np-launcher', CSS);

  const b = el('button', 'open', 'neo-plan');
  b.setAttribute('aria-label', 'Open neo-plan');
  b.title = 'Open neo-plan';
  b.append(el('span', 'mono', '↗'));

  const shade = el('div', 'dim-page');
  shade.hidden = true;
  const card = el('div', 'card');
  card.hidden = true;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'neo-plan');
  const tab = el('a', 'mono', 'Open in a tab');
  tab.target = '_blank';
  tab.rel = 'noopener';
  const close = el('button', 'close', '×');
  close.setAttribute('aria-label', 'Close neo-plan');
  close.title = 'Close (Esc)';
  const bar = el('div', 'bar');
  bar.append(el('span', 'brand', 'neo-plan'), tab, close);
  card.append(bar);
  root.append(b, shade, card);

  let frame = null;
  let isOpen = false;

  async function open() {
    if (isOpen) return;
    if (!frame) {
      let r = null;
      try { r = await send({ type: 'neoplanServer' }); } catch { /* worker gone: extension reloaded */ }
      if (!r?.ok || !r.server) {
        if (!card.querySelector('.err')) card.append(el('div', 'err', 'Reload the extension, then this page.'));
      } else {
        card.querySelector('.err')?.remove();
        tab.href = `${r.server}/`;
        frame = el('iframe');
        frame.title = 'neo-plan';
        frame.src = `${r.server}/`;
        card.append(frame);
      }
    }
    isOpen = true;
    shade.hidden = false;
    card.hidden = false;
    b.hidden = true;
    (frame || close).focus();
  }

  function shut() {
    if (!isOpen) return;
    isOpen = false;
    shade.hidden = true;
    card.hidden = true;
    b.hidden = false;
    b.focus();
  }

  onClick(b, open);
  onClick(close, shut);
  onClick(shade, shut);
  // The page behind stays where it was: no scrolling it through the shade.
  shade.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  doc.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') { e.stopPropagation(); shut(); }
  }, true);

  doc.body.append(host);
  return { host, root, button: b, card, open, close: shut, get frame() { return frame; } };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
