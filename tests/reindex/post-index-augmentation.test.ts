import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runFingerprintCachedPostIndexAugmentation,
  runPostIndexAugmentation,
} from '../../src/reindex/augmentation/post-index-augmentation.js';

describe('post-index augmentation', () => {
  it('returns stage metadata around the stage result', () => {
    const run = runPostIndexAugmentation(
      {
        id: 'fixture-stage',
        facts: ['fingerprint-cache'],
        run: () => 42,
      },
      { projectRoot: '/fixture/project', dbPath: '/fixture/index.db' },
    );

    expect(run.stageId).toBe('fixture-stage');
    expect(run.facts).toEqual(['fingerprint-cache']);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.result).toBe(42);
  });

  it('reuses matching fingerprint cache entries and recomputes after drift', () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'scip-query-post-index-cache-')), 'cache.json');
    let fingerprint = { version: 1 };
    let computes = 0;
    const cacheHits: { value: number }[] = [];

    const first = runFingerprintCachedPostIndexAugmentation({
      cachePath,
      readFingerprint: () => fingerprint,
      compute: () => ({ value: ++computes }),
      onCacheHit: (result) => cacheHits.push(result),
    });

    const second = runFingerprintCachedPostIndexAugmentation({
      cachePath,
      readFingerprint: () => fingerprint,
      compute: () => {
        throw new Error('cache hit should skip compute');
      },
      onCacheHit: (result) => cacheHits.push(result),
    });

    fingerprint = { version: 2 };
    const third = runFingerprintCachedPostIndexAugmentation({
      cachePath,
      readFingerprint: () => fingerprint,
      compute: () => ({ value: ++computes }),
      onCacheHit: (result) => cacheHits.push(result),
    });
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
      fingerprint: { version: number };
      result: { value: number };
    };

    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(third).toEqual({ value: 2 });
    expect(computes).toBe(2);
    expect(cacheHits).toEqual([{ value: 1 }]);
    expect(cache.fingerprint).toEqual({ version: 2 });
    expect(cache.result).toEqual({ value: 2 });
  });

  it('treats unreadable cache content as a miss', () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'scip-query-post-index-cache-bad-')), 'cache.json');
    writeFileSync(cachePath, '{not json');

    const result = runFingerprintCachedPostIndexAugmentation({
      cachePath,
      readFingerprint: () => ({ version: 1 }),
      compute: () => ({ value: 1 }),
    });

    expect(result).toEqual({ value: 1 });
  });
});
