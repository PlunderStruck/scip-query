import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectConfig } from '../domain/types.js';
import {
  ensureDirectoryDurable,
  mergeDirectorySyncStatus,
  NODE_DIRECTORY_DURABILITY_RUNTIME,
  syncDirectoryDurable,
  type DirectoryDurabilityRuntime,
  type DirectorySyncStatus,
} from '../filesystem/durable-path.js';
import { writeFileCompletely, type CompleteWritePort } from '../filesystem/file-descriptor.js';
import {
  isPathInsideProject,
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
} from '../domain/path-normalization.js';
import { cliVersion } from './cli-version.js';
import { readSmallArtifactText } from './bounded-file.js';

export const CACHE_OWNERSHIP_SCHEMA_VERSION = 1 as const;
export const CACHE_OWNERSHIP_FILE = '.scip-query-cache-owner.json';
const MAX_CACHE_OWNERSHIP_BYTES = 16 * 1024;

export interface CacheOwnershipRecord {
  schemaVersion: typeof CACHE_OWNERSHIP_SCHEMA_VERSION;
  canonicalProjectRoot: string;
  canonicalCacheDir: string;
  creatorVersion: string;
}

export interface CacheOwnershipProof {
  record: CacheOwnershipRecord;
  ownerSha256: string;
  physicalCacheDir: string;
}

export type CacheOwnershipPublicationResult =
  | {
      kind: 'existing';
      cacheDir: string;
    }
  | {
      kind: 'published';
      cacheDir: string;
      achievedDurability: 'file-flushed' | 'directory-durable';
      directorySync: Exclude<DirectorySyncStatus, 'not-requested'>;
    };

export interface CacheOwnershipRuntime extends DirectoryDurabilityRuntime, CompleteWritePort {
  randomToken(): string;
  linkFile(source: string, target: string): void;
  removeFile(path: string): void;
}

export const NODE_CACHE_OWNERSHIP_RUNTIME: CacheOwnershipRuntime = Object.freeze({
  ...NODE_DIRECTORY_DURABILITY_RUNTIME,
  randomToken: () => randomUUID(),
  linkFile: (source: string, target: string) => linkSync(source, target),
  removeFile: (path: string) => unlinkSync(path),
  writeFile: (fd: number, bytes: Buffer, offset: number, length: number) => writeSync(fd, bytes, offset, length),
});

function unsafeCachePathError(configuredPath: string, reason: string): Error {
  return Object.assign(
    new Error(
      `refusing unsafe project dbPath ${JSON.stringify(configuredPath)} (${reason}); ` +
        'use a repository-relative directory that remains inside the checkout',
    ),
    { name: 'UnsafeCachePathError', code: 'SCIP_QUERY_UNSAFE_CACHE_PATH', configuredPath, reason },
  );
}

function cacheOwnershipError(cacheDir: string, reason: string): Error {
  return Object.assign(
    new Error(
      `refusing unowned cache directory ${JSON.stringify(cacheDir)} (${reason}); ` +
        'move unrelated data elsewhere or choose a new empty dbPath',
    ),
    { name: 'CacheOwnershipError', code: 'SCIP_QUERY_CACHE_OWNERSHIP', cacheDir, reason },
  );
}

/**
 * Resolve and adopt the cache directory for one canonical project.
 *
 * A cache ownership record is a small durable binding between a physical
 * directory and the project whose derived artifacts it stores. Destructive
 * cache operations require this binding so repository configuration cannot
 * turn an arbitrary host directory into disposable cache state.
 */
export function resolveCacheDir(projectRoot: string, config?: ProjectConfig): string {
  const canonicalProjectRoot = realpathSync(projectRoot);
  return ensureOwnedCacheDir(canonicalProjectRoot, resolveCacheDirPath(canonicalProjectRoot, config));
}

/**
 * Resolves the cache location without creating or adopting it.
 *
 * Read-only consumers use this form so constructing a watcher or inspecting
 * optional telemetry cannot create global cache state as a side effect.
 */
export function resolveCacheDirPath(projectRoot: string, config?: ProjectConfig): string {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const envOverride = process.env['SCIP_QUERY_CACHE_DIR'];
  if (envOverride) {
    return resolve(envOverride);
  }

  if (config?.dbPath) {
    return resolveConfiguredCacheDir(canonicalProjectRoot, config.dbPath);
  }

  return resolveDefaultCacheDir(canonicalProjectRoot);
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
    // The pure path helper remains usable by setup planning before creation.
  }
  const projectHash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  return join(resolveScipQueryCacheRoot(), 'projects', projectHash);
}

