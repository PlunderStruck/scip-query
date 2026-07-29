import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  LastRefreshMetadata,
  RefreshTrigger,
  RefreshTriggerKind,
  ReindexActivitySummary,
  WatchResourceBudgetConfig,
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

export interface ReindexRunActivity {
  version: 1;
  event: 'run';
  recordedAt: string;
  trigger: RefreshTrigger;
  result: LastRefreshMetadata['result'];
  durationMs: number;
  estimatedLogicalOutputBytes: number;
  estimatedWriteBytes?: number;
  reflinkedBytes?: number;
  fallbackCopiedBytes?: number;
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

export function estimateReindexWriteBytes(result: ReindexResult): number {
  return estimateReindexLogicalOutputBytes(result) + (result.writeTelemetry?.fallbackCopiedBytes ?? 0);
}

export function recordReindexRunActivity(outputDb: string, result: ReindexResult): ReindexActivityWriteResult {
  const refresh = result.lastRefresh;
  if (!refresh) return { state: 'failed', reason: 'reindex result has no refresh metadata' };
  const estimatedLogicalOutputBytes = estimateReindexLogicalOutputBytes(result);
  return writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
    version: 1,
    event: 'run',
    recordedAt: refresh.completedAt,
    trigger: refresh.trigger,
    result: refresh.result,
    durationMs: refresh.durationMs,
    estimatedLogicalOutputBytes,
    estimatedWriteBytes: estimatedLogicalOutputBytes + (result.writeTelemetry?.fallbackCopiedBytes ?? 0),
    reflinkedBytes: result.writeTelemetry?.reflinkedBytes ?? 0,
    fallbackCopiedBytes: result.writeTelemetry?.fallbackCopiedBytes ?? 0,
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
    estimatedWriteBytes: 0,
    reflinkedBytes: 0,
    fallbackCopiedBytes: 0,
    byTrigger: {},
  };
  const path = reindexActivityPath(outputDb);
  let lines: string[] = [];
  if (readFile === defaultReadFile) {
    if (!existsSync(path) && !existsSync(`${path}${REINDEX_ACTIVITY_PREVIOUS_SUFFIX}`)) {
      return summary;
    }
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
    summary.estimatedWriteBytes =
      (summary.estimatedWriteBytes ?? 0) + (record.estimatedWriteBytes ?? record.estimatedLogicalOutputBytes);
    summary.reflinkedBytes = (summary.reflinkedBytes ?? 0) + (record.reflinkedBytes ?? 0);
    summary.fallbackCopiedBytes = (summary.fallbackCopiedBytes ?? 0) + (record.fallbackCopiedBytes ?? 0);
    if (record.result === 'rebuilt' && summary.oldestRebuildAt === undefined) {
      summary.oldestRebuildAt = record.recordedAt;
    }
    if ((record.estimatedWriteBytes ?? record.estimatedLogicalOutputBytes) > 0 && summary.oldestWriteAt === undefined) {
      summary.oldestWriteAt = record.recordedAt;
    }
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
      !isNonNegativeFiniteNumber(record.estimatedLogicalOutputBytes) ||
      (record.estimatedWriteBytes !== undefined && !isNonNegativeFiniteNumber(record.estimatedWriteBytes)) ||
      (record.reflinkedBytes !== undefined && !isNonNegativeFiniteNumber(record.reflinkedBytes)) ||
      (record.fallbackCopiedBytes !== undefined && !isNonNegativeFiniteNumber(record.fallbackCopiedBytes))
    ) {
      return null;
    }
    return record as ReindexRunActivity;
  } catch {
    return null;
  }
}

export type ReindexActivityBudgetDecision =
  | {
      state: 'allowed';
      rebuilt: number;
      estimatedWriteBytes: number;
    }
  | {
      state: 'paused';
      reason: 'rebuild-count' | 'estimated-write-bytes' | 'activity-evidence';
      until: number;
      rebuilt: number;
      estimatedWriteBytes: number;
      detail: string;
    };

export function inspectReindexActivityBudget(
  outputDb: string,
  config: Required<WatchResourceBudgetConfig>,
  now = new Date(),
): ReindexActivityBudgetDecision {
  if (!config.enabled) return { state: 'allowed', rebuilt: 0, estimatedWriteBytes: 0 };
  return evaluateReindexActivityBudget(
    readReindexActivitySummary(outputDb, now, config.windowMs),
    config,
    now.getTime(),
  );
}

export function evaluateReindexActivityBudget(
  summary: ReindexActivitySummary,
  config: Required<WatchResourceBudgetConfig>,
  nowMs: number,
): ReindexActivityBudgetDecision {
  const estimatedWriteBytes = summary.estimatedWriteBytes ?? summary.estimatedLogicalOutputBytes;
  const consumption = { rebuilt: summary.rebuilt, estimatedWriteBytes };
  if (!config.enabled) return { state: 'allowed', ...consumption };
  if (summary.confidence !== undefined && summary.confidence !== 'complete') {
    return {
      state: 'paused',
      reason: 'activity-evidence',
      until: nowMs + config.windowMs,
      ...consumption,
      detail: `reindex activity evidence is ${summary.confidence}`,
    };
  }
  if (summary.rebuilt >= config.maxRebuilds) {
    return {
      state: 'paused',
      reason: 'rebuild-count',
      until: budgetRetryAt(summary.oldestRebuildAt, config.windowMs, nowMs),
      ...consumption,
      detail: `${summary.rebuilt}/${config.maxRebuilds} automatic rebuild slots consumed`,
    };
  }
  if (estimatedWriteBytes >= config.maxEstimatedWriteBytes) {
    return {
      state: 'paused',
      reason: 'estimated-write-bytes',
      until: budgetRetryAt(summary.oldestWriteAt, config.windowMs, nowMs),
      ...consumption,
      detail: `${estimatedWriteBytes}/${config.maxEstimatedWriteBytes} estimated write bytes consumed`,
    };
  }
  return { state: 'allowed', ...consumption };
}

function budgetRetryAt(oldestContributingRecord: string | undefined, windowMs: number, nowMs: number): number {
  const oldestAtMs = oldestContributingRecord ? Date.parse(oldestContributingRecord) : Number.NaN;
  return Number.isFinite(oldestAtMs) && oldestAtMs + windowMs > nowMs ? oldestAtMs + windowMs : nowMs + windowMs;
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
