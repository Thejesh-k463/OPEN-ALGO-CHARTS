/**
 * The widget's pictures, all read from the chrome registry.
 *
 * Through 2.5.9 a handful of pictures (settings tabs, stacking order, fit,
 * line styles, a menu tick, a close cross) were drawn in widget files, where
 * the registry's grid, overlap and crispness checks never saw them: the price
 * tab's wicks once filled its candle bodies solid, and the tick sat on half
 * units. In 2.5.10 they moved into the registry and are shown by id, so the
 * first check here is that no widget file draws a picture again. The rest
 * pin what each surface shows: a glyph beside every chart type in the menu,
 * on the type button and in the phone sheet, a sun or a moon on the theme
 * button, and a glyph on every settings tab.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerChartType, registeredChartTypes, getChartType, type Bar } from '../src/index';
import '../src/transform/index';
import { chartTypeIcon, chromeIconSvg } from 'openalgo-charts/draw';
import { createWidget, openMenu, chartTypeChoices, type Widget, type WidgetOptions } from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, type FakeElement } from './helpers/fake-dom-widget';

beforeAll(ensureWindowGlobal);

type Sources = Record<string, string>;
/** `import.meta.glob`, typed; the suite carries no Vite client globals. */
type Glob = { glob(pattern: string, options: { query: string; import: string; eager: true }): Sources };
const WIDGET_SOURCES: Sources = (import.meta as unknown as Glob).glob('../src/widget/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('one icon system', () => {
  it('leaves no path data or hand-written glyph in a widget file', () => {
    expect(Object.keys(WIDGET_SOURCES).length).toBeGreaterThan(50);
    const found: string[] = [];
    for (const [file, text] of Object.entries(WIDGET_SOURCES)) {
      // A string that opens with a moveto and a coordinate is path data;
      // `<path` is markup around one. The chrome frame in form.ts draws the
      // registry's derived paths (a layout tile) and is the one exception.
      for (const m of text.matchAll(/(['"`])M\s*-?\d[^'"`]*\1/g)) found.push(`${file}: ${m[0]}`);
      if (!file.endsWith('/form.ts') && text.includes('<path')) found.push(`${file}: <path`);
    }
    expect(found).toEqual([]);
  });
});

const T0 = 1_700_000_000;
const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
  time: T0 + i * 300, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1000,
}));
const live: Widget[] = [];
afterEach(() => { for (const w of live.splice(0)) if (!w.isDestroyed) w.destroy(); });

function make(opts: WidgetOptions = {}): { w: Widget; root: FakeElement } {
  const doc = fakeWidgetDocument();
  const container = fakeContainer(doc);
  const w = createWidget(container as unknown as HTMLElement, {
    document: doc as unknown as Document,
    pixelRatio: () => 1,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    feed: { getBars: async () => bars, subscribeBars: () => () => {} },
    ...opts,
  });
  w.chart.applySize(800, 600);
  live.push(w);
  return { w, root: w.root as unknown as FakeElement };
}

const glyphOf = (el: FakeElement | null | undefined): string | undefined => el?.querySelector('.oac-glyph')?.innerHTML;

describe('chart type glyphs', () => {
  it('has a registry glyph for every chart type the menu offers, the transform types included', () => {
    const offered = chartTypeChoices();
    expect(offered).toEqual(expect.arrayContaining(['candlestick', 'line', 'point-figure', 'kagi']));
    for (const id of offered) expect(chartTypeIcon(id), id).toBeTypeOf('string');
  });

  it('shows each type\'s glyph beside its name in the menu and on the type button', () => {
    const { w, root } = make();
    const type = root.querySelector('.oac-topbar__type') as FakeElement;
    expect(glyphOf(type)).toBe(chromeIconSvg('chart-candlestick'));
    type.click();
    const rows = root.querySelectorAll('.oac-menu .oac-menu__row');
    expect(rows.length).toBe(chartTypeChoices().length);
    chartTypeChoices().forEach((id, i) => expect(glyphOf(rows[i]), id).toBe(chromeIconSvg(`chart-${id}`)));
    // The glyph carries no text, so a row still reads as its name alone.
    (rows.find((r) => r.textContent === 'Line') as FakeElement).click();
    expect(w.chartType()).toBe('line');
    expect(glyphOf(type)).toBe(chromeIconSvg('chart-line'));
  });

  it('lists the same glyphs in the phone sheet', () => {
    const { root } = make({ mobile: 'always' });
    (root.querySelector('[data-mobile-action="more"]') as FakeElement).click();
    const rows = root.querySelectorAll('[data-mobile-action="chart-type"]');
    expect(rows.map((r) => r.dataset.chartType)).toEqual(chartTypeChoices());
    for (const r of rows) expect(glyphOf(r), r.dataset.chartType).toBe(chromeIconSvg(`chart-${r.dataset.chartType}`));
  });

  it('keeps a host type\'s row aligned with an empty slot, and shows its name alone on the button', () => {
    registerChartType('host-ribbon', { ...getChartType('line') });
    expect(registeredChartTypes()).toContain('host-ribbon');
    const { root } = make({ chartType: 'host-ribbon' });
    const type = root.querySelector('.oac-topbar__type') as FakeElement;
    expect(type.querySelector('.oac-glyph')?.hidden).toBe(true);
    type.click();
    const row = root.querySelectorAll('.oac-menu .oac-menu__row').find((r) => r.textContent === 'Host ribbon');
    expect(glyphOf(row)).toBe('<svg aria-hidden="true"></svg>');
  });
});

describe('menu rows', () => {
  it('draw a glyph column only when a row asks for one, and an empty slot for an id the registry lacks', () => {
    const { w, root } = make();
    const anchor = root.querySelector('.oac-topbar__type') as unknown as HTMLElement;
    openMenu(w.context, anchor, [{ label: 'Plain', onSelect: () => {} }]);
    expect(root.querySelector('.oac-menu .oac-glyph')).toBeNull();
    w.context.overlays.closeAll();
    openMenu(w.context, anchor, [
      { label: 'Copy', icon: 'copy', onSelect: () => {} },
      { label: 'No icon', onSelect: () => {} },
      { label: 'Unknown', icon: 'no-such-glyph', onSelect: () => {} },
    ]);
    const rows = root.querySelectorAll('.oac-menu .oac-menu__row');
    expect(rows.map((r) => glyphOf(r))).toEqual([chromeIconSvg('copy'), '<svg aria-hidden="true"></svg>', '<svg aria-hidden="true"></svg>']);
  });
});

describe('theme and settings glyphs', () => {
  it('draws a registry glyph on every chart settings tab', () => {
    const { w, root } = make();
    w.openSettings();
    const tabs = root.querySelectorAll('.oac-settings [role="tab"]');
    expect(tabs.length).toBeGreaterThan(2);
    const expected: Record<string, string> = {
      price: 'chart-candlestick', readout: 'legend', axes: 'axes', appearance: 'panels', trading: 'trading',
    };
    for (const t of tabs) expect(glyphOf(t), t.dataset.tab).toBe(chromeIconSvg(expected[t.dataset.tab as string]));
  });
});
