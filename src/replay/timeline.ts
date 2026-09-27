import type { Bar } from '../model/bar';
import { foldFiner, formingWithin, startFiner } from './forming';

/** UTC seconds when this recorded candle becomes complete and available. */
export type ReplayBarEndTime = (bar: Bar, index: number) => number;

/** Explicit availability avoids treating a coarse candle's open as its close. */
export interface ReplayTiming {
  barEndTime: ReplayBarEndTime;
  /** Required with finer bars; their final prices also need a known availability time. */
  subBarEndTime?: ReplayBarEndTime;
}

interface ReplayPoint {
  time: number;
  index: number;
  subIndex: number;
  subSteps: number;
  bar: Bar;
}

function ends(bars: readonly Bar[], resolve: ReplayBarEndTime): number[] {
  return bars.map((bar, index) => {
    const time = bar.time, end = resolve(bar, index), next = bars[index + 1]?.time;
    if (!Number.isFinite(time) || !Number.isFinite(end) || end < time
      || (index > 0 && time <= bars[index - 1].time)
      || (next !== undefined && end > next)) {
      throw new Error('openalgo-charts: replay time must be finite, ordered and within its candle interval');
    }
    return end;
  });
}

/** Internal immutable observation index. It never infers a session from a gap. */
export class ReplayTimeline {
  public readonly points: ReplayPoint[] = [];
  public readonly ends: number[];
  public readonly steps: number[] = [];

  public constructor(bars: readonly Bar[], subs: readonly Bar[], timing: ReplayTiming) {
    this.ends = ends(bars, timing.barEndTime);
    if (subs.length && !timing.subBarEndTime) throw new Error('openalgo-charts: replay timing needs subBarEndTime');
    const subEnds = subs.length ? ends(subs, timing.subBarEndTime!) : [];
    let cursor = 0;
    for (let index = 0; index < bars.length; index++) {
      const full = bars[index], end = this.ends[index], from = this.points.length;
      while (cursor < subs.length && subs[cursor].time < full.time) cursor++;
      let partial: Bar | undefined, covered = full.time, gap = false;
      while (cursor < subs.length && subs[cursor].time < end) {
        const sub = subs[cursor], available = subEnds[cursor++];
        // A gap or straddling observation cannot establish the whole candle's
        // high/low. Keep the last known prefix until the full bar is available.
        if (sub.time !== covered || available > end) gap = true;
        if (gap) continue;
        covered = available;
        if (!partial) partial = startFiner(sub, full.time);
        else foldFiner(partial, sub);
        if (available >= end) continue;
        // Held inside the candle it closes on, so the open never moves and
        // nothing shrinks back when the full bar replaces it (`formingWithin`).
        const shown = formingWithin(partial, full);
        const last = this.points[this.points.length - 1];
        if (last?.index === index && last.time === available) last.bar = shown;
        else this.points.push({ time: available, index, subIndex: 0, subSteps: 0, bar: shown });
      }
      this.points.push({ time: end, index, subIndex: 0, subSteps: 0, bar: full });
      const count = this.points.length - from;
      this.steps[index] = count;
      for (let i = from; i < this.points.length; i++) {
        this.points[i].subIndex = i - from;
        this.points[i].subSteps = count;
      }
    }
  }

  /** Last available observation, or -1 before any price is known. */
  public at(time: number): number {
    let from = 0, to = this.points.length;
    while (from < to) {
      const mid = (from + to) >>> 1;
      if (this.points[mid].time <= time) from = mid + 1;
      else to = mid;
    }
    return from - 1;
  }
}
