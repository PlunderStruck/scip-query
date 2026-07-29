import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReindexResult } from '../../src/reindex/index.js';
import {
  appendReindexActivity,
  evaluateReindexActivityBudget,
  estimateReindexLogicalOutputBytes,
  estimateReindexWriteBytes,
  inspectReindexActivityBudget,
  readReindexActivitySummary,
  recordReindexRunActivity,
  recordSuppressedReindexActivity,
  reindexActivityPath,
  type ReindexActivityRecord,
} from '../../src/reindex/reindex-activity.js';
import { resolveWatchConfig } from '../../src/runtime/config.js';
import type { SupportedLanguage } from '../../src/domain/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reindex activity', () => {
  it('summarizes runs, suppressions, triggers, and estimated logical output in a rolling window', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    const outputScip = join(cacheDir, 'index.scip');
    writeFileSync(outputDb, 'database');
    writeFileSync(outputScip, 'scip');

    recordReindexRunActivity(
      outputDb,
      result({
        outputDb,
        outputScip,
        completedAt: '2026-07-24T12:00:00.000Z',
        result: 'rebuilt',
        reused: false,
        shards: [
          {
            id: 'typescript',
            language: 'typescript',
            reused: false,
            fingerprint: 'abc',
            outputBytes: 10,
            durationMs: 3,
          },
        ],
      }),
    );
    recordReindexRunActivity(
      outputDb,
      result({
        outputDb,
        outputScip,
        completedAt: '2026-07-24T13:00:00.000Z',
        result: 'reused',
        reused: true,
      }),
    );
    recordSuppressedReindexActivity(
      outputDb,
      { kind: 'watch-source', detail: 'src/a.ts' },
      new Date('2026-07-24T14:00:00.000Z'),
    );

    const summary = readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'));

    expect(summary).toEqual(
      expect.objectContaining({
        confidence: 'complete',
        recordsRead: 3,
        invalidRecords: 0,
        runs: 2,
        rebuilt: 1,
        reused: 1,
        failed: 0,
        suppressed: 1,
        estimatedLogicalOutputBytes: 22,
        estimatedWriteBytes: 22,
        reflinkedBytes: 0,
        fallbackCopiedBytes: 0,
        oldestRebuildAt: '2026-07-24T12:00:00.000Z',
        oldestWriteAt: '2026-07-24T12:00:00.000Z',
        languageAttribution: 'complete',
        attributedRuns: 2,
        unattributedRuns: 0,
        invalidLanguageDetails: 0,
        byLanguage: {
          typescript: {
            runs: 2,
            rebuilt: 1,
            reused: 1,
            producedOutputBytes: 10,
            durationMs: 3,
          },
        },
        byTrigger: { 'manual-cli': 2, 'watch-source': 1 },
      }),
    );
  });

  it('treats a cache with no activity ledger as complete zero activity', () => {
    const cacheDir = createCache();
    const summary = readReindexActivitySummary(join(cacheDir, 'index.db'), new Date('2026-07-24T15:00:00.000Z'));

    expect(summary).toEqual(
      expect.objectContaining({
        confidence: 'complete',
        recordsRead: 0,
        runs: 0,
        rebuilt: 0,
        estimatedWriteBytes: 0,
        languageAttribution: 'complete',
        attributedRuns: 0,
        unattributedRuns: 0,
      }),
    );
  });

  it('attributes each top-level language once without retaining project-shard detail', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    const outputScip = join(cacheDir, 'index.scip');
    const languageDir = join(cacheDir, 'language-indexes');
    mkdirSync(languageDir);
    writeFileSync(outputDb, 'database');
    writeFileSync(outputScip, 'scip');
    writeFileSync(join(languageDir, 'typescript.scip'), 'typescript');
    writeFileSync(join(languageDir, 'rust.scip'), 'rust');

    recordReindexRunActivity(
      outputDb,
      result({
        outputDb,
        outputScip,
        completedAt: '2026-07-24T12:00:00.000Z',
        result: 'rebuilt',
        reused: false,
        languages: ['typescript', 'rust'],
        shards: [
          {
            id: 'typescript:packages/app/tsconfig.json',
            language: 'typescript',
            reused: false,
            fingerprint: 'abc',
            outputBytes: 100,
            durationMs: 8,
          },
          {
            id: 'typescript:packages/lib/tsconfig.json',
            language: 'typescript',
            reused: true,
            fingerprint: 'def',
            outputBytes: 200,
            durationMs: 0,
          },
          {
            id: 'rust',
            language: 'rust',
            reused: true,
            fingerprint: 'ghi',
            outputBytes: 4,
            durationMs: 0,
          },
        ],
      }),
    );

    const raw = JSON.parse(readFileSync(reindexActivityPath(outputDb), 'utf8')) as {
      byLanguage: Record<string, unknown>;
    };
    expect(Object.keys(raw.byLanguage)).toEqual(['typescript', 'rust']);
    expect(raw.byLanguage).not.toHaveProperty('typescript:packages/app/tsconfig.json');
    expect(raw.byLanguage).toEqual({
      typescript: {
        result: 'rebuilt',
        outputBytes: 10,
        producedOutputBytes: 10,
        durationMs: 8,
      },
      rust: {
        result: 'reused',
        outputBytes: 4,
        producedOutputBytes: 0,
        durationMs: 0,
      },
    });

    expect(readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'))).toEqual(
      expect.objectContaining({
        languageAttribution: 'complete',
        attributedRuns: 1,
        unattributedRuns: 0,
        byLanguage: {
          typescript: {
            runs: 1,
            rebuilt: 1,
            reused: 0,
            producedOutputBytes: 10,
            durationMs: 8,
          },
          rust: {
            runs: 1,
            rebuilt: 0,
            reused: 1,
            producedOutputBytes: 0,
            durationMs: 0,
          },
        },
      }),
    );
  });

  it('keeps aggregate evidence when future language detail cannot be decoded', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    writeFileSync(
      reindexActivityPath(outputDb),
      `${JSON.stringify({
        ...runRecord('2026-07-24T12:00:00.000Z'),
        byLanguage: {
          typescript: {
            result: 'rebuilt',
            outputBytes: 7,
            producedOutputBytes: 7,
            durationMs: 4,
          },
          futurelang: {
            result: 'rebuilt',
            outputBytes: 99,
            producedOutputBytes: 99,
            durationMs: 12,
          },
        },
      })}\n`,
    );

    expect(readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'))).toEqual(
      expect.objectContaining({
        confidence: 'complete',
        runs: 1,
        rebuilt: 1,
        estimatedLogicalOutputBytes: 10,
        languageAttribution: 'partial',
        attributedRuns: 1,
        unattributedRuns: 0,
        invalidLanguageDetails: 1,
        byLanguage: {
          typescript: {
            runs: 1,
            rebuilt: 1,
            reused: 0,
            producedOutputBytes: 7,
            durationMs: 4,
          },
        },
      }),
    );
  });

  it('reads legacy run records as valid aggregate evidence with unavailable language attribution', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    appendReindexActivity(reindexActivityPath(outputDb), runRecord('2026-07-24T12:00:00.000Z'));

    expect(readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'))).toEqual(
      expect.objectContaining({
        confidence: 'complete',
        runs: 1,
        rebuilt: 1,
        languageAttribution: 'unavailable',
        attributedRuns: 0,
        unattributedRuns: 1,
        byLanguage: {},
      }),
    );
  });

  it('ignores malformed and out-of-window lines without losing valid records', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    const path = reindexActivityPath(outputDb);
    const valid = runRecord('2026-07-24T12:00:00.000Z');
    const old = runRecord('2026-07-20T12:00:00.000Z');
    writeFileSync(path, `${JSON.stringify(old)}\n{malformed\n${JSON.stringify(valid)}\n`);

    const summary = readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'));

    expect(summary.runs).toBe(1);
    expect(summary.rebuilt).toBe(1);
    expect(summary).toEqual(
      expect.objectContaining({
        confidence: 'partial',
        recordsRead: 3,
        invalidRecords: 1,
        skippedRecords: 1,
      }),
    );
  });

  it('reports incomplete tails and unavailable segments instead of implying complete history', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    const path = reindexActivityPath(outputDb);
    writeFileSync(path, JSON.stringify(runRecord('2026-07-24T12:00:00.000Z')));

    expect(readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'))).toEqual(
      expect.objectContaining({
        confidence: 'partial',
        recordsRead: 0,
        ignoredPartialTailBytes: expect.any(Number),
      }),
    );

    expect(
      readReindexActivitySummary(outputDb, new Date('2026-07-24T15:00:00.000Z'), 24 * 60 * 60_000, () => {
        throw new Error('unreadable');
      }),
    ).toEqual(
      expect.objectContaining({
        confidence: 'unavailable',
        readErrors: 2,
        recordsRead: 0,
      }),
    );
  });

  it('returns activity append failure to the caller without masking the refresh result', () => {
    const cacheDir = createCache();
    const blocker = join(cacheDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const outputDb = join(blocker, 'index.db');
    const outputScip = join(cacheDir, 'index.scip');
    writeFileSync(outputScip, 'scip');

    expect(
      recordReindexRunActivity(
        outputDb,
        result({
          outputDb,
          outputScip,
          completedAt: '2026-07-24T12:00:00.000Z',
          result: 'rebuilt',
          reused: false,
        }),
      ),
    ).toEqual(expect.objectContaining({ state: 'failed', reason: expect.any(String) }));
  });

  it('rotates activity into at most two bounded segments', () => {
    const cacheDir = createCache();
    const path = join(cacheDir, 'activity.jsonl');
    const first = runRecord('2026-07-24T12:00:00.000Z');
    const second = runRecord('2026-07-24T13:00:00.000Z');
    const lineBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`);

    appendReindexActivity(path, first, lineBytes + 5);
    appendReindexActivity(path, second, lineBytes + 5);

    expect(readFileSync(`${path}.previous`, 'utf8')).toContain(first.recordedAt);
    expect(readFileSync(path, 'utf8')).toContain(second.recordedAt);
    expect(statSync(path).size).toBeLessThanOrEqual(lineBytes + 5);
  });

  it('counts only produced artifacts and returns zero for a reused result', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    const outputScip = join(cacheDir, 'index.scip');
    writeFileSync(outputDb, '12345678');
    writeFileSync(outputScip, '1234');

    const rebuilt = result({
      outputDb,
      outputScip,
      completedAt: '2026-07-24T12:00:00.000Z',
      result: 'rebuilt',
      reused: false,
      shards: [
        {
          id: 'typescript',
          language: 'typescript',
          reused: false,
          fingerprint: 'abc',
          outputBytes: 5,
          durationMs: 3,
        },
        {
          id: 'rust',
          language: 'rust',
          reused: true,
          fingerprint: 'def',
          outputBytes: 99,
          durationMs: 0,
        },
      ],
    });

    expect(estimateReindexLogicalOutputBytes(rebuilt)).toBe(17);
    expect(
      estimateReindexWriteBytes({
        ...rebuilt,
        writeTelemetry: { reflinkedBytes: 100, fallbackCopiedBytes: 7 },
      }),
    ).toBe(24);
    expect(estimateReindexLogicalOutputBytes({ ...rebuilt, reused: true })).toBe(0);
  });

  it('pauses the next automatic rebuild at either persisted rolling limit', () => {
    const nowMs = Date.parse('2026-07-24T12:15:00.000Z');
    const config = {
      enabled: true,
      windowMs: 15 * 60_000,
      maxRebuilds: 8,
      maxEstimatedWriteBytes: 1_000,
    };
    const summary = {
      confidence: 'complete' as const,
      windowStartedAt: '2026-07-24T12:00:00.000Z',
      windowEndedAt: '2026-07-24T12:15:00.000Z',
      runs: 8,
      rebuilt: 8,
      reused: 0,
      failed: 0,
      suppressed: 0,
      estimatedLogicalOutputBytes: 800,
      estimatedWriteBytes: 900,
      oldestRebuildAt: '2026-07-24T12:01:00.000Z',
      oldestWriteAt: '2026-07-24T12:02:00.000Z',
      byTrigger: {},
    };

    expect(evaluateReindexActivityBudget(summary, config, nowMs)).toEqual({
      state: 'paused',
      reason: 'rebuild-count',
      until: Date.parse('2026-07-24T12:16:00.000Z'),
      rebuilt: 8,
      estimatedWriteBytes: 900,
      detail: '8/8 automatic rebuild slots consumed',
    });
    expect(
      evaluateReindexActivityBudget({ ...summary, rebuilt: 1, estimatedWriteBytes: 1_000 }, config, nowMs),
    ).toEqual(
      expect.objectContaining({
        state: 'paused',
        reason: 'estimated-write-bytes',
        until: Date.parse('2026-07-24T12:17:00.000Z'),
      }),
    );
    expect(evaluateReindexActivityBudget({ ...summary, rebuilt: 1, estimatedWriteBytes: 999 }, config, nowMs)).toEqual({
      state: 'allowed',
      rebuilt: 1,
      estimatedWriteBytes: 999,
    });
  });

  it('applies the calibrated default budget at two rebuilds or one GiB', () => {
    const nowMs = Date.parse('2026-07-24T12:15:00.000Z');
    const config = resolveWatchConfig({}).resourceBudget;
    const summary = {
      confidence: 'complete' as const,
      windowStartedAt: '2026-07-24T12:00:00.000Z',
      windowEndedAt: '2026-07-24T12:15:00.000Z',
      runs: 2,
      rebuilt: 2,
      reused: 0,
      failed: 0,
      suppressed: 0,
      estimatedLogicalOutputBytes: 512,
      estimatedWriteBytes: 512,
      oldestRebuildAt: '2026-07-24T12:01:00.000Z',
      oldestWriteAt: '2026-07-24T12:02:00.000Z',
      byTrigger: {},
    };

    expect(evaluateReindexActivityBudget(summary, config, nowMs)).toEqual(
      expect.objectContaining({ state: 'paused', reason: 'rebuild-count', rebuilt: 2 }),
    );
    expect(
      evaluateReindexActivityBudget({ ...summary, rebuilt: 1, estimatedWriteBytes: 1024 * 1024 * 1024 }, config, nowMs),
    ).toEqual(expect.objectContaining({ state: 'paused', reason: 'estimated-write-bytes' }));
    expect(
      evaluateReindexActivityBudget(
        { ...summary, rebuilt: 1, estimatedWriteBytes: 1024 * 1024 * 1024 - 1 },
        config,
        nowMs,
      ),
    ).toEqual(expect.objectContaining({ state: 'allowed' }));
  });

  it('reconstructs exhausted budget debt from the persisted ledger after a restart', () => {
    const cacheDir = createCache();
    const outputDb = join(cacheDir, 'index.db');
    for (let minute = 1; minute <= 4; minute += 1) {
      appendReindexActivity(reindexActivityPath(outputDb), runRecord(`2026-07-24T12:0${minute}:00.000Z`));
    }

    expect(
      inspectReindexActivityBudget(
        outputDb,
        {
          enabled: true,
          windowMs: 15 * 60_000,
          maxRebuilds: 4,
          maxEstimatedWriteBytes: 1_000,
        },
        new Date('2026-07-24T12:10:00.000Z'),
      ),
    ).toEqual({
      state: 'paused',
      reason: 'rebuild-count',
      until: Date.parse('2026-07-24T12:16:00.000Z'),
      rebuilt: 4,
      estimatedWriteBytes: 40,
      detail: '4/4 automatic rebuild slots consumed',
    });
  });

  it('fails closed when retained budget evidence is incomplete and allows explicit opt-out', () => {
    const summary = {
      confidence: 'partial' as const,
      windowStartedAt: '2026-07-24T12:00:00.000Z',
      windowEndedAt: '2026-07-24T12:15:00.000Z',
      runs: 0,
      rebuilt: 0,
      reused: 0,
      failed: 0,
      suppressed: 0,
      estimatedLogicalOutputBytes: 0,
      byTrigger: {},
    };
    const config = {
      enabled: true,
      windowMs: 15 * 60_000,
      maxRebuilds: 8,
      maxEstimatedWriteBytes: 1_000,
    };

    expect(evaluateReindexActivityBudget(summary, config, 0)).toEqual(
      expect.objectContaining({ state: 'paused', reason: 'activity-evidence' }),
    );
    expect(evaluateReindexActivityBudget(summary, { ...config, enabled: false }, 0)).toEqual({
      state: 'allowed',
      rebuilt: 0,
      estimatedWriteBytes: 0,
    });
  });
});

function createCache(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-query-reindex-activity-'));
  tempDirs.push(dir);
  return dir;
}

function runRecord(recordedAt: string): ReindexActivityRecord {
  return {
    version: 1,
    event: 'run',
    recordedAt,
    trigger: { kind: 'manual-cli' },
    result: 'rebuilt',
    durationMs: 5,
    estimatedLogicalOutputBytes: 10,
  };
}

function result(input: {
  outputDb: string;
  outputScip: string;
  completedAt: string;
  result: 'rebuilt' | 'reused';
  reused: boolean;
  languages?: SupportedLanguage[];
  shards?: ReindexResult['shards'];
}): ReindexResult {
  return {
    languages: input.languages ?? ['typescript'],
    indexPath: input.outputScip,
    dbPath: input.outputDb,
    durationMs: 5,
    reused: input.reused,
    skipped: [],
    shards: input.shards,
    lastRefresh: {
      trigger: { kind: 'manual-cli' },
      result: input.result,
      startedAt: '2026-07-24T11:59:59.000Z',
      completedAt: input.completedAt,
      durationMs: 5,
    },
  };
}
