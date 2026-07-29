import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  cloneFileDurable,
  ensureDirectoryDurable,
  mergeDirectorySyncStatus,
  syncDirectoryDurable,
  type DirectorySyncStatus,
} from '../storage/atomic-file.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { readProcessIdentity } from '../platform/process-identity.js';
import { isProcessAlive } from '../platform/process-liveness.js';
import { acquireProcessFileLock } from '../platform/repository-cache-lock.js';
import { writeJsonAtomic, writeJsonDurable } from '../storage/atomic-json.js';
import {
  SQLITE_GENERATION_DIRECTORY,
  SQLITE_GENERATION_MANIFEST,
  SQLITE_GENERATION_MANIFEST_VERSION,
  SQLITE_GENERATION_STORE_VERSION,
  fileIdentity,
  inspectSqliteGenerationReaderLeases,
  readSqliteGenerationManifest,
  readSqliteGenerationManifestFromRoot,
  readSqliteGenerationState,
  sqliteGenerationRoot,
  sqliteGenerationGcLockPath,
  stableMetadataIdentity,
  type SqliteGenerationArtifact,
  type SqliteGenerationManifest,
  type SqliteGenerationRecovery,
  type SqliteGenerationState,
  type SqlitePublicationRecord,
} from '../storage/sqlite-generation.js';

export {
  SQLITE_GENERATION_DIRECTORY,
  SQLITE_GENERATION_STORE_VERSION,
  readSqliteGenerationState,
  sqliteGenerationRoot,
};
export type { SqliteGenerationRecovery, SqliteGenerationState, SqlitePublicationRecord };

export type SqliteGenerationHandoffStage =
  | 'after-recovery-retained'
  | 'after-pointer-handoff'
  | 'after-scip-handoff'
  | 'after-database-handoff'
  | 'after-metadata-handoff';

export interface PromoteReindexArtifactsInput {
  tempOutputScip: string;
  tempOutputDb: string;
  tempMetaPath: string;
  outputScip: string;
  outputDb: string;
  metaPath: string;
  /** Keep the accepted whole SCIP file when SQLite was published from a changed-document overlay. */
  preserveOutputScip?: boolean;
  publication?: SqlitePublicationRecord;
  onStage?: (stage: SqliteGenerationHandoffStage) => void;
  now?: () => Date;
}

// scip-query: ignore-stale — reviewed S1 owned contract; this union names every generation-inspection outcome.
export type SqliteGenerationInspection =
  | { state: 'legacy'; statePath: string }
  | { state: 'invalid'; statePath: string; reason: string }
  | {
      state: 'current' | 'drifted';
      statePath: string;
      currentMatches: boolean;
      recoveryExists: boolean;
      generation: SqliteGenerationState;
      reason?: string;
    };

export interface PromoteReindexArtifactsResult {
  currentGeneration: string;
  previousGeneration?: SqliteGenerationRecovery;
  retention?: LocalSqliteGenerationRetentionResult;
  achievedDurability: 'file-flushed' | 'directory-durable';
  directorySync: Exclude<DirectorySyncStatus, 'not-requested'>;
}

export interface LocalSqliteGenerationRetentionLimits {
  maxGenerations: number;
  maxLogicalBytes: number;
}

export const DEFAULT_LOCAL_SQLITE_GENERATION_RETENTION: Readonly<LocalSqliteGenerationRetentionLimits> = Object.freeze({
  maxGenerations: 8,
  maxLogicalBytes: 2 * 1024 * 1024 * 1024,
});

export interface LocalSqliteGenerationRetentionResult {
  state: 'within-bounds' | 'collected' | 'protected' | 'deferred' | 'error';
  generationCount: number;
  logicalBytes: number;
  protectedGenerations: number;
  activeReaderLeases: number;
  staleReaderLeasesRemoved: number;
  malformedReaderLeases: number;
  removedGenerations: number;
  removedLogicalBytes: number;
  limits: LocalSqliteGenerationRetentionLimits;
  at: string;
  reason?: string;
}

