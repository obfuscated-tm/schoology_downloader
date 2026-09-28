// A course's Materials page and its folders (docs/OVERLAY-UI.md §2). Schoology's
// table stays as it is; this adds, each in a shadow root of its own:
//   above the table  a strip: "Only open work", "N open in this course", and
//                    "Archive saved <when> · Sync now" (the archiver, in the
//                    side panel, for this course)
//   folder rows      on the right, "1 missing · 1 to turn in · 1 to do" (or
//                    "All turned in") and the folder's scored % (points earned
//                    / points graded in it, subfolders included)
//   assignment rows  on the right, one marker (overlays/matstate.js says which)
// Folders keep opening the Schoology way. "Only open work" hides the other
// rows (the one change made to Schoology's own nodes: display, put back when
// it's unticked or the Overlay is off).
//
// What it reads, all GET, same origin, one at a time:
//   /course/{id}/student_grades            the scores
//   /course/{id}/materials?f={folder}      every folder of the course, from
//                                          the root, for the totals and counts
// both cached (overlays/coursedata.js), so moving between folders doesn't
// read the course again. neo-plan's items come in one batched request.

import { materialRowsIn, folderRowsIn, materialTableRows } from '../reader/parse/sync.js';
import { np, createHost, el, onClick, debounce, failText, onOverlay, isOverlayOn, keepEvents } from './ui.js';
import { rowState, OPEN, folderTotals, summaryParts, pctText, ago } from './matstate.js';
import { openCourse, chromeStore, fetchDoc, ROOT } from './coursedata.js';
import { MARK_CSS, markerFor } from './marker.js';

const ONLY_OPEN_KEY = 'materialsOnlyOpen';

const STRIP_CSS = `
:host { display: block; margin: 0 0 8px; }
.strip {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px;
  padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--sunk); color: var(--dim);
}
label { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); cursor: pointer; }
input { accent-color: var(--accent); margin: 0; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.sp { margin-left: auto; }
.linkbtn { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
@media (max-width: 760px) { .sp { margin-left: 0; } }
`;

// Floated right inside the row's title line, so it sits beside the title
// without moving anything of Schoology's. The title block runs to the edge
// of Schoology's cell, in a folder opened in place too, so every marker ends
// at the same right edge. --line-h (the title's line height) is set on the
// host from the page.
const RIGHT_CSS = MARK_CSS + `
:host {
  float: right; margin-left: 12px; white-space: nowrap; font-size: 12px; color: var(--dim);
}
.right { display: inline-flex; align-items: center; gap: 10px; height: var(--line-h, 18px); line-height: 18px; }
.pct { color: var(--faint); min-width: 52px; text-align: right; }
`;

