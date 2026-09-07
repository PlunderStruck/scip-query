import { join } from 'node:path';

import type { LastRefreshMetadata, ReindexActivitySummary, WatcherStatus } from '../domain/types.js';
import { isRefreshTriggerKind } from '../domain/maintenance-types.js';
import { SUPPORTED_LANGUAGES } from '../domain/config-types.js';
import {
  isNonNegativeFiniteNumber,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecordObject,
  isSha256Hex,
  isValidRecordTimestamp,
} from '../domain/record-validation.js';
import { parseProcessIdentity, type ProcessIdentity } from './process-identity.js';
import { readSmallArtifactText } from './bounded-file.js';

export const WATCH_SERVICE_PROTOCOL_VERSION = 6;
export const WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS = 10_000;
export const WATCH_LOCK_FILE = 'watch.lock';
export const WATCH_STATE_FILE = 'watch-state.json';
export const WATCH_ACTIVITY_FILE = 'watch-activity.json';
export const WATCH_REFRESH_REQUESTS_DIRECTORY = 'watch-refresh-requests';

export interface WatchRefreshRequestStatusSnapshot {
  pending: number;
  claimed: number;
  completed: number;
  expired: number;
  invalid: number;
  oldestPendingAt?: string;
}

export interface TypeScriptSemanticServiceStatusSnapshot {
  protocolVersion: number;
  state: 'idle' | 'ready' | 'unavailable' | 'error';
  requests: number;
  lastRequestAt?: string;
  lastError?: string;
  busyUntil?: string;
  sessionsCreated: number;
  sessionsReused: number;
  sessionsRefreshed: number;
  sessionsReplaced: number;
  projectsCreated: number;
  mailbox?: BoundedMailboxStatusSnapshot;
}

export interface TypeScriptIndexServiceStatusSnapshot {
  protocolVersion: number;
  state: 'idle' | 'ready' | 'unavailable' | 'error';
  requests: number;
  sessionsCreated: number;
  sessionsReplaced: number;
  sessionsEvicted?: number;
  activeSessions?: number;
  maxActiveSessions?: number;
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  softMemoryLimitBytes?: number;
  retireRequested?: boolean;
  initializations: number;
  programUpdates: number;
  documentsEmitted: number;
  documentsRemoved: number;
  lastRequestAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  busyUntil?: string;
  mailbox?: BoundedMailboxStatusSnapshot;
}

export interface BoundedMailboxStatusSnapshot {
  pending: number;
  inflight: number;
  responses: number;
  deadLetters: number;
  invalid: number;
  totalItems: number;
  totalBytes: number;
  oldestPendingAt?: string;
}

export interface WatchServiceState {
  version: 1;
  protocolVersion: typeof WATCH_SERVICE_PROTOCOL_VERSION;
  pid: number;
  /** Required on newly written state; absent only on legacy records that must never authorize signaling. */
  processIdentity?: ProcessIdentity;
  projectRoot: string;
  worktreeId?: string;
  cliVersion: string;
  startedAt: string;
  heartbeatAt: string;
  lastActivityAt: string;
  idleDeadlineAt?: string;
  watcher: WatcherStatus;
  indexGeneration?: string;
  lastRefresh?: LastRefreshMetadata;
  lastError?: { at: string; message: string };
  reindexActivity?: ReindexActivitySummary;
  refreshRequests?: WatchRefreshRequestStatusSnapshot;
  typescriptSemantic?: TypeScriptSemanticServiceStatusSnapshot;
  typescriptIndex?: TypeScriptIndexServiceStatusSnapshot;
}

// scip-query: ignore-stale — reviewed S1 owned contract; these paths are the watch-service filesystem boundary.
export interface WatchServicePaths {
  lockPath: string;
  statePath: string;
  activityPath: string;
  refreshRequestsPath: string;
}

export function watchServicePaths(cacheDir: string): WatchServicePaths {
  return {
    lockPath: join(cacheDir, WATCH_LOCK_FILE),
    statePath: join(cacheDir, WATCH_STATE_FILE),
    activityPath: join(cacheDir, WATCH_ACTIVITY_FILE),
    refreshRequestsPath: join(cacheDir, WATCH_REFRESH_REQUESTS_DIRECTORY),
  };
}

export function readWatchServiceState(statePath: string): WatchServiceState | null {
  try {
    return parseWatchServiceState(JSON.parse(readSmallArtifactText(statePath, 'watch service state')) as unknown);
  } catch {
    return null;
  }
}

