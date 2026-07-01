import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { FindingSuppression, ProjectConfig, SupportedLanguage, WatchConfig } from '../domain/types.js';

const CONFIG_FILENAME = '.scipquery.json';

const DEFAULT_WATCH: Required<WatchConfig> = {
  enabled: false,
  debounceMs: 30_000,
  cooldownMs: 60_000,
  gitPollMs: 2_000,
  autoRefresh: true,
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
  'clojure',
];

export interface ConfigDiagnostic {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

const ROOT_CONFIG_KEYS = new Set([
  'languages',
  'indexerConcurrency',
  'watch',
  'hooks',
  'indexer',
  'dbPath',
  'entryRoots',
  'semantic',
  'suppressions',
  'declaredCouplings',
  'locality',
]);

const WATCH_CONFIG_KEYS = new Set(['enabled', 'debounceMs', 'cooldownMs', 'gitPollMs', 'autoRefresh', 'ignore']);
const HOOK_CONFIG_KEYS = new Set(['router']);
const ENTRY_ROOTS_CONFIG_KEYS = new Set(['pathPrefixes', 'files', 'symbolPatterns', 'qualifiedVars']);
const SEMANTIC_CONFIG_KEYS = new Set(['typescript']);
const TYPESCRIPT_SEMANTIC_CONFIG_KEYS = new Set(['tsconfigs']);
const INDEXER_CONFIG_KEYS = new Set(SUPPORTED_LANGUAGES);
const INDEXER_OVERRIDE_CONFIG_KEYS = new Set(['pnpmWorkspaces', 'projectMode', 'projects', 'configPath']);
const LOCALITY_CONFIG_KEYS = new Set(['architecturalBoundarySegments']);
const DECLARED_COUPLING_CONFIG_KEYS = new Set(['name', 'files', 'reason']);
const SUPPRESSION_CONFIG_KEYS = new Set(['id', 'check', 'file', 'reason', 'expiresAt']);

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

export function validateProjectConfig(
  config: ProjectConfig,
  opts: { now?: Date; projectRoot?: string } = {},
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  reportUnknownConfigKeys(config, diagnostics);
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
  if (
    config.indexerConcurrency !== undefined &&
    (!Number.isInteger(config.indexerConcurrency) || config.indexerConcurrency <= 0)
  ) {
    diagnostics.push({
      level: 'error',
      path: 'indexerConcurrency',
      message: 'Must be a positive integer.',
    });
  }
  if (config.watch?.debounceMs !== undefined && config.watch.debounceMs <= 0) {
    diagnostics.push({ level: 'error', path: 'watch.debounceMs', message: 'Must be greater than 0.' });
  }
  if (config.watch?.cooldownMs !== undefined && config.watch.cooldownMs <= 0) {
    diagnostics.push({ level: 'error', path: 'watch.cooldownMs', message: 'Must be greater than 0.' });
  }
  if (config.watch?.gitPollMs !== undefined && config.watch.gitPollMs <= 0) {
    diagnostics.push({ level: 'error', path: 'watch.gitPollMs', message: 'Must be greater than 0.' });
  }
  if (config.watch?.autoRefresh !== undefined && typeof config.watch.autoRefresh !== 'boolean') {
    diagnostics.push({ level: 'error', path: 'watch.autoRefresh', message: 'Must be a boolean.' });
  }
  if (config.hooks?.router !== undefined && config.hooks.router !== 'off' && config.hooks.router !== 'single') {
    diagnostics.push({ level: 'error', path: 'hooks.router', message: 'Must be "off" or "single".' });
  }
  const typescriptIndexer = config.indexer?.typescript;
  if (
    typescriptIndexer?.projectMode !== undefined &&
    typescriptIndexer.projectMode !== 'single' &&
    typescriptIndexer.projectMode !== 'workspace'
  ) {
    diagnostics.push({
      level: 'error',
      path: 'indexer.typescript.projectMode',
      message: 'Must be "single" or "workspace".',
    });
  }
  if (typescriptIndexer?.projects !== undefined) {
    if (!Array.isArray(typescriptIndexer.projects)) {
      diagnostics.push({ level: 'error', path: 'indexer.typescript.projects', message: 'Must be an array.' });
    } else {
      for (const [index, project] of typescriptIndexer.projects.entries()) {
        const path = `indexer.typescript.projects[${index}]`;
        if (typeof project !== 'string' || project.trim() === '') {
          diagnostics.push({ level: 'error', path, message: 'Project path must be a non-empty string.' });
        } else if (opts.projectRoot) {
          const resolved = resolve(opts.projectRoot, project);
          const relativePath = relative(opts.projectRoot, resolved);
          if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
            diagnostics.push({ level: 'error', path, message: 'Project path must stay inside the project root.' });
          } else if (!existsSync(resolved)) {
            diagnostics.push({ level: 'warning', path, message: `TypeScript project path does not exist: ${project}` });
          }
        }
      }
    }
  }
  if (typescriptIndexer?.projectMode === 'workspace' && typescriptIndexer.pnpmWorkspaces === true) {
    diagnostics.push({
      level: 'warning',
      path: 'indexer.typescript.pnpmWorkspaces',
      message: 'Ignored when projectMode is "workspace"; explicit TypeScript projects are indexed directly.',
    });
  }
  const clojureIndexer = config.indexer?.clojure;
  if (clojureIndexer?.configPath !== undefined) {
    const path = 'indexer.clojure.configPath';
    if (typeof clojureIndexer.configPath !== 'string' || clojureIndexer.configPath.trim() === '') {
      diagnostics.push({ level: 'error', path, message: 'Config path must be a non-empty string.' });
    } else if (opts.projectRoot) {
      const resolved = resolve(opts.projectRoot, clojureIndexer.configPath);
      const relativePath = relative(opts.projectRoot, resolved);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        diagnostics.push({ level: 'error', path, message: 'Config path must stay inside the project root.' });
      } else if (!existsSync(resolved)) {
        diagnostics.push({
          level: 'warning',
          path,
          message: `Clojure indexer config path does not exist: ${clojureIndexer.configPath}`,
        });
      }
    }
  }
  if (config.locality !== undefined) {
    if (!isConfigObject(config.locality)) {
      diagnostics.push({ level: 'error', path: 'locality', message: 'Must be an object.' });
    } else {
      const segments = config.locality.architecturalBoundarySegments as unknown;
      if (segments !== undefined) {
        if (!Array.isArray(segments)) {
          diagnostics.push({
            level: 'error',
            path: 'locality.architecturalBoundarySegments',
            message: 'Must be an array.',
          });
        } else {
          for (const [index, segment] of segments.entries()) {
            const path = `locality.architecturalBoundarySegments[${index}]`;
            if (typeof segment !== 'string' || segment.trim() === '') {
              diagnostics.push({
                level: 'error',
                path,
                message: 'Boundary segment must be a non-empty string.',
              });
            } else if (segment.includes('/') || segment.includes('\\')) {
              diagnostics.push({
                level: 'error',
                path,
                message: 'Boundary segment must be a single folder name, not a path.',
              });
            }
          }
        }
      }
    }
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
          } else if (opts.projectRoot && !existsSync(join(opts.projectRoot, file))) {
            diagnostics.push({
              level: 'warning',
              path: `${path}.files[${fileIndex}]`,
              message: `Declared coupling file does not exist: ${file}`,
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
  if (config.suppressions !== undefined && !Array.isArray(config.suppressions)) {
    diagnostics.push({ level: 'error', path: 'suppressions', message: 'Must be an array.' });
  }
  for (const [index, suppression] of (Array.isArray(config.suppressions) ? config.suppressions : []).entries()) {
    const path = `suppressions[${index}]`;
    if (!isConfigObject(suppression)) {
      diagnostics.push({ level: 'error', path, message: 'Suppression must be an object.' });
      continue;
    }
    if (!suppression.reason || suppression.reason.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.reason`, message: 'Suppression reason is required.' });
    }
    if (suppression.id !== undefined && suppression.id.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.id`, message: 'Suppression id cannot be blank.' });
    }
    if (suppression.check !== undefined && suppression.check.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.check`, message: 'Suppression check cannot be blank.' });
    }
    if (!suppression.id && (!suppression.check || !suppression.file)) {
      diagnostics.push({ level: 'error', path, message: 'Suppression must include id or both check and file.' });
    } else if (!suppression.id && suppression.check && suppression.file) {
      diagnostics.push({
        level: 'warning',
        path,
        message:
          'Check+file suppressions waive every matching finding in that file; prefer a stable id when available.',
      });
    }
    if (suppression.file !== undefined) {
      if (suppression.file.trim() === '') {
        diagnostics.push({ level: 'error', path: `${path}.file`, message: 'Suppression file path cannot be blank.' });
      } else if (opts.projectRoot && !existsSync(join(opts.projectRoot, suppression.file))) {
        diagnostics.push({
          level: 'warning',
          path: `${path}.file`,
          message: `Suppression file does not exist: ${suppression.file}`,
        });
      }
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
      gitPollMs: 2_000,
      autoRefresh: true,
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
  const errors = validateProjectConfig(next, { projectRoot }).filter((diagnostic) => diagnostic.level === 'error');
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

function reportUnknownConfigKeys(config: ProjectConfig, diagnostics: ConfigDiagnostic[]): void {
  if (!isConfigObject(config as unknown)) return;
  const typedConfig = config as ProjectConfig;
  reportUnknownObjectKeys(diagnostics, typedConfig, '', ROOT_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.watch, 'watch', WATCH_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.hooks, 'hooks', HOOK_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.entryRoots, 'entryRoots', ENTRY_ROOTS_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.semantic, 'semantic', SEMANTIC_CONFIG_KEYS);
  reportUnknownObjectKeys(
    diagnostics,
    typedConfig.semantic?.typescript,
    'semantic.typescript',
    TYPESCRIPT_SEMANTIC_CONFIG_KEYS,
  );
  reportUnknownObjectKeys(diagnostics, typedConfig.locality, 'locality', LOCALITY_CONFIG_KEYS);

  if (isConfigObject(typedConfig.indexer)) {
    reportUnknownObjectKeys(diagnostics, typedConfig.indexer, 'indexer', INDEXER_CONFIG_KEYS);
    for (const [language, override] of Object.entries(typedConfig.indexer)) {
      if (INDEXER_CONFIG_KEYS.has(language as SupportedLanguage)) {
        reportUnknownObjectKeys(diagnostics, override, `indexer.${language}`, INDEXER_OVERRIDE_CONFIG_KEYS);
      }
    }
  }

  if (Array.isArray(typedConfig.declaredCouplings)) {
    for (const [index, coupling] of typedConfig.declaredCouplings.entries()) {
      reportUnknownObjectKeys(diagnostics, coupling, `declaredCouplings[${index}]`, DECLARED_COUPLING_CONFIG_KEYS);
    }
  }

  if (Array.isArray(typedConfig.suppressions)) {
    for (const [index, suppression] of typedConfig.suppressions.entries()) {
      reportUnknownObjectKeys(diagnostics, suppression, `suppressions[${index}]`, SUPPRESSION_CONFIG_KEYS);
    }
  }
}

function reportUnknownObjectKeys(
  diagnostics: ConfigDiagnostic[],
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
): void {
  if (!isConfigObject(value)) return;
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    diagnostics.push({
      level: 'warning',
      path: path ? `${path}.${key}` : key,
      message: 'Unknown config key.',
    });
  }
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
