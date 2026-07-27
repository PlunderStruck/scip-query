import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  LastRefreshMetadata,
  RefreshTrigger,
  RefreshTriggerKind,
  ReindexActivitySummary,
} from '../domain/types.js';
import { isNonNegativeFiniteNumber, isValidRecordTimestamp } from '../domain/record-validation.js';
import type { ReindexResult } from './index.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import {
  appendRotatingJsonlRecord,
  readRotatingJsonlLines,
  ROTATING_JSONL_PREVIOUS_SUFFIX,
  type RotatingJsonlRuntime,
} from './rotating-jsonl.js';

export const REINDEX_ACTIVITY_FILE = 'reindex-activity.jsonl';
export const REINDEX_ACTIVITY_PREVIOUS_SUFFIX = ROTATING_JSONL_PREVIOUS_SUFFIX;
export const REINDEX_ACTIVITY_MAX_BYTES = 1024 * 1024;
export const REINDEX_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ReindexRunActivity {
  version: 1;
  event: 'run';
  recordedAt: string;
  trigger: RefreshTrigger;
  result: LastRefreshMetadata['result'];
  durationMs: number;
  estimatedLogicalOutputBytes: number;
}

interface ReindexSuppressedActivity {
  version: 1;
  event: 'suppressed';
  recordedAt: string;
  trigger: RefreshTrigger;
  reason: 'completed-index-is-fresh';
}

export type ReindexActivityRecord = ReindexRunActivity | ReindexSuppressedActivity;

export type ReindexActivityWriteRuntime = RotatingJsonlRuntime;
export type ReindexActivityWriteResult = { state: 'recorded' } | { state: 'failed'; reason: string };

const defaultReadFile = (path: string): string => readSmallArtifactText(path, 'reindex activity segment');

export function reindexActivityPath(outputDb: string): string {
  return join(dirname(outputDb), REINDEX_ACTIVITY_FILE);
}

export function estimateReindexLogicalOutputBytes(result: ReindexResult): number {
  if (result.reused) return 0;
  let bytes = fileSize(result.indexPath) + fileSize(result.dbPath);
  for (const shard of result.shards ?? []) {
    if (!shard.reused && shard.outputBytes !== null) bytes += shard.outputBytes;
  }
  return bytes;
}

export function recordReindexRunActivity(outputDb: string, result: ReindexResult): ReindexActivityWriteResult {
  const refresh = result.lastRefresh;
  if (!refresh) return { state: 'failed', reason: 'reindex result has no refresh metadata' };
  return writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
    version: 1,
    event: 'run',
    recordedAt: refresh.completedAt,
    trigger: refresh.trigger,
    result: refresh.result,
    durationMs: refresh.durationMs,
    estimatedLogicalOutputBytes: estimateReindexLogicalOutputBytes(result),
  });
}

export function recordFailedReindexActivity(
  outputDb: string,
  refresh: LastRefreshMetadata,
): ReindexActivityWriteResult {
  return writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
    version: 1,
    event: 'run',
    recordedAt: refresh.completedAt,
    trigger: refresh.trigger,
    result: 'failed',
    durationMs: refresh.durationMs,
    estimatedLogicalOutputBytes: 0,
  });
}

export function recordSuppressedReindexActivity(
  outputDb: string,
  trigger: RefreshTrigger,
  now: Date = new Date(),
): ReindexActivityWriteResult {
  return writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
    version: 1,
    event: 'suppressed',
    recordedAt: now.toISOString(),
    trigger,
    reason: 'completed-index-is-fresh',
  });
}

export function appendReindexActivity(
  path: string,
  record: ReindexActivityRecord,
  maxBytes = REINDEX_ACTIVITY_MAX_BYTES,
  runtime?: ReindexActivityWriteRuntime,
): void {
  appendRotatingJsonlRecord(path, record, {
    maxSegmentBytes: maxBytes,
    previousSuffix: REINDEX_ACTIVITY_PREVIOUS_SUFFIX,
    ...(runtime ? { runtime } : {}),
  });
}

