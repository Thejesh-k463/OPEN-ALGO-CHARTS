import { test, expect, type Page } from '@playwright/test';

/**
 * The widget tier's bottom bar in the reference host, against the fixture
 * server: under the stage beside the rail, acting on the focused chart. A
 * range loads the interval and the period its sessions need through the
 * page's own load path and places them; the clock's zone survives the next
 * rebuild; the scale toggles act on the chart; the session shading is on the
 * chart, over fixture bars laid out in each venue's own hours; and the phone
 * shell follows the container-size rule. On a desktop the bar's Go to and
 * clock are the page's only ones; the phone shell, which hides the bar, keeps
 * the toolbar's Go to and the corner clock.
 */

const PAGE = '/examples/yfinance/index.html?test=1';
const PROBE = '/api/history?symbol=AAPL&interval=1d&period=1mo';
let serverUp: boolean | null = null;

test.beforeEach(async ({ request }) => {
  if (serverUp === null) serverUp = await request.get(PROBE).then(response => response.ok(), () => false);
  test.skip(!serverUp, 'The reference fixture server is unavailable');
});

async function openHost(page: Page, viewport = { width: 1360, height: 900 }): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize(viewport);
  await page.goto(PAGE);
  await page.waitForFunction(() => Boolean((window as any).__oac?.app?.currentBars?.length) && !(window as any).__oac.app.loading);
  return errors;
}

const app = (page: Page, read: string): Promise<unknown> =>
  page.evaluate(expression => new Function('app', `return ${expression}`)((window as any).__oac.app), read);

/** Load `symbol` through the page's own load path, the hidden field the toolbar writes. */
async function chooseSymbol(page: Page, symbol: string): Promise<void> {
  await page.evaluate(async (value) => {
    (document.getElementById('symbol') as HTMLInputElement).value = value;
    await (window as any).__oac.app.load();
  }, symbol);
  await expect.poll(() => app(page, `app.req.symbol === ${JSON.stringify(symbol)} && !app.loading && app.currentBars.length > 0`)).toBe(true);
}

