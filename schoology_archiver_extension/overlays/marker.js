// The one marker an assignment row gets, on the Materials page (§2), in the
// Upcoming / To Do columns and /home/assignments (overlays/marks.js), and in
// the assignment page's "Also in" list (§3): overlays/matstate.js says which
// state, this draws it. The host's CSS needs MARK_CSS.

import { el, onClick } from './ui.js';
import { scoreText, shortDue } from './matstate.js';

// Colour says the state at a glance (the overlay's tokens, docs/OVERLAY-UI.md):
//   green  Submitted / Turned in / Finished     blue  ● Done, not submitted, ■ Studied
//   ink    □ Not studied                        grey  ○ To do (or its due date)
//   red    Missing                              faint Removed
// Tests get a square, as in neo-plan; everything else a circle.
export const MARK_CSS = `
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.score { color: var(--ink); }
.pill {
  padding: 0 6px; border-radius: var(--radius);
  color: var(--bad); background: var(--bad-soft); font-weight: 500; font-size: 11px; line-height: 16px;
}
.circle { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--dim); flex: none; }
.circle.sq { border-radius: 2px; }
.st { display: inline-flex; align-items: center; gap: 6px; }
.st.done { color: var(--accent); font-weight: 500; }
.st.done .circle { background: var(--accent); border-color: var(--accent); }
.st.exam { color: var(--ink); }
.st.exam .circle { border-color: var(--ink); }
.st.cleared { color: var(--good); font-weight: 500; }
.st.cleared .circle { background: var(--good); border-color: var(--good); position: relative; }
.st.cleared .circle::after {
  content: ""; position: absolute; left: 3.5px; top: 1px; width: 3px; height: 6px;
  border: solid var(--surface); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
}
.removed { color: var(--faint); }
.linkbtn { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
/* A todo/ready state given onToggle draws as this button instead of a span: same
   look (button chrome is already stripped in BASE_CSS), a subtle hover cue on
   the words, and the shared :focus-visible ring. */
button.st:hover > *:not(.circle) { text-decoration: underline; text-underline-offset: 2px; }
`;

function linkBtn(text, label, fn, disabled) {
  const b = el('button', 'linkbtn', text);
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  onClick(b, fn);
  return b;
}
const circle = (exam) => { const c = el('span', exam ? 'circle sq' : 'circle'); c.setAttribute('aria-hidden', 'true'); return c; };

/**
 * "Mark studied" / "Mark not studied" / "Mark done" / "Mark not done": the
 * action a toggle button offers, from the state it's leaving. Pure.
 */
export function toggleLabel(kind, exam) {
  if (kind === 'ready') return exam ? 'Mark not studied' : 'Mark not done';
  return exam ? 'Mark studied' : 'Mark done';
}

/**
 * A state: its shape (circle, or square for a test), then its words. A
 * `toggle` ({ pressed, busy, label, onToggle }) makes it a real <button> —
 * aria-pressed, aria-label, disabled while busy — instead of a plain span.
 */
function st(cls, exam, words, toggle) {
  const box = el(toggle ? 'button' : 'span', `st ${cls}`.trim());
  box.append(circle(exam));
  for (const w of words) if (w) box.append(typeof w === 'string' ? el('span', null, w) : w);
  if (toggle) {
    box.setAttribute('aria-pressed', String(toggle.pressed));
    box.setAttribute('aria-label', toggle.label);
    box.disabled = toggle.busy;
    onClick(box, toggle.onToggle);
  }
  return box;
}

/**
 * s: rowState(). item: neo-plan's Item (for the due date). rowDue: the due
 * Schoology's row shows. onToggle, when given, makes a todo/ready state's
 * words a button that flips it (marks.js's toggle()) instead of plain text —
 * missing/submitted/graded/removed/none never get one. → { kids: [nodes],
 * label } (label for title/aria).
 */
export function markerFor(s, { item, rowDue, busy = false, onAdd, onRestore, onToggle } = {}) {
  const toggleFor = (kind, exam) => onToggle && { pressed: kind === 'ready', busy, label: toggleLabel(kind, exam), onToggle };
  switch (s.kind) {
    case 'graded':
      return { kids: [el('span', 'num score', scoreText(s.earned, s.possible))], label: `Graded ${scoreText(s.earned, s.possible)}` };
    case 'submitted':
      return { kids: [st('cleared', false, [s.word])], label: s.word };
    case 'removed':
      return { kids: [el('span', 'removed', 'Removed'), linkBtn('Add back', 'Add back to neo-plan', onRestore, busy)], label: 'Removed from neo-plan' };
    case 'missing':
      return { kids: [el('span', 'pill', 'Missing'), circle(s.exam)], label: s.exam ? 'Missing, not studied' : 'Missing, not done' };
    case 'ready':
      return s.exam
        ? { kids: [st('done', true, ['Studied'], toggleFor('ready', true))], label: 'Studied (neo-plan)' }
        : { kids: [st('done', false, ['Done, not submitted'], toggleFor('ready', false))], label: 'Marked done in neo-plan, not submitted' };
    case 'todo': {
      const due = shortDue(item, rowDue);
      const dueEl = due ? el('span', 'num', due) : null;
      if (s.exam) return { kids: [st('exam', true, ['Not studied', dueEl], toggleFor('todo', true))], label: due ? `Not studied, on ${due}` : 'Not studied' };
      // With no due date to show (a row that already shows it), the words say it.
      return { kids: [st('', false, [dueEl || 'To do'], toggleFor('todo', false))], label: due ? `Not done, due ${due}` : 'Not done' };
    }
    case 'none':
      return { kids: [linkBtn('+ Add to neo-plan', 'Add to neo-plan', onAdd, busy)], label: 'Not in neo-plan' };
    default:
      return { kids: [], label: '' };
  }
}
