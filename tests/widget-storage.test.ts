/**
 * Widget storage: the asynchronous contract (`load`, the write-behind, the
 * journal, `flush`), the IndexedDB store with its one-time copy from the
 * page's storage, the widget built over an asynchronous store (the saved
 * layout applied once the store answers, the first load held until then),
 * and the synchronous path a host keeps by passing its own `StorageLike`,
 * pinned call for call against the widget as it was.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { type Bar, type BarsRequest, type DataFeed } from '../src/index';
import {
  createWidget, createIndexedDbWidgetStorage, WidgetStorage, SAVE_DEBOUNCE_MS,
  type Widget, type WidgetOptions, type StorageLike, type WidgetStorageError,
} from '../src/widget/index';
import { fakeWidgetDocument, fakeContainer, ensureWindowGlobal, fire, type FakeDocument, type FakeElement } from './helpers/fake-dom-widget';
import { FakeIndexedDb } from './helpers/fake-indexeddb';
import { FakeAsyncStore, settle } from './helpers/fake-async-store';

beforeAll(ensureWindowGlobal);

const T0 = 1_700_000_000;
/** A seeded random walk, the shape of a real stock's five-minute bars. */
function walk(n: number, seed: number): Bar[] {
  let s = seed >>> 0;
  const rand = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  let close = 250;
  return Array.from({ length: n }, (_, i) => {
    const open = close;
    close = Math.max(1, open * (1 + (rand() - 0.5) * 0.012));
    const high = Math.max(open, close) * (1 + rand() * 0.004);
    const low = Math.min(open, close) * (1 - rand() * 0.004);
    return { time: T0 + i * 300, open, high, low, close, volume: Math.round(1000 + rand() * 9000) };
  });
}

const live: Widget[] = [];
afterEach(() => {
  for (const w of live.splice(0)) if (!w.isDestroyed) w.destroy();
  vi.useRealTimers();
});

function make(opts: WidgetOptions, doc: FakeDocument = fakeWidgetDocument()): Widget {
  const container = fakeContainer(doc);
  const w = createWidget(container as unknown as HTMLElement, {
    document: doc as unknown as Document,
    pixelRatio: () => 1,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    mobile: 'never',
    ...opts,
  });
  w.chart.applySize(800, 600);
  live.push(w);
  const root = w.root as unknown as FakeElement;
  root.rect = { left: 0, top: 0, width: 800, height: 600 };
  return w;
}

/** Every call the widget makes on the store, with the value it read or wrote. */
class RecordingStorage implements StorageLike {
  public readonly map = new Map<string, string>();
  public readonly calls: Array<[op: string, key: string, value: string | null]> = [];
  public getItem(k: string): string | null {
    const v = this.map.get(k) ?? null;
    this.calls.push(['get', k, v]);
    return v;
  }
  public setItem(k: string, v: string): void { this.calls.push(['set', k, v]); this.map.set(k, v); }
  public removeItem(k: string): void { this.calls.push(['remove', k, null]); this.map.delete(k); }
  /** The calls, each value reduced to the start of its SHA-256 so the pin stays readable. */
  public async log(): Promise<string[]> {
    const out: string[] = [];
    for (const [op, key, value] of this.calls) out.push(op === 'remove' ? `remove ${key}` : `${op} ${key} ${await digest(value)}`);
    return out;
  }
}

async function digest(v: string | null): Promise<string> {
  if (v === null) return 'null';
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/**
 * Two visits over one store: the first changes the interval, the chart type,
 * the theme and the symbol with a drawing on each instrument, and leaves by
 * the page going away and by destroy; the second opens on what was saved.
 */
async function scriptedSession(store: StorageLike, byDefault = false): Promise<void> {
  const storage = byDefault ? {} : { storage: store };
  const bars = walk(240, 7);
  const feed: DataFeed = { getBars: async () => bars };
  const listeners = new Map<string, Set<() => void>>();
  const doc = fakeWidgetDocument();
  (doc as unknown as { defaultView: unknown }).defaultView = {
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)); },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
  };
  const pagehide = (): void => { for (const fn of [...(listeners.get('pagehide') ?? [])]) fn(); };
  const line = (id: string, from: number, to: number) => ({
    id, tool: 'trend-line', paneIndex: 0, createdAt: T0 * 1000, style: {},
    points: [{ time: bars[from].time, price: bars[from].low }, { time: bars[to].time, price: bars[to].high }],
  });

  const a = make({ feed, persist: 'pin', ...storage, symbol: 'ALPHA', exchange: 'NSE', interval: '5m' }, doc);
  await vi.advanceTimersByTimeAsync(10);
  a.setInterval('15m');
  a.setChartType('line');
  a.setTheme('light');
  a.draw.add(line('pin-a', 20, 120));
  await vi.advanceTimersByTimeAsync(400);
  a.setSymbol('BETA');
  await vi.advanceTimersByTimeAsync(10);
  a.draw.add(line('pin-b', 40, 200));
  a.setInterval('1h');
  pagehide();
  a.destroy();

  const b = make({ feed, persist: 'pin', ...storage }, fakeWidgetDocument());
  await vi.advanceTimersByTimeAsync(10);
  expect([b.symbol(), b.interval(), b.chartType(), b.theme()]).toEqual(['BETA', '1h', 'line', 'light']);
  expect(b.draw.drawings().map(d => d.id)).toEqual(['pin-b']);
  b.setSymbol('ALPHA');
  await vi.advanceTimersByTimeAsync(10);
  expect(b.draw.drawings().map(d => d.id)).toEqual(['pin-a']);
  await vi.advanceTimersByTimeAsync(400);
  b.destroy();
}

