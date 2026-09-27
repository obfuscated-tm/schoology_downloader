// A course as the overlays read it (the Materials page, §2, and the
// assignment page, §3): its gradebook and its folder tree. Everything is a
// GET, same origin, one Schoology page at a time, cached in
// chrome.storage.local for CACHE_MS, so moving between a course's pages
// doesn't read the course again.
//
// A folder in the tree: { at, a, f, i }
//   a  its assignments  [{ id, title, due? }]
//   f  its subfolders   [folder id]
//   i  every row, in page order: [{ k, key, title, id?, fid?, url? }], k being
//      'folder' (fid) or reader/parse/materials.js's kind; `id` for a row that
//      links to /assignment/{id}; `gid` for a newer quiz (/assessments/{id}),
//      whose score the gradebook keeps under that id; `key` is the row's id,
//      as the archive keys it

import { materialRowsIn, folderRowsIn, isLoginPage } from '../reader/parse/sync.js';
import { parseFolderRows } from '../reader/parse/materials.js';
import { parseGrades } from '../reader/parse/grades.js';
import { parseScore } from './grademath.js';

export const ROOT = 'root';
const CACHE_KEY = 'materialsCache'; // { [section]: { grades: { at, rows }, folders: { [fid]: folder }, used } }
const CACHE_MS = 10 * 60_000;
const CACHE_SECTIONS = 8;
const GAP_MS = 400; // one Schoology page every ~0.4s, as the reader does
const MAX_FOLDERS = 80;
const WEIGHTS_KEY = 'gradeWeights'; // { [course id]: { [category title]: percent } }

