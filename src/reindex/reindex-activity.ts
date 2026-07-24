import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  LastRefreshMetadata,
  RefreshTrigger,
  RefreshTriggerKind,
  ReindexActivitySummary,
} from '../domain/types.js';
import type { ReindexResult } from './index.js';

export const REINDEX_ACTIVITY_FILE = 'reindex-activity.jsonl';
export const REINDEX_ACTIVITY_PREVIOUS_SUFFIX = '.previous';
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

export interface ReindexActivityWriteRuntime {
  appendFile(path: string, value: string): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  size(path: string): number;
}

const defaultWriteRuntime: ReindexActivityWriteRuntime = {
  appendFile: appendFileSync,
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  size: (path) => statSync(path).size,
};

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

export function recordReindexRunActivity(outputDb: string, result: ReindexResult): void {
  const refresh = result.lastRefresh;
  if (!refresh) return;
  writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
    version: 1,
    event: 'run',
    recordedAt: refresh.completedAt,
    trigger: refresh.trigger,
    result: refresh.result,
    durationMs: refresh.durationMs,
    estimatedLogicalOutputBytes: estimateReindexLogicalOutputBytes(result),
  });
}

export function recordFailedReindexActivity(outputDb: string, refresh: LastRefreshMetadata): void {
  writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
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
): void {
  writeReindexActivityBestEffort(reindexActivityPath(outputDb), {
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
  runtime: ReindexActivityWriteRuntime = defaultWriteRuntime,
): void {
  const line = `${JSON.stringify(record)}\n`;
  const segmentLimit = Math.max(1, Math.floor(maxBytes));
  const previousPath = `${path}${REINDEX_ACTIVITY_PREVIOUS_SUFFIX}`;
  runtime.mkdir(dirname(path));
  if (runtime.exists(path)) {
    const currentBytes = runtime.size(path);
    if (currentBytes > segmentLimit) {
      runtime.remove(path);
      runtime.remove(previousPath);
    } else if (currentBytes + Buffer.byteLength(line) > segmentLimit) {
      runtime.remove(previousPath);
      runtime.rename(path, previousPath);
    }
  }
  runtime.appendFile(path, line);
}

export function readReindexActivitySummary(
  outputDb: string,
  now: Date = new Date(),
  windowMs = REINDEX_ACTIVITY_WINDOW_MS,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ReindexActivitySummary {
  const endedAtMs = now.getTime();
  const startedAtMs = endedAtMs - windowMs;
  const summary: ReindexActivitySummary = {
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
  for (const segment of [`${path}${REINDEX_ACTIVITY_PREVIOUS_SUFFIX}`, path]) {
    let contents: string;
    try {
      contents = readFile(segment);
    } catch {
      continue;
    }
    for (const line of contents.split('\n')) {
      if (!line) continue;
      const record = parseReindexActivityRecord(line);
      if (!record) continue;
      const recordedAtMs = Date.parse(record.recordedAt);
      if (recordedAtMs < startedAtMs || recordedAtMs > endedAtMs) continue;
      summary.byTrigger[record.trigger.kind] = (summary.byTrigger[record.trigger.kind] ?? 0) + 1;
      if (record.event === 'suppressed') {
        summary.suppressed += 1;
        continue;
      }
      summary.runs += 1;
      summary[record.result] += 1;
      summary.estimatedLogicalOutputBytes += record.estimatedLogicalOutputBytes;
    }
  }
  return summary;
}

function writeReindexActivityBestEffort(path: string, record: ReindexActivityRecord): void {
  try {
    appendReindexActivity(path, record);
  } catch {
    // Operational measurement must never mask a refresh result.
  }
}

function parseReindexActivityRecord(line: string): ReindexActivityRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<ReindexActivityRecord>;
    if (
      record.version !== 1 ||
      !validTimestamp(record.recordedAt) ||
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
      !nonNegativeNumber(record.durationMs) ||
      !nonNegativeNumber(record.estimatedLogicalOutputBytes)
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

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
