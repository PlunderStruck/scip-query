import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthReport } from '../../src/queries/health/health-report.js';
import {
  healthReportCacheKey,
  healthReportCacheKeyHash,
  healthReportCachePath,
  readHealthReportCache,
  writeHealthReportCache,
} from '../../src/runtime/health-report-cache.js';
import type { ScipDatabase } from '../../src/storage/db.js';

function fakeDb(tempDir: string): ScipDatabase {
  const dbPath = join(tempDir, 'index.db');
  return {
    config: {
      dbPath,
      projectRoot: join(tempDir, 'project'),
    },
    generation: {
      identity: 'test-generation',
      databasePath: dbPath,
      metadataPath: join(tempDir, 'meta.json'),
      metadataRaw: readFileSync(join(tempDir, 'meta.json'), 'utf8'),
      source: 'legacy',
    },
  } as ScipDatabase;
}

function writeMeta(tempDir: string, fingerprint: unknown): void {
  writeFileSync(
    join(tempDir, 'meta.json'),
    JSON.stringify({
      version: 3,
      status: 'complete',
      fingerprint,
      indexedLanguages: ['typescript'],
    }),
  );
}

function minimalReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    overview: { documents: 1, symbols: 2, indexSizeBytes: 3 },
    findings: {
      deadSymbols: 0,
      deadLoc: 0,
      cycles: 0,
      similarPairs: 0,
      duplicateBodyGroups: 0,
      duplicateBodyLoc: 0,
      twinDriftGroups: 0,
      twinDriftLoc: 0,
      reactComponentDuplicatePairs: 0,
      reactHookCandidatePairs: 0,
      reactHookCandidateScoreCount: 0,
      reactLargeComponentPressureFiles: 0,
      vueComponentDuplicatePairs: 0,
      vueComposableCandidatePairs: 0,
      vueComposableCandidateScoreCount: 0,
      vueLargeViewPressureFiles: 0,
      passthroughs: 0,
      driftedFiles: 0,
      hiddenCouplingPairs: null,
      hiddenCouplingScoreCount: null,
      coverageContractViolations: 0,
    },
    axes: {
      deletable: { symbols: 0, loc: 0 },
      cycles: { count: 0 },
      changeAmplification: null,
      hiddenCoupling: null,
      evidenceQuality: { graphFindings: 0, heuristicFindings: 0, userSuppressed: 0 },
    },
    validation: null,
    suppressions: null,
    actions: [],
    policyExclusions: [],
    detectorEvidence: [],
    ...overrides,
  };
}

describe('health report cache', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reuses a report for the same project identity and misses after the project fingerprint changes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-report-cache-'));
    const deps = { gitHead: () => 'head-a' };
    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'a' }] });
    const db = fakeDb(tempDir);

    const key = healthReportCacheKey(db, { full: true }, '0.11.0', deps);
    expect(key).not.toBeNull();
    writeHealthReportCache(db, key!, minimalReport({ overview: { documents: 88, symbols: 2, indexSizeBytes: 3 } }));

    expect(readHealthReportCache(db, key!)?.overview.documents).toBe(88);

    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'changed' }] });
    const changedKey = healthReportCacheKey(fakeDb(tempDir), { full: true }, '0.11.0', deps);
    expect(changedKey).not.toBeNull();
    expect(healthReportCacheKeyHash(changedKey!)).not.toBe(healthReportCacheKeyHash(key!));
    expect(readHealthReportCache(db, changedKey!)).toBeNull();
  });

  it('rejects version 13 reports that can retain obsolete score descriptions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-report-cache-'));
    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'a' }] });
    const db = fakeDb(tempDir);
    const key = healthReportCacheKey(db, {}, '0.25.0', { gitHead: () => 'head-a', buildIdentity: () => 'same-entry' })!;
    writeHealthReportCache(db, key, minimalReport());
    const path = healthReportCachePath(db);
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    previous.version = 13;
    previous.key.version = 13;
    previous.keyHash = healthReportCacheKeyHash(previous.key);
    writeFileSync(path, JSON.stringify(previous));

    expect(readHealthReportCache(db, key)).toBeNull();
  });

  it('separates full, scoped, and phase-timeout health reports in the cache key', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-report-cache-'));
    const deps = { gitHead: () => 'head-a' };
    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'a' }] });
    const db = fakeDb(tempDir);

    const fullKey = healthReportCacheKey(db, { full: true }, '0.11.0', deps);
    const scopedKey = healthReportCacheKey(db, { full: true, scope: 'src/runtime' }, '0.11.0', deps);
    const defaultKey = healthReportCacheKey(db, {}, '0.11.0', deps);
    const boundedDefaultKey = healthReportCacheKey(db, { phaseTimeoutMs: 30000 }, '0.11.0', deps);

    expect(fullKey).not.toBeNull();
    expect(scopedKey).not.toBeNull();
    expect(defaultKey).not.toBeNull();
    expect(boundedDefaultKey).not.toBeNull();
    expect(healthReportCacheKeyHash(scopedKey!)).not.toBe(healthReportCacheKeyHash(fullKey!));
    expect(healthReportCacheKeyHash(defaultKey!)).not.toBe(healthReportCacheKeyHash(fullKey!));
    expect(healthReportCacheKeyHash(boundedDefaultKey!)).not.toBe(healthReportCacheKeyHash(defaultKey!));
  });
});
