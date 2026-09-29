/**
 * The widget's IndexedDB store, and the store `persist` uses when the host
 * names none.
 *
 * `localStorage` is synchronous, shared with the host's own keys and capped
 * at a few megabytes per origin, which drawings kept for every instrument a
 * trader has looked at can reach. IndexedDB has room, but answers later, so
 * the store here is an `AsyncStorageLike`: `WidgetStorage` reads a namespace
 * from it once and writes behind.
 *
 * Four decisions worth recording:
 *
 * - **A namespace this database has never held takes what an earlier release
 *   left in the page's storage.** The first read of an empty namespace copies
 *   every `oac-widget:<namespace>:` key from `localStorage` in the same
 *   transaction and marks the namespace as copied, so a layout saved before
 *   the upgrade opens as it was, and a namespace emptied later is not filled
 *   again from the old copy. The old keys are left where they were: going
 *   back to an earlier release, or to `storage: localStorage`, still finds them.
 * - **The writes pending when the page goes away are journaled in
 *   `localStorage`.** IndexedDB may not commit a transaction started while a
 *   page unloads; the journal is small, written once, and replayed and
 *   removed by the next load.
 * - **Another tab upgrading or deleting the database is let through.** The
 *   connection closes when asked, and the next call opens a new one.
 * - **The default falls back to `localStorage` when the database cannot be
 *   read at all**, so a browser that offers IndexedDB but refuses it keeps
 *   persisting as earlier releases did. A host that names this store gets
 *   IndexedDB or a reported failure, never a quiet change of store.
 */
import { defaultStorage, type AsyncStorageLike, type StorageLike } from './context';

/** The database the widget keeps its preferences and layouts in when the host names none. */
const DATABASE = 'openalgo-charts-widget';
const STORE = 'entries';
/** Where a namespace's copy from the page's storage is recorded; outside every `oac-widget:` range. */
const COPIED = 'copied:';

export interface IndexedDbWidgetStorageOptions {
  /**
   * Where the writes still pending when the page goes away are kept until the
   * next load. Default: the page's `localStorage`. Null keeps no journal, and
   * those writes may be lost with the page.
   */
  journal?: StorageLike | null;
  /**
   * Where earlier releases kept the widget's keys, copied once into a
   * namespace this database has never held. Default: the page's
   * `localStorage`. Null copies nothing.
   */
  migrateFrom?: Storage | null;
}

export interface IndexedDbWidgetStorage extends AsyncStorageLike {
  /** Release the connection. Later calls reject. */
  close(): void;
}

/**
 * A key-value store for the widget over IndexedDB: one object store of JSON
 * texts under the widget's keys, one transaction per call. Pass the page's
 * `indexedDB`; importing this module needs no browser.
 *
 * ```ts
 * createWidget(el, { persist: 'desk', storage: createIndexedDbWidgetStorage(indexedDB, 'my-app-charts') });
 * ```
 */
