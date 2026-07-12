import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ScipDatabase } from '../storage/db.js';
import { createGitignoreFilter } from '../source/gitignore-filter.js';
import { loadProjectConfig, resolveIndexStoragePaths } from './config.js';
import type { ProjectConfig, ScipQueryConfig, WatcherStatus } from '../domain/types.js';

export function resolveProjectRoot(): string {
  return process.env['SCIP_QUERY_PROJECT_ROOT'] ?? process.cwd();
}

interface CliProjectContext {
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof resolveIndexStoragePaths>;
  dbPath: string;
  dbPathSource: 'env' | 'configured' | 'root-fallback';
  rootFallbackWarning?: string;
}

export function resolveCliProjectContext(projectRoot = resolveProjectRoot()): CliProjectContext {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
  const envDbPath = process.env['SCIP_QUERY_INDEX_DB'];
  if (envDbPath) return { projectRoot, config, paths, dbPath: envDbPath, dbPathSource: 'env' };
  if (existsSync(paths.dbPath)) return { projectRoot, config, paths, dbPath: paths.dbPath, dbPathSource: 'configured' };

  const dbPath = join(projectRoot, 'index.db');
  return {
    projectRoot,
    config,
    paths,
    dbPath,
    dbPathSource: 'root-fallback',
    rootFallbackWarning: rootIndexFallbackWarning(dbPath, paths.dbPath),
  };
}

export function resolveActiveDbPath(projectRoot: string): string {
  return resolveCliProjectContext(projectRoot).dbPath;
}

export function openDb(): ScipDatabase {
  try {
    return openProjectDb(resolveProjectRoot(), { warnOnRootFallback: true });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export function openProjectDb(projectRoot: string, opts: { warnOnRootFallback?: boolean } = {}): ScipDatabase {
  const { config, paths, dbPath, dbPathSource, rootFallbackWarning } = resolveCliProjectContext(projectRoot);

  if (!existsSync(dbPath)) throw new Error('No index.db found. Run: scip-query reindex');
  if (opts.warnOnRootFallback && dbPathSource === 'root-fallback' && rootFallbackWarning)
    console.error(rootFallbackWarning);

  const dbConfig: ScipQueryConfig = {
    dbPath,
    indexPath: process.env['SCIP_QUERY_INDEX_SCIP'] ?? paths.indexPath,
    projectRoot,
    entryRoots: config.entryRoots,
    semantic: config.semantic,
    suppressions: config.suppressions,
    declaredCouplings: config.declaredCouplings,
    locality: config.locality,
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
  const db = openDb();
  try {
    return run(db);
  } finally {
    db.close();
  }
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
    default:
      return assertNever(status);
  }
}

// scip-query: ignore-twin — exhaustive guards belong to their individual discriminated unions.
function assertNever(value: never): never {
  throw new Error(`Unhandled watcher status: ${JSON.stringify(value)}`);
}
