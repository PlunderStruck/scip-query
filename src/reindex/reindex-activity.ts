import { isRefreshTriggerKind } from '../domain/maintenance-types.js';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  LastRefreshMetadata,
  RefreshTrigger,
  ReindexActivitySummary,
  ReindexLanguageActivitySummary,
  SupportedLanguage,
  WatchResourceBudgetConfig,
} from '../domain/types.js';
import { SUPPORTED_LANGUAGES } from '../domain/config-types.js';
import {
  isNonNegativeFiniteNumber,
  isNonNegativeInteger,
  isValidRecordTimestamp,
} from '../domain/record-validation.js';
import type { ReindexResult } from './reindex-result.js';
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
  incrementalWrittenBytes?: number;
  byLanguage?: Partial<Record<SupportedLanguage, ReindexRunLanguageActivity>>;
}

export interface ReindexRunLanguageActivity {
  result: 'rebuilt' | 'reused';
  strategy?: 'reused' | 'incremental' | 'full';
  fallbackReason?: string;
  /** Size of the top-level cached SCIP shard after this run. */
  outputBytes: number;
  /** Bytes newly produced by this run. Reused shards always contribute zero. */
  producedOutputBytes: number;
  /** Indexer time for this language; reused shards always contribute zero. */
  durationMs: number;
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
  const completeScipDeferred =
    result.shards?.some((shard) => !shard.reused && shard.strategy === 'incremental') ?? false;
  let bytes = (completeScipDeferred ? 0 : fileSize(result.indexPath)) + fileSize(result.dbPath);
  for (const shard of result.shards ?? []) {
    if (shard.reused) continue;
    const producedBytes = shard.producedOutputBytes ?? shard.outputBytes;
    if (producedBytes !== null) bytes += producedBytes;
  }
  return bytes;
}

export function estimateReindexWriteBytes(result: ReindexResult): number {
  const logicalBytes = estimateReindexLogicalOutputBytes(result);
  const telemetry = result.writeTelemetry;
  if (!telemetry) return logicalBytes;
  return (
    Math.max(0, logicalBytes - telemetry.reflinkedBytes) +
    telemetry.fallbackCopiedBytes +
    (telemetry.incrementalWrittenBytes ?? 0)
  );
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
    estimatedWriteBytes: estimateReindexWriteBytes(result),
    reflinkedBytes: result.writeTelemetry?.reflinkedBytes ?? 0,
    fallbackCopiedBytes: result.writeTelemetry?.fallbackCopiedBytes ?? 0,
    incrementalWrittenBytes: result.writeTelemetry?.incrementalWrittenBytes ?? 0,
    byLanguage: summarizeLanguageActivity(result),
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
  const summary = emptyActivitySummary(startedAtMs, now);
  const lines = readActivityLines(reindexActivityPath(outputDb), readFile, summary);
  if (lines === null) return summary;
  for (const line of lines) {
    const parsed = includedActivityRecord(line, startedAtMs, endedAtMs, summary);
    if (!parsed) continue;
    const { record } = parsed;
    summary.invalidLanguageDetails += parsed.invalidLanguageDetails;
    summary.byTrigger[record.trigger.kind] = (summary.byTrigger[record.trigger.kind] ?? 0) + 1;
    if (record.event === 'suppressed') {
      summary.suppressed += 1;
      continue;
    }
    accumulateReindexActivityRun(summary, parsed, record);
  }
  if (summary.ignoredPartialTailBytes > 0 && summary.confidence !== 'unavailable') {
    summary.confidence = 'partial';
  }
  summary.languageAttribution = languageAttribution(summary);
  return summary;
}

type CollectedActivitySummary = ReindexActivitySummary &
  Required<
    Pick<
      ReindexActivitySummary,
      | 'confidence'
      | 'recordsRead'
      | 'invalidRecords'
      | 'skippedRecords'
      | 'readErrors'
      | 'ignoredPartialTailBytes'
      | 'estimatedWriteBytes'
      | 'reflinkedBytes'
      | 'fallbackCopiedBytes'
      | 'attributedRuns'
      | 'unattributedRuns'
      | 'invalidLanguageDetails'
      | 'fullRebuilds'
      | 'byLanguage'
      | 'automatic'
    >
  >;