describe('a synchronous store the host passes', () => {
  it('sees the same calls, in the same order, with the same values as before asynchronous storage', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = new RecordingStorage();
    await scriptedSession(store);
    expect(await store.log()).toEqual(SYNC_LOG);
  });

  it('is what a page without IndexedDB gets by default: its localStorage, as before', async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = new RecordingStorage();
    const g = globalThis as { localStorage?: StorageLike; indexedDB?: unknown };
    expect(g.indexedDB).toBeUndefined();
    g.localStorage = store;
    try {
      await scriptedSession(store, true);
    } finally { delete g.localStorage; }
    expect(await store.log()).toEqual(SYNC_LOG);
  });
});

// Recorded from the widget as it stood before asynchronous storage (2.5.9 plus
// the wave 1 split), with the session above.
const SYNC_LOG: readonly string[] = [
  'get oac-widget:pin:state null',
  'get oac-widget:pin:drawings:NSE:ALPHA null',
  'get oac-widget:pin:rail null',
  'get oac-widget:pin:rail null',
  'set oac-widget:pin:drawings:NSE:ALPHA dec3d03e62c9',
  'set oac-widget:pin:state a5ebfb281b33',
  'get oac-widget:pin:drawings:NSE:BETA null',
  'set oac-widget:pin:drawings:NSE:BETA 37916dec368c',
  'set oac-widget:pin:state 19cc3dedd981',
  'set oac-widget:pin:state 19cc3dedd981',
  'get oac-widget:pin:state 19cc3dedd981',
  'get oac-widget:pin:drawings:NSE:BETA 37916dec368c',
  'get oac-widget:pin:drawings:NSE:BETA 37916dec368c',
  'get oac-widget:pin:rail null',
  'get oac-widget:pin:rail null',
  'set oac-widget:pin:rail bebd1f203d89',
  'get oac-widget:pin:drawings:NSE:ALPHA dec3d03e62c9',
  'set oac-widget:pin:state 7437d2c17f93',
  'set oac-widget:pin:state 7437d2c17f93',
];

// ── the asynchronous contract ──────────────────────────────────────────

class MemoryStorage implements StorageLike {
  public readonly map = new Map<string, string>();
  public getItem(k: string): string | null { return this.map.get(k) ?? null; }
  public setItem(k: string, v: string): void { this.map.set(k, v); }
  public removeItem(k: string): void { this.map.delete(k); }
}

