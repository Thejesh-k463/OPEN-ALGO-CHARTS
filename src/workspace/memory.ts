import { number, readJson, string, WorkspaceDocumentError } from './json';
import { parseWorkspaceCatalog, WorkspaceConflictError, type WorkspaceStorage } from './repository';

const copy = <T>(value: T): T => readJson(value) as T;

/**
 * Revision-checked workspace storage in memory: for tests, previews and hosts
 * without IndexedDB. Nothing outlives the page. `seed` maps namespaces to
 * catalogs. It keeps the IndexedDB adapter's contract: a stale or skipping
 * write is refused, and a corrupt stored catalog is never replaced.
 */
export function createMemoryWorkspaceStorage(seed: Readonly<Record<string, unknown>> = {}): WorkspaceStorage {
  // Copies in and out: a caller holding a seed or a read value cannot reach the stored one.
  const values = new Map<string, unknown>(Object.entries(seed).map(([key, value]) => [key, copy(value)]));
  return {
    async read(namespace) {
      const value = values.get(string(namespace, 'storage namespace'));
      return value === undefined ? null : copy(value);
    },
    async write(namespace, catalog, expectedRevision, options) {
      options?.signal?.throwIfAborted();
      const key = string(namespace, 'storage namespace');
      const expected = number(expectedRevision, 'expected revision', 0, Number.MAX_SAFE_INTEGER, true);
      const next = parseWorkspaceCatalog(catalog);
      if (next.revision !== expected + 1) throw new WorkspaceDocumentError('A write must advance the catalog revision by one');
      const previous = values.get(key);
      // Nothing awaits between the comparison and the write, so it is atomic.
      if ((previous === undefined ? 0 : parseWorkspaceCatalog(previous).revision) !== expected) throw new WorkspaceConflictError();
      values.set(key, next);
    },
  };
}
