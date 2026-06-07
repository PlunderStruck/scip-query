import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ScipDatabase } from '../storage/db.js';
import { createGitignoreFilter } from '../source/gitignore-filter.js';
import { loadProjectConfig, resolveIndexPaths } from './config.js';
import * as queries from '../queries/index.js';
import type { ProjectConfig, ScipQueryConfig, WatcherStatus } from '../domain/types.js';

export { queries };

export function resolveProjectRoot(): string {
  return process.env['SCIP_QUERY_PROJECT_ROOT'] ?? process.cwd();
}

interface CliProjectContext {
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof resolveIndexPaths>;
  dbPath: string;
}

export function resolveCliProjectContext(projectRoot = resolveProjectRoot()): CliProjectContext {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  const dbPath = process.env['SCIP_QUERY_INDEX_DB']
    ?? (existsSync(paths.dbPath) ? paths.dbPath : join(projectRoot, 'index.db'));
  return { projectRoot, config, paths, dbPath };
}

export function resolveActiveDbPath(projectRoot: string): string {
  return resolveCliProjectContext(projectRoot).dbPath;
}

export function openDb(): ScipDatabase {
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();

  if (!existsSync(dbPath)) {
    console.error(`error: No index.db found. Run: scip-query reindex`);
    process.exit(1);
  }

  const dbConfig: ScipQueryConfig = {
    dbPath,
    indexPath: process.env['SCIP_QUERY_INDEX_SCIP'] ?? paths.indexPath,
    projectRoot,
    entryRoots: config.entryRoots,
    semantic: config.semantic,
  };

  const filter = createGitignoreFilter(projectRoot);
  return new ScipDatabase(dbConfig, filter);
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

/** parseInt wrapper safe for commander (which passes default as 2nd arg = radix) */
export function parseIntSafe(value: string): number {
  return parseInt(value, 10);
}

export function parsePositiveInt(value: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
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

function assertNever(value: never): never {
  throw new Error(`Unhandled watcher status: ${JSON.stringify(value)}`);
}