export function chromeStore() {
  return {
    async get(k) { try { return (await chrome.storage.local.get(k))?.[k]; } catch { return undefined; } },
    async set(k, v) { try { await chrome.storage.local.set({ [k]: v }); } catch { /* tests */ } },
    watch(fn) { try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local') fn(ch); }); } catch { /* tests */ } },
  };
}

export async function fetchDoc(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (new URL(r.url).pathname.startsWith('/login')) throw new Error('login');
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  if (isLoginPage(doc)) throw new Error('login');
  return doc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ASSIGNMENT_RE = /\/assignment\/(\d+)(?:[/?#]|$)/;
const ASSESSMENT_RE = /\/assessments\/(\d+)(?:[/?#]|$)/;

/** One folder's own rows, as the tree keeps them. */
export function folderOf(doc, url) {
  const origin = new URL(url, 'https://x.schoology.com').origin;
  const client = { abs: (h) => new URL(h, origin).href };
  const folderIds = new Map(folderRowsIn(doc).map((r) => [r.title, r.folder_id]));
  const i = [];
  for (const r of parseFolderRows(doc, client) || []) {
    if (r.kind === 'folder') {
      const fid = new URL(r.url).searchParams.get('f') || folderIds.get(r.title);
      if (fid) i.push({ k: 'folder', key: r.key, title: r.title, fid });
      continue;
    }
    const m = (r.url || '').match(ASSIGNMENT_RE);
    const q = !m && (r.url || '').match(ASSESSMENT_RE);
    // A document row has no url of its own: its Schoology page (a file's
    // viewer), else its first file or web link (/link?path=…), else any link.
    const title = r.kind === 'document' && doc.getElementById(r.key)?.querySelector('.item-title a[href]');
    const url = r.url || (title && client.abs(title.getAttribute('href'))) || r.files?.[0]?.url || r.links?.[0]?.url || r.otherUrl || null;
    i.push({ k: r.kind, key: r.key, title: r.title, ...(m ? { id: m[1] } : {}), ...(q ? { gid: q[1] } : {}), ...(url ? { url } : {}) });
  }
  return {
    a: materialRowsIn(doc, url).map((r) => ({ id: r.schoology_id, title: r.title, ...(r.due ? { due: r.due } : {}) })),
    f: folderRowsIn(doc).map((r) => r.folder_id),
    i,
  };
}

/** Gradebook rows → Map id → { earned, possible } for the graded items. */
function gradeMap(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (r.level !== 'item' || !r.id) continue;
    const s = parseScore(r.grade);
    if (s.earned != null) m.set(r.id, s);
  }
  return m;
}

/**
 * A course's reader. `onChange()` after each page it reads. The tree and the
 * gradebook start from the cache (what's still fresh of it).
 */
export async function openCourse({ section, origin, store = chromeStore(), getDoc = fetchDoc, now = () => Date.now(), onChange = () => {} }) {
  const folderUrl = (fid) => `${origin}/course/${section}/materials${fid === ROOT ? '' : `?f=${encodeURIComponent(fid)}`}`;
  const tree = {}; // fid → folder
  let rows = null; // the gradebook's rows (parseGrades), or null
  let grades = null; // Map id → { earned, possible }
  let gradesAt = 0;

  const cached = (await store.get(CACHE_KEY))?.[section];
  const fresh = (at) => at && now() - at < CACHE_MS;
  // A folder cached before rows were kept (no `i`) is read again.
  for (const [fid, f] of Object.entries(cached?.folders || {})) if (fresh(f.at) && Array.isArray(f.i)) tree[fid] = f;
  if (fresh(cached?.grades?.at) && Array.isArray(cached.grades.rows)) {
    rows = cached.grades.rows;
    grades = gradeMap(rows);
    gradesAt = cached.grades.at;
  }

  async function saveCache() {
    const all = (await store.get(CACHE_KEY)) || {};
    all[section] = {
      folders: Object.fromEntries(Object.entries(tree).filter(([, f]) => fresh(f.at))),
      ...(rows && gradesAt ? { grades: { at: gradesAt, rows } } : {}),
      used: now(),
    };
    const keep = Object.entries(all).sort((a, b) => (b[1].used || 0) - (a[1].used || 0)).slice(0, CACHE_SECTIONS);
    await store.set(CACHE_KEY, Object.fromEntries(keep));
  }

  /** This page's own folder, from the live page. */
  function sawFolder(fid, doc, url) {
    tree[fid] = { at: now(), ...folderOf(doc, url) };
  }

  async function readGrades() {
    if (grades) return;
    try {
      const d = await getDoc(`${origin}/course/${section}/student_grades`);
      rows = parseGrades(d);
      grades = gradeMap(rows);
      gradesAt = now();
    } catch { rows = []; grades = new Map(); gradesAt = 0; } // not cached: tried again next page
    onChange();
  }

  let reads = 0;
  /** Read a folder not in the tree yet (`fresh`: read it again anyway). */
  async function readFolder(fid, { fresh: again = false } = {}) {
    if (tree[fid] && !again) return true;
    if (reads++) await sleep(GAP_MS);
    try {
      tree[fid] = { at: now(), ...folderOf(await getDoc(folderUrl(fid)), folderUrl(fid)) };
    } catch { return false; }
    onChange();
    return true;
  }

  /**
   * The folders under `from` (the root unless given), breadth first, reading
   * the ones not in the tree. Stops early once `until()` is true.
   */
  async function walk({ from = ROOT, until = () => false } = {}) {
    const queue = [from];
    const seen = new Set();
    let read = 0;
    while (queue.length) {
      if (until()) return;
      const fid = queue.shift();
      if (seen.has(fid)) continue;
      seen.add(fid);
      if (!tree[fid]) {
        if (read++ >= MAX_FOLDERS) break;
        if (!(await readFolder(fid))) continue;
      }
      queue.push(...tree[fid].f);
    }
  }

  return {
    tree,
    folderUrl,
    get rows() { return rows; },
    get grades() { return grades; },
    gradeOf: (id) => grades?.get(id),
    sawFolder, readGrades, readFolder, walk, saveCache,
  };
}

/** The folder holding assignment `id`, from the tree, or null. */
export function folderHolding(tree, id) {
  for (const [fid, f] of Object.entries(tree)) if (f.a.some((x) => x.id === id)) return fid;
  return null;
}

/** A folder's name, from its parent's row (the root is "Materials"). */
export function folderName(tree, fid) {
  if (fid === ROOT) return 'Materials';
  for (const f of Object.values(tree)) {
    const row = f.i?.find((r) => r.k === 'folder' && r.fid === fid);
    if (row) return row.title;
  }
  return null;
}

/** Category weights Owen typed on the Grades page, for categories Schoology shows none for. */
export async function loadWeights(courseId) {
  try { return (await chrome.storage.local.get(WEIGHTS_KEY))?.[WEIGHTS_KEY]?.[courseId] || {}; } catch { return {}; }
}
export async function saveWeights(courseId, w) {
  try {
    const all = (await chrome.storage.local.get(WEIGHTS_KEY))?.[WEIGHTS_KEY] || {};
    if (Object.keys(w).length) all[courseId] = w; else delete all[courseId];
    await chrome.storage.local.set({ [WEIGHTS_KEY]: all });
  } catch { /* not in the extension */ }
}
