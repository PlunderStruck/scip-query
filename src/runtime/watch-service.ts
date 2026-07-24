import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig, WatchConfig, WatcherStatus } from '../domain/types.js';
import { canonicalPath, resolveGitWorktreeIdentity, type GitWorktreeContext } from '../platform/git-worktree.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import {
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  WATCH_SERVICE_PROTOCOL_VERSION,
  isValidWatchServiceTimestamp,
  readWatchServiceState,
  watchServicePaths,
  type WatchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';

export {
  WATCH_ACTIVITY_FILE,
  WATCH_LOCK_FILE,
  WATCH_SERVICE_MAX_HEARTBEAT_AGE_MS,
  WATCH_SERVICE_PROTOCOL_VERSION,
  WATCH_STATE_FILE,
  parseWatchServiceState,
  readWatchServiceState,
  watchServicePaths,
  type WatchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';

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
  gitContext?: GitWorktreeContext;
  serverPath?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  watchOverrides?: WatchServiceWatchOverrides;
  runtime?: WatchServiceRuntime;
}

export type WatchServiceWatchOverrides = Pick<WatchConfig, 'debounceMs' | 'cooldownMs' | 'gitPollMs' | 'idleTimeoutMs'>;

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
    recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
    return { disposition: 'reused', state: action.state };
  }
  if (action.kind === 'replace') {
    stopLiveWatchProcess(action.state.pid, opts, runtime);
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

  inspection = inspectWatchServiceWithIdentity(opts, identity);
  action = planWatchServiceAction('ensure', inspection.classification);
  if (action.kind === 'reuse') {
    recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
    return { disposition: 'reused', state: action.state };
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
  recordWatchServiceActivity(inspection.paths.activityPath, runtime.now());
  return { disposition: 'started', state };
}

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
    stopLiveWatchProcess(action.state.pid, opts, runtime);
    cleanupWatchServiceFiles(paths, action.state.pid, runtime);
    return { disposition: 'stopped', pid: action.state.pid };
  }
  if (action.kind === 'clean-stale') {
    cleanupWatchServiceFiles(paths, action.state.pid, runtime);
    return { disposition: 'stopped', pid: action.state.pid };
  }
  const lock = readWatchProcessLock(paths.lockPath);
  if (action.kind === 'already-stopped' && lock && runtime.isProcessAlive(lock.pid)) {
    stopLiveWatchProcess(lock.pid, opts, runtime);
    cleanupWatchServiceFiles(paths, lock.pid, runtime);
    return { disposition: 'stopped', pid: lock.pid };
  }
  return { disposition: 'already-stopped' };
}

// scip-query: ignore-passthrough — protocol writer keeps watch-state callers
// on the validated service contract instead of its JSON storage mechanism.
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
      !isValidWatchServiceTimestamp(parsed.startedAt)
    ) {
      return null;
    }
    return parsed as WatchProcessLockMetadata;
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
  identity: WatchServiceIdentity,
  runtime: WatchServiceRuntime,
  timeoutMs: number,
): WatchServiceState | null {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() <= deadline) {
    const classification = inspectWatchServiceWithIdentity(opts, identity).classification;
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

function assertNever(value: never): never {
  throw new Error(`Unhandled watch service value: ${JSON.stringify(value)}`);
}