export async function start({
  doc = document, loc = location, call = np, getDoc = fetchDoc, store = chromeStore(),
  now = () => Date.now(),
} = {}) {
  const section = (loc.pathname.match(/^\/course\/(\d+)/) || [])[1];
  if (!section) return null;
  const here = new URLSearchParams(loc.search || '').get('f') || ROOT;
  const archiveKey = `course:${loc.host}:${section}`;

  const course = await openCourse({ section, origin: loc.origin, store, getDoc, now, onChange: () => drawSoon() });
  const tree = course.tree; // fid → { at, a, f, i }
  const known = new Map(); // schoology_id → Item | null
  const errors = new Map();
  const busy = new Set();
  let itemsFailed = false; // neo-plan can't answer (no token, or not reachable)
  let walking = true;
  let onlyOpen = (await store.get(ONLY_OPEN_KEY)) === true;
  let archive = await store.get(archiveKey);
  let syncNote = '';

  const gradeOf = course.gradeOf;
  const stateOf = (id) => rowState(gradeOf(id), itemsFailed ? undefined : known.get(id));
  const rowsById = new Map(); // id → row from the live page (for adding)

  // ── The strip ──
  let strip = null;
  const box = el('div', 'strip');
  const check = el('input');
  check.type = 'checkbox';
  const onlyLabel = el('label');
  onlyLabel.append(check, document.createTextNode(' Only open work'));
  const count = el('span');
  const arch = el('span', 'sp');
  box.append(onlyLabel, count, arch);
  check.addEventListener('change', () => {
    onlyOpen = check.checked;
    store.set(ONLY_OPEN_KEY, onlyOpen);
    applyFilter();
    drawStrip();
  });

  function drawStrip() {
    const t = tree[ROOT] ? folderTotals(tree, ROOT, stateOf, gradeOf) : null;
    const ready = !itemsFailed && !walking && !!t?.known;
    onlyLabel.hidden = itemsFailed;
    check.checked = onlyOpen;
    count.replaceChildren();
    if (ready && t) {
      if (t.open) count.append(el('span', 'num', String(t.open)), document.createTextNode(' open in this course'));
      else count.textContent = 'Nothing open in this course';
      if (t.open && hiddenAll) count.append(document.createTextNode(' · none in this folder'));
    } else if (!itemsFailed) {
      count.textContent = 'Reading the course…';
    }

    const last = archive?.runs?.at?.(-1)?.at;
    const syncBtn = el('button', 'linkbtn', last ? 'Sync now' : 'Archive now');
    syncBtn.title = 'Archive this course again (only new or changed things are saved)';
    onClick(syncBtn, syncNow);
    arch.replaceChildren(
      document.createTextNode(last ? `Archive saved ${ago(last, now())}` : 'Not archived yet'),
      document.createTextNode(' · '),
      syncNote ? el('span', null, syncNote) : syncBtn,
    );
  }

  async function syncNow() {
    syncNote = 'Opening the archiver…';
    drawStrip();
    try {
      const { start: startCard } = await import('./archive.js');
      const cardApi = startCard({ loc });
      await cardApi.open();
      await cardApi.startNow();
      syncNote = '';
    } catch {
      syncNote = 'Reload the extension, then this page';
    }
    drawStrip();
  }

  store.watch?.((ch) => {
    if (!(archiveKey in ch)) return;
    archive = ch[archiveKey].newValue;
    syncNote = '';
    drawStrip();
  });

  // ── Rows ──
  const hosts = new Map(); // tr → { host, root, kind, id }
  function markFor(row, kind, id) {
    const had = hosts.get(row.tr);
    if (had && had.host.isConnected) return had;
    const { host, root } = createHost('np-mat-mark', RIGHT_CSS);
    keepEvents(host);
    const title = row.el.querySelector('a') || row.el;
    host.style.setProperty('--line-h', getComputedStyle(title).lineHeight);
    row.el.insertBefore(host, row.el.firstChild);
    const h = { host, root, kind, id };
    hosts.set(row.tr, h);
    return h;
  }
  const put = (root, ...kids) => {
    const box = el('span', 'right');
    box.append(...kids.filter(Boolean));
    root.replaceChildren(root.firstChild, box);
  };

  function drawMark(h) {
    const id = h.id;
    const it = known.get(id);
    const { kids, label } = markerFor(stateOf(id), {
      item: it,
      rowDue: rowsById.get(id)?.due,
      busy: busy.has(id),
      onAdd: () => add(id),
      onRestore: () => change(id, () => call('restore', { id: it?.id })),
      onToggle: () => toggle(id),
    });
    const err = errors.get(id);
    if (err) kids.push(el('span', 'bad', err));
    h.host.title = label;
    if (label) h.host.setAttribute('aria-label', label); else h.host.removeAttribute('aria-label');
    put(h.root, ...kids);
  }

  function drawFolder(h) {
    const t = folderTotals(tree, h.id, stateOf, gradeOf);
    const sum = el('span');
    const parts = itemsFailed ? [] : summaryParts(t);
    parts.forEach((p, i) => {
      if (i) sum.append(document.createTextNode(' · '));
      sum.append(p.bad ? el('span', 'bad', p.text) : document.createTextNode(p.text));
    });
    const pct = el('span', 'num pct', pctText(t.pct));
    pct.title = 'Points earned out of points graded in this folder';
    put(h.root, parts.length ? sum : null, pct);
  }

  let hiddenAll = false; // "Only open work" left no row of this folder
  const hiddenByUs = new Map(); // tr → its display before
  function applyFilter() {
    const on = onlyOpen && isOverlayOn() && !itemsFailed;
    let shown = 0;
    for (const { tr, kind, id } of materialTableRows(doc)) {
      let keep = true;
      if (on && kind === 'folder') {
        // A folder not read yet, or with rows neo-plan hasn't answered for, stays.
        const t = id ? folderTotals(tree, id, stateOf, gradeOf) : null;
        keep = !t || t.open > 0 || !t.known;
      } else if (on && kind === 'assignment') {
        const k = stateOf(id).kind;
        keep = OPEN.has(k) || k === 'unknown';
      } else if (on) {
        keep = false;
      }
      if (keep) {
        shown++;
        if (hiddenByUs.has(tr)) { tr.style.display = hiddenByUs.get(tr); hiddenByUs.delete(tr); }
      } else if (!hiddenByUs.has(tr)) {
        hiddenByUs.set(tr, tr.style.display);
        tr.style.display = 'none';
      }
    }
    hiddenAll = on && shown === 0;
  }

  // A folder opened in place sits inside its row's cell, so its rows' titles
  // end short of the others: their markers move out to the same edge.
  function alignNested() {
    const table = doc.querySelector('table#folder-contents-table');
    const top = [...hosts].find(([tr, h]) => h.host.isConnected && tr.closest('table') === table);
    if (!top) return;
    const edge = top[1].host.parentNode.getBoundingClientRect().right;
    for (const [tr, h] of hosts) {
      if (!h.host.isConnected || tr.closest('table') === table) continue;
      const short = edge - h.host.parentNode.getBoundingClientRect().right;
      h.host.style.marginRight = short > 0 ? `${-Math.round(short)}px` : '';
    }
  }

  function drawAll() {
    clearFilter();
    alignNested();
    for (const h of hosts.values()) {
      if (!h.host.isConnected) continue;
      if (h.kind === 'folder') drawFolder(h); else drawMark(h);
    }
    applyFilter();
    drawStrip();
  }
  const drawSoon = debounce(drawAll, 50);

  // ── Changes to neo-plan ──
  async function change(id, run) {
    if (busy.has(id)) return;
    busy.add(id);
    errors.delete(id);
    drawAll();
    const r = await run();
    busy.delete(id);
    if (r.ok && r.data) known.set(id, r.data);
    else errors.set(id, failText(r));
    drawAll();
  }
  function add(id) {
    const row = rowsById.get(id) || {};
    return change(id, () => call('addItem', {
      item: {
        schoology_id: id,
        section_id: section,
        realm: null,
        title: row.title || '',
        due_at: row.due || null,
        source_url: `${loc.origin}/assignment/${id}`,
      },
    }));
  }

  // Studied / done, or back: shown at once, put back if neo-plan refuses.
  function toggle(id) {
    const it = known.get(id);
    if (!it || busy.has(id)) return;
    const work = it.work === 'ready' ? 'todo' : 'ready';
    known.set(id, { ...it, work });
    return change(id, async () => {
      const r = await call('work', { id: it.id, work });
      if (!r.ok) known.set(id, it);
      return r;
    });
  }

  // ── Reading ──
  const asked = new Set();
  async function ask(ids) {
    const want = [...new Set(ids)].filter((id) => !known.has(id) && !asked.has(id));
    if (!want.length || itemsFailed) return;
    for (const id of want) asked.add(id);
    for (let i = 0; i < want.length; i += 100) {
      const batch = want.slice(i, i + 100);
      const r = await call('items', { schoology_ids: batch });
      if (!r.ok) {
        for (const id of batch) asked.delete(id);
        if (r.status === 401 || r.status === 0) itemsFailed = true; // no token, or no neo-plan: markers stay quiet
        drawAll();
        return;
      }
      const got = new Map((r.data?.items || []).map((it) => [String(it.source_id), it]));
      for (const id of batch) known.set(id, got.get(id) || null);
      drawAll();
    }
  }

  // Schoology's "All Materials" menu is placed absolutely and hangs below its
  // bar, over whatever comes first: the strip moves down clear of it.
  function clearFilter() {
    const menu = doc.querySelector('.materials-filter-wrapper');
    // Measured only while both show (the strip is hidden until the Overlay setting is read).
    if (!strip || !menu || !menu.getClientRects().length || !strip.host.getClientRects().length) return;
    // Padding, not margin: a margin would collapse into the one above it.
    strip.host.style.paddingTop = '';
    const over = menu.getBoundingClientRect().bottom - strip.host.getBoundingClientRect().top;
    if (over > -8) strip.host.style.paddingTop = `${Math.ceil(over) + 8}px`;
  }
  try { window.addEventListener('resize', debounce(() => { clearFilter(); alignNested(); }, 100)); } catch { /* tests */ }

  function scan() {
    if (!doc.querySelector('table#folder-contents-table')) return false;
    const table = doc.querySelector('table#folder-contents-table');
    if (!strip || !strip.host.isConnected) {
      strip = createHost('np-materials-strip', STRIP_CSS);
      keepEvents(strip.host);
      strip.root.append(box);
      table.parentNode.insertBefore(strip.host, table);
    }
    clearFilter();
    course.sawFolder(here, doc, loc.href);
    for (const r of materialRowsIn(doc, loc.href, { nested: true })) {
      rowsById.set(r.schoology_id, r);
      markFor(r, 'assignment', r.schoology_id);
    }
    for (const r of folderRowsIn(doc, { nested: true })) markFor(r, 'folder', r.folder_id);
    drawAll();
    return true;
  }

  const onChange = debounce(scan, 300);
  const observer = new MutationObserver((records) => {
    const ours = (n) => n.nodeType === 1 && /^np-/.test(n.localName);
    if (records.every((rec) => [...rec.addedNodes].every(ours) && [...rec.removedNodes].every(ours))) return;
    onChange();
  });
  onOverlay(() => { applyFilter(); drawStrip(); clearFilter(); });

  if (!scan()) {
    // The table can arrive after the page: wait for it.
    await new Promise((resolve) => {
      const wait = new MutationObserver(() => { if (doc.querySelector('table#folder-contents-table')) { wait.disconnect(); resolve(); } });
      wait.observe(doc.body, { childList: true, subtree: true });
    });
    scan();
  }
  observer.observe(doc.body, { childList: true, subtree: true });

  const ready = (async () => {
    await ask(tree[here].a.map((a) => a.id));
    await course.readGrades();
    await course.walk();
    walking = false;
    await ask(Object.values(tree).flatMap((f) => f.a.map((a) => a.id)));
    drawAll();
    await course.saveCache();
  })();

  return { ready, tree, known, get grades() { return course.grades; }, hosts, strip: () => strip, scan, stop: () => observer.disconnect() };
}
