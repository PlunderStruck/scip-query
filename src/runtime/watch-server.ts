import process from 'node:process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeTerminalLine } from '../platform/terminal-output.js';
import { monotonicNowMs } from '../domain/time.js';
import type { RefreshTrigger, WatcherStatus } from '../domain/types.js';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import {
  WATCH_SERVICE_PROTOCOL_VERSION,
  watchServicePaths,
  type WatchServiceState,
} from '../platform/watch-service-state.js';
import { loadProjectConfig, resolveWatchConfig } from './config.js';
import { getIndexFreshness, type IndexFreshnessState } from './index-freshness.js';
import { Watcher } from './watch.js';
import { openProjectDb } from './cli-context.js';
import {
  TypeScriptSemanticServiceHost,
  initializeTypeScriptSemanticMailbox,
  processTypeScriptSemanticMailbox,
  typeScriptSemanticMailboxStatus,
} from '../semantic/typescript/session-service.js';
import {
  publishedGenerationIdentity,
  typeScriptSemanticMailboxPaths,
} from '../semantic/typescript/session-protocol.js';
import {
  TypeScriptIndexServiceHost,
  initializeTypeScriptIndexMailbox,
  processTypeScriptIndexMailbox,
  typeScriptIndexMailboxStatus,
} from '../reindex/typescript-index-service.js';
import {
  publishedTypeScriptIndexGeneration,
  typeScriptIndexMailboxPaths,
} from '../reindex/typescript-index-protocol.js';
import { readReindexActivitySummary, recordSuppressedReindexActivity } from '../reindex/reindex-activity.js';
import {
  acquireWatchProcessLock,
  readWatchServiceActivity,
  resolveWatchServiceIdentity,
  shouldStopWatchServiceForIdle,
  writeWatchServiceState,
  type WatchServiceWatchOverrides,
} from './watch-service.js';
import { maybeSweepRepositoryCache } from './repository-cache-lifecycle.js';
import { WatchRefreshCoordinator } from './watch-refresh-coordinator.js';
import { maintainBoundedMailbox } from '../storage/bounded-mailbox.js';

const HEARTBEAT_INTERVAL_MS = 1_000;
const ACTIVITY_POLL_INTERVAL_MS = 250;
const MAILBOX_MAINTENANCE_INTERVAL_MS = 60_000;
const BUSY_SERVICE_LOOP_INTERVAL_MS = 10;
const IDLE_SERVICE_LOOP_INTERVAL_MS = 50;

