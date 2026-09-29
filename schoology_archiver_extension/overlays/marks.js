// Row markers for the Upcoming / To Do columns, on /home and on a course's
// pages, and for the list on /home/assignments: the same one marker the Materials page gives an assignment
// (overlays/marker.js, docs/OVERLAY-UI.md §2), on the title's line at the
// right of the row:
//   Submitted / Turned in / Finished     Missing pill + ○
//   ● Done, not submitted                ○ (not done; the row shows the due)
//   + Add to neo-plan                    Removed · Add back
// Nothing from the gradebook here (these lists span courses), and no due date:
// Schoology's row already shows it.
// One batched items request for the rows on screen; rows Schoology loads
// later are picked up by a MutationObserver. Each marker is our own element in
// its own shadow root, placed inside the row; Schoology's nodes and their
// attributes are never changed.

import { np, createHost, el, debounce, failText, keepEvents } from './ui.js';
import { rowState } from './matstate.js';
import { MARK_CSS, markerFor } from './marker.js';

// /home's rows are flex rows (title block, then Schoology's status icon), as
// is the title cell of a /home/assignments row: the marker is the last item. A course page's rows are plain blocks: the marker
// floats right inside the row's content. Either way it's lined up with the
// title's first line (--line-h and margin-top, measured from the page).
const CSS = MARK_CSS + `
:host { font-size: 12px; line-height: 18px; color: var(--dim); white-space: nowrap; }
.right { display: inline-flex; align-items: center; gap: 8px; height: var(--line-h, 18px); }
/* todo.js's own rows: the buttons, stacked, in the row's right-hand column;
   the state's words on a line of their own under the due date. */
:host([data-line]) { display: block; }
:host([data-line]) .right { display: flex; flex-direction: column; align-items: stretch; gap: 4px; height: auto; }
:host([data-status]) { display: block; white-space: normal; }
:host([data-status]) .right { display: flex; flex-wrap: wrap; gap: 4px 8px; height: auto; }
`;
const TAG = 'np-mark';

/**
 * rowsIn(doc) → [{ el, schoology_id, title, due?, realm?, section_id?, titleEl?,
 * graded?, markSlot?, onState? }]. `el` is the row the marker goes in; `titleEl`,
 * when the title isn't a link to the assignment, what to line it up with.
 * `turnIn`, when true (the To Do sidebars' rows), adds buttons: Done / Not
 * done, Turn in on an open assignment, and its Undo (marker.js's `actions`),
 * stacked in `markSlot`, with the state's words in `statusSlot`.
 * `markSlot`, when given (todo.js's own grid rows), is where the marker host
 * is placed instead — inline, with none of the float/flex placement or the
 * align() nudging other pages need. `onState(state, item)`, when given, is
 * called every time a row is drawn, with rowState()'s result and the known
 * Item (or null: not in neo-plan; undefined: not known yet) — todo.js uses it
 * to keep its own type tag in step.
 */
