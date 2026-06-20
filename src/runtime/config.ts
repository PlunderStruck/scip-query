import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { FindingSuppression, ProjectConfig, SupportedLanguage, WatchConfig } from '../domain/types.js';

const CONFIG_FILENAME = '.scipquery.json';

const DEFAULT_WATCH: Required<WatchConfig> = {
  enabled: false,
  debounceMs: 30_000,
  cooldownMs: 60_000,
  ignore: [],
};

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'typescript',
  'javascript',
  'java',
  'scala',
  'kotlin',
  'rust',
  'python',
  'ruby',
  'go',
  'cpp',
  'c',
  'csharp',
  'vb',
  'dart',
  'php',
];

export interface ConfigDiagnostic {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

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
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof SyntaxError) {
      throw new Error(`invalid ${CONFIG_FILENAME} at ${configPath}: ${reason}`, { cause: err });
    }
    throw new Error(`unable to read ${CONFIG_FILENAME} at ${configPath}: ${reason}`, { cause: err });
  }
}

export function validateProjectConfig(config: ProjectConfig, opts: { now?: Date } = {}): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const supported = new Set(SUPPORTED_LANGUAGES);
  for (const [index, language] of (config.languages ?? []).entries()) {
    if (!supported.has(language)) {
      diagnostics.push({
        level: 'error',
        path: `languages[${index}]`,
        message: `Unsupported language: ${language}`,
      });
    }
  }
  if (config.watch?.debounceMs !== undefined && config.watch.debounceMs <= 0) {
    diagnostics.push({ level: 'error', path: 'watch.debounceMs', message: 'Must be greater than 0.' });
  }
  if (config.watch?.cooldownMs !== undefined && config.watch.cooldownMs <= 0) {
    diagnostics.push({ level: 'error', path: 'watch.cooldownMs', message: 'Must be greater than 0.' });
  }
  if (config.declaredCouplings !== undefined && !Array.isArray(config.declaredCouplings)) {
    diagnostics.push({ level: 'error', path: 'declaredCouplings', message: 'Must be an array.' });
  } else {
    for (const [index, coupling] of (config.declaredCouplings ?? []).entries()) {
      const path = `declaredCouplings[${index}]`;
      if (!coupling.name || coupling.name.trim() === '') {
        diagnostics.push({ level: 'error', path: `${path}.name`, message: 'Declared coupling name is required.' });
      }
      if (!Array.isArray(coupling.files) || coupling.files.length < 2) {
        diagnostics.push({
          level: 'error',
          path: `${path}.files`,
          message: 'Declared coupling needs at least two files.',
        });
      } else {
        for (const [fileIndex, file] of coupling.files.entries()) {
          if (!file || file.trim() === '') {
            diagnostics.push({
              level: 'error',
              path: `${path}.files[${fileIndex}]`,
              message: 'Declared coupling file path is required.',
            });
          }
        }
      }
      if (coupling.reason !== undefined && coupling.reason.trim() === '') {
        diagnostics.push({
          level: 'error',
          path: `${path}.reason`,
          message: 'Declared coupling reason cannot be blank.',
        });
      }
    }
  }
  const now = opts.now ?? new Date();
  for (const [index, suppression] of (config.suppressions ?? []).entries()) {
    const path = `suppressions[${index}]`;
    if (!suppression.reason || suppression.reason.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.reason`, message: 'Suppression reason is required.' });
    }
    if (!suppression.id && !suppression.check) {
      diagnostics.push({ level: 'error', path, message: 'Suppression must include id or check.' });
    }
    if (suppression.expiresAt) {
      const expires = Date.parse(suppression.expiresAt);
      if (Number.isNaN(expires)) {
        diagnostics.push({ level: 'error', path: `${path}.expiresAt`, message: 'Must be an ISO date string.' });
      } else if (expires <= now.getTime()) {
        diagnostics.push({ level: 'warning', path: `${path}.expiresAt`, message: 'Suppression has expired.' });
      }
    }
  }
  return diagnostics;
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
  const projectHash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 12);

  const dir = join(cacheBase, 'scip-query', 'projects', projectHash);
  return ensureDir(dir);
}

/**
 * Resolve all paths for a project's index files.
 */
export function resolveIndexPaths(
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

export function addFindingSuppression(
  projectRoot: string,
  suppression: FindingSuppression,
): { path: string; suppressionCount: number } {
  const configPath = join(projectRoot, CONFIG_FILENAME);
  const config = loadProjectConfig(projectRoot);
  const next: ProjectConfig = {
    ...config,
    suppressions: [...(config.suppressions ?? []), suppression],
  };
  const errors = validateProjectConfig(next).filter((diagnostic) => diagnostic.level === 'error');
  if (errors.length > 0) {
    const detail = errors.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; ');
    throw new Error(`invalid suppression: ${detail}`);
  }
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  return { path: configPath, suppressionCount: next.suppressions?.length ?? 0 };
}

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
