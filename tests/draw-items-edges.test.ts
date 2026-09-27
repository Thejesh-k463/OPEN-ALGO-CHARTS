/**
 * A renderer that draws a segment between neighbouring bars (a line, a step,
 * an area) needs the bar beyond each edge of the view, or the segment that
 * crosses the edge is never drawn (src/render/draw-items.ts, `edges`).
 *
 * On a dense series that loss is one bar's width and nobody sees it. On a
 * sparse one it is most of the line: a level held from 09:20 to 09:40 on a
 * chart whose axis also carries a 5-second series disappears entirely once the
 * view starts at 09:30, because its only in-view bar is the one at 09:40.
 */
import { describe, it, expect } from 'vitest';
import { createSeriesDrawItems } from '../src/render/draw-items';
import { DataLayer } from '../src/model/data-layer';
import { TimeScale } from '../src/scale/time-scale';
import { PriceScale } from '../src/scale/price-scale';
import { getChartType } from '../src/model/chart-type-registry';
import type { Bar } from '../src/model/bar';

const bar = (time: number, v: number): Bar => ({ time, open: v, high: v, low: v, close: v });

function setup() {
  const layer = new DataLayer();
  // A dense series owns the axis: 101 logical indices, one per time.
  const dense = layer.createSeries();
  layer.setSeriesData(dense, Array.from({ length: 101 }, (_, i) => bar(1000 + i * 5, 10)));
  // The sparse line has three points on it: indices 0, 50 and 100.
  const sparse = layer.createSeries();
  layer.setSeriesData(sparse, [bar(1000, 20), bar(1250, 20), bar(1500, 20)]);
  const timeScale = new TimeScale({ barSpacing: 8, rightOffset: 0 });
  timeScale.setWidth(800);
  timeScale.setBaseIndex(layer.baseIndex);
  const scale = new PriceScale();
  scale.setHeight(200);
  scale.setPriceRange({ min: 0, max: 30 });
  return { layer, sparse, timeScale, scale };
}

describe('series draw items at the edges of the view', () => {
  it('without edges, carries only the bars in view', () => {
    const { layer, sparse, timeScale, scale } = setup();
    const items = createSeriesDrawItems().build(layer, sparse, 20, 80, 0, timeScale, scale, null);
    expect(items.map((it) => it.bar.time)).toEqual([1250]);
  });

  it('with edges, adds the nearest bar beyond each side, off screen', () => {
    const { layer, sparse, timeScale, scale } = setup();
    const buffer = createSeriesDrawItems();
    const items = buffer.build(layer, sparse, 20, 80, 0, timeScale, scale, null, true);
    expect(items.map((it) => it.bar.time)).toEqual([1000, 1250, 1500]);
    expect(items[0].x).toBeLessThan(timeScale.indexToX(20));
    expect(items[2].x).toBeGreaterThan(timeScale.indexToX(80));
    // firstIndex still names the first bar IN view, for previous-close colouring.
    expect(buffer.firstIndex()).toBe(50);
  });

  it('adds nothing past the first or last bar of the series', () => {
    const { layer, sparse, timeScale, scale } = setup();
    const items = createSeriesDrawItems().build(layer, sparse, 0, 100, 0, timeScale, scale, null, true);
    expect(items.map((it) => it.bar.time)).toEqual([1000, 1250, 1500]);
  });

  it('is on for the line family only', () => {
    for (const t of ['line', 'line-markers', 'step', 'area', 'hlc-area', 'baseline'] as const) {
      expect(getChartType(t).connectsBars, t).toBe(true);
    }
    for (const t of ['candlestick', 'hollow-candle', 'volume-candle', 'bar', 'high-low', 'column', 'histogram'] as const) {
      expect(getChartType(t).connectsBars, t).toBeFalsy();
    }
  });
});