describe('WidgetStorage over an asynchronous store', () => {
  it('reads its namespace once, and answers later reads from memory', async () => {
    const store = new FakeAsyncStore();
    store.map.set('oac-widget:a:state', '{"v":1}');
    store.map.set('oac-widget:b:state', '{"v":2}');
    const storage = new WidgetStorage('a', store);
    expect(storage.enabled).toBe(true);
    expect(storage.loaded).toBe(false);
    expect(storage.get('state')).toBeNull();
    await Promise.all([storage.load(), storage.load()]);
    expect(storage.loaded).toBe(true);
    expect(storage.get('state')).toEqual({ v: 1 });
    expect(store.calls).toEqual(['entries oac-widget:a:']);
    store.map.set('oac-widget:a:state', '{"v":9}');
    expect(storage.get('state')).toEqual({ v: 1 });
  });

  it('holds a change made before the read, then lets it win over the stored value', async () => {
    const store = new FakeAsyncStore();
    store.map.set('oac-widget:a:state', '{"v":1}');
    store.hold = true;
    const storage = new WidgetStorage('a', store);
    expect(storage.set('state', { v: 2 })).toBe(true);
    expect(storage.get('state')).toEqual({ v: 2 });
    await settle();
    // Only the read has gone out: a write now could land under it.
    expect(store.calls).toEqual(['entries oac-widget:a:']);
    store.release();
    await settle();
    store.release();
    await storage.flush();
    expect(storage.get('state')).toEqual({ v: 2 });
    expect(store.map.get('oac-widget:a:state')).toBe('{"v":2}');
  });

  it('coalesces the changes to one key within a task into one write', async () => {
    const store = new FakeAsyncStore();
    const storage = new WidgetStorage('a', store);
    await storage.load();
    storage.set('rail', { n: 1 });
    storage.set('rail', { n: 2 });
    storage.set('state', { n: 1 });
    storage.set('rail', { n: 3 });
    await storage.flush();
    expect(store.writes()).toEqual(['set oac-widget:a:rail {"n":3}', 'set oac-widget:a:state {"n":1}']);
    storage.remove('rail');
    await storage.flush();
    expect(store.writes().slice(-1)[0]).toBe('remove oac-widget:a:rail');
    expect(store.map.has('oac-widget:a:rail')).toBe(false);
    expect(storage.get('rail')).toBeNull();
  });

  it('never sends a key again while its last write is out, so the newer value lands last', async () => {
    const store = new FakeAsyncStore();
    const storage = new WidgetStorage('a', store);
    await storage.load();
    store.hold = true;
    storage.set('state', { n: 1 });
    await settle();
    storage.set('state', { n: 2 });
    await settle();
    expect(store.writes()).toEqual(['set oac-widget:a:state {"n":1}']);
    store.release();
    await settle();
    expect(store.writes()).toEqual(['set oac-widget:a:state {"n":1}', 'set oac-widget:a:state {"n":2}']);
    store.release();
    await storage.flush();
    expect(store.map.get('oac-widget:a:state')).toBe('{"n":2}');
  });

  it('reports a refused write, keeps the value, and sends it again with the next flush', async () => {
    const store = new FakeAsyncStore();
    const errors: WidgetStorageError[] = [];
    const storage = new WidgetStorage('a', store, { onError: e => errors.push(e) });
    await storage.load();
    store.failWrites = new Error('quota exceeded');
    storage.set('state', { n: 1 });
    await settle();
    expect(errors.map(e => [e.operation, e.key, (e.error as Error).message])).toEqual([['write', 'oac-widget:a:state', 'quota exceeded']]);
    expect(storage.get('state')).toEqual({ n: 1 });
    store.failWrites = null;
    await storage.flush();
    expect(store.map.get('oac-widget:a:state')).toBe('{"n":1}');
    expect(errors).toHaveLength(1);
  });

  it('runs on memory alone when the namespace cannot be read, rather than write over it', async () => {
    const store = new FakeAsyncStore();
    store.map.set('oac-widget:a:state', '{"v":1}');
    store.failEntries = new Error('the database is gone');
    const errors: WidgetStorageError[] = [];
    const storage = new WidgetStorage('a', store, { onError: e => errors.push(e) });
    await storage.load();
    expect(storage.loaded).toBe(true);
    expect(errors.map(e => [e.operation, e.key])).toEqual([['load', 'oac-widget:a:']]);
    storage.set('state', { v: 2 });
    await storage.flush();
    expect(storage.get('state')).toEqual({ v: 2 });
    expect(store.writes()).toEqual([]);
    expect(store.map.get('oac-widget:a:state')).toBe('{"v":1}');
  });

  it('gives up on a store that never answers, so the widget is not held forever', async () => {
    vi.useFakeTimers();
    const store = new FakeAsyncStore();
    store.silent = true;
    const errors: WidgetStorageError[] = [];
    const storage = new WidgetStorage('a', store, { onError: e => errors.push(e) });
    let done = false;
    void storage.load().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    expect(errors.map(e => e.operation)).toEqual(['load']);
  });

  it('journals the writes not landed yet when flushed, and drops the journal once they land', async () => {
    const store = new FakeAsyncStore();
    const journal = new MemoryStorage();
    store.journal = journal;
    const storage = new WidgetStorage('a', store);
    await storage.load();
    store.hold = true;
    storage.set('state', { n: 1 });
    await settle();
    storage.set('state', { n: 2 });
    storage.set('rail', { r: 1 });
    const flushed = storage.flush();
    // Synchronous, as the page going away needs it: what is out and what is not sent yet.
    expect(JSON.parse(journal.map.get('oac-widget-journal:a')!)).toEqual({
      version: 1, entries: { 'oac-widget:a:state': '{"n":2}', 'oac-widget:a:rail': '{"r":1}' },
    });
    store.release();
    await settle();
    store.release();
    await flushed;
    expect(journal.map.has('oac-widget-journal:a')).toBe(false);
    expect(store.map.get('oac-widget:a:state')).toBe('{"n":2}');
  });

  it('replays the journal the last page left over the store, writes it through, then drops it', async () => {
    const store = new FakeAsyncStore();
    const journal = new MemoryStorage();
    store.journal = journal;
    store.map.set('oac-widget:a:state', '{"v":"old"}');
    store.map.set('oac-widget:a:gone', '{"v":1}');
    journal.setItem('oac-widget-journal:a', JSON.stringify({ version: 1, entries: {
      'oac-widget:a:state': '{"v":"new"}', 'oac-widget:a:gone': null, 'oac-widget:b:state': '{"v":"other"}',
    } }));
    const storage = new WidgetStorage('a', store);
    await storage.load();
    expect(storage.get('state')).toEqual({ v: 'new' });
    expect(storage.get('gone')).toBeNull();
    await storage.flush();
    expect(store.map.get('oac-widget:a:state')).toBe('{"v":"new"}');
    expect(store.map.has('oac-widget:a:gone')).toBe(false);
    // Another namespace's entry is not this one's to write.
    expect(store.map.has('oac-widget:b:state')).toBe(false);
    expect(journal.map.has('oac-widget-journal:a')).toBe(false);
  });

  it('lets a change made before the read win over the journal as well', async () => {
    const store = new FakeAsyncStore();
    const journal = new MemoryStorage();
    store.journal = journal;
    journal.setItem('oac-widget-journal:a', JSON.stringify({ version: 1, entries: { 'oac-widget:a:state': '{"v":"journal"}' } }));
    const storage = new WidgetStorage('a', store);
    storage.set('state', { v: 'mine' });
    await storage.load();
    await storage.flush();
    expect(storage.get('state')).toEqual({ v: 'mine' });
    expect(store.map.get('oac-widget:a:state')).toBe('{"v":"mine"}');
  });

  it('keeps an unread journal when the page goes away again before the read', () => {
    const store = new FakeAsyncStore();
    const journal = new MemoryStorage();
    store.journal = journal;
    store.hold = true;
    journal.setItem('oac-widget-journal:a', JSON.stringify({ version: 1, entries: { 'oac-widget:a:state': '{"v":"last page"}' } }));
    const storage = new WidgetStorage('a', store);
    storage.set('rail', { r: 1 });
    void storage.flush();
    expect(JSON.parse(journal.map.get('oac-widget-journal:a')!).entries).toEqual({
      'oac-widget:a:state': '{"v":"last page"}', 'oac-widget:a:rail': '{"r":1}',
    });
  });

  it('goes straight through a synchronous store, where load and flush settle at once', async () => {
    const store = new MemoryStorage();
    const storage = new WidgetStorage('a', store);
    expect(storage.loaded).toBe(true);
    storage.set('state', { n: 1 });
    expect(store.map.get('oac-widget:a:state')).toBe('{"n":1}');
    await storage.load();
    await storage.flush();
    expect(new WidgetStorage('a', null).enabled).toBe(false);
  });
});

