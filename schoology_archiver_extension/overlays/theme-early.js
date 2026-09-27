// Content script (classic, document_start): applies the page theme before
// first paint, so a dark theme doesn't flash white while boot.js and the
// rest wait for document_idle. Just dynamic-imports theme.js (a module) and
// calls its start(), which waits for the Overlay switch and the settings
// itself (see overlays/theme.js and docs/OVERLAY-UI.md, "Themes and settings").
(() => {
  if (window.top !== window) return;
  import(chrome.runtime.getURL('overlays/theme.js'))
    .then((m) => m.start())
    .catch((e) => console.debug('[neo-plan theme]', e));
})();
