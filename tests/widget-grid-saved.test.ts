/**
 * The chart grid's saved layouts: with the grid bar and a `workspaces` store,
 * one Layouts control in the bar saves and opens the whole desk through the
 * widget's own Layouts menu, no chart has a button of its own, the focus is
 * no unsaved change, a change in the quiet period is written when the page
 * hides, and the layout that was active reopens once the grid's own desk has
 * landed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { BarsRequest, DataFeed } from '../src/index';
import '../src/indicators/index';
import { WorkspaceRepository, createMemoryWorkspaceStorage, type WorkspaceStorage } from '../src/workspace/index';
import { createLayoutsController, type ChartGrid, type ChartGridOptions } from '../src/widget/index';
import { ensureWindowGlobal, fire, fireKey, type FakeElement } from './helpers/fake-dom-widget';
import { FakeAsyncStore } from './helpers/fake-async-store';
import { MemoryStorage, el, makeGrid, walk } from './widget-grid-harness';

beforeAll(ensureWindowGlobal);

const feed: DataFeed = { getBars: async (request: BarsRequest) => walk(120, 100 + request.symbol.charCodeAt(0)) };

/** Microtasks, then a turn of the timer queue: a store write and the menu's first read both land. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** One account's layouts, shared by every repository made from it, as tabs share IndexedDB. */
function account(storage: WorkspaceStorage = createMemoryWorkspaceStorage()) {
  let n = 0;
  return () => new WorkspaceRepository(storage, 'desk', { id: () => `layout-${++n}`, now: () => 1000 + n });
}

const make = (options: ChartGridOptions) => makeGrid({ feed, preset: '1x2', toolbar: true, ...options });
const control = (root: FakeElement): FakeElement => root.querySelector('.oac-grid__bar .oac-grid__saved')!;
const must = (root: FakeElement, selector: string): FakeElement => {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};

/** Open the Layouts menu from the bar and let its first read land. */
async function openMenu(root: FakeElement): Promise<FakeElement> {
  control(root).click();
  await settle();
  return must(root, '.oac-grid__overlay .oac-layouts');
}

async function saveAs(root: FakeElement, name: string): Promise<void> {
  const menu = await openMenu(root);
  must(menu, '[data-action="save-as"]').click();
  must(menu, '.oac-layouts__input').value = name;
  must(menu, '[data-action="submit-name"]').click();
  await settle();
  fireKey(menu, 'Escape');
}

const symbols = (grid: ChartGrid): string[] => grid.cells().map(cell => cell.widget.symbol());