// scip-query: ignore-stale -- Status contract separates retention inspection from CLI presentation.
export interface LocalSqliteGenerationStatus {
  state: 'managed' | 'absent' | 'deferred' | 'error';
  generationCount: number;
  logicalBytes: number;
  oldestGenerationAt?: string;
  protectedGenerations: number;
  activeReaderLeases: number;
  malformedReaderLeases: number;
  limits: LocalSqliteGenerationRetentionLimits;
  lastCollection?: LocalSqliteGenerationRetentionResult;
  reason?: string;
}

/**
 * Retains the accepted database, then changes the stable artifact paths in a
 * fixed order. Each database path always names one complete SQLite file.
 */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function promoteReindexArtifacts(input: PromoteReindexArtifactsInput): PromoteReindexArtifactsResult {
  const generationRoot = sqliteGenerationRoot(input.outputDb);
  const previousGeneration = retainPublishedGeneration(input);
  input.onStage?.('after-recovery-retained');

  const candidateScip = input.preserveOutputScip ? input.outputScip : input.tempOutputScip;
  const candidate = materializeGeneration({
    generationRoot,
    databasePath: input.tempOutputDb,
    indexPath: existsSync(candidateScip) ? candidateScip : undefined,
    metadataPath: existsSync(input.tempMetaPath) ? input.tempMetaPath : undefined,
  });

  const publishedAt = (input.now ?? (() => new Date()))().toISOString();
  const state: SqliteGenerationState = {
    version: SQLITE_GENERATION_STORE_VERSION,
    currentGeneration: candidate.identity,
    artifactSet: 'immutable-v1',
    ...(previousGeneration ? { previousGeneration } : {}),
    ...(input.publication ? { publication: input.publication } : {}),
    publishedAt,
  };
  const pointerWrite = writeJsonDurable(join(generationRoot, 'state.json'), state, {
    spacing: 2,
    trailingNewline: true,
  });
  input.onStage?.('after-pointer-handoff');

  if (!input.preserveOutputScip) replaceFile(input.tempOutputScip, input.outputScip);
  input.onStage?.('after-scip-handoff');
  replaceFile(input.tempOutputDb, input.outputDb);
  input.onStage?.('after-database-handoff');
  replaceFile(input.tempMetaPath, input.metaPath);
  input.onStage?.('after-metadata-handoff');

  const currentGeneration = candidate.identity;
  const mirroredState: SqliteGenerationState = {
    ...state,
    stableMirrors: stableMirrorIdentity(input.outputDb, input.outputScip),
  };
  writeJsonDurable(join(generationRoot, 'state.json'), mirroredState, { spacing: 2, trailingNewline: true });
  const retention = collectLocalSqliteGenerations(input.outputDb, { now: input.now });
  const directorySync = mergeDirectorySyncStatus(candidate.directorySync, pointerWrite.directorySync) as Exclude<
    DirectorySyncStatus,
    'not-requested'
  >;
  return {
    currentGeneration,
    ...(previousGeneration ? { previousGeneration } : {}),
    retention,
    achievedDurability: directorySync === 'synced' ? 'directory-durable' : 'file-flushed',
    directorySync,
  };
}

/**
 * Upgrades a complete legacy stable layout to the immutable pointer protocol
 * before reindex code reads it while owning the publication lock.
 */
