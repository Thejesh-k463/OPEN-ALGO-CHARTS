/**
 * The parts of the widget that load on first use.
 *
 * A plain widget never opens the shortcuts editor, the Layouts menu or the
 * indicator templates list, and never shows a grid's bar or its menus, so
 * none of them rides in the tier's own file: the build writes each one
 * beside it (rollup.config.js) and `import()` fetches it the first time
 * someone asks for it. Once a part has arrived it is used at once, as if it had been
 * bundled in; until then the request waits for it. A load that fails is reported where the user asked,
 * and forgotten, so the next request tries again rather than failing for the
 * rest of the page's life.
 *
 * Each part is declared beside the one control that opens it. The tier entry
 * exports none of this.
 */
import { widgetText, type WidgetTranslationOptions } from './localization';

export interface LazyPart<T> {
  /** The module once it has arrived, else null. */
  now: T | null;
  /** Fetch it once: every caller shares the load in flight. */
  load(): Promise<T>;
}

/** The parts declared so far, which `loadWidgetParts` fetches. */
const declared: Array<LazyPart<unknown>> = [];

/** A part fetched with `load` on first use. */
export function lazyPart<T>(load: () => Promise<T>): LazyPart<T> {
  let loading: Promise<T> | null = null;
  const part: LazyPart<T> = {
    now: null,
    load: () => (loading ??= load().then(module => (part.now = module), (error: unknown) => {
      loading = null;
      throw error;
    })),
  };
  declared.push(part);
  return part;
}

/**
 * Run `use` with a part: at once when it has arrived, else when it does,
 * unless `live` says by then that whoever asked has gone. A failed load goes
 * to `failed` on the same terms.
 */
export function usePart<T>(part: LazyPart<T>, use: (module: T) => void, failed: (error: unknown) => void, live: () => boolean): void {
  if (part.now !== null) { use(part.now); return; }
  part.load().then(module => { if (live()) use(module); }, (error: unknown) => { if (live()) failed(error); });
}

/** What a part that could not load says: its name and the reason. */
export function partFailed(text: WidgetTranslationOptions, name: string, error: unknown): string {
  return widgetText(text, '{name} could not load: {error}', { name, error: error instanceof Error ? error.message : String(error) });
}

/**
 * Fetch every part declared so far. The unit tests open the parts the way a
 * page does once they have arrived; the late and failed loads have tests of
 * their own.
 */
export function loadWidgetParts(): Promise<unknown[]> {
  return Promise.all(declared.map(part => part.load()));
}
