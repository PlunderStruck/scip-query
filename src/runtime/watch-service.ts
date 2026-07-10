import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LastRefreshMetadata, ProjectConfig, WatchConfig, WatcherStatus } from '../domain/types.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import type { TypeScriptSemanticServiceStatus } from '../semantic/typescript/session-protocol.js';
import type { TypeScriptIndexServiceStatus } from '../reindex/typescript-index-protocol.js';
import { isProcessAlive } from './process-liveness.js';

export const WATCH_SERVICE_PROTOCOL_VERSION = 3;
export const WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS = 5_000;
export const WATCH_LOCK_FILE = 'watch.lock';
export const WATCH_STATE_FILE = 'watch-state.json';
export const WATCH_ACTIVITY_FILE = 'watch-activity.json';
const WATCH_SERVICE_STARTUP_TIMEOUT_MS = 5_000;
const WATCH_SERVICE_STOP_TIMEOUT_MS = 2_000;
const WATCH_SERVICE_POLL_INTERVAL_MS = 10;
const AUTO_START_EXCLUDED_COMMANDS = new Set([
  'bench',
  'config-validate',
  'hook-context',
  'hook-stop',
  'init',
  'reindex',
  'setup',
  'setup-agent',
  'setup-ci',
  'setup-hooks',
  'uninstall',
  'watch',
  'work-audit',
]);

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
  typescriptSemantic?: TypeScriptSemanticServiceStatus;
  typescriptIndex?: TypeScriptIndexServiceStatus;
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

export interface WatchServicePaths {
  lockPath: string;
  statePath: string;
  activityPath: string;
}

export interface WatchServiceActivity {
  atMs: number;
  refreshRequestedAtMs?: number;
  refreshDetail?: string;
}

export interface WatchProcessLockMetadata {
  version: 1;
  pid: number;
  projectRoot: string;
  startedAt: string;
}

export interface WatchProcessLockResult {
  acquired: boolean;
  lockPath: string;
  message: string;
  release: () => void;
}

export interface WatchServiceRuntime {
  now(): number;
  isProcessAlive(pid: number): boolean;
  spawnServer(
    serverPath: string,
    projectRoot: string,
    cliVersion: string,
    watchOverrides: WatchServiceWatchOverrides,
  ): void;
  signalProcess(pid: number): void;
  sleep(durationMs: number): void;
}

export interface WatchServiceControllerOptions {
  projectRoot: string;
  cacheDir: string;
  cliVersion: string;
  serverPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  watchOverrides?: WatchServiceWatchOverrides;
  runtime?: WatchServiceRuntime;
}

export type WatchServiceWatchOverrides = Pick<WatchConfig, 'debounceMs' | 'cooldownMs' | 'gitPollMs' | 'idleTimeoutMs'>;

export interface WatchServiceInspection {
  classification: WatchServiceClassification;
  lock: WatchProcessLockMetadata | null;
  lockIsLive: boolean;
  paths: WatchServicePaths;
}

export interface WatchServiceEnsureResult {
  disposition: 'started' | 'reused';
  state: WatchServiceState;
}

export interface WatchServiceStopResult {
  disposition: 'stopped' | 'already-stopped';
  pid?: number;
}

export type WatchServiceAutoEnsureResult =
  | { kind: 'skipped'; reason: 'disabled' | 'excluded-command' | 'environment' }
  | { kind: 'started' | 'reused'; state: WatchServiceState }
  | { kind: 'failed'; message: string };

export function watchServiceAutoStartEligible(
  commandName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env['SCIP_QUERY_SKIP_WATCH_SERVICE'] !== '1' &&
    !commandName.startsWith('__') &&
    !AUTO_START_EXCLUDED_COMMANDS.has(commandName)
  );
}

