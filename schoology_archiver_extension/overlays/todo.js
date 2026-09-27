// The right-hand column of the Schoology home page: our own To Do list,
// grouped by class, in place of Schoology's own flat OVERDUE / UPCOMING
// lists. Schoology's own To Do block (`#todo.todo-wrapper`, inside
// `#right-column`; Calendar and Recently Completed below it stay) is hidden with an inline style while our host shows the
// same information grouped and sorted the way Owen actually scans it; the
// Overlay switch, and any load/fetch failure, put it straight back.
//
// Selectors checked against fuhsd.schoology.com (Sep 2026): the dashboard's
// cards are `li.sgy-grid-layout__item` in a jQuery-sortable `ul.sgy-sortable`,
// each keyed `data-key=".$<section id>"`; test/home-page.html mirrors them.
//
// Data: /v2/events/overdue and /v2/events/upcoming (reader/parse/sync.js's
// parseEventsJson), all pages of each (nextEventsUrl follows `@links.next`).
// Grouping: by the Course Dashboard's cards, in their on-screen order (a
// class is any card whose name matches /^.+ - \d{3,5}:/ — a course code
// before the colon). The order survives to other tabs via chrome.storage.local
// (last-seen order), and re-sorts live if the cards are on screen and get
// dragged. A class with nothing due still gets a header ("Nothing due"); a
// non-class card (a hub, an advisory) only shows up if something in it is due.
// Items matching no card land in "Other" at the bottom.
//
// Marks: our rows are real elements in our own shadow root, so
// overlays/marks.js's markers are drawn straight into them (its own
// MutationObserver watches document.body, which can't see inside a shadow
// root, so we call marks.scan() ourselves after every render).

import { parseEventsJson, nextEventsUrl } from '../reader/parse/sync.js';
import { createHost, el, keepEvents, onOverlay, isOverlayOn, debounce } from './ui.js';
import { limitedFetch } from '../reader/ratelimit.js';
import {
  calendarDays, formatDue, formatOverdue, annotateItems, sortDueItems,
  ROW_CSS, tagFor, buildRow,
} from './todorows.js';

// Re-exported: test/todo.test.js imports these from here.
export { formatDue, formatOverdue, tagFor };

export const TODO_LISTS = ['overdue', 'upcoming'];
const REREAD_MS = 180_000; // Schoology's own response says `@cache.max_age: 180` for these lists
const CAP = 5;
// async: in a tab left open across an extension reload, chrome.storage throws
// "Extension context invalidated" synchronously; this turns it into a rejection
// the callers already catch. Shared with overlays/coursetodo.js.
export const defaultStore = {
  get: async (k) => (await chrome.storage.local.get(k))?.[k],
  set: async (k, v) => chrome.storage.local.set({ [k]: v }),
};
const MAX_PAGES = 20; // a runaway @links.next loop should never hang the tab

// ── Fetching (paginated; reused by home.js for the /home/assignments list) ──

