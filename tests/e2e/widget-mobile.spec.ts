import { test, expect, type Page, type TestInfo } from '@playwright/test';

test.use({ hasTouch: true });

test('candle density survives desktop and mobile resizing, reset and data changes', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 740 });
    await page.goto('/tests/e2e/widget-mobile-fixture.html');
    await page.waitForFunction(() => (window as any).__loaded > 0);
    const spacing = () => page.evaluate(() => (window as any).__widget.chart.timeScale.barSpacing);
    await expect.poll(spacing).toBe(8);
    await page.evaluate(() => {
      const widget = (window as any).__widget;
      widget.chart.setVisibleLogicalRange({ from: 0, to: 30 });
      widget.chart.resetScale();
    });
    await expect.poll(spacing).toBe(8);
    await page.evaluate(() => (window as any).__widget.setSymbol('NEXT'));
    await expect.poll(spacing).toBe(8);
    await page.evaluate(() => (window as any).__widget.setInterval('15m'));
    await expect.poll(spacing).toBe(8);
    await info.attach(`candle density at width ${width}`, {
      body: await page.screenshot({ path: info.outputPath(`density-${width}.png`) }), contentType: 'image/png',
    });
  }
  expect(errors).toEqual([]);
});

test('touch drawing controls work in portrait and remain available in landscape', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto('/tests/e2e/widget-mobile-fixture.html');
  await page.waitForFunction(() => (window as any).__loaded > 0);
  await page.locator('[data-mobile-action=draw]').tap();
  await page.locator('[data-tool=trend-line].oac-mobile__tool').tap();
  await page.touchscreen.tap(90, 260);
  await page.touchscreen.tap(240, 400);
  await page.waitForFunction(() => (window as any).__widget.draw.drawings().length === 1);
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings()[0].points.length)).toBe(2);
  await page.locator('[data-mobile-action=lock]').tap();
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings()[0].locked)).toBe(true);
  await page.locator('[data-mobile-action=delete]').tap();
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings().length)).toBe(0);
  await page.setViewportSize({ width: 740, height: 390 });
  await expect(page.locator('[data-mobile-action=draw]')).toBeVisible();
  await page.locator('[data-mobile-action=draw]').tap();
  const panel = page.locator('.oac-mobile-sheet');
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(741);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(391);
  await info.attach('landscape touch controls', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('symbol search keeps the final result reachable in a short embedded widget', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/tests/e2e/widget-mobile-fixture.html');
  await page.waitForFunction(() => (window as any).__loaded > 0);
  await page.evaluate(async () => {
    (window as any).__widget.destroy();
    const host = document.getElementById('t')!;
    host.style.cssText = 'position:absolute;left:0;top:0;width:390px;height:300px';
    const { createWidget } = await import('/dist/openalgo-charts.widget.mjs');
    const matches = Array.from({ length: 20 }, (_, index) => ({
      symbol: `SYM${String(index).padStart(2, '0')}`,
      exchange: 'NSE',
      name: `Company ${index + 1}`,
    }));
    (window as any).__widget = createWidget(host, {
      mobile: 'always',
      symbol: 'START',
      interval: '5m',
      symbolSearch: () => matches,
    });
  });

  const input = page.locator('.oac-mobile__symbol');
  await input.fill('sym');
  const results = page.locator('.oac-mobile-results');
  const list = page.locator('.oac-mobile-results__list');
  const last = page.locator('[data-mobile-action=pick-symbol]').last();
  await expect(results).toBeVisible();
  await expect(last).toHaveText(/SYM19/);
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });

  const panelBox = await results.boundingBox();
  const lastBox = await last.boundingBox();
  expect(lastBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  await last.tap();
  await expect(results).toBeHidden();
  expect(await page.evaluate(() => (window as any).__widget.symbol())).toBe('SYM19');
});

/**
 * Replace the fixture's widget with one fed a seeded random walk in market
 * hours, so a screenshot of the chrome shows a chart that reads like a real
 * stock. Resolves once the first bars are on screen.
 */
async function mountRandomWalk(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.goto('/tests/e2e/widget-mobile-fixture.html');
  await page.waitForFunction(() => (window as any).__loaded > 0);
  // The module comes from a script tag rather than an import awaited inside
  // the evaluate below: in Chromium that await, after the bars are built,
  // fails the evaluate with a navigation error while the page stays intact.
  await page.addScriptTag({
    type: 'module',
    content: "import { createWidget } from '/dist/openalgo-charts.widget.mjs'; window.__createWidget = createWidget;",
  });
  await page.waitForFunction(() => typeof (window as any).__createWidget === 'function');
  await page.evaluate((themeName) => {
    let seed = 20260929;
    const uniform = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
    const normal = (): number => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const tick = (value: number): number => Math.round(value * 20) / 20;
    const bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    let price = 1486.4;
    let vol = 0.0016;
    // Five-minute bars from 09:15 IST, weekdays only, with an overnight gap.
    for (let day = Date.UTC(2026, 7, 3) / 1000; bars.length < 450; day += 86400) {
      const weekday = new Date(day * 1000).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      price *= 1 + normal() * 0.006;
      for (let slot = 0; slot < 75 && bars.length < 450; slot++) {
        vol = Math.min(0.004, Math.max(0.0008, vol * (1 + normal() * 0.08)));
        const open = tick(price);
        const close = tick(open * (1 + normal() * vol));
        const high = tick(Math.max(open, close) * (1 + Math.abs(normal()) * vol * 0.5));
        const low = tick(Math.min(open, close) * (1 - Math.abs(normal()) * vol * 0.5));
        const busy = slot < 6 || slot > 68 ? 2.2 : 1;
        bars.push({ time: day + 13_500 + slot * 300, open, high, low, close, volume: Math.round(busy * 42_000 * (0.6 + uniform())) });
        price = close;
      }
    }
    (window as any).__widget.destroy();
    (window as any).__loaded = 0;
    const widget = (window as any).__createWidget(document.getElementById('t')!, {
      mobile: 'auto', symbol: 'INFY', exchange: 'NSE', interval: '5m', theme: themeName, rail: { favorites: ['trend-line'] },
      feed: { getBars: async () => bars, subscribeBars: () => () => {} },
    });
    widget.on('data', (event: { bars: number }) => { (window as any).__loaded = event.bars; });
    (window as any).__widget = widget;
  }, theme);
  await page.waitForFunction(() => (window as any).__loaded > 0);
}