export function resolveRepositoryCacheDir(repositoryId: string): string {
  if (!/^[a-f0-9]{24}$/.test(repositoryId)) throw new Error(`invalid repository cache identity: ${repositoryId}`);
  const directory = join(resolveScipQueryCacheRoot(), 'repositories', repositoryId);
  mkdirPrivate(directory);
  return realpathSync(directory);
}

export function automaticSharedCacheEnabled(config?: ProjectConfig): boolean {
  return (
    process.env['SCIP_QUERY_SHARED_CACHE'] !== '0' &&
    !process.env['SCIP_QUERY_CACHE_DIR'] &&
    !process.env['SCIP_QUERY_INDEX_DB'] &&
    !config?.dbPath
  );
}

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

export function ensureOwnedCacheDir(
  projectRoot: string,
  cacheDir: string,
  runtime: CacheOwnershipRuntime = NODE_CACHE_OWNERSHIP_RUNTIME,
): string {
  return ensureOwnedCacheDirWithDurability(projectRoot, cacheDir, runtime).cacheDir;
}

/**
 * Establishes the destructive-safety credential and reports the namespace
 * guarantee achieved by the host. The path-only wrapper above is retained for
 * compatibility; callers that make durability claims use this result.
 */
export function ensureOwnedCacheDirWithDurability(
  projectRoot: string,
  cacheDir: string,
  runtime: CacheOwnershipRuntime = NODE_CACHE_OWNERSHIP_RUNTIME,
): CacheOwnershipPublicationResult {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const cacheDirectorySync = existsSync(cacheDir) ? 'synced' : mkdirPrivate(cacheDir, runtime);
  const physicalCacheDir = realpathSync(cacheDir);
  const ownerPath = join(physicalCacheDir, CACHE_OWNERSHIP_FILE);

  if (existsSync(ownerPath)) {
    assertOwnedCacheDir(canonicalProjectRoot, physicalCacheDir);
    chmodPrivateFile(ownerPath);
    chmodPrivateDirectory(physicalCacheDir);
    return { kind: 'existing', cacheDir: physicalCacheDir };
  }

  assertAdoptableLegacyCache(physicalCacheDir);
  hardenLegacyCacheEntries(physicalCacheDir);
  assertAdoptableLegacyCache(physicalCacheDir);
  const record: CacheOwnershipRecord = {
    schemaVersion: CACHE_OWNERSHIP_SCHEMA_VERSION,
    canonicalProjectRoot,
    canonicalCacheDir: physicalCacheDir,
    creatorVersion: cliVersion,
  };
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const credentialDirectorySync = publishPrivateOwnershipFile(ownerPath, payload, runtime);
    const directorySync = mergeDirectorySyncStatus(cacheDirectorySync, credentialDirectorySync);
    return {
      kind: 'published',
      cacheDir: physicalCacheDir,
      achievedDurability: directorySync === 'synced' ? 'directory-durable' : 'file-flushed',
      directorySync,
    };
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      assertOwnedCacheDir(canonicalProjectRoot, physicalCacheDir);
      return { kind: 'existing', cacheDir: physicalCacheDir };
    }
    throw error;
  }
}

export function assertOwnedCacheDir(projectRoot: string, cacheDir: string): CacheOwnershipProof {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const physicalCacheDir = realpathSync(cacheDir);
  return readAndValidateOwnership(physicalCacheDir, canonicalProjectRoot, physicalCacheDir);
}

/**
 * Reads a cache's durable ownership credential without requiring its project
 * root to still exist. Global maintenance uses this proof to discover only
 * scip-query-owned cache directories after a worktree has been removed.
 */
export function readCacheOwnershipProof(cacheDir: string): CacheOwnershipProof {
  const cacheStat = lstatSync(cacheDir);
  if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) {
    throw cacheOwnershipError(cacheDir, 'cache path is not a regular directory');
  }
  const physicalCacheDir = realpathSync(cacheDir);
  return readAndValidateOwnership(physicalCacheDir, undefined, physicalCacheDir);
}

