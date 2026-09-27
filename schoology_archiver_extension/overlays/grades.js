// The grades page, /course/{id}/student_grades (docs/OVERLAY-UI.md §1), inline
// in Schoology's own table. Schoology's rows, grades and buttons stay as they
// are; this only adds, and only what the page doesn't already show:
//   course row     beside Schoology's grade, Graph (a step chart of the
//                  replayed term, in a row of our own under it) and, with
//                  what-ifs, "→ A 96.12% ±delta Reset"; "X.XX above A" at right
//   category rows  "A holds down to NN.N%"; "→ NN.N%" with what-ifs; a weight
//                  box only when Schoology shows no (N%) for the category
//   graded items   the impact tag (course % with it − without it)
//   "—" items      a what-if score box (and a points box: "—" rows don't say
//                  what they're out of)
//   after each category, a row of our own: "+ Plan an upcoming …"
// The right-hand column is a <td> of ours appended to every row; it and our
// own rows vanish with the Overlay switch like every host. Schoology hides
// its Course Grade row, so the course-level additions sit on the current
// period's row then. What-ifs and planned items live only in this page view;
// typed weights are saved per course.
//
// Only the current grading period (grademath.currentPeriod) is annotated.

import { parseGrades } from '../reader/parse/grades.js';
import {
  periodsFromRows, currentPeriod, grade, impact, history, categoryFloor, needFor, letter, A_CUTOFF,
} from './grademath.js';
import { createHost, el, onOverlay, isOverlayOn, debounce, keepEvents } from './ui.js';
import { loadWeights, saveWeights } from './coursedata.js';

const EPS = 0.005;

const CSS = `
.imp {
  display: inline-block; min-width: 44px; padding: 0 5px; border-radius: 3px; text-align: center;
  font: 500 11px/16px var(--mono); font-variant-numeric: tabular-nums;
}
.imp.pos { color: var(--good); background: var(--good-soft); }
.imp.neg { color: var(--bad); background: var(--bad-soft); }
.acc { color: var(--accent); }
.note { font-size: 12px; color: var(--accent); white-space: nowrap; }
.note.warn { color: var(--bad); }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; font-weight: 500; }
.linkbtn { color: var(--accent); font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
input {
  font: 12px/16px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink);
  padding: 1px 5px; margin: 0; border: 1px dashed var(--accent); border-radius: 4px;
  background: var(--surface); text-align: right;
}
input::placeholder { color: var(--accent); opacity: .7; font-family: var(--sans); }
input:not(:placeholder-shown) { border-style: solid; background: var(--accent-soft); }
input[type=number] { -moz-appearance: textfield; }
input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.wrap { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); }
`;

const CELL_CSS = CSS + `
:host { display: block; padding: 0 8px; text-align: right; }
.note { white-space: normal; }
.num, .imp { white-space: nowrap; }
`;

const INLINE_CSS = CSS + `
:host { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; vertical-align: middle; }
:host([hidden]) { display: none !important; }
.spark {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px;
  color: var(--accent); font-size: 12px; font-weight: 400; white-space: nowrap;
}
.spark:hover { background: var(--accent-soft); }
.spark svg { display: block; }
.wi-pts { width: 44px; }
.wi-score { width: 66px; }
.w { width: 44px; }
`;

const ROW_CSS = CSS + `
:host { display: block; }
.hypo { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12px; color: var(--dim); }
.hypo input[type=text] { width: 160px; text-align: left; font-family: var(--sans); }
.hypo input[type=number] { width: 56px; }
.need b { font-family: var(--mono); font-weight: 500; }
.chart { position: relative; max-width: 640px; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart-note { display: flex; flex-wrap: wrap; gap: 4px 20px; font-size: 12px; color: var(--dim); margin-top: 8px; }
.tip {
  position: absolute; pointer-events: none; transform: translate(-50%, -100%); margin-top: -10px;
  background: var(--ink); color: #fff; font-size: 12px; line-height: 1.4; padding: 6px 8px;
  border-radius: 4px; white-space: nowrap;
}
.tip b { font-family: var(--mono); font-weight: 500; }
.tip .s { opacity: .7; }
`;

