import type { ScipDatabase } from './db.js';

/**
 * Per-database keyed cache. Computes once per (db, key); subsequent calls hit
 * cache. The DB is held weakly so closing a DB doesn't leak its entries.
 */
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

export function createPerDbCache<K, V>(_name: string): PerDbCache<K, V> {
  const cache = new WeakMap<ScipDatabase, Map<K, V>>();
  const ensure = (db: ScipDatabase): Map<K, V> => {
    let m = cache.get(db);
    if (!m) { m = new Map<K, V>(); cache.set(db, m); }
    return m;
  };
  return {
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
}

export function createPerDbValue<V>(_name: string): PerDbValue<V> {
  const cache = new WeakMap<ScipDatabase, { value: V }>();
  return {
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

export function createPerDbSourceCache<V>(_name: string): PerDbSourceCache<V> {
  const cache = new WeakMap<ScipDatabase, Map<string, { source: string; value: V }>>();
  const ensure = (db: ScipDatabase): Map<string, { source: string; value: V }> => {
    let m = cache.get(db);
    if (!m) { m = new Map(); cache.set(db, m); }
    return m;
  };
  return {
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
}