export function hardenOwnedCacheTreeIfOwned(projectRoot: string, cacheDir: string): boolean {
  if (!existsSync(join(cacheDir, CACHE_OWNERSHIP_FILE))) return false;
  assertOwnedCacheDir(projectRoot, cacheDir);
  hardenTree(cacheDir);
  return true;
}

function resolveConfiguredCacheDir(projectRoot: string, configuredPath: string): string {
  let relativePath: string;
  try {
    relativePath = normalizeSafeProjectRelativePath(configuredPath);
  } catch (error) {
    if (error instanceof UnsafeProjectPathError) {
      throw unsafeCachePathError(configuredPath, error.reason);
    }
    throw error;
  }
  const candidate = resolve(projectRoot, ...relativePath.split('/'));
  if (candidate === projectRoot || !isPathInsideProject(projectRoot, candidate)) {
    throw unsafeCachePathError(configuredPath, 'outside-project');
  }

  const existingAncestor = nearestExistingAncestor(candidate);
  const canonicalAncestor = realpathSync(existingAncestor);
  if (!isPathInsideProject(projectRoot, canonicalAncestor) && canonicalAncestor !== projectRoot) {
    throw unsafeCachePathError(configuredPath, 'symlink-escape');
  }
  return candidate;
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw unsafeCachePathError(path, 'no-existing-ancestor');
    current = parent;
  }
  return current;
}

function readAndValidateOwnership(
  physicalCacheDir: string,
  canonicalProjectRoot: string | undefined,
  expectedCanonicalCacheDir: string,
): CacheOwnershipProof {
  const ownerPath = join(physicalCacheDir, CACHE_OWNERSHIP_FILE);
  if (!existsSync(ownerPath) || lstatSync(ownerPath).isSymbolicLink()) {
    throw cacheOwnershipError(physicalCacheDir, 'missing regular ownership record');
  }
  const stat = lstatSync(ownerPath);
  if (!stat.isFile() || stat.size > MAX_CACHE_OWNERSHIP_BYTES) {
    throw cacheOwnershipError(physicalCacheDir, 'invalid ownership record file');
  }
  const payload = readSmallArtifactText(ownerPath, 'cache ownership record');
  const record = parseOwnershipRecord(payload, physicalCacheDir);
  if (canonicalProjectRoot !== undefined && record.canonicalProjectRoot !== canonicalProjectRoot) {
    throw cacheOwnershipError(physicalCacheDir, 'ownership record belongs to a different project');
  }
  if (record.canonicalCacheDir !== expectedCanonicalCacheDir) {
    throw cacheOwnershipError(physicalCacheDir, 'ownership record names a different cache directory');
  }
  return {
    record,
    ownerSha256: createHash('sha256').update(payload).digest('hex'),
    physicalCacheDir,
  };
}

