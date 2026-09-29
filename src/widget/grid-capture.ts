/**
 * One picture of a whole chart grid: every chart's own screenshot, put where
 * the chart sits on the grid, over the grid's gutters and each cell's chrome.
 *
 * Pure apart from the canvas it draws into, so the placement can be checked
 * against a recording canvas without a browser. The chrome itself (a top bar,
 * a status line) is DOM, not paint, and a canvas cannot copy it; each cell's
 * chrome is drawn as a plain panel carrying the chart's symbol and interval,
 * so the picture still says which chart is which.
 */

/** A rectangle in CSS pixels, relative to the grid's cells area. */
export interface CaptureBox { left: number; top: number; width: number; height: number }

export interface GridCapturePiece {
  /** The cell's whole box: its chart and its chrome. */
  readonly cell: CaptureBox;
  /** Where the chart's plot sits inside it. */
  readonly chart: CaptureBox;
  /** The chart's own screenshot, device pixels; null for a chart with nothing to show. */
  readonly image: HTMLCanvasElement | null;
  /** Written in the cell's top chrome, when there is room above the chart. */
  readonly label: string;
}

export interface GridCaptureColors {
  /** Behind everything: what shows through the gutters between cells. */
  readonly gutter: string;
  /** Each cell's chrome. */
  readonly panel: string;
  readonly text: string;
  readonly font: string;
}

/** The smallest band of chrome worth writing a label in, CSS pixels. */
const LABEL_ROOM = 14;

/**
 * The device pixel ratio the charts drew at: a screenshot's width over its
 * chart's CSS width, from the first chart that has both. One page draws every
 * chart at one ratio; `fallback`, the page's own ratio, covers a grid whose
 * charts are all unmeasured.
 */
export function captureRatio(pieces: readonly GridCapturePiece[], fallback: number): number {
  for (const piece of pieces) {
    if (piece.image === null || piece.image.width <= 1 || piece.chart.width <= 0) continue;
    // A canvas is a whole number of device pixels, so at a fractional ratio
    // (1.25, 1.5) the quotient reads a hair low and the picture comes out a
    // pixel short of the grid. When the page's ratio accounts for the canvas
    // to within that pixel, it is the exact one.
    if (fallback > 0 && Math.abs(piece.image.width - piece.chart.width * fallback) <= 1) return fallback;
    return piece.image.width / piece.chart.width;
  }
  return fallback > 0 ? fallback : 1;
}

/**
 * Compose the grid: `size` is the cells area in CSS pixels, `ratio` the device
 * pixels per CSS pixel. Every placement is rounded to whole device pixels, so
 * neighbouring cells meet without a seam or an overlap.
 */
export function composeGridCapture(doc: Document, size: { width: number; height: number }, ratio: number,
  pieces: readonly GridCapturePiece[], colors: GridCaptureColors): HTMLCanvasElement {
  const out = doc.createElement('canvas');
  const px = (v: number): number => Math.round(v * ratio);
  out.width = Math.max(1, px(size.width));
  out.height = Math.max(1, px(size.height));
  const g = out.getContext('2d');
  if (g === null) return out;
  g.fillStyle = colors.gutter;
  g.fillRect(0, 0, out.width, out.height);
  for (const piece of pieces) {
    const { cell, chart } = piece;
    g.fillStyle = colors.panel;
    g.fillRect(px(cell.left), px(cell.top), px(cell.left + cell.width) - px(cell.left), px(cell.top + cell.height) - px(cell.top));
    const room = chart.top - cell.top;
    if (room >= LABEL_ROOM && piece.label !== '') {
      g.fillStyle = colors.text;
      g.font = `600 ${px(12)}px ${colors.font}`;
      g.textBaseline = 'middle';
      g.fillText(piece.label, px(cell.left + 8), px(cell.top + room / 2), px(Math.max(0, cell.width - 16)));
    }
    // A hidden or unmeasured chart has no image to give; its panel stays plain.
    if (piece.image === null || piece.image.width <= 1 || chart.width <= 0 || chart.height <= 0) continue;
    g.drawImage(piece.image, px(chart.left), px(chart.top), px(chart.left + chart.width) - px(chart.left), px(chart.top + chart.height) - px(chart.top));
  }
  return out;
}
