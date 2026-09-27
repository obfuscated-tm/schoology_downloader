// Content script (classic): loads this page's overlays as modules from the
// extension. The overlays only read the page and draw inside their own
// shadow roots; they never click or submit. Schoology's elements are only
// added to (the grades page also adds rows of its own to the gradebook and
// tints a row that has a what-if score).
(() => {
  if (window.top !== window) return;
  const p = location.pathname;
  const load = (which) => import(chrome.runtime.getURL(`overlays/${which}.js`)).catch((e) => console.debug('[neo-plan overlay]', e));

  let page = null;
  if (/^\/assignment\/\d+(\/info)?\/?$/.test(p)) page = 'assignment';
  else if (/^\/home(\/assignments)?\/?$/.test(p)) page = 'home';
  else if (/^\/course\/\d+(\/(materials|updates))?\/?$/.test(p)) page = 'course';
  else if (/^\/course\/\d+\/student_grades\/?$/.test(p)) page = 'grades';
  if (page) load(page);

  // The neo-plan button: everywhere but assignments and tests.
  const inWork = /^\/assignment\//.test(p)
    || /assessment/i.test(p)
    || /\/(take|start|resume|dropbox)(\/|$)/.test(p);
  const launcher = !inWork && !/^app\./i.test(location.hostname);
  if (launcher) load('launcher');

  // The Overlay switch (and Alt+S): wherever anything above was added.
  if (page || launcher) load('switch');
})();
