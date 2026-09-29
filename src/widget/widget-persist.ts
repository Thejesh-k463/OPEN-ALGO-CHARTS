/**
 * The shell's persisted state: the saved layout read before the shell is
 * built and applied once it is, each instrument's drawings kept beside it,
 * the debounced write after a change and the flush when the page goes away,
 * and `restoreState` applying a state a host kept.
 *
 * Its own module so persistence can grow (an asynchronous store, a layouts
 * catalog) while widget.ts stays under its line cap. The functions reach the
 * shell through `PersistHost`. The shell itself is the host: each member
 * carries the name and the type of the shell's own, so the moved code reads
 * as it did in widget.ts, and a member the shell renames or retypes fails to
 * compile here. The tier entry exports none of it: the names hosts import
 * (`stripView` and the storage constants) stay declared in widget.ts.
 * `_scheduleSave` and `_saveNow` stay on the shell as one-line delegates,
 * because every change the shell follows schedules a save and `destroy`
 * writes the last one, and the timer's callback here calls back through them.
 */
import {
  dataVariantKey, isKnownInterval, normalizeDataVariant, registeredChartTypes,
  type DataVariant, type RestoreReport,
} from 'openalgo-charts';
import { InstrumentDrawings, instrumentDrawingsKey, memoryDrawingStore, migrateUnscopedDrawings, type DrawingDocumentStore } from 'openalgo-charts/draw';
import { widgetText } from './localization';
import { sanitizePanelDockState } from './panel-dock';
import type { RailPrefs } from './rail';
import type {
  WidgetChartState, WidgetImpl, WidgetRestoreReport, WidgetState,
  DRAWINGS_KEY_PREFIX as DrawingsKeyPrefix, SAVE_DEBOUNCE_MS as SaveDebounceMs, STATE_KEY as StateKey, WIDGET_STATE_VERSION as StateVersion,
} from './widget';

// widget.ts declares these for hosts and imports this module, so reading them
// from there at run time would be an import cycle. Each copy is typed as its
// public constant's literal, so the two cannot drift apart without a compile
// error.
const SAVE_DEBOUNCE_MS: typeof SaveDebounceMs = 250;
const STATE_KEY: typeof StateKey = 'state';
const DRAWINGS_KEY_PREFIX: typeof DrawingsKeyPrefix = 'drawings:';
const WIDGET_STATE_VERSION: typeof StateVersion = 1;

