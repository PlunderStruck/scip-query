import process from 'node:process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeTerminalLine } from '../platform/terminal-output.js';
import { boundedExponentialLoopDelayMs, monotonicNowMs } from '../domain/time.js';
import type { RefreshTrigger, WatcherStatus } from '../domain/types.js';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { resolveGitWorktreeIdentity } from '../platform/git-worktree.js';
import { createPathChangeWake } from '../platform/path-change-wake.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { captureWorktreeLivenessIdentity, worktreeLivenessIdentityIsCurrent } from '../platform/worktree-liveness.js';
import {
  WATCH_SERVICE_PROTOCOL_VERSION,
  watchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';
import { loadProjectConfig, resolveWatchConfig } from './config.js';
import { getIndexFreshness, getPublishedIndexFreshness, type IndexFreshnessState } from './index-freshness.js';
import { Watcher, type WatcherStopResult } from './watch.js';
import { typeScriptSemanticMailboxPaths } from '../semantic/typescript/session-protocol.js';
import { typeScriptIndexMailboxPaths } from '../reindex/typescript-index-protocol.js';
import { readReindexActivitySummary, recordSuppressedReindexActivity } from '../reindex/reindex-activity.js';
import {
  acquireWatchProcessLock,
  readWatchServiceActivity,
  resolveWatchServiceIdentity,
  shouldStopWatchServiceForIdle,
  writeWatchServiceState,
  type WatchServiceWatchOverrides,
} from './watch-service.js';
import { maybeSweepRepositoryCache, DEFAULT_REPOSITORY_SWEEP_INTERVAL_MS } from './repository-cache-lifecycle.js';
import { WatchRefreshCoordinator } from './watch-refresh-coordinator.js';
import { initializeBoundedMailbox, maintainBoundedMailbox } from '../storage/bounded-mailbox.js';
import { publishedSqliteGenerationIdentity } from '../storage/sqlite-generation.js';
import { createTypeScriptIndexMailboxLane, createTypeScriptSemanticMailboxLane } from './typescript-mailbox-lanes.js';

const HEARTBEAT_INTERVAL_MS = 2_000;
const ACTIVITY_POLL_INTERVAL_MS = 5_000;
const WORKTREE_LIVENESS_POLL_INTERVAL_MS = 5_000;
const MAILBOX_MAINTENANCE_INTERVAL_MS = 60_000;
const BUSY_SERVICE_LOOP_INTERVAL_MS = 10;
const IDLE_SERVICE_LOOP_INTERVAL_MS = 50;
const MAX_IDLE_SERVICE_LOOP_INTERVAL_MS = 10_000;

export function watchServiceLoopDelayMs(processedRequests: number, consecutiveIdlePolls = 1): number {
  return boundedExponentialLoopDelayMs(
    processedRequests,
    consecutiveIdlePolls,
    BUSY_SERVICE_LOOP_INTERVAL_MS,
    IDLE_SERVICE_LOOP_INTERVAL_MS,
    MAX_IDLE_SERVICE_LOOP_INTERVAL_MS,
    8,
  );
}

export { createPathChangeWake } from '../platform/path-change-wake.js';

export interface WatchServiceLoopIterationRuntime {
  processIndexRequests(): number;
  processSemanticRequests(): number;
  afterMailboxPoll(result: { indexRequests: number; semanticRequests: number; processedRequests: number }): void;
  shouldStop(): boolean;
  wait(durationMs: number): Promise<void>;
}

export interface WatchServiceShutdown {
  begin(): Promise<WatcherStopResult>;
}

/**
 * Starts the time-critical part of service shutdown exactly once. Reindex
 * cancellation must begin when shutdown is requested, not after unrelated
 * mailbox drains that can consume the controller's graceful-stop deadline.
 */
export function createWatchServiceShutdown(
  watcher: Pick<Watcher, 'stop'>,
  runtime: {
    requestStop(): void;
    closeWake(): void;
  },
): WatchServiceShutdown {
  let stopPromise: Promise<WatcherStopResult> | undefined;
  return {
    begin() {
      if (!stopPromise) {
        runtime.requestStop();
        runtime.closeWake();
        stopPromise = watcher.stop();
        // The signal handler cannot await. Attach a rejection observer now;
        // the server's finally block still awaits and reports the same promise.
        void stopPromise.catch(() => undefined);
      }
      return stopPromise;
    },
  };
}

interface WatchServiceLoopIterationResultBase {
  indexRequests: number;
  semanticRequests: number;
  processedRequests: number;
  consecutiveIdlePolls: number;
}

export type WatchServiceLoopIterationResult = WatchServiceLoopIterationResultBase &
  ({ stopped: true; delayMs?: never } | { stopped: false; delayMs: number });

/**
 * One directly testable service-loop iteration. The injected runtime keeps
 * process ownership and filesystem effects in the server while making mailbox
 * ordering, idle backoff, shutdown, and failure propagation deterministic.
 */
export async function runWatchServiceLoopIteration(
  consecutiveIdlePolls: number,
  runtime: WatchServiceLoopIterationRuntime,
): Promise<WatchServiceLoopIterationResult> {
  const indexRequests = runtime.processIndexRequests();
  const semanticRequests = runtime.processSemanticRequests();
  const processedRequests = indexRequests + semanticRequests;
  const nextIdlePolls = processedRequests > 0 ? 0 : consecutiveIdlePolls + 1;
  runtime.afterMailboxPoll({ indexRequests, semanticRequests, processedRequests });
  if (runtime.shouldStop()) {
    return {
      indexRequests,
      semanticRequests,
      processedRequests,
      consecutiveIdlePolls: nextIdlePolls,
      stopped: true,
    };
  }
  const delayMs = watchServiceLoopDelayMs(processedRequests, nextIdlePolls);
  await runtime.wait(delayMs);
  return {
    indexRequests,
    semanticRequests,
    processedRequests,
    consecutiveIdlePolls: nextIdlePolls,
    stopped: false,
    delayMs,
  };
}

export function startupRefreshTrigger(state: IndexFreshnessState): RefreshTrigger | null {
  return state === 'fresh' ? null : { kind: 'watch-startup', detail: `index ${state} when watch service started` };
}

function writeCurrentWatchServiceState(input: {
  statePath: string;
  durability: 'durable' | 'visibility';
  processIdentity: ReturnType<typeof readProcessIdentity>;
  projectRoot: string;
  worktreeId: string | undefined;
  cliVersion: string;
  startedAtMs: number;
  nowMs: number;
  lastActivityAtMs: number;
  idleTimeoutMs: number;
  watcherStatus: WatcherStatus;
  indexGeneration: string | undefined;
  lastRefresh: WatchServiceState['lastRefresh'];
  lastError: WatchServiceState['lastError'];
  reindexActivity: WatchServiceState['reindexActivity'];
  refreshCoordinator: WatchRefreshCoordinator;
  semanticLane: Pick<ReturnType<typeof createTypeScriptSemanticMailboxLane>, 'status'>;
  indexLane: Pick<ReturnType<typeof createTypeScriptIndexMailboxLane>, 'status'>;
  semanticBusyUntilMs: number | undefined;
  indexBusyUntilMs: number | undefined;
}): void {
  writeWatchServiceState(
    input.statePath,
    {
      version: 1,
      protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
      pid: process.pid,
      ...(input.processIdentity ? { processIdentity: input.processIdentity } : {}),
      projectRoot: input.projectRoot,
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      cliVersion: input.cliVersion,
      startedAt: new Date(input.startedAtMs).toISOString(),
      heartbeatAt: new Date(input.nowMs).toISOString(),
      lastActivityAt: new Date(input.lastActivityAtMs).toISOString(),
      ...(input.idleTimeoutMs === 0
        ? {}
        : { idleDeadlineAt: new Date(input.lastActivityAtMs + input.idleTimeoutMs).toISOString() }),
      watcher: input.watcherStatus,
      ...(input.watcherStatus.state === 'idle' && input.indexGeneration
        ? { indexGeneration: input.indexGeneration }
        : {}),
      ...(input.lastRefresh ? { lastRefresh: input.lastRefresh } : {}),
      ...(input.lastError ? { lastError: input.lastError } : {}),
      reindexActivity: input.reindexActivity,
      refreshRequests: input.refreshCoordinator.status(),
      typescriptSemantic: {
        ...input.semanticLane.status(),
        ...(input.semanticBusyUntilMs === undefined
          ? {}
          : { busyUntil: new Date(input.semanticBusyUntilMs).toISOString() }),
      },
      typescriptIndex: {
        ...input.indexLane.status(),
        ...(input.indexBusyUntilMs === undefined ? {} : { busyUntil: new Date(input.indexBusyUntilMs).toISOString() }),
      },
    },
    { durability: input.durability },
  );
}

function createWatchServiceMaintenance(input: {
  worktreeLiveness: ReturnType<typeof captureWorktreeLivenessIdentity>;
  indexMailboxPaths: ReturnType<typeof typeScriptIndexMailboxPaths>;
  semanticMailboxPaths: ReturnType<typeof typeScriptSemanticMailboxPaths>;
  projectRoot: string;
  cliVersion: string;
  activityPath: string;
  refreshCoordinator: WatchRefreshCoordinator;
  watcherStatus(): WatcherStatus;
  requestRefresh(detail: string): void;
  requestStop(): void;
  recordActivity(): void;
  updateObservedActivity(atMs: number, monotonicMs: number): void;
  persistState(force?: boolean, durability?: 'durable' | 'visibility'): void;
}): WatchServiceLoopIterationRuntime['afterMailboxPoll'] {
  let lastRefreshRequestAtMs = 0;
  let lastActivityPollAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastWorktreeLivenessPollAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastCacheSweepAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastMailboxMaintenanceAtMonotonicMs = Number.NEGATIVE_INFINITY;

  return ({ processedRequests }): void => {
    const nowMonotonicMs = monotonicNowMs();
    if (nowMonotonicMs - lastWorktreeLivenessPollAtMonotonicMs >= WORKTREE_LIVENESS_POLL_INTERVAL_MS) {
      lastWorktreeLivenessPollAtMonotonicMs = nowMonotonicMs;
      if (!worktreeLivenessIdentityIsCurrent(input.worktreeLiveness)) {
        input.requestStop();
        return;
      }
    }
    if (nowMonotonicMs - lastMailboxMaintenanceAtMonotonicMs >= MAILBOX_MAINTENANCE_INTERVAL_MS) {
      lastMailboxMaintenanceAtMonotonicMs = nowMonotonicMs;
      maintainBoundedMailbox(input.indexMailboxPaths);
      maintainBoundedMailbox(input.semanticMailboxPaths);
    }
    if (nowMonotonicMs - lastCacheSweepAtMonotonicMs >= DEFAULT_REPOSITORY_SWEEP_INTERVAL_MS) {
      lastCacheSweepAtMonotonicMs = nowMonotonicMs;
      maybeSweepRepositoryCache(input.projectRoot, input.cliVersion);
    }
    if (nowMonotonicMs - lastActivityPollAtMonotonicMs >= ACTIVITY_POLL_INTERVAL_MS) {
      lastActivityPollAtMonotonicMs = nowMonotonicMs;
      const activity = readWatchServiceActivity(input.activityPath);
      if (activity) input.updateObservedActivity(activity.atMs, nowMonotonicMs);
      if (activity?.refreshRequestedAtMs !== undefined && activity.refreshRequestedAtMs > lastRefreshRequestAtMs) {
        lastRefreshRequestAtMs = activity.refreshRequestedAtMs;
        input.refreshCoordinator.observeLegacyRequest(
          activity.refreshRequestedAtMs,
          activity.refreshDetail ?? 'stale index observed by a legacy command',
        );
      }
    }
    input.refreshCoordinator.poll(input.watcherStatus(), (detail) => {
      input.recordActivity();
      input.requestRefresh(detail);
    });
    if (processedRequests > 0) {
      input.recordActivity();
      input.persistState(true, 'visibility');
    }
    input.persistState();
  };
}

async function runWatchServiceLifecycle(input: {
  watcher: Watcher;
  shutdown: WatchServiceShutdown;
  stopSignal(): void;
  initializeFreshness(): RefreshTrigger | null;
  markReady(): void;
  recordActivity(): void;
  persistState(force?: boolean, durability?: 'durable' | 'visibility'): void;
  requestRefresh(trigger: RefreshTrigger): void;
  stopRequested(): boolean;
  processIndexRequests(): number;
  processSemanticRequests(): number;
  afterMailboxPoll: WatchServiceLoopIterationRuntime['afterMailboxPoll'];
  shouldStop(): boolean;
  wait(durationMs: number): Promise<void>;
  closeLanes(): Promise<void>;
  mailboxFatalError(): Error | undefined;
  finalizeStopped(): void;
  finalizeDegraded(reasons: readonly string[]): Error;
}): Promise<void> {
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let consecutiveIdleMailboxPolls = 0;
  let executionFailed = false;
  let executionError: unknown;
  let shutdownError: Error | undefined;
  process.once('SIGINT', input.stopSignal);
  process.once('SIGTERM', input.stopSignal);
  try {
    input.watcher.start();
    const startupTrigger = input.initializeFreshness();
    input.recordActivity();
    input.markReady();
    input.persistState(true);
    heartbeatTimer = setInterval(() => input.persistState(), HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    if (startupTrigger) input.requestRefresh(startupTrigger);

    while (!input.stopRequested()) {
      const iteration = await runWatchServiceLoopIteration(consecutiveIdleMailboxPolls, {
        processIndexRequests: input.processIndexRequests,
        processSemanticRequests: input.processSemanticRequests,
        afterMailboxPoll: input.afterMailboxPoll,
        shouldStop: input.shouldStop,
        wait: input.wait,
      });
      consecutiveIdleMailboxPolls = iteration.consecutiveIdlePolls;
      if (iteration.stopped) break;
    }
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    process.off('SIGINT', input.stopSignal);
    process.off('SIGTERM', input.stopSignal);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    const watcherStop = input.shutdown.begin();
    await input.closeLanes();
    const stopResult = await watcherStop;
    if (stopResult.state === 'stopped') input.finalizeStopped();
    else shutdownError = input.finalizeDegraded(stopResult.reasons);
  }
  const mailboxFatalError = input.mailboxFatalError();
  if (!executionFailed && mailboxFatalError) {
    executionFailed = true;
    executionError = mailboxFatalError;
  }
  if (executionFailed && shutdownError) {
    throw new AggregateError([executionError, shutdownError], 'Watch service execution and shutdown both failed.');
  }
  if (executionFailed) throw executionError;
  if (shutdownError) throw shutdownError;
}

function createWatchServiceMailboxLanes(input: {
  semanticPaths: ReturnType<typeof typeScriptSemanticMailboxPaths>;
  indexPaths: ReturnType<typeof typeScriptIndexMailboxPaths>;
  projectRoot: string;
  dbPath: string;
  config: ReturnType<typeof loadProjectConfig>;
  onSemanticBusy(deadlineAtMs: number | undefined): void;
  onIndexBusy(deadlineAtMs: number | undefined): void;
  onFatal(error: Error): void;
}) {
  const semanticLane = createTypeScriptSemanticMailboxLane({
    paths: input.semanticPaths,
    projectRoot: input.projectRoot,
    onBusy: input.onSemanticBusy,
    onFatal: input.onFatal,
  });
  const typescript = input.config.indexer?.typescript;
  const indexLane = createTypeScriptIndexMailboxLane({
    paths: input.indexPaths,
    projectRoot: input.projectRoot,
    dbPath: input.dbPath,
    ...(typescript?.maxWarmSessions === undefined ? {} : { maxActiveSessions: typescript.maxWarmSessions }),
    ...(typescript?.workerIdleMs === undefined ? {} : { workerIdleMs: typescript.workerIdleMs }),
    ...(typescript?.workerSoftMemoryMb === undefined ? {} : { workerSoftMemoryMb: typescript.workerSoftMemoryMb }),
    ...(typescript?.workerHeapMb === undefined ? {} : { workerHeapMb: typescript.workerHeapMb }),
    onBusy: input.onIndexBusy,
    onFatal: input.onFatal,
  });
  return { semanticLane, indexLane };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; watcher lifecycle, refresh ordering, and failure recovery stay together.
export async function runWatchServiceServer(
  projectRootInput: string,
  cliVersion: string,
  watchOverrides: WatchServiceWatchOverrides = {},
): Promise<void> {
  const serviceIdentity = resolveWatchServiceIdentity(projectRootInput, cliVersion);
  const projectRoot = serviceIdentity.projectRoot;
  const gitControlDirectory =
    serviceIdentity.worktreeKind === 'git'
      ? resolveCurrentGitControlDirectory(projectRoot, serviceIdentity.worktreeId)
      : undefined;
  const worktreeLiveness = captureWorktreeLivenessIdentity(projectRoot, gitControlDirectory);
  const config = loadProjectConfig(projectRoot);
  config.watch = { ...config.watch, ...watchOverrides };
  const watchConfig = resolveWatchConfig(config);
  if (!watchConfig.enabled) {
    throw new Error('watch mode is disabled; set "watch.enabled": true before starting the service');
  }
  const indexPaths = resolveIndexStoragePaths(projectRoot, config);
  const servicePaths = watchServicePaths(indexPaths.cacheDir);
  const processIdentity = readProcessIdentity(process.pid);
  const lock = acquireWatchProcessLock(servicePaths.lockPath, projectRoot, {
    readProcessIdentity: (pid) => (pid === process.pid ? processIdentity : readProcessIdentity(pid)),
  });
  if (!lock.acquired) return;
  const refreshCoordinator = new WatchRefreshCoordinator(servicePaths.refreshRequestsPath, {
    retryDelayMs: Math.max(1_000, watchConfig.cooldownMs),
  });
  refreshCoordinator.initializeAfterOwnershipAcquired();

  const startedAtMs = Date.now();
  const startedAtMonotonicMs = monotonicNowMs();
  let lastActivityAtMs = startedAtMs;
  let lastActivityAtMonotonicMs = startedAtMonotonicMs;
  let watcherStatus: WatcherStatus = { state: 'idle' };
  let indexGeneration: string | undefined;
  let lastRefresh: WatchServiceState['lastRefresh'];
  let lastError: WatchServiceState['lastError'];
  let mailboxFatalError: Error | undefined;
  let reindexActivity = readReindexActivitySummary(indexPaths.dbPath);
  let stopping = false;
  let ready = false;
  let lastHeartbeatAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let semanticBusyUntilMs: number | undefined;
  let indexBusyUntilMs: number | undefined;
  const semanticMailboxPaths = typeScriptSemanticMailboxPaths(indexPaths.cacheDir);
  const indexMailboxPaths = typeScriptIndexMailboxPaths(indexPaths.cacheDir);
  initializeBoundedMailbox(semanticMailboxPaths);
  initializeBoundedMailbox(indexMailboxPaths);
  const mailboxWake = createPathChangeWake([
    indexMailboxPaths.pendingDir,
    indexMailboxPaths.legacyRequestDir,
    semanticMailboxPaths.pendingDir,
    semanticMailboxPaths.legacyRequestDir,
    servicePaths.refreshRequestsPath,
  ]);

  const persistState = (
    force = false,
    durability: 'durable' | 'visibility' = force ? 'durable' : 'visibility',
  ): void => {
    if (!ready) return;
    const nowMs = Date.now();
    const nowMonotonicMs = monotonicNowMs();
    if (!force && nowMonotonicMs - lastHeartbeatAtMonotonicMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMonotonicMs = nowMonotonicMs;
    writeCurrentWatchServiceState({
      statePath: servicePaths.statePath,
      durability,
      processIdentity,
      projectRoot,
      worktreeId: serviceIdentity.worktreeId,
      cliVersion,
      startedAtMs,
      nowMs,
      lastActivityAtMs,
      idleTimeoutMs: watchConfig.idleTimeoutMs,
      watcherStatus,
      indexGeneration,
      lastRefresh,
      lastError,
      reindexActivity,
      refreshCoordinator,
      semanticLane,
      indexLane,
      semanticBusyUntilMs,
      indexBusyUntilMs,
    });
  };

  const recordActivity = (): void => {
    lastActivityAtMs = Date.now();
    lastActivityAtMonotonicMs = monotonicNowMs();
  };

  const recordMailboxFatal = (error: Error): void => {
    recordActivity();
    mailboxFatalError ??= error;
    lastError = { at: new Date().toISOString(), message: error.message };
    persistState(true, 'visibility');
  };
  const { semanticLane, indexLane } = createWatchServiceMailboxLanes({
    semanticPaths: semanticMailboxPaths,
    indexPaths: indexMailboxPaths,
    projectRoot,
    dbPath: indexPaths.dbPath,
    config,
    onSemanticBusy(deadlineAtMs) {
      semanticBusyUntilMs = deadlineAtMs === undefined ? undefined : deadlineAtMs + 5_000;
      persistState(true, 'visibility');
    },
    onIndexBusy(deadlineAtMs) {
      indexBusyUntilMs = deadlineAtMs === undefined ? undefined : deadlineAtMs + 5_000;
      persistState(true, 'visibility');
    },
    onFatal: recordMailboxFatal,
  });

  const watcher = new Watcher({
    projectRoot,
    config: { ...config, watch: watchConfig },
    outputDb: indexPaths.dbPath,
    languages: config.languages,
    onStatus(status) {
      watcherStatus = status;
      if (status.state !== 'idle') indexGeneration = undefined;
      if (status.state !== 'idle') recordActivity();
      persistState(true);
    },
    onReindexComplete(_durationMs, _trigger, context) {
      recordActivity();
      const freshness =
        context?.pendingChanges !== false
          ? getIndexFreshness(projectRoot, config, indexPaths)
          : getPublishedIndexFreshness(indexPaths);
      lastRefresh = freshness.lastRefresh;
      indexGeneration =
        freshness.state === 'fresh' ? (publishedSqliteGenerationIdentity(indexPaths.dbPath) ?? undefined) : undefined;
      reindexActivity = readReindexActivitySummary(indexPaths.dbPath);
      refreshCoordinator.completeActive();
      lastError = undefined;
      persistState(true);
      return freshness.state === 'fresh';
    },
    onReindexError() {
      refreshCoordinator.failActive();
    },
    onRefreshSuppressed(trigger) {
      const activityWrite = recordSuppressedReindexActivity(indexPaths.dbPath, trigger);
      if (activityWrite.state === 'failed') {
        lastError = {
          at: new Date().toISOString(),
          message: `Suppressed-refresh telemetry was not recorded: ${activityWrite.reason}`,
        };
        persistState(true, 'visibility');
      }
      reindexActivity = readReindexActivitySummary(indexPaths.dbPath);
    },
    onError(error) {
      recordActivity();
      indexGeneration = undefined;
      lastError = { at: new Date().toISOString(), message: error.message };
      persistState(true);
    },
  });

  const shutdown = createWatchServiceShutdown(watcher, {
    requestStop() {
      stopping = true;
    },
    closeWake() {
      mailboxWake.close();
    },
  });
  const stop = (): void => {
    void shutdown.begin();
  };
  const afterMailboxPoll = createWatchServiceMaintenance({
    worktreeLiveness,
    indexMailboxPaths,
    semanticMailboxPaths,
    projectRoot,
    cliVersion,
    activityPath: servicePaths.activityPath,
    refreshCoordinator,
    watcherStatus: () => watcherStatus,
    requestRefresh: (detail) => watcher.requestRefresh({ kind: 'watch-demand', detail }, { immediate: true }),
    requestStop: () => {
      stopping = true;
    },
    recordActivity,
    updateObservedActivity(atMs, monotonicMs) {
      if (atMs <= lastActivityAtMs) return;
      lastActivityAtMs = atMs;
      lastActivityAtMonotonicMs = monotonicMs;
    },
    persistState,
  });
  await runWatchServiceLifecycle({
    watcher,
    shutdown,
    stopSignal: stop,
    initializeFreshness() {
      const freshness = getIndexFreshness(projectRoot, config, indexPaths);
      lastRefresh = freshness.lastRefresh;
      indexGeneration =
        freshness.state === 'fresh' ? (publishedSqliteGenerationIdentity(indexPaths.dbPath) ?? undefined) : undefined;
      return startupRefreshTrigger(freshness.state);
    },
    markReady: () => {
      ready = true;
    },
    recordActivity,
    persistState,
    requestRefresh: (trigger) => watcher.requestRefresh(trigger, { immediate: true }),
    stopRequested: () => stopping,
    processIndexRequests: () => indexLane.poll(),
    processSemanticRequests: () => semanticLane.poll(),
    afterMailboxPoll,
    shouldStop: () =>
      stopping ||
      mailboxFatalError !== undefined ||
      shouldStopWatchServiceForIdle({
        watcher: watcherStatus,
        lastActivityAtMs: lastActivityAtMonotonicMs,
        nowMs: monotonicNowMs(),
        idleTimeoutMs: watchConfig.idleTimeoutMs,
      }),
    wait: (durationMs) => mailboxWake.wait(durationMs),
    closeLanes: () =>
      Promise.all([
        semanticLane.close('TypeScript semantic service stopped before completing the request.'),
        indexLane.close('TypeScript index service stopped before completing the request.'),
      ]).then(() => undefined),
    mailboxFatalError: () => mailboxFatalError,
    finalizeStopped() {
      rmSync(servicePaths.statePath, { force: true });
      rmSync(servicePaths.activityPath, { force: true });
      lock.release();
    },
    finalizeDegraded(reasons) {
      lastError = {
        at: new Date().toISOString(),
        message: `Watch service shutdown is degraded: ${reasons.join('; ')}`,
      };
      persistState(true);
      return new Error(lastError.message);
    },
  });
}

function resolveCurrentGitControlDirectory(projectRoot: string, expectedWorktreeId: string): string {
  const resolution = resolveGitWorktreeIdentity(projectRoot);
  if (resolution.kind !== 'worktree' || resolution.identity.worktreeId !== expectedWorktreeId) {
    throw new Error(`Git worktree identity changed while starting the watch service for ${projectRoot}.`);
  }
  return resolution.identity.gitDir;
}

export function terminateWatchServiceProcess(
  error: unknown,
  runtime: {
    report(message: string): void;
    exit(code: number): never;
  } = {
    report: (message) => console.error(message),
    exit: (code) => process.exit(code),
  },
): never {
  runtime.report(`watch-service: ${sanitizeTerminalLine(error instanceof Error ? error.message : String(error))}`);
  return runtime.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const projectRoot = process.argv[2];
  const cliVersion = process.argv[3];
  const watchOverrides = parseWatchOverrides(process.argv[4]);
  if (!projectRoot || !cliVersion) {
    console.error('watch-service: expected <project-root> <cli-version>');
    process.exitCode = 1;
  } else {
    try {
      await runWatchServiceServer(projectRoot, cliVersion, watchOverrides);
    } catch (error) {
      terminateWatchServiceProcess(error);
    }
  }
}

function parseWatchOverrides(raw: string | undefined): WatchServiceWatchOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as WatchServiceWatchOverrides;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
