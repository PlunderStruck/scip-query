import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LastRefreshMetadata, ReindexActivitySummary, WatcherStatus } from '../domain/types.js';
import { isValidRecordTimestamp } from '../domain/record-validation.js';
import { parseProcessIdentity, type ProcessIdentity } from './process-identity.js';

export const WATCH_SERVICE_PROTOCOL_VERSION = 5;
export const WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS = 5_000;
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
    return parseWatchServiceState(JSON.parse(readFileSync(statePath, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

export function parseWatchServiceState(value: unknown): WatchServiceState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<WatchServiceState>;
  if (
    state.version !== 1 ||
    typeof state.protocolVersion !== 'number' ||
    typeof state.pid !== 'number' ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0 ||
    typeof state.projectRoot !== 'string' ||
    (state.worktreeId !== undefined && (typeof state.worktreeId !== 'string' || state.worktreeId.length === 0)) ||
    typeof state.cliVersion !== 'string' ||
    !isValidWatchServiceTimestamp(state.startedAt) ||
    !isValidWatchServiceTimestamp(state.heartbeatAt) ||
    !isValidWatchServiceTimestamp(state.lastActivityAt) ||
    !validWatcherStatus(state.watcher)
  ) {
    return null;
  }
  if (state.idleDeadlineAt !== undefined && !isValidWatchServiceTimestamp(state.idleDeadlineAt)) {
    return null;
  }
  if (state.processIdentity !== undefined) {
    const processIdentity = parseProcessIdentity(state.processIdentity);
    if (!processIdentity || processIdentity.pid !== state.pid) return null;
    state.processIdentity = processIdentity;
  }
  if (state.indexGeneration !== undefined && !/^[a-f0-9]{64}$/.test(state.indexGeneration)) {
    return null;
  }
  if (state.lastError !== undefined && !validLastError(state.lastError)) return null;
  if (state.lastRefresh !== undefined && !validLastRefresh(state.lastRefresh)) return null;
  if (state.reindexActivity !== undefined && !validReindexActivitySummary(state.reindexActivity)) return null;
  if (state.refreshRequests !== undefined && !validWatchRefreshRequestStatus(state.refreshRequests)) return null;
  if (state.typescriptSemantic !== undefined && !validTypeScriptSemanticStatus(state.typescriptSemantic)) {
    return null;
  }
  if (state.typescriptIndex !== undefined && !validTypeScriptIndexStatus(state.typescriptIndex)) {
    return null;
  }
  return state as WatchServiceState;
}

// scip-query: ignore-wrapper — reviewed W1 reused predicate; eleven validation sites share this timestamp rule.
export function isValidWatchServiceTimestamp(value: unknown): value is string {
  return isValidRecordTimestamp(value);
}

function validWatcherStatus(value: unknown): value is WatcherStatus {
  if (!value || typeof value !== 'object' || !('state' in value)) return false;
  const status = value as Partial<WatcherStatus>;
  switch (status.state) {
    case 'idle':
      return true;
    case 'waiting':
      return finiteNumber(status.changedFiles) && finiteNumber(status.reindexAt);
    case 'indexing':
      return finiteNumber(status.startedAt);
    case 'cooldown':
      return finiteNumber(status.until) && typeof status.dirty === 'boolean';
    case 'draining':
      return finiteNumber(status.startedAt) && typeof status.reason === 'string';
    default:
      return false;
  }
}

function validLastError(value: unknown): value is NonNullable<WatchServiceState['lastError']> {
  if (!value || typeof value !== 'object') return false;
  const error = value as Partial<NonNullable<WatchServiceState['lastError']>>;
  return isValidWatchServiceTimestamp(error.at) && typeof error.message === 'string';
}

function validLastRefresh(value: unknown): value is LastRefreshMetadata {
  if (!value || typeof value !== 'object') return false;
  const refresh = value as Partial<LastRefreshMetadata>;
  return (
    typeof refresh.trigger?.kind === 'string' &&
    typeof refresh.result === 'string' &&
    isValidWatchServiceTimestamp(refresh.startedAt) &&
    isValidWatchServiceTimestamp(refresh.completedAt) &&
    finiteNumber(refresh.durationMs)
  );
}

function validReindexActivitySummary(value: unknown): value is ReindexActivitySummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<ReindexActivitySummary>;
  if (
    !isValidWatchServiceTimestamp(summary.windowStartedAt) ||
    !isValidWatchServiceTimestamp(summary.windowEndedAt) ||
    !nonNegativeInteger(summary.runs) ||
    !nonNegativeInteger(summary.rebuilt) ||
    !nonNegativeInteger(summary.reused) ||
    !nonNegativeInteger(summary.failed) ||
    !nonNegativeInteger(summary.suppressed) ||
    !finiteNumber(summary.estimatedLogicalOutputBytes) ||
    summary.estimatedLogicalOutputBytes! < 0 ||
    !summary.byTrigger ||
    typeof summary.byTrigger !== 'object'
  ) {
    return false;
  }
  return Object.values(summary.byTrigger).every((count) => count === undefined || nonNegativeInteger(count));
}

function validWatchRefreshRequestStatus(value: unknown): value is WatchRefreshRequestStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<WatchRefreshRequestStatusSnapshot>;
  return (
    nonNegativeInteger(status.pending) &&
    nonNegativeInteger(status.claimed) &&
    nonNegativeInteger(status.completed) &&
    nonNegativeInteger(status.expired) &&
    nonNegativeInteger(status.invalid) &&
    (status.oldestPendingAt === undefined || isValidWatchServiceTimestamp(status.oldestPendingAt))
  );
}

