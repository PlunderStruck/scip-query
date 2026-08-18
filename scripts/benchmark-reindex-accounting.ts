import { closeSync, mkdtempSync, openSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReindexResult, ReindexShardDiagnostic } from '../src/reindex/index.js';
import { estimateReindexLogicalOutputBytes, estimateReindexWriteBytes } from '../src/reindex/reindex-activity.js';

const MIB = 1024 * 1024;
const acceptedDatabaseBytes = 30 * MIB;
const acceptedIndexBytes = 30 * MIB;
const acceptedTypeScriptShardBytes = 30 * MIB;
const affectedFragmentBytes = 256 * 1024;
const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-reindex-accounting-'));

try {
  const dbPath = join(cacheDir, 'index.db');
  const indexPath = join(cacheDir, 'index.scip');
  closeSync(openSync(dbPath, 'w'));
  closeSync(openSync(indexPath, 'w'));
  truncateSync(dbPath, acceptedDatabaseBytes);
  truncateSync(indexPath, acceptedIndexBytes);

  const full = result({
    dbPath,
    indexPath,
    shard: {
      id: 'typescript',
      language: 'typescript',
      reused: false,
      strategy: 'full',
      fingerprint: 'benchmark-full',
      outputBytes: acceptedTypeScriptShardBytes,
      producedOutputBytes: acceptedTypeScriptShardBytes,
      durationMs: 1,
    },
  });
  const incremental = result({
    dbPath,
    indexPath,
    shard: {
      id: 'typescript',
      language: 'typescript',
      reused: false,
      strategy: 'incremental',
      fingerprint: 'benchmark-incremental',
      outputBytes: acceptedTypeScriptShardBytes,
      producedOutputBytes: affectedFragmentBytes,
      durationMs: 1,
    },
  });

  const fullLogicalBytes = estimateReindexLogicalOutputBytes(full);
  const incrementalLogicalBytes = estimateReindexLogicalOutputBytes(incremental);
  const incrementalWriteBytes = estimateReindexWriteBytes(incremental);
  process.stdout.write(
    `${JSON.stringify({
      benchmark: 'reindex-accounting',
      scenario: 'one-file-typescript-incremental-refresh',
      fixture: {
        acceptedDatabaseBytes,
        acceptedIndexBytes,
        acceptedTypeScriptShardBytes,
        affectedFragmentBytes,
        fallbackCopiedBytes: 0,
      },
      observed: {
        fullLogicalBytes,
        incrementalLogicalBytes,
        incrementalWriteBytes,
        incrementalToFullRatio: rounded(incrementalLogicalBytes / fullLogicalBytes),
      },
      contract: {
        unchangedAcceptedIndexCharged: incrementalLogicalBytes >= acceptedDatabaseBytes + acceptedIndexBytes,
        referencedBaseShardCharged:
          incrementalLogicalBytes >= acceptedDatabaseBytes + acceptedIndexBytes + acceptedTypeScriptShardBytes,
      },
    })}\n`,
  );
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

function result(input: { dbPath: string; indexPath: string; shard: ReindexShardDiagnostic }): ReindexResult {
  return {
    languages: ['typescript'],
    indexPath: input.indexPath,
    dbPath: input.dbPath,
    durationMs: 1,
    reused: false,
    skipped: [],
    shards: [input.shard],
    writeTelemetry: { reflinkedBytes: 0, fallbackCopiedBytes: 0 },
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}
