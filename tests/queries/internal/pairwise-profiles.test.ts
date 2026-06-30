import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pairwiseCandidateIndexFromKeys,
  rankedPairwiseProfileResults,
  type PairwiseProfileCounters,
} from '../../../src/queries/internal/pairwise-profiles.js';

const PROFILE_ENV_KEYS = ['SCIP_QUERY_PROFILE', 'SCIP_QUERY_PROFILE_OUT', 'SCIP_QUERY_PROFILE_COMMAND'] as const;

interface TestProfile {
  file: string;
  tokens: Set<string>;
}

interface TestResult {
  pair: string;
  similarity: number;
}

function profile(file: string, tokens: readonly string[]): TestProfile {
  return { file, tokens: new Set(tokens) };
}

function restoreProfileEnv(snapshot: Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>): void {
  for (const key of PROFILE_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('ranked pairwise profile runner', () => {
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

  it('uses candidate indexes to skip profile pairs with no shared keys', () => {
    const profiles = [profile('a.ts', ['shared', 'alpha']), profile('b.ts', ['beta']), profile('c.ts', ['shared'])];
    const comparedPairs: string[] = [];
    let counters: PairwiseProfileCounters | undefined;

    const results = rankedPairwiseProfileResults({
      profiles,
      limit: 10,
      candidateIndex: pairwiseCandidateIndexFromKeys(profiles, (item) => item.tokens),
      profile: { name: 'test-pairs' },
      compare: (left, right) => {
        comparedPairs.push(`${left.file}:${right.file}`);
        return { pair: `${left.file}:${right.file}`, similarity: 1 };
      },
      onProfile: (profileCounters) => {
        counters = profileCounters;
      },
    });

    expect(comparedPairs).toEqual(['a.ts:c.ts']);
    expect(results).toEqual([{ pair: 'a.ts:c.ts', similarity: 1 }]);
    expect(counters).toMatchObject({
      pipeline: 'test-pairs',
      profileCount: 3,
      focusedProfileCount: 0,
      candidatePairs: 1,
      comparedPairs: 1,
      matchedResults: 1,
      emittedResults: 1,
      candidateIndexApplied: true,
      focusApplied: false,
      filePatternApplied: false,
      overrunApplied: false,
    });
  });

  it('preserves focus-file semantics with candidate indexes', () => {
    const profiles = [profile('a.ts', ['shared']), profile('b.ts', ['shared']), profile('c.ts', ['shared'])];
    const comparedPairs: string[] = [];

    rankedPairwiseProfileResults({
      profiles,
      limit: 10,
      focusFiles: new Set(['b.ts']),
      candidateIndex: pairwiseCandidateIndexFromKeys(profiles, (item) => item.tokens),
      compare: (left, right) => {
        comparedPairs.push(`${left.file}:${right.file}`);
        return { pair: `${left.file}:${right.file}`, similarity: 1 };
      },
    });

    expect(comparedPairs).toEqual(['a.ts:b.ts', 'b.ts:c.ts']);
  });

  it('preserves file-pattern target orientation with candidate indexes', () => {
    const profiles = [profile('a.ts', ['shared']), profile('target.ts', ['shared']), profile('c.ts', ['shared'])];
    const comparedPairs: string[] = [];

    const results = rankedPairwiseProfileResults({
      profiles,
      limit: 10,
      filePattern: 'target',
      candidateIndex: pairwiseCandidateIndexFromKeys(profiles, (item) => item.tokens),
      compare: (left, right) => {
        comparedPairs.push(`${left.file}:${right.file}`);
        return { pair: `${left.file}:${right.file}`, similarity: 1 };
      },
    });

    expect(comparedPairs).toEqual(['target.ts:a.ts', 'target.ts:c.ts']);
    expect(results.map((result) => result.pair)).toEqual(['target.ts:a.ts', 'target.ts:c.ts']);
  });

  it('sorts and limits results after collecting matches', () => {
    const profiles = [profile('a.ts', ['shared']), profile('b.ts', ['shared']), profile('c.ts', ['shared'])];
    let counters: PairwiseProfileCounters | undefined;

    const results = rankedPairwiseProfileResults({
      profiles,
      limit: 2,
      candidateIndex: pairwiseCandidateIndexFromKeys(profiles, (item) => item.tokens),
      compare: (left, right) => ({
        pair: `${left.file}:${right.file}`,
        similarity: left.file === 'a.ts' && right.file === 'c.ts' ? 3 : 1,
      }),
      onProfile: (profileCounters) => {
        counters = profileCounters;
      },
    });

    expect(results.map((result) => result.pair)).toEqual(['a.ts:c.ts', 'a.ts:b.ts']);
    expect(counters).toMatchObject({
      candidatePairs: 3,
      comparedPairs: 3,
      matchedResults: 3,
      emittedResults: 2,
    });
  });

  it('writes pairwise counters into profile spans when profiling is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-pairwise-profile-'));
    const profilePath = join(tempDir, 'profile.jsonl');
    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = profilePath;
    process.env.SCIP_QUERY_PROFILE_COMMAND = 'scip-query react-component-duplicates --json';
    const profiles = [profile('a.tsx', ['jsx']), profile('b.tsx', ['jsx'])];

    rankedPairwiseProfileResults<TestProfile, TestResult>({
      profiles,
      limit: 1,
      candidateIndex: pairwiseCandidateIndexFromKeys(profiles, (item) => item.tokens),
      profile: { name: 'contract-test', metadata: { detector: 'unit' } },
      compare: (left, right) => ({ pair: `${left.file}:${right.file}`, similarity: 1 }),
    });

    const event = JSON.parse(readFileSync(profilePath, 'utf8').trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      command: 'scip-query react-component-duplicates --json',
      type: 'span',
      name: 'pairwise-profile:contract-test',
      ok: true,
      detector: 'unit',
      pipeline: 'contract-test',
      profileCount: 2,
      focusedProfileCount: 0,
      candidatePairs: 1,
      comparedPairs: 1,
      matchedResults: 1,
      emittedResults: 1,
      candidateIndexApplied: true,
      focusApplied: false,
      filePatternApplied: false,
      overrunApplied: false,
    });
    expect(typeof event.durationMs).toBe('number');
  });
});
