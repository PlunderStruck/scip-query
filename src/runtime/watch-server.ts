import process from 'node:process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RefreshTrigger, WatcherStatus } from '../domain/types.js';
import { loadProjectConfig, resolveIndexStoragePaths, resolveWatchConfig } from './config.js';
import { getIndexFreshness, type IndexFreshnessState } from './index-freshness.js';
import { Watcher } from './watch.js';
import {
  WATCH_SERVICE_PROTOCOL_VERSION,
  acquireWatchProcessLock,
  readWatchServiceActivityAt,
  shouldStopWatchServiceForIdle,
  watchServicePaths,
  writeWatchServiceState,
  type WatchServiceState,
  type WatchServiceWatchOverrides,
} from './watch-service.js';

const HEARTBEAT_INTERVAL_MS = 1_000;

export function startupRefreshTrigger(state: IndexFreshnessState): RefreshTrigger | null {
  return state === 'fresh' ? null : { kind: 'watch-startup', detail: `index ${state} when watch service started` };
}

export async function runWatchServiceServer(
  projectRootInput: string,
  cliVersion: string,
  watchOverrides: WatchServiceWatchOverrides = {},
): Promise<void> {
  const projectRoot = resolve(projectRootInput);
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
  let lastRefresh: WatchServiceState['lastRefresh'];
  let lastError: WatchServiceState['lastError'];
  let stopping = false;
  let ready = false;

  const persistState = (): void => {
    if (!ready) return;
    const nowMs = Date.now();
    writeWatchServiceState(servicePaths.statePath, {
      version: 1,
      protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
      pid: process.pid,
      projectRoot,
      cliVersion,
      startedAt: new Date(startedAtMs).toISOString(),
      heartbeatAt: new Date(nowMs).toISOString(),
      lastActivityAt: new Date(lastActivityAtMs).toISOString(),
      ...(watchConfig.idleTimeoutMs === 0
        ? {}
        : { idleDeadlineAt: new Date(lastActivityAtMs + watchConfig.idleTimeoutMs).toISOString() }),
      watcher: watcherStatus,
      ...(lastRefresh ? { lastRefresh } : {}),
      ...(lastError ? { lastError } : {}),
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
      if (status.state !== 'idle') recordActivity();
      persistState();
    },
    onReindexComplete() {
      recordActivity();
      lastRefresh = getIndexFreshness(projectRoot, config, indexPaths).lastRefresh;
      lastError = undefined;
      persistState();
    },
    onError(error) {
      recordActivity();
      lastError = { at: new Date().toISOString(), message: error.message };
      persistState();
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
    const startupTrigger = startupRefreshTrigger(freshness.state);
    if (startupTrigger) watcher.requestRefresh(startupTrigger, { immediate: true });
    recordActivity();
    ready = true;
    persistState();

    while (!stopping) {
      const commandActivityAtMs = readWatchServiceActivityAt(servicePaths.activityPath);
      if (commandActivityAtMs !== null && commandActivityAtMs > lastActivityAtMs) {
        lastActivityAtMs = commandActivityAtMs;
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
      await sleep(HEARTBEAT_INTERVAL_MS);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    watcher.stop();
    rmSync(servicePaths.statePath, { force: true });
    rmSync(servicePaths.activityPath, { force: true });
    lock.release();
  }
}

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