// ── the IndexedDB store ────────────────────────────────────────────────

/** The page's storage as the copy reads it: a full web storage. */
class PageStorage extends MemoryStorage {
  public get length(): number { return this.map.size; }
  public key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  public clear(): void { this.map.clear(); }
}

const idbStore = (db: FakeIndexedDb, options: { journal?: StorageLike | null; migrateFrom?: PageStorage | null } = {}) =>
  createIndexedDbWidgetStorage(db as unknown as IDBFactory, 'test-widget', {
    journal: options.journal ?? null, migrateFrom: (options.migrateFrom ?? null) as unknown as Storage | null,
  });

describe('createIndexedDbWidgetStorage', () => {
  it('keeps each key in one object store and lists a namespace by prefix', async () => {
    const db = new FakeIndexedDb();
    const store = idbStore(db);
    await store.setItem('oac-widget:a:state', '{"n":1}');
    await store.setItem('oac-widget:a:rail', '{"r":1}');
    await store.setItem('oac-widget:ab:state', '{"n":2}');
    await store.removeItem('oac-widget:a:rail');
    expect(await store.entries('oac-widget:a:')).toEqual([['oac-widget:a:state', '{"n":1}']]);
    expect([...db.records('test-widget')]).toEqual([['oac-widget:a:state', '{"n":1}'], ['oac-widget:ab:state', '{"n":2}']]);
    expect(db.opens).toBe(1);
  });

  it('copies what an earlier release left in the page storage into an empty namespace, once', async () => {
    const db = new FakeIndexedDb();
    const page = new PageStorage();
    page.setItem('oac-widget:desk:state', '{"symbol":"INFY"}');
    page.setItem('oac-widget:desk:drawings:NSE:INFY', '{"version":2,"drawings":[]}');
    page.setItem('oac-widget:other:state', '{"symbol":"TCS"}');
    page.setItem('host-key', 'x');
    const store = idbStore(db, { migrateFrom: page });
    expect(await store.entries('oac-widget:desk:')).toEqual([
      ['oac-widget:desk:state', '{"symbol":"INFY"}'], ['oac-widget:desk:drawings:NSE:INFY', '{"version":2,"drawings":[]}'],
    ]);
    const records = db.records('test-widget');
    expect(records.get('oac-widget:desk:state')).toBe('{"symbol":"INFY"}');
    expect(records.has('oac-widget:other:state')).toBe(false);
    expect(records.has('host-key')).toBe(false);
    // Left where it was, for an earlier release or a host going back to it.
    expect(page.getItem('oac-widget:desk:state')).toBe('{"symbol":"INFY"}');
    // Emptied later, the namespace is not filled again from the old copy.
    await store.removeItem('oac-widget:desk:state');
    await store.removeItem('oac-widget:desk:drawings:NSE:INFY');
    expect(await store.entries('oac-widget:desk:')).toEqual([]);
  });

  it('copies nothing into a namespace that already holds keys', async () => {
    const db = new FakeIndexedDb();
    const page = new PageStorage();
    page.setItem('oac-widget:desk:state', '{"symbol":"OLD"}');
    const store = idbStore(db, { migrateFrom: page });
    await store.setItem('oac-widget:desk:state', '{"symbol":"NEW"}');
    expect(await store.entries('oac-widget:desk:')).toEqual([['oac-widget:desk:state', '{"symbol":"NEW"}']]);
  });

  it('lets another tab upgrade or delete the database, and opens again on the next call', async () => {
    const db = new FakeIndexedDb();
    const store = idbStore(db);
    await store.setItem('oac-widget:a:state', '1');
    db.versionChange();
    expect(db.connections[0].closed).toBe(true);
    await store.setItem('oac-widget:a:state', '2');
    expect(db.opens).toBe(2);
    expect(db.records('test-widget').get('oac-widget:a:state')).toBe('2');
  });

  it('rejects a call it cannot open for, and every call once closed', async () => {
    const db = new FakeIndexedDb();
    db.failOpen = new Error('SecurityError');
    const store = idbStore(db);
    await expect(store.entries('oac-widget:a:')).rejects.toThrow('SecurityError');
    db.failOpen = null;
    expect(await store.entries('oac-widget:a:')).toEqual([]);
    store.close();
    await expect(store.setItem('oac-widget:a:state', '1')).rejects.toThrow('closed');
  });

  it('carries the journal it was given, the page storage by default', () => {
    const journal = new MemoryStorage();
    expect(idbStore(new FakeIndexedDb(), { journal }).journal).toBe(journal);
    // No page storage in this runtime, so no journal.
    expect(createIndexedDbWidgetStorage(new FakeIndexedDb() as unknown as IDBFactory).journal).toBeNull();
  });
});