function validTypeScriptSemanticStatus(value: unknown): value is TypeScriptSemanticServiceStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<TypeScriptSemanticServiceStatusSnapshot>;
  return (
    typeof status.protocolVersion === 'number' &&
    (status.state === 'idle' ||
      status.state === 'ready' ||
      status.state === 'unavailable' ||
      status.state === 'error') &&
    finiteNumber(status.requests) &&
    finiteNumber(status.sessionsCreated) &&
    finiteNumber(status.sessionsReused) &&
    finiteNumber(status.sessionsRefreshed) &&
    finiteNumber(status.sessionsReplaced) &&
    finiteNumber(status.projectsCreated) &&
    (status.lastRequestAt === undefined || isValidWatchServiceTimestamp(status.lastRequestAt)) &&
    (status.lastError === undefined || typeof status.lastError === 'string') &&
    (status.busyUntil === undefined || isValidWatchServiceTimestamp(status.busyUntil)) &&
    (status.mailbox === undefined || validBoundedMailboxStatus(status.mailbox))
  );
}

function validTypeScriptIndexStatus(value: unknown): value is TypeScriptIndexServiceStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<TypeScriptIndexServiceStatusSnapshot>;
  return (
    typeof status.protocolVersion === 'number' &&
    (status.state === 'idle' ||
      status.state === 'ready' ||
      status.state === 'unavailable' ||
      status.state === 'error') &&
    nonNegativeInteger(status.requests) &&
    nonNegativeInteger(status.sessionsCreated) &&
    nonNegativeInteger(status.sessionsReplaced) &&
    nonNegativeInteger(status.initializations) &&
    nonNegativeInteger(status.programUpdates) &&
    nonNegativeInteger(status.documentsEmitted) &&
    nonNegativeInteger(status.documentsRemoved) &&
    (status.lastRequestAt === undefined || isValidWatchServiceTimestamp(status.lastRequestAt)) &&
    (status.lastDurationMs === undefined || (finiteNumber(status.lastDurationMs) && status.lastDurationMs >= 0)) &&
    (status.lastError === undefined || typeof status.lastError === 'string') &&
    (status.busyUntil === undefined || isValidWatchServiceTimestamp(status.busyUntil)) &&
    (status.mailbox === undefined || validBoundedMailboxStatus(status.mailbox))
  );
}

function validBoundedMailboxStatus(value: unknown): value is BoundedMailboxStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<BoundedMailboxStatusSnapshot>;
  return (
    nonNegativeInteger(status.pending) &&
    nonNegativeInteger(status.inflight) &&
    nonNegativeInteger(status.responses) &&
    nonNegativeInteger(status.deadLetters) &&
    nonNegativeInteger(status.invalid) &&
    nonNegativeInteger(status.totalItems) &&
    finiteNumber(status.totalBytes) &&
    status.totalBytes! >= 0 &&
    status.totalItems === status.pending! + status.inflight! + status.responses! + status.deadLetters! &&
    (status.oldestPendingAt === undefined || isValidWatchServiceTimestamp(status.oldestPendingAt))
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
