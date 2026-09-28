// neo-plan settings: server, token, the Schoology line and Courses. Shown two
// ways — as a normal tab (toolbar icon / chrome://extensions "Details" ›
// "Extension options"), and framed with ?embed=1 inside the Overlay gear
// popover on a Schoology page (built in overlays/switch.js). Embedded, there
// is no Done button (the popover closes itself) and this page reports its
// height to the parent frame so the popover can size to it.

import { np } from './np.js';
import { createSyncSettings } from './sync-settings.js';
import { getSavedFolder, pickFolder, clearFolder } from '../outputs/archive/folder.js';

const $ = (id) => document.getElementById(id);
const embed = new URLSearchParams(location.search).has('embed');
if (embed) document.body.classList.add('embed');

const syncSettings = createSyncSettings();

function hint(text, bad = false) {
  const h = $('npTokenHint');
  h.textContent = text;
  h.hidden = !text;
  h.classList.toggle('bad', bad);
}

async function draw(s) {
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
  await syncSettings.draw({ hasToken: !!s.hasToken });
}

async function saveToken() {
  const token = $('npTokenInput').value.trim();
  if (!token) { $('npTokenInput').focus(); return; }
  const r = await np('setToken', { token });
  if (!r.ok) {
    // Only a bad format is the token's fault. No reply at all means the service
    // worker is still the old one: Chrome swaps it only on a reload.
    hint(r.data?.error === 'token_format' ? 'Token starts with np_' : 'Reload extension', true);
    $('npTokenInput').focus();
    return;
  }
  $('npTokenInput').value = '';
  await draw(r.data);
  $('npTokenRemove').focus();
}

async function removeToken() {
  const r = await np('removeToken');
  await draw(r.data);
  $('npTokenInput').focus();
}

// ── Where archives are saved (Downloads, or a chosen folder) ──────────────
// Hidden entirely when embedded (settings.css: body.embed #npArchiverRow):
// the File System Access picker is refused in a cross-origin iframe, so
// choosing or changing the folder only ever happens here, as a normal tab.
async function drawFolder() {
  const folder = await getSavedFolder().catch(() => null);
  if (!folder) {
    $('npFolderName').textContent = 'Downloads › Schoology Archive';
    $('npFolderClear').hidden = true;
    $('npFolderChoose').textContent = 'Choose folder…';
    return;
  }
  const granted = (await folder.queryPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted';
  $('npFolderName').textContent = folder.name + (granted ? '' : ' (will ask to allow)');
  $('npFolderClear').hidden = false;
  $('npFolderChoose').textContent = 'Change…';
}

async function chooseFolder() {
  const h = $('npFolderHint');
  h.hidden = true;
  try {
    await pickFolder();
    await drawFolder();
  } catch (e) {
    if (e?.name === 'AbortError') return; // picker cancelled
    h.textContent = 'Chrome didn’t allow the folder picker here.';
    h.hidden = false;
  }
}

async function useDownloads() {
  await clearFolder();
  await drawFolder();
}

function wire() {
  $('npServer').addEventListener('change', async (e) => { await draw((await np('setServer', { server: e.target.value })).data); });
  $('npTokenSave').addEventListener('click', saveToken);
  $('npTokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
  $('npTokenRemove').addEventListener('click', removeToken);
  $('npFolderChoose').addEventListener('click', chooseFolder);
  $('npFolderClear').addEventListener('click', useDownloads);
  if (!embed) $('npSettingsDone').addEventListener('click', () => window.close());
}

// ── Reporting height to the popover that frames this page ───────────────
function watchHeight() {
  if (!embed || typeof ResizeObserver === 'undefined') return;
  let last = -1;
  const report = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h === last) return;
    last = h;
    parent.postMessage({ type: 'np-settings-height', height: h }, '*');
  };
  new ResizeObserver(report).observe(document.documentElement);
  report();
}

(async function init() {
  wire();
  watchHeight();
  await draw();
  if (!embed) { await drawFolder(); $('npServer').focus(); }
})();
