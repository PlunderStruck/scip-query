import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { ScipDatabase } from '../storage/db.js';
import { createGitignoreFilter } from '../source/primitives/gitignore-filter.js';
import { loadProjectConfig } from './config.js';
import type { ProjectConfig, ScipQueryConfig, WatcherStatus } from '../domain/types.js';
import { getIndexFreshness, type IndexFreshness } from './index-freshness.js';
import type { GitWorktreeContext, GitWorktreeContextObservation } from '../platform/git-worktree.js';
import { withProjectFileListingCache } from '../platform/project-file-inventory-context.js';
import { publishedGenerationIdentity } from '../semantic/typescript/session-protocol.js';
import { readSuppressionDir } from '../storage/suppression-store.js';
import {
  prepareSharedGenerationForProject,
  publishFreshLocalGenerationForProject,
  type SharedCacheAction,
  resolveSharedEvidenceDbPath,
} from '../reindex/shared-generation-store.js';

export function resolveProjectRoot(): string {
  return process.env['SCIP_QUERY_PROJECT_ROOT'] ?? process.cwd();
}

export interface CliProjectContext {
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof resolveIndexStoragePaths>;
  dbPath: string;
  dbPathSource: 'env' | 'configured' | 'root-fallback';
  rootFallbackWarning?: string;
  gitContext?: GitWorktreeContext;
}

export type WorktreeIndexPreparation =
  | (Extract<SharedCacheAction, { kind: 'local-fresh' }> & { freshness?: IndexFreshness })
  | Exclude<SharedCacheAction, { kind: 'local-fresh' }>;

let activeCliProjectContext: CliProjectContext | undefined;
let activeCliDatabase: ScipDatabase | undefined;

export function activateCliProjectContext(context: CliProjectContext | undefined): void {
  activeCliProjectContext = context;
}

export function currentCliDatabase(): ScipDatabase | undefined {
  return activeCliDatabase;
}

export function resolveCliProjectContext(
  projectRoot = resolveProjectRoot(),
  gitContext: GitWorktreeContext | undefined = undefined,
): CliProjectContext {
  if (gitContext === undefined && activeCliProjectContext?.projectRoot === projectRoot) {
    return activeCliProjectContext;
  }
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
  const envDbPath = process.env['SCIP_QUERY_INDEX_DB'];
  if (envDbPath) return { projectRoot, config, paths, dbPath: envDbPath, dbPathSource: 'env', gitContext };
  if (existsSync(paths.dbPath)) {
    return { projectRoot, config, paths, dbPath: paths.dbPath, dbPathSource: 'configured', gitContext };
  }

  const dbPath = join(projectRoot, 'index.db');
  return {
    projectRoot,
    config,
    paths,
    dbPath,
    dbPathSource: 'root-fallback',
    rootFallbackWarning: rootIndexFallbackWarning(dbPath, paths.dbPath),
    gitContext,
  };
}

export function resolveActiveDbPath(projectRoot: string): string {
  return resolveCliProjectContext(projectRoot).dbPath;
}

export function prepareWorktreeIndex(
  projectRoot: string,
  config: ProjectConfig,
  paths: ReturnType<typeof resolveIndexStoragePaths>,
  opts: {
    gitContext?: GitWorktreeContext;
    gitObservation?: GitWorktreeContextObservation;
    watcherGeneration?: string;
  } = {},
): WorktreeIndexPreparation {
  if (
    existsSync(paths.dbPath) &&
    opts.gitContext?.clean === false &&
    opts.watcherGeneration !== undefined &&
    publishedGenerationIdentity(paths.dbPath) === opts.watcherGeneration
  ) {
    return publishFreshLocalGenerationForProject(projectRoot, config, paths, opts.gitContext);
  }
  const freshness = getIndexFreshness(projectRoot, config, paths, {
    gitContext: opts.gitContext,
    gitObservation: opts.gitObservation,
  });
  if (freshness.state === 'fresh') {
    return { kind: 'local-fresh', freshness };
  }
  return prepareSharedGenerationForProject(projectRoot, config, paths, opts.gitContext);
}

