/**
 * The chart grid's bar and its menus: the layout picker, maximize, the link
 * menu, whole-grid capture and, when the grid keeps them, the desk's saved
 * layouts (the widget's own Layouts menu, grid-saved.ts).
 *
 * The grid has no widget of its own, so it has no overlay stack to open a
 * menu in. It keeps one over its whole area instead (`createOverlayStack` on
 * a layer that covers the grid), which is what lets a menu opened from the
 * bar hang over the charts below it, with the widget's own Escape, Tab and
 * focus-return rules. The bar and that layer carry `oac-widget`, so every
 * control in them takes the widget's buttons, menus, focus ring and
 * scrollbars rather than a second set of styles that could drift.
 */
import { chromeIconSvg, layoutIconPath } from 'openalgo-charts/draw';
import { h, type OverlayStack, type TipController } from './context';
import { glyphSvg } from './form';
import { CHART_GRID_LAYOUTS, isChartGridLayout, type ChartGridLayoutId } from './grid-layouts';
import type { ChartGridLinkGroup, LinkChannel } from './grid-links';
import type { GridSaved } from './grid-saved';
import { chartCount, layoutName } from './grid-text';
import { layoutNeedsAttention } from './layouts-menu';
import { widgetText, type WidgetTranslationOptions } from './localization';

/** What the bar and its menus read from the grid and ask it to do. */
export interface GridBarHost {
  readonly doc: Document;
  readonly text: WidgetTranslationOptions;
  readonly overlays: OverlayStack;
  readonly tips: TipController;
  /** The layouts the picker offers, in its order. */
  readonly layouts: readonly ChartGridLayoutId[];
  /** The layout in force, when it is one of the catalogue's. */
  layout(): string | null;
  setLayout(id: ChartGridLayoutId): void;
  maximized(): boolean;
  /** Why the active chart cannot be maximized now, or null when it can. */
  maximizeBlocked(): string | null;
  toggleMaximize(): void;
  links: {
    groups(): readonly ChartGridLinkGroup[];
    /** The active chart's group, or null when it is in none. */
    current(): ChartGridLinkGroup | null;
    setGroup(id: string | null): void;
    newGroup(): void;
    rename(id: string, name: string): void;
    setChannel(channel: LinkChannel | 'nearest', on: boolean): void;
    share(): number;
  };
  capture: {
    /** Why the grid cannot be captured whole now, or null. */
    blocked(): string | null;
    download(): void;
    copy(): void;
    canCopy(): boolean;
  };
  /** The desk's saved layouts, when the grid keeps them: the bar then has a Layouts control. */
  readonly saved?: Pick<GridSaved, 'controller' | 'open' | 'status'>;
}

export interface GridBarHandle {
  readonly el: HTMLElement;
  /** Repaint every control from the host's state. */
  refresh(): void;
  destroy(): void;
}

const txt = (host: GridBarHost): WidgetTranslationOptions => host.text;
/** Ids for the notes menus point their held-back rows at; one page may hold several grids. */
let notes = 0;

/** A layout's tile: its own slots drawn on the chrome grid. */
export function layoutTileSvg(id: ChartGridLayoutId): string {
  const spec = CHART_GRID_LAYOUTS[id];
  return glyphSvg(layoutIconPath(spec.rows, spec.columns, spec.slots));
}

const chrome = (doc: Document, svg: string): HTMLSpanElement => {
  const span = h(doc, 'span', 'oac-glyph oac-glyph--chrome', { 'aria-hidden': 'true' });
  span.innerHTML = svg;
  return span;
};

/** The glyph each channel row carries, from the chrome registry. */
const CHANNEL_ICON: Readonly<Record<LinkChannel, string>> = {
  crosshair: chromeIconSvg('crosshair'), viewport: chromeIconSvg('time-range'), symbol: chromeIconSvg('search'),
  interval: chromeIconSvg('clock'), chartType: chromeIconSvg('chart-candlestick'), appearance: chromeIconSvg('palette'),
  drawings: chromeIconSvg('drawing-sync'),
};
const CHANNEL_LABEL = {
  crosshair: 'Crosshair', viewport: 'Time range', symbol: 'Symbol', interval: 'Interval',
  chartType: 'Chart type', appearance: 'Appearance', drawings: 'Drawings',
} as const;

