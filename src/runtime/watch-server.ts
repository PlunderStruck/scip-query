import process from 'node:process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeTerminalLine } from '../platform/terminal-output.js';
import { monotonicNowMs } from '../domain/time.js';
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
import { Watcher } from './watch.js';
import { initializeTypeScriptSemanticMailbox } from '../semantic/typescript/session-service.js';
import {
  publishedGenerationIdentity,
  typeScriptSemanticMailboxPaths,
} from '../semantic/typescript/session-protocol.js';
import { initializeTypeScriptIndexMailbox } from '../reindex/typescript-index-service.js';
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
import { maintainBoundedMailbox } from '../storage/bounded-mailbox.js';
import { createTypeScriptIndexMailboxLane, createTypeScriptSemanticMailboxLane } from './typescript-mailbox-lanes.js';

const HEARTBEAT_INTERVAL_MS = 2_000;
const ACTIVITY_POLL_INTERVAL_MS = 5_000;
const WORKTREE_LIVENESS_POLL_INTERVAL_MS = 5_000;
const MAILBOX_MAINTENANCE_INTERVAL_MS = 60_000;
const BUSY_SERVICE_LOOP_INTERVAL_MS = 10;
const IDLE_SERVICE_LOOP_INTERVAL_MS = 50;
const MAX_IDLE_SERVICE_LOOP_INTERVAL_MS = 10_000;

export function watchServiceLoopDelayMs(processedRequests: number, consecutiveIdlePolls = 1): number {
  if (processedRequests > 0) return BUSY_SERVICE_LOOP_INTERVAL_MS;
  const exponent = Math.max(0, Math.min(8, consecutiveIdlePolls - 1));
  return Math.min(MAX_IDLE_SERVICE_LOOP_INTERVAL_MS, IDLE_SERVICE_LOOP_INTERVAL_MS * 2 ** exponent);
}

export { createPathChangeWake } from '../platform/path-change-wake.js';

