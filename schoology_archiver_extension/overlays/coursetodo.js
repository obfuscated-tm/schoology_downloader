// A single course's own "To Do" panel, in place of that course's own
// Upcoming column: Schoology's `div#course-events.upcoming-events-wrapper`
// (inside `#right-column-inner` / `#right-column`, headed by
// `h3#event-selector` "Upcoming") is hidden with an inline style while our
// host shows just this course's overdue + upcoming items, oldest-overdue
// first then soonest-upcoming, flat (no class grouping — there's only one
// class here — and no "+N more" cap). The Overlay switch, and any load/fetch
// failure, put Schoology's own block straight back. This mirrors
// overlays/todo.js's lifecycle closely enough that it shares its events
// fetch, its events cache (same two account-wide lists), and the row/panel
// look and pure helpers of overlays/todorows.js.
//
// The course's section id comes from the URL (`/course/(\d+)`) and is
// matched against each event's own `section_id`.
//
// Marks: our rows are real elements in our own shadow root, so
// overlays/marks.js's markers are drawn straight into them (its own
// MutationObserver watches document.body, which can't see inside a shadow
// root, so we call marks.scan() ourselves after every render).

import { createHost, el, keepEvents, onOverlay, isOverlayOn, debounce } from './ui.js';
import { ROW_CSS, buildRow, annotateItems, sortDueItems } from './todorows.js';
import {
  fetchEvents, TODO_LISTS, EVENTS_CACHE_KEY, cacheIsFresh, cacheSkipsFetch, defaultStore,
} from './todo.js';

const REREAD_MS = 180_000; // Schoology's own response says `@cache.max_age: 180` for these lists

/**
 * This course's overdue + upcoming items, oldest-overdue-first then
 * soonest-upcoming-first. Pure — the filter/sort helper coursetodo.test.js
 * covers directly.
 */
export function courseItems({ overdue = [], upcoming = [], sectionId, now = new Date() } = {}) {
  if (!sectionId) return [];
  const mine = annotateItems({ overdue, upcoming, now }).filter((e) => String(e.section_id) === String(sectionId));
  return sortDueItems(mine);
}

const CSS = ROW_CSS;

/**
 * Mounts the panel on a course's pages. `getEvents`/`store`/`now`/`doc`/`loc`
 * are overridable for tests and for test/course-page.html.
 */
export function start({
  doc = document, loc = location, getEvents = fetchEvents, store = defaultStore, now = () => new Date(),
} = {}) {
  const section = (loc.pathname.match(/^\/course\/(\d+)/) || [])[1] || null;
  let overdue = [], upcoming = [];
  let host = null, root = null;
  let schoologyBlock = null;
  let rows = []; // the live row descriptors, for marks.js
  let marksHost = null; // { scan() }, set by course.js once startMarks exists
  let loaded = false; // a successful fetch happened at least once
  let readAt = 0;
  let reading = null;

  function findSchoologyBlock() {
    if (schoologyBlock?.isConnected) return schoologyBlock;
    schoologyBlock = doc.querySelector('#course-events');
    return schoologyBlock;
  }

  function ensureHost() {
    const block = findSchoologyBlock();
    if (!block) return null;
    if (!host || !host.isConnected) {
      const created = createHost('np-coursetodo', CSS);
      host = created.host;
      root = created.root;
      keepEvents(host);
    }
    if (host.nextSibling !== block) block.before(host);
    return host;
  }

  function applyHiding() {
    const block = findSchoologyBlock();
    if (!block) return;
    const wantHidden = loaded && isOverlayOn();
    const isHidden = block.style.display === 'none';
    if (wantHidden !== isHidden) block.style.display = wantHidden ? 'none' : '';
  }

  function render() {
    if (!root) return;
    if (!loaded) { root.replaceChildren(root.firstChild); rows = []; return; }
    const items = courseItems({ overdue, upcoming, sectionId: section, now: now() });
    const frag = el('div', 'panel'); // a light panel, for contrast with Schoology's white column
    frag.append(el('div', 'todo-h', 'To Do')); // Schoology's own heading is in the block we hide
    rows = items.map(buildRow);
    for (const r of rows) frag.append(r.el);
    if (!items.length) frag.append(el('div', 'nothing', 'Nothing due'));
    root.replaceChildren(root.firstChild, frag);
    applyHiding();
    marksHost?.scan?.();
  }

  function renderError() {
    loaded = false;
    if (root) root.replaceChildren(root.firstChild, el('div', 'err', 'Couldn’t load the To Do list here — showing Schoology’s own.'));
    applyHiding();
  }

  async function read() {
    if (!section) return; // no course section on the URL: leave Schoology's own block alone
    if (reading || Date.now() - readAt < REREAD_MS) return reading;
    readAt = Date.now();
    reading = (async () => {
      try {
        const [o, u] = await Promise.all(TODO_LISTS.map(getEvents));
        overdue = o; upcoming = u; loaded = true;
        ensureHost();
        render();
        store.set(EVENTS_CACHE_KEY, { at: Date.now(), overdue, upcoming, host: loc.host }).catch?.(() => {});
      } catch {
        // A RateLimitError or any other failure: with a cache (or an earlier
        // successful read) already on screen, keep showing it rather than
        // falling back to Schoology's own block. Never cache a failure.
        if (!loaded) renderError();
      }
    })().finally(() => { reading = null; });
    return reading;
  }

  /** The last good lists, shown before the first fetch of this page load resolves. */
  async function loadEventsCache() {
    if (!section) return;
    let cache;
    try { cache = await store.get(EVENTS_CACHE_KEY); } catch { return; }
    if (!cacheIsFresh(cache, loc.host)) return;
    overdue = cache.overdue; upcoming = cache.upcoming; loaded = true;
    ensureHost();
    render();
    // Cache still within REREAD_MS of its own age: the read a moment from now
    // would just refetch the same window, so start the clock from the cache's
    // own age instead of from now.
    if (cacheSkipsFetch(cache, loc.host)) readAt = cache.at;
  }

  // ── Keep the panel in place through Schoology's own re-renders ───────────
  const rescan = debounce(() => {
    if (!findSchoologyBlock()) return;
    ensureHost();
    applyHiding();
  }, 200);
  const bodyObserver = new MutationObserver((records) => {
    if (records.every((rec) => [...rec.addedNodes, ...rec.removedNodes].every((n) => n.nodeType !== 1 || n.localName === 'np-coursetodo'))) return;
    rescan();
  });

  onOverlay(() => { applyHiding(); ensureHost(); });

  bodyObserver.observe(doc.body, { childList: true, subtree: true });
  const ready = (async () => { await loadEventsCache(); await read(); })();
  try {
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') read(); });
  } catch { /* tests without a real document */ }

  return {
    ready,
    refresh: read,
    rowsIn: () => rows,
    active: () => loaded && !!findSchoologyBlock(),
    setMarks: (m) => { marksHost = m; },
    stop: () => { bodyObserver.disconnect(); },
  };
}