export function readReindexActivitySummary(
  outputDb: string,
  now: Date = new Date(),
  windowMs = REINDEX_ACTIVITY_WINDOW_MS,
  readFile: (path: string) => string = defaultReadFile,
): ReindexActivitySummary {
  const endedAtMs = now.getTime();
  const startedAtMs = endedAtMs - windowMs;
  const summary: ReindexActivitySummary &
    Required<
      Pick<
        ReindexActivitySummary,
        'confidence' | 'recordsRead' | 'invalidRecords' | 'skippedRecords' | 'readErrors' | 'ignoredPartialTailBytes'
      >
    > = {
    confidence: 'complete',
    recordsRead: 0,
    invalidRecords: 0,
    skippedRecords: 0,
    readErrors: 0,
    ignoredPartialTailBytes: 0,
    windowStartedAt: new Date(startedAtMs).toISOString(),
    windowEndedAt: now.toISOString(),
    runs: 0,
    rebuilt: 0,
    reused: 0,
    failed: 0,
    suppressed: 0,
    estimatedLogicalOutputBytes: 0,
    byTrigger: {},
  };
  const path = reindexActivityPath(outputDb);
  let lines: string[] = [];
  if (readFile === defaultReadFile) {
    try {
      const read = readRotatingJsonlLines(path, {
        previousSuffix: REINDEX_ACTIVITY_PREVIOUS_SUFFIX,
      });
      lines = read.lines;
      summary.ignoredPartialTailBytes = read.ignoredPartialTailBytes;
    } catch {
      summary.readErrors += 1;
      summary.confidence = 'unavailable';
    }
  } else {
    let segmentsRead = 0;
    for (const segment of [`${path}${REINDEX_ACTIVITY_PREVIOUS_SUFFIX}`, path]) {
      try {
        lines.push(...completeInjectedLines(readFile(segment)));
        segmentsRead += 1;
      } catch {
        summary.readErrors += 1;
      }
    }
    if (segmentsRead === 0) summary.confidence = 'unavailable';
    else if (summary.readErrors > 0) summary.confidence = 'partial';
  }
  for (const line of lines) {
    summary.recordsRead += 1;
    const record = parseReindexActivityRecord(line);
    if (!record) {
      summary.invalidRecords += 1;
      if (summary.confidence !== 'unavailable') summary.confidence = 'partial';
      continue;
    }
    const recordedAtMs = Date.parse(record.recordedAt);
    if (recordedAtMs < startedAtMs || recordedAtMs > endedAtMs) {
      summary.skippedRecords += 1;
      continue;
    }
    summary.byTrigger[record.trigger.kind] = (summary.byTrigger[record.trigger.kind] ?? 0) + 1;
    if (record.event === 'suppressed') {
      summary.suppressed += 1;
      continue;
    }
    summary.runs += 1;
    summary[record.result] += 1;
    summary.estimatedLogicalOutputBytes += record.estimatedLogicalOutputBytes;
  }
  if (summary.ignoredPartialTailBytes > 0 && summary.confidence !== 'unavailable') {
    summary.confidence = 'partial';
  }
  return summary;
}

function writeReindexActivityBestEffort(path: string, record: ReindexActivityRecord): ReindexActivityWriteResult {
  try {
    appendReindexActivity(path, record);
    return { state: 'recorded' };
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

function parseReindexActivityRecord(line: string): ReindexActivityRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<ReindexActivityRecord>;
    if (
      record.version !== 1 ||
      !isValidRecordTimestamp(record.recordedAt) ||
      !record.trigger ||
      !isRefreshTriggerKind(record.trigger.kind)
    ) {
      return null;
    }
    if (record.event === 'suppressed') {
      return record.reason === 'completed-index-is-fresh' ? (record as ReindexSuppressedActivity) : null;
    }
    if (
      record.event !== 'run' ||
      (record.result !== 'rebuilt' && record.result !== 'reused' && record.result !== 'failed') ||
      !isNonNegativeFiniteNumber(record.durationMs) ||
      !isNonNegativeFiniteNumber(record.estimatedLogicalOutputBytes)
    ) {
      return null;
    }
    return record as ReindexRunActivity;
  } catch {
    return null;
  }
}

function isRefreshTriggerKind(value: unknown): value is RefreshTriggerKind {
  return (
    value === 'manual-cli' ||
    value === 'setup' ||
    value === 'watch-source' ||
    value === 'watch-startup' ||
    value === 'watch-demand' ||
    value === 'watch-git-head' ||
    value === 'watch-git-index' ||
    value === 'watch-git-state' ||
    value === 'unknown'
  );
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function completeInjectedLines(contents: string): string[] {
  if (!contents.endsWith('\n')) contents = contents.slice(0, Math.max(0, contents.lastIndexOf('\n') + 1));
  return contents.split('\n').filter((line) => line.length > 0);
}
