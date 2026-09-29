/**
 * Saved layouts and indicator templates for one widget, from the store its
 * host passes as `WidgetOptions.workspaces`: a layouts controller over the
 * widget itself (or the one a chart grid hands every chart), the Layouts menu
 * the top bar and the phone layout open, and the store the indicator picker
 * offers templates from.
 *
 * Its own module so widget.ts carries only the option and the mount call.
 * On creation it reopens the layout that was active when the page last
 * closed, so a reload continues where autosave left off; the layout replaces
 * the chart the host started with, as opening it from the menu would.
 */
import type { WorkspaceStore } from 'openalgo-charts/workspace';
import type { PanelHandle } from './form';
import { createLayoutsController, type LayoutsController } from './layouts';
import { openLayoutsMenu } from './layouts-menu';
import { widgetLayoutTarget } from './layouts-target';
import { bindTemplateStore } from './layouts-templates';
import { widgetText } from './localization';
import type { Widget } from './widget';

/** What the widget holds for its layouts; internal. */
export interface WidgetLayouts {
  /** What the Layouts menu drives, or null when the widget shows no menu. */
  readonly controller: LayoutsController | null;
  /** Open the Layouts menu, under `anchor` when given. False without a controller or after destroy. */
  open(anchor?: HTMLElement): boolean;
  destroy(): void;
}

export interface WidgetLayoutsOptions {
  workspaces?: WorkspaceStore;
  layouts?: LayoutsController | false;
}

/** Wire `widget`'s layouts and templates, or null when its host passed neither a store nor a controller. */
export function attachWidgetLayouts(widget: Widget, options: WidgetLayoutsOptions): WidgetLayouts | null {
  const store = options.workspaces;
  const given = options.layouts === false ? null : options.layouts ?? null;
  if (store === undefined && given === null) return null;
  const ctx = widget.context;
  const text = (key: string, fallback: string, values: Record<string, string | number> = {}): string =>
    widgetText(ctx, `schema.ui.layouts.${key}`, values, fallback);
  bindTemplateStore(ctx, store);
  // A controller handed over belongs to its maker (a grid, over all its charts): used, never reopened or destroyed here.
  const own = given === null && options.layouts !== false && store !== undefined ? createLayoutsController(store, widgetLayoutTarget(widget)) : null;
  const controller = given ?? own;
  let menu: PanelHandle | null = null;
  let destroyed = false;
  let failing = false;
  // An autosave that stops is said once on the status line: the menu may be closed.
  const offState = own?.subscribe(state => {
    const failed = state.autosave === 'failed' && !state.conflict;
    if (failed && !failing) ctx.status(text('autosaveStopped', 'Autosave stopped: the layout could not be saved'), 'error');
    else if (state.conflict && !failing) ctx.status(text('conflictStatus', 'The layout was changed in another window'), 'error');
    failing = failed || state.conflict;
  });
  // A change inside autosave's quiet period is written when the page is hidden:
  // a tab switched away from may be closed without coming back. Best effort on
  // pagehide, since the store's write may not finish before the page goes.
  const doc = ctx.document;
  const win = doc.defaultView;
  const flushHidden = (): void => { if (doc.visibilityState === 'hidden') void own?.flush(); };
  const flushGone = (): void => { void own?.flush(); };
  if (own !== null) {
    doc.addEventListener('visibilitychange', flushHidden);
    win?.addEventListener('pagehide', flushGone);
    void own.reload().then(async catalog => {
      if (destroyed || catalog.activeWorkspaceId === null) return;
      const report = await own.open(catalog.activeWorkspaceId);
      if (!report.applied && !destroyed) ctx.status(text('notReopened', 'The last layout could not open here: {error}', { error: report.reason ?? '' }), 'error');
    }).catch((error: unknown) => {
      if (!destroyed) ctx.status(text('notLoaded', 'Saved layouts could not be read: {error}', { error: error instanceof Error ? error.message : String(error) }), 'error');
    });
  }
  return {
    controller,
    open(anchor) {
      if (destroyed || controller === null) return false;
      if (menu?.isOpen()) { menu.el.focus(); return true; }
      menu = openLayoutsMenu(ctx, controller, anchor);
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      menu?.close();
      offState?.();
      doc.removeEventListener('visibilitychange', flushHidden);
      win?.removeEventListener('pagehide', flushGone);
      own?.destroy();
      bindTemplateStore(ctx, undefined);
    },
  };
}
