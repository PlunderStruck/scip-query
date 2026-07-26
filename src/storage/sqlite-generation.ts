import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalReindexMetadataIdentity, decodeReindexMetadata } from '../domain/reindex-metadata.js';
import type { ScipQueryConfig } from '../domain/types.js';
import { readSmallArtifactText } from '../filesystem/bounded-file.js';

export const SQLITE_GENERATION_STORE_VERSION = 1;
export const SQLITE_GENERATION_MANIFEST_VERSION = 1;
export const SQLITE_GENERATION_DIRECTORY = '.scipquery-generations';
export const SQLITE_GENERATION_MANIFEST = 'manifest.json';

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

export function sqliteGenerationRoot(outputDb: string): string {
  return join(dirname(outputDb), SQLITE_GENERATION_DIRECTORY);
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
      !artifactHasRecordedSize(databasePath, manifest.database) ||
      (manifest.index && (!indexPath || !artifactHasRecordedSize(indexPath, manifest.index))) ||
      (manifest.metadata && (!metadataPath || !artifactHasRecordedSize(metadataPath, manifest.metadata)))
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

function artifactHasRecordedSize(path: string, artifact: SqliteGenerationArtifact): boolean {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size === artifact.size;
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
