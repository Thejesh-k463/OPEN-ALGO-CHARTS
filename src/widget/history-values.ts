/**
 * The value-level helpers of the chart-wide history (history.ts): equality
 * over the plain data a capture holds, and the study-source references inside
 * a study's settings. Pure and stateless, so they live apart from the class
 * that records and walks the steps.
 */
import type { IndicatorSettings } from 'openalgo-charts';

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural equality for the plain data a capture holds. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!same(a[key], b[key])) return false;
  return true;
}

export const isSource = (v: unknown): v is { kind: 'indicator'; instanceId: string; plotKey: string } =>
  isRecord(v) && v.kind === 'indicator' && typeof v.instanceId === 'string';

/** Settings with every study-source reference renamed, as a detached copy. */
export function renameSources(settings: Readonly<IndicatorSettings>, rename: (id: string) => string): IndicatorSettings {
  const out: IndicatorSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    out[key] = isSource(value) ? { ...value, instanceId: rename(value.instanceId) }
      : Array.isArray(value) ? value.map(item => (isRecord(item) ? { ...item } : item)) as never
      : isRecord(value) ? { ...value } as never : value;
  }
  return out;
}
