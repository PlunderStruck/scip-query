import process from 'node:process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RefreshTrigger, WatcherStatus } from '../domain/types.js';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
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
} from '../semantic/typescript/session-service.js';
import {
  publishedGenerationIdentity,
  typeScriptSemanticMailboxPaths,
} from '../semantic/typescript/session-protocol.js';
import {
  TypeScriptIndexServiceHost,
  initializeTypeScriptIndexMailbox,
  processTypeScriptIndexMailbox,
} from '../reindex/typescript-index-service.js';
import {
  publishedTypeScriptIndexGeneration,
  typeScriptIndexMailboxPaths,
} from '../reindex/typescript-index-protocol.js';
import {
  acquireWatchProcessLock,
  readWatchServiceActivity,
  resolveWatchServiceIdentity,
  shouldStopWatchServiceForIdle,
  writeWatchServiceState,
  type WatchServiceWatchOverrides,
} from './watch-service.js';
import { maybeSweepRepositoryCache } from './repository-cache-lifecycle.js';

const HEARTBEAT_INTERVAL_MS = 1_000;
const ACTIVITY_POLL_INTERVAL_MS = 250;
const SERVICE_LOOP_INTERVAL_MS = 10;

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
  const lock = acquireWatchProcessLock(servicePaths.lockPath, projectRoot);
  if (!lock.acquired) return;

  const startedAtMs = Date.now();
  let lastActivityAtMs = startedAtMs;
  let watcherStatus: WatcherStatus = { state: 'idle' };
  let indexGeneration: string | undefined;
  let lastRefresh: WatchServiceState['lastRefresh'];
  let lastError: WatchServiceState['lastError'];
  let stopping = false;
  let ready = false;
  let lastRefreshRequestAtMs = 0;
  let lastHeartbeatAtMs = 0;
  let lastActivityPollAtMs = 0;
  let lastCacheSweepAtMs = 0;
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
    if (!force && nowMs - lastHeartbeatAtMs < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAtMs = nowMs;
    writeWatchServiceState(servicePaths.statePath, {
      version: 1,
      protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
      pid: process.pid,
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
      typescriptSemantic: {
        ...semanticHost.status(),
        ...(semanticBusyUntilMs === undefined ? {} : { busyUntil: new Date(semanticBusyUntilMs).toISOString() }),
      },
      typescriptIndex: {
        ...indexHost.status(),
        ...(indexBusyUntilMs === undefined ? {} : { busyUntil: new Date(indexBusyUntilMs).toISOString() }),
      },
    });
  };

  const recordActivity = (): void => {
    lastActivityAtMs = Date.now();
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
      lastError = undefined;
      persistState(true);
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
      const nowMs = Date.now();
      if (nowMs - lastCacheSweepAtMs >= 60_000) {
        lastCacheSweepAtMs = nowMs;
        maybeSweepRepositoryCache(projectRoot, cliVersion);
      }
      if (nowMs - lastActivityPollAtMs >= ACTIVITY_POLL_INTERVAL_MS) {
        lastActivityPollAtMs = nowMs;
        const activity = readWatchServiceActivity(servicePaths.activityPath);
        if (activity && activity.atMs > lastActivityAtMs) {
          lastActivityAtMs = activity.atMs;
        }
        if (activity?.refreshRequestedAtMs !== undefined && activity.refreshRequestedAtMs > lastRefreshRequestAtMs) {
          lastRefreshRequestAtMs = activity.refreshRequestedAtMs;
          recordActivity();
          watcher.requestRefresh(
            { kind: 'watch-demand', detail: activity.refreshDetail ?? 'stale index observed by a command' },
            { immediate: true },
          );
        }
      }
      if (semanticRequests > 0 || indexRequests > 0) {
        recordActivity();
        persistState(true);
      }
      persistState();
      if (
        shouldStopWatchServiceForIdle({
          watcher: watcherStatus,
          lastActivityAtMs,
          nowMs: Date.now(),
          idleTimeoutMs: watchConfig.idleTimeoutMs,
        })
      ) {
        break;
      }
      await sleep(SERVICE_LOOP_INTERVAL_MS);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    semanticHost.closeTypeScriptService();
    indexHost.close();
    watcher.stop();
    rmSync(servicePaths.statePath, { force: true });
    rmSync(servicePaths.activityPath, { force: true });
    lock.release();
  }
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
      console.error(`watch-service: ${error instanceof Error ? error.message : String(error)}`);
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
