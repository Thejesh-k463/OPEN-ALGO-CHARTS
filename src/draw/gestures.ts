/**
 * The pointer gestures that make no drawing of their own. Shift+click on
 * empty chart space lays down a ruler for a moment: a preview of the measure
 * tool from the click to the pointer, gone on the next click or on Escape.
 *
 * Nothing here enters the model. A ruler is a preview, painted in the slot a
 * shape being placed uses, so it is never saved, never an undo step, never
 * announced as a drawing and never carried to another chart by a link.
 */
import type { Drawing, DrawingPoint, DrawingStyle } from './types';
import { getDrawingTool, hasDrawingTool } from './tools';
import type { DrawingGestureOptions } from './controller';

/** The modifier keys a pointer report carried. `mod` is Ctrl or Cmd. */
export interface GestureKeys {
  shift: boolean;
  mod: boolean;
  alt: boolean;
}

/** A chart click as the gestures read it. */
export interface GestureClick {
  id: string | null;
  time: number;
  price: number | null;
  paneIndex: number;
  viaDrag?: boolean;
  keys: GestureKeys;
}

/** Where the pointer is, in data space, on which pane. */
export interface GestureCursor {
  time: number;
  price: number;
  paneIndex: number;
}

/** What the gestures need of the controller that owns them. */
export interface GestureHost {
  /** The armed drawing tool, or null. */
  tool(): string | null;
  /** The gestures the host has left on. */
  options(): Required<DrawingGestureOptions>;
  /** Where a click at `point` lands on `paneIndex`, the magnet included. */
  aim(point: DrawingPoint, paneIndex: number): DrawingPoint;
  /** The style a preview is painted in. */
  style(): DrawingStyle;
  /** Paint the preview slot again: what `ruler` returns has changed. */
  preview(): void;
  emit(event: string, payload: unknown): void;
}

/** The id of the ruler's preview. It is never a drawing, so it never collides with one. */
const RULER_ID = '__measure';

export class DrawingGestures {
  private readonly _host: GestureHost;
  private _measure: { pane: number; start: DrawingPoint; end: DrawingPoint } | null = null;

  public constructor(host: GestureHost) {
    this._host = host;
  }

  /** Whether a temporary measure is on the chart. */
  public measuring(): boolean {
    return this._measure !== null;
  }

  /**
   * A click the gestures take, true when it was theirs and nothing else is
   * to act on it. Any click ends a ruler: it is there to be read and let go
   * of, and a click that also selected or placed something would be two acts
   * for one press. A Shift+click on empty space, with no tool armed, starts
   * one; with a tool armed Shift is the angle lock, and on a drawing it adds
   * to the selection.
   */
  public click(p: GestureClick): boolean {
    if (this.endMeasure()) return true;
    const { shift, mod, alt } = p.keys;
    if (!this._host.options().measure || this._host.tool() !== null || p.id !== null || p.viaDrag === true
      || !shift || mod || alt || p.price === null || !Number.isFinite(p.price) || !Number.isFinite(p.time)
      || !hasDrawingTool('measure')) return false;
    const start = this._host.aim({ time: p.time, price: p.price }, p.paneIndex);
    this._measure = { pane: p.paneIndex, start, end: start };
    this._host.preview();
    this._host.emit('draw:measure', { active: true });
    return true;
  }

  /**
   * Follow the pointer with the ruler's far end, on the pane it started on.
   * True when the ruler moved. A pointer off that pane leaves the end where
   * it last was, so the reading stays up while the hand passes elsewhere.
   */
  public follow(cursor: GestureCursor | null): boolean {
    const m = this._measure;
    if (m === null || cursor === null || cursor.paneIndex !== m.pane) return false;
    m.end = this._host.aim({ time: cursor.time, price: cursor.price }, m.pane);
    return true;
  }

  /** The ruler as the preview slot paints it, or null when there is none. */
  public ruler(): Drawing | null {
    const m = this._measure;
    if (m === null) return null;
    return {
      id: RULER_ID, tool: 'measure', points: [{ ...m.start }, { ...m.end }], paneIndex: m.pane, zIndex: 0,
      style: { ...this._host.style(), ...getDrawingTool('measure').defaultStyle },
    };
  }

  /** Take the ruler away. True when there was one. */
  public endMeasure(): boolean {
    if (this._measure === null) return false;
    this._measure = null;
    this._host.preview();
    this._host.emit('draw:measure', { active: false });
    return true;
  }

  /** End every gesture in hand: the chart under it changed, or the controller is going. */
  public reset(): void {
    this.endMeasure();
  }
}