// ── Small helpers ────────────────────────────────────────────────────────

const fmt = (v, d = 2) => (v == null ? '' : v.toFixed(d));
const signed = (d) => (d < 0 ? '−' : '+') + Math.abs(d).toFixed(2);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const dayNum = (day) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 864e5;
const dayLabel = (day) => new Date(dayNum(day) * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "A (97%)" → { pct: 97, tol: 0.5 }; "95.9%" → { pct: 95.9, tol: 0.05 }; else null. */
function shownPct(text) {
  const m = String(text || '').match(/(\d+(?:\.(\d+))?)\s*%/);
  return m ? { pct: Number(m[1]), tol: 0.5 * 10 ** -(m[2]?.length || 0) } : null;
}

/** A row our controls sit in never hears about clicks and keys on them. */
const isShown = (node) => node.getClientRects().length > 0;

function impTag(d, title) {
  if (d == null || Math.abs(d) < EPS) return null;
  const t = el('span', `imp ${d < 0 ? 'neg' : 'pos'}`, signed(d));
  if (title) t.title = title;
  return t;
}

function input(type, cls, label, placeholder) {
  const i = el('input', cls);
  i.type = type;
  if (type === 'number') { i.min = '0'; i.step = 'any'; i.inputMode = 'decimal'; }
  i.setAttribute('aria-label', label);
  if (placeholder) i.placeholder = placeholder;
  return i;
}

// ── The chart ────────────────────────────────────────────────────────────

/** History points with a day to plot at (undated ones plot at today). */
function plotPoints(hist) {
  const t = today();
  const pts = [];
  for (const p of hist) {
    if (p.pct == null) continue;
    const day = p.day || t;
    const last = pts[pts.length - 1];
    if (last && last.day === day) { last.pct = p.pct; last.items.push(...p.items); } else pts.push({ day, pct: p.pct, items: [...p.items] });
  }
  return pts;
}

function sparkSvg(pts) {
  const w = 56, h = 16;
  const x0 = dayNum(pts[0].day), x1 = Math.max(dayNum(pts[pts.length - 1].day), x0 + 1);
  const lo = Math.min(...pts.map((p) => p.pct)), hi = Math.max(100, ...pts.map((p) => p.pct));
  const X = (d) => 2 + ((dayNum(d) - x0) / (x1 - x0)) * (w - 6);
  const Y = (v) => 2 + ((hi - v) / (hi - lo || 1)) * (h - 4);
  let d = `M${X(pts[0].day)},${Y(pts[0].pct)}`;
  for (const p of pts.slice(1)) d += ` H${X(p.day)} V${Y(p.pct)}`;
  const l = pts[pts.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/><circle cx="${X(l.day)}" cy="${Y(l.pct)}" r="2.5" fill="var(--accent)"/></svg>`;
}

/** The step chart into `box`, with a dashed line to `proj` when a what-if is set. */
function drawChart(box, pts, proj) {
  const w = 600, h = 200, m = { l: 36, r: 76, t: 12, b: 24 };
  const tNum = dayNum(today());
  const x0 = dayNum(pts[0].day);
  const xEnd = Math.max(dayNum(pts[pts.length - 1].day), tNum);
  const span = Math.max(xEnd - x0, 1);
  const x1 = proj != null ? xEnd + Math.max(3, span * 0.08) : xEnd + (xEnd === x0 ? 1 : 0);
  const vals = pts.map((p) => p.pct).concat(proj ?? []);
  const ymin = Math.min(A_CUTOFF - 1, Math.floor(Math.min(...vals)) - 1);
  const ymax = Math.max(100, Math.ceil(Math.max(...vals)));
  const X = (n) => m.l + ((n - x0) / (x1 - x0)) * (w - m.l - m.r);
  const Y = (v) => m.t + ((ymax - v) / (ymax - ymin)) * (h - m.t - m.b);
  const mono = 'font-family="ov JetBrains Mono, JetBrains Mono, monospace"';
  const sans = 'font-family="ov Instrument Sans, Instrument Sans, sans-serif"';

  let g = '';
  const range = ymax - ymin, step = range <= 12 ? 2 : range <= 30 ? 5 : 10;
  for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) {
    g += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--sunk)"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--faint)" ${mono}>${v}</text>`;
  }
  g += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(A_CUTOFF)}" y2="${Y(A_CUTOFF)}" stroke="var(--dim)" stroke-dasharray="3 3"/><text x="${w - m.r + 6}" y="${Y(A_CUTOFF) + 4}" font-size="11" fill="var(--dim)" ${sans}>A cutoff</text>`;
  for (let i = 0; i < 4; i++) {
    const n = Math.round(x0 + ((xEnd - x0) * i) / 3);
    const label = new Date(n * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    g += `<text x="${X(n)}" y="${h - 6}" text-anchor="middle" font-size="11" fill="var(--faint)" ${mono}>${label}</text>`;
    if (xEnd === x0) break;
  }
  let path = `M${X(dayNum(pts[0].day))},${Y(pts[0].pct)}`;
  for (const p of pts.slice(1)) path += ` H${X(dayNum(p.day))} V${Y(p.pct)}`;
  const lastX = X(xEnd), lp = pts[pts.length - 1];
  path += ` H${lastX}`;
  g += `<path d="${path} V${h - m.b} H${X(x0)} Z" fill="var(--accent)" fill-opacity=".07"/><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  g += `<circle cx="${lastX}" cy="${Y(lp.pct)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/><text x="${lastX + 8}" y="${Y(lp.pct) + (proj != null && proj > lp.pct ? 14 : -6)}" font-size="11" fill="var(--ink)" ${mono}>${fmt(lp.pct)}</text>`;
  if (proj != null) {
    g += `<line x1="${lastX}" y1="${Y(lp.pct)}" x2="${X(x1)}" y2="${Y(proj)}" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/><circle cx="${X(x1)}" cy="${Y(proj)}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/><text x="${X(x1) + 8}" y="${Y(proj) + 4}" font-size="11" fill="var(--accent)" ${mono}>${fmt(proj)}</text>`;
  }
  g += `<line class="xh" y1="${m.t}" y2="${h - m.b}" stroke="var(--dim)" visibility="hidden"/><circle class="xd" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/><rect class="hit" x="${m.l}" y="0" width="${Math.max(lastX - m.l, 1)}" height="${h}" fill="transparent"/>`;

  const chart = el('div', 'chart');
  chart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img">${g}</svg>`;
  const svg = chart.firstChild;
  svg.setAttribute('aria-label', `Course grade over the term, now ${fmt(lp.pct)}%`);
  const tip = el('div', 'tip');
  tip.hidden = true;
  chart.append(tip);

  const xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd'), hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * w;
    let best = pts[0];
    for (const p of pts) if (X(dayNum(p.day)) <= sx) best = p;
    const px = X(dayNum(best.day)), py = Y(best.pct);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', px); xd.setAttribute('cy', py); xd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.left = `${(px / w) * 100}%`;
    tip.style.top = `${(py / h) * r.height}px`;
    const more = best.items.length > 1 ? ` +${best.items.length - 1} more` : '';
    tip.replaceChildren(el('b', null, `${fmt(best.pct)}%`), ` · ${dayLabel(best.day)}`, el('br'), el('span', 's', best.items[best.items.length - 1] + more));
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    xh.setAttribute('visibility', 'hidden');
    xd.setAttribute('visibility', 'hidden');
  });

  const lo = pts.reduce((a, b) => (b.pct < a.pct ? b : a));
  const note = el('div', 'chart-note');
  note.append(el('span', null, 'Replayed from graded items by due date'));
  const low = el('span', null, 'Lowest ');
  low.append(el('span', 'num', fmt(lo.pct)), ` on ${dayLabel(lo.day)}`);
  note.append(low);
  if (proj != null) note.append(el('span', 'acc', 'Dashed line is your what-if'));
  box.replaceChildren(chart, note);
}

