import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectConfig } from '../domain/types.js';
import {
  isPathInsideProject,
  normalizeSafeProjectRelativePath,
  UnsafeProjectPathError,
} from '../domain/path-normalization.js';
import { cliVersion } from './cli-version.js';

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
  const envOverride = process.env['SCIP_QUERY_CACHE_DIR'];
  if (envOverride) {
    return ensureOwnedCacheDir(canonicalProjectRoot, resolve(envOverride));
  }

  if (config?.dbPath) {
    return ensureOwnedCacheDir(canonicalProjectRoot, resolveConfiguredCacheDir(canonicalProjectRoot, config.dbPath));
  }

  return ensureOwnedCacheDir(canonicalProjectRoot, resolveDefaultCacheDir(canonicalProjectRoot));
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

export function ensureOwnedCacheDir(projectRoot: string, cacheDir: string): string {
  const canonicalProjectRoot = realpathSync(projectRoot);
  if (!existsSync(cacheDir)) mkdirPrivate(cacheDir);
  const physicalCacheDir = realpathSync(cacheDir);
  const ownerPath = join(physicalCacheDir, CACHE_OWNERSHIP_FILE);

  if (existsSync(ownerPath)) {
    assertOwnedCacheDir(canonicalProjectRoot, physicalCacheDir);
    chmodPrivateFile(ownerPath);
    chmodPrivateDirectory(physicalCacheDir);
    return physicalCacheDir;
  }

  assertAdoptableLegacyCache(physicalCacheDir);
  const record: CacheOwnershipRecord = {
    schemaVersion: CACHE_OWNERSHIP_SCHEMA_VERSION,
    canonicalProjectRoot,
    canonicalCacheDir: physicalCacheDir,
    creatorVersion: cliVersion,
  };
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  try {
    writeNewPrivateFile(ownerPath, payload);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      assertOwnedCacheDir(canonicalProjectRoot, physicalCacheDir);
      return physicalCacheDir;
    }
    throw error;
  }

  try {
    assertAdoptableLegacyCache(physicalCacheDir);
    hardenLegacyCacheEntries(physicalCacheDir);
  } catch (error) {
    unlinkSync(ownerPath);
    throw error;
  }
  return physicalCacheDir;
}

export function assertOwnedCacheDir(projectRoot: string, cacheDir: string): CacheOwnershipProof {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const physicalCacheDir = realpathSync(cacheDir);
  return readAndValidateOwnership(physicalCacheDir, canonicalProjectRoot, physicalCacheDir);
}

export function assertOwnedCacheBackup(
  projectRoot: string,
  backupDir: string,
  expectedOriginalCacheDir: string,
  expectedOwnerSha256?: string,
): CacheOwnershipProof {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const physicalBackupDir = realpathSync(backupDir);
  const canonicalOriginal = canonicalizeAbsentPath(expectedOriginalCacheDir);
  const proof = readAndValidateOwnership(physicalBackupDir, canonicalProjectRoot, canonicalOriginal);
  if (expectedOwnerSha256 && proof.ownerSha256 !== expectedOwnerSha256) {
    throw cacheOwnershipError(backupDir, 'ownership record changed after the cache was moved');
  }
  return proof;
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
  canonicalProjectRoot: string,
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
  const payload = readFileSync(ownerPath, 'utf8');
  const record = parseOwnershipRecord(payload, physicalCacheDir);
  if (record.canonicalProjectRoot !== canonicalProjectRoot) {
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
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw cacheOwnershipError(cacheDir, `legacy cache entry ${name} is a symlink`);
    }
    if (stat.isDirectory()) chmodPrivateDirectory(path);
    else if (stat.isFile()) chmodPrivateFile(path);
    else throw cacheOwnershipError(cacheDir, `legacy cache entry ${name} is not a file or directory`);
  }
  chmodPrivateDirectory(cacheDir);
}

function hardenTree(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw cacheOwnershipError(root, 'managed cache tree contains a symlink');
  if (stat.isFile()) {
    chmodPrivateFile(root);
    return;
  }
  if (!stat.isDirectory()) throw cacheOwnershipError(root, 'managed cache tree contains a special file');
  chmodPrivateDirectory(root);
  for (const name of readdirSync(root)) hardenTree(join(root, name));
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodPrivateDirectory(path);
}

function writeNewPrivateFile(path: string, payload: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeSync(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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

export function cacheIdentityHash(cacheDir: string): string {
  const canonical = canonicalCacheIdentity(cacheDir);
  return createHash('sha256').update(canonical).digest('hex');
}

export function canonicalCacheIdentity(cacheDir: string): string {
  return canonicalizeAbsentPath(resolve(cacheDir));
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
  );
}
