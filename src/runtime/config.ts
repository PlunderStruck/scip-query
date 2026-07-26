import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SUPPORTED_LANGUAGES } from '../domain/config-types.js';
import { isRecordObject } from '../domain/record-validation.js';
import type { ProjectConfig, SupportedLanguage, WatchConfig } from '../domain/types.js';
import {
  FileContentConflictError,
  mutateTextFileRevisionAware,
  type RevisionedTextSnapshot,
} from './revisioned-file.js';

const CONFIG_FILENAME = '.scipquery.json';
const DEFAULT_WATCH_DEBOUNCE_MS = 250;
const DEFAULT_WATCH_COOLDOWN_MS = 0;
const DEFAULT_WATCH_IDLE_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_WATCH: Required<WatchConfig> = {
  enabled: false,
  debounceMs: DEFAULT_WATCH_DEBOUNCE_MS,
  cooldownMs: DEFAULT_WATCH_COOLDOWN_MS,
  gitPollMs: 2_000,
  idleTimeoutMs: DEFAULT_WATCH_IDLE_TIMEOUT_MS,
  autoRefresh: true,
  ignore: [],
};

export { SUPPORTED_LANGUAGES };

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
  'architecture',
  'coverageContracts',
  'docs',
]);

const WATCH_CONFIG_KEYS = new Set([
  'enabled',
  'debounceMs',
  'cooldownMs',
  'gitPollMs',
  'idleTimeoutMs',
  'autoRefresh',
  'ignore',
]);
const HOOK_CONFIG_KEYS = new Set(['router']);
const ENTRY_ROOTS_CONFIG_KEYS = new Set(['pathPrefixes', 'files', 'symbolPatterns', 'qualifiedVars']);
const SEMANTIC_CONFIG_KEYS = new Set(['typescript', 'rust']);
const TYPESCRIPT_SEMANTIC_CONFIG_KEYS = new Set(['tsconfigs']);
const RUST_SEMANTIC_CONFIG_KEYS = new Set(['rustAnalyzerPath']);
const INDEXER_CONFIG_KEYS = new Set(SUPPORTED_LANGUAGES);
const INDEXER_OVERRIDE_CONFIG_KEYS = new Set(['pnpmWorkspaces', 'projectMode', 'projects', 'configPath']);
const LOCALITY_CONFIG_KEYS = new Set(['architecturalBoundarySegments']);
const ARCHITECTURE_CONFIG_KEYS = new Set([
  'boundaries',
  'allowedDependencies',
  'requireCompletePolicy',
  'requireAcyclic',
  'requireResolvedBoundaries',
  'requireMinimalPolicy',
  'maxBoundaryFanOut',
  'maxBoundaryFiles',
  'testPaths',
]);
const ARCHITECTURE_BOUNDARY_CONFIG_KEYS = new Set(['name', 'paths', 'subUnits', 'maxFiles']);
const DOCS_CONFIG_KEYS = new Set(['snapshotPaths']);
const DECLARED_COUPLING_CONFIG_KEYS = new Set(['name', 'files', 'reason']);
const SUPPRESSION_CONFIG_KEYS = new Set(['id', 'check', 'file', 'reason', 'expiresAt', 'createdAt']);
const COVERAGE_CONTRACT_CONFIG_KEYS = new Set(['name', 'file', 'keys', 'mustEqual', 'allowExtra']);
const COVERAGE_CONTRACT_KEY_SPEC_KEYS = new Set(['type', 'identifier', 'marker']);
const COVERAGE_CONTRACT_SOURCE_SPEC_KEYS = new Set(['type', 'path', 'pattern']);
const COVERAGE_CONTRACT_KEY_SPEC_TYPES = new Set(['object-literal-keys', 'string-array', 'markdown-list']);
const COVERAGE_CONTRACT_SOURCE_SPEC_TYPES = new Set([
  'top-level-dirs',
  'file-glob',
  'registered-commands',
  'builtin-skills',
]);

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
  if (
    config.watch?.cooldownMs !== undefined &&
    (!Number.isInteger(config.watch.cooldownMs) || config.watch.cooldownMs < 0)
  ) {
    diagnostics.push({
      level: 'error',
      path: 'watch.cooldownMs',
      message: 'Must be a non-negative integer; 0 disables cooldown spacing.',
    });
  }
  if (config.watch?.gitPollMs !== undefined && config.watch.gitPollMs <= 0) {
    diagnostics.push({ level: 'error', path: 'watch.gitPollMs', message: 'Must be greater than 0.' });
  }
  if (
    config.watch?.idleTimeoutMs !== undefined &&
    (!Number.isInteger(config.watch.idleTimeoutMs) || config.watch.idleTimeoutMs < 0)
  ) {
    diagnostics.push({
      level: 'error',
      path: 'watch.idleTimeoutMs',
      message: 'Must be a non-negative integer; 0 disables idle shutdown.',
    });
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
  const rustSemantic = config.semantic?.rust;
  if (
    rustSemantic?.rustAnalyzerPath !== undefined &&
    (typeof rustSemantic.rustAnalyzerPath !== 'string' || rustSemantic.rustAnalyzerPath.trim() === '')
  ) {
    diagnostics.push({
      level: 'error',
      path: 'semantic.rust.rustAnalyzerPath',
      message: 'Rust analyzer path must be a non-empty string.',
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
    if (!isRecordObject(config.locality)) {
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
  validateArchitectureConfig(config, diagnostics);
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
    if (!isRecordObject(suppression)) {
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
  validateCoverageContracts(config, diagnostics, opts);
  validateDocsConfig(config, diagnostics);
  return diagnostics;
}

function validateArchitectureConfig(config: ProjectConfig, diagnostics: ConfigDiagnostic[]): void {
  if (config.architecture === undefined) return;
  if (!isRecordObject(config.architecture)) {
    diagnostics.push({ level: 'error', path: 'architecture', message: 'Must be an object.' });
    return;
  }

  const rawBoundaries = config.architecture.boundaries as unknown;
  if (!Array.isArray(rawBoundaries) || rawBoundaries.length === 0) {
    diagnostics.push({
      level: 'error',
      path: 'architecture.boundaries',
      message: 'Must be a non-empty array.',
    });
    return;
  }

  const boundaryNames = new Set<string>();
  const boundaryPaths = new Set<string>();
  for (const [index, rawBoundary] of rawBoundaries.entries()) {
    const path = `architecture.boundaries[${index}]`;
    if (!isRecordObject(rawBoundary)) {
      diagnostics.push({ level: 'error', path, message: 'Architecture boundary must be an object.' });
      continue;
    }

    const name = rawBoundary.name;
    if (typeof name !== 'string' || name.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.name`, message: 'Boundary name is required.' });
    } else if (boundaryNames.has(name)) {
      diagnostics.push({ level: 'error', path: `${path}.name`, message: `Duplicate boundary name: ${name}` });
    } else {
      boundaryNames.add(name);
    }

    // Validated as a closed set: detection treats every unrecognized value as
    // directory granularity, so an unchecked typo (`"files"`) would silently
    // disable the same-directory cycle enforcement this option exists to turn on.
    const subUnits = rawBoundary.subUnits;
    if (subUnits !== undefined && subUnits !== 'directory' && subUnits !== 'file') {
      diagnostics.push({
        level: 'error',
        path: `${path}.subUnits`,
        message: "Must be 'directory' or 'file'.",
      });
    }
    const maxFiles = rawBoundary.maxFiles;
    if (maxFiles !== undefined && (typeof maxFiles !== 'number' || !Number.isInteger(maxFiles) || maxFiles < 0)) {
      diagnostics.push({
        level: 'error',
        path: `${path}.maxFiles`,
        message: 'Must be a non-negative integer.',
      });
    }

    const paths = rawBoundary.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      diagnostics.push({
        level: 'error',
        path: `${path}.paths`,
        message: 'Boundary paths must be a non-empty array.',
      });
      continue;
    }
    for (const [pathIndex, pattern] of paths.entries()) {
      const patternPath = `${path}.paths[${pathIndex}]`;
      if (typeof pattern !== 'string' || pattern.trim() === '') {
        diagnostics.push({ level: 'error', path: patternPath, message: 'Boundary path must be a non-empty string.' });
        continue;
      }
      if (!isSupportedArchitecturePath(pattern)) {
        diagnostics.push({
          level: 'error',
          path: patternPath,
          message: 'Boundary path must be project-relative and may use only one trailing /* or /** glob.',
        });
      }
      if (boundaryPaths.has(pattern)) {
        diagnostics.push({ level: 'error', path: patternPath, message: `Duplicate boundary path: ${pattern}` });
      } else {
        boundaryPaths.add(pattern);
      }
    }
  }

  const allowedDependencies = config.architecture.allowedDependencies as unknown;
  if (allowedDependencies !== undefined && !isRecordObject(allowedDependencies)) {
    diagnostics.push({
      level: 'error',
      path: 'architecture.allowedDependencies',
      message: 'Must be an object keyed by boundary name.',
    });
  } else if (isRecordObject(allowedDependencies)) {
    for (const [fromBoundary, rawTargets] of Object.entries(allowedDependencies)) {
      const rowPath = `architecture.allowedDependencies.${fromBoundary}`;
      if (!boundaryNames.has(fromBoundary)) {
        diagnostics.push({
          level: 'error',
          path: rowPath,
          message: `Unknown source boundary: ${fromBoundary}`,
        });
      }
      if (!Array.isArray(rawTargets)) {
        diagnostics.push({ level: 'error', path: rowPath, message: 'Dependency row must be an array.' });
        continue;
      }
      const seenTargets = new Set<string>();
      for (const [targetIndex, target] of rawTargets.entries()) {
        const targetPath = `${rowPath}[${targetIndex}]`;
        if (typeof target !== 'string' || target.trim() === '') {
          diagnostics.push({ level: 'error', path: targetPath, message: 'Target boundary name is required.' });
        } else if (!boundaryNames.has(target)) {
          diagnostics.push({ level: 'error', path: targetPath, message: `Unknown target boundary: ${target}` });
        } else if (seenTargets.has(target)) {
          diagnostics.push({ level: 'error', path: targetPath, message: `Duplicate target boundary: ${target}` });
        } else {
          seenTargets.add(target);
        }
      }
    }
  }

  if (config.architecture.requireAcyclic !== undefined && typeof config.architecture.requireAcyclic !== 'boolean') {
    diagnostics.push({ level: 'error', path: 'architecture.requireAcyclic', message: 'Must be a boolean.' });
  }
  for (const flag of ['requireResolvedBoundaries', 'requireMinimalPolicy'] as const) {
    if (config.architecture[flag] !== undefined && typeof config.architecture[flag] !== 'boolean') {
      diagnostics.push({ level: 'error', path: `architecture.${flag}`, message: 'Must be a boolean.' });
    }
  }
  for (const limit of ['maxBoundaryFanOut', 'maxBoundaryFiles'] as const) {
    const value = config.architecture[limit];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
      diagnostics.push({ level: 'error', path: `architecture.${limit}`, message: 'Must be a non-negative integer.' });
    }
  }
  const testPaths = config.architecture.testPaths as unknown;
  if (testPaths !== undefined && (!Array.isArray(testPaths) || testPaths.some((p) => typeof p !== 'string'))) {
    diagnostics.push({ level: 'error', path: 'architecture.testPaths', message: 'Must be an array of strings.' });
  }
  if (
    config.architecture.requireCompletePolicy !== undefined &&
    typeof config.architecture.requireCompletePolicy !== 'boolean'
  ) {
    diagnostics.push({ level: 'error', path: 'architecture.requireCompletePolicy', message: 'Must be a boolean.' });
  } else if (config.architecture.requireCompletePolicy === true) {
    const declaredRows = isRecordObject(allowedDependencies) ? allowedDependencies : {};
    for (const boundaryName of [...boundaryNames].sort()) {
      if (Object.hasOwn(declaredRows, boundaryName)) continue;
      diagnostics.push({
        level: 'error',
        path: `architecture.allowedDependencies.${boundaryName}`,
        message: 'A dependency row is required by architecture.requireCompletePolicy.',
      });
    }
  }
}

function isSupportedArchitecturePath(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized === '.' || normalized === '..') return false;
  if (normalized.split('/').includes('..')) return false;
  const literalPrefix = normalized.replace(/\/\*\*?$/, '');
  return literalPrefix.length > 0 && !/[*?[\]]/.test(literalPrefix);
}

function validateDocsConfig(config: ProjectConfig, diagnostics: ConfigDiagnostic[]): void {
  const snapshotPaths = config.docs?.snapshotPaths;
  if (snapshotPaths === undefined) return;
  if (!Array.isArray(snapshotPaths)) {
    diagnostics.push({ level: 'error', path: 'docs.snapshotPaths', message: 'Must be an array.' });
    return;
  }
  for (const [index, pattern] of snapshotPaths.entries()) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      diagnostics.push({
        level: 'error',
        path: `docs.snapshotPaths[${index}]`,
        message: 'Snapshot path glob must be a non-empty string.',
      });
    }
  }
}

function validateCoverageContracts(
  config: ProjectConfig,
  diagnostics: ConfigDiagnostic[],
  opts: { projectRoot?: string },
): void {
  if (config.coverageContracts === undefined) return;
  if (!Array.isArray(config.coverageContracts)) {
    diagnostics.push({ level: 'error', path: 'coverageContracts', message: 'Must be an array.' });
    return;
  }
  for (const [index, contract] of config.coverageContracts.entries()) {
    const path = `coverageContracts[${index}]`;
    if (!isRecordObject(contract)) {
      diagnostics.push({ level: 'error', path, message: 'Coverage contract must be an object.' });
      continue;
    }
    if (typeof contract.name !== 'string' || contract.name.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.name`, message: 'Coverage contract name is required.' });
    }
    if (typeof contract.file !== 'string' || contract.file.trim() === '') {
      diagnostics.push({ level: 'error', path: `${path}.file`, message: 'Coverage contract file is required.' });
    } else if (opts.projectRoot && !existsSync(join(opts.projectRoot, contract.file))) {
      diagnostics.push({
        level: 'warning',
        path: `${path}.file`,
        message: `Coverage contract file does not exist: ${contract.file}`,
      });
    }
    validateCoverageContractSpec(
      diagnostics,
      contract.keys,
      `${path}.keys`,
      COVERAGE_CONTRACT_KEY_SPEC_TYPES,
      'Unknown coverage-contract key extractor type.',
    );
    validateCoverageContractSpec(
      diagnostics,
      contract.mustEqual,
      `${path}.mustEqual`,
      COVERAGE_CONTRACT_SOURCE_SPEC_TYPES,
      'Unknown coverage-contract ground-truth source type.',
    );
    if (contract.allowExtra !== undefined && typeof contract.allowExtra !== 'boolean') {
      diagnostics.push({ level: 'error', path: `${path}.allowExtra`, message: 'Must be a boolean.' });
    }
  }
}

function validateCoverageContractSpec(
  diagnostics: ConfigDiagnostic[],
  spec: unknown,
  path: string,
  knownTypes: ReadonlySet<string>,
  unknownTypeMessage: string,
): void {
  if (!isRecordObject(spec)) {
    diagnostics.push({ level: 'error', path, message: 'Must be an object with a "type" field.' });
    return;
  }
  if (typeof spec.type !== 'string' || !knownTypes.has(spec.type)) {
    diagnostics.push({
      level: 'error',
      path: `${path}.type`,
      message: `${unknownTypeMessage} Got: ${String(spec.type)}`,
    });
    return;
  }
  // Per-type required fields: a spec that validates here must never crash
  // the checker downstream (round-3: a contract missing mustEqual.path
  // passed config-validate, then threw a raw TypeError in
  // resolveContractSource).
  const required: Record<string, string[]> = {
    'object-literal-keys': ['identifier'],
    'string-array': ['identifier'],
    'markdown-list': ['marker'],
    'top-level-dirs': ['path'],
    'file-glob': ['pattern'],
    'registered-commands': [],
    'builtin-skills': [],
  };
  for (const field of required[spec.type] ?? []) {
    if (typeof spec[field] !== 'string' || spec[field].length === 0) {
      diagnostics.push({
        level: 'error',
        path: `${path}.${field}`,
        message: `"${spec.type}" requires a non-empty string "${field}".`,
      });
    }
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
 * Scaffold a default .scipquery.json in the project root.
 * Does not overwrite an existing config.
 */
export function initProjectConfig(projectRoot: string, languages: string[]): string {
  const configPath = join(projectRoot, CONFIG_FILENAME);
  const config: ProjectConfig = {
    languages: languages as ProjectConfig['languages'],
    watch: {
      enabled: true,
      debounceMs: DEFAULT_WATCH_DEBOUNCE_MS,
      cooldownMs: DEFAULT_WATCH_COOLDOWN_MS,
      gitPollMs: 2_000,
      idleTimeoutMs: DEFAULT_WATCH_IDLE_TIMEOUT_MS,
      autoRefresh: true,
    },
  };
  mutateTextFileRevisionAware(configPath, (snapshot) =>
    snapshot.revision.exists ? { kind: 'unchanged' } : { kind: 'write', text: serializeProjectConfig(config) },
  );
  return configPath;
}

// scip-query: ignore-stale — reviewed S1 owned contract; config persistence returns this named refresh result.
export interface ProjectAutomaticRefreshConfigResult {
  configPath: string;
  config: ProjectConfig;
  changed: boolean;
}

export function configureProjectLanguages(
  projectRoot: string,
  config: ProjectConfig,
  languages: readonly SupportedLanguage[],
): ProjectAutomaticRefreshConfigResult {
  const configPath = join(projectRoot, CONFIG_FILENAME);
  const desired = [...languages];
  let finalConfig = config;
  const mutation = mutateTextFileRevisionAware(configPath, (snapshot) => {
    const latest = parseProjectConfigSnapshot(snapshot, config);
    if (conflictingFieldEdit(config.languages, latest.languages, desired)) {
      throw new FileContentConflictError(configPath, 'languages');
    }
    const next: ProjectConfig = { ...latest, languages: desired };
    finalConfig = next;
    return snapshot.revision.exists && sameJson(next, latest)
      ? { kind: 'unchanged' }
      : { kind: 'write', text: serializeProjectConfig(next) };
  });
  return { configPath, config: finalConfig, changed: mutation.changed };
}

/**
 * Persist setup's automatic-indexing decision without replacing unrelated
 * project configuration. Callers decide whether an existing explicit opt-out
 * should be preserved before invoking this function.
 */
export function configureProjectAutomaticRefresh(
  projectRoot: string,
  config: ProjectConfig,
  enabled: boolean,
): ProjectAutomaticRefreshConfigResult {
  const configPath = join(projectRoot, CONFIG_FILENAME);
  let finalConfig = config;
  const mutation = mutateTextFileRevisionAware(configPath, (snapshot) => {
    const latest = parseProjectConfigSnapshot(snapshot, config);
    if (conflictingFieldEdit(config.watch?.enabled, latest.watch?.enabled, enabled)) {
      throw new FileContentConflictError(configPath, 'watch.enabled');
    }
    const next: ProjectConfig = {
      ...latest,
      watch: {
        ...latest.watch,
        enabled,
        ...(enabled && latest.watch?.autoRefresh === undefined ? { autoRefresh: true } : {}),
      },
    };
    finalConfig = next;
    return snapshot.revision.exists && sameJson(next, latest)
      ? { kind: 'unchanged' }
      : { kind: 'write', text: serializeProjectConfig(next) };
  });
  return { configPath, config: finalConfig, changed: mutation.changed };
}

function parseProjectConfigSnapshot(snapshot: RevisionedTextSnapshot, fallback: ProjectConfig): ProjectConfig {
  if (!snapshot.revision.exists) return fallback;
  try {
    const parsed = JSON.parse(snapshot.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed as ProjectConfig;
  } catch (error) {
    throw new Error(
      `Cannot update ${snapshot.path}: the latest project config is invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
}

function serializeProjectConfig(config: ProjectConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function conflictingFieldEdit(base: unknown, latest: unknown, desired: unknown): boolean {
  return !sameJson(base, latest) && !sameJson(latest, desired);
}

function reportUnknownConfigKeys(config: ProjectConfig, diagnostics: ConfigDiagnostic[]): void {
  if (!isRecordObject(config as unknown)) return;
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
  reportUnknownObjectKeys(diagnostics, typedConfig.semantic?.rust, 'semantic.rust', RUST_SEMANTIC_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.locality, 'locality', LOCALITY_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.architecture, 'architecture', ARCHITECTURE_CONFIG_KEYS);
  reportUnknownObjectKeys(diagnostics, typedConfig.docs, 'docs', DOCS_CONFIG_KEYS);

  if (Array.isArray(typedConfig.architecture?.boundaries)) {
    for (const [index, boundary] of typedConfig.architecture.boundaries.entries()) {
      reportUnknownObjectKeys(
        diagnostics,
        boundary,
        `architecture.boundaries[${index}]`,
        ARCHITECTURE_BOUNDARY_CONFIG_KEYS,
      );
    }
  }

  if (isRecordObject(typedConfig.indexer)) {
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

  if (Array.isArray(typedConfig.coverageContracts)) {
    for (const [index, contract] of typedConfig.coverageContracts.entries()) {
      const path = `coverageContracts[${index}]`;
      reportUnknownObjectKeys(diagnostics, contract, path, COVERAGE_CONTRACT_CONFIG_KEYS);
      if (isRecordObject(contract)) {
        reportUnknownObjectKeys(diagnostics, contract.keys, `${path}.keys`, COVERAGE_CONTRACT_KEY_SPEC_KEYS);
        reportUnknownObjectKeys(
          diagnostics,
          contract.mustEqual,
          `${path}.mustEqual`,
          COVERAGE_CONTRACT_SOURCE_SPEC_KEYS,
        );
      }
    }
  }
}

function reportUnknownObjectKeys(
  diagnostics: ConfigDiagnostic[],
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
): void {
  if (!isRecordObject(value)) return;
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    diagnostics.push({
      level: 'warning',
      path: path ? `${path}.${key}` : key,
      message: 'Unknown config key.',
    });
  }
}
