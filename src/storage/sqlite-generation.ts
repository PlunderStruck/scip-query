import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalReindexMetadataIdentity, decodeReindexMetadata } from '../domain/reindex-metadata.js';
import { parseProcessIdentity, sameProcessIdentity, type ProcessIdentity } from '../domain/process-identity.js';
import type { ScipQueryConfig } from '../domain/types.js';
import { readSmallArtifactText, sha256FileWithinLimit } from '../filesystem/bounded-file.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { acquireProcessFileLock } from '../platform/repository-cache-lock.js';
import { writeJsonAtomic } from './atomic-json.js';

export const SQLITE_GENERATION_STORE_VERSION = 1;
export const SQLITE_GENERATION_MANIFEST_VERSION = 1;
export const SQLITE_GENERATION_DIRECTORY = '.scipquery-generations';
export const SQLITE_GENERATION_MANIFEST = 'manifest.json';
export const SQLITE_GENERATION_READERS_DIRECTORY = 'readers';
export const SQLITE_GENERATION_GC_LOCK = 'gc.lock';
const MAX_VERIFIED_ARTIFACT_CACHE_ENTRIES = 128;
const verifiedImmutableArtifacts = new Map<string, true>();

export interface SqliteGenerationRecovery {
  generationIdentity: string;
  databasePath: string;
  metadataPath?: string;
}

export interface SqlitePublicationRecord {
  mode: 'incremental' | 'full';
  validation: 'passed';
  converterDurationMs: number;
  affectedDocumentCount?: number;
  changedDocumentCount?: number;
  producerDurationMs?: number;
  materializationDurationMs?: number;
  patchDurationMs?: number;
  scipCompanion?: 'current' | 'deferred';
  typescriptOverlayGeneration?: string;
  fallbackReason?: string;
}

// scip-query: ignore-stale -- Persisted generation-pointer schema shared by validation and publication.
export interface SqliteGenerationState {
  version: typeof SQLITE_GENERATION_STORE_VERSION;
  currentGeneration: string;
  /** Present on writers that publish an atomic pointer to a complete immutable artifact set. */
  artifactSet?: 'immutable-v1';
  stableMirrors?: {
    databaseFileIdentity: string;
    indexFileIdentity?: string;
  };
  previousGeneration?: SqliteGenerationRecovery;
  publication?: SqlitePublicationRecord;
  publishedAt: string;
}

export interface SqliteGenerationArtifact {
  file: string;
  size: number;
  sha256: string;
}

// scip-query: ignore-stale -- Versioned immutable-artifact manifest is an on-disk compatibility boundary.
export interface SqliteGenerationManifest {
  version: typeof SQLITE_GENERATION_MANIFEST_VERSION;
  identity: string;
  database: SqliteGenerationArtifact;
  index?: SqliteGenerationArtifact;
  metadata?: SqliteGenerationArtifact;
}

/**
 * One retained publication of the compiler index. Its immutable paths and
 * metadata bytes are the only companion evidence that may be combined with
 * the open SQLite connection carrying this handle.
 */
// scip-query: ignore-stale -- Reader handle preserves immutable-versus-legacy generation ownership.
export interface SqliteGenerationHandle {
  identity: string;
  databasePath: string;
  indexPath?: string;
  metadataPath?: string;
  metadataRaw?: string;
  source: 'immutable' | 'legacy';
  /** Internal race token for opening a legacy replaceable database path. */
  databaseFileIdentity?: string;
}

export interface SqliteGenerationReaderLease {
  version: 1;
  token: string;
  generationIdentity: string;
  pid: number;
  processIdentity?: ProcessIdentity;
  acquiredAt: string;
}

export interface SqliteGenerationReaderLeaseSnapshot {
  protectedGenerations: ReadonlySet<string>;
  activeLeases: number;
  staleLeasesRemoved: number;
  malformedLeases: number;
}

export interface SqliteGenerationReaderRuntime {
  pid: number;
  now(): Date;
  randomToken(): string;
  isProcessAlive(pid: number): boolean;
  readProcessIdentity(pid: number): ProcessIdentity | null;
}

