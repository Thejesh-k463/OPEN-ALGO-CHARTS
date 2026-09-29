import { test, expect, type Page } from '@playwright/test';

// The reference host's own chrome in both of its palettes. The rail's lower
// block (magnet, keep tool, lock, visibility, trash, undo, redo) and its
// active and danger tints were written as the dark palette's literal
// colours, so the light theme kept a dark strip at the bottom of the rail.
// And the replay transport printed the chart's name twice: once as the
// owner label and once as the scope toggle beside it.

const PAGE = '/examples/yfinance/index.html?test=1';
const PROBE = '/api/history?symbol=AAPL&interval=1d&period=1mo';
let serverUp: boolean | null = null;

test.beforeEach(async ({ request, page }) => {
  if (serverUp === null) serverUp = await request.get(PROBE).then(response => response.ok(), () => false);
  test.skip(!serverUp, 'The reference fixture server is unavailable');
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(PAGE);
  await page.waitForFunction(() => Boolean((window as any).__oac?.app?.currentBars?.length));
});

async function setTheme(page: Page, name: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async theme => {
    const path = '/examples/yfinance/src/ui.js';
    (await import(path)).setTheme(theme, { silent: true });
  }, name);
  await expect(page.locator('html')).toHaveAttribute('data-theme', name);
}

/** A custom property resolved to the colour the browser paints, via a probe element. */
async function token(page: Page, name: string, property: 'backgroundColor' | 'color' | 'borderTopColor'): Promise<string> {
  return page.evaluate(([n, p]) => {
    const probe = document.createElement('div');
    const css = p === 'backgroundColor' ? 'background-color' : p === 'color' ? 'color' : 'border-top-color';
    probe.style.setProperty(css, `var(${n})`);
    document.body.appendChild(probe);
    const value = getComputedStyle(probe)[p as 'color'];
    probe.remove();
    return value;
  }, [name, property] as const);
}

const style = (page: Page, selector: string, property: 'backgroundColor' | 'color' | 'borderTopColor') =>
  page.locator(selector).first().evaluate((node, p) => getComputedStyle(node)[p as 'color'], property);

test('the rail and its lower block share one surface in the light and the dark theme', async ({ page }, info) => {
  for (const theme of ['light', 'dark', 'light'] as const) {
    await setTheme(page, theme);
    const rail = await style(page, '#rail', 'backgroundColor');
    expect(await style(page, '#rail .rail__ctl', 'backgroundColor')).toBe(rail);
    expect(rail).toBe(await token(page, '--panel-2', 'backgroundColor'));
    await page.screenshot({ path: info.outputPath(`rail-${theme}.png`) });
  }
});

test('the active tool, the checked flyout row and the danger hover take the theme tokens', async ({ page }, info) => {
  await setTheme(page, 'light');
  const lines = page.locator('#rail .rail__group[data-group="lines"]');
  await lines.click();
  await expect(lines).toHaveAttribute('aria-pressed', 'true');
  // Polled: the button eases its tint over a tenth of a second.
  const onBg = await token(page, '--on-bg', 'backgroundColor');
  await expect.poll(() => style(page, '#rail .rail__group[data-group="lines"]', 'backgroundColor')).toBe(onBg);
  await expect.poll(() => style(page, '#rail .rail__group[data-group="lines"]', 'borderTopColor')).toBe(await token(page, '--on-bd', 'borderTopColor'));

  // The group's flyout marks the tool in use as its checked row.
  await lines.hover();
  await lines.locator('.rail__chev').click();
  const checked = page.locator('.fly__row[aria-checked="true"]').first();
  await expect(checked).toBeVisible();
  await expect.poll(() => checked.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(onBg);
  await page.screenshot({ path: info.outputPath('rail-flyout-light.png') });
  await page.keyboard.press('Escape');

  // With nothing selected the trash is off; a selected drawing turns it on.
  await page.evaluate(() => {
    const oac = (window as any).__oac;
    const bars = oac.app.currentBars;
    const a = bars[bars.length - 30], b = bars[bars.length - 5];
    const drawing = oac.draw.add({ tool: 'trend-line', paneIndex: 0, style: {}, points: [{ time: a.time, price: a.close }, { time: b.time, price: b.close }] });
    oac.draw.select([drawing.id]);
  });
  await expect(page.locator('#rail .rail__btn--danger:not(.is-off)').first()).toBeVisible();
  await page.locator('#rail .rail__btn--danger:not(.is-off)').first().hover();
  await expect.poll(() => style(page, '#rail .rail__btn--danger:not(.is-off)', 'color')).toBe(await token(page, '--danger-tx', 'color'));
});

test('the replay bar names the chart once and the scope toggle names the scope', async ({ page }, info) => {
  await page.locator('#chart').focus();
  await page.getByRole('button', { name: 'Replay this session bar by bar', exact: true }).click();
  // The pick prompt has no owner label, so its toggle still names the chart.
  await expect(page.locator('#rp-pick-scope')).toHaveText('Chart 1');
  await page.evaluate(async () => {
    const path = '/examples/yfinance/src/replay.js'; await (await import(path)).startReplayAt(20);
  });
  await expect(page.locator('#replaybar')).toBeVisible();
  const owner = page.locator('#rp-owner'), scope = page.locator('#rp-scope');
  await expect(owner).toHaveText('Chart 1');
  await expect(scope).toHaveText('This chart');
  await expect(scope).toHaveAttribute('aria-label', 'Replay scope: This chart');
  await expect(scope).toHaveAttribute('aria-pressed', 'false');
  expect(await owner.textContent()).not.toBe(await scope.textContent());
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#replaybar').screenshot({ path: info.outputPath(`replay-bar-${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('#replaybar').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.locator('#replaybar').screenshot({ path: info.outputPath('replay-bar-narrow.png') });
});
