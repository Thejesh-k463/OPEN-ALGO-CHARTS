/**
 * The shell's keyboard: the scopes a chord is resolved in, the pointer facts
 * those scopes read, and the bindings the shell registers on its keymap (the
 * editing keys, Escape, the tool chords and the shortcuts panel).
 *
 * Its own module so the keyboard can grow (rebinding, capturing a new chord,
 * saved overrides) while widget.ts stays under its line cap. The shell wires
 * these functions while it is built, calling each with itself as `this`,
 * typed `KeysHost`. Each member carries the name and the type of the shell's
 * own, so a member the shell renames or retypes fails to compile here. The
 * code keeps `this` rather than taking the shell as a parameter because it
 * then reads exactly as it did in widget.ts and compresses like the rest of
 * the shell, where the parameter form measurably grew the widget bundle.
 * The tier entry exports none of it.
 */
import { drawingShortcuts, keyToDrawingAction, type DrawingKeyContext } from 'openalgo-charts/draw';
import { historyPress } from './context';
import { openShortcutsPanel, type KeyEventLike, type KeyScope } from './keymap';
import { toolName } from './rail';
import type { WidgetImpl } from './widget';

/**
 * The slice of the shell the keyboard reads and drives. `_inChart` stays on
 * the shell because the engine's shortcut routing asks it too.
 */
export interface KeysHost {
  readonly draw: WidgetImpl['draw'];
  readonly alerts: WidgetImpl['alerts'];
  readonly context: WidgetImpl['context'];
  readonly root: WidgetImpl['root'];
  readonly _doc: WidgetImpl['_doc'];
  readonly _opts: WidgetImpl['_opts'];
  readonly _keymap: WidgetImpl['_keymap'];
  readonly _chartEl: WidgetImpl['_chartEl'];
  readonly _dataStatus: WidgetImpl['_dataStatus'];
  readonly _rail: WidgetImpl['_rail'];
  readonly _cleanups: WidgetImpl['_cleanups'];
  _pointerInside: WidgetImpl['_pointerInside'];
  _pointerInChart: WidgetImpl['_pointerInChart'];
  readonly _inChart: WidgetImpl['_inChart'];
}

/** The scopes a chord is resolved in, innermost first. The keymap asks on every key. */
export function keyScopes(this: KeysHost): KeyScope[] {
  if (this.context.overlays.size() > 0) return ['overlay'];
  const out: KeyScope[] = [];
  const active = this._doc.activeElement;
  const routed = this._opts.keyboardRoute?.();
  if (routed === false || (active !== null && this._dataStatus.el.contains(active))) return [];
  // A control that walks itself with the arrows (the drawing toolbar) names its own scope.
  const own = active !== null && this.root.contains(active) ? active.closest('[data-key-scope]')?.getAttribute('data-key-scope') : null;
  if (own) out.push(own);
  if (this._rail !== null && active !== null && this._rail.el.contains(active)) out.push('rail');
  if (routed || this._inChart()) out.push('chart');
  if (routed || this._pointerInside || (active !== null && this.root.contains(active))) out.push('widget');
  out.push('global');
  return out;
}