export function createIndexedDbWidgetStorage(factory: IDBFactory, name: string = DATABASE,
  options: IndexedDbWidgetStorageOptions = {}): IndexedDbWidgetStorage {
  const journal = options.journal === undefined ? defaultStorage() : options.journal;
  const legacy = options.migrateFrom === undefined ? pageStorage() : options.migrateFrom;
  let opening: Promise<IDBDatabase> | null = null;
  let closed = false;

  const open = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new Error('The widget storage is closed'));
    if (opening !== null) return opening;
    const attempt: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onblocked = () => reject(new Error('The widget storage is held open by another tab'));
      request.onerror = () => reject(request.error ?? new Error('The widget storage could not be opened'));
      request.onsuccess = () => {
        const db = request.result;
        if (closed) { db.close(); reject(new Error('The widget storage is closed')); return; }
        db.onversionchange = () => { db.close(); if (opening === attempt) opening = null; };
        db.onclose = () => { if (opening === attempt) opening = null; };
        resolve(db);
      };
    }).catch((error: unknown) => {
      if (opening === attempt) opening = null;
      throw error;
    });
    opening = attempt;
    return attempt;
  };

  /** One transaction on the store, settled when it commits. */
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value: T | undefined;
      tx.oncomplete = () => resolve(value as T);
      tx.onabort = () => reject(tx.error ?? new Error('The widget storage transaction was aborted'));
      body(tx.objectStore(STORE), result => { value = result; });
    });
  };

  return {
    journal,
    entries: prefix => run<Array<[string, string]>>('readwrite', (store, done) => {
      const rows: Array<[string, string]> = [];
      done(rows);
      const range = keyRange(prefix);
      const cursor = range === null ? store.openCursor() : store.openCursor(range);
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (at !== null) {
          if (typeof at.key === 'string' && at.key.startsWith(prefix) && typeof at.value === 'string') rows.push([at.key, at.value]);
          at.continue();
          return;
        }
        if (rows.length > 0 || legacy === null) return;
        const marker = store.get(COPIED + prefix);
        marker.onsuccess = () => {
          if (marker.result !== undefined) return;
          const copied = legacyEntries(legacy, prefix);
          if (copied.length === 0) return;
          for (const [key, value] of copied) { store.put(value, key); rows.push([key, value]); }
          store.put(new Date().toISOString(), COPIED + prefix);
        };
      };
    }),
    setItem: (key, value) => run<void>('readwrite', store => { store.put(value, key); }),
    removeItem: key => run<void>('readwrite', store => { store.delete(key); }),
    close: () => {
      closed = true;
      const pending = opening;
      opening = null;
      void pending?.then(db => db.close(), () => {});
    },
  };
}

/** Every key under `prefix` and its value in a web storage; nothing when it cannot be read. */
function legacyEntries(storage: Storage, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      const value = storage.getItem(key);
      if (value !== null) out.push([key, value]);
    }
  } catch { return []; }
  return out;
}

/** The keys under `prefix`, where the page has key ranges; null to scan them all. */
function keyRange(prefix: string): IDBKeyRange | null {
  const Range = (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
  try { return Range === undefined ? null : Range.bound(prefix, prefix + '\uffff'); } catch { return null; }
}

/** The page's `localStorage` as a full web storage, for the copy, or null. */
function pageStorage(): Storage | null {
  const store = defaultStorage() as Partial<Storage> | null;
  return store !== null && typeof store.key === 'function' && typeof store.length === 'number' ? store as Storage : null;
}

let shared: { factory: IDBFactory; store: AsyncStorageLike } | null = null;

/**
 * The store behind `persist` when the host names none: IndexedDB where the
 * page has it, one connection for every widget on the page, else the page's
 * `localStorage`, else null.
 */
export function defaultWidgetStore(): StorageLike | AsyncStorageLike | null {
  let factory: IDBFactory | undefined;
  // Reading the property alone throws in some sandboxed frames.
  try { factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined; } catch { factory = undefined; }
  if (factory === undefined || typeof factory.open !== 'function') return defaultStorage();
  if (shared === null || shared.factory !== factory) shared = { factory, store: orPageStorage(createIndexedDbWidgetStorage(factory)) };
  return shared.store;
}

/**
 * `idb`, or the page's `localStorage` when the database cannot be read at
 * all. A browser can offer `indexedDB` and refuse every open (turned off, or
 * in some private windows) while its `localStorage` works; such a page keeps
 * its layouts where every release before this one kept them, rather than
 * losing each session's changes. Decided once, by the first read: a database
 * that has answered is kept for the page, so one refused write never splits
 * a page's keys between two stores.
 */
function orPageStorage(idb: IndexedDbWidgetStorage): AsyncStorageLike {
  const page = pageStorage();
  if (page === null) return idb;
  let use: 'idb' | 'page' | null = null;
  const onPage = (write: () => void): Promise<void> => {
    try { write(); return Promise.resolve(); } catch (error) { return Promise.reject(error); }
  };
  return {
    journal: idb.journal,
    entries: prefix => use === 'page' ? Promise.resolve(legacyEntries(page, prefix)) : idb.entries(prefix).then(
      rows => { use = 'idb'; return rows; },
      (error: unknown) => {
        if (use === 'idb') throw error;
        use = 'page';
        return legacyEntries(page, prefix);
      }),
    setItem: (key, value) => use === 'page' ? onPage(() => page.setItem(key, value)) : idb.setItem(key, value),
    removeItem: key => use === 'page' ? onPage(() => page.removeItem(key)) : idb.removeItem(key),
  };
}
