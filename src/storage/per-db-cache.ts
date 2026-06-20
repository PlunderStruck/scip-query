import type { ScipDatabase } from './db.js';
import { registerCacheClear, type CacheClearGroup } from './cache-registry.js';

/**
 * Per-database keyed cache. Computes once per (db, key); subsequent calls hit
 * cache. The DB is held weakly so closing a DB doesn't leak its entries.
 *
 * Every factory requires `clearGroups` — the cache's invalidation membership
 * (see cache-registry.ts). Pass an explicit `[]` for caches derived purely
 * from the read-only index, with a comment saying why. Caches in the
 * 'source-file' group MUST be keyed by normalized relative path.
 */
export interface PerDbCacheOptions {
  clearGroups: readonly CacheClearGroup[];
}

export interface PerDbCache<K, V> {
  /** Get-or-compute. Computes once per (db, key). */
  get(db: ScipDatabase, key: K, compute: () => V): V;
  /** Drop one key for one DB. */
  invalidate(db: ScipDatabase, key: K): void;
  /** Drop all keys for one DB. */
  invalidateAll(db: ScipDatabase): void;
  /** Number of entries cached for `db`. For observability. */
  size(db: ScipDatabase): number;
}

/**
 * Per-database single-value cache. Computes once per db.
 */
export interface PerDbValue<V> {
  get(db: ScipDatabase, compute: () => V): V;
  invalidate(db: ScipDatabase): void;
  has(db: ScipDatabase): boolean;
}

/** Shared per-db map store — the WeakMap-ensure boilerplate both keyed factories need. */
function createPerDbMapStore<K, V>(): {
  cache: WeakMap<ScipDatabase, Map<K, V>>;
  ensure: (db: ScipDatabase) => Map<K, V>;
} {
  const cache = new WeakMap<ScipDatabase, Map<K, V>>();
  return {
    cache,
    ensure(db) {
      let m = cache.get(db);
      if (!m) {
        m = new Map<K, V>();
        cache.set(db, m);
      }
      return m;
    },
  };
}

export function createPerDbCache<K, V>(name: string, opts: PerDbCacheOptions): PerDbCache<K, V> {
  const { cache, ensure } = createPerDbMapStore<K, V>();
  const api: PerDbCache<K, V> = {
    get(db, key, compute) {
      const m = ensure(db);
      if (m.has(key)) return m.get(key) as V;
      const value = compute();
      m.set(key, value);
      return value;
    },
    invalidate(db, key) {
      cache.get(db)?.delete(key);
    },
    invalidateAll(db) {
      cache.delete(db);
    },
    size(db) {
      return cache.get(db)?.size ?? 0;
    },
  };
  registerCacheClear({
    name,
    groups: opts.clearGroups,
    clearAll: (db) => api.invalidateAll(db),
    // Sound only for path-keyed caches — the 'source-file' group contract.
    clearFile: (db, relativePath) => api.invalidate(db, relativePath as unknown as K),
  });
  return api;
}

export function createPerDbValue<V>(name: string, opts: PerDbCacheOptions): PerDbValue<V> {
  const cache = new WeakMap<ScipDatabase, { value: V }>();
  const api: PerDbValue<V> = {
    get(db, compute) {
      const cached = cache.get(db);
      if (cached) return cached.value;
      const value = compute();
      cache.set(db, { value });
      return value;
    },
    invalidate(db) {
      cache.delete(db);
    },
    has(db) {
      return cache.has(db);
    },
  };
  registerCacheClear({
    name,
    groups: opts.clearGroups,
    clearAll: (db) => api.invalidate(db),
    // Single value per db — a file-scoped clear conservatively drops it all.
  });
  return api;
}

/**
 * Per-database cache keyed by file path with source-equality invalidation.
 * Use when the cached value would go stale if the file's contents change
 * (parsed AST, stripped source lines, etc.). Compares the current source
 * string identity against the cached one; recomputes on mismatch.
 */
export interface PerDbSourceCache<V> {
  get(db: ScipDatabase, file: string, source: string, compute: () => V): V;
  invalidate(db: ScipDatabase, file: string): void;
  invalidateAll(db: ScipDatabase): void;
}

const SOURCE_FILE_CACHE_OPTIONS = {
  clearGroups: ['whole-project', 'source-file'],
} as const;

export function createSourceFileCache<V>(name: string): PerDbSourceCache<V> {
  return createPerDbSourceCache<V>(name, SOURCE_FILE_CACHE_OPTIONS);
}

// scip-query: ignore-similar — deliberately mirrors createPerDbCache; the
// source-equality check in get() is the contract difference, and folding the
// two factories into one strategy-parameterized function would hide it.
export function createPerDbSourceCache<V>(name: string, opts: PerDbCacheOptions): PerDbSourceCache<V> {
  const { cache, ensure } = createPerDbMapStore<string, { source: string; value: V }>();
  const api: PerDbSourceCache<V> = {
    get(db, file, source, compute) {
      const m = ensure(db);
      const cached = m.get(file);
      if (cached && cached.source === source) return cached.value;
      const value = compute();
      m.set(file, { source, value });
      return value;
    },
    invalidate(db, file) {
      cache.get(db)?.delete(file);
    },
    invalidateAll(db) {
      cache.delete(db);
    },
  };
  registerCacheClear({
    name,
    groups: opts.clearGroups,
    clearAll: (db) => api.invalidateAll(db),
    clearFile: (db, relativePath) => api.invalidate(db, relativePath),
  });
  return api;
}
