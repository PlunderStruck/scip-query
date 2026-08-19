import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCacheOwnershipProof, resolveScipQueryCacheRoot } from '../platform/cache-layout.js';
import { sameProcessIdentity } from '../platform/process-identity.js';
import { readWatchServiceState, watchServicePaths } from '../platform/watch-service-state.js';
import {
  readWatchProcessLock,
  stopWatchService,
  type WatchServiceControllerOptions,
  type WatchServiceStopResult,
} from './watch-service.js';

export interface WatchServicePruneDiagnostic {
  cacheDir: string;
  projectRoot?: string;
  message: string;
}

export interface WatchServicePruneReport {
  projectsDirectory: string;
  scannedCacheDirs: number;
  ownedCacheDirs: number;
  retainedRoots: number;
  orphanedRoots: number;
  stoppedServices: number;
  alreadyStoppedServices: number;
  skipped: WatchServicePruneDiagnostic[];
  failures: WatchServicePruneDiagnostic[];
}

export interface WatchServicePruneOptions {
  cacheRoot?: string;
  rootIsCurrent?: (projectRoot: string) => boolean;
  stopService?: (opts: WatchServiceControllerOptions) => WatchServiceStopResult;
}

/**
 * Stops watcher processes whose durable cache owner names a worktree root that
 * no longer exists. It never deletes index data and never signals from a PID
 * alone: stopWatchService revalidates the recorded OS process identity.
 */
export function pruneOrphanWatchServices(opts: WatchServicePruneOptions = {}): WatchServicePruneReport {
  const projectsDirectory = join(opts.cacheRoot ?? resolveScipQueryCacheRoot(), 'projects');
  const report: WatchServicePruneReport = {
    projectsDirectory,
    scannedCacheDirs: 0,
    ownedCacheDirs: 0,
    retainedRoots: 0,
    orphanedRoots: 0,
    stoppedServices: 0,
    alreadyStoppedServices: 0,
    skipped: [],
    failures: [],
  };
  if (!directoryExists(projectsDirectory)) return report;

  const rootIsCurrent = opts.rootIsCurrent ?? directoryExists;
  const stopService = opts.stopService ?? stopWatchService;
  for (const entry of readdirSync(projectsDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const cacheDir = join(projectsDirectory, entry.name);
    report.scannedCacheDirs += 1;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      report.skipped.push({ cacheDir, message: 'not a regular cache directory' });
      continue;
    }

    let projectRoot: string;
    try {
      projectRoot = readCacheOwnershipProof(cacheDir).record.canonicalProjectRoot;
      report.ownedCacheDirs += 1;
    } catch (error) {
      report.skipped.push({ cacheDir, message: errorMessage(error) });
      continue;
    }
    if (rootIsCurrent(projectRoot)) {
      report.retainedRoots += 1;
      continue;
    }

    try {
      assertWatcherArtifactsBelongToRoot(cacheDir, projectRoot);
      // A worktree can be recreated while the cache is being inspected. The
      // second observation keeps a newly live pathname out of the stop path.
      if (rootIsCurrent(projectRoot)) {
        report.retainedRoots += 1;
        continue;
      }
      report.orphanedRoots += 1;
      const result = stopService({ projectRoot, cacheDir, cliVersion: 'orphan-prune' });
      if (result.disposition === 'stopped') report.stoppedServices += 1;
      else report.alreadyStoppedServices += 1;
    } catch (error) {
      report.failures.push({ cacheDir, projectRoot, message: errorMessage(error) });
    }
  }
  return report;
}

function assertWatcherArtifactsBelongToRoot(cacheDir: string, projectRoot: string): void {
  const paths = watchServicePaths(cacheDir);
  const state = readWatchServiceState(paths.statePath);
  const lock = readWatchProcessLock(paths.lockPath);
  if (existsSync(paths.statePath) && !state) throw new Error('watch state exists but is not a valid ownership record');
  if (existsSync(paths.lockPath) && !lock) throw new Error('watch lock exists but is not a valid ownership record');
  if (state && state.projectRoot !== projectRoot) throw new Error('watch state belongs to a different project root');
  if (lock && lock.projectRoot !== projectRoot) throw new Error('watch lock belongs to a different project root');
  if (state && lock && state.pid !== lock.pid) throw new Error('watch state and lock name different process owners');
  if (
    state?.processIdentity &&
    lock?.processIdentity &&
    !sameProcessIdentity(state.processIdentity, lock.processIdentity)
  ) {
    throw new Error('watch state and lock name different process identities');
  }
}

function directoryExists(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