export function ensureImmutableSqliteGeneration(
  outputDb: string,
  outputScip: string,
  metaPath: string,
  now: () => Date = () => new Date(),
): SqliteGenerationState | null {
  if (!existsSync(outputDb)) return null;
  const previous = readSqliteGenerationState(outputDb);
  const statePath = join(sqliteGenerationRoot(outputDb), 'state.json');
  if (previous?.artifactSet === 'immutable-v1' && readSqliteGenerationManifest(outputDb, previous.currentGeneration)) {
    return previous;
  }

  const generationRoot = sqliteGenerationRoot(outputDb);
  const recoveredIdentity =
    !previous && existsSync(statePath) ? sqliteGenerationIdentity(metaPath, outputDb, outputScip) : undefined;
  if (recoveredIdentity && !readSqliteGenerationManifestFromRoot(generationRoot, recoveredIdentity)) {
    return null;
  }
  const retained = materializeGeneration({
    generationRoot,
    databasePath: outputDb,
    indexPath: existsSync(outputScip) ? outputScip : undefined,
    metadataPath: existsSync(metaPath) ? metaPath : undefined,
    forcedIdentity: previous?.currentGeneration ?? recoveredIdentity,
  });
  const state: SqliteGenerationState = {
    version: SQLITE_GENERATION_STORE_VERSION,
    currentGeneration: retained.identity,
    artifactSet: 'immutable-v1',
    stableMirrors: stableMirrorIdentity(outputDb, outputScip),
    ...(previous?.previousGeneration ? { previousGeneration: previous.previousGeneration } : {}),
    ...(previous?.publication ? { publication: previous.publication } : {}),
    publishedAt: previous?.publishedAt ?? now().toISOString(),
  };
  writeJsonDurable(join(generationRoot, 'state.json'), state, {
    spacing: 2,
    trailingNewline: true,
  });
  return state;
}

/** Refreshes the generation identity after metadata-only publication. */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function refreshSqliteGenerationMetadata(
  outputDb: string,
  metaPath: string,
  now: () => Date = () => new Date(),
): SqliteGenerationState {
  if (!existsSync(outputDb) || !existsSync(metaPath)) {
    throw new Error('metadata-only generation refresh requires stable database and metadata files');
  }
  const previous = readSqliteGenerationState(outputDb);
  const generationRoot = sqliteGenerationRoot(outputDb);
  const current = materializeGeneration({
    generationRoot,
    databasePath: outputDb,
    indexPath: existsSync(join(dirname(outputDb), 'index.scip')) ? join(dirname(outputDb), 'index.scip') : undefined,
    metadataPath: metaPath,
  });
  const previousGeneration =
    previous && previous.currentGeneration !== current.identity
      ? recoveryForGeneration(outputDb, previous.currentGeneration)
      : undefined;
  const state: SqliteGenerationState = {
    version: SQLITE_GENERATION_STORE_VERSION,
    currentGeneration: current.identity,
    artifactSet: 'immutable-v1',
    stableMirrors: stableMirrorIdentity(outputDb, join(dirname(outputDb), 'index.scip')),
    ...(previousGeneration ? { previousGeneration } : {}),
    ...(previous?.publication ? { publication: previous.publication } : {}),
    publishedAt: now().toISOString(),
  };
  writeJsonDurable(join(sqliteGenerationRoot(outputDb), 'state.json'), state, {
    spacing: 2,
    trailingNewline: true,
  });
  collectLocalSqliteGenerations(outputDb, { now });
  return state;
}