const NODE_SQLITE_GENERATION_READER_RUNTIME: SqliteGenerationReaderRuntime = {
  pid: process.pid,
  now: () => new Date(),
  randomToken: () => randomUUID(),
  isProcessAlive,
  readProcessIdentity,
};

export function sqliteGenerationRoot(outputDb: string): string {
  return join(dirname(outputDb), SQLITE_GENERATION_DIRECTORY);
}

export function sqliteGenerationGcLockPath(outputDb: string): string {
  return join(sqliteGenerationRoot(outputDb), SQLITE_GENERATION_GC_LOCK);
}

/**
 * Resolves one published immutable generation and protects it before the
 * publication lock can make it eligible for collection.
 */
export function acquireSqliteGenerationReader(
  config: ScipQueryConfig,
  runtime: SqliteGenerationReaderRuntime = NODE_SQLITE_GENERATION_READER_RUNTIME,
): { generation: SqliteGenerationHandle; release(): void } {
  const lock = acquireProcessFileLock(sqliteGenerationGcLockPath(config.dbPath), { waitMs: 5_000 });
  if (!lock) throw new Error('SQLite generation retention is busy; retry opening the index.');
  let leasePath: string | undefined;
  try {
    const generation = resolveSqliteGeneration(config);
    if (generation.source !== 'immutable') return { generation, release() {} };
    const token = runtime.randomToken();
    if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error('SQLite generation reader token is unsafe.');
    const readersDirectory = join(sqliteGenerationRoot(config.dbPath), SQLITE_GENERATION_READERS_DIRECTORY);
    mkdirSync(readersDirectory, { recursive: true });
    leasePath = join(readersDirectory, `${runtime.pid}-${token}.json`);
    const processIdentity = runtime.readProcessIdentity(runtime.pid);
    writeJsonAtomic(
      leasePath,
      {
        version: 1,
        token,
        generationIdentity: generation.identity,
        pid: runtime.pid,
        ...(processIdentity ? { processIdentity } : {}),
        acquiredAt: runtime.now().toISOString(),
      } satisfies SqliteGenerationReaderLease,
      { spacing: 2, trailingNewline: true },
    );
    let released = false;
    return {
      generation,
      release() {
        if (released || !leasePath) return;
        released = true;
        rmSync(leasePath, { force: true });
      },
    };
  } finally {
    lock.release();
  }
}

/**
 * Classifies reader ownership while the caller holds the generation GC lock.
 * Invalid records fail closed by protecting every retained generation.
 */