/** Every chord the shell owns: the editing keys, Escape, the tool chords and `?`. */
export function installKeys(this: KeysHost): void {
  const km = this._keymap;
  const draw = this.draw;
  const drawCtx = (): DrawingKeyContext => ({
    hasSelection: draw.selected() !== null,
    hasTarget: draw.hovered() !== null,
    editingText: false,
    placing: draw.activeTool() !== null,
  });
  const targets = (): string[] => {
    const sel = draw.selection();
    if (sel.length > 0) return sel.slice();
    const hov = draw.hovered();
    return hov === null ? [] : [hov];
  };
  // One handler for every editing key: the tier says what the key means
  // for the selection or the placement in hand, and a key that means
  // nothing right now is declined so the engine (an arrow pan) still gets it.
  const editing = (e: KeyEventLike): boolean => {
    const action = keyToDrawingAction(e, drawCtx());
    // Alert deletion is a fallback: a drawing selection, hover or active
    // tool keeps ownership even when the pointer is over an alert line.
    if (action === null) {
      const alertId = this.alerts.hovered();
      if (alertId !== undefined && draw.activeTool() === null && (e.key === 'Delete' || e.key === 'Backspace')) {
        this.alerts.remove(alertId);
        this._rail?.refresh();
        return true;
      }
      return false;
    }
    switch (action.type) {
      // The chart-wide timeline: a drawing, a study and a pane in the order they were made.
      case 'undo': historyPress(this.context, 'undo'); break;
      case 'redo': historyPress(this.context, 'redo'); break;
      case 'delete': draw.removeMany(targets()); break;
      case 'duplicate': draw.duplicate(targets()); break;
      case 'nudge': draw.nudge(targets(), action.dx, action.dy); break;
      case 'cancel': draw.cancel(); if (draw.activeTool() === null) this._rail?.setDrawLock(false); break;
      case 'finish': draw.finish(); break;
      case 'popAnchor': draw.popAnchor(); break;
      case 'copy': void draw.copy(targets()); break;
      case 'cut': void draw.cut(targets()); break;
      case 'paste': void draw.paste(); break;
    }
    this._rail?.refresh();
    return true;
  };
  const G = 'Drawing';
  // The arrows are layered: with nothing selected they decline and the
  // engine's pan runs, so they are not a conflict with it.
  const edit = (combo: string, label: string, hidden = false, layered = false, group = G): void => {
    km.register(combo, editing, 'widget', { label, group, hidden, layered });
  };
  // Undo and redo reach every step on the chart, not only drawings.
  edit('Mod+Z', 'Undo', false, false, 'Widget');
  edit('Mod+Shift+Z', 'Redo', false, false, 'Widget');
  edit('Mod+Y', 'Redo', true, false, 'Widget');
  edit('Mod+C', 'Copy the selected drawing');
  edit('Mod+X', 'Cut the selected drawing');
  edit('Mod+V', 'Paste drawings');
  edit('Mod+D', 'Duplicate the selected drawing');
  edit('Delete', 'Delete the selected drawing');
  edit('Backspace', 'Delete, or drop the last anchor while placing');
  edit('Enter', 'Finish the drawing being placed');
  edit('ArrowLeft', 'Nudge the selection left (Shift: ten pixels)', false, true);
  edit('ArrowRight', 'Nudge the selection right (Shift: ten pixels)', false, true);
  edit('ArrowUp', 'Nudge the selection up (Shift: ten pixels)', false, true);
  edit('ArrowDown', 'Nudge the selection down (Shift: ten pixels)', false, true);
  for (const k of ['Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown']) edit(k, 'Nudge ten pixels', true, true);
  km.register('Escape', (e) => {
    if (draw.activeTool() !== null) {
      if (editing(e)) return true;
      draw.setTool(null);
      this._rail?.setDrawLock(false);
      return true;
    }
    if (draw.selection().length > 0) { draw.select(null); this._rail?.refresh(); return true; }
    return false;
  }, 'widget', { label: 'Leave the tool, then clear the selection', group: G });
  for (const [id, chord] of Object.entries(drawingShortcuts())) {
    km.register(chord, () => { this._rail?.setDrawLock(false); draw.setTool(id); }, 'widget', { label: toolName(id), group: 'Drawing tools' });
  }
  km.register('?', () => { openShortcutsPanel(this.context); }, 'widget', { label: 'Keyboard shortcuts', group: 'Widget' });
}

/** The pointer facts `keyScopes` and `_inChart` read; the listeners go with the shell. */
export function trackPointer(this: KeysHost): void {
  const root = this.root;
  const chartEl = this._chartEl;
  const onRootEnter = (): void => { this._pointerInside = true; };
  const onRootLeave = (): void => { this._pointerInside = false; this._pointerInChart = false; };
  const onChartEnter = (): void => { this._pointerInChart = true; };
  const onChartLeave = (): void => { this._pointerInChart = false; };
  root.addEventListener('pointerenter', onRootEnter);
  root.addEventListener('pointerleave', onRootLeave);
  chartEl.addEventListener('pointerenter', onChartEnter);
  chartEl.addEventListener('pointerleave', onChartLeave);
  this._cleanups.push(() => {
    root.removeEventListener('pointerenter', onRootEnter);
    root.removeEventListener('pointerleave', onRootLeave);
    chartEl.removeEventListener('pointerenter', onChartEnter);
    chartEl.removeEventListener('pointerleave', onChartLeave);
  });
}
