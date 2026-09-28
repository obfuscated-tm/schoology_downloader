// The Archiver runs in the offscreen document (it needs DOMParser, which the
// service worker doesn't have) — but an offscreen document only gets
// chrome.runtime; chrome.storage, chrome.downloads, chrome.tabs and
// chrome.scripting all live in the service worker. Every function here picks
// the right path itself: when chrome.tabs exists (the service worker — sync's
// own use of SchoologyClient) it calls Chrome directly; otherwise (the
// offscreen document) it asks the service worker through one allowlisted
// message, 'archiveProxy' — see background.js, which only accepts these from
// the offscreen document's own URL and answers by calling these same
// functions itself (where they take the direct path).

const hasDirect = () => typeof chrome !== 'undefined' && !!chrome.tabs;

function proxy(op, args) {
  return chrome.runtime.sendMessage({ type: 'archiveProxy', op, args }).then((r) => {
    if (!r?.ok) throw new Error(r?.error || `${op} failed`);
    return r.result;
  });
}

export const storageGet = (key) => (hasDirect() ? chrome.storage.local.get(key) : proxy('storageGet', { key }));
export const storageSet = (obj) => (hasDirect() ? chrome.storage.local.set(obj) : proxy('storageSet', { obj }));

export const downloadsSetUiEnabled = (enabled) => (hasDirect()
  ? chrome.downloads.setUiOptions({ enabled }) : proxy('downloadsUi', { enabled }));
export const downloadsSearch = (query) => (hasDirect() ? chrome.downloads.search(query) : proxy('downloadsSearch', { query }));
export const downloadsCancel = (id) => (hasDirect() ? chrome.downloads.cancel(id) : proxy('downloadsCancel', { id }));
export const downloadsRemoveFile = (id) => (hasDirect() ? chrome.downloads.removeFile(id) : proxy('downloadsRemoveFile', { id }));
export const downloadsStart = (options) => (hasDirect() ? chrome.downloads.download(options) : proxy('downloadsStart', { options }));

export const tabsCreate = (opts) => (hasDirect() ? chrome.tabs.create(opts) : proxy('tabsCreate', { opts }));
export const tabsRemove = (id) => (hasDirect() ? chrome.tabs.remove(id) : proxy('tabsRemove', { id }));
export const tabsGet = (id) => (hasDirect() ? chrome.tabs.get(id) : proxy('tabsGet', { id }));
export const tabsQuery = (query) => (hasDirect() ? chrome.tabs.query(query) : proxy('tabsQuery', { query }));

// The kill switch's record of open quiz-review tabs (background.js reads this
// on Alt+Shift+K / extension-off, whichever context started them).
export const reviewTabsSet = (ids) => (hasDirect()
  ? chrome.storage.session.set({ reviewTabs: ids }) : proxy('reviewTabsSet', { ids }));

// fetch() run inside a Schoology tab (SchoologyClient's "tab mode" fallback,
// used when the extension's own fetch doesn't carry the login cookie).
export async function tabFetch(tabId, url, redirect, headers) {
  if (hasDirect()) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (u, redir, hdrs) => {
        const r = await fetch(u, { credentials: 'include', redirect: redir, headers: hdrs });
        if (r.type === 'opaqueredirect') return { status: 0, url: u, text: '', redirected: true };
        return { status: r.status, url: r.url, text: await r.text() };
      },
      args: [url, redirect, headers],
    });
    return res?.result ?? null;
  }
  return proxy('tabFetch', { tabId, url, redirect, headers });
}

// VIEW ONLY: clicks only a link whose whole text is exactly "View" in the
// Previous Attempts table, the Nth one — never Start/Resume/Continue/Submit.
export async function tabClickView(tabId, index) {
  if (hasDirect()) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: clickViewLinkFn, args: [index] });
    return res?.result ?? null;
  }
  return proxy('tabClickView', { tabId, index });
}

export async function tabReadReview(tabId) {
  if (hasDirect()) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readReviewFn, args: [] });
    return res?.result ?? null;
  }
  return proxy('tabReadReview', { tabId });
}