export function ensureWatchServiceForCommand(opts: {
  commandName: string;
  projectRoot: string;
  cacheDir: string;
  cliVersion: string;
  config: ProjectConfig;
  env?: Record<string, string | undefined>;
  runtime?: WatchServiceRuntime;
}): WatchServiceAutoEnsureResult {
  const env = opts.env ?? process.env;
  if (env['SCIP_QUERY_SKIP_WATCH_SERVICE'] === '1') return { kind: 'skipped', reason: 'environment' };
  if (!watchServiceAutoStartEligible(opts.commandName, env)) return { kind: 'skipped', reason: 'excluded-command' };
  if (opts.config.watch?.enabled !== true) return { kind: 'skipped', reason: 'disabled' };
  try {
    const result = ensureWatchService({
      projectRoot: opts.projectRoot,
      cacheDir: opts.cacheDir,
      cliVersion: opts.cliVersion,
      runtime: opts.runtime,
    });
    return { kind: result.disposition, state: result.state };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

export function watchServicePaths(cacheDir: string): WatchServicePaths {
  return {
    lockPath: join(cacheDir, WATCH_LOCK_FILE),
    statePath: join(cacheDir, WATCH_STATE_FILE),
    activityPath: join(cacheDir, WATCH_ACTIVITY_FILE),
  };
}

export function inspectWatchService(opts: WatchServiceControllerOptions): WatchServiceInspection {
  const runtime = opts.runtime ?? DEFAULT_WATCH_SERVICE_RUNTIME;
  const paths = watchServicePaths(opts.cacheDir);
  const state = readWatchServiceState(paths.statePath);
  const lock = readWatchProcessLock(paths.lockPath);
  return {
    classification: classifyWatchServiceState(
      state,
      { projectRoot: resolve(opts.projectRoot), cliVersion: opts.cliVersion },
      runtime.now(),
      runtime.isProcessAlive,
    ),
    lock,
    lockIsLive: lock !== null && runtime.isProcessAlive(lock.pid),
    paths,
  };
}

export function ensureWatchService(opts: WatchServiceControllerOptions): WatchServiceEnsureResult {
  const runtime = opts.runtime ?? DEFAULT_WATCH_SERVICE_RUNTIME;
  let inspection = inspectWatchService(opts);
  let action = planWatchServiceAction('ensure', inspection.classification);

  if (action.kind === 'reuse') {
    recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
    return { disposition: 'reused', state: action.state };
  }
  if (action.kind === 'replace') {
    stopLiveWatchProcess(action.state.pid, opts, runtime);
    cleanupWatchServiceFiles(inspection.paths, action.state.pid, runtime);
  } else if (action.kind === 'start') {
    if (inspection.lockIsLive) {
      const concurrent = waitForWatchServiceState(opts, runtime, Math.min(opts.startupTimeoutMs ?? 1_000, 1_000));
      if (concurrent) {
        recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
        return { disposition: 'reused', state: concurrent };
      }
      throw new Error(
        `scip-query watch is already running for ${resolve(opts.projectRoot)} (pid ${inspection.lock?.pid}; lock: ${inspection.paths.lockPath}) without compatible daemon state. Stop the foreground watcher before starting the service.`,
      );
    }
    if (inspection.classification.kind === 'stale') {
      cleanupWatchServiceFiles(inspection.paths, inspection.classification.state.pid, runtime);
    }
  } else {
    throw new Error(`Unexpected ensure action: ${action.kind}`);
  }

  inspection = inspectWatchService(opts);
  action = planWatchServiceAction('ensure', inspection.classification);
  if (action.kind === 'reuse') {
    recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
    return { disposition: 'reused', state: action.state };
  }

  const serverPath = opts.serverPath ?? fileURLToPath(new URL('./watch-server.js', import.meta.url));
  runtime.spawnServer(serverPath, resolve(opts.projectRoot), opts.cliVersion, opts.watchOverrides ?? {});
  const state = waitForWatchServiceState(opts, runtime, opts.startupTimeoutMs ?? WATCH_SERVICE_STARTUP_TIMEOUT_MS);
  if (!state) {
    throw new Error(
      `scip-query watch service did not become ready within ${opts.startupTimeoutMs ?? WATCH_SERVICE_STARTUP_TIMEOUT_MS}ms.`,
    );
  }
  recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
  return { disposition: 'started', state };
}

export function stopWatchService(opts: WatchServiceControllerOptions): WatchServiceStopResult {
  const runtime = opts.runtime ?? DEFAULT_WATCH_SERVICE_RUNTIME;
  const inspection = inspectWatchService(opts);
  const action = planWatchServiceAction('stop', inspection.classification);
  if (action.kind === 'signal-stop') {
    stopLiveWatchProcess(action.state.pid, opts, runtime);
    cleanupWatchServiceFiles(inspection.paths, action.state.pid, runtime);
    return { disposition: 'stopped', pid: action.state.pid };
  }
  if (action.kind === 'clean-stale') {
    cleanupWatchServiceFiles(inspection.paths, action.state.pid, runtime);
    return { disposition: 'stopped', pid: action.state.pid };
  }
  if (action.kind === 'already-stopped' && inspection.lockIsLive && inspection.lock) {
    stopLiveWatchProcess(inspection.lock.pid, opts, runtime);
    cleanupWatchServiceFiles(inspection.paths, inspection.lock.pid, runtime);
    return { disposition: 'stopped', pid: inspection.lock.pid };
  }
  return { disposition: 'already-stopped' };
}

export function readWatchServiceState(statePath: string): WatchServiceState | null {
  try {
    return parseWatchServiceState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return null;
  }
}

export function writeWatchServiceState(statePath: string, state: WatchServiceState): void {
  writeJsonAtomic(statePath, state);
}

export function recordWatchServiceActivity(activityPath: string, nowMs = Date.now()): void {
  const current = readWatchServiceActivity(activityPath);
  writeJsonAtomic(activityPath, {
    version: 1,
    at: new Date(nowMs).toISOString(),
    ...(current?.refreshRequestedAtMs === undefined
      ? {}
      : {
          refreshRequestedAt: new Date(current.refreshRequestedAtMs).toISOString(),
          ...(current.refreshDetail ? { refreshDetail: current.refreshDetail } : {}),
        }),
  });
}

export function readWatchServiceActivityAt(activityPath: string): number | null {
  return readWatchServiceActivity(activityPath)?.atMs ?? null;
}

export function requestWatchServiceRefresh(activityPath: string, detail: string, nowMs = Date.now()): void {
  writeJsonAtomic(activityPath, {
    version: 1,
    at: new Date(nowMs).toISOString(),
    refreshRequestedAt: new Date(nowMs).toISOString(),
    refreshDetail: detail,
  });
}

export function readWatchServiceActivity(activityPath: string): WatchServiceActivity | null {
  try {
    const parsed = JSON.parse(readFileSync(activityPath, 'utf8')) as {
      version?: unknown;
      at?: unknown;
      refreshRequestedAt?: unknown;
      refreshDetail?: unknown;
    };
    if (parsed.version !== 1 || !validTimestamp(parsed.at)) return null;
    if (parsed.refreshRequestedAt !== undefined && !validTimestamp(parsed.refreshRequestedAt)) return null;
    if (parsed.refreshDetail !== undefined && typeof parsed.refreshDetail !== 'string') return null;
    return {
      atMs: Date.parse(parsed.at),
      ...(parsed.refreshRequestedAt === undefined
        ? {}
        : { refreshRequestedAtMs: Date.parse(parsed.refreshRequestedAt) }),
      ...(parsed.refreshDetail === undefined ? {} : { refreshDetail: parsed.refreshDetail }),
    };
  } catch {
    return null;
  }
}

export function acquireWatchProcessLock(
  lockPath: string,
  projectRoot: string,
  opts: { pid?: number; now?: () => Date; isProcessAlive?: (pid: number) => boolean } = {},
): WatchProcessLockResult {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isProcessAlive ?? isProcessAlive;
  const releaseNoop = (): void => undefined;
  const existing = readWatchProcessLock(lockPath);
  if (existing && isAlive(existing.pid)) {
    return {
      acquired: false,
      lockPath,
      message: runningWatchMessage(lockPath, projectRoot, existing),
      release: releaseNoop,
    };
  }
  if (existing) rmSync(lockPath, { force: true });
  mkdirSync(dirname(lockPath), { recursive: true });

  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') {
      return {
        acquired: false,
        lockPath,
        message: runningWatchMessage(lockPath, projectRoot, readWatchProcessLock(lockPath)),
        release: releaseNoop,
      };
    }
    throw error;
  }

  const metadata: WatchProcessLockMetadata = {
    version: 1,
    pid,
    projectRoot: resolve(projectRoot),
    startedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  writeFileSync(fd, `${JSON.stringify(metadata)}\n`);

  let released = false;
  return {
    acquired: true,
    lockPath,
    message: '',
    release: () => {
      if (released) return;
      released = true;
      closeSync(fd);
      const current = readWatchProcessLock(lockPath);
      if (current?.pid === metadata.pid && current.startedAt === metadata.startedAt) {
        rmSync(lockPath, { force: true });
      }
    },
  };
}

export function readWatchProcessLock(lockPath: string): WatchProcessLockMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<WatchProcessLockMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.projectRoot !== 'string' ||
      !validTimestamp(parsed.startedAt)
    ) {
      return null;
    }
    return parsed as WatchProcessLockMetadata;
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
  if (state.typescriptSemantic !== undefined && !validTypeScriptSemanticStatus(state.typescriptSemantic)) return null;
  if (state.typescriptIndex !== undefined && !validTypeScriptIndexStatus(state.typescriptIndex)) return null;
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
          return { kind: 'start' };
        case 'stale':
          return classification.reason === 'old-heartbeat'
            ? { kind: 'replace', state: classification.state }
            : { kind: 'start' };
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
          return classification.reason === 'old-heartbeat'
            ? { kind: 'signal-stop', state: classification.state }
            : { kind: 'clean-stale', state: classification.state };
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