export function inspectSqliteGenerationReaderLeases(
  outputDb: string,
  allGenerationIdentities: readonly string[],
  runtime: Pick<
    SqliteGenerationReaderRuntime,
    'isProcessAlive' | 'readProcessIdentity'
  > = NODE_SQLITE_GENERATION_READER_RUNTIME,
  options: { removeStale?: boolean } = {},
): SqliteGenerationReaderLeaseSnapshot {
  const readersDirectory = join(sqliteGenerationRoot(outputDb), SQLITE_GENERATION_READERS_DIRECTORY);
  if (!existsSync(readersDirectory)) {
    return {
      protectedGenerations: new Set(),
      activeLeases: 0,
      staleLeasesRemoved: 0,
      malformedLeases: 0,
    };
  }
  const protectedGenerations = new Set<string>();
  let activeLeases = 0;
  let staleLeasesRemoved = 0;
  let malformedLeases = 0;
  for (const entry of readdirSync(readersDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(readersDirectory, entry.name);
    let lease: SqliteGenerationReaderLease | null;
    try {
      lease = parseSqliteGenerationReaderLease(
        JSON.parse(readSmallArtifactText(path, 'SQLite generation reader lease')),
      );
    } catch {
      lease = null;
    }
    if (!lease) {
      malformedLeases += 1;
      for (const identity of allGenerationIdentities) protectedGenerations.add(identity);
      continue;
    }
    if (!readerLeaseIsLive(lease, runtime)) {
      if (options.removeStale !== false) {
        rmSync(path, { force: true });
        staleLeasesRemoved += 1;
      }
      continue;
    }
    activeLeases += 1;
    protectedGenerations.add(lease.generationIdentity);
  }
  return { protectedGenerations, activeLeases, staleLeasesRemoved, malformedLeases };
}

function parseSqliteGenerationReaderLease(value: unknown): SqliteGenerationReaderLease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lease = value as Partial<SqliteGenerationReaderLease>;
  const processIdentity = lease.processIdentity === undefined ? null : parseProcessIdentity(lease.processIdentity);
  if (
    lease.version !== 1 ||
    typeof lease.token !== 'string' ||
    lease.token.trim() === '' ||
    typeof lease.generationIdentity !== 'string' ||
    !/^[a-f0-9]{64}$/.test(lease.generationIdentity) ||
    typeof lease.pid !== 'number' ||
    !Number.isSafeInteger(lease.pid) ||
    lease.pid <= 0 ||
    typeof lease.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(lease.acquiredAt)) ||
    (lease.processIdentity !== undefined && (!processIdentity || processIdentity.pid !== lease.pid))
  ) {
    return null;
  }
  return {
    version: 1,
    token: lease.token,
    generationIdentity: lease.generationIdentity,
    pid: lease.pid,
    ...(processIdentity ? { processIdentity } : {}),
    acquiredAt: lease.acquiredAt,
  };
}

function readerLeaseIsLive(
  lease: SqliteGenerationReaderLease,
  runtime: Pick<SqliteGenerationReaderRuntime, 'isProcessAlive' | 'readProcessIdentity'>,
): boolean {
  if (!runtime.isProcessAlive(lease.pid)) return false;
  if (!lease.processIdentity) return true;
  const observed = runtime.readProcessIdentity(lease.pid);
  return observed === null || sameProcessIdentity(lease.processIdentity, observed);
}

