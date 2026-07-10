import type { LastRefreshMetadata, WatcherStatus } from '../domain/types.js';

export const WATCH_SERVICE_PROTOCOL_VERSION = 1;
export const WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS = 5_000;
export const DEFAULT_WATCH_SERVICE_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface WatchServiceState {
  version: 1;
  protocolVersion: typeof WATCH_SERVICE_PROTOCOL_VERSION;
  pid: number;
  projectRoot: string;
  cliVersion: string;
  startedAt: string;
  heartbeatAt: string;
  lastActivityAt: string;
  idleDeadlineAt?: string;
  watcher: WatcherStatus;
  lastRefresh?: LastRefreshMetadata;
  lastError?: { at: string; message: string };
}

export interface WatchServiceIdentity {
  projectRoot: string;
  cliVersion: string;
}

export type WatchServiceClassification =
  | { kind: 'stopped' }
  | { kind: 'live'; state: WatchServiceState }
  | { kind: 'stale'; state: WatchServiceState; reason: 'dead-process' | 'old-heartbeat' }
  | { kind: 'incompatible'; state: WatchServiceState; reason: 'protocol' | 'project' | 'cli-version' };

export type WatchServiceRequest = 'ensure' | 'status' | 'stop';

export type WatchServiceAction =
  | { kind: 'start' }
  | { kind: 'reuse'; state: WatchServiceState }
  | { kind: 'replace'; state: WatchServiceState }
  | { kind: 'signal-stop'; state: WatchServiceState }
  | { kind: 'clean-stale'; state: WatchServiceState }
  | { kind: 'report'; classification: WatchServiceClassification }
  | { kind: 'already-stopped' };

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
    typeof state.cliVersion !== 'string' ||
    !validTimestamp(state.startedAt) ||
    !validTimestamp(state.heartbeatAt) ||
    !validTimestamp(state.lastActivityAt) ||
    !validWatcherStatus(state.watcher)
  ) {
    return null;
  }
  if (state.idleDeadlineAt !== undefined && !validTimestamp(state.idleDeadlineAt)) return null;
  if (state.lastError !== undefined && !validLastError(state.lastError)) return null;
  if (state.lastRefresh !== undefined && !validLastRefresh(state.lastRefresh)) return null;
  return state as WatchServiceState;
}

export function classifyWatchServiceState(
  state: WatchServiceState | null,
  identity: WatchServiceIdentity,
  nowMs: number,
  isProcessAlive: (pid: number) => boolean,
): WatchServiceClassification {
  if (!state) return { kind: 'stopped' };
  if (state.protocolVersion !== WATCH_SERVICE_PROTOCOL_VERSION) {
    return { kind: 'incompatible', state, reason: 'protocol' };
  }
  if (state.projectRoot !== identity.projectRoot) {
    return { kind: 'incompatible', state, reason: 'project' };
  }
  if (state.cliVersion !== identity.cliVersion) {
    return { kind: 'incompatible', state, reason: 'cli-version' };
  }
  if (!isProcessAlive(state.pid)) return { kind: 'stale', state, reason: 'dead-process' };
  const heartbeatAtMs = Date.parse(state.heartbeatAt);
  if (nowMs - heartbeatAtMs > WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS) {
    return { kind: 'stale', state, reason: 'old-heartbeat' };
  }
  return { kind: 'live', state };
}

export function planWatchServiceAction(
  request: WatchServiceRequest,
  classification: WatchServiceClassification,
): WatchServiceAction {
  switch (request) {
    case 'status':
      return { kind: 'report', classification };
    case 'ensure':
      switch (classification.kind) {
        case 'stopped':
        case 'stale':
          return { kind: 'start' };
        case 'live':
          return { kind: 'reuse', state: classification.state };
        case 'incompatible':
          return { kind: 'replace', state: classification.state };
        default:
          return assertNever(classification);
      }
    case 'stop':
      switch (classification.kind) {
        case 'stopped':
          return { kind: 'already-stopped' };
        case 'stale':
          return { kind: 'clean-stale', state: classification.state };
        case 'live':
        case 'incompatible':
          return { kind: 'signal-stop', state: classification.state };
        default:
          return assertNever(classification);
      }
    default:
      return assertNever(request);
  }
}

export function shouldStopWatchServiceForIdle(opts: {
  watcher: WatcherStatus;
  lastActivityAtMs: number;
  nowMs: number;
  idleTimeoutMs: number;
}): boolean {
  if (opts.idleTimeoutMs === 0 || opts.watcher.state !== 'idle') return false;
  return opts.nowMs - opts.lastActivityAtMs >= opts.idleTimeoutMs;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
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
    default:
      return false;
  }
}

function validLastError(value: unknown): value is NonNullable<WatchServiceState['lastError']> {
  if (!value || typeof value !== 'object') return false;
  const error = value as Partial<NonNullable<WatchServiceState['lastError']>>;
  return validTimestamp(error.at) && typeof error.message === 'string';
}

function validLastRefresh(value: unknown): value is LastRefreshMetadata {
  if (!value || typeof value !== 'object') return false;
  const refresh = value as Partial<LastRefreshMetadata>;
  return (
    typeof refresh.trigger?.kind === 'string' &&
    typeof refresh.result === 'string' &&
    validTimestamp(refresh.startedAt) &&
    validTimestamp(refresh.completedAt) &&
    finiteNumber(refresh.durationMs)
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled watch service value: ${JSON.stringify(value)}`);
}
