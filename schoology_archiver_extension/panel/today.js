// The neo-plan Today view: Overdue, Today, Upcoming, from
// GET /api/extension/today. Cards follow neo-plan's DESIGN.md §5b: the status
// glyph on the left, the turn-in box on the right, exams heavy, and a cleared
// card's place holding Undo for --duration-undo (6s) — never a toast.
//
// Every write is optimistic and rolls back on refusal; the one error line has
// Retry. A 401 shows the setup state. All network goes through np() → the
// service worker.

import { np as defaultNp } from './np.js';
import { itemDay, longDay, metaText, dayOf, clearedWord } from './today-format.js';

export const SECTIONS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
];
const UNDO_MS = 6000; // neo-plan --duration-undo

/** The response's sections as { overdue: [], today: [], upcoming: [] }. */
export function normalize(body) {
  const out = { overdue: [], today: [], upcoming: [] };
  for (const s of Array.isArray(body?.sections) ? body.sections : []) {
    if (s && s.key in out && Array.isArray(s.items)) out[s.key] = s.items.filter((i) => i && i.id != null);
  }
  return { now: body?.now || new Date().toISOString(), zone: body?.zone || 'UTC', sections: out };
}

/**
 * What to draw, as data: sections (empty ones dropped), Upcoming grouped by
 * day, optimistic copies laid over the server's, and cleared cards' places
 * put back where the card stood. Pure, so the harness can check it.
 */
export function buildModel(state) {
  const { data, pending, ghosts } = state;
  if (!data) return [];
  const out = [];
  for (const { key, label } of SECTIONS) {
    const rows = data.sections[key]
      .filter((i) => !ghosts.has(i.id))
      .map((i) => ({ kind: 'item', item: pending.get(i.id) || i }));
    const here = [...ghosts.values()].filter((g) => g.section === key).sort((a, b) => a.index - b.index);
    for (const g of here) rows.splice(Math.min(g.index, rows.length), 0, { kind: 'ghost', item: g.item, ghost: g });
    if (!rows.length) continue;
    if (key !== 'upcoming') { out.push({ key, label, groups: [{ day: null, rows }] }); continue; }
    const groups = [];
    for (const r of rows) {
      const day = itemDay(r.item, data.zone) || '';
      let g = groups.find((x) => x.day === day);
      if (!g) groups.push((g = { day, rows: [] }));
      g.rows.push(r);
    }
    // Server order within a day; days in date order, undated last.
    groups.sort((a, b) => (a.day || '9999').localeCompare(b.day || '9999'));
    out.push({ key, label, groups });
  }
  return out;
}