/** One list, every page of it, as parseEventsJson rows. */
export async function fetchEvents(list, { fetchImpl = limitedFetch } = {}) {
  const out = [];
  let url = `/v2/events/${list}`;
  const seen = new Set();
  for (let page = 0; url && page < MAX_PAGES && !seen.has(url); page++) {
    seen.add(url);
    const r = await fetchImpl(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    out.push(...parseEventsJson(text));
    url = nextEventsUrl(text);
  }
  return out;
}

// ── Events cache: last good lists, shown instantly while a fresh read runs ──

export const EVENTS_CACHE_KEY = 'todoEventsCache'; // coursetodo.js shares this cache (same two lists for the whole account)
const EVENTS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // older than this, don't trust it at all

/**
 * Whether a `{ at, overdue, upcoming, host }` cache (as stored under
 * EVENTS_CACHE_KEY) is fresh enough to render immediately: the right host
 * (never another school's or another tab's data) and less than 24h old. Pure.
 */
export function cacheIsFresh(cache, host, now = Date.now()) {
  return !!cache && cache.host === host && typeof cache.at === 'number' && now - cache.at < EVENTS_CACHE_MAX_AGE_MS;
}

/** Whether that cache is recent enough to skip the immediate re-fetch entirely. Pure. */
export function cacheSkipsFetch(cache, host, now = Date.now(), rereadMs = REREAD_MS) {
  return cacheIsFresh(cache, host, now) && now - cache.at < rereadMs;
}

// ── Pure helpers (grouping, matching, formatting) ───────────────────────────

/** A course-dashboard card is a class if its name carries a course code before a colon. */
export function isClassCard(name) {
  return /^.+ - \d{3,5}\s*:/.test(String(name || '').trim());
}

/** "Pre-Calculus H - 2420: JaehnigS p1 T1" → "Pre-Calculus H"; "CHS Hub: Gr10" → "CHS Hub". */
export function shortName(name) {
  const left = String(name || '').split(':')[0];
  return left.replace(/\s*-\s*\d{3,5}\s*$/, '').trim();
}

/** The part of a card's name an event's `course` is matched against: everything before the colon. */
export function cardKey(name) {
  return String(name || '').split(':')[0].trim().toLowerCase();
}

/** A small deterministic palette index (1–8) for a class name, for the header dot. */
export function colorIndexOf(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}

/**
 * Group overdue + upcoming events by class, in `cards`' order (the Course
 * Dashboard's cards, [{ name }], top to bottom). A class card is always
 * included (even with nothing due); a non-class card only when it has items;
 * an event matching no card goes in a trailing "Other" group. Within a group:
 * overdue first (oldest due first), then upcoming (soonest first).
 * → [{ key, name, colorIndex, isOther, dueToday, items: [{ ...event, overdue, days? }] }]
 */
export function groupEvents({ overdue = [], upcoming = [], cards = [], now = new Date() } = {}) {
  const byKey = new Map(); // cardKey → group
  const bySection = new Map(); // section id → group
  const order = [];
  for (const c of cards) {
    const name = cardKey(c.name);
    // Two sections of one course share a name, so a section id keys its own group.
    const key = c.section_id ? `s${c.section_id}` : name;
    if (!name || byKey.has(key) || bySection.has(String(c.section_id))) continue;
    const g = { key, name: shortName(c.name), colorIndex: colorIndexOf(shortName(c.name)), isClass: isClassCard(c.name), items: [] };
    if (!byKey.has(name)) byKey.set(name, g);
    byKey.set(key, g);
    if (c.section_id) bySection.set(String(c.section_id), g);
    order.push(g);
  }
  const other = { key: '\u0000other', name: 'Other', colorIndex: 0, isClass: false, isOther: true, items: [] };

  const place = (item) => {
    const g = (item.section_id && bySection.get(String(item.section_id))) || byKey.get(String(item.course || '').trim().toLowerCase());
    (g || other).items.push(item);
  };
  for (const item of annotateItems({ overdue, upcoming, now })) place(item);

  const groups = order.filter((g) => g.isClass || g.items.length).concat(other.items.length ? [other] : []);
  for (const g of groups) {
    g.items = sortDueItems(g.items);
    g.dueToday = g.items.some((it) => it.due && calendarDays(new Date(it.due), now) === 0);
  }
  return groups;
}

/** The first `cap` items, and how many more there are (for the "+N more" button). */
export function visibleItems(items, { expanded = false, cap = CAP } = {}) {
  if (expanded || items.length <= cap) return { shown: items, more: 0 };
  return { shown: items.slice(0, cap), more: items.length - cap };
}

// ── Course Dashboard cards: order, live and cached ──────────────────────────

const CARD_ORDER_KEY = 'todoCardOrder';
// A handful of guesses at the dashboard's own markup; first one that matches wins.
const CARD_CONTAINER_SELECTORS = ['.course-dashboard__inner ul.sgy-sortable', '.course-dashboard ul.sgy-sortable'];
const CARD_SELECTORS = ['li.sgy-grid-layout__item'];
// The title's text is split over several elements for the ellipsis; the
// container's textContent is still the whole name.
const CARD_TITLE_SELECTORS = ['.course-dashboard__card-context-title'];

function firstMatch(root, selectors) {
  for (const sel of selectors) {
    const found = root.querySelectorAll(sel);
    if (found.length) return [...found];
  }
  return [];
}

/** The Course Dashboard's cards on screen, top to bottom: [{ el, name, section_id }]. Empty off that tab. */
export function dashboardCardsIn(doc) {
  let container = null;
  for (const sel of CARD_CONTAINER_SELECTORS) { container = doc.querySelector(sel); if (container) break; }
  const cards = firstMatch(container || doc, CARD_SELECTORS);
  return cards.map((elCard) => {
    let title = null;
    for (const sel of CARD_TITLE_SELECTORS) { title = elCard.querySelector(sel); if (title) break; }
    const name = ((title || elCard).textContent || '').replace(/\s+/g, ' ').trim();
    const section_id = (elCard.getAttribute('data-key') || '').match(/(\d+)$/)?.[1] || null;
    return { el: elCard, name, section_id };
  }).filter((c) => c.name);
}

function cardContainerIn(doc) {
  for (const sel of CARD_CONTAINER_SELECTORS) { const c = doc.querySelector(sel); if (c) return c; }
  return null;
}

// ── Rendering ────────────────────────────────────────────────────────────

// The group/header chrome, on top of todorows.js's shared panel/row CSS.
const CSS = ROW_CSS + `
.group { margin: 0 0 14px; }
.group:last-child { margin-bottom: 0; }
.ghead { display: flex; align-items: center; gap: 8px; padding: 2px 0 6px; border-bottom: 1px solid var(--line); }
.gname { font-weight: 600; }
.gcount { margin-left: auto; color: var(--faint); }
.gtoday { color: var(--bad); background: var(--bad-soft); border-radius: 3px; padding: 1px 6px; font-size: 11px; font-weight: 600; }
`;

function renderGroup(g, expanded) {
  const box = el('div', 'group');
  const head = el('div', 'ghead');
  const dot = el('span', 'dot');
  dot.style.background = g.isOther ? 'var(--class-none)' : `var(--class-${g.colorIndex})`;
  head.append(dot, el('span', 'gname', g.name));
  if (g.dueToday) head.append(el('span', 'gtoday', 'Due today'));
  head.append(el('span', 'gcount', String(g.items.length)));
  box.append(head);
  if (!g.items.length) {
    box.append(el('div', 'nothing', 'Nothing due'));
    return { box, rows: [] };
  }
  const { shown, more } = visibleItems(g.items, { expanded });
  const rows = shown.map(buildRow);
  for (const r of rows) box.append(r.el);
  if (more > 0) {
    const btn = el('button', 'more', `+${more} more`);
    btn.type = 'button';
    box.append(btn);
    return { box, rows, moreBtn: btn };
  }
  return { box, rows };
}

/**
 * Mounts the sidebar on /home (not the /home/assignments list, which keeps
 * its own overlays/marks.js treatment). `getEvents`/`store`/`now`/`doc`/`loc`
 * are overridable for tests and for test/home-page.html.
 */
export function start({
  doc = document, loc = location, getEvents = fetchEvents,
  store = defaultStore,
  now = () => new Date(),
} = {}) {
  const expanded = new Set(); // group key → expanded (memory only)
  let overdue = [], upcoming = [];
  let cardOrder = []; // [{ name, section_id }], last known
  let host = null, root = null;
  let schoologyBlock = null;
  let rows = []; // the live row descriptors, for marks.js
  let marksHost = null; // { scan() }, set by home.js once startMarks exists
  let loaded = false; // a successful fetch happened at least once
  let readAt = 0;
  let reading = null;

  function findSchoologyBlock() {
    if (schoologyBlock?.isConnected) return schoologyBlock;
    schoologyBlock = doc.querySelector('#todo.todo-wrapper, #right-column .todo-wrapper');
    return schoologyBlock;
  }

  function ensureHost() {
    const block = findSchoologyBlock();
    if (!block) return null;
    if (!host || !host.isConnected) {
      const created = createHost('np-todo', CSS);
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
    const groups = groupEvents({ overdue, upcoming, cards: cardOrder, now: now() });
    const frag = el('div', 'panel'); // a light panel, for contrast with Schoology's white column
    frag.append(el('div', 'todo-h', 'To Do')); // Schoology's own heading is in the block we hide
    rows = [];
    for (const g of groups) {
      const { box, rows: groupRows, moreBtn } = renderGroup(g, expanded.has(g.key));
      rows.push(...groupRows);
      if (moreBtn) moreBtn.addEventListener('click', () => { expanded.add(g.key); render(); });
      frag.append(box);
    }
    if (!groups.length) frag.append(el('div', 'nothing', 'Nothing due'));
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

  // ── Course-dashboard order: live when the cards are here, cached otherwise ──
  function readCardsFromDom() {
    const cards = dashboardCardsIn(doc);
    if (!cards.length) return false;
    cardOrder = cards.map((c) => ({ name: c.name, section_id: c.section_id }));
    store.set(CARD_ORDER_KEY, cardOrder).catch?.(() => {});
    return true;
  }

  async function loadCardOrder() {
    if (readCardsFromDom()) return;
    try {
      const cached = await store.get(CARD_ORDER_KEY);
      if (Array.isArray(cached) && cached.length) cardOrder = cached;
    } catch { /* fall back to alphabetical (an empty order sorts everything into Other) */ }
  }

  const onCardsChange = debounce(() => { if (readCardsFromDom()) render(); }, 200);
  const cardObserver = new MutationObserver(onCardsChange);
  let watched = null;
  function watchCards() {
    const container = cardContainerIn(doc);
    if (!container || container === watched) return;
    cardObserver.disconnect();
    watched = container;
    cardObserver.observe(container, { childList: true, subtree: false });
    onCardsChange(); // the dashboard tab just (re)drew its cards
  }

  // ── Keep the sidebar in place through Schoology's own re-renders ──────────
  const rescan = debounce(() => {
    if (!findSchoologyBlock()) return;
    ensureHost();
    applyHiding();
    watchCards();
  }, 200);
  const bodyObserver = new MutationObserver((records) => {
    if (records.every((rec) => [...rec.addedNodes, ...rec.removedNodes].every((n) => n.nodeType !== 1 || n.localName === 'np-todo'))) return;
    rescan();
  });

  onOverlay(() => { applyHiding(); ensureHost(); });

  async function refresh() { await loadCardOrder(); await read(); }

  bodyObserver.observe(doc.body, { childList: true, subtree: true });
  watchCards();
  const ready = (async () => { await loadEventsCache(); await refresh(); })();
  try {
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') refresh(); });
  } catch { /* tests without a real document */ }

  return {
    ready,
    refresh,
    rowsIn: () => rows,
    active: () => loaded && !!findSchoologyBlock(),
    setMarks: (m) => { marksHost = m; },
    stop: () => { bodyObserver.disconnect(); cardObserver.disconnect(); },
  };
}