const layout = (page: Page): Promise<string | null> => page.locator('.oac-widget').getAttribute('data-mobile');

/** Switch the theme and let the chart repaint its canvas on the next frames before a shot. */
const setTheme = (page: Page, theme: 'dark' | 'light'): Promise<void> => page.evaluate((name) => new Promise<void>((done) => {
  (window as any).__widget.setTheme(name);
  requestAnimationFrame(() => requestAnimationFrame(() => done()));
}), theme);

// The chrome fades its colours on a theme change; the shot shows the settled theme.
const shoot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  await info.attach(name, { body: await page.screenshot({ path: info.outputPath(`${name.replace(/ /g, '-')}.png`), animations: 'disabled' }), contentType: 'image/png' });
};

test('a tablet keeps the toolbar and drawing rail in both orientations, and they work by touch', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 820, height: 1180 });
  await mountRandomWalk(page, 'dark');
  // Each engine must emulate a touch screen here, or the test proves nothing about coarse pointers.
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  expect(await layout(page)).toBe('false');
  await expect(page.locator('.oac-topbar')).toBeVisible();
  await expect(page.locator('.oac-rail')).toBeVisible();
  await expect(page.locator('.oac-mobile__bar')).toBeHidden();

  await page.locator('.oac-pills [data-interval="15m"]').tap();
  await expect.poll(() => page.evaluate(() => (window as any).__widget.interval())).toBe('15m');
  // The pinned button, not the group face: Chromium moves a tap on a group
  // face onto its list chevron, which opens the list instead of the tool.
  await page.locator('.oac-rail__fav[data-tools="trend-line"]').tap();
  await expect.poll(() => page.evaluate(() => (window as any).__widget.draw.activeTool())).toBe('trend-line');
  const stage = (await page.locator('.oac-stage').boundingBox())!;
  await page.touchscreen.tap(stage.x + stage.width * 0.25, stage.y + stage.height * 0.6);
  await page.touchscreen.tap(stage.x + stage.width * 0.7, stage.y + stage.height * 0.35);
  await page.waitForFunction(() => (window as any).__widget.draw.drawings().length === 1);
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings()[0].points.length)).toBe(2);
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme);
    await shoot(page, info, `tablet 820x1180 ${theme}`);
  }

  // Turning the tablet resizes the container; the chrome and the drawing stay.
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(page.locator('.oac-rail')).toBeVisible();
  expect(await layout(page)).toBe('false');
  await expect(page.locator('.oac-topbar')).toBeVisible();
  await expect(page.locator('.oac-mobile__bar')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings().length)).toBe(1);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await shoot(page, info, `tablet 1180x820 ${theme}`);
  }
  expect(errors).toEqual([]);
});

test('a phone keeps the compact controls in both orientations, the widest phones included', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await mountRandomWalk(page, 'light');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  for (const [width, height] of [[390, 844], [844, 390], [932, 430], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.oac-mobile__bar')).toBeVisible();
    expect(await layout(page)).toBe('true');
    await expect(page.locator('.oac-topbar')).toBeHidden();
    await expect(page.locator('.oac-rail')).toBeHidden();
    const theme = width > height ? 'dark' : 'light';
    await setTheme(page, theme);
    await shoot(page, info, `phone ${width}x${height} ${theme}`);
  }
  expect(errors).toEqual([]);
});

test('auto mode follows the widget container while the window stays put', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await mountRandomWalk(page, 'dark');
  const size = (css: string): Promise<void> => page.locator('#t').evaluate((element, value) => { (element as HTMLElement).style.cssText = value; }, css);
  expect(await layout(page)).toBe('false');
  // A narrow cell in a wide dashboard.
  await size('position:absolute;left:0;top:0;width:600px;height:820px');
  await expect.poll(() => layout(page)).toBe('true');
  // Wide but short, the shape a phone on its side gives: compact under a coarse pointer.
  await size('position:absolute;left:0;top:0;width:900px;height:450px');
  await expect.poll(() => layout(page)).toBe('true');
  await size('position:absolute;left:0;top:0;width:900px;height:700px');
  await expect.poll(() => layout(page)).toBe('false');
  await size('position:absolute;left:0;top:0;width:1100px;height:450px');
  await expect.poll(() => layout(page)).toBe('false');
  await size('position:absolute;inset:0');
  await expect.poll(() => layout(page)).toBe('false');
  expect(page.viewportSize()).toEqual({ width: 1180, height: 820 });
});

test.describe('with a fine pointer', () => {
  test.use({ hasTouch: false });

  test('only the container width decides', async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    await mountRandomWalk(page, 'dark');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    expect(await layout(page)).toBe('false');
    await page.setViewportSize({ width: 640, height: 900 });
    await expect.poll(() => layout(page)).toBe('true');
  });
});
