// Row markers, shared by /home and a course's Materials page: one small
// marker at the end of each assignment row, saying what neo-plan has for it:
//   ○ in neo-plan, not done    ✓ done, not turned in
//   Turned in / Finished / Submitted (Schoology cleared it)
//   Missing, in --time         × takes it off neo-plan
//   + not in neo-plan (adds it)    Removed · Add back (brings it back)
// One batched items request for the rows on screen; rows Schoology loads
// later are picked up by a MutationObserver. Each marker is our own element in
// its own shadow root, appended inside the row; Schoology's nodes and their
// attributes are never changed.

import { np, createHost, el, onClick, debounce, failText } from './ui.js';
import { clearedWord } from '../panel/today-format.js';

const CSS = `
:host { display: inline-block; margin-left: 8px; vertical-align: baseline; }
.mark {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 0 4px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
  font-family: var(--mono); font-size: 12px; line-height: 16px; color: var(--ink-dim);
}
.add, .back { color: var(--ink); min-width: 16px; }
.back { text-decoration: underline; text-underline-offset: 2px; }
.rm { color: var(--ink-dim); min-width: 16px; }
.rm:hover { color: var(--ink); }
.time { color: var(--time); }
`;
const TAG = 'np-mark';

/**
 * rowsIn(doc) → [{ el, schoology_id, title, due?, realm?, section_id? }].
 * `el` is where the marker is appended.
 */
export function startMarks({ rowsIn, doc = document, loc = location, call = np }) {
  const known = new Map(); // schoology_id → Item | null (null: not in neo-plan)
  const marks = new Map(); // schoology_id → [{ row, host, root, busy }]
  const errors = new Map(); // schoology_id → text of the last failed change
  const asked = new Set();
  let failed = false;

  function button(cls, text, label, fn, busy) {
    const b = el('button', cls, text);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.disabled = !!busy;
    onClick(b, fn);
    return b;
  }

  function drawMark(m) {
    const row = m.row;
    const it = known.get(row.schoology_id);
    if (it === undefined) { m.root.replaceChildren(m.root.firstChild); m.host.hidden = true; return; }
    m.host.hidden = false;
    const box = el('span', 'mark');
    let label;
    if (it === null) {
      box.append(button('add', '+', 'Add to neo-plan', () => add(row), m.busy));
      label = 'Not in neo-plan';
    } else if (it.removed) {
      box.append(el('span', null, 'Removed'), button('back', 'Add back', 'Add back to neo-plan', () => restore(row), m.busy));
      label = 'Removed from neo-plan';
    } else {
      const done = it.cleared ? clearedWord(it) : it.work === 'ready' ? 'Done' : 'Not done';
      box.append(el('span', null, it.cleared ? done : it.work === 'ready' ? '✓' : '○'));
      if (it.missing) box.append(el('span', 'time', 'Missing'));
      box.append(button('rm', '×', 'Remove from neo-plan', () => remove(row), m.busy));
      label = `neo-plan: ${done}${it.missing ? ', Missing' : ''}`;
    }
    const err = errors.get(row.schoology_id);
    if (err) box.append(el('span', 'time', err));
    box.title = label;
    box.setAttribute('aria-label', label);
    m.root.replaceChildren(m.root.firstChild, box); // keep the <style>
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
  const remove = (row) => change(row, () => call('remove', { id: known.get(row.schoology_id)?.id }));
  const restore = (row) => change(row, () => call('restore', { id: known.get(row.schoology_id)?.id }));

  async function scan() {
    const rows = rowsIn(doc);
    for (const row of rows) {
      const list = (marks.get(row.schoology_id) || []).filter((x) => x.host.isConnected);
      marks.set(row.schoology_id, list);
      if ([...row.el.children].some((c) => c.localName === TAG)) continue;
      const { host, root } = createHost(TAG, CSS);
      host.hidden = true;
      row.el.append(host);
      const x = { row, host, root, busy: false };
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
  const ready = scan();
  return { ready, scan, known, marks, observer, stop: () => observer.disconnect() };
}
