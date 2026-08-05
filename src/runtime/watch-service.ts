import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monotonicNowMs } from '../domain/time.js';
import type { ProjectConfig, WatchConfig, WatcherStatus } from '../domain/types.js';
import { canonicalPath, resolveGitWorktreeIdentity, type GitWorktreeContext } from '../platform/git-worktree.js';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import {
  NODE_PROCESS_FILE_LOCK_RUNTIME,
  readProcessFileLock,
  reclaimProcessFileLock,
  tryAcquireProcessFileLock,
  type LegacyProcessLockDecoder,
  type ProcessFileLockObservation,
} from '../platform/process-file-lock.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import {
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  WATCH_SERVICE_PROTOCOL_VERSION,
  isValidWatchServiceTimestamp,
  readWatchServiceState,
  watchServicePaths,
  type WatchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';
import { writeJsonAtomic, writeJsonDurable, type AtomicJsonWriteOptions } from '../storage/atomic-json.js';
import {
  enqueueWatchRefreshRequest,
  type EnqueueWatchRefreshRequestOptions,
} from '../storage/watch-refresh-requests.js';

export {
  WATCH_ACTIVITY_FILE,
  WATCH_LOCK_FILE,
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  WATCH_SERVICE_PROTOCOL_VERSION,
  WATCH_REFRESH_REQUESTS_DIRECTORY,
  WATCH_STATE_FILE,
  parseWatchServiceState,
  readWatchServiceState,
  watchServicePaths,
  type WatchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';

const WATCH_SERVICE_STARTUP_TIMEOUT_MS = 5_000;
const WATCH_SERVICE_STOP_TIMEOUT_MS = 6_000;
const WATCH_SERVICE_FORCE_STOP_TIMEOUT_MS = 1_000;
const WATCH_SERVICE_POLL_INTERVAL_MS = 10;
const AUTO_START_EXCLUDED_COMMANDS = new Set([
  'capabilities',
  'check-deps',
  'config-validate',
  'doctor',
  'init',
  'install-skills',
  'reindex',
  'setup',
  'setup-agent',
  'status',
  'suppress',
  'uninstall',
  'watch',
]);

export type WatchServiceIdentity =
  | { projectRoot: string; worktreeKind: 'git'; worktreeId: string; cliVersion: string }
  | { projectRoot: string; worktreeKind: 'non-git'; worktreeId?: undefined; cliVersion: string };

export type WatchServiceClassification =
  | { kind: 'stopped' }
  | { kind: 'live'; state: WatchServiceState }
  | { kind: 'stale'; state: WatchServiceState; reason: 'dead-process' | 'old-heartbeat' }
  | {
      kind: 'incompatible';
      state: WatchServiceState;
      reason: 'protocol' | 'project' | 'worktree' | 'cli-version';
    };

export type WatchServiceRequest = 'ensure' | 'status' | 'stop';

export type WatchServiceAction =
  | { kind: 'start' }
  | { kind: 'reuse'; state: WatchServiceState }
  | { kind: 'replace'; state: WatchServiceState }
  | { kind: 'signal-stop'; state: WatchServiceState }
  | { kind: 'clean-stale'; state: WatchServiceState }
  | { kind: 'refuse-replace'; state: WatchServiceState; reason: 'old-heartbeat' }
  | { kind: 'report'; classification: WatchServiceClassification }
  | { kind: 'already-stopped' };

export interface WatchServiceActivity {
  atMs: number;
  refreshRequestedAtMs?: number;
  refreshDetail?: string;
}

export interface WatchProcessLockMetadata {
  version: 1;
  pid: number;
  /** Absent only on legacy/unverifiable records, which cannot authorize a signal. */
  processIdentity?: ProcessIdentity;
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
  /** Civil time for persisted activity and heartbeat diagnostics. */
  now(): number;
  /** Process-local elapsed clock; defaults to performance.now(). */
  monotonicNow?(): number;
  isProcessAlive(pid: number): boolean;
  readProcessIdentity(pid: number): ProcessIdentity | null;
  recordActivity?(activityPath: string, nowMs: number): void;
  spawnServer(
    serverPath: string,
    projectRoot: string,
    cliVersion: string,
    watchOverrides: WatchServiceWatchOverrides,
  ): void;
  signalProcess(pid: number): void;
  forceSignalProcess?(pid: number): void;
  sleep(durationMs: number): void;
}

export interface WatchServiceControllerOptions {
  projectRoot: string;
  cacheDir: string;
  cliVersion: string;
  gitContext?: GitWorktreeContext;
  serverPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  watchOverrides?: WatchServiceWatchOverrides;
  runtime?: WatchServiceRuntime;
}

export type WatchServiceWatchOverrides = Pick<WatchConfig, 'debounceMs' | 'cooldownMs' | 'gitPollMs' | 'idleTimeoutMs'>;

// scip-query: ignore-stale — reviewed S1 owned contract; watch inspection returns this complete service snapshot.
export interface WatchServiceInspection {
  identity: WatchServiceIdentity;
  classification: WatchServiceClassification;
  lock: WatchProcessLockMetadata | null;
  lockIsLive: boolean;
  paths: WatchServicePaths;
}

export function trustedWatchServiceIndexGeneration(inspection: WatchServiceInspection): string | undefined {
  const classification = inspection.classification;
  if (classification.kind !== 'live') return undefined;
  const { state } = classification;
  return state.watcher.state === 'idle' && state.lastError === undefined ? state.indexGeneration : undefined;
}

// scip-query: ignore-stale — reviewed S1 owned contract; service startup returns this named lifecycle result.
export interface WatchServiceEnsureResult {
  disposition: 'started' | 'reused';
  state: WatchServiceState;
}

// scip-query: ignore-stale -- Discriminated stop result enforces when a process id may be present.
export type WatchServiceStopResult =
  | { disposition: 'stopped'; pid: number }
  | { disposition: 'already-stopped'; pid?: never };

// scip-query: ignore-stale — reviewed S1 owned contract; this union makes automatic-start outcomes explicit.
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
  gitContext?: GitWorktreeContext;
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
      gitContext: opts.gitContext,
      runtime: opts.runtime,
    });
    return { kind: result.disposition, state: result.state };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveWatchServiceIdentity(
  projectRootInput: string,
  cliVersion: string,
  gitContext?: GitWorktreeContext,
): WatchServiceIdentity {
  const projectRoot = canonicalPath(resolve(projectRootInput));
  if (gitContext && canonicalPath(gitContext.projectRoot) === projectRoot) {
    return { projectRoot, worktreeKind: 'git', worktreeId: gitContext.worktreeId, cliVersion };
  }
  const resolution = resolveGitWorktreeIdentity(projectRoot);
  if (resolution.kind === 'error') {
    throw new Error(`Could not establish Git worktree identity for ${projectRoot}: ${resolution.message}`);
  }
  if (resolution.kind === 'non-git') {
    return { projectRoot, worktreeKind: 'non-git', cliVersion };
  }
  return {
    projectRoot,
    worktreeKind: 'git',
    worktreeId: resolution.identity.worktreeId,
    cliVersion,
  };
}