export function parseWatchServiceState(value: unknown): WatchServiceState | null {
  if (
    !validFields(value, {
      version: (entry) => entry === 1,
      protocolVersion: isPositiveInteger,
      pid: isPositiveInteger,
      projectRoot: isString,
      worktreeId: optional((entry) => isString(entry) && entry.length > 0),
      cliVersion: isString,
      startedAt: isValidWatchServiceTimestamp,
      heartbeatAt: isValidWatchServiceTimestamp,
      lastActivityAt: isValidWatchServiceTimestamp,
      idleDeadlineAt: optional(isValidWatchServiceTimestamp),
      watcher: validWatcherStatus,
      indexGeneration: optional(isSha256Hex),
      lastError: optional(validLastError),
      lastRefresh: optional(validLastRefresh),
      reindexActivity: optional(validReindexActivitySummary),
      refreshRequests: optional(validWatchRefreshRequestStatus),
      typescriptSemantic: optional(validTypeScriptSemanticStatus),
      typescriptIndex: optional(validTypeScriptIndexStatus),
    })
  )
    return null;
  if (value.processIdentity === undefined) return value as unknown as WatchServiceState;
  const processIdentity = parseProcessIdentity(value.processIdentity);
  if (!processIdentity || processIdentity.pid !== value.pid) return null;
  return { ...value, processIdentity } as unknown as WatchServiceState;
}

// scip-query: ignore-wrapper — reviewed W1 reused predicate; validation sites share this timestamp rule.
export function isValidWatchServiceTimestamp(value: unknown): value is string {
  return isValidRecordTimestamp(value);
}

type FieldValidator = (value: unknown) => boolean;

/** Validate known fields while retaining forward-compatible extra metadata. */
function validFields(
  value: unknown,
  fields: Readonly<Record<string, FieldValidator>>,
): value is Record<string, unknown> {
  return isRecordObject(value) && Object.entries(fields).every(([key, validate]) => validate(value[key]));
}