test('sits under the chart beside the rail, and the chart stands clear of it', async ({ page }, info) => {
  const errors = await openHost(page);
  const bar = page.locator('.host-bottombar .oac-bottombar');
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  const chartBox = await page.locator('#inspect-layout-1').boundingBox();
  const railBox = await page.locator('#rail').boundingBox();
  expect(barBox!.height).toBe(28);
  expect(Math.abs(barBox!.y - (chartBox!.y + chartBox!.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(barBox!.x - (railBox!.x + railBox!.width))).toBeLessThanOrEqual(1);
  // Only the strip takes the pointer: the layer over the stage lets the chart have it.
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#chart') !== null,
    { x: chartBox!.x + chartBox!.width / 2, y: chartBox!.y + chartBox!.height / 2 });
  expect(hit).toBe(true);
  await info.attach('host bottom bar', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('a range loads the interval and period its sessions need, then places the last session', async ({ page }, info) => {
  const errors = await openHost(page);
  await chooseSymbol(page, 'RELIANCE.NS');
  await page.locator('.host-bottombar .oac-bottombar__range[data-range="1D"]').click();
  await expect.poll(() => app(page, 'app.bottombar.controls.range()'), { timeout: 15_000 }).toBe('1D');
  expect(await app(page, 'app.req.interval + "/" + app.req.period')).toBe('5m/1mo');
  await expect(page.locator('.host-bottombar .oac-bottombar__range[data-range="1D"]')).toHaveAttribute('aria-pressed', 'true');
  // The view runs from the 09:15 open of the last bar's session to that bar.
  const placed = await app(page, `(() => {
    const bars = app.chart.primaryBars(), view = app.chart.getVisibleLogicalRange();
    const last = bars[bars.length - 1].time, first = app.chart.dataLayer.indexToTime(Math.ceil(view.from));
    const ist = t => new Date((t + 19800) * 1000).toISOString().slice(0, 16);
    return { first: ist(first), last: ist(last), right: Math.floor(view.to) === bars.length - 1 };
  })()`) as { first: string; last: string; right: boolean };
  expect(placed.first.slice(0, 10)).toBe(placed.last.slice(0, 10));
  expect(placed.first.slice(11)).toBe('09:15');
  expect(placed.right).toBe(true);
  await info.attach('one session', { body: await page.screenshot(), contentType: 'image/png' });
  // An interval picked by hand leaves the range.
  await page.locator('#shellbar .pills').getByRole('button', { name: '15M', exact: true }).click();
  await expect.poll(() => app(page, 'app.req.interval + ":" + Boolean(app.loading)')).toBe('15m:false');
  await expect.poll(() => app(page, 'app.bottombar.controls.range()')).toBeNull();
  expect(errors).toEqual([]);
});

test('a range wider than the plot keeps the latest bars in view', async ({ page }) => {
  // All at a weekly interval is more bars than a tablet-width plot holds at its narrowest spacing.
  const errors = await openHost(page, { width: 1024, height: 768 });
  await page.locator('.host-bottombar .oac-bottombar__range[data-range="ALL"]').click();
  await expect.poll(() => app(page, 'app.bottombar.controls.range()'), { timeout: 15_000 }).toBe('ALL');
  const placed = await app(page, `(() => {
    const bars = app.chart.primaryBars(), view = app.chart.getVisibleLogicalRange();
    return { n: bars.length, to: view.to, from: view.from };
  })()`) as { n: number; to: number; from: number };
  expect(placed.from).toBeGreaterThan(0);
  expect(placed.to).toBeCloseTo(placed.n - 0.5, 3);
  await expect(page.locator('#status')).toContainText('The range is wider than the chart');
  expect(errors).toEqual([]);
});

test('a zone picked on the clock moves the chart and survives the next rebuild', async ({ page }) => {
  const errors = await openHost(page);
  await page.locator('.host-bottombar .oac-bottombar__clock').click();
  const menu = page.locator('.host-bottombar .oac-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.oac-menu__row', { hasText: 'Europe/London' }).click();
  expect(await app(page, 'app.chart.timezone()')).toBe('Europe/London');
  expect(await app(page, 'app.chartTimezone')).toBe('Europe/London');
  await expect(page.locator('.host-bottombar .oac-bottombar__clock')).toHaveAttribute('aria-label', 'Timezone: Europe/London');
  // A chart-type switch builds a new chart; the zone comes with it.
  await page.evaluate(() => { const select = document.getElementById('ctype') as HTMLSelectElement; select.value = 'bar'; select.dispatchEvent(new Event('change')); });
  await expect.poll(() => app(page, 'app.chart.timezone()')).toBe('Europe/London');
  expect(errors).toEqual([]);
});

test('the scale toggles act on the chart and the shading is on it', async ({ page }) => {
  const errors = await openHost(page);
  await page.locator('.host-bottombar .oac-bottombar__icon[data-scale="log"]').click();
  expect(await app(page, 'app.chart.priceAxisState(app.chart.primaryPaneIndex(), "right").mode')).toBe('logarithmic');
  await expect(page.locator('.host-bottombar .oac-bottombar__icon[data-scale="log"]')).toHaveAttribute('aria-pressed', 'true');
  const shaded = await page.evaluate(async () => {
    const engine = await import('/dist/openalgo-charts.mjs' as string);
    const chart = (window as any).__oac.app.chart;
    return chart.panes().flatMap((pane: { primitives(): unknown[] }) => pane.primitives()).some((p: unknown) => p instanceof engine.SessionShade);
  });
  expect(shaded).toBe(true);
  expect(errors).toEqual([]);
});

test('a US symbol trades in New York hours: nothing to wash in regular hours, its pre and post market in extended', async ({ page }, info) => {
  const errors = await openHost(page);
  const phases = async (): Promise<Record<string, number>> => await app(page, `(() => {
    const calendar = app.chart.dataLayer.sessionCalendar, count = {};
    for (const bar of app.chart.primaryBars()) { const phase = calendar.phaseAt(bar.time); count[phase] = (count[phase] || 0) + 1; }
    return count;
  })()`) as Record<string, number>;
  await page.locator('#shellbar .pills').getByRole('button', { name: '5M', exact: true }).click();
  await expect.poll(() => app(page, 'app.req.interval + ":" + Boolean(app.loading)')).toBe('5m:false');
  expect(Object.keys(await phases())).toEqual(['regular']);
  await info.attach('regular hours', { body: await page.screenshot(), contentType: 'image/png' });
  await page.locator('#session-menu').click();
  await page.locator('.menu button', { hasText: 'Extended hours' }).click();
  await expect.poll(() => app(page, 'app.req.session === "extended" && !app.loading')).toBe(true);
  expect(Object.keys(await phases()).sort()).toEqual(['post', 'pre', 'regular']);
  await info.attach('extended hours', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('on a desktop the bar is the one Go to and the one clock, and the phone shell keeps its own', async ({ page }, info) => {
  const errors = await openHost(page);
  const toolbarGoTo = page.locator('#goto');
  const barGoTo = page.locator('.host-bottombar .oac-bottombar__goto');
  const cornerClock = (): Promise<unknown> => app(page, 'Boolean(app.chart.axisChromeOptions().sessionClock)');
  await expect(barGoTo).toBeVisible();
  await expect(toolbarGoTo).toBeHidden();
  expect(await cornerClock()).toBe(false);
  await info.attach('desktop', { body: await page.screenshot(), contentType: 'image/png' });
  // A chart-type switch builds a new chart, and that one has no corner clock either.
  await page.evaluate(() => { const select = document.getElementById('ctype') as HTMLSelectElement; select.value = 'bar'; select.dispatchEvent(new Event('change')); });
  expect(await cornerClock()).toBe(false);
  // A narrow window takes the phone shell, which hides the bar: the toolbar's
  // Go to and the corner clock come back, and go again with the bar.
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(barGoTo).toBeHidden();
  await expect(toolbarGoTo).toBeVisible();
  await expect.poll(cornerClock).toBe(true);
  await info.attach('phone shell', { body: await page.screenshot(), contentType: 'image/png' });
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(toolbarGoTo).toBeHidden();
  await expect.poll(cornerClock).toBe(false);
  expect(errors).toEqual([]);
});

test('the corner clock switch is the user\'s choice, kept beside the bar and after a reload', async ({ page }) => {
  const errors = await openHost(page);
  const cornerClock = (): Promise<unknown> => app(page, 'Boolean(app.chart.axisChromeOptions().sessionClock)');
  await page.getByRole('button', { name: 'Chart settings (or right-click the chart)', exact: true }).click();
  await page.locator('#cset-tabs').getByRole('button', { name: 'Axes', exact: true }).click();
  const box = page.locator('[data-key="axisChrome.sessionClock"]');
  await expect(box).not.toBeChecked();
  await box.check();
  await page.locator('#cset-ok').click();
  expect(await cornerClock()).toBe(true);
  await page.evaluate(() => { const select = document.getElementById('ctype') as HTMLSelectElement; select.value = 'line'; select.dispatchEvent(new Event('change')); });
  expect(await cornerClock()).toBe(true);
  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).__oac?.app?.currentBars?.length) && !(window as any).__oac.app.loading);
  expect(await cornerClock()).toBe(true);
  // Switched back to what the bar shows anyway, it follows the bar again.
  await page.getByRole('button', { name: 'Chart settings (or right-click the chart)', exact: true }).click();
  await page.locator('#cset-tabs').getByRole('button', { name: 'Axes', exact: true }).click();
  await page.locator('[data-key="axisChrome.sessionClock"]').uncheck();
  await page.locator('#cset-ok').click();
  expect(await cornerClock()).toBe(false);
  await page.setViewportSize({ width: 820, height: 900 });
  await expect.poll(cornerClock).toBe(true);
  expect(errors).toEqual([]);
});

test('Go to opens from the bar, waits for a load under way, and answers at the bar after loading history', async ({ page }) => {
  const errors = await openHost(page);
  const barGoTo = page.locator('.host-bottombar .oac-bottombar__goto');
  // A chart about to be replaced gets no panel: the status line says why.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/history**', async route => { await held; await route.continue(); });
  const loading = page.evaluate(async () => {
    (document.getElementById('interval') as HTMLSelectElement).value = '1h';
    (document.getElementById('period') as HTMLSelectElement).value = '1mo';
    await (window as any).__oac.app.load();
  });
  await expect.poll(() => app(page, 'Boolean(app.loading)')).toBe(true);
  await barGoTo.click();
  await expect(page.locator('#status')).toHaveText('wait for chart history before going to a date');
  await expect(page.locator('.oac-goto')).toHaveCount(0);
  release();
  await loading;
  await page.unroute('**/api/history**');
  // Three years back is more than an hourly chart can load: the answer comes
  // after the longest period has loaded, in a panel opened again at the bar.
  await barGoTo.click();
  const panel = page.locator('.oac-goto');
  await expect(panel).toBeVisible();
  const asked = (await panel.boundingBox())!;
  const bar = (await barGoTo.boundingBox())!;
  const target = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {
    timeZone: (window as any).__oac.app.chart.timezone(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - 3 * 366 * 86400_000)));
  await panel.locator('input[type=date]').first().fill(target);
  await panel.locator('input[type=time]').first().fill('');
  await panel.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.locator('.oac-goto .oac-goto__message')).toHaveText(/^History starts at /, { timeout: 20_000 });
  expect(await app(page, 'app.req.period')).toBe('1y');
  const answered = (await page.locator('.oac-goto').boundingBox())!;
  expect(Math.abs(answered.x - asked.x)).toBeLessThanOrEqual(2);
  expect(answered.y + answered.height).toBeLessThanOrEqual(bar.y + 1);
  expect(answered.y + answered.height).toBeGreaterThan(bar.y - 60);
  expect(errors).toEqual([]);
});

test('the phone shell follows the container-size rule, not every touch screen', async ({ browser }) => {
  // Four full page loads in one test: the default budget is for one.
  test.slow();
  for (const [width, height, phone] of [[390, 844, true], [932, 430, true], [1024, 768, false], [1180, 820, false]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true });
    const page = await context.newPage();
    await page.goto(PAGE);
    await page.waitForFunction(() => Boolean((window as any).__oac?.app?.currentBars?.length));
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.locator('#mobilebar')).toBeVisible({ visible: phone });
    await expect(page.locator('#rail')).toBeVisible({ visible: !phone });
    await expect(page.locator('.host-bottombar .oac-bottombar')).toBeVisible({ visible: !phone });
    await context.close();
  }
});
