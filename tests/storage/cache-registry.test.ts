import { describe, expect, it } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { createPerDbCache, createPerDbSourceCache, createPerDbValue } from '../../src/storage/per-db-cache.js';

// The registry only uses the db as a WeakMap key.
function fakeDb(): ScipDatabase {
  return {} as ScipDatabase;
}

describe('cache registry', () => {
  it('clears caches by declared group membership', () => {
    const db = fakeDb();
    const projectCache = createPerDbValue<string>('test-project-cache', { clearGroups: ['whole-project'] });
    const unmanagedCache = createPerDbValue<string>('test-unmanaged-cache', { clearGroups: [] });

    projectCache.get(db, () => 'a');
    unmanagedCache.get(db, () => 'b');

    clearRegisteredCaches(db, { groups: ['whole-project'] });

    expect(projectCache.has(db)).toBe(false);
    expect(unmanagedCache.has(db)).toBe(true);
  });

  it('clears a single file for path-keyed caches and everything otherwise', () => {
    const db = fakeDb();
    const fileCache = createPerDbCache<string, number>('test-file-cache', {
      clearGroups: ['source-file'],
    });
    fileCache.get(db, 'src/a.ts', () => 1);
    fileCache.get(db, 'src/b.ts', () => 2);

    clearRegisteredCaches(db, { groups: ['source-file'], file: 'src/a.ts' });

    expect(fileCache.size(db)).toBe(1);
    expect(fileCache.get(db, 'src/b.ts', () => -1)).toBe(2);
  });

  it('does not touch caches outside the requested groups', () => {
    const db = fakeDb();
    const optInCache = createPerDbValue<string>('test-opt-in-cache', { clearGroups: ['semantic-provider'] });
    optInCache.get(db, () => 'provider');

    clearRegisteredCaches(db, { groups: ['whole-project', 'source-file'] });

    expect(optInCache.has(db)).toBe(true);

    clearRegisteredCaches(db, { groups: ['semantic-provider'] });
    expect(optInCache.has(db)).toBe(false);
  });

  it('evicts the least-recently-used keyed entry without changing computed values', () => {
    const db = fakeDb();
    const cache = createPerDbCache<string, number>('test-bounded-cache', {
      clearGroups: [],
      maxEntries: 2,
    });

    expect(cache.get(db, 'a', () => 1)).toBe(1);
    expect(cache.get(db, 'b', () => 2)).toBe(2);
    expect(cache.get(db, 'a', () => -1)).toBe(1);
    expect(cache.get(db, 'c', () => 3)).toBe(3);

    expect(cache.size(db)).toBe(2);
    expect(cache.has(db, 'a')).toBe(true);
    expect(cache.has(db, 'b')).toBe(false);
    expect(cache.get(db, 'b', () => 20)).toBe(20);
  });

  it('bounds source-equality caches and recomputes an evicted source', () => {
    const db = fakeDb();
    const cache = createPerDbSourceCache<number>('test-bounded-source-cache', {
      clearGroups: ['source-file'],
      maxEntries: 2,
    });
    let computations = 0;
    const read = (file: string, source: string) => cache.get(db, file, source, () => ++computations);

    expect(read('src/a.ts', 'a')).toBe(1);
    expect(read('src/b.ts', 'b')).toBe(2);
    expect(read('src/a.ts', 'a')).toBe(1);
    expect(read('src/c.ts', 'c')).toBe(3);
    expect(read('src/b.ts', 'b')).toBe(4);
  });
});
