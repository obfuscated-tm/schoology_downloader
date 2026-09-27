// The assignment page (docs/OVERLAY-UI.md §3), and submit detection. Three
// additions, each in a shadow root of its own; Schoology's page stays as it is:
//
//   chip      one line under Schoology's due date (overlays/asgstate.js says
//             which state): the class, then Missing · "A zero costs −N.NN" ·
//             Remove from neo-plan; or Submitted · Cleared in neo-plan · Late
//             by N days; or Graded · Moved your course grade ±N.NN · Nth
//             lowest of M in <category>; or Add to neo-plan; or Removed · Add
//             back. There is no Turn in here: work is turned in only with
//             Schoology's own Submit button, and submit detection clears it.
//   what-if   in Schoology's sidebar, under its Grade box, only while
//             ungraded: "What if I get [ ] / pts" → "Course grade NN.NN% ±delta".
//             Never saved.
//   Also in   below the instructions: the other rows of the folder this
//             assignment is in, with the Materials page's marker (a folder
//             with its status and scored %; a file or page, "In your archive"
//             when the archive has it).
//
// What it reads (overlays/coursedata.js, cached with the Materials page's):
// the course's gradebook, and its folders until the one holding this
// assignment turns up (then that folder's subfolders, for their totals).
//
// Submit detection: when this page shows the submission as made (on load, or
// after the submit dialog changes it), the service worker posts a one-item
// enrich. Reading only: nothing on the page is clicked or changed.

import { parseAssignmentPage, parseSubmissionStatus, assignmentIdOf, folderIdOf } from '../reader/parse/sync.js';
import { clearedWord } from '../panel/today-format.js';
import { cleanText } from '../util.js';
import { np, createHost, el, classDot, onClick, debounce, failText, keepEvents } from './ui.js';
import { periodsFromRows, impact, grade as courseGrade } from './grademath.js';
import { openCourse, chromeStore, fetchDoc, loadWeights, folderHolding, folderName } from './coursedata.js';
import { rowState, folderTotals, summaryParts, pctText, scoreText } from './matstate.js';
import { MARK_CSS, markerFor } from './marker.js';
import {
  chipState, findItem, signed, zeroCost, whatIfGrade, rankIn, rankText, lateDays, lateText, pointsFromText, inArchive,
} from './asgstate.js';

const EPS = 0.005;

const CHIP_CSS = `
:host { display: block; margin: 8px 0 12px; }
:host(.float) { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; margin: 0; }
.chip {
  display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; max-width: 100%;
  padding: 5px 10px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.sep { width: 1px; height: 14px; background: var(--line); flex: none; }
.cls { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.pill { font: 500 12px/18px var(--mono); padding: 0 6px; border-radius: 4px; }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.ok { color: var(--good); background: var(--good-soft); }
.linkbtn { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
`;

const WHATIF_CSS = `
:host { display: block; margin: 12px 0; }
.box {
  display: grid; gap: 6px; padding: 10px 12px; color: var(--dim);
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
input {
  width: 60px; margin: 0 2px; padding: 2px 6px; border: 1px dashed var(--accent); border-radius: 4px;
  background: var(--surface); color: var(--ink); text-align: right;
  font: 13px/18px var(--mono); font-variant-numeric: tabular-nums;
}
input.pts { width: 48px; }
input::placeholder { color: var(--accent); opacity: .7; }
input:not(:placeholder-shown) { border-style: solid; background: var(--accent-soft); }
input[type=number] { -moz-appearance: textfield; }
input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
b.num { font-weight: 500; color: var(--ink); }
.imp { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 3px; font: 500 11px/16px var(--mono); }
.imp.pos { color: var(--good); background: var(--good-soft); }
.imp.neg { color: var(--bad); background: var(--bad-soft); }
`;

const ALSO_CSS = MARK_CSS + `
:host { display: block; margin: 16px 0; max-width: 640px; }
.also { display: grid; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--dim); }
.r { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0; border-top: 1px solid var(--sunk); }
.r:first-of-type { border-top: 0; }
a[href] { color: var(--accent); text-decoration: none; min-width: 0; overflow-wrap: anywhere; }
a[href]:hover { text-decoration: underline; text-underline-offset: 2px; }
a:not([href]) { color: var(--ink); }
.right { display: inline-flex; align-items: center; gap: 10px; flex: none; font-size: 12px; color: var(--dim); white-space: nowrap; }
.pct { color: var(--faint); min-width: 44px; text-align: right; }
.bad { color: var(--bad); }
`;

