// Browser-side cache of parsed files (IndexedDB) so the map opens instantly
// and keeps working with no signal. Nothing here leaves the device.

const DB_NAME = 'foraging-fog-map';
const STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// record: { id, source: 'local'|'drive', name, modified, tracks, waypoints, parts }
export function putFile(record) {
  return tx('readwrite', (s) => s.put(record));
}

export function deleteFiles(ids) {
  return tx('readwrite', (s) => { for (const id of ids) s.delete(id); });
}

export function allFiles() {
  return tx('readonly', (s) => reqP(s.getAll()));
}

export function clearAll() {
  return tx('readwrite', (s) => s.clear());
}
