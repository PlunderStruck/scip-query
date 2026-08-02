import type { ProjectConfig } from '../domain/types.js';
import type { GitWorktreeContext } from '../platform/git-worktree.js';
import type { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { getIndexFreshness, type IndexFreshness } from './index-freshness.js';
import { prepareWorktreeIndex } from './cli-context.js';
import type { reindexConfiguredProject } from './project-reindex.js';
import {
  ensureWatchServiceForCommand,
  inspectWatchService,
  requestWatchServiceRefresh,
  trustedWatchServiceIndexGeneration,
  watchServicePaths,
  type WatchServiceAutoEnsureResult,
} from './watch-service.js';
import { cliVersion } from './cli-support.js';

const DEFAULT_WATCH_REFRESH_WAIT_MS = 5_000;
const DEFAULT_WATCH_REFRESH_POLL_MS = 100;

interface EvidenceCommandWorkspace {
  commandName: string;
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof resolveIndexStoragePaths>;
  dbPathSource: 'env' | 'configured' | 'root-fallback';
  gitContext?: GitWorktreeContext;
}

export interface EvidenceCommandFreshnessResult {
  source: 'explicit-index' | 'existing' | 'shared-generation' | 'watcher' | 'synchronous-reindex';
  service: WatchServiceAutoEnsureResult;
}

export interface EvidenceCommandFreshnessDependencies {
  prepare: typeof prepareWorktreeIndex;
  freshness: typeof getIndexFreshness;
  ensureService: typeof ensureWatchServiceForCommand;
  inspectService: typeof inspectWatchService;
  requestRefresh: typeof requestWatchServiceRefresh;
  reindex: typeof reindexConfiguredProject;
  wait(milliseconds: number): Promise<void>;
  now(): number;
}

const DEFAULT_DEPENDENCIES: EvidenceCommandFreshnessDependencies = {
  prepare: prepareWorktreeIndex,
  freshness: getIndexFreshness,
  ensureService: ensureWatchServiceForCommand,
  inspectService: inspectWatchService,
  requestRefresh: requestWatchServiceRefresh,
  async reindex(projectRoot, config, paths, options) {
    const { reindexConfiguredProject } = await import('./project-reindex.js');
    return reindexConfiguredProject(projectRoot, config, paths, options);
  },
  wait(milliseconds) {
    return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
  },
  now: Date.now,
};

/**
 * An evidence command owns index freshness as one internal transaction. It
 * first reuses local/shared/watcher work, then performs one synchronous
 * fallback when background refresh cannot make progress within the bound.
 */
export async function ensureEvidenceCommandFreshness(
  workspace: EvidenceCommandWorkspace,
  dependencies: EvidenceCommandFreshnessDependencies = DEFAULT_DEPENDENCIES,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<EvidenceCommandFreshnessResult> {
  if (workspace.dbPathSource === 'env') {
    return { source: 'explicit-index', service: { kind: 'skipped', reason: 'environment' } };
  }

  const watcherGeneration = trustedGeneration(workspace, dependencies);
  const prepared = dependencies.prepare(workspace.projectRoot, workspace.config, workspace.paths, {
    gitContext: workspace.gitContext,
    ...(watcherGeneration ? { watcherGeneration } : {}),
  });
  let freshness = dependencies.freshness(workspace.projectRoot, workspace.config, workspace.paths);
  const service = dependencies.ensureService({
    commandName: workspace.commandName,
    projectRoot: workspace.projectRoot,
    cacheDir: workspace.paths.cacheDir,
    cliVersion,
    config: workspace.config,
    gitContext: workspace.gitContext,
  });
  if (freshness.state === 'fresh') {
    return {
      source: prepared.kind === 'local-fresh' ? 'existing' : 'shared-generation',
      service,
    };
  }

  if (service.kind === 'started' || service.kind === 'reused') {
    dependencies.requestRefresh(
      watchServicePaths(workspace.paths.cacheDir).activityPath,
      `evidence command ${workspace.commandName} requires a fresh generation`,
    );
    freshness = await waitForFreshness(workspace, freshness, dependencies, options, service);
    if (freshness.state === 'fresh') return { source: 'watcher', service };
  }

  try {
    await dependencies.reindex(workspace.projectRoot, workspace.config, workspace.paths, {
      allowPartial: false,
      skipAutoInstall: true,
      trigger: { kind: 'watch-demand', detail: `scip-query ${workspace.commandName}` },
      onStatus: () => {},
    });
  } catch (error) {
    throw new Error(
      `Could not prepare fresh evidence for scip-query ${workspace.commandName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  freshness = dependencies.freshness(workspace.projectRoot, workspace.config, workspace.paths);
  if (freshness.state !== 'fresh') {
    throw new Error(
      `Could not prepare fresh evidence for scip-query ${workspace.commandName}: index remained ${freshness.state} (${freshness.reason})`,
    );
  }
  return { source: 'synchronous-reindex', service };
}

function trustedGeneration(
  workspace: EvidenceCommandWorkspace,
  dependencies: EvidenceCommandFreshnessDependencies,
): string | undefined {
  if (workspace.config.watch?.enabled !== true) return undefined;
  try {
    return trustedWatchServiceIndexGeneration(
      dependencies.inspectService({
        projectRoot: workspace.projectRoot,
        cacheDir: workspace.paths.cacheDir,
        cliVersion,
        gitContext: workspace.gitContext,
      }),
    );
  } catch {
    return undefined;
  }
}

async function waitForFreshness(
  workspace: EvidenceCommandWorkspace,
  initial: IndexFreshness,
  dependencies: EvidenceCommandFreshnessDependencies,
  options: { waitMs?: number; pollMs?: number },
  service: Extract<WatchServiceAutoEnsureResult, { kind: 'started' | 'reused' }>,
): Promise<IndexFreshness> {
  if (service.state.watcher.state === 'budget-paused') return initial;
  const waitMs = Math.max(0, options.waitMs ?? DEFAULT_WATCH_REFRESH_WAIT_MS);
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_WATCH_REFRESH_POLL_MS);
  const deadline = dependencies.now() + waitMs;
  let current = initial;
  while (dependencies.now() < deadline) {
    await dependencies.wait(Math.min(pollMs, Math.max(1, deadline - dependencies.now())));
    current = dependencies.freshness(workspace.projectRoot, workspace.config, workspace.paths);
    if (current.state === 'fresh') return current;
  }
  return current;
}