// ── Where things go on Schoology's page ──────────────────────────────────

// On fuhsd.schoology.com (2026-09-26): the title bar has its own, empty
// p.due-date beside "Grade: N/A" (.grading-grade); the due date that shows
// is .assignment-details > p.due-date, above .info-body (the instructions).
// The sidebar's blocks are in #right-column-inner. The breadcrumb names the
// folder: #center-top .folder-title a[href*="?f="].

/** Schoology's due date line (the one with text), the title if there's none. */
function chipAnchor(doc, page) {
  const details = doc.querySelector('.assignment-details');
  if (details && cleanText(details)) return details;
  const due = [...doc.querySelectorAll('p.due-date')].find((p) => cleanText(p));
  if (due) return due;
  return page.anchor?.isConnected ? page.anchor : doc.querySelector('#center-top .page-title, #center-top h2, h2.page-title');
}

/** The folder the breadcrumb names: { fid, name } or null. */
function crumbFolder(doc) {
  const a = doc.querySelector('#center-top .folder-title a[href*="f="]');
  const fid = a && folderIdOf(a.getAttribute('href'));
  return fid ? { fid, name: cleanText(a) } : null;
}

/** The points this is out of, as the page says it, or null (Schoology shows none until it's graded). */
function pagePoints(doc) {
  for (const n of [doc.querySelector('.grading-grade'), doc.querySelector('.assignment-details')]) {
    const p = n && pointsFromText(n.textContent);
    if (p) return p;
  }
  return null;
}