describe('the chart grid saved layouts', () => {
  it('are one Layouts control at the end of the grid bar, and no chart has one', () => {
    const { grid, root } = make({ workspaces: account()() });
    const bar = root.querySelector('.oac-grid__bar')!;
    expect(bar.children[bar.children.length - 1]).toBe(control(root));
    expect(control(root).getAttribute('aria-label')).toBe('Layouts');
    expect(control(root).textContent).toBe('Layouts');
    for (const cell of grid.cells()) {
      expect(cell.widget.layouts).toBeNull();
      expect(el(cell.widget.root).querySelector('.oac-topbar__layouts')).toBeNull();
    }
    // The bar's arrow keys reach it.
    const buttons = bar.querySelectorAll('button');
    buttons[0].focus();
    fireKey(buttons[0], 'End');
    expect(root.ownerDocument.activeElement).toBe(control(root));
  });

  it('are left out without the grid bar, or with layouts turned off', () => {
    expect(makeGrid({ feed, workspaces: account()() }).root.querySelector('.oac-grid__saved')).toBeNull();
    expect(make({ workspaces: account()(), layouts: false }).root.querySelector('.oac-grid__saved')).toBeNull();
  });

  it('save the whole desk from the bar, and open it again over a changed desk', async () => {
    const repo = account()();
    const { grid, root } = make({ workspaces: repo });
    grid.cells()[1].widget.setSymbol('BBB');
    await saveAs(root, 'Two charts');
    const [layout] = (await repo.load()).workspaces;
    expect(layout.name).toBe('Two charts');
    expect(layout.panes.map(pane => pane.symbol)).toEqual(['AAA', 'BBB']);
    expect(control(root).textContent).toBe('Two charts');
    grid.setPreset('2x2');
    grid.cells()[3].widget.setSymbol('DDD');
    await saveAs(root, 'Four charts');
    expect(symbols(grid)).toEqual(['AAA', 'BBB', 'AAA', 'DDD']);
    const menu = await openMenu(root);
    const row = menu.querySelectorAll('.oac-layouts__row').find(r => r.textContent.includes('Two charts'))!;
    row.click();
    await settle();
    expect(symbols(grid)).toEqual(['AAA', 'BBB']);
    expect(control(root).textContent).toBe('Two charts');
    expect((await repo.load()).activeWorkspaceId).toBe(layout.id);
  });

  it('leave which chart is active out of a layout, so a click on another chart is no unsaved change', async () => {
    const { grid, root } = make({ workspaces: account()() });
    await saveAs(root, 'Desk');
    grid.setActive(grid.cells()[1].id);
    let menu = await openMenu(root);
    expect(must(menu, '[data-action="save"]').getAttribute('aria-disabled')).toBe('true');
    expect(control(root).dataset.attention).toBe('false');
    fireKey(menu, 'Escape');
    grid.cells()[1].widget.setSymbol('CCC');
    menu = await openMenu(root);
    expect(must(menu, '[data-action="save"]').getAttribute('aria-disabled')).toBe('false');
    expect(control(root).dataset.attention).toBe('true');
    expect(control(root).getAttribute('aria-label')).toBe('Layouts: Desk, Unsaved changes');
  });

  it('hear a change inside a chart a new layout of the grid made', async () => {
    const { grid, root } = make({ workspaces: account()() });
    grid.setPreset('2x2');
    await saveAs(root, 'Four charts');
    expect(control(root).dataset.attention).toBe('false');
    grid.cells()[3].widget.setSymbol('FFF');
    // Past autosave's quiet period, with no menu open to compare it sooner.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await settle();
    expect(control(root).dataset.attention).toBe('true');
  });

  it('write a change inside the quiet period when the page is hidden, and let go with the grid', async () => {
    const repo = account()();
    await repo.setAutosave(true);
    const { grid, root, doc } = make({ workspaces: repo });
    await saveAs(root, 'Desk');
    grid.cells()[0].widget.setSymbol('EEE');
    Object.assign(doc, { visibilityState: 'hidden' });
    fire(doc, 'visibilitychange');
    await settle();
    expect((await repo.load()).workspaces[0].panes[0].symbol).toBe('EEE');
    await openMenu(root);
    grid.destroy();
    expect(doc.body.querySelector('.oac-layouts')).toBeNull();
  });

  it('reopen the layout that was active once the grid own desk has landed', async () => {
    const repos = account();
    const first = make({ workspaces: repos() });
    first.grid.cells()[1].widget.setSymbol('BBB');
    await saveAs(first.root, 'Morning');
    first.grid.destroy();
    // The grid's own desk, one chart on ZZZ, answers later.
    const sync = new MemoryStorage();
    const kept = makeGrid({ feed, persist: 'desk', storage: sync, preset: '1x1', symbol: 'ZZZ' }).grid;
    kept.destroy();
    const store = new FakeAsyncStore();
    for (const [k, v] of sync.map) store.map.set(k, v);
    store.hold = true;
    const { grid, root } = make({ workspaces: repos(), persist: 'desk', storage: store });
    await settle();
    // Nothing opens under a desk still being read.
    expect(symbols(grid)).toEqual(['', '']);
    store.release();
    store.hold = false;
    await grid.ready;
    await settle();
    expect(symbols(grid)).toEqual(['AAA', 'BBB']);
    expect(control(root).textContent).toBe('Morning');
  });

  it('drive a controller the host passes from the bar alone, never reopening or ending it', async () => {
    const repo = account()();
    let target: ChartGrid | null = null;
    const controller = createLayoutsController(repo, { capture: () => target!.getWorkspace(), apply: payload => target!.applyWorkspace(payload) });
    const { grid, root } = make({ workspaces: repo, layouts: controller });
    target = grid;
    expect(grid.cells().every(cell => cell.widget.layouts === null)).toBe(true);
    await saveAs(root, 'Hosted');
    expect(controller.state().layoutId).not.toBeNull();
    grid.destroy();
    // Still the host's: it answers after the grid has gone.
    expect((await controller.reload()).workspaces.map(doc => doc.name)).toEqual(['Hosted']);
    controller.destroy();
  });
});
