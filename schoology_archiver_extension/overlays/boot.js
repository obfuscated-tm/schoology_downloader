// Content script (classic): loads this page's overlays as modules from the
// extension. The overlays only read the page and draw inside their own
// shadow roots; they never click, submit or change Schoology's elements.
(() => {
  if (window.top !== window) return;
  const p = location.pathname;
  const load = (which) => import(chrome.runtime.getURL(`overlays/${which}.js`)).catch((e) => console.debug('[neo-plan overlay]', e));

  if (/^\/assignment\/\d+(\/info)?\/?$/.test(p)) load('assignment');
  else if (/^\/home\/?$/.test(p)) load('home');
  else if (/^\/course\/\d+\/materials\/?$/.test(p)) load('course');

  // The neo-plan button: everywhere but assignments and tests.
  const inWork = /^\/assignment\//.test(p)
    || /assessment/i.test(p)
    || /\/(take|start|resume|dropbox)(\/|$)/.test(p);
  if (!inWork && !/^app\./i.test(location.hostname)) load('launcher');
})();
