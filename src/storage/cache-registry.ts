import type { ScipDatabase } from './db.js';

/**
 * Cache-clear registry — every per-db cache declares its invalidation
 * membership at creation, and invalidation iterates the registry.
 *
 * Soundness: registration and population happen in the same module scope.
 * A cache cannot hold data unless its module was loaded, and loading the
 * module registers it — so the registry can never under-cover a populated
 * cache. This replaces a hand-maintained registry in cache-invalidation.ts
 * that new caches could silently miss.
 *
 * Groups:
 * - 'whole-project'      cleared when composite analyses drop all source/
 *                        symbol evidence (e.g. between health phases).
 * - 'source-file'        cleared per file after a source-backed scan; the
 *                        cache key must be the normalized relative path.
 * - 'semantic-provider'  opt-in: expensive provider instances, cleared only
 *                        when a phase explicitly requests it.
 * - 'definition-catalog' opt-in: definition rows derived from the read-only
 *                        index, cleared per file only when a scan refines
 *                        definitions from source.
 *
 * Caches derived purely from the read-only SQLite index declare no groups
 * (explicit `clearGroups: []`) — they stay valid for the connection's life.
 */
// scip-query: ignore-stale — registry contract vocabulary; consumed via the
// factory options type as well as direct registrations.
export type CacheClearGroup =
  | 'whole-project'
  | 'source-file'
  | 'semantic-provider'
  | 'definition-catalog';

export interface CacheClearRegistration {
  name: string;
  groups: readonly CacheClearGroup[];
  clearAll: (db: ScipDatabase) => void;
  /** Per-file clear for path-keyed caches; falls back to clearAll if absent. */
  clearFile?: (db: ScipDatabase, relativePath: string) => void;
}

const registrations: CacheClearRegistration[] = [];

/**
 * Register clear hooks for a cache. Factory-created caches register
 * automatically; module-level caches that don't go through a factory
 * (singleton variables, provider maps) call this directly.
 */
export function registerCacheClear(registration: CacheClearRegistration): void {
  if (registration.groups.length > 0) registrations.push(registration);
}

export function clearRegisteredCaches(
  db: ScipDatabase,
  opts: { groups: readonly CacheClearGroup[]; file?: string },
): void {
  const requested = new Set(opts.groups);
  for (const registration of registrations) {
    if (!registration.groups.some((group) => requested.has(group))) continue;
    if (opts.file !== undefined && registration.clearFile) {
      registration.clearFile(db, opts.file);
    } else {
      registration.clearAll(db);
    }
  }
}