/** The slice of the shell the persistence reads and drives. */
export interface PersistHost {
  readonly chart: WidgetImpl['chart'];
  readonly draw: WidgetImpl['draw'];
  readonly instrumentDrawings: WidgetImpl['instrumentDrawings'];
  readonly context: WidgetImpl['context'];
  readonly _doc: WidgetImpl['_doc'];
  readonly _opts: WidgetImpl['_opts'];
  readonly _bus: WidgetImpl['_bus'];
  readonly _storage: WidgetImpl['_storage'];
  readonly _toasts: WidgetImpl['_toasts'];
  readonly _series: WidgetImpl['_series'];
  readonly _rail: WidgetImpl['_rail'];
  readonly _topbar: WidgetImpl['_topbar'];
  readonly _statusline: WidgetImpl['_statusline'];
  readonly _mobile: WidgetImpl['_mobile'];
  readonly _dock: WidgetImpl['_dock'];
  readonly _destroyed: WidgetImpl['_destroyed'];
  readonly _cleanups: WidgetImpl['_cleanups'];
  _symbol: WidgetImpl['_symbol'];
  _exchange: WidgetImpl['_exchange'];
  _interval: WidgetImpl['_interval'];
  _variant: WidgetImpl['_variant'];
  _keepView: WidgetImpl['_keepView'];
  _pendingView: WidgetImpl['_pendingView'];
  _saveTimer: WidgetImpl['_saveTimer'];
  readonly getState: WidgetImpl['getState'];
  readonly chartType: WidgetImpl['chartType'];
  readonly setTheme: WidgetImpl['setTheme'];
  readonly setChartType: WidgetImpl['setChartType'];
  readonly reload: WidgetImpl['reload'];
  readonly _cancelNavigation: WidgetImpl['_cancelNavigation'];
  readonly _publishDataContext: WidgetImpl['_publishDataContext'];
  readonly _scheduleSave: WidgetImpl['_scheduleSave'];
  readonly _saveNow: WidgetImpl['_saveNow'];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A stored variant: undefined for the default series, null for one this build
 * cannot read. That one falls back to the default series rather than failing
 * the widget, and its saved view is dropped, since it was taken on other bars.
 */
function savedVariant(value: unknown): Readonly<DataVariant> | undefined | null {
  try { return normalizeDataVariant(value); } catch { return null; }
}

/**
 * The body of the public `stripView`, which widget.ts declares, documents
 * and delegates here, so a saved layout can be read without importing
 * widget.ts at run time.
 */
export function stripView(state: WidgetChartState): WidgetChartState {
  const out = { ...state } as Record<string, unknown>;
  delete out.viewport;
  delete out.barSpacing;
  const clearScaleView = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const scale = { ...value, autoScale: true } as Record<string, unknown>;
    delete scale.range;
    delete scale.ratioLock;
    return scale;
  };
  if (Array.isArray(out.panes)) {
    out.panes = (out.panes as unknown[]).map((pane) => {
      if (!isRecord(pane)) return pane;
      const next = { ...pane };
      if (isRecord(pane.priceScale)) next.priceScale = clearScaleView(pane.priceScale);
      if (isRecord(pane.scales)) next.scales = Object.fromEntries(
        Object.entries(pane.scales).map(([id, scale]) => [id, clearScaleView(scale)]),
      );
      return next;
    });
  }
  return out as unknown as WidgetChartState;
}

/**
 * The saved layout, onto the dataset it belongs to: its view only on the
 * symbol, interval and variant it was saved on, then its rail preferences
 * and panels. Runs once the chrome is built.
 */
export function applySavedLayout(w: PersistHost, saved: WidgetState | null): void {
  if (saved?.chart !== undefined) {
    const same = saved.symbol === w._symbol && saved.exchange === w._exchange && saved.interval === w._interval
      && dataVariantKey(saved.variant) === dataVariantKey(w._variant);
    let layout = same ? saved.chart : stripView(saved.chart);
    // The layout's own drawings were attached to its instrument by
    // `scopeDrawings`; the chart keeps the ones the current instrument has,
    // already on it. A layout that names no instrument has nowhere else to
    // keep them, so they land as they always did and go to the first
    // instrument charted.
    if (w.instrumentDrawings !== null && savedKey(saved) !== null) layout = { ...layout, drawings: w.draw.toJSON() };
    const report = w.chart.restoreState(layout);
    if (report.applied) {
      w._keepView = same;
      w._pendingView = same ? saved.chart.viewport ?? null : null;
    } else {
      w._toasts.toast(widgetText(w.context, 'The saved layout could not be restored: {error}', { error: report.reason ?? 'unknown reason' }), 'error');
    }
  }
  if (saved?.rail && w._rail !== null) w._rail.restorePrefs(saved.rail);
  if (saved?.panels) w._dock?.restore(saved.panels);
}

/**
 * Drawings per instrument, from the store the host named or the one the
 * persisted layout sits in. A layout saved before drawings were per
 * instrument holds the drawings of the instrument it was saved on, which
 * are attached to that instrument here, so opening on another symbol
 * neither shows them there nor loses them.
 */