export function inspectWatchService(opts: WatchServiceControllerOptions): WatchServiceInspection {
  return inspectWatchServiceWithIdentity(
    opts,
    resolveWatchServiceIdentity(opts.projectRoot, opts.cliVersion, opts.gitContext),
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function inspectWatchServiceWithIdentity(
  opts: WatchServiceControllerOptions,
  identity: WatchServiceIdentity,
): WatchServiceInspection {
  const runtime = opts.runtime ?? DEFAULT_WATCH_SERVICE_RUNTIME;
  const paths = watchServicePaths(opts.cacheDir);
  const state = readWatchServiceState(paths.statePath);
  const lock = readWatchProcessLock(paths.lockPath);
  return {
    identity,
    classification: classifyWatchServiceState(state, identity, runtime.now(), runtime.isProcessAlive),
    lock,
    lockIsLive: lock !== null && runtime.isProcessAlive(lock.pid),
    paths,
  };
}

// scip-query: ignore-similar — starting and stopping share inspection but have opposite transitions.
export function ensureWatchService(opts: WatchServiceControllerOptions): WatchServiceEnsureResult {
  const runtime = opts.runtime ?? DEFAULT_WATCH_SERVICE_RUNTIME;
  const identity = resolveWatchServiceIdentity(opts.projectRoot, opts.cliVersion, opts.gitContext);
  let inspection = inspectWatchServiceWithIdentity(opts, identity);
  let action = planWatchServiceAction('ensure', inspection.classification);

  if (action.kind === 'reuse') {
    recordWatchServiceActivityBestEffort(inspection.paths.activityPath, runtime);
    return { disposition: 'reused', state: action.state };
  }
  if (action.kind === 'refuse-replace') {
    throw new Error(
      `scip-query watch service pid ${action.state.pid} is still alive but its heartbeat is old. ` +
        'Refusing automatic replacement because civil-clock age alone cannot authorize a process signal.',
    );
  }
  if (action.kind === 'replace') {
    stopLiveWatchProcess(action.state, opts, runtime);
    cleanupWatchServiceFiles(inspection.paths, action.state.pid, runtime);
  } else if (action.kind === 'start') {
    if (inspection.lockIsLive) {
      const concurrent = waitForWatchServiceState(
        opts,
        identity,
        runtime,
        Math.min(opts.startupTimeoutMs ?? 1_000, 1_000),
      );
      if (concurrent) {
        recordWatchServiceActivityBestEffort(inspection.paths.activityPath, runtime);
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

  inspection = inspectWatchServiceWithIdentity(opts, identity);
  action = planWatchServiceAction('ensure', inspection.classification);
  if (action.kind === 'reuse') {
    recordWatchServiceActivityBestEffort(inspection.paths.activityPath, runtime);
    return { disposition: 'reused', state: action.state };
  }
  if (action.kind === 'refuse-replace') {
    throw new Error(
      `scip-query watch service pid ${action.state.pid} remains alive with an old heartbeat; ` +
        'automatic replacement is not authorized.',
    );
  }

  const serverPath = opts.serverPath ?? fileURLToPath(new URL('./watch-server.js', import.meta.url));
  runtime.spawnServer(serverPath, identity.projectRoot, opts.cliVersion, opts.watchOverrides ?? {});
  const state = waitForWatchServiceState(
    opts,
    identity,
    runtime,
    opts.startupTimeoutMs ?? WATCH_SERVICE_STARTUP_TIMEOUT_MS,
  );
  if (!state) {
    throw new Error(
      `scip-query watch service did not become ready within ${opts.startupTimeoutMs ?? WATCH_SERVICE_STARTUP_TIMEOUT_MS}ms.`,
    );
  }
  recordWatchServiceActivityBestEffort(inspection.paths.activityPath, runtime);
  return { disposition: 'started', state };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function stopWatchService(opts: WatchServiceControllerOptions): WatchServiceStopResult {
  const runtime = opts.runtime ?? DEFAULT_WATCH_SERVICE_RUNTIME;
  const paths = watchServicePaths(opts.cacheDir);
  const state = readWatchServiceState(paths.statePath);
  const classification: WatchServiceClassification = !state
    ? { kind: 'stopped' }
    : runtime.isProcessAlive(state.pid)
      ? { kind: 'live', state }
      : { kind: 'stale', state, reason: 'dead-process' };
  const action = planWatchServiceAction('stop', classification);
  if (action.kind === 'signal-stop') {
    stopLiveWatchProcess(action.state, opts, runtime);
    cleanupWatchServiceFiles(paths, action.state.pid, runtime);
    return { disposition: 'stopped', pid: action.state.pid };
  }
  if (action.kind === 'clean-stale') {
    cleanupWatchServiceFiles(paths, action.state.pid, runtime);
    return { disposition: 'stopped', pid: action.state.pid };
  }
  const lock = readWatchProcessLock(paths.lockPath);
  if (action.kind === 'already-stopped' && lock && runtime.isProcessAlive(lock.pid)) {
    stopLiveWatchProcess(lock, opts, runtime);
    cleanupWatchServiceFiles(paths, lock.pid, runtime);
    return { disposition: 'stopped', pid: lock.pid };
  }
  return { disposition: 'already-stopped' };
}

// scip-query: ignore-passthrough — protocol writer keeps watch-state callers
// on the validated service contract instead of its JSON storage mechanism.
export function writeWatchServiceState(
  statePath: string,
  state: WatchServiceState,
  options: AtomicJsonWriteOptions & { durability?: 'durable' | 'visibility' } = {},
): void {
  const { durability = 'durable', ...writeOptions } = options;
  if (durability === 'durable') writeJsonDurable(statePath, state, writeOptions);
  else writeJsonAtomic(statePath, state, writeOptions);
}

export function recordWatchServiceActivity(activityPath: string, nowMs = Date.now()): void {
  writeJsonAtomic(activityPath, {
    version: 1,
    at: new Date(nowMs).toISOString(),
  });
}

export function readWatchServiceActivityAt(activityPath: string): number | null {
  return readWatchServiceActivity(activityPath)?.atMs ?? null;
}

export function requestWatchServiceRefresh(
  activityPath: string,
  detail: string,
  nowMs = Date.now(),
  options: Omit<EnqueueWatchRefreshRequestOptions, 'now'> = {},
): void {
  enqueueWatchRefreshRequest(watchServicePaths(dirname(activityPath)).refreshRequestsPath, detail, {
    ...options,
    now: () => new Date(nowMs),
  });
  recordWatchServiceActivity(activityPath, nowMs);
}

export function readWatchServiceActivity(activityPath: string): WatchServiceActivity | null {
  try {
    const parsed = JSON.parse(readSmallArtifactText(activityPath, 'watch activity record')) as {
      version?: unknown;
      at?: unknown;
      refreshRequestedAt?: unknown;
      refreshDetail?: unknown;
    };
    if (parsed.version !== 1 || !isValidWatchServiceTimestamp(parsed.at)) return null;
    if (parsed.refreshRequestedAt !== undefined && !isValidWatchServiceTimestamp(parsed.refreshRequestedAt)) {
      return null;
    }
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

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function acquireWatchProcessLock(
  lockPath: string,
  projectRoot: string,
  opts: {
    pid?: number;
    now?: () => Date;
    isProcessAlive?: (pid: number) => boolean;
    readProcessIdentity?: (pid: number) => ProcessIdentity | null;
  } = {},
): WatchProcessLockResult {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isProcessAlive ?? isProcessAlive;
  const releaseNoop = (): void => undefined;
  const readIdentity = opts.readProcessIdentity ?? readProcessIdentity;
  const now = opts.now ?? (() => new Date());
  const runtime = {
    ...NODE_PROCESS_FILE_LOCK_RUNTIME,
    wallNow: () => now().getTime(),
    isProcessAlive: isAlive,
    readProcessIdentity: readIdentity,
  };
  const acquired = tryAcquireProcessFileLock(lockPath, {
    kind: 'watch',
    pid,
    processIdentity: readIdentity(pid),
    detail: { projectRoot: resolve(projectRoot) },
    parseLegacy: parseLegacyWatchOwner,
    runtime,
  });
  if (acquired.kind === 'contended') {
    const existing = watchMetadataFromObservation(acquired.observation);
    return {
      acquired: false,
      lockPath,
      message: runningWatchMessage(lockPath, projectRoot, existing),
      release: releaseNoop,
    };
  }
  return {
    acquired: true,
    lockPath,
    message: '',
    release: () => void acquired.lock.release(),
  };
}

export function readWatchProcessLock(lockPath: string): WatchProcessLockMetadata | null {
  return watchMetadataFromObservation(readProcessFileLock(lockPath, { parseLegacy: parseLegacyWatchOwner }));
}

const parseLegacyWatchOwner: LegacyProcessLockDecoder = (value) => {
  const metadata = parseLegacyWatchMetadata(value);
  return metadata
    ? {
        pid: metadata.pid,
        ...(metadata.processIdentity ? { processIdentity: metadata.processIdentity } : {}),
      }
    : null;
};

function watchMetadataFromObservation(observation: ProcessFileLockObservation): WatchProcessLockMetadata | null {
  if (observation.state === 'valid' && observation.record?.kind === 'watch') {
    const projectRoot = observation.record.detail?.['projectRoot'];
    if (typeof projectRoot !== 'string') return null;
    return {
      version: 1,
      pid: observation.record.pid,
      ...(observation.record.processIdentity ? { processIdentity: observation.record.processIdentity } : {}),
      projectRoot,
      startedAt: observation.record.startedAt,
    };
  }
  return parseLegacyWatchMetadata(observation.parsed);
}

function parseLegacyWatchMetadata(value: unknown): WatchProcessLockMetadata | null {
  try {
    const parsed = value as Partial<WatchProcessLockMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.projectRoot !== 'string' ||
      !isValidWatchServiceTimestamp(parsed.startedAt)
    ) {
      return null;
    }
    const processIdentity = parsed.processIdentity === undefined ? null : parseProcessIdentity(parsed.processIdentity);
    if (parsed.processIdentity !== undefined && (!processIdentity || processIdentity.pid !== parsed.pid)) return null;
    return {
      version: 1,
      pid: parsed.pid,
      ...(processIdentity ? { processIdentity } : {}),
      projectRoot: parsed.projectRoot,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
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
  const expectedWorktreeId = identity.worktreeKind === 'git' ? identity.worktreeId : undefined;
  if (state.worktreeId !== expectedWorktreeId) {
    return { kind: 'incompatible', state, reason: 'worktree' };
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
            ? { kind: 'refuse-replace', state: classification.state, reason: 'old-heartbeat' }
            : { kind: 'start' };
        case 'live':
          // A live `draining` watcher still owns its subscriptions, child, and
          // lock. Reusing every live state prevents a second service from
          // overlapping shutdown before that ownership is released.
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
  identity: WatchServiceIdentity,
  runtime: WatchServiceRuntime,
  timeoutMs: number,
): WatchServiceState | null {
  const monotonicNow = runtime.monotonicNow ?? monotonicNowMs;
  const deadline = monotonicNow() + timeoutMs;
  while (monotonicNow() <= deadline) {
    const classification = inspectWatchServiceWithIdentity(opts, identity).classification;
    if (classification.kind === 'live') return classification.state;
    runtime.sleep(WATCH_SERVICE_POLL_INTERVAL_MS);
  }
  return null;
}

function stopLiveWatchProcess(
  owner: { pid: number; processIdentity?: ProcessIdentity },
  opts: WatchServiceControllerOptions,
  runtime: WatchServiceRuntime,
): void {
  const { pid } = owner;
  if (!runtime.isProcessAlive(pid)) return;
  assertSameProcessInstance(owner, runtime);
  runtime.signalProcess(pid);
  const timeoutMs = opts.stopTimeoutMs ?? WATCH_SERVICE_STOP_TIMEOUT_MS;
  const monotonicNow = runtime.monotonicNow ?? monotonicNowMs;
  const deadline = monotonicNow() + timeoutMs;
  while (monotonicNow() <= deadline) {
    if (!runtime.isProcessAlive(pid)) return;
    runtime.sleep(WATCH_SERVICE_POLL_INTERVAL_MS);
  }
  if (!runtime.forceSignalProcess) {
    throw new Error(
      `scip-query watch service pid ${pid} did not stop within ${timeoutMs}ms and forced termination is unavailable.`,
    );
  }
  assertSameProcessInstance(owner, runtime);
  runtime.forceSignalProcess(pid);
  const forceTimeoutMs = opts.forceStopTimeoutMs ?? WATCH_SERVICE_FORCE_STOP_TIMEOUT_MS;
  const forceDeadline = monotonicNow() + forceTimeoutMs;
  while (monotonicNow() <= forceDeadline) {
    if (!runtime.isProcessAlive(pid)) return;
    const actual = runtime.readProcessIdentity(pid);
    if (owner.processIdentity && actual && !sameProcessIdentity(owner.processIdentity, actual)) return;
    runtime.sleep(WATCH_SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error(`scip-query watch service pid ${pid} remained alive ${forceTimeoutMs}ms after forced termination.`);
}

function cleanupWatchServiceFiles(paths: WatchServicePaths, expectedPid: number, runtime: WatchServiceRuntime): void {
  rmSync(paths.statePath, { force: true });
  rmSync(paths.activityPath, { force: true });
  const lock = readWatchProcessLock(paths.lockPath);
  if (lock?.pid === expectedPid && !runtime.isProcessAlive(expectedPid)) {
    const lockRuntime = {
      ...NODE_PROCESS_FILE_LOCK_RUNTIME,
      wallNow: runtime.now,
      isProcessAlive: runtime.isProcessAlive,
      readProcessIdentity: runtime.readProcessIdentity,
    };
    const observation = readProcessFileLock(paths.lockPath, {
      parseLegacy: parseLegacyWatchOwner,
      runtime: lockRuntime,
    });
    reclaimProcessFileLock(paths.lockPath, observation, {
      parseLegacy: parseLegacyWatchOwner,
      runtime: lockRuntime,
    });
  }
}

function runningWatchMessage(lockPath: string, projectRoot: string, existing: WatchProcessLockMetadata | null): string {
  return `error: scip-query watch is already running for ${resolve(projectRoot)}${
    existing ? ` (pid ${existing.pid}, started ${existing.startedAt}; lock: ${lockPath})` : ` (lock: ${lockPath})`
  }. Stop that watcher before starting another.`;
}

function recordWatchServiceActivityBestEffort(activityPath: string, runtime: WatchServiceRuntime): void {
  try {
    (runtime.recordActivity ?? recordWatchServiceActivity)(activityPath, runtime.now());
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS') throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

const DEFAULT_WATCH_SERVICE_RUNTIME: WatchServiceRuntime = {
  now: Date.now,
  monotonicNow: monotonicNowMs,
  isProcessAlive,
  readProcessIdentity,
  spawnServer(serverPath, projectRoot, cliVersion, watchOverrides) {
    if (!existsSync(serverPath)) {
      throw new Error(`Watch service helper was not found at ${serverPath}. Run npm run build first.`);
    }
    // scip-query: process-lifetime-reviewed -- detached service lifetime is
    // owned by the persisted identity, heartbeat lease, and stop protocol.
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
  forceSignalProcess(pid) {
    process.kill(pid, 'SIGKILL');
  },
  sleep(durationMs) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, durationMs);
  },
};

function assertSameProcessInstance(
  owner: { pid: number; processIdentity?: ProcessIdentity },
  runtime: Pick<WatchServiceRuntime, 'readProcessIdentity'>,
): void {
  if (!owner.processIdentity) {
    throw new Error(
      `Refusing to signal scip-query watch pid ${owner.pid}: its ownership record has no process identity.`,
    );
  }
  const actual = runtime.readProcessIdentity(owner.pid);
  if (!actual) {
    throw new Error(`Refusing to signal scip-query watch pid ${owner.pid}: its process identity is unavailable.`);
  }
  if (!sameProcessIdentity(owner.processIdentity, actual)) {
    throw new Error(
      `Refusing to signal scip-query watch pid ${owner.pid}: its process identity does not match the ownership record.`,
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled watch service value: ${JSON.stringify(value)}`);
}
