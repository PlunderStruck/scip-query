import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { writeJsonDurable } from '../storage/atomic-json.js';

export const SQLITE_GENERATION_STORE_VERSION = 1;
export const SQLITE_GENERATION_DIRECTORY = '.scipquery-generations';

export type SqliteGenerationHandoffStage =
  | 'after-recovery-retained'
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

export interface SqliteGenerationRecovery {
  generationIdentity: string;
  databasePath: string;
  metadataPath?: string;
}

export interface SqliteGenerationState {
  version: typeof SQLITE_GENERATION_STORE_VERSION;
  currentGeneration: string;
  previousGeneration?: SqliteGenerationRecovery;
  publication?: SqlitePublicationRecord;
  publishedAt: string;
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
}

/**
 * Retains the accepted database, then changes the stable artifact paths in a
 * fixed order. Each database path always names one complete SQLite file.
 */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function promoteReindexArtifacts(input: PromoteReindexArtifactsInput): PromoteReindexArtifactsResult {
  const generationRoot = sqliteGenerationRoot(input.outputDb);
  const previousGeneration = retainPreviousGeneration(input, generationRoot);
  input.onStage?.('after-recovery-retained');

  if (!input.preserveOutputScip) replaceFile(input.tempOutputScip, input.outputScip);
  input.onStage?.('after-scip-handoff');
  replaceFile(input.tempOutputDb, input.outputDb);
  input.onStage?.('after-database-handoff');
  replaceFile(input.tempMetaPath, input.metaPath);
  input.onStage?.('after-metadata-handoff');

  const currentGeneration = sqliteGenerationIdentity(input.metaPath, input.outputDb);
  const state: SqliteGenerationState = {
    version: SQLITE_GENERATION_STORE_VERSION,
    currentGeneration,
    ...(previousGeneration ? { previousGeneration } : {}),
    ...(input.publication ? { publication: input.publication } : {}),
    publishedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  writeJsonDurable(join(generationRoot, 'state.json'), state, { spacing: 2, trailingNewline: true });
  return { currentGeneration, ...(previousGeneration ? { previousGeneration } : {}) };
}

export function readSqliteGenerationState(outputDb: string): SqliteGenerationState | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(sqliteGenerationRoot(outputDb), 'state.json'), 'utf8'),
    ) as Partial<SqliteGenerationState>;
    if (
      parsed.version !== SQLITE_GENERATION_STORE_VERSION ||
      typeof parsed.currentGeneration !== 'string' ||
      !parsed.currentGeneration ||
      typeof parsed.publishedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.publishedAt)) ||
      !validRecovery(parsed.previousGeneration) ||
      !validPublication(parsed.publication)
    ) {
      return null;
    }
    return parsed as SqliteGenerationState;
  } catch {
    return null;
  }
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
  const state: SqliteGenerationState = {
    version: SQLITE_GENERATION_STORE_VERSION,
    currentGeneration: sqliteGenerationIdentity(metaPath, outputDb),
    ...(previous?.previousGeneration ? { previousGeneration: previous.previousGeneration } : {}),
    ...(previous?.publication ? { publication: previous.publication } : {}),
    publishedAt: now().toISOString(),
  };
  writeJsonDurable(join(sqliteGenerationRoot(outputDb), 'state.json'), state, {
    spacing: 2,
    trailingNewline: true,
  });
  return state;
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
    const expectedGeneration = sqliteGenerationIdentity(metaPath, outputDb);
    const currentMatches = generation.currentGeneration === expectedGeneration;
    const recoveryExists = generation.previousGeneration
      ? existsSync(join(dirname(outputDb), generation.previousGeneration.databasePath))
      : true;
    if (!currentMatches || !recoveryExists) {
      return {
        state: 'drifted',
        statePath,
        currentMatches,
        recoveryExists,
        generation,
        reason: !currentMatches
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

export function sqliteGenerationRoot(outputDb: string): string {
  return join(dirname(outputDb), SQLITE_GENERATION_DIRECTORY);
}

function retainPreviousGeneration(
  input: PromoteReindexArtifactsInput,
  generationRoot: string,
): SqliteGenerationRecovery | undefined {
  if (!existsSync(input.outputDb)) return undefined;
  const generationIdentity = sqliteGenerationIdentity(input.metaPath, input.outputDb);
  const generationDir = join(generationRoot, generationIdentity);
  const databasePath = join(generationDir, basename(input.outputDb));
  const metadataPath = existsSync(input.metaPath) ? join(generationDir, basename(input.metaPath)) : undefined;

  if (!existsSync(databasePath)) {
    const temporaryDir = `${generationDir}.${process.pid}.${Date.now()}.tmp`;
    rmSync(temporaryDir, { recursive: true, force: true });
    mkdirSync(temporaryDir, { recursive: true });
    const temporaryDb = join(temporaryDir, basename(input.outputDb));
    try {
      linkSync(input.outputDb, temporaryDb);
    } catch {
      copyFileSync(input.outputDb, temporaryDb);
    }
    if (metadataPath) copyFileSync(input.metaPath, join(temporaryDir, basename(input.metaPath)));
    mkdirSync(generationRoot, { recursive: true });
    renameSync(temporaryDir, generationDir);
  }

  pruneRecoveryGenerations(generationRoot, generationIdentity);
  return {
    generationIdentity,
    databasePath: relative(dirname(input.outputDb), databasePath),
    ...(metadataPath ? { metadataPath: relative(dirname(input.outputDb), metadataPath) } : {}),
  };
}

function pruneRecoveryGenerations(generationRoot: string, keepIdentity: string): void {
  for (const entry of readdirSync(generationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keepIdentity || entry.name.endsWith('.tmp')) continue;
    rmSync(join(generationRoot, entry.name), { recursive: true, force: true });
  }
  for (const entry of readdirSync(generationRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.tmp')) {
      rmSync(join(generationRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function sqliteGenerationIdentity(metaPath: string, databasePath: string): string {
  const hash = createHash('sha256').update(`sqlite-generation-v${SQLITE_GENERATION_STORE_VERSION}\0`);
  if (existsSync(metaPath)) hash.update(stableMetadataIdentity(readFileSync(metaPath, 'utf8')));
  const stat = statSync(databasePath);
  hash.update(`\0${stat.size}`);
  return hash.digest('hex');
}

function stableMetadataIdentity(raw: string): string {
  try {
    const metadata = JSON.parse(raw) as {
      version?: unknown;
      status?: unknown;
      updatedAt?: unknown;
      fingerprint?: unknown;
      indexedLanguages?: unknown;
      scipCompanion?: unknown;
    };
    if (
      (metadata.version === 2 || metadata.version === 3) &&
      metadata.status === 'complete' &&
      typeof metadata.updatedAt === 'string' &&
      metadata.fingerprint !== undefined
    ) {
      return JSON.stringify({
        version: metadata.version,
        status: metadata.status,
        updatedAt: metadata.updatedAt,
        fingerprint: metadata.fingerprint,
        indexedLanguages: metadata.indexedLanguages,
        scipCompanion: metadata.scipCompanion,
      });
    }
  } catch {
    // Legacy/non-JSON metadata keeps its exact byte identity.
  }
  return raw;
}

function replaceFile(source: string, target: string): void {
  rmSync(`${target}.tmp-replace`, { force: true });
  renameSync(source, `${target}.tmp-replace`);
  renameSync(`${target}.tmp-replace`, target);
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