function emptyActivitySummary(startedAtMs: number, now: Date): CollectedActivitySummary {
  return {
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
    fullRebuilds: 0,
    reused: 0,
    failed: 0,
    suppressed: 0,
    estimatedLogicalOutputBytes: 0,
    estimatedWriteBytes: 0,
    reflinkedBytes: 0,
    fallbackCopiedBytes: 0,
    languageAttribution: 'complete',
    attributedRuns: 0,
    unattributedRuns: 0,
    invalidLanguageDetails: 0,
    byLanguage: {},
    byTrigger: {},
    automatic: { runs: 0, rebuilt: 0, fullRebuilds: 0, estimatedWriteBytes: 0 },
  };
}

function readActivityLines(
  path: string,
  readFile: (path: string) => string,
  summary: CollectedActivitySummary,
): string[] | null {
  let lines: string[] = [];
  if (readFile === defaultReadFile) {
    if (!existsSync(path) && !existsSync(`${path}${REINDEX_ACTIVITY_PREVIOUS_SUFFIX}`)) {
      return null;
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
  return lines;
}

function includedActivityRecord(
  line: string,
  startedAtMs: number,
  endedAtMs: number,
  summary: CollectedActivitySummary,
): ReturnType<typeof parseReindexActivityRecord> {
  summary.recordsRead += 1;
  const parsed = parseReindexActivityRecord(line);
  if (!parsed) {
    summary.invalidRecords += 1;
    if (summary.confidence !== 'unavailable') summary.confidence = 'partial';
    return null;
  }
  const { record } = parsed;
  const recordedAtMs = Date.parse(record.recordedAt);
  if (recordedAtMs < startedAtMs || recordedAtMs > endedAtMs) {
    summary.skippedRecords += 1;
    return null;
  }
  return parsed;
}

function accumulateReindexActivityRun(
  summary: CollectedActivitySummary,
  parsed: NonNullable<ReturnType<typeof parseReindexActivityRecord>>,
  record: ReindexRunActivity,
): void {
  summary.runs += 1;
  summary[record.result] += 1;
  summary.estimatedLogicalOutputBytes += record.estimatedLogicalOutputBytes;
  const estimatedWriteBytes = effectiveRecordedWriteBytes(record);
  summary.estimatedWriteBytes += estimatedWriteBytes;
  summary.reflinkedBytes += record.reflinkedBytes ?? 0;
  summary.fallbackCopiedBytes += record.fallbackCopiedBytes ?? 0;
  accumulateActivityLanguages(summary, parsed, record);
  const expensiveRebuild = isExpensiveRebuild(record);
  if (expensiveRebuild && summary.oldestRebuildAt === undefined) {
    summary.oldestRebuildAt = record.recordedAt;
  }
  if (expensiveRebuild) {
    summary.fullRebuilds += 1;
  }
  if (estimatedWriteBytes > 0 && summary.oldestWriteAt === undefined) {
    summary.oldestWriteAt = record.recordedAt;
  }
  accumulateAutomaticActivity(summary.automatic, record, expensiveRebuild, estimatedWriteBytes);
}

function accumulateActivityLanguages(
  summary: CollectedActivitySummary,
  parsed: NonNullable<ReturnType<typeof parseReindexActivityRecord>>,
  record: ReindexRunActivity,
): void {
  if (record.result !== 'failed') {
    if (parsed.hasLanguageDetails) {
      summary.attributedRuns += 1;
    } else {
      summary.unattributedRuns += 1;
    }
  }
  for (const [language, detail] of typedLanguageEntries(record.byLanguage)) {
    const languageSummary = (summary.byLanguage[language] ??= emptyLanguageSummary());
    languageSummary.runs += 1;
    languageSummary[detail.result] += 1;
    languageSummary.producedOutputBytes += detail.producedOutputBytes;
    languageSummary.durationMs += detail.durationMs;
  }
}

function accumulateAutomaticActivity(
  automatic: NonNullable<ReindexActivitySummary['automatic']>,
  record: ReindexRunActivity,
  expensiveRebuild: boolean,
  estimatedWriteBytes: number,
): void {
  if (isAutomaticTrigger(record.trigger)) {
    automatic.runs += 1;
    if (record.result === 'rebuilt') automatic.rebuilt += 1;
    if (expensiveRebuild) {
      automatic.fullRebuilds += 1;
      automatic.oldestRebuildAt ??= record.recordedAt;
    }
    automatic.estimatedWriteBytes += estimatedWriteBytes;
    if (estimatedWriteBytes > 0) automatic.oldestWriteAt ??= record.recordedAt;
  }
}

function writeReindexActivityBestEffort(path: string, record: ReindexActivityRecord): ReindexActivityWriteResult {
  try {
    appendReindexActivity(path, record);
    return { state: 'recorded' };
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

interface ParsedReindexActivityRecord {
  record: ReindexActivityRecord;
  hasLanguageDetails: boolean;
  invalidLanguageDetails: number;
}

function parseReindexActivityRecord(line: string): ParsedReindexActivityRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<ReindexActivityRecord>;
    if (!hasValidActivityHeader(record)) return null;
    if (record.event === 'suppressed') {
      return record.reason === 'completed-index-is-fresh'
        ? {
            record: record as ReindexSuppressedActivity,
            hasLanguageDetails: false,
            invalidLanguageDetails: 0,
          }
        : null;
    }
    if (!isValidRunActivity(record)) return null;
    const runRecord = record as ReindexRunActivity;
    const { byLanguage: _untrustedByLanguage, ...baseRecord } = runRecord;
    const parsedLanguages = parseLanguageActivity(_untrustedByLanguage);
    const sanitized: ReindexRunActivity = {
      ...baseRecord,
      ...(parsedLanguages.byLanguage ? { byLanguage: parsedLanguages.byLanguage } : {}),
    };
    return {
      record: sanitized,
      hasLanguageDetails: parsedLanguages.hasLanguageDetails,
      invalidLanguageDetails: parsedLanguages.invalidLanguageDetails,
    };
  } catch {
    return null;
  }
}

function hasValidActivityHeader(record: Partial<ReindexActivityRecord>): boolean {
  return (
    record.version === 1 &&
    isValidRecordTimestamp(record.recordedAt) &&
    !!record.trigger &&
    isRefreshTriggerKind(record.trigger.kind)
  );
}

function isValidRunActivity(record: Partial<ReindexActivityRecord>): boolean {
  if (record.event !== 'run') return false;
  if (record.result !== 'rebuilt' && record.result !== 'reused' && record.result !== 'failed') return false;
  if (!isNonNegativeFiniteNumber(record.durationMs)) return false;
  if (!isNonNegativeFiniteNumber(record.estimatedLogicalOutputBytes)) return false;
  return [
    record.estimatedWriteBytes,
    record.reflinkedBytes,
    record.fallbackCopiedBytes,
    record.incrementalWrittenBytes,
  ].every((value) => value === undefined || isNonNegativeFiniteNumber(value));
}

function effectiveRecordedWriteBytes(record: ReindexRunActivity): number {
  if (record.reflinkedBytes === undefined) {
    return record.estimatedWriteBytes ?? record.estimatedLogicalOutputBytes;
  }
  return (
    Math.max(0, record.estimatedLogicalOutputBytes - record.reflinkedBytes) +
    (record.fallbackCopiedBytes ?? 0) +
    (record.incrementalWrittenBytes ?? 0)
  );
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

/** Refreshes the watcher started itself; `setup` and manual `reindex` are explicit consent. */
export function isAutomaticTrigger(trigger: RefreshTrigger): boolean {
  return trigger.kind.startsWith('watch-');
}

export function evaluateReindexActivityBudget(
  summary: ReindexActivitySummary,
  config: Required<WatchResourceBudgetConfig>,
  nowMs: number,
): ReindexActivityBudgetDecision {
  // Only the watcher's own refreshes consume the automatic budget. A legacy
  // summary without the split falls back to the window totals.
  const charged = summary.automatic ?? {
    fullRebuilds: summary.fullRebuilds ?? summary.rebuilt,
    estimatedWriteBytes: summary.estimatedWriteBytes ?? summary.estimatedLogicalOutputBytes,
    oldestRebuildAt: summary.oldestRebuildAt,
    oldestWriteAt: summary.oldestWriteAt,
  };
  const estimatedWriteBytes = charged.estimatedWriteBytes;
  const expensiveRebuilds = charged.fullRebuilds;
  const consumption = { rebuilt: expensiveRebuilds, estimatedWriteBytes };
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
  if (expensiveRebuilds >= config.maxRebuilds) {
    return {
      state: 'paused',
      reason: 'rebuild-count',
      until: budgetRetryAt(charged.oldestRebuildAt, config.windowMs, nowMs),
      ...consumption,
      detail: `${expensiveRebuilds}/${config.maxRebuilds} expensive full rebuild slots consumed by automatic refreshes`,
    };
  }
  if (estimatedWriteBytes >= config.maxEstimatedWriteBytes) {
    return {
      state: 'paused',
      reason: 'estimated-write-bytes',
      until: budgetRetryAt(charged.oldestWriteAt, config.windowMs, nowMs),
      ...consumption,
      detail: `${estimatedWriteBytes}/${config.maxEstimatedWriteBytes} estimated write bytes consumed by automatic refreshes`,
    };
  }
  return { state: 'allowed', ...consumption };
}

function isExpensiveRebuild(record: ReindexRunActivity): boolean {
  if (record.result !== 'rebuilt') return false;
  const languages = typedLanguageEntries(record.byLanguage);
  if (languages.length === 0) return true;
  return languages.some(
    ([, detail]) => detail.result === 'rebuilt' && detail.strategy !== 'incremental' && detail.strategy !== 'reused',
  );
}

function budgetRetryAt(oldestContributingRecord: string | undefined, windowMs: number, nowMs: number): number {
  const oldestAtMs = oldestContributingRecord ? Date.parse(oldestContributingRecord) : Number.NaN;
  return Number.isFinite(oldestAtMs) && oldestAtMs + windowMs > nowMs ? oldestAtMs + windowMs : nowMs + windowMs;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function summarizeLanguageActivity(
  result: ReindexResult,
): Partial<Record<SupportedLanguage, ReindexRunLanguageActivity>> {
  const byLanguage: Partial<Record<SupportedLanguage, ReindexRunLanguageActivity>> = {};
  for (const language of result.languages) {
    byLanguage[language] = summarizeOneLanguageActivity(result, language);
  }
  return byLanguage;
}

function summarizeOneLanguageActivity(result: ReindexResult, language: SupportedLanguage): ReindexRunLanguageActivity {
  const diagnostics = (result.shards ?? []).filter((shard) => shard.language === language);
  const topLevel = diagnostics.find((shard) => shard.id === language);
  const reused = languageShardsReused(result.reused, diagnostics, topLevel);
  const cachedOutputBytes = fileSize(join(dirname(result.dbPath), 'language-indexes', `${language}.scip`));
  const outputBytes = cachedOutputBytes > 0 ? cachedOutputBytes : (topLevel?.outputBytes ?? cachedOutputBytes);
  const durationMs = languageShardDuration(reused, diagnostics, topLevel);
  return {
    result: reused ? 'reused' : 'rebuilt',
    strategy: reused ? 'reused' : (topLevel?.strategy ?? 'full'),
    ...languageFallbackReason(topLevel),
    outputBytes,
    producedOutputBytes: reused ? 0 : (topLevel?.producedOutputBytes ?? outputBytes),
    durationMs,
  };
}

type LanguageActivityShard = NonNullable<ReindexResult['shards']>[number];

function languageFallbackReason(
  topLevel: LanguageActivityShard | undefined,
): Pick<ReindexRunLanguageActivity, 'fallbackReason'> {
  return topLevel?.strategy === 'full' && (topLevel.fallbackReason ?? topLevel.missReason)
    ? { fallbackReason: topLevel.fallbackReason ?? topLevel.missReason }
    : {};
}

function languageShardsReused(
  resultReused: boolean,
  diagnostics: LanguageActivityShard[],
  topLevel: LanguageActivityShard | undefined,
): boolean {
  return (
    resultReused || (topLevel ? topLevel.reused : diagnostics.length > 0 && diagnostics.every((shard) => shard.reused))
  );
}

function languageShardDuration(
  reused: boolean,
  diagnostics: LanguageActivityShard[],
  topLevel: LanguageActivityShard | undefined,
): number {
  if (reused) return 0;
  return (
    topLevel?.durationMs ??
    diagnostics.filter((shard) => !shard.reused).reduce((total, shard) => total + shard.durationMs, 0)
  );
}

function parseLanguageActivity(value: unknown): {
  byLanguage?: Partial<Record<SupportedLanguage, ReindexRunLanguageActivity>>;
  hasLanguageDetails: boolean;
  invalidLanguageDetails: number;
} {
  if (value === undefined) return { hasLanguageDetails: false, invalidLanguageDetails: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { hasLanguageDetails: false, invalidLanguageDetails: 1 };
  }
  const byLanguage: Partial<Record<SupportedLanguage, ReindexRunLanguageActivity>> = {};
  let invalidLanguageDetails = 0;
  for (const [language, detail] of Object.entries(value)) {
    if (!isSupportedLanguage(language) || !isValidLanguageActivity(detail)) {
      invalidLanguageDetails += 1;
      continue;
    }
    byLanguage[language] = detail;
  }
  const hasLanguageDetails = Object.keys(byLanguage).length > 0;
  return {
    ...(hasLanguageDetails ? { byLanguage } : {}),
    hasLanguageDetails,
    invalidLanguageDetails,
  };
}

function isValidLanguageActivity(value: unknown): value is ReindexRunLanguageActivity {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<ReindexRunLanguageActivity>;
  return validLanguageActivityStrategy(detail) && validLanguageActivityProduction(detail);
}

function validLanguageActivityStrategy(detail: Partial<ReindexRunLanguageActivity>): boolean {
  return (
    (detail.result === 'rebuilt' || detail.result === 'reused') &&
    (detail.strategy === undefined ||
      detail.strategy === 'reused' ||
      detail.strategy === 'incremental' ||
      detail.strategy === 'full') &&
    (detail.fallbackReason === undefined || typeof detail.fallbackReason === 'string')
  );
}

function validLanguageActivityProduction(detail: Partial<ReindexRunLanguageActivity>): boolean {
  return (
    isNonNegativeInteger(detail.outputBytes) &&
    isNonNegativeInteger(detail.producedOutputBytes) &&
    isNonNegativeFiniteNumber(detail.durationMs) &&
    (detail.result !== 'reused' || (detail.producedOutputBytes === 0 && detail.durationMs === 0)) &&
    detail.producedOutputBytes! <= detail.outputBytes!
  );
}

function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function typedLanguageEntries(
  value: Partial<Record<SupportedLanguage, ReindexRunLanguageActivity>> | undefined,
): [SupportedLanguage, ReindexRunLanguageActivity][] {
  if (!value) return [];
  return SUPPORTED_LANGUAGES.flatMap((language) => {
    const detail = value[language];
    return detail ? [[language, detail] as [SupportedLanguage, ReindexRunLanguageActivity]] : [];
  });
}

function emptyLanguageSummary(): ReindexLanguageActivitySummary {
  return { runs: 0, rebuilt: 0, reused: 0, producedOutputBytes: 0, durationMs: 0 };
}

function languageAttribution(
  summary: ReindexActivitySummary,
): NonNullable<ReindexActivitySummary['languageAttribution']> {
  const invalid = summary.invalidLanguageDetails ?? 0;
  const attributed = summary.attributedRuns ?? 0;
  const unattributed = summary.unattributedRuns ?? 0;
  if (unattributed === 0 && invalid === 0) return 'complete';
  if (attributed === 0) return 'unavailable';
  return 'partial';
}

function completeInjectedLines(contents: string): string[] {
  if (!contents.endsWith('\n')) contents = contents.slice(0, Math.max(0, contents.lastIndexOf('\n') + 1));
  return contents.split('\n').filter((line) => line.length > 0);
}
