import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReindexResult } from '../../src/reindex/index.js';
import {
  appendReindexActivity,
  estimateReindexLogicalOutputBytes,
  readReindexActivitySummary,
  recordReindexRunActivity,
  recordSuppressedReindexActivity,
  reindexActivityPath,
  type ReindexActivityRecord,
} from '../../src/reindex/reindex-activity.js';

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
        byTrigger: { 'manual-cli': 2, 'watch-source': 1 },
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
    expect(estimateReindexLogicalOutputBytes({ ...rebuilt, reused: true })).toBe(0);
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
  shards?: ReindexResult['shards'];
}): ReindexResult {
  return {
    languages: ['typescript'],
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