function waitForWatchServiceState(
  opts: WatchServiceControllerOptions,
  runtime: WatchServiceRuntime,
  timeoutMs: number,
): WatchServiceState | null {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    const classification = inspectWatchService(opts).classification;
    if (classification.kind === 'live') return classification.state;
    runtime.sleep(WATCH_SERVICE_POLL_INTERVAL_MS);
  }
  return null;
}

function stopLiveWatchProcess(pid: number, opts: WatchServiceControllerOptions, runtime: WatchServiceRuntime): void {
  if (!runtime.isProcessAlive(pid)) return;
  runtime.signalProcess(pid);
  const timeoutMs = opts.stopTimeoutMs ?? WATCH_SERVICE_STOP_TIMEOUT_MS;
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    if (!runtime.isProcessAlive(pid)) return;
    runtime.sleep(WATCH_SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error(`scip-query watch service pid ${pid} did not stop within ${timeoutMs}ms.`);
}

function cleanupWatchServiceFiles(paths: WatchServicePaths, expectedPid: number, runtime: WatchServiceRuntime): void {
  rmSync(paths.statePath, { force: true });
  rmSync(paths.activityPath, { force: true });
  const lock = readWatchProcessLock(paths.lockPath);
  if (lock?.pid === expectedPid && !runtime.isProcessAlive(expectedPid)) {
    rmSync(paths.lockPath, { force: true });
  }
}

function runningWatchMessage(lockPath: string, projectRoot: string, existing: WatchProcessLockMetadata | null): string {
  return `error: scip-query watch is already running for ${resolve(projectRoot)}${
    existing ? ` (pid ${existing.pid}, started ${existing.startedAt}; lock: ${lockPath})` : ` (lock: ${lockPath})`
  }. Stop that watcher before starting another.`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined;
}

const DEFAULT_WATCH_SERVICE_RUNTIME: WatchServiceRuntime = {
  now: Date.now,
  isProcessAlive,
  spawnServer(serverPath, projectRoot, cliVersion, watchOverrides) {
    if (!existsSync(serverPath)) {
      throw new Error(`Watch service helper was not found at ${serverPath}. Run npm run build first.`);
    }
    const child = spawn(process.execPath, [serverPath, projectRoot, cliVersion, JSON.stringify(watchOverrides)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SCIP_QUERY_SKIP_WATCH_SERVICE: '1' },
    });
    child.unref();
  },
  signalProcess(pid) {
    process.kill(pid, 'SIGTERM');
  },
  sleep(durationMs) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, durationMs);
  },
};

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

function validTypeScriptSemanticStatus(value: unknown): value is TypeScriptSemanticServiceStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<TypeScriptSemanticServiceStatus>;
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
    (status.lastRequestAt === undefined || validTimestamp(status.lastRequestAt)) &&
    (status.lastError === undefined || typeof status.lastError === 'string') &&
    (status.busyUntil === undefined || validTimestamp(status.busyUntil))
  );
}

function validTypeScriptIndexStatus(value: unknown): value is TypeScriptIndexServiceStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<TypeScriptIndexServiceStatus>;
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
    (status.lastRequestAt === undefined || validTimestamp(status.lastRequestAt)) &&
    (status.lastDurationMs === undefined || (finiteNumber(status.lastDurationMs) && status.lastDurationMs >= 0)) &&
    (status.lastError === undefined || typeof status.lastError === 'string') &&
    (status.busyUntil === undefined || validTimestamp(status.busyUntil))
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled watch service value: ${JSON.stringify(value)}`);
}
