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
import { writeJsonAtomic } from '../storage/atomic-json.js';

export const SQLITE_GENERATION_STORE_VERSION = 1;
const SQLITE_GENERATION_DIRECTORY = '.scipquery-generations';

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
  publishedAt: string;
}

export interface PromoteReindexArtifactsResult {
  currentGeneration: string;
  previousGeneration?: SqliteGenerationRecovery;
}

/**
 * Retains the accepted database, then changes the stable artifact paths in a
 * fixed order. Each database path always names one complete SQLite file.
 */
export function promoteReindexArtifacts(input: PromoteReindexArtifactsInput): PromoteReindexArtifactsResult {
  const generationRoot = sqliteGenerationRoot(input.outputDb);
  const previousGeneration = retainPreviousGeneration(input, generationRoot);
  input.onStage?.('after-recovery-retained');

  replaceFile(input.tempOutputScip, input.outputScip);
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
    publishedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  writeJsonAtomic(join(generationRoot, 'state.json'), state, { spacing: 2, trailingNewline: true });
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
      !validRecovery(parsed.previousGeneration)
    ) {
      return null;
    }
    return parsed as SqliteGenerationState;
  } catch {
    return null;
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
  if (existsSync(metaPath)) hash.update(readFileSync(metaPath));
  const stat = statSync(databasePath);
  hash.update(`\0${stat.size}`);
  return hash.digest('hex');
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