export function collectLocalSqliteGenerations(
  outputDb: string,
  options: {
    limits?: Partial<LocalSqliteGenerationRetentionLimits>;
    now?: () => Date;
    isProcessAlive?: (pid: number) => boolean;
    readProcessIdentity?: typeof readProcessIdentity;
    onBeforeRemove?: (identity: string) => void;
  } = {},
): LocalSqliteGenerationRetentionResult {
  const limits = resolveLocalGenerationRetentionLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const lock = acquireProcessFileLock(sqliteGenerationGcLockPath(outputDb), { waitMs: 0 });
  if (!lock) {
    return {
      state: 'deferred',
      generationCount: 0,
      logicalBytes: 0,
      protectedGenerations: 0,
      activeReaderLeases: 0,
      staleReaderLeasesRemoved: 0,
      malformedReaderLeases: 0,
      removedGenerations: 0,
      removedLogicalBytes: 0,
      limits,
      at,
      reason: 'another process owns local generation retention',
    };
  }
  try {
    const state = readSqliteGenerationState(outputDb);
    const generations = localGenerationEntries(outputDb);
    const leaseSnapshot = inspectSqliteGenerationReaderLeases(
      outputDb,
      generations.map((generation) => generation.identity),
      {
        isProcessAlive: options.isProcessAlive ?? isProcessAlive,
        readProcessIdentity: options.readProcessIdentity ?? readProcessIdentity,
      },
    );
    const protectedIdentities = new Set(leaseSnapshot.protectedGenerations);
    if (state?.currentGeneration) protectedIdentities.add(state.currentGeneration);
    if (state?.previousGeneration?.generationIdentity) {
      protectedIdentities.add(state.previousGeneration.generationIdentity);
    }
    let generationCount = generations.length;
    let logicalBytes = generations.reduce((total, generation) => total + generation.logicalBytes, 0);
    let removedGenerations = 0;
    let removedLogicalBytes = 0;
    for (const generation of generations) {
      if (generationCount <= limits.maxGenerations && logicalBytes <= limits.maxLogicalBytes) break;
      if (protectedIdentities.has(generation.identity)) continue;
      options.onBeforeRemove?.(generation.identity);
      rmSync(generation.path, { recursive: true, force: true });
      generationCount -= 1;
      logicalBytes -= generation.logicalBytes;
      removedGenerations += 1;
      removedLogicalBytes += generation.logicalBytes;
    }
    const stillOverLimit = generationCount > limits.maxGenerations || logicalBytes > limits.maxLogicalBytes;
    const result: LocalSqliteGenerationRetentionResult = {
      state: stillOverLimit ? 'protected' : removedGenerations > 0 ? 'collected' : 'within-bounds',
      generationCount,
      logicalBytes,
      protectedGenerations: protectedIdentities.size,
      activeReaderLeases: leaseSnapshot.activeLeases,
      staleReaderLeasesRemoved: leaseSnapshot.staleLeasesRemoved,
      malformedReaderLeases: leaseSnapshot.malformedLeases,
      removedGenerations,
      removedLogicalBytes,
      limits,
      at,
      ...(stillOverLimit
        ? {
            reason:
              leaseSnapshot.malformedLeases > 0
                ? 'malformed reader ownership evidence fails closed'
                : 'retention bounds cannot be met without deleting a protected generation',
          }
        : {}),
    };
    writeLocalGenerationRetentionResult(outputDb, result);
    return result;
  } catch (error) {
    const result: LocalSqliteGenerationRetentionResult = {
      state: 'error',
      generationCount: 0,
      logicalBytes: 0,
      protectedGenerations: 0,
      activeReaderLeases: 0,
      staleReaderLeasesRemoved: 0,
      malformedReaderLeases: 0,
      removedGenerations: 0,
      removedLogicalBytes: 0,
      limits,
      at,
      reason: error instanceof Error ? error.message : String(error),
    };
    try {
      writeLocalGenerationRetentionResult(outputDb, result);
    } catch {
      // Publication remains authoritative even when observational GC telemetry cannot be written.
    }
    return result;
  } finally {
    lock.release();
  }
}

