// /home: one small marker at the end of each upcoming/overdue submission row,
// saying what neo-plan has for it:
//   ○ in neo-plan, not done    ✓ done, not turned in    Cleared / Submitted
//   + not in neo-plan (a button: adds it)               Missing, in --time
// One batched items request for the rows on screen; rows Schoology loads
// later are picked up by a MutationObserver. Each marker is our own element in
// its own shadow root, appended inside the row; Schoology's nodes and their
// attributes are never changed.

import { homeRowsIn } from '../reader/parse/sync.js';
import { np, createHost, el, onClick, debounce } from './ui.js';

const CSS = `
:host { display: inline-block; margin-left: 8px; vertical-align: baseline; }
.mark {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 0 4px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
  font-family: var(--mono); font-size: 12px; line-height: 16px; color: var(--ink-dim);
}
.add { color: var(--ink); min-width: 16px; }
.time { color: var(--time); }
`;
const TAG = 'np-mark';

export function start({ doc = document, loc = location, call = np } = {}) {
  const known = new Map(); // schoology_id → Item | null (null: not in neo-plan)
  const marks = new Map(); // schoology_id → [{ row, host, root }]
  const asked = new Set();
  let failed = false;

  function drawMark(m, row) {
    const box = el('span', 'mark');
    const it = known.get(row.schoology_id);
    if (it === undefined) { m.root.replaceChildren(m.root.firstChild); m.host.hidden = true; return; }
    m.host.hidden = false;
    let label = '';
    if (it === null) {
      const b = el('button', 'add', '+');
      b.setAttribute('aria-label', 'Add to neo-plan');
      b.title = 'Add to neo-plan';
      b.disabled = !!m.busy;
      onClick(b, () => add(row));
      box.append(b);
      label = 'Add to neo-plan';
    } else {
      if (it.cleared) box.append(el('span', null, it.cleared_by === 'schoology' ? 'Submitted' : 'Cleared'));
      else if (it.work === 'ready') box.append(el('span', null, '✓'));
      else box.append(el('span', null, '○'));
      if (it.missing) box.append(el('span', 'time', 'Missing'));
      label = `neo-plan: ${it.cleared ? (it.cleared_by === 'schoology' ? 'Submitted' : 'Cleared') : it.work === 'ready' ? 'Done' : 'Not done'}${it.missing ? ', Missing' : ''}`;
      box.title = label;
    }
    box.setAttribute('aria-label', label);
    m.root.replaceChildren(m.root.firstChild, box); // keep the <style>
  }

  function drawAll() {
    for (const [id, list] of marks) for (const x of list) if (x.host.isConnected) drawMark(x, x.row);
  }

  async function add(row) {
    const list = marks.get(row.schoology_id) || [];
    for (const x of list) x.busy = true;
    drawAll();
    const r = await call('addItem', {
      item: {
        schoology_id: row.schoology_id,
        realm: row.realm || null, // the service worker turns it into a section
        title: row.title,
        due_at: row.due || null,
        source_url: `${loc.origin}/assignment/${row.schoology_id}`,
      },
    });
    for (const x of list) x.busy = false;
    if (r.ok && r.data) known.set(row.schoology_id, r.data);
    drawAll();
  }

  async function scan() {
    const rows = homeRowsIn(doc);
    for (const row of rows) {
      const list = marks.get(row.schoology_id) || [];
      marks.set(row.schoology_id, list.filter((x) => x.host.isConnected));
      if ([...row.el.children].some((c) => c.localName === TAG)) continue;
      const { host, root } = createHost(TAG, CSS);
      host.hidden = true;
      row.el.append(host);
      const x = { row, host, root, busy: false };
      marks.get(row.schoology_id).push(x);
      drawMark(x, row);
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

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