export function scopeDrawings(w: PersistHost, saved: WidgetState | null): InstrumentDrawings {
  const storage = w._storage;
  const store: DrawingDocumentStore = w._opts.drawingStore ?? (storage.enabled ? {
    get: key => storage.get(DRAWINGS_KEY_PREFIX + key),
    set: (key, document) => storage.set(DRAWINGS_KEY_PREFIX + key, document),
    remove: key => storage.remove(DRAWINGS_KEY_PREFIX + key),
  } : memoryDrawingStore());
  if (saved?.chart?.drawings !== undefined) migrateUnscopedDrawings(store, savedKey(saved), saved.chart.drawings);
  return new InstrumentDrawings(w.chart, w.draw, {
    store,
    // Reported on the status line, as a failed layout write is: the drawings
    // stay in memory for the session and the next change tries again. The
    // shell may still be under construction, so this does what the
    // context's own status call does rather than going through it.
    onError: ({ operation, key }) => {
      if (operation === 'read' || w._destroyed) return;
      const text = widgetText(w._opts, 'The drawings for {instrument} could not be saved', { instrument: decodeURIComponent(key) });
      w._statusline?.setMessage(text, 'error');
      w._bus.emit('status', { text, kind: 'error' });
    },
  });
}

/** The key the drawings of a persisted layout belong under, or null when it names no instrument. */
function savedKey(saved: WidgetState): string | null {
  return instrumentDrawingsKey({ symbol: saved.symbol.toUpperCase(), exchange: saved.exchange });
}

/** What `restoreState` applies, inside the history's `ignore`. */
export function restoreWidgetState(w: PersistHost, state: unknown): WidgetRestoreReport {
  if (!isRecord(state)) return { applied: false, reason: 'not a widget state object' };
  if (state.version !== undefined && state.version !== WIDGET_STATE_VERSION) {
    return { applied: false, reason: `widget state version ${String(state.version)} is not ${WIDGET_STATE_VERSION}` };
  }
  // Read before anything is applied: a variant this build cannot name would
  // be served as some other series, so the whole state is refused. A state
  // that names none was saved on the feed's default series (getState leaves
  // the default out, and nothing saved before variants could name another),
  // so it restores onto the default whatever this widget shows now. Keeping
  // the current variant instead would land its view on bars it never saw.
  let variant: Readonly<DataVariant> | undefined;
  try { variant = normalizeDataVariant(state.variant); }
  catch (error) { return { applied: false, reason: error instanceof Error ? error.message : 'invalid data variant' }; }
  if (state.theme === 'dark' || state.theme === 'light') w.setTheme(state.theme);
  if (typeof state.chartType === 'string' && registeredChartTypes().includes(state.chartType)) w.setChartType(state.chartType);
  if (state.rail !== undefined && w._rail !== null) w._rail.restorePrefs(state.rail);
  if (state.panels !== undefined) w._dock?.restore(state.panels);
  const symbol = typeof state.symbol === 'string' ? state.symbol.toUpperCase() : w._symbol;
  const exchange = typeof state.exchange === 'string' ? state.exchange : w._exchange;
  const interval = typeof state.interval === 'string' && isKnownInterval(state.interval) ? state.interval : w._interval;
  const sameVariant = dataVariantKey(variant) === dataVariantKey(w._variant);
  const same = symbol === w._symbol && exchange === w._exchange && interval === w._interval && sameVariant;
  let chart: RestoreReport | undefined;
  if (isRecord(state.chart)) {
    let doc = state.chart as unknown as WidgetChartState;
    const scoped = w.instrumentDrawings;
    // A layout for another instrument brings that instrument's drawings.
    // They wait in its store while the chart restore keeps the ones on
    // screen, which are this instrument's until the switch below, so the
    // alerts the layout restores are judged against their own drawings.
    const moving = scoped !== null && (symbol !== w._symbol || exchange !== w._exchange)
      && instrumentDrawingsKey({ symbol, exchange }) !== null;
    const incoming = doc.drawings;
    if (moving) doc = { ...doc, drawings: w.draw.toJSON() };
    chart = w.chart.restoreState(same ? doc : stripView(doc));
    if (!chart.applied) return { applied: false, reason: chart.reason, chart };
    if (moving && scoped !== null) scoped.setDocument({ symbol, exchange }, incoming ?? []);
    w._keepView = same;
    w._pendingView = same ? doc.viewport ?? null : null;
  }
  if (!same) {
    w._cancelNavigation();
    if (interval !== w._interval) {
      w._interval = interval;
      w._bus.emit('interval', { interval });
    }
    if (symbol !== w._symbol || exchange !== w._exchange) {
      w._symbol = symbol;
      w._exchange = exchange;
      w._bus.emit('symbol', { symbol, exchange });
    }
    if (!sameVariant) {
      w._variant = variant;
      w._bus.emit('variant', { variant });
    }
    w._statusline?.setSymbol(w._symbol, w._exchange, w._interval);
    w._topbar?.refresh();
    w._mobile?.refresh();
    if (w._opts.feed) void w.reload();
    else {
      w._series.setData([]);
      w._publishDataContext();
    }
  }
  w._rail?.refresh();
  w._statusline?.refresh();
  w._bus.emit('layout', { reason: 'restore', chartType: w.chartType() });
  w._scheduleSave();
  return chart === undefined ? { applied: true } : { applied: true, chart };
}