// ── the widget over an asynchronous store ──────────────────────────────

/** A feed that records every request, answering each with the same walk. */
function recordingFeed(bars = walk(240, 11)): { feed: DataFeed; requests: BarsRequest[] } {
  const requests: BarsRequest[] = [];
  return { requests, feed: { getBars: async request => { requests.push(request); return bars; } } };
}

const instrumentsAsked = (requests: readonly BarsRequest[]): string[] => requests.map(r => `${r.symbol} ${r.interval}`);

/**
 * A first visit on a synchronous store, left the way a user leaves it: an
 * instrument, an interval, a chart type, a theme, rail preferences, the data
 * panel open and a line on the chart. What it saved, copied into an
 * asynchronous store, is what the next visit opens on.
 */
async function savedVisit(): Promise<{ store: FakeAsyncStore; state: ReturnType<Widget['getState']>; lineId: string }> {
  const sync = new MemoryStorage();
  const { feed } = recordingFeed();
  const w = make({ feed, persist: 'desk', storage: sync, symbol: 'SAVED', exchange: 'NSE', interval: '15m' });
  await settle();
  w.setChartType('line');
  w.setTheme('light');
  w.restoreState({ ...w.getState(), rail: { favorites: ['trend-line'], magnet: 'strong', stay: true, last: {} } });
  w.openDataWindow();
  await settle();
  const bars = w.series.getData();
  const lineId = w.draw.add({ tool: 'trend-line', paneIndex: 0, style: { color: '#ff00ff' },
    points: [{ time: bars[30].time, price: bars[30].low }, { time: bars[180].time, price: bars[180].high }] }).id;
  const state = w.getState();
  w.destroy();
  const store = new FakeAsyncStore();
  for (const [k, v] of sync.map) store.map.set(k, v);
  return { store, state, lineId };
}