function optional(validate: FieldValidator): FieldValidator {
  return (value) => value === undefined || validate(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function validWatcherStatus(value: unknown): value is WatcherStatus {
  if (!isRecordObject(value)) return false;
  switch (value.state) {
    case 'idle':
      return true;
    case 'waiting':
      return validFields(value, { changedFiles: isNonNegativeInteger, reindexAt: isNonNegativeFiniteNumber });
    case 'indexing':
      return validFields(value, { startedAt: isNonNegativeFiniteNumber });
    case 'cooldown':
      return validFields(value, { until: isNonNegativeFiniteNumber, dirty: isBoolean });
    case 'budget-paused':
      return validFields(value, {
        until: isNonNegativeFiniteNumber,
        dirty: isBoolean,
        reason: isString,
        rebuilt: isNonNegativeInteger,
        estimatedWriteBytes: isNonNegativeInteger,
      });
    case 'draining':
      return validFields(value, { startedAt: isNonNegativeFiniteNumber, reason: isString });
    default:
      return false;
  }
}

function validLastError(value: unknown): boolean {
  return validFields(value, { at: isValidWatchServiceTimestamp, message: isString });
}

function validLastRefresh(value: unknown): value is LastRefreshMetadata {
  return validFields(value, {
    trigger: (entry) => validFields(entry, { kind: isRefreshTriggerKind, detail: optional(isString) }),
    result: (entry) => entry === 'rebuilt' || entry === 'reused' || entry === 'failed',
    startedAt: isValidWatchServiceTimestamp,
    completedAt: isValidWatchServiceTimestamp,
    durationMs: isNonNegativeFiniteNumber,
    indexedLanguages: optional((entry) => Array.isArray(entry) && entry.every(isSupportedLanguage)),
    skipped: optional(
      (entry) =>
        Array.isArray(entry) &&
        entry.every((item) => validFields(item, { language: isSupportedLanguage, reason: isString })),
    ),
    error: optional(isString),
  });
}

function isSupportedLanguage(value: unknown): boolean {
  return isString(value) && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function validConfidence(value: unknown): boolean {
  return value === 'complete' || value === 'partial' || value === 'unavailable';
}

function validReindexActivitySummary(value: unknown): value is ReindexActivitySummary {
  return validFields(value, {
    confidence: optional(validConfidence),
    recordsRead: optional(isNonNegativeInteger),
    invalidRecords: optional(isNonNegativeInteger),
    skippedRecords: optional(isNonNegativeInteger),
    readErrors: optional(isNonNegativeInteger),
    ignoredPartialTailBytes: optional(isNonNegativeInteger),
    windowStartedAt: isValidWatchServiceTimestamp,
    windowEndedAt: isValidWatchServiceTimestamp,
    runs: isNonNegativeInteger,
    rebuilt: isNonNegativeInteger,
    fullRebuilds: optional(isNonNegativeInteger),
    reused: isNonNegativeInteger,
    failed: isNonNegativeInteger,
    suppressed: isNonNegativeInteger,
    estimatedLogicalOutputBytes: isNonNegativeFiniteNumber,
    estimatedWriteBytes: optional(isNonNegativeInteger),
    reflinkedBytes: optional(isNonNegativeInteger),
    fallbackCopiedBytes: optional(isNonNegativeInteger),
    oldestRebuildAt: optional(isValidWatchServiceTimestamp),
    oldestWriteAt: optional(isValidWatchServiceTimestamp),
    languageAttribution: optional(validConfidence),
    attributedRuns: optional(isNonNegativeInteger),
    unattributedRuns: optional(isNonNegativeInteger),
    invalidLanguageDetails: optional(isNonNegativeInteger),
    byTrigger: (entry) =>
      isRecordObject(entry) &&
      Object.entries(entry).every(
        ([kind, count]) => isRefreshTriggerKind(kind) && (count === undefined || isNonNegativeInteger(count)),
      ),
    byLanguage: optional(validLanguageActivitySummary),
    automatic: optional(validAutomaticActivitySummary),
  });
}

function validAutomaticActivitySummary(value: unknown): boolean {
  return validFields(value, {
    runs: isNonNegativeInteger,
    rebuilt: isNonNegativeInteger,
    fullRebuilds: isNonNegativeInteger,
    estimatedWriteBytes: isNonNegativeInteger,
    oldestRebuildAt: optional(isValidWatchServiceTimestamp),
    oldestWriteAt: optional(isValidWatchServiceTimestamp),
  });
}

function validLanguageActivitySummary(value: unknown): boolean {
  return (
    isRecordObject(value) &&
    Object.entries(value).every(
      ([language, candidate]) => isSupportedLanguage(language) && validLanguageActivity(candidate),
    )
  );
}

function validLanguageActivity(value: unknown): boolean {
  if (
    !validFields(value, {
      runs: isNonNegativeInteger,
      rebuilt: isNonNegativeInteger,
      reused: isNonNegativeInteger,
      producedOutputBytes: isNonNegativeInteger,
      durationMs: isNonNegativeFiniteNumber,
    })
  )
    return false;
  return (value.rebuilt as number) + (value.reused as number) === value.runs;
}

function validWatchRefreshRequestStatus(value: unknown): value is WatchRefreshRequestStatusSnapshot {
  return validFields(value, {
    pending: isNonNegativeInteger,
    claimed: isNonNegativeInteger,
    completed: isNonNegativeInteger,
    expired: isNonNegativeInteger,
    invalid: isNonNegativeInteger,
    oldestPendingAt: optional(isValidWatchServiceTimestamp),
  });
}

function validServiceState(value: unknown): boolean {
  return value === 'idle' || value === 'ready' || value === 'unavailable' || value === 'error';
}

function validTypeScriptSemanticStatus(value: unknown): value is TypeScriptSemanticServiceStatusSnapshot {
  return validFields(value, {
    protocolVersion: isPositiveInteger,
    state: validServiceState,
    requests: isNonNegativeInteger,
    sessionsCreated: isNonNegativeInteger,
    sessionsReused: isNonNegativeInteger,
    sessionsRefreshed: isNonNegativeInteger,
    sessionsReplaced: isNonNegativeInteger,
    projectsCreated: isNonNegativeInteger,
    lastRequestAt: optional(isValidWatchServiceTimestamp),
    lastError: optional(isString),
    busyUntil: optional(isValidWatchServiceTimestamp),
    mailbox: optional(validBoundedMailboxStatus),
  });
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function validTypeScriptIndexStatus(value: unknown): value is TypeScriptIndexServiceStatusSnapshot {
  return validFields(value, {
    protocolVersion: isPositiveInteger,
    state: validServiceState,
    requests: isNonNegativeInteger,
    sessionsCreated: isNonNegativeInteger,
    sessionsReplaced: isNonNegativeInteger,
    sessionsEvicted: optional(isNonNegativeInteger),
    activeSessions: optional(isNonNegativeInteger),
    maxActiveSessions: optional(isNonNegativeInteger),
    heapUsedBytes: optional(isNonNegativeInteger),
    heapLimitBytes: optional(isNonNegativeInteger),
    softMemoryLimitBytes: optional(isNonNegativeInteger),
    retireRequested: optional(isBoolean),
    initializations: isNonNegativeInteger,
    programUpdates: isNonNegativeInteger,
    documentsEmitted: isNonNegativeInteger,
    documentsRemoved: isNonNegativeInteger,
    lastRequestAt: optional(isValidWatchServiceTimestamp),
    lastDurationMs: optional(isNonNegativeFiniteNumber),
    lastError: optional(isString),
    busyUntil: optional(isValidWatchServiceTimestamp),
    mailbox: optional(validBoundedMailboxStatus),
  });
}

function validBoundedMailboxStatus(value: unknown): value is BoundedMailboxStatusSnapshot {
  if (
    !validFields(value, {
      pending: isNonNegativeInteger,
      inflight: isNonNegativeInteger,
      responses: isNonNegativeInteger,
      deadLetters: isNonNegativeInteger,
      invalid: isNonNegativeInteger,
      totalItems: isNonNegativeInteger,
      totalBytes: isNonNegativeFiniteNumber,
      oldestPendingAt: optional(isValidWatchServiceTimestamp),
    })
  )
    return false;
  return (
    value.totalItems ===
    (value.pending as number) + (value.inflight as number) + (value.responses as number) + (value.deadLetters as number)
  );
}
