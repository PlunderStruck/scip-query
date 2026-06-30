import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runCandidateAnalysis,
  type CandidatePipelineCounters,
} from '../../../src/queries/internal/candidate-scan.js';

const PROFILE_ENV_KEYS = ['SCIP_QUERY_PROFILE', 'SCIP_QUERY_PROFILE_OUT', 'SCIP_QUERY_PROFILE_COMMAND'] as const;

function restoreProfileEnv(snapshot: Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>): void {
  for (const key of PROFILE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('candidate pipeline runner', () => {
  let tempDir: string | undefined;
  const envSnapshot = Object.fromEntries(PROFILE_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof PROFILE_ENV_KEYS)[number],
    string | undefined
  >;

  afterEach(() => {
    restoreProfileEnv(envSnapshot);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('applies cheap filters before ordering, scan limits, prepare, and evaluate', () => {
    const preparedBatches: number[][] = [];
    let counters: CandidatePipelineCounters | undefined;

    const results = runCandidateAnalysis<number, { batch: readonly number[] }, string>({
      candidates: () => [3, 1, 2, 4],
      filterCandidate: (candidate) => candidate % 2 === 0,
      orderCandidates: (left, right) => right - left,
      scanLimit: 1,
      profile: { name: 'test-pipeline' },
      prepare: (candidates) => {
        preparedBatches.push([...candidates]);
        return { batch: candidates };
      },
      evaluate: (candidate, context) => `${candidate}:${context.batch.join(',')}`,
      onProfile: (profile) => {
        counters = profile;
      },
    });

    expect(preparedBatches).toEqual([[4]]);
    expect(results).toEqual(['4:4']);
    expect(counters).toMatchObject({
      pipeline: 'test-pipeline',
      loadedCandidates: 4,
      filteredCandidates: 2,
      scannedCandidates: 1,
      evaluatedCandidates: 1,
      matchedResults: 1,
      emittedResults: 1,
      scanLimitApplied: true,
      resultLimitApplied: false,
    });
  });

  it('reports matched rows separately from result-limited emitted rows', () => {
    let counters: CandidatePipelineCounters | undefined;

    const results = runCandidateAnalysis<number, undefined, number>({
      candidates: () => [1, 2, 3],
      evaluate: (candidate) => candidate,
      orderResults: (left, right) => right - left,
      limit: 2,
      onProfile: (profile) => {
        counters = profile;
      },
    });

    expect(results).toEqual([3, 2]);
    expect(counters).toMatchObject({
      loadedCandidates: 3,
      filteredCandidates: 3,
      scannedCandidates: 3,
      evaluatedCandidates: 3,
      matchedResults: 3,
      emittedResults: 2,
      scanLimitApplied: false,
      resultLimitApplied: true,
    });
  });

  it('writes pipeline counters into profile spans when profiling is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-candidate-profile-'));
    const profilePath = join(tempDir, 'profile.jsonl');
    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = profilePath;
    process.env.SCIP_QUERY_PROFILE_COMMAND = 'scip-query wrapper-candidates --json';

    runCandidateAnalysis<number, undefined, string>({
      candidates: () => [1, 2],
      evaluate: (candidate) => String(candidate),
      limit: 1,
      profile: { name: 'contract-test', metadata: { detector: 'unit' } },
    });

    const event = JSON.parse(readFileSync(profilePath, 'utf8').trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      command: 'scip-query wrapper-candidates --json',
      type: 'span',
      name: 'candidate-pipeline:contract-test',
      ok: true,
      detector: 'unit',
      pipeline: 'contract-test',
      loadedCandidates: 2,
      filteredCandidates: 2,
      scannedCandidates: 2,
      evaluatedCandidates: 2,
      matchedResults: 2,
      emittedResults: 1,
      scanLimitApplied: false,
      resultLimitApplied: true,
    });
    expect(typeof event.durationMs).toBe('number');
  });
});
