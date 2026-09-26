// Content script (classic): loads the overlay for this page as a module from
// the extension. The overlays only read the page and draw inside their own
// shadow roots; they never click, submit or change Schoology's elements.
(() => {
  const p = location.pathname;
  let which = null;
  if (/^\/assignment\/\d+(\/info)?\/?$/.test(p)) which = 'assignment';
  else if (/^\/home\/?$/.test(p)) which = 'home';
  if (!which) return;
  import(chrome.runtime.getURL(`overlays/${which}.js`)).catch((e) => console.debug('[neo-plan overlay]', e));
})();
