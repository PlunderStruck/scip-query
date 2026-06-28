import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commandAnalysisBudget,
  diffImpactBatchConcurrency,
  healthPhaseConcurrency,
  healthPhaseTasks,
  shouldRunHealthPhase,
  skippedHealthPhaseResult,
} from '../../src/runtime/cli-support.js';
import type { ScipDatabase } from '../../src/storage/db.js';

function fakeLargeDb(): ScipDatabase {
  return {
    config: { dbPath: '/tmp/missing-index.db' },
    get: (sql: string) => {
      if (sql.includes('documents')) return { c: 10_000 };
      if (sql.includes('global_symbols')) return { c: 100_000 };
      return { c: 0 };
    },
  } as unknown as ScipDatabase;
}

describe('commandAnalysisBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses large-index warnings for JSON commands without changing the budget', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'cleanup-plan', false, { quiet: true })).toEqual({
      scanLimit: 2500,
      semantic: false,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps large-index warnings for human output', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'cleanup-plan', false)).toEqual({ scanLimit: 2500, semantic: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Large index detected'));
  });
});

describe('healthPhaseConcurrency', () => {
  it('uses an adaptive default capped below the full phase count', () => {
    expect(healthPhaseConcurrency(20, {}, () => 14)).toBe(12);
    expect(healthPhaseConcurrency(20, {}, () => 6)).toBe(5);
    expect(healthPhaseConcurrency(3, {}, () => 14)).toBe(3);
  });

  it('honors explicit environment overrides', () => {
    expect(healthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_CONCURRENCY: '6' }, () => 14)).toBe(6);
    expect(healthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_CONCURRENCY: '100' }, () => 14)).toBe(20);
    expect(healthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_CONCURRENCY: 'nope' }, () => 14)).toBe(12);
  });
});

describe('frontend health phase pruning', () => {
  it('groups runnable frontend phases by framework for cache reuse', () => {
    expect(
      healthPhaseTasks([
        'overview',
        'react-component-duplicates',
        'react-hook-candidates',
        'react-large-component-pressure',
        'vue-component-duplicates',
        'vue-composable-candidates',
        'vue-large-view-pressure',
        'dead',
      ]),
    ).toEqual([
      ['overview'],
      ['react-component-duplicates', 'react-hook-candidates', 'react-large-component-pressure'],
      ['vue-component-duplicates', 'vue-composable-candidates', 'vue-large-view-pressure'],
      ['dead'],
    ]);
  });

  it('runs frontend phases only when matching files are present', () => {
    expect(
      shouldRunHealthPhase('react-component-duplicates', {
        react: false,
        vue: true,
      }),
    ).toBe(false);
    expect(
      shouldRunHealthPhase('react-hook-candidates', {
        react: true,
        vue: false,
      }),
    ).toBe(true);
    expect(
      shouldRunHealthPhase('vue-large-view-pressure', {
        react: true,
        vue: false,
      }),
    ).toBe(false);
    expect(
      shouldRunHealthPhase('dead', {
        react: false,
        vue: false,
      }),
    ).toBe(true);
  });

  it('synthesizes the same empty summaries frontend phases return with no source files', () => {
    expect(skippedHealthPhaseResult('react-component-duplicates')).toEqual({
      phase: 'react-component-duplicates',
      reactComponentDuplicates: { count: 0, loc: 0, files: [] },
    });
    expect(skippedHealthPhaseResult('vue-composable-candidates')).toEqual({
      phase: 'vue-composable-candidates',
      vueComposableCandidates: { count: 0, loc: 0, files: [] },
    });
  });
});

describe('diffImpactBatchConcurrency', () => {
  it('uses an adaptive default capped below the full batch count', () => {
    expect(diffImpactBatchConcurrency(20, {}, () => 14)).toBe(8);
    expect(diffImpactBatchConcurrency(20, {}, () => 6)).toBe(5);
    expect(diffImpactBatchConcurrency(3, {}, () => 14)).toBe(3);
  });

  it('honors explicit environment overrides', () => {
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: '6' }, () => 14)).toBe(6);
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: '100' }, () => 14)).toBe(20);
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: 'nope' }, () => 14)).toBe(8);
  });
});
