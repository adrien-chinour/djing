// The single IndexedDB database of the page, "djing". MIGRATIONS[n] upgrades version n to n + 1;
// a feature that needs a new store appends a migration, never edits a released one.

const NAME = 'djing';

export const MIGRATIONS = [
  // 0 -> 1: per-track data keyed by track id (library/scan.js), and small settings (directory handle).
  (db) => {
    db.createObjectStore('tracks', { keyPath: 'id' });
    db.createObjectStore('settings');
  },
];

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

let opening = null;

/** Opens (and upgrades) the database once; resolves to the IDBDatabase. */
export function openDb() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, MIGRATIONS.length);
    req.onupgradeneeded = (e) => {
      for (let v = e.oldVersion; v < MIGRATIONS.length; v++) MIGRATIONS[v](req.result, req.transaction);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

/** Reads `key` from `store` (undefined when absent). */
export async function get(store, key) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).get(key));
}

/** Reads every value of `store`. */
export async function getAll(store) {
  const db = await openDb();
  return request(db.transaction(store).objectStore(store).getAll());
}

/** Writes `value` to `store`, under `key` for a store without key path. */
export async function put(store, value, key) {
  const db = await openDb();
  return request(db.transaction(store, 'readwrite').objectStore(store).put(value, key));
}