/** The stored layout, checked field by field, or null when nothing this build can read is stored. */
export function readSaved(w: PersistHost): WidgetState | null {
  const raw = w._storage.get(STATE_KEY);
  if (!isRecord(raw) || raw.version !== WIDGET_STATE_VERSION) return null;
  const variant = savedVariant(raw.variant);
  const chart = isRecord(raw.chart) ? (raw.chart as unknown as WidgetChartState) : undefined;
  const out: WidgetState = {
    version: WIDGET_STATE_VERSION,
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '',
    exchange: typeof raw.exchange === 'string' ? raw.exchange : '',
    interval: typeof raw.interval === 'string' && raw.interval !== '' ? raw.interval : '1d',
    chartType: typeof raw.chartType === 'string' ? raw.chartType : 'candlestick',
    theme: raw.theme === 'light' ? 'light' : 'dark',
    ...(variant ? { variant } : {}),
    chart: (chart && variant === null ? stripView(chart) : chart) as WidgetChartState,
    rail: isRecord(raw.rail) ? (raw.rail as unknown as RailPrefs) : null,
    panels: sanitizePanelDockState(raw.panels),
  };
  return out;
}

/** One write, a debounce after the last change, because drags fire per frame. */
export function scheduleSave(w: PersistHost): void {
  if (!w._storage.enabled || w._destroyed) return;
  if (w._saveTimer !== 0) clearTimeout(w._saveTimer);
  w._saveTimer = setTimeout(() => { w._saveTimer = 0; w._saveNow(); }, SAVE_DEBOUNCE_MS);
}

/** The write itself, now: a failure is reported on the status line, never thrown. */
export function saveNow(w: PersistHost): void {
  if (!w._storage.enabled || w._destroyed) return;
  if (w._saveTimer !== 0) { clearTimeout(w._saveTimer); w._saveTimer = 0; }
  try {
    if (!w._storage.set(STATE_KEY, w.getState())) w.context.status(widgetText(w.context, 'The chart layout could not be saved'), 'error');
  } catch (error) {
    w.context.status(widgetText(w.context, 'The chart layout could not be saved: {error}', { error: error instanceof Error ? error.message : 'invalid state' }), 'error');
  }
}

/** Writes a pending save when the page goes away; the listener goes with the shell. */
export function flushOnPageHide(w: PersistHost): void {
  const win = w._doc.defaultView;
  if (win !== null && win !== undefined && typeof win.addEventListener === 'function') {
    // A debounced save still pending when the tab closes is the last quarter
    // second of the user's work; pagehide is the last synchronous moment.
    const flush = (): void => w._saveNow();
    win.addEventListener('pagehide', flush);
    w._cleanups.push(() => win.removeEventListener('pagehide', flush));
  }
}