// Runs inside the quiz page (structured-clone'd by executeScript, so it must
// be self-contained — no closing over anything outside its own args).
function clickViewLinkFn(index) {
  if (!location.host.endsWith('schoology.com')) return { fatal: 'redirected away from Schoology (logged out?)' };
  const links = [...document.querySelectorAll('a')].filter((a) => a.textContent.trim() === 'View');
  if (!links[index]) return { clicked: false };
  const link = links[index];
  if (/start|resume|begin|continue|submit|retake/i.test(link.textContent)) return { fatal: 'refused: not a View link' };
  const row = link.closest('tr, [role="row"]');
  const label = row ? `Attempt ${(row.innerText || '').trim().split(/\s+/)[0]}` : '';
  link.click();
  return { clicked: true, label };
}

// Runs inside the quiz page after "View": each question is an <article>; answers live in inputs.
function readReviewFn() {
  const render = (el) => {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { s += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (t === 'SCRIPT' || t === 'STYLE' || n.getAttribute('aria-hidden') === 'true') continue;
      if (t === 'INPUT') {
        if (n.type === 'radio' || n.type === 'checkbox') s += n.checked ? '[x] ' : '[ ] ';
        else if (n.type !== 'hidden') s += ` [answer: ${n.value || '—'}] `;
        continue;
      }
      if (t === 'TEXTAREA') { s += ` [answer: ${n.value || '—'}] `; continue; }
      if (t === 'SELECT') { s += ` [answer: ${n.options[n.selectedIndex]?.text || '—'}] `; continue; }
      const inner = render(n);
      s += /^(P|DIV|LI|TR|H\d|ARTICLE|SECTION|UL|OL|TABLE)$/.test(t) ? `\n${inner}\n` : inner;
    }
    return s;
  };
  const arts = [...document.querySelectorAll('article')];
  const text = arts.map((a) => render(a)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*(\[answer:[^\]]*\])\s*\n\s*/g, ' $1 ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()).join('\n\n---\n\n');
  const prev = window.__archiverLastLen;
  window.__archiverLastLen = text.length;
  return { count: arts.length, stable: prev === text.length && text.length > 0, text };
}

// The allowlist background.js's 'archiveProxy' handler dispatches through —
// exactly the ops the functions above ever send, nothing else.
export const PROXY_OPS = {
  storageGet: (a) => storageGet(a.key),
  storageSet: (a) => storageSet(a.obj),
  downloadsUi: (a) => downloadsSetUiEnabled(a.enabled),
  downloadsSearch: (a) => downloadsSearch(a.query),
  downloadsCancel: (a) => downloadsCancel(a.id),
  downloadsRemoveFile: (a) => downloadsRemoveFile(a.id),
  downloadsStart: (a) => downloadsStart(a.options),
  tabsCreate: (a) => tabsCreate(a.opts),
  tabsRemove: (a) => tabsRemove(a.id),
  tabsGet: (a) => tabsGet(a.id),
  tabsQuery: (a) => tabsQuery(a.query),
  reviewTabsSet: (a) => reviewTabsSet(a.ids),
  tabFetch: (a) => tabFetch(a.tabId, a.url, a.redirect, a.headers),
  tabClickView: (a) => tabClickView(a.tabId, a.index),
  tabReadReview: (a) => tabReadReview(a.tabId),
};

// Waits (by polling — simplest thing that works proxied or not; downloads
// aren't latency-sensitive) until a download this run started finishes.
export async function downloadsWaitDone(id, signal, timeoutMs = 10 * 60 * 1000) {
  const { throwIfStopped, sleep } = await import('../../util.js');
  const until = Date.now() + timeoutMs;
  for (;;) {
    throwIfStopped(signal);
    const [it] = await downloadsSearch({ id });
    if (it?.state === 'complete') return it;
    if (it?.state === 'interrupted') throw new Error(`download failed (${it.error || 'interrupted'})`);
    if (Date.now() > until) throw new Error('download timed out');
    await sleep(400, signal);
  }
}

// Waits (by polling) until a tab finishes loading.
export async function tabsWaitLoaded(tabId, signal, timeoutMs = 45_000) {
  const { throwIfStopped, sleep } = await import('../../util.js');
  const until = Date.now() + timeoutMs;
  for (;;) {
    throwIfStopped(signal);
    const t = await tabsGet(tabId).catch(() => null);
    if (t?.status === 'complete') return;
    if (Date.now() > until) throw new Error('page load timed out');
    await sleep(300, signal);
  }
}
