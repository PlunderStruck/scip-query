import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { ProjectConfig, WatchConfig } from './types.js';

const CONFIG_FILENAME = '.scipquery.json';

const DEFAULT_WATCH: Required<WatchConfig> = {
  enabled: false,
  debounceMs: 30_000,
  cooldownMs: 60_000,
  ignore: [],
};

/**
 * Load project config from .scipquery.json in the project root.
 * Returns defaults for anything not specified.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return {};
  }
}

/** Resolve watch config with defaults applied */
export function resolveWatchConfig(config: ProjectConfig): Required<WatchConfig> {
  return {
    ...DEFAULT_WATCH,
    ...config.watch,
  };
}

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
  const xdgCache = process.env['XDG_CACHE_HOME'];
  const cacheBase = xdgCache || join(homedir(), '.cache');
  const projectHash = createHash('sha256')
    .update(resolve(projectRoot))
    .digest('hex')
    .slice(0, 12);

  const dir = join(cacheBase, 'scip-query', 'projects', projectHash);
  return ensureDir(dir);
}

/**
 * Resolve all paths for a project's index files.
 */
export function resolveIndexPaths(projectRoot: string, config?: ProjectConfig): {
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

/**
 * Scaffold a default .scipquery.json in the project root.
 * Does not overwrite an existing config.
 */
export function initProjectConfig(projectRoot: string, languages: string[]): string {
  const configPath = join(projectRoot, CONFIG_FILENAME);

  if (existsSync(configPath)) {
    return configPath;
  }

  const config: ProjectConfig = {
    languages: languages as ProjectConfig['languages'],
    watch: {
      enabled: false,
      debounceMs: 30_000,
      cooldownMs: 60_000,
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
