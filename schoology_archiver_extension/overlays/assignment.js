// The assignment page: a neo-plan chip by the title, and submit detection.
//
// Chip, left to right: "neo-plan", the class dot + name, Owen's own due date
// (mono), then one state — Turn in (the yellow box) when can_turn_in,
// Submitted when Schoology cleared it, Cleared when he did, Missing (in --time)
// when the gradebook says so. An assignment neo-plan doesn't have gets
// "Add to neo-plan".
//
// Submit detection: when this page shows the submission as made (on load, or
// after the submit dialog changes it), the service worker posts a one-item
// enrich. Reading only: nothing on the page is clicked or changed.

import { parseAssignmentPage, parseSubmissionStatus, assignmentIdOf } from '../reader/parse/sync.js';
import { metaText } from '../panel/today-format.js';
import { np, createHost, el, classDot, onClick, debounce, UNDO_MS } from './ui.js';

const CSS = `
:host { display: block; margin: 8px 0; }
:host(.float) { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; margin: 0; }
.chip {
  display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px 12px;
  padding: 4px 12px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.brand { font-weight: 600; }
.cls { display: inline-flex; align-items: center; gap: 4px; }
.turnin { display: inline-flex; align-items: center; gap: 8px; }
.add { text-decoration: underline; text-underline-offset: 2px; }
`;

export function start({ doc = document, loc = location, send = (m) => chrome.runtime.sendMessage(m), call = np } = {}) {
  const id = assignmentIdOf(loc.href);
  if (!id) return null;
  const page = parseAssignmentPage(doc, loc.href);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { host, root } = createHost('np-chip', CSS);
  const chip = el('div', 'chip');
  chip.setAttribute('role', 'status');
  root.append(chip);

  const state = { item: undefined, error: null, busy: false, ghost: null };

  function mount() {
    if (host.isConnected) return;
    const anchor = page.anchor?.isConnected ? page.anchor : doc.querySelector('#center-top .page-title, #center-top h2, h2.page-title');
    if (anchor?.parentNode) {
      host.classList.remove('float');
      anchor.insertAdjacentElement('afterend', host);
    } else {
      host.classList.add('float');
      doc.body.append(host);
    }
  }

  function draw() {
    chip.replaceChildren(el('span', 'brand', 'neo-plan'));
    if (state.item === undefined && !state.error) { chip.hidden = true; return; }
    chip.hidden = false;
    if (state.error) { chip.append(el('span', state.error.quiet ? 'dim' : 'time', state.error.text)); if (state.item === undefined) return; }
    const it = state.item;
    if (it === null) {
      const b = el('button', 'add', 'Add to neo-plan');
      b.disabled = state.busy;
      onClick(b, add);
      chip.append(b);
      return;
    }
    if (it.class) {
      const c = el('span', 'cls');
      c.append(classDot(it.class), document.createTextNode(it.class.short_code || it.class.name || ''));
      chip.append(c);
    }
    const meta = metaText(it, zone, { withDay: true });
    if (meta) chip.append(el('span', 'mono dim', meta));
    if (it.missing) chip.append(el('span', 'time', 'Missing'));
    if (state.ghost) {
      chip.append(el('span', 'mono dim', 'Cleared'));
      const u = el('button', 'link', 'Undo');
      u.disabled = state.busy;
      onClick(u, undo);
      chip.append(u);
    } else if (it.cleared) {
      chip.append(el('span', 'dim', it.cleared_by === 'schoology' ? 'Submitted' : 'Cleared'));
    } else if (it.can_turn_in) {
      const b = el('button', 'turnin', 'Turn in');
      b.setAttribute('aria-label', `Turn in ${it.title || ''}`.trim());
      b.append(el('span', 'box'));
      b.disabled = state.busy;
      onClick(b, turnIn);
      chip.append(b);
    }
  }

  function fail(r) {
    if (r.status === 401) state.error = { text: 'Token needed', quiet: true };
    else if (r.status === 0) state.error = { text: 'Can’t reach neo-plan' };
    else state.error = { text: 'Not saved' };
  }

  async function load() {
    const r = await call('items', { schoology_ids: [id] });
    if (!r.ok) { fail(r); draw(); return; }
    state.error = null;
    state.item = (r.data?.items || []).find((x) => String(x.source_id) === id) || null;
    draw();
  }

  async function add() {
    if (state.busy) return;
    state.busy = true; state.error = null; draw();
    const r = await call('addItem', {
      item: { schoology_id: id, section_id: page.section_id, title: page.title, due_at: page.due_at, source_url: loc.origin + loc.pathname },
    });
    state.busy = false;
    if (r.ok && r.data) state.item = r.data; else fail(r);
    draw();
  }

  async function turnIn() {
    const it = state.item;
    if (state.busy || !it) return;
    state.busy = true; state.error = null; state.ghost = { timer: 0 }; draw();
    const r = await call('turnIn', { id: it.id });
    state.busy = false;
    if (!r.ok) { state.ghost = null; fail(r); draw(); return; }
    if (r.data) state.item = r.data;
    const g = state.ghost;
    g.timer = setTimeout(() => { if (state.ghost === g && !state.busy) { state.ghost = null; draw(); } }, UNDO_MS);
    draw();
  }

  async function undo() {
    const it = state.item;
    if (state.busy || !it || !state.ghost) return;
    clearTimeout(state.ghost.timer);
    state.busy = true; state.error = null; draw();
    const r = await call('putBack', { id: it.id });
    state.busy = false;
    if (!r.ok) {
      fail(r);
      const g = state.ghost;
      g.timer = setTimeout(() => { if (state.ghost === g) { state.ghost = null; draw(); } }, UNDO_MS);
      draw();
      return;
    }
    state.ghost = null;
    state.item = r.data?.id != null ? r.data : { ...it, cleared: false, cleared_by: null };
    draw();
  }

  // ── Submit detection ──────────────────────────────────────────────────
  let reported = false;
  async function checkSubmitted() {
    if (reported) return;
    const st = parseSubmissionStatus(doc, loc.href);
    if (st.state !== 'submitted') return;
    reported = true;
    let r = null;
    try { r = await send({ type: 'submitted', schoology_id: id, ...(typeof st.late === 'boolean' ? { late: st.late } : {}) }); } catch { /* worker asleep */ }
    if (!r?.ok) { reported = false; return; }
    if (!r.data?.already) load(); // neo-plan may have just cleared it
  }

  const onChange = debounce(() => { mount(); checkSubmitted(); }, 800);
  const observer = new MutationObserver(onChange);
  observer.observe(doc.body, { childList: true, subtree: true });

  mount();
  draw();
  checkSubmitted();
  const ready = load();
  return { host, root, chip, state, ready, checkSubmitted, observer, stop: () => observer.disconnect() };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
