import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from '../domain/types.js';

/**
 * Resolve the cache directory for a project's SCIP index.
 *
 * Default: ~/.cache/scip-query/projects/<hash>/
 * Override: project config dbPath, or SCIP_QUERY_DB_PATH env var
 *
 * The hash is derived from the absolute project path so each
 * project gets its own isolated index storage.
 */
export function resolveCacheDir(projectRoot: string, config?: ProjectConfig): string {
  // CLI/env override
  const envOverride = process.env['SCIP_QUERY_CACHE_DIR'];
  if (envOverride) return ensureDir(envOverride);

  // Project config override
  if (config?.dbPath) return ensureDir(resolve(projectRoot, config.dbPath));

  // Default: XDG cache dir / fallback to ~/.cache
  const dir = resolveDefaultCacheDir(projectRoot);
  return ensureDir(dir);
}

export function resolveScipQueryCacheRoot(): string {
  const xdgCache = process.env['XDG_CACHE_HOME'];
  return join(xdgCache || join(homedir(), '.cache'), 'scip-query');
}

export function resolveDefaultCacheDir(projectRoot: string): string {
  let canonicalRoot = resolve(projectRoot);
  try {
    canonicalRoot = realpathSync(canonicalRoot);
  } catch {
    // Setup can resolve storage before the project directory exists.
  }
  const projectHash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  return join(resolveScipQueryCacheRoot(), 'projects', projectHash);
}

export function resolveRepositoryCacheDir(repositoryId: string): string {
  if (!/^[a-f0-9]{24}$/.test(repositoryId)) throw new Error(`invalid repository cache identity: ${repositoryId}`);
  return join(resolveScipQueryCacheRoot(), 'repositories', repositoryId);
}

export function automaticSharedCacheEnabled(config?: ProjectConfig): boolean {
  return (
    process.env['SCIP_QUERY_SHARED_CACHE'] !== '0' &&
    !process.env['SCIP_QUERY_CACHE_DIR'] &&
    !process.env['SCIP_QUERY_INDEX_DB'] &&
    !config?.dbPath
  );
}

/**
 * Resolve all storage paths for a project's index files (cache dir, SQLite
 * db, .scip index, meta.json). Distinct from queries/internal/file-resolution.ts's
 * resolveIndexedPaths, which resolves a file-pattern query against the
 * already-indexed documents table -- a different job that happens to share
 * "resolve" + "index" + "paths" vocabulary.
 */
export function resolveIndexStoragePaths(
  projectRoot: string,
  config?: ProjectConfig,
): {
  cacheDir: string;
  dbPath: string;
  indexPath: string;
  metaPath: string;
} {
  const cacheDir = resolveCacheDir(projectRoot, config);
  return {
    cacheDir,
    dbPath: join(cacheDir, 'index.db'),
    indexPath: join(cacheDir, 'index.scip'),
    metaPath: join(cacheDir, 'meta.json'),
  };
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