export function sharedCachePreparationEligible(commandName: string): boolean {
  return !commandName.startsWith('__') && !SHARED_CACHE_PREPARATION_EXCLUDED_COMMANDS.has(commandName);
}

const SHARED_CACHE_PREPARATION_EXCLUDED_COMMANDS = new Set([
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

export function openDb(): ScipDatabase {
  try {
    return openProjectDb(resolveProjectRoot(), { warnOnRootFallback: true });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export function openProjectDb(projectRoot: string, opts: { warnOnRootFallback?: boolean } = {}): ScipDatabase {
  const { config, paths, dbPath, dbPathSource, rootFallbackWarning, gitContext } =
    resolveCliProjectContext(projectRoot);

  if (!existsSync(dbPath)) throw new Error('No index.db found. Run: scip-query reindex');
  if (opts.warnOnRootFallback && dbPathSource === 'root-fallback' && rootFallbackWarning)
    console.error(rootFallbackWarning);

  const repositorySuppressions = readSuppressionDir(projectRoot).suppressions;
  const dbConfig: ScipQueryConfig = {
    dbPath,
    indexPath: process.env['SCIP_QUERY_INDEX_SCIP'] ?? paths.indexPath,
    projectRoot,
    collaborationDomainId: config.collaborationDomainId,
    sharedEvidenceDbPath: resolveSharedEvidenceDbPath(projectRoot, config, gitContext),
    entryRoots: config.entryRoots,
    semantic: config.semantic,
    suppressions: [...(config.suppressions ?? []), ...repositorySuppressions],
    declaredCouplings: config.declaredCouplings,
    locality: config.locality,
    architecture: config.architecture,
    coverageContracts: config.coverageContracts,
    docs: config.docs,
  };

  const filter = createGitignoreFilter(projectRoot);
  return new ScipDatabase(dbConfig, filter);
}

export function rootIndexFallbackWarning(dbPath: string, configuredDbPath: string): string {
  let builtAt = 'unknown time';
  try {
    builtAt = statSync(dbPath).mtime.toISOString();
  } catch {
    // The caller may be about to emit the missing-index error; keep this best-effort.
  }
  return `warning: using legacy project-root index.db (${dbPath}, modified ${builtAt}) because the configured index was not found at ${configuredDbPath}. This fallback may be stale; run 'scip-query reindex' to refresh the configured index.`;
}

export function withDb<T>(run: (db: ScipDatabase) => T): T {
  return withProjectFileListingCache(() => {
    const db = openDb();
    const previous = activeCliDatabase;
    activeCliDatabase = db;
    try {
      return run(db);
    } finally {
      activeCliDatabase = previous;
      db.close();
    }
  });
}

export function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatStatus(status: WatcherStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Watching (idle)';
    case 'waiting': {
      const secs = Math.round((status.reindexAt - Date.now()) / 1000);
      return `${status.changedFiles} file(s) changed, reindexing in ${secs}s...`;
    }
    case 'indexing':
      return `Reindexing... (${Math.round((Date.now() - status.startedAt) / 1000)}s)`;
    case 'cooldown': {
      const secs = Math.round((status.until - Date.now()) / 1000);
      return `Cooldown (${secs}s)${status.dirty ? ' — changes pending' : ''}`;
    }
    case 'budget-paused': {
      const secs = Math.max(0, Math.round((status.until - Date.now()) / 1000));
      return (
        `Automatic reindex paused by resource budget (${secs}s; ${status.reason}; ` +
        `${status.rebuilt} rebuilds, ${formatBytes(status.estimatedWriteBytes)} estimated writes)` +
        `${status.dirty ? ' — changes pending' : ''}`
      );
    }
    case 'draining':
      return `Stopping safely — ${status.reason}`;
    default:
      return assertNever(status);
  }
}

// scip-query: ignore-twin — exhaustive guards belong to their individual discriminated unions.
function assertNever(value: never): never {
  throw new Error(`Unhandled watcher status: ${JSON.stringify(value)}`);
}