export function watchServiceLoopDelayMs(processedRequests: number): number {
  return processedRequests > 0 ? BUSY_SERVICE_LOOP_INTERVAL_MS : IDLE_SERVICE_LOOP_INTERVAL_MS;
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
  let reindexActivity = readReindexActivitySummary(indexPaths.dbPath);
  let stopping = false;
  let ready = false;
  let lastRefreshRequestAtMs = 0;
  let lastHeartbeatAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastActivityPollAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastCacheSweepAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let lastMailboxMaintenanceAtMonotonicMs = Number.NEGATIVE_INFINITY;
  let semanticBusyUntilMs: number | undefined;
  let indexBusyUntilMs: number | undefined;
  const semanticMailboxPaths = typeScriptSemanticMailboxPaths(indexPaths.cacheDir);
  const indexMailboxPaths = typeScriptIndexMailboxPaths(indexPaths.cacheDir);
  initializeTypeScriptSemanticMailbox(semanticMailboxPaths);
  initializeTypeScriptIndexMailbox(indexMailboxPaths);
  const semanticHost = new TypeScriptSemanticServiceHost({ openDb: () => openProjectDb(projectRoot) });
  const indexHost = new TypeScriptIndexServiceHost({
    projectRoot,
    currentGeneration: () => publishedTypeScriptIndexGeneration(indexPaths.dbPath),
  });

  const persistState = (force = false): void => {
    if (!ready) return;
    const nowMs = Date.now();
    const nowMonotonicMs = monotonicNowMs();
    if (!force && nowMonotonicMs - lastHeartbeatAtMonotonicMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMonotonicMs = nowMonotonicMs;
    writeWatchServiceState(servicePaths.statePath, {
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
        ...semanticHost.status(typeScriptSemanticMailboxStatus(semanticMailboxPaths)),
        ...(semanticBusyUntilMs === undefined ? {} : { busyUntil: new Date(semanticBusyUntilMs).toISOString() }),
      },
      typescriptIndex: {
        ...indexHost.status(typeScriptIndexMailboxStatus(indexMailboxPaths)),
        ...(indexBusyUntilMs === undefined ? {} : { busyUntil: new Date(indexBusyUntilMs).toISOString() }),
      },
    });
  };

  const recordActivity = (): void => {
    lastActivityAtMs = Date.now();
    lastActivityAtMonotonicMs = monotonicNowMs();
  };

  const watcher = new Watcher({
    projectRoot,
    config: { ...config, watch: watchConfig },
    languages: config.languages,
    onStatus(status) {
      watcherStatus = status;
      if (status.state !== 'idle') indexGeneration = undefined;
      if (status.state !== 'idle') recordActivity();
      persistState(true);
    },
    onReindexComplete() {
      recordActivity();
      const freshness = getIndexFreshness(projectRoot, config, indexPaths);
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
      recordSuppressedReindexActivity(indexPaths.dbPath, trigger);
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
    if (startupTrigger) watcher.requestRefresh(startupTrigger, { immediate: true });
    recordActivity();
    ready = true;
    persistState(true);

    while (!stopping) {
      const indexRequests = processTypeScriptIndexMailbox(indexMailboxPaths, indexHost, {
        beforeRequest(deadlineAtMs) {
          indexBusyUntilMs = deadlineAtMs + 5_000;
          persistState(true);
        },
        afterRequest() {
          indexBusyUntilMs = undefined;
          persistState(true);
        },
      });
      const semanticRequests = processTypeScriptSemanticMailbox(semanticMailboxPaths, semanticHost, {
        beforeRequest(deadlineAtMs) {
          semanticBusyUntilMs = deadlineAtMs + 5_000;
          persistState(true);
        },
        afterRequest() {
          semanticBusyUntilMs = undefined;
          persistState(true);
        },
      });
      const nowMonotonicMs = monotonicNowMs();
      if (nowMonotonicMs - lastMailboxMaintenanceAtMonotonicMs >= MAILBOX_MAINTENANCE_INTERVAL_MS) {
        lastMailboxMaintenanceAtMonotonicMs = nowMonotonicMs;
        maintainBoundedMailbox(indexMailboxPaths);
        maintainBoundedMailbox(semanticMailboxPaths);
      }
      if (nowMonotonicMs - lastCacheSweepAtMonotonicMs >= 60_000) {
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
        if (activity?.refreshRequestedAtMs !== undefined && activity.refreshRequestedAtMs > lastRefreshRequestAtMs) {
          lastRefreshRequestAtMs = activity.refreshRequestedAtMs;
          refreshCoordinator.observeLegacyRequest(
            activity.refreshRequestedAtMs,
            activity.refreshDetail ?? 'stale index observed by a legacy command',
          );
        }
        refreshCoordinator.poll(watcherStatus, (detail) => {
          recordActivity();
          watcher.requestRefresh({ kind: 'watch-demand', detail }, { immediate: true });
        });
      }
      if (semanticRequests > 0 || indexRequests > 0) {
        recordActivity();
        persistState(true);
      }
      persistState();
      if (
        shouldStopWatchServiceForIdle({
          watcher: watcherStatus,
          lastActivityAtMs: lastActivityAtMonotonicMs,
          nowMs: monotonicNowMs(),
          idleTimeoutMs: watchConfig.idleTimeoutMs,
        })
      ) {
        break;
      }
      await sleep(watchServiceLoopDelayMs(semanticRequests + indexRequests));
    }
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    semanticHost.closeTypeScriptService();
    indexHost.close();
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
  if (executionFailed && shutdownError) {
    throw new AggregateError([executionError, shutdownError], 'Watch service execution and shutdown both failed.');
  }
  if (executionFailed) throw executionError;
  if (shutdownError) throw shutdownError;
}

// scip-query: ignore-twin — independent process loops own their local timer primitive.
function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
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
      console.error(`watch-service: ${sanitizeTerminalLine(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
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