export function startMarks({ rowsIn, doc = document, loc = location, call = np }) {
  const known = new Map(); // schoology_id → Item | null (null: not in neo-plan)
  const marks = new Map(); // schoology_id → [{ row, host, root, busy }]
  const errors = new Map(); // schoology_id → text of the last failed change
  const asked = new Set();
  const ours = new WeakSet(); // the markers made here, not copies of them
  let failed = false;

  /** The row's title (its own, or its assignment link), whose first line the marker lines up with. */
  const titleOf = (row) => row.titleEl || [...row.el.querySelectorAll('a[href]')].find((a) => /\/assignment\/\d+/.test(a.getAttribute('href'))) || null;

  function align(m) {
    if (m.row.markSlot) return; // todo.js's grid rows line the marker up themselves
    const a = titleOf(m.row);
    const line = a?.getClientRects()[0];
    if (!line || !m.host.getClientRects().length) return;
    m.host.style.setProperty('--line-h', `${Math.round(line.height)}px`);
    m.host.style.marginTop = '';
    const off = line.top - m.host.getBoundingClientRect().top;
    if (Math.abs(off) >= 1) m.host.style.marginTop = `${Math.round(off)}px`;
  }

  function drawMark(m) {
    const row = m.row;
    const it = known.get(row.schoology_id);
    // A graded row shows its grade itself: nothing to add (not "Not studied").
    const s = row.graded ? { kind: 'unknown' } : rowState(undefined, it);
    // item and rowDue left out: no due date after the circle (the row has it).
    // neo-plan turns in assignments only (anything else is a 409).
    const canTurnIn = row.turnIn && it?.type === 'assignment';
    const { kids, label, status } = markerFor(s, {
      busy: m.busy,
      onAdd: () => add(row),
      onRestore: () => restore(row),
      onToggle: () => toggle(row),
      actions: !!row.turnIn, // the sidebars: status words, plus buttons of their own
      onTurnIn: canTurnIn ? () => turnIn(row) : undefined,
      onPutBack: row.turnIn ? () => putBack(row) : undefined,
    });
    const err = errors.get(row.schoology_id);
    // The sidebars' rows: the state's words in their own slot (under the due
    // date), the buttons in this host (the row's right-hand column).
    const words = m.statusRoot ? [...(status || [])] : kids;
    if (err) words.push(el('span', 'bad', err));
    if (m.statusRoot) {
      m.statusHost.hidden = !words.length;
      const line = el('span', 'right');
      line.append(...words);
      m.statusRoot.replaceChildren(m.statusRoot.firstChild, line);
    }
    m.host.hidden = !kids.length;
    m.host.title = label;
    if (label) m.host.setAttribute('aria-label', label); else m.host.removeAttribute('aria-label');
    const box = el('span', 'right');
    box.append(...kids);
    m.root.replaceChildren(m.root.firstChild, box); // keep the <style>
    align(m);
    row.onState?.(s, it); // todo.js's rotated type tag follows the same state/item
  }

  function drawAll() {
    for (const list of marks.values()) for (const x of list) if (x.host.isConnected) drawMark(x);
  }

  // One change to one row's item, with every marker for it busy meanwhile.
  async function change(row, run) {
    const list = marks.get(row.schoology_id) || [];
    if (list.some((x) => x.busy)) return;
    for (const x of list) x.busy = true;
    errors.delete(row.schoology_id);
    drawAll();
    const r = await run();
    for (const x of list) x.busy = false;
    if (r.ok && r.data) known.set(row.schoology_id, r.data);
    else errors.set(row.schoology_id, failText(r));
    drawAll();
  }

  const add = (row) => change(row, () => call('addItem', {
    item: {
      schoology_id: row.schoology_id,
      section_id: row.section_id || null,
      realm: row.realm || null, // the service worker turns it into a section
      title: row.title,
      due_at: row.due || null,
      source_url: `${loc.origin}/assignment/${row.schoology_id}`,
    },
  }));
  const restore = (row) => change(row, () => call('restore', { id: known.get(row.schoology_id)?.id }));
  // Turn in, and its undo: neo-plan puts an assignment back done, not turned in.
  const turnIn = (row) => change(row, () => call('turnIn', { id: known.get(row.schoology_id)?.id }));
  const putBack = (row) => change(row, () => call('putBack', { id: known.get(row.schoology_id)?.id }));
  // Studied/not studied, done/not done: flips instantly (the state known.get
  // already shows before the call answers), and rolls back on refusal.
  function toggle(row) {
    const it = known.get(row.schoology_id);
    if (!it) return;
    if ((marks.get(row.schoology_id) || []).some((x) => x.busy)) return; // change() would skip it, after the flip below
    const work = it.work === 'ready' ? 'todo' : 'ready';
    known.set(row.schoology_id, { ...it, work });
    return change(row, async () => {
      const r = await call('work', { id: it.id, work });
      if (!r.ok) known.set(row.schoology_id, it); // rollback: the marker flips back
      return r;
    });
  }

  /** Where the marker goes in this row, and how it sits there. */
  // Inline, not :host rules: a page's own "* { margin: 0 }" outranks :host.
  const FLEX = { flex: 'none', alignSelf: 'flex-start', marginLeft: 'auto', paddingLeft: '8px', paddingRight: '2px' };
  const BLOCK = { float: 'right', marginLeft: '8px' };
  function place(host, row) {
    if (row.markSlot) { host.setAttribute('data-line', ''); row.markSlot.append(host); return; } // todo.js's own grid slot: no float/flex, no nudging
    const rowEl = row.el;
    const flex = /flex/.test(getComputedStyle(rowEl).display);
    Object.assign(host.style, flex ? FLEX : BLOCK);
    // The popup's body has no padding of its own: keep the words off its border.
    if (rowEl.closest('.popups-body')) host.style.paddingRight = '12px';
    if (flex) { rowEl.append(host); return; }
    const box = rowEl.querySelector(':scope > .upcoming-item-content') || rowEl;
    box.insertBefore(host, box.firstChild);
  }

  async function scan() {
    const rows = rowsIn(doc);
    for (const row of rows) {
      const list = (marks.get(row.schoology_id) || []).filter((x) => x.host.isConnected);
      marks.set(row.schoology_id, list);
      // A marker Schoology copied along with the row (the "N more overdue"
      // popup clones rows) comes without its shadow root: an empty shell.
      // Take the shell out and give the row a marker of its own.
      const tags = [...row.el.querySelectorAll(TAG)];
      if (tags.some((c) => ours.has(c))) continue;
      for (const c of tags) c.remove();
      const { host, root } = createHost(TAG, CSS);
      ours.add(host);
      keepEvents(host);
      host.hidden = true;
      place(host, row);
      const x = { row, host, root, busy: false };
      if (row.statusSlot) {
        const s2 = createHost(TAG, CSS);
        ours.add(s2.host);
        keepEvents(s2.host);
        s2.host.hidden = true;
        s2.host.setAttribute('data-status', '');
        row.statusSlot.append(s2.host);
        x.statusHost = s2.host;
        x.statusRoot = s2.root;
      }
      list.push(x);
      drawMark(x);
    }
    const want = rows.map((r) => r.schoology_id).filter((id) => !known.has(id) && !asked.has(id));
    if (!want.length || failed) return;
    for (const id of want) asked.add(id);
    for (let i = 0; i < want.length; i += 100) {
      const ids = want.slice(i, i + 100);
      const r = await call('items', { schoology_ids: ids });
      if (!r.ok) { failed = r.status === 401; for (const id of ids) asked.delete(id); return; } // no token: stay quiet
      const got = new Map((r.data?.items || []).map((it) => [String(it.source_id), it]));
      for (const id of ids) known.set(id, got.get(id) || null);
    }
    drawAll();
  }

  const onChange = debounce(scan, 500);
  const observer = new MutationObserver((records) => {
    // Our own markers appearing is not a reason to look again.
    if (records.every((rec) => [...rec.addedNodes].every((n) => n.localName === TAG) && !rec.removedNodes.length)) return;
    onChange();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  try { window.addEventListener('resize', debounce(drawAll, 100)); } catch { /* tests */ }
  const ready = scan();
  return { ready, scan, known, marks, observer, stop: () => observer.disconnect() };
}
