// The side panel's shell: the view switcher (Today | Archive, top right, a
// menu — never a tab bar), Settings for neo-plan, and when Today refreshes.
// The Archive view is archive.js, untouched; this only shows or hides it.

import { np } from './np.js';
import { createToday } from './today.js';

const $ = (id) => document.getElementById(id);
const VIEW_KEY = 'panelView';
const REFRESH_MS = 60_000;
const body = document.body;

let view = null;
let dateText = '';

const today = createToday({
  onDate: (text) => { dateText = text; drawTop(); },
  openUrl,
});

// The folder-picker tab (archive.html?setup=1) is the archiver's alone.
if (new URLSearchParams(location.search).has('setup')) {
  $('npTop').hidden = true;
  body.dataset.view = 'archive';
} else {
  init();
}

async function init() {
  let saved = null;
  try { saved = (await chrome.storage.local.get(VIEW_KEY))[VIEW_KEY]; } catch { /* default below */ }
  let initial = saved === 'today' || saved === 'archive' ? saved : null;
  if (!initial) {
    const s = await np('settings');
    initial = s.ok && s.data?.hasToken ? 'today' : 'archive';
  }
  setView(initial, { remember: false });
  wire();
}

function setView(v, { remember = true } = {}) {
  view = v;
  body.dataset.view = v;
  if (remember) chrome.storage.local.set({ [VIEW_KEY]: v }).catch(() => {});
  drawTop();
  if (v === 'today' && !settingsOpen()) today.refresh();
}

function drawTop() {
  $('npViewName').textContent = view === 'archive' ? 'Archive' : 'Today';
  for (const b of $('npViewMenu').querySelectorAll('[data-view]')) b.setAttribute('aria-checked', String(b.dataset.view === view));
  // The title names what is shown: the day, on Today. Archive has its own heading.
  const title = view === 'today' && !settingsOpen() ? dateText : '';
  $('npDate').textContent = title;
  $('npDate').hidden = !title;
}

// ── Switcher menu ─────────────────────────────────────────────────────────
function menu(open) {
  $('npViewMenu').hidden = !open;
  $('npViewBtn').setAttribute('aria-expanded', String(open));
  if (open) $('npViewMenu').querySelector('[aria-checked="true"]')?.focus();
}

// ── Settings ─────────────────────────────────────────────────────────────
const settingsOpen = () => 'settings' in body.dataset;

async function openSettings() {
  body.dataset.settings = '';
  $('npSettings').hidden = false;
  $('npSettingsBtn').setAttribute('aria-expanded', 'true');
  drawTop();
  await drawSettings();
  $('npServer').focus();
}

function closeSettings() {
  delete body.dataset.settings;
  $('npSettings').hidden = true;
  $('npSettingsBtn').setAttribute('aria-expanded', 'false');
  drawTop();
  if (view === 'today') { today.reset(); today.refresh(); }
}

async function drawSettings(s) {
  s = s || (await np('settings')).data || {};
  const sel = $('npServer');
  sel.replaceChildren(...(s.servers || []).map((url) => {
    const o = document.createElement('option');
    o.value = url;
    o.textContent = url.replace(/^https?:\/\//, '');
    o.selected = url === s.server;
    return o;
  }));
  $('npTokenSet').hidden = !s.hasToken;
  $('npTokenNew').hidden = !!s.hasToken;
  $('npTokenMasked').textContent = s.masked || '';
  hint(s.hasToken ? '' : 'Make one in neo-plan Settings.');
}

function hint(text, bad = false) {
  const h = $('npTokenHint');
  h.textContent = text;
  h.hidden = !text;
  h.classList.toggle('bad', bad);
}

async function saveToken() {
  const token = $('npTokenInput').value.trim();
  if (!token) { $('npTokenInput').focus(); return; }
  const r = await np('setToken', { token });
  if (!r.ok) { hint('Token starts with np_', true); $('npTokenInput').focus(); return; }
  $('npTokenInput').value = '';
  await drawSettings(r.data);
  $('npTokenRemove').focus();
}

async function removeToken() {
  const r = await np('removeToken');
  await drawSettings(r.data);
  $('npTokenInput').focus();
}

// ── Opening a Schoology page in the tab beside the panel ─────────────────
async function openUrl(url) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
}

// ── Wiring ───────────────────────────────────────────────────────────────
function wire() {
  $('npViewBtn').addEventListener('click', () => menu($('npViewMenu').hidden));
  for (const b of $('npViewMenu').querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => {
      menu(false);
      if (settingsOpen()) closeSettings();
      setView(b.dataset.view);
      $('npViewBtn').focus();
    });
  }
  $('npViewMenu').addEventListener('keydown', (e) => {
    const items = [...$('npViewMenu').querySelectorAll('[data-view]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Escape') {
      menu(false);
      $('npViewBtn').focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!$('npViewMenu').hidden && !e.target.closest('.switch')) menu(false);
  });

  $('npSettingsBtn').addEventListener('click', () => (settingsOpen() ? closeSettings() : openSettings()));
  $('npSettingsDone').addEventListener('click', closeSettings);
  $('npSetupOpen').addEventListener('click', openSettings);
  $('npServer').addEventListener('change', async (e) => { await drawSettings((await np('setServer', { server: e.target.value })).data); });
  $('npTokenSave').addEventListener('click', saveToken);
  $('npTokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
  $('npTokenRemove').addEventListener('click', removeToken);

  // Refresh when the panel comes back into view, and once a minute while seen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && view === 'today' && !settingsOpen()) today.refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && view === 'today' && !settingsOpen()) today.refresh();
  }, REFRESH_MS);
}