export function inspectLocalSqliteGenerationRetention(outputDb: string): LocalSqliteGenerationStatus {
  const root = sqliteGenerationRoot(outputDb);
  if (!existsSync(root)) {
    return {
      state: 'absent',
      generationCount: 0,
      logicalBytes: 0,
      protectedGenerations: 0,
      activeReaderLeases: 0,
      malformedReaderLeases: 0,
      limits: { ...DEFAULT_LOCAL_SQLITE_GENERATION_RETENTION },
      reason: 'local immutable generation store does not exist',
    };
  }
  const lastCollection = readLocalGenerationRetentionResult(outputDb);
  const limits = lastCollection?.limits ?? { ...DEFAULT_LOCAL_SQLITE_GENERATION_RETENTION };
  const lock = acquireProcessFileLock(sqliteGenerationGcLockPath(outputDb), { waitMs: 0 });
  if (!lock) {
    return {
      state: 'deferred',
      generationCount: lastCollection?.generationCount ?? 0,
      logicalBytes: lastCollection?.logicalBytes ?? 0,
      protectedGenerations: lastCollection?.protectedGenerations ?? 0,
      activeReaderLeases: lastCollection?.activeReaderLeases ?? 0,
      malformedReaderLeases: lastCollection?.malformedReaderLeases ?? 0,
      limits,
      ...(lastCollection ? { lastCollection } : {}),
      reason: 'another process owns local generation retention',
    };
  }
  try {
    const generations = localGenerationEntries(outputDb);
    const state = readSqliteGenerationState(outputDb);
    const leases = inspectSqliteGenerationReaderLeases(
      outputDb,
      generations.map((generation) => generation.identity),
      { isProcessAlive, readProcessIdentity },
      { removeStale: false },
    );
    const protectedIdentities = new Set(leases.protectedGenerations);
    if (state?.currentGeneration) protectedIdentities.add(state.currentGeneration);
    if (state?.previousGeneration?.generationIdentity) {
      protectedIdentities.add(state.previousGeneration.generationIdentity);
    }
    return {
      state: 'managed',
      generationCount: generations.length,
      logicalBytes: generations.reduce((total, generation) => total + generation.logicalBytes, 0),
      ...(generations[0] ? { oldestGenerationAt: new Date(generations[0].modifiedAtMs).toISOString() } : {}),
      protectedGenerations: protectedIdentities.size,
      activeReaderLeases: leases.activeLeases,
      malformedReaderLeases: leases.malformedLeases,
      limits,
      ...(lastCollection ? { lastCollection } : {}),
      ...(leases.malformedLeases > 0
        ? { reason: 'malformed reader ownership evidence prevents unsafe collection' }
        : {}),
    };
  } catch (error) {
    return {
      state: 'error',
      generationCount: 0,
      logicalBytes: 0,
      protectedGenerations: 0,
      activeReaderLeases: 0,
      malformedReaderLeases: 0,
      limits,
      ...(lastCollection ? { lastCollection } : {}),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    lock.release();
  }
}

function resolveLocalGenerationRetentionLimits(
  overrides: Partial<LocalSqliteGenerationRetentionLimits> = {},
): LocalSqliteGenerationRetentionLimits {
  const limits = { ...DEFAULT_LOCAL_SQLITE_GENERATION_RETENTION, ...overrides };
  if (!Number.isSafeInteger(limits.maxGenerations) || limits.maxGenerations < 2) {
    throw new Error('Local SQLite generation retention must keep at least current and previous generations.');
  }
  if (!Number.isSafeInteger(limits.maxLogicalBytes) || limits.maxLogicalBytes <= 0) {
    throw new Error('Local SQLite generation byte retention must be a positive safe integer.');
  }
  return limits;
}

function localGenerationEntries(outputDb: string): Array<{
  identity: string;
  path: string;
  logicalBytes: number;
  modifiedAtMs: number;
}> {
  const root = sqliteGenerationRoot(outputDb);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => {
      const path = join(root, entry.name);
      const manifest = readSqliteGenerationManifestFromRoot(root, entry.name);
      const logicalBytes = manifest
        ? manifest.database.size + (manifest.index?.size ?? 0) + (manifest.metadata?.size ?? 0)
        : directoryLogicalBytes(path);
      return { identity: entry.name, path, logicalBytes, modifiedAtMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.identity.localeCompare(right.identity));
}

function directoryLogicalBytes(path: string): number {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += directoryLogicalBytes(child);
    else if (entry.isFile()) bytes += statSync(child).size;
  }
  return bytes;
}

function writeLocalGenerationRetentionResult(outputDb: string, result: LocalSqliteGenerationRetentionResult): void {
  writeJsonAtomic(join(sqliteGenerationRoot(outputDb), 'gc.json'), result, {
    spacing: 2,
    trailingNewline: true,
  });
}

function readLocalGenerationRetentionResult(outputDb: string): LocalSqliteGenerationRetentionResult | undefined {
  try {
    const value = JSON.parse(
      readSmallArtifactText(join(sqliteGenerationRoot(outputDb), 'gc.json'), 'local SQLite generation GC status'),
    ) as LocalSqliteGenerationRetentionResult;
    if (
      !value ||
      (value.state !== 'within-bounds' &&
        value.state !== 'collected' &&
        value.state !== 'protected' &&
        value.state !== 'deferred' &&
        value.state !== 'error') ||
      !Number.isSafeInteger(value.generationCount) ||
      value.generationCount < 0 ||
      !Number.isFinite(value.logicalBytes) ||
      value.logicalBytes < 0 ||
      !Number.isFinite(Date.parse(value.at))
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function inspectSqliteGeneration(
  outputDb: string,
  metaPath = join(dirname(outputDb), 'meta.json'),
): SqliteGenerationInspection {
  const statePath = join(sqliteGenerationRoot(outputDb), 'state.json');
  if (!existsSync(statePath)) return { state: 'legacy', statePath };
  const generation = readSqliteGenerationState(outputDb);
  if (!generation) return { state: 'invalid', statePath, reason: 'generation state is malformed' };
  try {
    const manifest = readSqliteGenerationManifest(outputDb, generation.currentGeneration);
    const currentExists = manifest !== null;
    const currentMatches = manifest ? stableMirrorsMatch(outputDb, metaPath, manifest, generation) : false;
    const recoveryExists = generation.previousGeneration
      ? existsSync(join(dirname(outputDb), generation.previousGeneration.databasePath))
      : true;
    if (!currentMatches || !currentExists || !recoveryExists) {
      return {
        state: 'drifted',
        statePath,
        currentMatches,
        recoveryExists,
        generation,
        reason: !currentExists
          ? 'published immutable generation is missing'
          : !currentMatches
            ? 'stable database or metadata no longer matches the published generation'
            : 'retained recovery database is missing',
      };
    }
    return { state: 'current', statePath, currentMatches, recoveryExists, generation };
  } catch (error) {
    return {
      state: 'drifted',
      statePath,
      currentMatches: false,
      recoveryExists: false,
      generation,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function stableMirrorsMatch(
  outputDb: string,
  metaPath: string,
  manifest: SqliteGenerationManifest,
  state: SqliteGenerationState,
): boolean {
  if (
    state.stableMirrors &&
    (state.stableMirrors.databaseFileIdentity !== fileIdentity(outputDb) ||
      (state.stableMirrors.indexFileIdentity !== undefined &&
        state.stableMirrors.indexFileIdentity !== fileIdentity(join(dirname(outputDb), 'index.scip'))))
  ) {
    return false;
  }
  if (!artifactSizeMatches(outputDb, manifest.database)) return false;
  const stableIndex = join(dirname(outputDb), 'index.scip');
  if (manifest.index && !artifactSizeMatches(stableIndex, manifest.index)) return false;
  if (!manifest.metadata) return !existsSync(metaPath);
  if (!existsSync(metaPath)) return false;
  const immutableMetaPath = join(sqliteGenerationRoot(outputDb), manifest.identity, manifest.metadata.file);
  return (
    existsSync(immutableMetaPath) &&
    stableMetadataIdentity(readSmallArtifactText(metaPath, 'reindex metadata')) ===
      stableMetadataIdentity(readSmallArtifactText(immutableMetaPath, 'immutable reindex metadata'))
  );
}

function artifactSizeMatches(path: string, artifact: SqliteGenerationArtifact): boolean {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size === artifact.size;
}

function retainPublishedGeneration(input: PromoteReindexArtifactsInput): SqliteGenerationRecovery | undefined {
  const published = ensureImmutableSqliteGeneration(input.outputDb, input.outputScip, input.metaPath);
  return published ? recoveryForGeneration(input.outputDb, published.currentGeneration) : undefined;
}

function stableMirrorIdentity(
  databasePath: string,
  indexPath: string,
): NonNullable<SqliteGenerationState['stableMirrors']> {
  return {
    databaseFileIdentity: fileIdentity(databasePath),
    ...(existsSync(indexPath) ? { indexFileIdentity: fileIdentity(indexPath) } : {}),
  };
}

function recoveryForGeneration(outputDb: string, identity: string): SqliteGenerationRecovery {
  const directory = join(sqliteGenerationRoot(outputDb), identity);
  const databasePath = join(directory, basename(outputDb));
  const metadataPath = join(directory, 'meta.json');
  return {
    generationIdentity: identity,
    databasePath: relative(dirname(outputDb), databasePath),
    ...(existsSync(metadataPath) ? { metadataPath: relative(dirname(outputDb), metadataPath) } : {}),
  };
}

function removeAbandonedStagingDirectories(generationRoot: string): void {
  if (!existsSync(generationRoot)) return;
  for (const entry of readdirSync(generationRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.tmp')) {
      rmSync(join(generationRoot, entry.name), { recursive: true, force: true });
    }
  }
}

export function sqliteGenerationIdentity(
  metaPath: string,
  databasePath: string,
  indexPath = join(dirname(databasePath), 'index.scip'),
): string {
  const hash = createHash('sha256').update('sqlite-generation-artifacts-v1\0');
  hash.update(hashFile(databasePath));
  if (existsSync(indexPath)) hash.update(`\0${hashFile(indexPath)}`);
  if (existsSync(metaPath)) {
    hash.update(`\0${stableMetadataIdentity(readSmallArtifactText(metaPath, 'reindex metadata'))}`);
  }
  return hash.digest('hex');
}

function materializeGeneration(input: {
  generationRoot: string;
  databasePath: string;
  indexPath?: string;
  metadataPath?: string;
  forcedIdentity?: string;
}): { identity: string; directorySync: Exclude<DirectorySyncStatus, 'not-requested'> } {
  const database = describeArtifact(input.databasePath);
  const index = input.indexPath ? describeArtifact(input.indexPath) : undefined;
  const metadata = input.metadataPath ? describeArtifact(input.metadataPath) : undefined;
  const identity = input.forcedIdentity ?? generationIdentityFromArtifacts(database, index, input.metadataPath);
  const generationDirectory = join(input.generationRoot, identity);
  const existingManifestPath = join(generationDirectory, SQLITE_GENERATION_MANIFEST);
  if (existsSync(existingManifestPath)) {
    const existing = readSqliteGenerationManifestFromRoot(input.generationRoot, identity);
    if (
      existing &&
      storedArtifactMatches(generationDirectory, existing.database, database) &&
      optionalStoredArtifactMatches(generationDirectory, existing.index, index) &&
      storedMetadataMatches(generationDirectory, existing.metadata, input.metadataPath)
    ) {
      return { identity, directorySync: syncDirectoryDurable(input.generationRoot) };
    }
    throw new Error(`SQLite generation ${identity} already exists with different or corrupt artifacts.`);
  }

  const directoryStatuses: Exclude<DirectorySyncStatus, 'not-requested'>[] = [
    ensureDirectoryDurable(input.generationRoot),
  ];
  removeAbandonedStagingDirectories(input.generationRoot);
  const temporaryDirectory = `${generationDirectory}.${process.pid}.${Date.now()}.tmp`;
  rmSync(temporaryDirectory, { recursive: true, force: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  try {
    directoryStatuses.push(cloneArtifact(input.databasePath, join(temporaryDirectory, database.file)));
    if (index && input.indexPath) {
      directoryStatuses.push(cloneArtifact(input.indexPath, join(temporaryDirectory, index.file)));
    }
    if (metadata && input.metadataPath) {
      directoryStatuses.push(cloneArtifact(input.metadataPath, join(temporaryDirectory, metadata.file)));
    }
    const manifestWrite = writeJsonDurable(
      join(temporaryDirectory, SQLITE_GENERATION_MANIFEST),
      {
        version: SQLITE_GENERATION_MANIFEST_VERSION,
        identity,
        database,
        ...(index ? { index } : {}),
        ...(metadata ? { metadata } : {}),
      } satisfies SqliteGenerationManifest,
      { spacing: 2, trailingNewline: true },
    );
    if (manifestWrite.directorySync !== 'not-requested') directoryStatuses.push(manifestWrite.directorySync);
    directoryStatuses.push(syncDirectoryDurable(temporaryDirectory));
    renameSync(temporaryDirectory, generationDirectory);
    directoryStatuses.push(syncDirectoryDurable(input.generationRoot));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return { identity, directorySync: mergeDirectorySyncStatus(...directoryStatuses) };
}

function generationIdentityFromArtifacts(
  database: SqliteGenerationArtifact,
  index: SqliteGenerationArtifact | undefined,
  metadataPath: string | undefined,
): string {
  const hash = createHash('sha256').update('sqlite-generation-artifacts-v1\0');
  hash.update(database.sha256);
  if (index) hash.update(`\0${index.sha256}`);
  if (metadataPath) {
    hash.update(`\0${stableMetadataIdentity(readSmallArtifactText(metadataPath, 'reindex metadata'))}`);
  }
  return hash.digest('hex');
}

function describeArtifact(path: string): SqliteGenerationArtifact {
  return {
    file: basename(path),
    size: statSync(path).size,
    sha256: hashFile(path),
  };
}

function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readFileChunk(fd, buffer);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function readFileChunk(fd: number, buffer: Buffer): number {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null);
    offset += bytesRead;
    if (bytesRead === 0) break;
  }
  return offset;
}

function cloneArtifact(source: string, target: string): Exclude<DirectorySyncStatus, 'not-requested'> {
  return cloneFileDurable(source, target, { mode: 0o444 });
}

function storedArtifactMatches(
  directory: string,
  stored: SqliteGenerationArtifact,
  candidate: SqliteGenerationArtifact,
): boolean {
  const path = join(directory, stored.file);
  return (
    stored.file === candidate.file &&
    stored.size === candidate.size &&
    stored.sha256 === candidate.sha256 &&
    existsSync(path) &&
    statSync(path).size === stored.size &&
    hashFile(path) === stored.sha256
  );
}

function optionalStoredArtifactMatches(
  directory: string,
  stored: SqliteGenerationArtifact | undefined,
  candidate: SqliteGenerationArtifact | undefined,
): boolean {
  if (!stored || !candidate) return stored === candidate;
  return storedArtifactMatches(directory, stored, candidate);
}

function storedMetadataMatches(
  directory: string,
  stored: SqliteGenerationArtifact | undefined,
  candidatePath: string | undefined,
): boolean {
  if (!stored || !candidatePath) return stored === undefined && candidatePath === undefined;
  const storedPath = join(directory, stored.file);
  return (
    existsSync(storedPath) &&
    stableMetadataIdentity(readSmallArtifactText(storedPath, 'stored reindex metadata')) ===
      stableMetadataIdentity(readSmallArtifactText(candidatePath, 'candidate reindex metadata'))
  );
}

function replaceFile(source: string, target: string): void {
  rmSync(`${target}.tmp-replace`, { force: true });
  renameSync(source, `${target}.tmp-replace`);
  renameSync(`${target}.tmp-replace`, target);
}