describe('the widget over an asynchronous store', () => {
  it('builds on the defaults out of sight, holds the first load, then opens on what was saved', async () => {
    const { store, state, lineId } = await savedVisit();
    store.hold = true;
    const { feed, requests } = recordingFeed();
    const w = make({ feed, persist: 'desk', storage: store });
    const root = w.root as unknown as FakeElement;
    await settle();
    expect(w.symbol()).toBe('');
    expect(w.theme()).toBe('dark');
    expect((root.style as unknown as { visibility: string }).visibility).toBe('hidden');
    // Nothing went out for the default instrument while the store had not answered.
    expect(requests).toEqual([]);
    let ready = false;
    void w.ready.then(() => { ready = true; });
    await settle();
    expect(ready).toBe(false);
    store.release();
    await w.ready;
    await settle();
    expect((root.style as unknown as { visibility: string }).visibility).toBe('');
    expect([w.symbol(), w.exchange(), w.interval(), w.chartType(), w.theme()]).toEqual(['SAVED', 'NSE', '15m', 'line', 'light']);
    expect(instrumentsAsked(requests)).toEqual(['SAVED 15m']);
    const now = w.getState();
    expect(now.rail).toEqual(state.rail);
    expect(now.panels).toEqual(state.panels);
    expect(w.draw.drawings().map(d => d.id)).toEqual([lineId]);
    expect(w.history.canUndo()).toBe(false);
  });

  it('keeps what the host passed as options, and drops a saved view taken on other bars', async () => {
    const { store } = await savedVisit();
    const { feed, requests } = recordingFeed();
    const w = make({ feed, persist: 'desk', storage: store, symbol: 'OTHER', theme: 'dark' });
    await w.ready;
    await settle();
    expect([w.symbol(), w.interval(), w.chartType(), w.theme()]).toEqual(['OTHER', '15m', 'line', 'dark']);
    expect(instrumentsAsked(requests)).toEqual(['OTHER 15m']);
    // The saved line belongs to the saved instrument, not this one.
    expect(w.draw.drawings()).toEqual([]);
  });

  it('lets a symbol the user picked before the store answered win over the saved one', async () => {
    const { store } = await savedVisit();
    store.hold = true;
    const { feed, requests } = recordingFeed();
    const w = make({ feed, persist: 'desk', storage: store });
    const symbols: string[] = [];
    w.on('symbol', e => symbols.push(e.symbol));
    w.setSymbol('MINE');
    await settle();
    expect(requests).toEqual([]);
    store.release();
    await w.ready;
    await settle();
    expect([w.symbol(), w.interval()]).toEqual(['MINE', '15m']);
    expect(instrumentsAsked(requests)).toEqual(['MINE 15m']);
    expect(symbols).toEqual(['MINE']);
  });

  it('announces the saved instrument and interval once they land', async () => {
    const { store } = await savedVisit();
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store });
    const seen: string[] = [];
    w.on('symbol', e => seen.push(`symbol ${e.symbol}`));
    w.on('interval', e => seen.push(`interval ${e.interval}`));
    w.on('layout', e => seen.push(`layout ${e.reason}`));
    await w.ready;
    expect(seen).toContain('symbol SAVED');
    expect(seen).toContain('interval 15m');
    expect(seen.slice(-1)[0]).toBe('layout restore');
  });

  it('writes nothing before the store answers, and afterwards only a change made meanwhile', async () => {
    vi.useFakeTimers();
    const { store } = await savedVisit();
    const stored = store.map.get('oac-widget:desk:state');
    store.hold = true;
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store });
    w.setInterval('1h');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(store.writes()).toEqual([]);
    store.hold = false;
    store.release();
    await w.ready;
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    const saved = JSON.parse(store.map.get('oac-widget:desk:state')!);
    expect(saved.interval).toBe('1h');
    expect(saved.symbol).toBe('SAVED');
    expect(stored).not.toBe(store.map.get('oac-widget:desk:state'));
  });

  it('writes no layout at all when nothing changed while the store was read', async () => {
    vi.useFakeTimers();
    const { store } = await savedVisit();
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store });
    await w.ready;
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(store.writes().filter(c => c.startsWith('set oac-widget:desk:state'))).toEqual([]);
  });

  it('keeps a saved layout it refuses, as it does over a synchronous store', async () => {
    vi.useFakeTimers();
    const store = new FakeAsyncStore();
    const refused = JSON.stringify({ version: 1, symbol: 'SAVED', exchange: 'NSE', interval: '15m', chartType: 'candlestick', theme: 'dark',
      chart: { version: 99 }, rail: null });
    store.map.set('oac-widget:desk:state', refused);
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store });
    await w.ready;
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 4);
    expect(w.symbol()).toBe('SAVED');
    expect(store.map.get('oac-widget:desk:state')).toBe(refused);
  });

  it('opens on the defaults and says so when the store cannot be read', async () => {
    const store = new FakeAsyncStore();
    store.failEntries = new Error('the database is gone');
    const { feed, requests } = recordingFeed();
    const statuses: string[] = [];
    const w = make({ feed, persist: 'desk', storage: store, symbol: 'DEFAULT' });
    w.on('status', e => statuses.push(`${e.kind} ${e.text}`));
    await w.ready;
    await settle();
    const text = 'Saved chart settings could not be read, so changes are kept for this session only: the database is gone';
    expect(statuses[0]).toBe(`error ${text}`);
    expect(instrumentsAsked(requests)).toEqual(['DEFAULT 1d']);
    // The first load's own messages take the status line over at once, so the
    // failure is raised as a toast as well, the way a failed load is.
    expect(statuses.slice(-1)[0]).toBe('info 240 bars');
    const toast = (w.root as unknown as FakeElement).querySelector('.oac-toast__msg');
    expect(toast?.textContent).toBe(text);
  });

  it('puts a write the store refused on the status line', async () => {
    vi.useFakeTimers();
    const store = new FakeAsyncStore();
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store, symbol: 'ONE' });
    await w.ready;
    const statuses: string[] = [];
    w.on('status', e => statuses.push(`${e.kind} ${e.text}`));
    store.failWrites = new Error('quota exceeded');
    w.setInterval('1h');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(statuses).toContain('error Saved chart settings could not be written: quota exceeded');
  });

  it('journals the pending layout when the page goes away', async () => {
    vi.useFakeTimers();
    const store = new FakeAsyncStore();
    const journal = new MemoryStorage();
    store.journal = journal;
    const listeners = new Map<string, Set<() => void>>();
    const doc = fakeWidgetDocument();
    (doc as unknown as { defaultView: unknown }).defaultView = {
      addEventListener: (type: string, fn: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)); },
      removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    };
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store, symbol: 'ONE' }, doc);
    await w.ready;
    store.hold = true;
    w.setInterval('1h');
    // Still inside the debounce: only the page going away writes it now.
    expect(journal.map.size).toBe(0);
    for (const fn of listeners.get('pagehide') ?? []) fn();
    const entries = JSON.parse(journal.map.get('oac-widget-journal:desk')!).entries as Record<string, string>;
    expect(JSON.parse(entries['oac-widget:desk:state']).interval).toBe('1h');
    w.destroy();
    expect(listeners.get('pagehide')?.size ?? 0).toBe(0);
  });

  it('writes the pending layout when the page is hidden, which a phone may close without a pagehide', async () => {
    vi.useFakeTimers();
    const store = new FakeAsyncStore();
    const doc = fakeWidgetDocument();
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store, symbol: 'ONE' }, doc);
    await w.ready;
    w.setInterval('1h');
    (doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    fire(doc, 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(store.map.get('oac-widget:desk:state')!).interval).toBe('1h');
  });

  it('applies and writes nothing when destroyed before the store answers', async () => {
    const { store } = await savedVisit();
    store.hold = true;
    const { feed, requests } = recordingFeed();
    const w = make({ feed, persist: 'desk', storage: store });
    w.setInterval('1h');
    w.destroy();
    // The read is out and held: answered now, it is what a slow store does.
    await settle();
    expect(store.calls).toEqual(['entries oac-widget:desk:']);
    store.release();
    await w.ready;
    await settle();
    store.release();
    await settle();
    expect(w.context.storage.loaded).toBe(true);
    expect(requests).toEqual([]);
    expect(store.writes()).toEqual([]);
  });

  it('lets a whole state the host restores before the store answers win over the stored one', async () => {
    const { store } = await savedVisit();
    store.hold = true;
    const { feed, requests } = recordingFeed();
    const w = make({ feed, persist: 'desk', storage: store });
    const given = w.getState();
    const report = w.restoreState({ ...given, symbol: 'GIVEN', exchange: 'BSE', interval: '5m' });
    expect(report.applied).toBe(true);
    await settle();
    expect(store.calls).toEqual(['entries oac-widget:desk:']);
    store.release();
    await w.ready;
    await settle();
    expect([w.symbol(), w.exchange(), w.interval(), w.chartType(), w.theme()]).toEqual(['GIVEN', 'BSE', '5m', 'candlestick', 'dark']);
    expect(instrumentsAsked(requests)).toEqual(['GIVEN 5m']);
  });

  it('brings back each instrument its own drawings, and moves a layout saved before them to its instrument', async () => {
    const { store, lineId } = await savedVisit();
    // The older record: one drawing set inside the layout, no entry per instrument.
    const state = JSON.parse(store.map.get('oac-widget:desk:state')!);
    const drawings = JSON.parse(store.map.get('oac-widget:desk:drawings:NSE:SAVED')!);
    store.map.delete('oac-widget:desk:drawings:NSE:SAVED');
    store.map.set('oac-widget:desk:state', JSON.stringify({ ...state, chart: { ...state.chart, drawings } }));
    const w = make({ feed: recordingFeed().feed, persist: 'desk', storage: store, symbol: 'ELSE' });
    await w.ready;
    await settle();
    expect(w.draw.drawings()).toEqual([]);
    w.setSymbol('SAVED');
    await settle();
    expect(w.draw.drawings().map(d => d.id)).toEqual([lineId]);
    await w.context.storage.flush();
    expect(JSON.parse(store.map.get('oac-widget:desk:drawings:NSE:SAVED')!).drawings.map((d: { id: string }) => d.id)).toEqual([lineId]);
  });

  it('waits for the saved layout before a reload or a go-to it is asked for early', async () => {
    const { store } = await savedVisit();
    store.hold = true;
    const { feed, requests } = recordingFeed();
    const w = make({ feed, persist: 'desk', storage: store, symbol: 'EARLY' });
    const reload = w.reload();
    await settle();
    expect(requests).toEqual([]);
    store.release();
    await reload;
    expect(instrumentsAsked(requests)).toEqual(['EARLY 15m']);
    expect(w.series.getData().length).toBeGreaterThan(0);
  });

  it('uses IndexedDB when the page has it and the host names no store, copying the old localStorage layout in', async () => {
    const g = globalThis as { indexedDB?: unknown; localStorage?: unknown };
    const db = new FakeIndexedDb();
    const page = new PageStorage();
    const { store } = await savedVisit();
    for (const [k, v] of store.map) page.setItem(k, v);
    g.indexedDB = db;
    g.localStorage = page;
    try {
      const { feed, requests } = recordingFeed();
      const w = make({ feed, persist: 'desk' });
      expect(w.context.storage.loaded).toBe(false);
      await w.ready;
      await settle();
      expect([w.symbol(), w.interval(), w.chartType(), w.theme()]).toEqual(['SAVED', '15m', 'line', 'light']);
      expect(instrumentsAsked(requests)).toEqual(['SAVED 15m']);
      expect(db.records('openalgo-charts-widget').get('oac-widget:desk:state')).toBe(page.getItem('oac-widget:desk:state'));
      w.setInterval('1h');
      w.destroy();
      await w.context.storage.flush();
      expect(JSON.parse(db.records('openalgo-charts-widget').get('oac-widget:desk:state') as string).interval).toBe('1h');
      // The old copy stays as the earlier release left it.
      expect(JSON.parse(page.getItem('oac-widget:desk:state')!).interval).toBe('15m');
    } finally {
      delete g.indexedDB;
      delete g.localStorage;
    }
  });

  it('stays on localStorage, as before, on a page whose IndexedDB cannot be opened', async () => {
    vi.useFakeTimers();
    const g = globalThis as { indexedDB?: unknown; localStorage?: unknown };
    const db = new FakeIndexedDb();
    db.failOpen = new Error('InvalidStateError: IndexedDB is off in this window');
    const page = new PageStorage();
    const { store } = await savedVisit();
    for (const [k, v] of store.map) page.setItem(k, v);
    g.indexedDB = db;
    g.localStorage = page;
    try {
      const { feed, requests } = recordingFeed();
      const w = make({ feed, persist: 'desk' });
      const statuses: string[] = [];
      w.on('status', e => statuses.push(`${e.kind} ${e.text}`));
      await w.ready;
      await vi.advanceTimersByTimeAsync(10);
      expect([w.symbol(), w.interval(), w.chartType(), w.theme()]).toEqual(['SAVED', '15m', 'line', 'light']);
      expect(instrumentsAsked(requests)).toEqual(['SAVED 15m']);
      // Nothing to report: the layout is kept where it always was.
      expect(statuses.filter(s => s.startsWith('error'))).toEqual([]);
      w.setInterval('1h');
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
      expect(JSON.parse(page.getItem('oac-widget:desk:state')!).interval).toBe('1h');
      // A second chart on the page asks the database no more.
      const opens = db.opens;
      const other = make({ feed, persist: 'other' });
      await other.ready;
      expect(db.opens).toBe(opens);
    } finally {
      delete g.indexedDB;
      delete g.localStorage;
    }
  });
});