function parseOwnershipRecord(payload: string, cacheDir: string): CacheOwnershipRecord {
  try {
    const parsed = JSON.parse(payload) as Partial<CacheOwnershipRecord>;
    if (
      parsed.schemaVersion !== CACHE_OWNERSHIP_SCHEMA_VERSION ||
      typeof parsed.canonicalProjectRoot !== 'string' ||
      typeof parsed.canonicalCacheDir !== 'string' ||
      typeof parsed.creatorVersion !== 'string' ||
      !isAbsolute(parsed.canonicalProjectRoot) ||
      !isAbsolute(parsed.canonicalCacheDir)
    ) {
      throw new Error('invalid fields');
    }
    return parsed as CacheOwnershipRecord;
  } catch (error) {
    throw cacheOwnershipError(
      cacheDir,
      `malformed ownership record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertAdoptableLegacyCache(cacheDir: string): void {
  const unknown = readdirSync(cacheDir).filter(
    (name) => name !== CACHE_OWNERSHIP_FILE && !isRecognizedCacheEntry(name),
  );
  if (unknown.length > 0) {
    throw cacheOwnershipError(cacheDir, `unrecognized existing entries: ${unknown.slice(0, 3).join(', ')}`);
  }
}

function isRecognizedCacheEntry(name: string): boolean {
  if (name.startsWith(`${CACHE_OWNERSHIP_FILE}.tmp-`)) return true;
  if (name.startsWith('git-worktree-context.json.tmp-')) return true;
  if (
    [
      '.scipquery-generations',
      'affected-shadow-latest.json',
      'affected-shadow.jsonl',
      'agent-hooks',
      'augment-vue-meta.json',
      'cache-lifecycle.lock',
      'evidence.db',
      'evidence.db-shm',
      'evidence.db-wal',
      'health-report-cache.json',
      'git-worktree-context.json',
      'index.db',
      'index.db-shm',
      'index.db-wal',
      'index.lock',
      'index.scip',
      'language-indexes',
      'meta.json',
      'reindex-activity.jsonl',
      'shared-cache.json',
      'typescript-index',
      'typescript-scip-fragments',
      'typescript-scip-overlays',
      'typescript-semantic',
      'typescript-shard-costs.json',
      'watch-activity.json',
      'watch-refresh-requests',
      'watch-state.json',
      'watch.lock',
    ].includes(name)
  ) {
    return true;
  }
  return /^(?:reindex-|rust-|typescript-)/.test(name);
}

function hardenLegacyCacheEntries(cacheDir: string): void {
  for (const name of readdirSync(cacheDir)) {
    const path = join(cacheDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw cacheOwnershipError(cacheDir, `legacy cache entry ${name} is a symlink`);
      }
      if (stat.isDirectory()) chmodPrivateDirectory(path);
      else if (stat.isFile()) chmodPrivateFile(path);
      else throw cacheOwnershipError(cacheDir, `legacy cache entry ${name} is not a file or directory`);
    } catch (error) {
      // Process-lock candidates and other temporary artifacts can disappear
      // after the directory snapshot. Their absence leaves nothing to harden.
      if (isMissingCacheEntryError(error)) continue;
      throw error;
    }
  }
  chmodPrivateDirectory(cacheDir);
}

function hardenTree(root: string, allowMissing = false): void {
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink()) throw cacheOwnershipError(root, 'managed cache tree contains a symlink');
    if (stat.isFile()) {
      chmodPrivateFile(root);
      return;
    }
    if (!stat.isDirectory()) throw cacheOwnershipError(root, 'managed cache tree contains a special file');
    chmodPrivateDirectory(root);
    for (const name of readdirSync(root)) hardenTree(join(root, name), true);
  } catch (error) {
    // A child observed in readdir may be an atomically published or removed
    // temporary. The owned root itself must still exist.
    if (allowMissing && isMissingCacheEntryError(error)) return;
    throw error;
  }
}

function isMissingCacheEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function mkdirPrivate(
  path: string,
  runtime: DirectoryDurabilityRuntime = NODE_DIRECTORY_DURABILITY_RUNTIME,
): Exclude<DirectorySyncStatus, 'not-requested'> {
  const directorySync = ensureDirectoryDurable(path, runtime);
  chmodPrivateDirectory(path);
  return directorySync;
}

function publishPrivateOwnershipFile(
  path: string,
  payload: string,
  runtime: CacheOwnershipRuntime,
): Exclude<DirectorySyncStatus, 'not-requested'> {
  const candidate = `${path}.tmp-${process.pid}-${runtime.randomToken()}`;
  let descriptor: number | undefined;
  let candidateOwned = false;
  try {
    descriptor = runtime.openFile(candidate, 'wx', 0o600);
    candidateOwned = true;
    writeFileCompletely(descriptor, Buffer.from(payload), runtime, 'cache ownership record');
    runtime.syncFile(descriptor);
    runtime.closeFile(descriptor);
    descriptor = undefined;
    runtime.linkFile(candidate, path);
    const publicationDirectorySync = syncDirectoryDurable(dirname(path), runtime);
    runtime.removeFile(candidate);
    candidateOwned = false;
    return mergeDirectorySyncStatus(publicationDirectorySync, syncDirectoryDurable(dirname(path), runtime));
  } finally {
    if (descriptor !== undefined) {
      try {
        runtime.closeFile(descriptor);
      } catch {
        // Preserve the primary write or synchronization failure.
      }
    }
    if (candidateOwned) {
      try {
        runtime.removeFile(candidate);
      } catch {
        // A failed create or injected filesystem fault may leave no candidate.
      }
    }
  }
}

function chmodPrivateDirectory(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function chmodPrivateFile(path: string): void {
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function canonicalizeAbsentPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = realpathSync(dirname(path));
  return join(parent, basename(path));
}

export function canonicalCacheIdentity(cacheDir: string): string {
  return canonicalizeAbsentPath(resolve(cacheDir));
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
  );
}