export function start({
  doc = document, loc = location, send = (m) => chrome.runtime.sendMessage(m), call = np,
  getDoc = fetchDoc, store = chromeStore(), now = () => Date.now(),
} = {}) {
  const id = assignmentIdOf(loc.href);
  if (!id) return null;
  const page = parseAssignmentPage(doc, loc.href);
  const section = page.section_id;

  const chipHost = createHost('np-chip', CHIP_CSS);
  const chip = el('div', 'chip');
  chip.setAttribute('role', 'status');
  chipHost.root.append(chip);

  const wiHost = createHost('np-asg-whatif', WHATIF_CSS);
  keepEvents(wiHost.host);
  const wiBox = el('div', 'box');
  wiHost.root.append(wiBox);
  wiHost.host.hidden = true;

  const alsoHost = createHost('np-asg-also', ALSO_CSS);
  keepEvents(alsoHost.host);
  const alsoBox = el('div', 'also');
  alsoHost.root.append(alsoBox);
  alsoHost.host.hidden = true;

  const state = {
    item: undefined, error: null, busy: false,
    submitted: false, late: undefined, submittedAt: null,
    course: null, periods: [], weights: {},
    points: null, typedPoints: null, whatIf: null,
    fid: null, crumb: null, archive: null,
  };
  const known = new Map(); // schoology_id → Item | null, for the Also in rows
  const busy = new Set();
  const errors = new Map();
  let itemsFailed = false;

  // ── Placing ──
  function mount() {
    const anchor = chipAnchor(doc, page);
    if (!chipHost.host.isConnected || (anchor && chipHost.host.previousElementSibling !== anchor)) {
      if (anchor?.parentNode) {
        chipHost.host.classList.remove('float');
        anchor.insertAdjacentElement('afterend', chipHost.host);
      } else {
        chipHost.host.classList.add('float');
        doc.body.append(chipHost.host);
      }
    }
    const inFlow = !chipHost.host.classList.contains('float');
    if (!wiHost.host.isConnected) {
      // Schoology's Grade sits in the title bar; the what-if goes at the foot of the sidebar.
      const rc = doc.querySelector('#right-column-inner, #right-column');
      if (rc) rc.append(wiHost.host);
      else if (inFlow) chipHost.host.insertAdjacentElement('afterend', wiHost.host);
    }
    if (!alsoHost.host.isConnected) {
      // Below the instructions and their attachments, above Schoology's Comments.
      const comments = doc.querySelector('.assignment-details ~ .comment-container');
      const after = doc.querySelector('.assignment-details ~ .attachments') || doc.querySelector('.info-body');
      if (comments?.parentNode) comments.insertAdjacentElement('beforebegin', alsoHost.host);
      else if (after?.parentNode) after.insertAdjacentElement('afterend', alsoHost.host);
      else if (inFlow) (wiHost.host.parentNode === chipHost.host.parentNode ? wiHost.host : chipHost.host).insertAdjacentElement('afterend', alsoHost.host);
    }
  }

  // ── What the gradebook says about this assignment ──
  const found = () => findItem(state.periods, id);
  const possible = () => state.points ?? found()?.item.possible ?? state.typedPoints;
  const gradeHere = () => state.course?.gradeOf(id);

  // ── The chip ──
  function draw() {
    const kind = chipState(gradeHere(), state.item, state.submitted);
    const it = state.item;
    const segs = []; // [nodes] per segment; separators go between them
    const seg = (...nodes) => segs.push(nodes.filter(Boolean));

    if (it?.class && kind !== 'none' && kind !== 'removed') {
      const c = el('span', 'cls');
      c.append(classDot(it.class), document.createTextNode(it.class.short_code || it.class.name || ''));
      seg(c);
    }
    if (kind === 'graded') {
      seg(el('span', 'dim', 'Graded'));
      const f = found();
      if (f) {
        const d = impact(f.course, id, { weights: state.weights });
        if (d != null) {
          if (Math.abs(d) < EPS) seg(el('span', 'dim', 'Didn’t move your course grade'));
          else {
            const s = el('span', 'dim', 'Moved your course grade ');
            s.append(el('span', `num ${d < 0 ? 'bad' : 'good'}`, signed(d)));
            seg(s);
          }
        }
        const r = rankIn(f.category, id);
        if (r) seg(el('span', 'dim', rankText(r, f.category.title)));
      }
    } else if (kind === 'removed') {
      seg(el('span', 'dim', 'Removed'), button('Add back', 'Add back to neo-plan', () => change('restore')));
    } else if (kind === 'submitted') {
      const word = state.submitted || !it ? 'Submitted' : clearedWord(it);
      seg(el('span', 'pill ok', word));
      if (it?.cleared) seg(el('span', 'dim', 'Cleared in neo-plan'));
      const due = page.due_at || it?.due?.at || null;
      const at = state.submittedAt ?? (it?.cleared_at ? Date.parse(it.cleared_at) : null);
      const days = lateDays(due, at);
      if (state.late === true || (state.late !== false && days > 0)) seg(el('span', 'dim', lateText(days)));
    } else if (kind === 'none') {
      seg(button('Add to neo-plan', 'Add to neo-plan', add));
    } else if (kind === 'open') {
      if (it.missing) seg(el('span', 'pill bad', 'Missing'));
      const f = found();
      const z = f ? zeroCost(f.course, id, possible(), state.weights) : null;
      if (z != null && Math.abs(z) >= EPS) {
        const s = el('span', 'dim', 'A zero costs ');
        s.append(el('span', 'num bad', signed(z)));
        seg(s);
      }
      seg(button('Remove from neo-plan', 'Remove from neo-plan', () => change('remove'), 'linkbtn dim'));
    }
    if (state.error) seg(el('span', state.error.quiet ? 'dim' : 'bad', state.error.text));

    chip.replaceChildren();
    segs.filter((s) => s.length).forEach((nodes, i) => {
      if (i) chip.append(el('span', 'sep'));
      chip.append(...nodes);
    });
    chipHost.host.hidden = !chip.childNodes.length;
    drawWhatIf();
  }

  function button(text, label, fn, cls = 'linkbtn') {
    const b = el('button', cls, text);
    b.setAttribute('aria-label', label);
    b.disabled = state.busy;
    onClick(b, fn);
    return b;
  }

  // ── The sidebar what-if ──
  const score = input('What-if score');
  score.placeholder = 'score';
  const pts = input('Points it is out of', 'pts');
  pts.placeholder = 'pts';
  const out = el('span');
  const line = el('span');
  wiBox.append(line, out);
  score.addEventListener('input', drawWhatIf);
  pts.addEventListener('input', () => { state.typedPoints = num(pts.value); draw(); });

  function input(label, cls) {
    const i = el('input', cls);
    i.type = 'number';
    i.min = '0';
    i.step = 'any';
    i.inputMode = 'decimal';
    i.setAttribute('aria-label', label);
    return i;
  }

  let wiShape = '';
  function drawWhatIf() {
    const f = found();
    const show = !!f && !gradeHere() && courseGrade(f.course, { weights: state.weights }).pct != null;
    wiHost.host.hidden = !show;
    if (!show) return;
    // "/ 10" when the page says what it's out of, else a box for it.
    const shape = state.points ?? f.item.possible ?? 'typed';
    if (shape !== wiShape) {
      wiShape = shape;
      line.replaceChildren(document.createTextNode('What if I get '), score, document.createTextNode(' / '));
      if (shape === 'typed') line.append(pts); else line.append(el('span', 'num', String(shape)));
    }
    const r = whatIfGrade(f.course, id, num(score.value), possible(), state.weights);
    out.replaceChildren();
    if (!r) return;
    out.append(document.createTextNode('Course grade '), el('b', 'num', `${r.pct.toFixed(2)}%`));
    if (r.delta != null && Math.abs(r.delta) >= EPS) out.append(el('span', `imp ${r.delta < 0 ? 'neg' : 'pos'}`, signed(r.delta)));
  }

  // ── Also in <folder> ──
  function drawAlso() {
    const course = state.course;
    const f = state.fid && course?.tree[state.fid];
    const rows = (f?.i || []).filter((r) => r.id !== id);
    alsoHost.host.hidden = !rows.length;
    if (!rows.length) return;
    const name = folderName(course.tree, state.fid) || state.crumb?.name || 'this folder';
    const stateOf = (aid) => rowState(course.gradeOf(aid), itemsFailed ? undefined : known.get(aid));
    const kids = [el('h3', null, `Also in ${name}`)];
    for (const r of rows) {
      const row = el('div', 'r');
      const a = el('a', null, r.title);
      a.href = r.k === 'folder' ? course.folderUrl(r.fid) : r.id ? `${loc.origin}/assignment/${r.id}` : r.url || '';
      if (!r.url && r.k !== 'folder' && !r.id) a.removeAttribute('href');
      // A web link leaves Schoology (its /link redirect): a new tab, as Schoology opens it.
      if (/\/link\?/.test(r.url || '')) { a.target = '_blank'; a.rel = 'noopener'; }
      const right = el('span', 'right');
      if (r.k === 'folder') {
        const t = folderTotals(course.tree, r.fid, stateOf, course.gradeOf);
        const parts = itemsFailed ? [] : summaryParts(t);
        parts.forEach((p, i) => {
          if (i) right.append(document.createTextNode(' · '));
          right.append(p.bad ? el('span', 'bad', p.text) : document.createTextNode(p.text));
        });
        const pct = el('span', 'num pct', pctText(t.pct));
        pct.title = 'Points earned out of points graded in this folder';
        right.append(pct);
      } else if (r.id) {
        const it = known.get(r.id);
        const { kids: mark, label } = markerFor(stateOf(r.id), {
          item: it,
          rowDue: course.tree[state.fid].a.find((x) => x.id === r.id)?.due,
          busy: busy.has(r.id),
          onAdd: () => changeRow(r.id, () => call('addItem', {
            item: { schoology_id: r.id, section_id: section, realm: null, title: r.title, due_at: course.tree[state.fid].a.find((x) => x.id === r.id)?.due || null, source_url: `${loc.origin}/assignment/${r.id}` },
          })),
          onRestore: () => changeRow(r.id, () => call('restore', { id: it?.id })),
        });
        right.append(...mark);
        if (label) right.title = label;
        if (errors.has(r.id)) right.append(el('span', 'bad', errors.get(r.id)));
      } else if (r.gid && course.gradeOf(r.gid)) {
        // A newer quiz: not in neo-plan, but the gradebook has its score.
        const g = course.gradeOf(r.gid);
        right.append(el('span', 'num score', scoreText(g.earned, g.possible)));
      } else if (inArchive(state.archive, r.key)) {
        right.append(document.createTextNode('In your archive'));
      }
      row.append(a, right);
      kids.push(row);
    }
    alsoBox.replaceChildren(...kids);
  }

  async function changeRow(aid, run) {
    if (busy.has(aid)) return;
    busy.add(aid);
    errors.delete(aid);
    drawAlso();
    const r = await run();
    busy.delete(aid);
    if (r.ok && r.data) known.set(aid, r.data);
    else errors.set(aid, failText(r));
    drawAlso();
  }

  async function askRows(ids) {
    const want = [...new Set(ids)].filter((x) => !known.has(x));
    for (let i = 0; i < want.length && !itemsFailed; i += 100) {
      const batch = want.slice(i, i + 100);
      const r = await call('items', { schoology_ids: batch });
      if (!r.ok) { if (r.status === 401 || r.status === 0) itemsFailed = true; break; }
      const got = new Map((r.data?.items || []).map((it) => [String(it.source_id), it]));
      for (const x of batch) known.set(x, got.get(x) || null);
    }
    drawAlso();
  }

  // ── neo-plan: this assignment ──
  function fail(r) {
    if (r.status === 401) state.error = { text: 'Token needed', quiet: true };
    else state.error = { text: failText(r) };
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
      item: { schoology_id: id, section_id: section, title: page.title, due_at: page.due_at, source_url: loc.origin + loc.pathname },
    });
    state.busy = false;
    if (r.ok && r.data) state.item = r.data; else fail(r);
    draw();
  }

  // Remove from neo-plan, or add it back: the item as it is after.
  async function change(op) {
    const it = state.item;
    if (state.busy || !it) return;
    state.busy = true; state.error = null; draw();
    const r = await call(op, { id: it.id });
    state.busy = false;
    if (r.ok && r.data) state.item = r.data; else fail(r);
    draw();
  }

  // ── Submit detection ──────────────────────────────────────────────────
  let reported = false;
  let checked = false; // the first look: a submission seen later was made in this view
  async function checkSubmitted() {
    const st = parseSubmissionStatus(doc, loc.href);
    const first = !checked;
    checked = true;
    if (st.state !== 'submitted') return;
    if (typeof st.late === 'boolean') state.late = st.late;
    if (!state.submitted) {
      state.submitted = true;
      if (!first) state.submittedAt = now();
      draw();
    }
    if (reported) return;
    reported = true;
    let r = null;
    try { r = await send({ type: 'submitted', schoology_id: id, ...(typeof st.late === 'boolean' ? { late: st.late } : {}) }); } catch { /* worker asleep */ }
    if (!r?.ok) { reported = false; return; }
    if (!r.data?.already) load(); // neo-plan may have just cleared it
  }

  // ── The course: gradebook, folders, archive ──
  async function readCourse() {
    if (!section) return;
    const course = await openCourse({ section, origin: loc.origin, store, getDoc, now, onChange: debounce(drawAlso, 50) });
    state.course = course;
    state.weights = await loadWeights(section);
    state.archive = await store.get(`course:${loc.host}:${section}`);
    await course.readGrades();
    state.periods = periodsFromRows(course.rows || []);
    draw();

    // The folder: the breadcrumb's, else the cached tree's, else Schoology's
    // folders from the root until it turns up.
    state.crumb = crumbFolder(doc);
    if (state.crumb && await course.readFolder(state.crumb.fid, { fresh: true }) && folderHolding({ x: course.tree[state.crumb.fid] }, id)) state.fid = state.crumb.fid;
    state.fid ||= folderHolding(course.tree, id);
    if (!state.fid) {
      await course.walk({ until: () => !!folderHolding(course.tree, id) });
      state.fid = folderHolding(course.tree, id);
    }
    if (!state.fid) return;
    drawAlso();
    await course.walk({ from: state.fid }); // its subfolders, for their totals
    const under = [state.fid];
    for (let i = 0; i < under.length; i++) under.push(...(course.tree[under[i]]?.f || []));
    await askRows(under.flatMap((fid) => (course.tree[fid]?.a || []).map((a) => a.id)).filter((x) => x !== id));
    await course.saveCache();
  }

  store.watch?.((ch) => {
    const k = `course:${loc.host}:${section}`;
    if (!(k in ch)) return;
    state.archive = ch[k].newValue;
    drawAlso();
  });

  const onChange = debounce(() => { mount(); checkSubmitted(); }, 800);
  const observer = new MutationObserver((records) => {
    const ours = (n) => n.nodeType === 1 && /^np-/.test(n.localName);
    if (records.every((rec) => [...rec.addedNodes].every(ours) && [...rec.removedNodes].every(ours))) return;
    onChange();
  });
  observer.observe(doc.body, { childList: true, subtree: true });

  state.points = pagePoints(doc);
  mount();
  draw();
  checkSubmitted();
  const ready = Promise.all([load(), readCourse().catch((e) => console.debug('[neo-plan overlay]', e))]);
  return {
    host: chipHost.host, chip, whatIf: wiHost.host, also: alsoHost.host, state, known, ready,
    checkSubmitted, observer, stop: () => observer.disconnect(),
  };
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
