// The archive folder the user picked (File System Access API). The handle is
// kept in IndexedDB so it survives restarts; Chrome may still ask to re-allow
// access (choose "Allow on every visit" to stop that).

const DB = 'archiver';
const STORE = 'handles';
const KEY = 'archiveRoot';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const getSavedFolder = () => idb('readonly', (s) => s.get(KEY));
export const saveFolder = (handle) => idb('readwrite', (s) => s.put(handle, KEY));

// Must be called from a click (Chrome requires a user gesture for the picker).
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'schoology-archive', mode: 'readwrite', startIn: 'downloads' });
  await saveFolder(handle);
  return handle;
}

// Returns the handle if we can write to it, asking Chrome for permission if needed
// (also needs a user gesture). Returns null if there's no folder or access was denied.
export async function ensureWritable(handle) {
  if (!handle) return null;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return handle;
  if ((await handle.requestPermission(opts)) === 'granted') return handle;
  return null;
}