// ── The page ─────────────────────────────────────────────────────────────

export async function start({ doc = document, loc = location } = {}) {
  const rows = parseGrades(doc, { els: true });
  if (!rows.length) return null;
  const courseId = (loc.pathname.match(/^\/course\/(\d+)/) || [])[1] || 'page';
  const course = currentPeriod(periodsFromRows(rows));
  if (!course) return null;

  const typed = await loadWeights(courseId); // only for categories Schoology shows no (N%) for
  const whatIf = new Map(); // item id → { earned, possible }
  const plans = new Map(); // category title → { name, possible, score } (null: none open)
  let chartOpen = false;

  const weights = () => {
    const w = {};
    for (const c of course.categories) if (c.weight == null && typed[c.title] != null) w[c.title] = typed[c.title];
    return w;
  };
  const extras = (except) => [...plans].filter(([t, p]) => t !== except && p && p.score != null && p.possible > 0)
    .map(([t, p]) => ({ category: t, earned: p.score, possible: p.possible }));
  const whatIfOpts = () => Object.fromEntries([...whatIf].filter(([, v]) => v.earned != null && v.possible > 0));
  const opts = (exceptPlan) => ({ weights: weights(), whatIf: whatIfOpts(), extra: extras(exceptPlan) });
  const anyWhatIf = () => Object.keys(whatIfOpts()).length > 0 || extras().length > 0;

  // Schoology hides its "Course Grade" row (display: none) and shows the grade
  // in a box under the table; then the current period's row, at the top,
  // carries the course-level additions.
  const courseRow = [rows.find((r) => r.level === 'course'), course.src].find((r) => r && isShown(r.el))
    || rows.find((r) => r.level === 'course') || course.src;
  const updates = []; // () => void, run on every change
  const ourRows = []; // { tr, shown: () => bool }
  const wantTint = new Map(); // tr → has a what-if score
  const tinted = new Map(); // tr → carries the tint now
  const resetters = []; // clear the what-if boxes on Reset

  // The right-hand column: a <td> of ours on every row of the table. Schoology
  // draws each row's rule and padding on the .td-content-wrapper inside every
  // cell, so ours has one too and lines up. The cells go with the Overlay
  // switch (syncRows), so an off page has no extra column.
  const cells = new Map(); // tr → shadow root
  const ourCells = [];
  for (const r of rows) {
    const tr = r.el;
    const td = doc.createElement('td');
    td.className = 'np-grade-col';
    td.style.width = '112px'; // "A holds down to" on one line, the number under it
    td.style.display = 'none';
    const wrap = doc.createElement('div');
    wrap.className = 'td-content-wrapper';
    wrap.style.justifyContent = 'flex-end';
    const { host, root } = createHost('np-grade-col', CELL_CSS);
    keepEvents(host);
    wrap.append(host);
    td.append(wrap);
    tr.append(td);
    cells.set(tr, root);
    ourCells.push(td);
  }
  const cell = (tr, ...kids) => { const root = cells.get(tr); root.replaceChildren(root.firstChild, ...kids.filter(Boolean)); };

  function inline(where, tag, { wrap = false } = {}) {
    const { host, root } = createHost(tag, INLINE_CSS);
    keepEvents(host);
    host.style.marginLeft = '8px'; // inline: Schoology's own margin reset beats :host
    const box = where.querySelector('.td-content-wrapper') || where;
    // The wrapper is a one-line flex box. With `wrap`, ours may drop to a
    // second line rather than squeeze Schoology's grade (not on item rows:
    // their empty .grade-wrapper would take a line of its own).
    if (wrap && getComputedStyle(box).display.includes('flex')) { box.style.flexWrap = 'wrap'; box.style.rowGap = '4px'; }
    box.append(host);
    return { host, root };
  }
  /** A row's indent: its title cell's reportSpacer padding (Schoology scopes that rule to its own cells). */
  const indentOf = (tr) => { const sp = tr?.querySelector('[class*="reportSpacer-"]'); return sp ? getComputedStyle(sp).paddingLeft : '0px'; };
  const gradeCell = (tr) => tr.querySelector('.grade-column') || tr.children[1] || tr;
  const titleCell = (tr) => tr.querySelector('th, .title-column') || tr.firstElementChild;

  /**
   * A <tr> of ours after `after`, one cell across the table, holding a host,
   * inside Schoology's own spacer and wrapper classes so it gets the same
   * indent (that of `indentLike`) and rule as the rows around it.
   */
  function ourRow(after, shown, indentLike) {
    const tr = doc.createElement('tr');
    tr.className = 'np-overlay-row';
    const td = doc.createElement('td');
    td.colSpan = after.children.length;
    const spacer = doc.createElement('div');
    spacer.style.paddingLeft = indentOf(indentLike);
    const wrap = doc.createElement('div');
    wrap.className = 'td-content-wrapper';
    const { host, root } = createHost('np-grade-row', ROW_CSS);
    host.style.flex = '1 1 auto'; // the wrapper is a flex box; let the chart have the width
    host.style.minWidth = '0';
    keepEvents(host);
    wrap.append(host);
    spacer.append(wrap);
    td.append(spacer);
    tr.append(td);
    after.after(tr);
    tr.style.display = 'none';
    ourRows.push({ tr, shown });
    return { tr, root };
  }

  // ── Course row ──
  const hist = plotPoints(history(course, { weights: weights() }));
  let chartBox = null;
  {
    const tr = courseRow.el;
    // Graph sits beside Schoology's grade: the title cell is too narrow for
    // it, and our column is kept narrow so Schoology's titles don't wrap more.
    if (hist.length >= 2) {
      const { root } = inline(gradeCell(tr), 'np-grade-graph', { wrap: true });
      const b = el('button', 'spark');
      root.append(b);
      b.title = 'Show your grade over the term';
      const label = el('span');
      const chart = ourRow(tr, () => chartOpen && isShown(tr), tr);
      chartBox = chart.root;
      b.addEventListener('click', () => { chartOpen = !chartOpen; update(); });
      updates.push(() => {
        b.innerHTML = sparkSvg(plotPoints(history(course, { weights: weights() })));
        label.textContent = chartOpen ? 'Hide graph' : 'Graph';
        b.append(label);
        b.setAttribute('aria-expanded', String(chartOpen));
        if (chartOpen) {
          const box = el('div');
          drawChart(box, plotPoints(history(course, { weights: weights() })), anyWhatIf() ? grade(course, opts()).pct : null);
          chartBox.replaceChildren(chartBox.firstChild, box);
        }
      });
    }

    const { host: projHost, root: proj } = inline(gradeCell(tr), 'np-grade-proj');
    const reset = el('button', 'linkbtn', 'Reset');
    reset.addEventListener('click', () => {
      whatIf.clear();
      for (const p of plans.values()) if (p) p.score = null;
      for (const f of resetters) f();
      update();
    });
    const shown = shownPct((course.src || courseRow).grade) || shownPct(courseRow.grade);
    updates.push(() => {
      const base = grade(course, { weights: weights() }).pct;
      const now = grade(course, opts()).pct;
      projHost.hidden = !anyWhatIf() || now == null;
      if (!projHost.hidden) {
        const out = el('span', 'acc', '→ ');
        out.append(el('span', 'num', `${letter(now)} ${fmt(now)}%`));
        proj.replaceChildren(proj.firstChild, out, impTag(now - base, 'What-if course grade minus the real one') || el('span', 'mono dim', '±0.00'), reset);
      }
      if (base == null) return cell(tr);
      if (shown && Math.abs(base - shown.pct) > shown.tol + 1e-9) {
        const n = el('span', 'note warn', `Weights? we get ${fmt(base)}%`);
        n.title = `Schoology shows ${shown.pct}%. The overlay's math doesn't match it, so its numbers on this page are off. If a category has no weight, type it in beside the category's name.`;
        return cell(tr, n);
      }
      const d = base - A_CUTOFF;
      const n = el('span', 'note');
      n.append(el('span', 'num', fmt(Math.abs(d))), d >= 0 ? ' above A' : ' below A');
      n.title = `Course grade minus the A cutoff (${A_CUTOFF}%)`;
      cell(tr, n);
    });
  }

  // ── Categories, their items, and a planning row after each ──
  for (const cat of course.categories) {
    const ctr = cat.src.el;

    if (cat.weight == null) {
      const { root } = inline(titleCell(ctr), 'np-grade-weight');
      const w = input('number', 'w', `Weight of ${cat.title}, percent`, '?');
      if (typed[cat.title] != null) w.value = String(typed[cat.title]);
      w.addEventListener('input', () => {
        const v = num(w.value);
        if (v == null) delete typed[cat.title]; else typed[cat.title] = v;
        saveWeights(courseId, { ...typed });
        update();
      });
      const wrap = el('span', 'wrap', 'weight ');
      wrap.title = 'Schoology shows no weight for this category. Type it to weight the course grade by category; leave every one empty to use total points.';
      wrap.append(w, '%');
      root.append(wrap);
    }

    const { host: catProjHost, root: catProj } = inline(gradeCell(ctr), 'np-grade-proj');
    updates.push(() => {
      const base = grade(course, { weights: weights() }).categories.find((c) => c.title === cat.title)?.pct;
      const now = grade(course, opts()).categories.find((c) => c.title === cat.title)?.pct;
      catProjHost.hidden = now == null || (base != null && Math.abs(now - base) < EPS);
      if (!catProjHost.hidden) {
        const out = el('span', 'acc', '→ ');
        out.append(el('span', 'num', `${fmt(now, 1)}%`));
        catProj.replaceChildren(catProj.firstChild, out);
      }
      const floor = categoryFloor(course, cat.title, A_CUTOFF, opts());
      if (floor == null || now == null) return cell(ctr);
      const n = el('span', 'note');
      if (floor > 100) n.append('A out of reach here');
      else if (floor > now + 1e-9) n.append('A needs ', el('span', 'num', `${fmt(floor, 1)}%`));
      else n.append('A holds down to ', el('span', 'num', `${fmt(Math.max(floor, 0), 1)}%`));
      n.title = `Lowest ${cat.title} can drop, the other categories unchanged, and keep an A (${A_CUTOFF}%)`;
      cell(ctr, n);
    });

    for (const it of cat.items) {
      const tr = it.src.el;
      if (it.earned != null) {
        updates.push(() => cell(tr, impTag(impact(course, it.id, { weights: weights() }), 'Course grade with this item minus without it')));
        continue;
      }
      const { root } = inline(gradeCell(tr), 'np-grade-whatif');
      const score = input('number', 'wi-score', `What-if score for ${it.title}`, 'what if');
      const wrap = el('span', 'wrap');
      wrap.append(score, '/');
      let pts = null;
      if (it.possible != null) wrap.append(el('span', 'mono', String(it.possible)));
      else { pts = input('number', 'wi-pts', `Points ${it.title} is out of`, 'pts'); wrap.append(pts); }
      root.append(wrap);
      const read = () => {
        const earned = num(score.value), possible = pts ? num(pts.value) : it.possible;
        if (earned == null && possible == null) whatIf.delete(it.id); else whatIf.set(it.id, { earned, possible });
        update();
      };
      score.addEventListener('input', read);
      pts?.addEventListener('input', read);
      resetters.push(() => { score.value = ''; if (pts) pts.value = ''; });
      updates.push(() => {
        const v = whatIf.get(it.id);
        tint(tr, !!(v && v.earned != null && v.possible > 0));
        cell(tr);
      });
    }

    // The planning row goes after the category's last row of items.
    const last = cat.items.length ? cat.items[cat.items.length - 1].src.el : ctr;
    const lead = cat.items.length ? cat.items[0].src.el : ctr;
    const plan = ourRow(last, () => isShown(lead), cat.items.length ? lead : ctr);
    plans.set(cat.title, null);
    const kind = /test|quiz|exam|assess/i.test(cat.title) ? 'test' : 'assignment';
    let need = null;
    const drawPlan = () => {
      const p = plans.get(cat.title);
      if (!p) {
        const b = el('button', 'linkbtn', `+ Plan an upcoming ${kind}`);
        b.addEventListener('click', () => {
          plans.set(cat.title, { name: '', possible: kind === 'test' ? 50 : 10, score: null });
          drawPlan();
          update();
          plan.root.querySelector('input')?.focus();
        });
        need = null;
        return plan.root.replaceChildren(plan.root.firstChild, b);
      }
      const box = el('div', 'hypo');
      const name = input('text', null, `Upcoming ${kind} name`, 'name');
      name.value = p.name;
      name.addEventListener('input', () => { p.name = name.value; });
      const worth = input('number', null, 'Points it is worth');
      worth.value = String(p.possible);
      worth.addEventListener('input', () => { p.possible = num(worth.value); update(); });
      const sc = input('number', null, 'What-if score', '?');
      sc.addEventListener('input', () => { p.score = num(sc.value); update(); });
      resetters.push(() => { sc.value = ''; });
      need = el('span', 'need acc');
      const rm = el('button', 'linkbtn', 'Remove');
      rm.addEventListener('click', () => { plans.set(cat.title, null); drawPlan(); update(); });
      box.append(el('span', null, 'Upcoming'), name, el('span', null, 'worth'), worth, el('span', null, 'score'), sc, need, rm);
      plan.root.replaceChildren(plan.root.firstChild, box);
    };
    drawPlan();
    updates.push(() => {
      const p = plans.get(cat.title);
      if (!p || !need) return;
      if (!(p.possible > 0)) return need.replaceChildren();
      const r = needFor(course, { category: cat.title, possible: p.possible }, opts(cat.title));
      if (r.status === 'any') need.replaceChildren('any score keeps an A');
      else if (r.status === 'out') need.replaceChildren('out of reach with this alone');
      else need.replaceChildren('need ', el('b', null, `${Math.ceil(r.need * 100) / 100}/${p.possible}`), ' for an A');
    });
  }

  // A row with a what-if score gets --accent-soft, on Schoology's own cells,
  // only while the overlay is on.
  function tint(tr, on) {
    wantTint.set(tr, on);
    const want = on && isOverlayOn();
    if (!!tinted.get(tr) === want) return;
    tinted.set(tr, want);
    for (const c of tr.children) if (c.localName === 'td' || c.localName === 'th') c.style.backgroundColor = want ? '#E7EFF8' : '';
  }

  // Our own rows follow the overlay switch and Schoology's collapsing.
  function syncRows() {
    const col = isOverlayOn() ? '' : 'none';
    for (const td of ourCells) if (td.style.display !== col) td.style.display = col;
    for (const r of ourRows) {
      const d = isOverlayOn() && r.shown() ? '' : 'none';
      if (r.tr.style.display !== d) r.tr.style.display = d;
    }
  }

  function update() {
    for (const f of updates) f();
    syncRows();
  }

  const table = courseRow.el.closest('table') || doc.body;
  new MutationObserver(debounce(syncRows, 60)).observe(table, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
  onOverlay(() => {
    for (const [tr, on] of wantTint) tint(tr, on);
    syncRows();
  });
  update();
  return { update, whatIf, plans };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && typeof location !== 'undefined' && !globalThis.__npNoAutoStart) start();