export function readSqliteGenerationState(outputDb: string): SqliteGenerationState | null {
  try {
    const parsed = JSON.parse(
      readSmallArtifactText(join(sqliteGenerationRoot(outputDb), 'state.json'), 'SQLite generation state'),
    ) as Partial<SqliteGenerationState>;
    return validSqliteGenerationState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readSqliteGenerationManifest(outputDb: string, identity: string): SqliteGenerationManifest | null {
  return readSqliteGenerationManifestFromRoot(sqliteGenerationRoot(outputDb), identity);
}

export function readSqliteGenerationManifestFromRoot(
  generationRoot: string,
  identity: string,
): SqliteGenerationManifest | null {
  try {
    const parsed = JSON.parse(
      readSmallArtifactText(join(generationRoot, identity, SQLITE_GENERATION_MANIFEST), 'SQLite generation manifest'),
    ) as Partial<SqliteGenerationManifest>;
    return validManifest(parsed, identity) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the atomically published pointer to immutable artifacts. Repositories
 * predating the generation store use one coherently captured legacy snapshot.
 */
export function resolveSqliteGeneration(config: ScipQueryConfig): SqliteGenerationHandle {
  const state = readSqliteGenerationState(config.dbPath);
  if (state) {
    const immutable = readImmutableGeneration(config, state.currentGeneration);
    if (immutable) return immutable;
    if (state.artifactSet === 'immutable-v1') {
      throw new Error(`Published SQLite generation ${state.currentGeneration} is missing or invalid.`);
    }
  }
  if (existsSync(join(dirname(config.dbPath), 'index.lock'))) {
    throw new Error('Legacy SQLite publication is in progress; retry after the reindex lock is released.');
  }
  return resolveLegacyGeneration(config, state?.currentGeneration);
}

export function publishedSqliteGenerationIdentity(dbPath: string): string | null {
  const state = readSqliteGenerationState(dbPath);
  if (state) return state.currentGeneration;
  try {
    const metaPath = join(dirname(dbPath), 'meta.json');
    const metadataRaw = existsSync(metaPath) ? readSmallArtifactText(metaPath, 'reindex metadata') : undefined;
    return legacyGenerationIdentity(dbPath, metadataRaw);
  } catch {
    return null;
  }
}

export function generationMetadata<T>(generation: SqliteGenerationHandle): T | null {
  if (generation.metadataRaw === undefined) return null;
  try {
    return JSON.parse(generation.metadataRaw) as T;
  } catch {
    return null;
  }
}

export function stableMetadataIdentity(raw: string): string {
  return canonicalReindexMetadataIdentity(decodeReindexMetadata(raw)) ?? raw;
}

function readImmutableGeneration(config: ScipQueryConfig, identity: string): SqliteGenerationHandle | null {
  try {
    const directory = join(sqliteGenerationRoot(config.dbPath), identity);
    const manifest = readSqliteGenerationManifest(config.dbPath, identity);
    if (!manifest) return null;
    const databasePath = artifactPath(directory, manifest.database);
    const indexPath = manifest.index ? artifactPath(directory, manifest.index) : undefined;
    const metadataPath = manifest.metadata ? artifactPath(directory, manifest.metadata) : undefined;
    if (
      !artifactMatchesRecordedDigest(databasePath, manifest.database) ||
      (manifest.index && (!indexPath || !artifactMatchesRecordedDigest(indexPath, manifest.index))) ||
      (manifest.metadata && (!metadataPath || !artifactMatchesRecordedDigest(metadataPath, manifest.metadata)))
    ) {
      return null;
    }
    return {
      identity,
      databasePath,
      ...(indexPath ? { indexPath } : {}),
      ...(metadataPath ? { metadataPath, metadataRaw: readSmallArtifactText(metadataPath, 'reindex metadata') } : {}),
      source: 'immutable',
    };
  } catch {
    return null;
  }
}

function resolveLegacyGeneration(config: ScipQueryConfig, publishedIdentity?: string): SqliteGenerationHandle {
  const databaseFileIdentity = fileIdentity(config.dbPath);
  const metadataPath = join(dirname(config.dbPath), 'meta.json');
  const metadataRaw = existsSync(metadataPath) ? readSmallArtifactText(metadataPath, 'reindex metadata') : undefined;
  const indexPath = existsSync(config.indexPath) ? config.indexPath : undefined;
  return {
    identity: publishedIdentity ?? legacyGenerationIdentity(config.dbPath, metadataRaw),
    databasePath: config.dbPath,
    ...(indexPath ? { indexPath } : {}),
    ...(metadataRaw === undefined ? {} : { metadataPath, metadataRaw }),
    source: 'legacy',
    databaseFileIdentity,
  };
}

function legacyGenerationIdentity(databasePath: string, metadataRaw?: string): string {
  const hash = createHash('sha256').update('sqlite-generation-legacy-v1\0');
  if (metadataRaw !== undefined) hash.update(stableMetadataIdentity(metadataRaw));
  hash.update(`\0${fileIdentity(databasePath)}`);
  return hash.digest('hex');
}

export function fileIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function artifactPath(directory: string, artifact: SqliteGenerationArtifact): string {
  if (basename(artifact.file) !== artifact.file || artifact.file === '.' || artifact.file === '..') {
    throw new Error('SQLite generation manifest contains an unsafe artifact path');
  }
  return join(directory, artifact.file);
}

function artifactMatchesRecordedDigest(path: string, artifact: SqliteGenerationArtifact): boolean {
  if (!existsSync(path)) return false;
  const before = immutableArtifactIdentity(path);
  if (!before || before.size !== artifact.size) return false;
  const cacheKey = `${path}\0${artifact.sha256}\0${before.identity}`;
  if (verifiedImmutableArtifacts.has(cacheKey)) return true;
  const digest = sha256FileWithinLimit(path, {
    inputKind: 'immutable SQLite generation artifact',
    maxBytes: artifact.size,
  });
  const after = immutableArtifactIdentity(path);
  if (!after || after.identity !== before.identity || digest !== artifact.sha256) return false;
  verifiedImmutableArtifacts.set(cacheKey, true);
  while (verifiedImmutableArtifacts.size > MAX_VERIFIED_ARTIFACT_CACHE_ENTRIES) {
    const oldest = verifiedImmutableArtifacts.keys().next().value;
    if (oldest === undefined) break;
    verifiedImmutableArtifacts.delete(oldest);
  }
  return true;
}

function immutableArtifactIdentity(path: string): { identity: string; size: number } | null {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) return null;
  return {
    identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    size: Number(stat.size),
  };
}

function validManifest(
  value: Partial<SqliteGenerationManifest>,
  expectedIdentity: string,
): value is SqliteGenerationManifest {
  return (
    value.version === SQLITE_GENERATION_MANIFEST_VERSION &&
    value.identity === expectedIdentity &&
    validArtifact(value.database) &&
    (value.index === undefined || validArtifact(value.index)) &&
    (value.metadata === undefined || validArtifact(value.metadata))
  );
}

function validArtifact(value: unknown): value is SqliteGenerationArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<SqliteGenerationArtifact>;
  return (
    typeof artifact.file === 'string' &&
    Boolean(artifact.file) &&
    Number.isSafeInteger(artifact.size) &&
    (artifact.size ?? -1) >= 0 &&
    typeof artifact.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(artifact.sha256)
  );
}

function validSqliteGenerationState(value: Partial<SqliteGenerationState>): value is SqliteGenerationState {
  return (
    value.version === SQLITE_GENERATION_STORE_VERSION &&
    typeof value.currentGeneration === 'string' &&
    Boolean(value.currentGeneration) &&
    typeof value.publishedAt === 'string' &&
    Number.isFinite(Date.parse(value.publishedAt)) &&
    (value.artifactSet === undefined || value.artifactSet === 'immutable-v1') &&
    validStableMirrors(value.stableMirrors) &&
    validRecovery(value.previousGeneration) &&
    validPublication(value.publication)
  );
}

function validStableMirrors(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const mirrors = value as {
    databaseFileIdentity?: unknown;
    indexFileIdentity?: unknown;
  };
  return (
    typeof mirrors.databaseFileIdentity === 'string' &&
    Boolean(mirrors.databaseFileIdentity) &&
    (mirrors.indexFileIdentity === undefined ||
      (typeof mirrors.indexFileIdentity === 'string' && Boolean(mirrors.indexFileIdentity)))
  );
}

function validRecovery(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const recovery = value as Partial<SqliteGenerationRecovery>;
  return (
    typeof recovery.generationIdentity === 'string' &&
    Boolean(recovery.generationIdentity) &&
    typeof recovery.databasePath === 'string' &&
    Boolean(recovery.databasePath) &&
    (recovery.metadataPath === undefined ||
      (typeof recovery.metadataPath === 'string' && Boolean(recovery.metadataPath)))
  );
}

function validPublication(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const publication = value as Partial<SqlitePublicationRecord>;
  const numericValues = [
    publication.converterDurationMs,
    publication.affectedDocumentCount,
    publication.changedDocumentCount,
    publication.producerDurationMs,
    publication.materializationDurationMs,
    publication.patchDurationMs,
  ].filter((entry) => entry !== undefined);
  return (
    (publication.mode === 'incremental' || publication.mode === 'full') &&
    publication.validation === 'passed' &&
    publication.converterDurationMs !== undefined &&
    numericValues.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) &&
    (publication.scipCompanion === undefined ||
      publication.scipCompanion === 'current' ||
      publication.scipCompanion === 'deferred') &&
    (publication.typescriptOverlayGeneration === undefined ||
      (typeof publication.typescriptOverlayGeneration === 'string' &&
        Boolean(publication.typescriptOverlayGeneration))) &&
    (publication.scipCompanion !== 'deferred' || Boolean(publication.typescriptOverlayGeneration)) &&
    (publication.fallbackReason === undefined || typeof publication.fallbackReason === 'string')
  );
}