/** A group's mark: its letter on its colour. The letter carries the meaning; the colour only helps. */
export function groupMark(doc: Document, group: Pick<ChartGridLinkGroup, 'letter'> | null): HTMLSpanElement {
  const mark = h(doc, 'span', 'oac-grid__chip', { 'aria-hidden': 'true' });
  if (group === null) {
    mark.dataset.group = 'none';
    mark.innerHTML = chromeIconSvg('unlink');
  } else {
    mark.dataset.group = group.letter;
    mark.textContent = group.letter;
  }
  return mark;
}

// ── menus ────────────────────────────────────────────────────────────────

interface MenuItem {
  kind: 'radio' | 'check' | 'action';
  label: string;
  sub?: string;
  checked?: boolean;
  disabled?: boolean;
  icon?: HTMLElement;
  /** Leave the menu open after the choice, so several toggles take one visit. */
  stay?: boolean;
  onSelect(): void;
}

/**
 * A menu of radio, check and action rows over the grid. `build` is read again
 * after every row that keeps the menu open, so a toggle repaints in place and
 * the focus stays on the row that was pressed.
 */
function openRows(host: GridBarHost, anchor: HTMLElement, label: string, build: () => Array<MenuItem | string>,
  extra?: (menu: HTMLElement, repaint: () => void) => void, note?: string | null): () => void {
  const doc = host.doc;
  const menu = h(doc, 'div', 'oac-menu oac-grid__menu', { role: 'menu', 'aria-label': label });
  const noteId = `oac-grid-note-${++notes}`;
  let close: () => void = () => {};
  const paint = (focusAt = -1): void => {
    menu.textContent = '';
    let index = 0;
    for (const item of build()) {
      if (typeof item === 'string') {
        const head = h(doc, 'div', 'oac-head', { role: 'presentation' });
        head.textContent = item;
        menu.appendChild(head);
        continue;
      }
      const row = h(doc, 'button', 'oac-menu__row', {
        type: 'button', role: item.kind === 'radio' ? 'menuitemradio' : item.kind === 'check' ? 'menuitemcheckbox' : 'menuitem',
        'aria-disabled': String(item.disabled === true),
      });
      if (item.kind !== 'action') row.setAttribute('aria-checked', String(item.checked === true));
      if (item.kind === 'check') {
        // A box with the chrome tick, not a native checkbox: a row is one button, and a control inside a button is not allowed.
        const box = h(doc, 'span', 'oac-grid__box', { 'aria-hidden': 'true' });
        box.innerHTML = chromeIconSvg('check');
        row.appendChild(box);
      }
      if (item.icon !== undefined) row.appendChild(item.icon);
      const name = h(doc, 'span', 'oac-menu__label');
      name.textContent = item.label;
      row.appendChild(name);
      if (item.sub !== undefined) {
        const sub = h(doc, 'span', 'oac-menu__sub');
        sub.textContent = item.sub;
        row.appendChild(sub);
      }
      if (item.disabled === true && note != null) row.setAttribute('aria-describedby', noteId);
      const at = index++;
      row.addEventListener('click', e => {
        e.stopPropagation();
        if (item.disabled === true) return;
        if (item.stay !== true) close();
        item.onSelect();
        if (item.stay === true) paint(at);
      });
      menu.appendChild(row);
    }
    if (note != null) {
      // Said once under the rows it holds back, rather than squeezed beside each label.
      const line = h(doc, 'div', 'oac-grid__note', { role: 'none', id: noteId });
      line.textContent = note;
      menu.appendChild(line);
    }
    extra?.(menu, () => paint());
    if (focusAt >= 0) menu.querySelectorAll<HTMLElement>('.oac-menu__row')[focusAt]?.focus();
  };
  paint();
  menu.addEventListener('keydown', e => {
    const rows = Array.from(menu.querySelectorAll<HTMLElement>('.oac-menu__row'));
    const at = rows.indexOf(doc.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % rows.length : e.key === 'ArrowUp' ? (at - 1 + rows.length) % rows.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -1;
    if (to < 0 || rows.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    rows[to].focus();
  });
  close = host.overlays.open(menu, { anchor, placement: 'below',
    initialFocus: menu.querySelector<HTMLElement>('.oac-menu__row[aria-checked="true"]') ?? undefined });
  return close;
}

/**
 * The layout picker: one row of tiles per chart count, the current layout
 * checked. Left and Right walk the tiles in order, Up and Down move between
 * rows at the same place, Home and End go to either end.
 */
export function openLayoutPicker(host: GridBarHost, anchor: HTMLElement): () => void {
  const doc = host.doc;
  const menu = h(doc, 'div', 'oac-grid__picker', { role: 'menu', 'aria-label': widgetText(txt(host), 'Layouts') });
  const rows: HTMLElement[][] = [];
  const current = host.layout();
  const byCount = new Map<number, ChartGridLayoutId[]>();
  for (const id of host.layouts) {
    const count = CHART_GRID_LAYOUTS[id].slots.length;
    byCount.set(count, [...(byCount.get(count) ?? []), id]);
  }
  let close: () => void = () => {};
  /**
   * The tiles are pictures, so a line under them names the one under the
   * pointer or the focus, and the current layout otherwise. A tooltip would
   * cover the next row of tiles; screen readers hear each tile's own label.
   */
  const describe = (id: ChartGridLayoutId): string =>
    widgetText(txt(host), '{name}, {count} charts', { name: layoutName(txt(host), id), count: CHART_GRID_LAYOUTS[id].slots.length });
  const caption = h(doc, 'div', 'oac-grid__picker-caption', { 'aria-hidden': 'true' });
  const rest = (): void => { caption.textContent = current !== null && isChartGridLayout(current) ? describe(current) : ''; };
  for (const [count, ids] of byCount) {
    const group = h(doc, 'div', 'oac-grid__picker-row', { role: 'group', 'aria-label': chartCount(txt(host), count) });
    const head = h(doc, 'span', 'oac-grid__picker-count', { 'aria-hidden': 'true' });
    head.textContent = String(count);
    group.appendChild(head);
    const tiles: HTMLElement[] = [];
    for (const id of ids) {
      const name = layoutName(txt(host), id);
      const tile = h(doc, 'button', 'oac-grid__tile', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(id === current), 'aria-label': name,
      });
      tile.dataset.layout = id;
      tile.appendChild(chrome(doc, layoutTileSvg(id)));
      const say = (): void => { caption.textContent = describe(id); };
      tile.addEventListener('pointerenter', say);
      tile.addEventListener('focus', say);
      tile.addEventListener('click', e => { e.stopPropagation(); close(); host.setLayout(id); });
      tiles.push(tile);
      group.appendChild(tile);
    }
    rows.push(tiles);
    menu.appendChild(group);
  }
  rest();
  menu.appendChild(caption);
  menu.addEventListener('pointerleave', () => { if (!menu.contains(doc.activeElement)) rest(); });
  const flat = rows.flat();
  menu.addEventListener('keydown', e => {
    const at = flat.indexOf(doc.activeElement as HTMLElement);
    if (at < 0) return;
    const row = rows.findIndex(r => r.includes(flat[at]));
    const col = rows[row].indexOf(flat[at]);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowRight') next = flat[(at + 1) % flat.length];
    else if (e.key === 'ArrowLeft') next = flat[(at - 1 + flat.length) % flat.length];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const to = rows[(row + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
      next = to[Math.min(col, to.length - 1)];
    } else if (e.key === 'Home') next = flat[0];
    else if (e.key === 'End') next = flat[flat.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
  });
  close = host.overlays.open(menu, { anchor, placement: 'below',
    initialFocus: flat.find(t => t.getAttribute('aria-checked') === 'true') ?? flat[0] ?? undefined });
  return close;
}

/**
 * The link menu for the active chart: which group it is in, a new group,
 * a name for the group, and the group's channels. Toggles leave the menu
 * open, so a user linking three channels opens it once.
 */
export function openLinkMenu(host: GridBarHost, anchor: HTMLElement): () => void {
  const doc = host.doc, t = txt(host);
  let renaming = false;
  const rows = (): Array<MenuItem | string> => {
    const current = host.links.current();
    const out: Array<MenuItem | string> = [widgetText(t, 'Link group')];
    out.push({ kind: 'radio', label: widgetText(t, 'Not linked'), checked: current === null, icon: groupMark(doc, null), stay: true,
      onSelect: () => host.links.setGroup(null) });
    for (const group of host.links.groups()) {
      out.push({ kind: 'radio', label: group.name, sub: chartCount(t, group.cells.length), checked: current?.id === group.id,
        icon: groupMark(doc, group), stay: true, onSelect: () => host.links.setGroup(group.id) });
    }
    out.push({ kind: 'action', label: widgetText(t, 'New group'), icon: chrome(doc, chromeIconSvg('plus')), stay: true, onSelect: () => host.links.newGroup() });
    out.push({ kind: 'action', label: widgetText(t, 'Rename group'), icon: chrome(doc, chromeIconSvg('rename')), disabled: current === null,
      sub: current === null ? widgetText(t, 'Link this chart to a group first') : undefined, stay: true, onSelect: () => { renaming = true; } });
    if (current === null) return out;
    out.push(widgetText(t, 'Links in {group}', { group: current.name }));
    const o = current.links;
    for (const channel of ['crosshair', 'viewport', 'symbol', 'interval', 'chartType', 'appearance', 'drawings'] as const) {
      out.push({ kind: 'check', label: widgetText(t, CHANNEL_LABEL[channel]), checked: o[channel], stay: true,
        icon: chrome(doc, CHANNEL_ICON[channel]), sub: channel === 'drawings' ? widgetText(t, 'same instrument only') : undefined,
        onSelect: () => host.links.setChannel(channel, !o[channel]) });
      if (channel === 'crosshair') {
        out.push({ kind: 'check', label: widgetText(t, 'Nearest bar'), sub: widgetText(t, 'where a chart has no bar at that time'),
          checked: o.whenMissing === 'nearest', disabled: !o.crosshair, stay: true, icon: h(doc, 'span', 'oac-grid__indent'),
          onSelect: () => host.links.setChannel('nearest', o.whenMissing !== 'nearest') });
      }
    }
    out.push({ kind: 'action', label: widgetText(t, 'Share this chart\'s drawings'), icon: chrome(doc, chromeIconSvg('drawing-sync')),
      disabled: !o.drawings, sub: o.drawings ? undefined : widgetText(t, 'Switch Drawings on first'), onSelect: () => host.links.share() });
    return out;
  };
  // Renaming swaps the rows for a field, in the same menu, so Escape and the
  // focus return behave as they do for the rows.
  const form = (menu: HTMLElement, repaint: () => void): void => {
    const current = host.links.current();
    if (!renaming || current === null) return;
    menu.textContent = '';
    const wrap = h(doc, 'div', 'oac-grid__rename');
    const input = h(doc, 'input', undefined, { type: 'text', 'aria-label': widgetText(t, 'Group name'), maxlength: '120' });
    input.value = current.name;
    const done = (save: boolean): void => {
      if (save && input.value.trim() !== '') host.links.rename(current.id, input.value.trim());
      renaming = false;
      repaint();
      menu.querySelector<HTMLElement>('.oac-menu__row[aria-checked="true"]')?.focus();
    };
    // Enter saves; Escape closes the menu like any other, leaving the name as it was.
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
    });
    const save = h(doc, 'button', 'oac-btn oac-btn--primary', { type: 'button' });
    save.textContent = widgetText(t, 'Save');
    save.addEventListener('click', e => { e.stopPropagation(); done(true); });
    const cancel = h(doc, 'button', 'oac-btn', { type: 'button' });
    cancel.textContent = widgetText(t, 'Cancel');
    cancel.addEventListener('click', e => { e.stopPropagation(); done(false); });
    wrap.append(input, cancel, save);
    menu.appendChild(wrap);
    input.focus();
    input.select();
  };
  return openRows(host, anchor, widgetText(t, 'Linking'), rows, form);
}

/** Download or copy one image of every chart; greyed with the reason while the grid shows one chart. */
export function openCaptureMenu(host: GridBarHost, anchor: HTMLElement): () => void {
  const t = txt(host);
  const blocked = host.capture.blocked();
  const copy = host.capture.canCopy();
  return openRows(host, anchor, widgetText(t, 'Capture every chart'), () => [
    { kind: 'action', label: widgetText(t, 'Download PNG of every chart'), disabled: blocked !== null,
      icon: chrome(host.doc, chromeIconSvg('download')), onSelect: () => host.capture.download() },
    { kind: 'action', label: widgetText(t, 'Copy image of every chart'), disabled: blocked !== null || !copy,
      sub: blocked !== null ? undefined : copy ? widgetText(t, 'paste it anywhere') : widgetText(t, 'needs https or localhost'),
      icon: chrome(host.doc, chromeIconSvg('copy')), onSelect: () => host.capture.copy() },
  ], undefined, blocked);
}

// ── the bar ──────────────────────────────────────────────────────────────

/** Mount the grid bar into `el`. */
export function mountGridBar(host: GridBarHost, el: HTMLElement): GridBarHandle {
  const doc = host.doc, t = txt(host);
  el.classList.add('oac-widget', 'oac-grid__bar');
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', widgetText(t, 'Chart grid'));
  const button = (className: string, label: string): HTMLButtonElement =>
    h(doc, 'button', `oac-btn ${className}`, { type: 'button', 'aria-label': label });
  const chev = (): HTMLElement => {
    const s = h(doc, 'span', 'oac-chev', { 'aria-hidden': 'true' });
    s.innerHTML = chromeIconSvg('chevron-down');
    return s;
  };

  const layout = button('oac-grid__layout', widgetText(t, 'Layout'));
  layout.setAttribute('aria-haspopup', 'menu');
  const layoutGlyph = chrome(doc, chromeIconSvg('layout'));
  const layoutText = h(doc, 'span', 'oac-grid__bar-text');
  layout.append(layoutGlyph, layoutText, chev());
  // The tip's title is also the button's name, so it carries the words the button shows.
  host.tips.attach(layout, () => {
    const id = host.layout();
    return { title: isChartGridLayout(id) ? widgetText(t, 'Layout: {name}', { name: layoutName(t, id) }) : widgetText(t, 'Layout'), side: 'bottom' };
  });
  layout.addEventListener('click', () => openLayoutPicker(host, layout));
  // A host that offers no layouts gets no picker, rather than one that opens empty.
  layout.hidden = host.layouts.length === 0;

  const max = button('oac-btn--icon oac-grid__max', widgetText(t, 'Maximize the chart'));
  const maxGlyph = chrome(doc, chromeIconSvg('maximize'));
  max.appendChild(maxGlyph);
  const maxLabel = (): string => widgetText(t, host.maximized() ? 'Restore the grid' : 'Maximize the chart');
  host.tips.attach(max, () => ({ title: maxLabel(), sub: host.maximizeBlocked() ?? undefined, side: 'bottom' }));
  max.addEventListener('click', () => { if (host.maximizeBlocked() === null) host.toggleMaximize(); });

  const link = button('oac-grid__link', widgetText(t, 'Link'));
  link.setAttribute('aria-haspopup', 'menu');
  const linkText = h(doc, 'span', 'oac-grid__bar-text');
  linkText.textContent = widgetText(t, 'Link');
  const linkMark = h(doc, 'span', 'oac-grid__bar-mark');
  link.append(chrome(doc, chromeIconSvg('link')), linkText, linkMark, chev());
  host.tips.attach(link, () => {
    const group = host.links.current();
    return { title: widgetText(t, 'Link: {name}', { name: group === null ? widgetText(t, 'Not linked') : group.name }), side: 'bottom' };
  });
  link.addEventListener('click', () => openLinkMenu(host, link));

  const capture = button('oac-btn--icon oac-grid__capture', widgetText(t, 'Capture every chart'));
  capture.setAttribute('aria-haspopup', 'menu');
  capture.appendChild(chrome(doc, chromeIconSvg('capture-grid')));
  host.tips.attach(capture, () => ({ title: widgetText(t, 'Capture every chart'), sub: host.capture.blocked() ?? undefined, side: 'bottom' }));
  capture.addEventListener('click', () => openCaptureMenu(host, capture));

  const sep = (): HTMLElement => h(doc, 'span', 'oac-sep', { role: 'separator' });
  el.append(layout, max, sep(), link, sep(), capture);

  // The desk's saved layouts, at the far end as in a chart's own bar: the
  // held layout's name, with a dot while it needs the user (unsaved, failing
  // or changed elsewhere), which its name then says in words.
  let saved: HTMLButtonElement | null = null;
  let offSaved: (() => void) | null = null;
  if (host.saved !== undefined) {
    const { controller } = host.saved;
    const title = widgetText(t, 'schema.ui.layouts.title', {}, 'Layouts');
    const held = (): string | null => {
      const state = controller.state();
      return state.catalog?.workspaces.find(doc => doc.id === state.layoutId)?.name ?? null;
    };
    const b = saved = button('oac-grid__saved', title);
    b.setAttribute('aria-haspopup', 'dialog');
    const name = h(doc, 'span', 'oac-grid__bar-text');
    b.append(chrome(doc, chromeIconSvg('folder')), name);
    host.tips.attach(b, () => {
      const at = held();
      return { title: at === null ? title : `${title}: ${at}`, sub: host.saved?.status(), side: 'bottom' };
    });
    const paint = (): void => {
      const attention = layoutNeedsAttention(controller.state());
      name.textContent = held() ?? title;
      b.dataset.attention = String(attention);
      host.tips.refreshLabel(b);
      if (attention) b.setAttribute('aria-label', `${b.getAttribute('aria-label') ?? title}, ${host.saved?.status() ?? ''}`);
    };
    offSaved = controller.subscribe(paint);
    paint();
    b.addEventListener('click', () => host.saved?.open(b));
    el.append(h(doc, 'span', 'oac-grid__spacer'), b);
  }
  // A toolbar's own keys: the arrows, Home and End move between its controls,
  // claimed here so no chart pans with them. Tab still reaches each one.
  const controls = [layout, max, link, capture, saved].filter((control): control is HTMLButtonElement => control !== null && !control.hidden);
  el.addEventListener('keydown', e => {
    const at = controls.indexOf(doc.activeElement as HTMLButtonElement);
    const to = at < 0 ? -1 : e.key === 'ArrowRight' ? (at + 1) % controls.length : e.key === 'ArrowLeft' ? (at + controls.length - 1) % controls.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? controls.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    controls[to].focus();
  });

  const refresh = (): void => {
    const id = host.layout();
    const known = isChartGridLayout(id);
    layoutGlyph.innerHTML = known ? layoutTileSvg(id) : chromeIconSvg('layout');
    layoutText.textContent = known ? layoutName(t, id) : '';
    layoutText.hidden = !known;
    const maxed = host.maximized();
    maxGlyph.innerHTML = chromeIconSvg(maxed ? 'restore' : 'maximize');
    max.setAttribute('aria-pressed', String(maxed));
    const blocked = host.maximizeBlocked();
    max.classList.toggle('is-off', blocked !== null);
    max.setAttribute('aria-disabled', String(blocked !== null));
    const group = host.links.current();
    linkMark.replaceChildren(groupMark(doc, group));
    capture.classList.toggle('is-off', host.capture.blocked() !== null);
    for (const control of [layout, max, link, capture]) host.tips.refreshLabel(control);
    // A tip already up says what was true when it opened; a layout picked
    // with the pointer still on the button would leave the previous layout named.
    const up = host.tips.target();
    if (up === layout || up === max || up === link || up === capture) host.tips.show(up);
  };
  refresh();
  return {
    el,
    refresh,
    destroy: () => { offSaved?.(); el.textContent = ''; },
  };
}