export function createToday({ onSetup, onDate, np = defaultNp, openUrl, doc = document } = {}) {
  const $ = (id) => doc.getElementById(id);
  const list = $('npList');
  const state = {
    data: null,
    pending: new Map(), // id → the optimistic copy while a work write is in flight
    ghosts: new Map(), // id → { item, section, index, busy, timer } — a cleared card's place
    error: null, // { text, retry, kind: 'load' | 'write' }
    setup: null, // null | 'none' | 'refused'
  };
  let seq = 0;

  // ── Errors ────────────────────────────────────────────────────────────
  function showError(text, retry, kind) {
    state.error = { text, retry, kind };
    drawError();
  }
  function clearError(kind) {
    if (!state.error || (kind && state.error.kind !== kind)) return;
    state.error = null;
    drawError();
  }
  function drawError() {
    const e = state.error;
    $('npErr').hidden = !e;
    if (!e) return;
    $('npErrText').textContent = e.text;
    $('npRetry').hidden = !e.retry;
  }
  $('npRetry').addEventListener('click', () => {
    const retry = state.error?.retry;
    clearError();
    retry?.();
  });

  /** A refused or failed call → setup state, or the one error line. */
  async function fail(r, retry, kind) {
    if (r.status === 401) {
      const s = await np('settings');
      state.setup = s.ok && s.data?.hasToken ? 'refused' : 'none';
      clearError();
      draw();
      onSetup?.(state.setup);
      return;
    }
    if (r.status === 404) { showError('Item gone', null, kind); refresh(); return; }
    if (r.status === 409) { showError('Not an assignment', null, kind); return; }
    if (kind === 'load') showError(r.status === 0 ? 'Can’t reach neo-plan' : 'Can’t load', retry, kind);
    else showError(r.status === 0 ? 'Can’t reach neo-plan' : 'Not saved', retry, kind);
  }

  // ── Server copy ───────────────────────────────────────────────────────
  function locate(id) {
    for (const { key } of SECTIONS) {
      const i = state.data?.sections[key].findIndex((x) => x.id === id) ?? -1;
      if (i >= 0) return { section: key, index: i };
    }
    return null;
  }
  function removeItem(id) {
    for (const { key } of SECTIONS) state.data.sections[key] = state.data.sections[key].filter((x) => x.id !== id);
  }
  /** Merge a returned Item where the old one was. */
  function mergeItem(item) {
    const at = locate(item.id);
    if (at) state.data.sections[at.section][at.index] = item;
  }

  async function refresh() {
    const mine = ++seq;
    const r = await np('today');
    if (mine !== seq) return; // a newer refresh already answered
    if (!r.ok) return fail(r, refresh, 'load');
    state.data = normalize(r.data);
    state.setup = null;
    clearError('load');
    onDate?.(longDay(dayOf(state.data.now, state.data.zone)));
    draw();
  }

  // ── Writes ────────────────────────────────────────────────────────────
  async function toggle(item) {
    if (state.pending.has(item.id)) return;
    const work = item.work === 'ready' ? 'todo' : 'ready';
    const at = locate(item.id);
    state.pending.set(item.id, { ...item, work });
    clearError('write');
    draw();
    const r = await np('work', { id: item.id, work });
    state.pending.delete(item.id);
    if (!r.ok) { draw(); return fail(r, () => toggle(item), 'write'); } // rollback: the server copy shows again
    if (r.data?.cleared) placeGhost(r.data, at, false); // a task: done is cleared
    else if (r.data) mergeItem(r.data);
    draw();
  }

  function placeGhost(item, at, busy) {
    const where = at || locate(item.id) || { section: 'today', index: 0 };
    const g = { item, section: where.section, index: where.index, busy, timer: 0 };
    state.ghosts.set(item.id, g);
    if (!busy) settle(g);
    return g;
  }
  /** The write is done: the place holds Undo for 6s, then closes. */
  function settle(g) {
    removeItem(g.item.id);
    g.busy = false;
    clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      if (g.busy || state.ghosts.get(g.item.id) !== g) return;
      state.ghosts.delete(g.item.id);
      draw();
    }, UNDO_MS);
  }

  async function turnIn(item) {
    if (state.ghosts.has(item.id) || state.pending.has(item.id)) return;
    const g = placeGhost(item, locate(item.id), true); // optimistic: the card leaves on the tap
    clearError('write');
    draw();
    const r = await np('turnIn', { id: item.id });
    if (!r.ok) {
      state.ghosts.delete(item.id); // rollback: the card comes back where it was
      draw();
      return fail(r, () => turnIn(item), 'write');
    }
    if (r.data) g.item = r.data;
    settle(g);
    draw();
  }

  async function undo(g) {
    if (g.busy) return;
    g.busy = true;
    clearTimeout(g.timer);
    clearError('write');
    draw();
    const r = await np('putBack', { id: g.item.id });
    if (!r.ok) {
      g.busy = false;
      settle(g); // the place stays open another window, so Retry has somewhere to land
      draw();
      return fail(r, () => undo(g), 'write');
    }
    state.ghosts.delete(g.item.id);
    const item = r.data && r.data.id != null ? r.data : { ...g.item, cleared: false };
    removeItem(item.id);
    const rows = state.data.sections[g.section];
    rows.splice(Math.min(g.index, rows.length), 0, item);
    draw();
  }

  // ── Drawing ───────────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function card(item, withDay) {
    const exam = item.type === 'exam';
    const ready = item.work === 'ready';
    const li = el('li', `card${exam ? ' exam' : ''}${ready ? ' ready' : ''}`);
    li.dataset.id = item.id;

    const glyph = el('button', 'glyph');
    glyph.dataset.focus = `glyph:${item.id}`;
    glyph.setAttribute('aria-pressed', String(ready));
    glyph.setAttribute('aria-label', `${exam ? 'Studied' : 'Done'}: ${item.title}`);
    const mark = el('span', null, ready ? '✓' : '');
    mark.setAttribute('aria-hidden', 'true');
    glyph.append(mark);
    glyph.disabled = state.pending.has(item.id);
    glyph.addEventListener('click', () => toggle(item));

    const body = el('div', 'body');
    const url = safeUrl(item.source_url);
    const title = el(url ? 'a' : 'span', 'title', item.title || 'Untitled');
    if (url) {
      title.href = url;
      title.dataset.focus = `title:${item.id}`;
      title.addEventListener('click', (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new-tab clicks stay native
        e.preventDefault();
        openUrl?.(url);
      });
    }
    body.append(title);

    const meta = el('div', 'meta');
    if (item.class) {
      const cls = el('span', 'cls');
      const dot = el('span', 'dot');
      const n = Number(item.class.colour_index);
      dot.style.background = `var(--np-class-${n >= 1 && n <= 8 ? n : 'none'})`;
      dot.setAttribute('aria-hidden', 'true');
      cls.append(dot, doc.createTextNode(item.class.short_code || item.class.name || ''));
      meta.append(cls);
    }
    const text = metaText(item, state.data.zone, { withDay });
    if (text) meta.append(el('span', 'mono', text));
    if (meta.childNodes.length) body.append(meta);

    li.append(glyph, body);
    if (exam && ready) li.append(el('span', 'studied', 'studied'));
    if (item.can_turn_in && !exam) {
      const btn = el('button', 'turnin', 'Turn in');
      btn.dataset.focus = `turnin:${item.id}`;
      btn.setAttribute('aria-label', `Turn in ${item.title}`);
      btn.append(el('span', 'box'));
      btn.addEventListener('click', () => turnIn(item));
      li.append(btn);
    }
    return li;
  }

  function ghostRow(g) {
    const li = el('li', 'card cleared');
    li.append(el('span', 'mono dim', clearedWord(g.item)), el('span', 'gone', g.item.title || ''));
    const b = el('button', 'link', 'Undo');
    b.dataset.focus = `undo:${g.item.id}`;
    b.disabled = g.busy;
    b.addEventListener('click', () => undo(g));
    li.append(b);
    return li;
  }

  function draw() {
    const focusKey = doc.activeElement?.dataset?.focus;
    $('npSetup').hidden = !state.setup;
    $('npSetupText').textContent = state.setup === 'refused' ? 'Token refused' : 'Token needed';
    list.replaceChildren();
    if (state.setup || !state.data) return;
    const model = buildModel(state);
    if (!model.length) { list.append(el('p', 'empty', 'Nothing due')); return; }
    for (const s of model) {
      list.append(el('h2', s.key === 'overdue' ? 'overdue' : null, s.label));
      for (const g of s.groups) {
        if (s.key === 'upcoming') list.append(el('p', 'mono dayhead', g.day ? longDay(g.day) : 'No date'));
        const ul = el('ul', 'cards');
        for (const r of g.rows) ul.append(r.kind === 'ghost' ? ghostRow(r.ghost) : card(r.item, s.key === 'overdue'));
        list.append(ul);
      }
    }
    if (focusKey) list.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }

  return {
    refresh,
    /** For the shell: after a token is saved or removed. */
    reset() { state.setup = null; state.data = null; state.error = null; drawError(); draw(); },
    get setup() { return state.setup; },
    _state: state, // the harness reads it
  };
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
