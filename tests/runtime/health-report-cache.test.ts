import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthReport } from '../../src/queries/health/health-report.js';
import {
  healthReportCacheKey,
  healthReportCacheKeyHash,
  readHealthReportCache,
  writeHealthReportCache,
} from '../../src/runtime/health-report-cache.js';
import type { ScipDatabase } from '../../src/storage/db.js';

function fakeDb(tempDir: string): ScipDatabase {
  return {
    config: {
      dbPath: join(tempDir, 'index.db'),
      projectRoot: join(tempDir, 'project'),
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
    score: 99,
    riskScore: 100,
    hygieneScore: 99,
    scoreBreakdown: [],
    overview: { documents: 1, symbols: 2, indexSizeBytes: 3 },
    findings: {
      deadSymbols: 0,
      deadLoc: 0,
      isolatedSymbols: 0,
      isolatedLoc: 0,
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
      extractionCandidates: 0,
      wrappers: 0,
      wrapperScoreCount: 0,
      passthroughs: 0,
      staleTypes: 0,
      driftedFiles: 0,
      complexityHotspotCount: 0,
      hiddenCouplingPairs: null,
      hiddenCouplingScoreCount: null,
      coverageContractViolations: 0,
    },
    axes: {
      deletable: { symbols: 0, loc: 0 },
      changeAmplification: null,
      hiddenCoupling: null,
      churnWeightedComplexity: [],
      evidenceQuality: { graphFindings: 0, heuristicFindings: 0, userSuppressed: 0 },
    },
    validation: null,
    suppressions: null,
    actions: [],
    pressure: [],
    topComplexity: [],
    detectorPrecision: [],
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
    const db = fakeDb(tempDir);
    const deps = { gitHead: () => 'head-a' };
    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'a' }] });

    const key = healthReportCacheKey(db, { full: true }, '0.11.0', deps);
    expect(key).not.toBeNull();
    writeHealthReportCache(db, key!, minimalReport({ score: 88 }));

    expect(readHealthReportCache(db, key!)?.score).toBe(88);

    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'changed' }] });
    const changedKey = healthReportCacheKey(fakeDb(tempDir), { full: true }, '0.11.0', deps);
    expect(changedKey).not.toBeNull();
    expect(healthReportCacheKeyHash(changedKey!)).not.toBe(healthReportCacheKeyHash(key!));
    expect(readHealthReportCache(db, changedKey!)).toBeNull();
  });

  it('separates full and scoped health reports in the cache key', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-report-cache-'));
    const db = fakeDb(tempDir);
    const deps = { gitHead: () => 'head-a' };
    writeMeta(tempDir, { files: [{ path: 'src/a.ts', hash: 'a' }] });

    const fullKey = healthReportCacheKey(db, { full: true }, '0.11.0', deps);
    const scopedKey = healthReportCacheKey(db, { full: true, scope: 'src/runtime' }, '0.11.0', deps);
    const defaultKey = healthReportCacheKey(db, {}, '0.11.0', deps);

    expect(fullKey).not.toBeNull();
    expect(scopedKey).not.toBeNull();
    expect(defaultKey).not.toBeNull();
    expect(healthReportCacheKeyHash(scopedKey!)).not.toBe(healthReportCacheKeyHash(fullKey!));
    expect(healthReportCacheKeyHash(defaultKey!)).not.toBe(healthReportCacheKeyHash(fullKey!));
  });
});