export interface WatchServiceLoopIterationRuntime {
  processIndexRequests(): number;
  processSemanticRequests(): number;
  afterMailboxPoll(result: { indexRequests: number; semanticRequests: number; processedRequests: number }): void;
  shouldStop(): boolean;
  wait(durationMs: number): Promise<void>;
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
  let lastRefreshRequestAtMs = 0;
  let lastHeartbeatAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastActivityPollAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastWorktreeLivenessPollAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastCacheSweepAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastMailboxMaintenanceAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let semanticBusyUntilMs: number | undefined;
  let indexBusyUntilMs: number | undefined;
  let consecutiveIdleMailboxPolls = 0;
  const semanticMailboxPaths = typeScriptSemanticMailboxPaths(indexPaths.cacheDir);
  const indexMailboxPaths = typeScriptIndexMailboxPaths(indexPaths.cacheDir);
  initializeTypeScriptSemanticMailbox(semanticMailboxPaths);
  initializeTypeScriptIndexMailbox(indexMailboxPaths);
  const mailboxWake = createPathChangeWake([
    indexMailboxPaths.pendingDir,
    indexMailboxPaths.legacyRequestDir,
    semanticMailboxPaths.pendingDir,
    semanticMailboxPaths.legacyRequestDir,
    servicePaths.refreshRequestsPath,
  ]);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const persistState = (
    force = false,
    durability: 'durable' | 'visibility' = force ? 'durable' : 'visibility',
  ): void => {
    if (!ready) return;
    const nowMs = Date.now();
    const nowMonotonicMs = monotonicNowMs();
    if (!force && nowMonotonicMs - lastHeartbeatAtMonotonicMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMonotonicMs = nowMonotonicMs;
    writeWatchServiceState(
      servicePaths.statePath,
      {
        version: 1,
        protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
        pid: process.pid,
        ...(processIdentity ? { processIdentity } : {}),
        projectRoot,
        ...(serviceIdentity.worktreeId ? { worktreeId: serviceIdentity.worktreeId } : {}),
        cliVersion,
        startedAt: new Date(startedAtMs).toISOString(),
        heartbeatAt: new Date(nowMs).toISOString(),
        lastActivityAt: new Date(lastActivityAtMs).toISOString(),
        ...(watchConfig.idleTimeoutMs === 0
          ? {}
          : { idleDeadlineAt: new Date(lastActivityAtMs + watchConfig.idleTimeoutMs).toISOString() }),
        watcher: watcherStatus,
        ...(watcherStatus.state === 'idle' && indexGeneration ? { indexGeneration } : {}),
        ...(lastRefresh ? { lastRefresh } : {}),
        ...(lastError ? { lastError } : {}),
        reindexActivity,
        refreshRequests: refreshCoordinator.status(),
        typescriptSemantic: {
          ...semanticLane.status(),
          ...(semanticBusyUntilMs === undefined ? {} : { busyUntil: new Date(semanticBusyUntilMs).toISOString() }),
        },
        typescriptIndex: {
          ...indexLane.status(),
          ...(indexBusyUntilMs === undefined ? {} : { busyUntil: new Date(indexBusyUntilMs).toISOString() }),
        },
      },
      { durability },
    );
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
  const semanticLane = createTypeScriptSemanticMailboxLane({
    paths: semanticMailboxPaths,
    projectRoot,
    onBusy(deadlineAtMs) {
      semanticBusyUntilMs = deadlineAtMs === undefined ? undefined : deadlineAtMs + 5_000;
      persistState(true, 'visibility');
    },
    onFatal: recordMailboxFatal,
  });
  const indexLane = createTypeScriptIndexMailboxLane({
    paths: indexMailboxPaths,
    projectRoot,
    dbPath: indexPaths.dbPath,
    ...(config.indexer?.typescript?.maxWarmSessions === undefined
      ? {}
      : { maxActiveSessions: config.indexer.typescript.maxWarmSessions }),
    ...(config.indexer?.typescript?.workerIdleMs === undefined
      ? {}
      : { workerIdleMs: config.indexer.typescript.workerIdleMs }),
    ...(config.indexer?.typescript?.workerSoftMemoryMb === undefined
      ? {}
      : { workerSoftMemoryMb: config.indexer.typescript.workerSoftMemoryMb }),
    onBusy(deadlineAtMs) {
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
        freshness.state === 'fresh' ? (publishedGenerationIdentity(indexPaths.dbPath) ?? undefined) : undefined;
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

  const stop = (): void => {
    stopping = true;
    mailboxWake.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let executionFailed = false;
  let executionError: unknown;
  let shutdownError: Error | undefined;
  try {
    watcher.start();
    const freshness = getIndexFreshness(projectRoot, config, indexPaths);
    lastRefresh = freshness.lastRefresh;
    indexGeneration =
      freshness.state === 'fresh' ? (publishedGenerationIdentity(indexPaths.dbPath) ?? undefined) : undefined;
    const startupTrigger = startupRefreshTrigger(freshness.state);
    recordActivity();
    ready = true;
    persistState(true);
    heartbeatTimer = setInterval(() => persistState(), HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    // Advertise a live TypeScript index mailbox before the first refresh so
    // the reindex worker can emit incrementally instead of falling back to
    // scip-typescript because the watch state file does not exist yet.
    if (startupTrigger) watcher.requestRefresh(startupTrigger, { immediate: true });

    while (!stopping) {
      const iteration = await runWatchServiceLoopIteration(consecutiveIdleMailboxPolls, {
        processIndexRequests: () => indexLane.poll(),
        processSemanticRequests: () => semanticLane.poll(),
        afterMailboxPoll: ({ processedRequests }) => {
          const nowMonotonicMs = monotonicNowMs();
          if (nowMonotonicMs - lastWorktreeLivenessPollAtMonotonicMs >= WORKTREE_LIVENESS_POLL_INTERVAL_MS) {
            lastWorktreeLivenessPollAtMonotonicMs = nowMonotonicMs;
            if (!worktreeLivenessIdentityIsCurrent(worktreeLiveness)) {
              stopping = true;
              return;
            }
          }
          if (nowMonotonicMs - lastMailboxMaintenanceAtMonotonicMs >= MAILBOX_MAINTENANCE_INTERVAL_MS) {
            lastMailboxMaintenanceAtMonotonicMs = nowMonotonicMs;
            maintainBoundedMailbox(indexMailboxPaths);
            maintainBoundedMailbox(semanticMailboxPaths);
          }
          if (nowMonotonicMs - lastCacheSweepAtMonotonicMs >= DEFAULT_REPOSITORY_SWEEP_INTERVAL_MS) {
            lastCacheSweepAtMonotonicMs = nowMonotonicMs;
            maybeSweepRepositoryCache(projectRoot, cliVersion);
          }
          if (nowMonotonicMs - lastActivityPollAtMonotonicMs >= ACTIVITY_POLL_INTERVAL_MS) {
            lastActivityPollAtMonotonicMs = nowMonotonicMs;
            const activity = readWatchServiceActivity(servicePaths.activityPath);
            if (activity && activity.atMs > lastActivityAtMs) {
              lastActivityAtMs = activity.atMs;
              lastActivityAtMonotonicMs = nowMonotonicMs;
            }
            if (
              activity?.refreshRequestedAtMs !== undefined &&
              activity.refreshRequestedAtMs > lastRefreshRequestAtMs
            ) {
              lastRefreshRequestAtMs = activity.refreshRequestedAtMs;
              refreshCoordinator.observeLegacyRequest(
                activity.refreshRequestedAtMs,
                activity.refreshDetail ?? 'stale index observed by a legacy command',
              );
            }
          }
          refreshCoordinator.poll(watcherStatus, (detail) => {
            recordActivity();
            watcher.requestRefresh({ kind: 'watch-demand', detail }, { immediate: true });
          });
          if (processedRequests > 0) {
            recordActivity();
            persistState(true, 'visibility');
          }
          persistState();
        },
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
      });
      consecutiveIdleMailboxPolls = iteration.consecutiveIdlePolls;
      if (iteration.stopped) break;
    }
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    mailboxWake.close();
    await Promise.all([
      semanticLane.close('TypeScript semantic service stopped before completing the request.'),
      indexLane.close('TypeScript index service stopped before completing the request.'),
    ]);
    const stopResult = await watcher.stop();
    if (stopResult.state === 'stopped') {
      rmSync(servicePaths.statePath, { force: true });
      rmSync(servicePaths.activityPath, { force: true });
      lock.release();
    } else {
      lastError = {
        at: new Date().toISOString(),
        message: `Watch service shutdown is degraded: ${stopResult.reasons.join('; ')}`,
      };
      persistState(true);
      shutdownError = new Error(lastError.message);
    }
  }
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
