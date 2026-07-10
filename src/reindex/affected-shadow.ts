import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { ScipDatabase } from '../storage/db.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { buildFileDepGraph } from '../symbols/graph/file-dep-graph.js';
import { buildProjectChangeManifest, classifyAffectedSetFallback, planAffectedFiles } from './affected-set.js';
import type {
  AffectedFilePlan,
  FileDependencyGraph,
  ProjectChangeManifest,
  ProjectInputSnapshot,
} from './affected-set.js';

export const GLOBAL_FACTS_UNIT = '<global-symbols>';

export type DocumentFactValue = string | number | null;

export interface DocumentFactRecord {
  relativePath: string;
  kind: 'document' | 'chunk' | 'definition' | 'mention' | 'global-symbol';
  values: readonly DocumentFactValue[];
}

export interface DocumentFactQuery {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

export interface DocumentFactComparison {
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  changedFiles: string[];
  unchangedFiles: string[];
}

export interface AffectedSetShadowEvaluation {
  passed: boolean;
  recall: number;
  affectedRatio: number;
  predictedFiles: string[];
  actualFiles: string[];
  missingFiles: string[];
  extraFiles: string[];
}

export type AffectedSetShadowUnavailableReason =
  | 'prior-index-unavailable'
  | 'candidate-index-unavailable'
  | 'oracle-error';

interface AffectedSetShadowRecordBase {
  version: 1;
  refreshResult: 'rebuilt' | 'reused';
  recordedAt: string;
  durationMs: number;
}

export interface EvaluatedAffectedSetShadowRecord extends AffectedSetShadowRecordBase {
  status: 'evaluated';
  manifest: ProjectChangeManifest;
  plan: AffectedFilePlan;
  comparison: DocumentFactComparison;
  evaluation: AffectedSetShadowEvaluation;
}

export interface UnavailableAffectedSetShadowRecord extends AffectedSetShadowRecordBase {
  status: 'unavailable';
  reason: AffectedSetShadowUnavailableReason;
  error?: string;
}

export type AffectedSetShadowRecord = EvaluatedAffectedSetShadowRecord | UnavailableAffectedSetShadowRecord;

export interface AffectedSetShadowPaths {
  latestPath: string;
  historyPath: string;
}

export interface AffectedShadowDatabase extends DocumentFactQuery {
  close(): void;
}

export interface AffectedSetShadowRuntime {
  now(): number;
  databaseExists(path: string): boolean;
  openDatabase(projectRoot: string, dbPath: string, indexPath: string): AffectedShadowDatabase;
  indexedPaths(db: AffectedShadowDatabase): string[];
  dependencyGraph(db: AffectedShadowDatabase): FileDependencyGraph;
  factDigests(db: AffectedShadowDatabase): Map<string, string>;
}

export interface AffectedSetShadowTelemetryRuntime {
  appendHistory(path: string, record: AffectedSetShadowRecord): void;
  writeLatest(path: string, record: AffectedSetShadowRecord): void;
}

export interface CollectAffectedSetShadowOptions {
  projectRoot: string;
  previousDbPath: string;
  previousIndexPath: string;
  candidateDbPath: string;
  candidateIndexPath: string;
  previousSnapshot: ProjectInputSnapshot | null;
  currentSnapshot: ProjectInputSnapshot;
  refreshResult: 'rebuilt' | 'reused';
}

interface DocumentRow {
  relative_path: string;
  language: string | null;
  position_encoding: string | null;
  text: string | null;
}

interface ChunkRow {
  relative_path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  occurrences_hex: string;
}

interface DefinitionRow {
  relative_path: string;
  start_line: number;
  start_char: number;
  end_line: number;
  end_char: number;
  symbol: string;
  display_name: string | null;
  kind: number | null;
  documentation: string | null;
  signature_hex: string | null;
  enclosing_symbol: string | null;
  relationships_hex: string | null;
}

interface MentionRow {
  relative_path: string;
  chunk_index: number;
  role: number;
  symbol: string;
  display_name: string | null;
  kind: number | null;
  documentation: string | null;
  signature_hex: string | null;
  enclosing_symbol: string | null;
  relationships_hex: string | null;
}

interface GlobalSymbolRow {
  symbol: string;
  display_name: string | null;
  kind: number | null;
  documentation: string | null;
  signature_hex: string | null;
  enclosing_symbol: string | null;
  relationships_hex: string | null;
}

export function readDocumentFactDigests(db: DocumentFactQuery): Map<string, string> {
  const facts: DocumentFactRecord[] = [];

  for (const row of db.all<DocumentRow>(`
    SELECT relative_path, language, position_encoding, text
    FROM documents
  `)) {
    facts.push({
      relativePath: row.relative_path,
      kind: 'document',
      values: [row.language, row.position_encoding, row.text],
    });
  }

  for (const row of db.all<ChunkRow>(`
    SELECT d.relative_path,
           c.chunk_index,
           c.start_line,
           c.end_line,
           hex(c.occurrences) AS occurrences_hex
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
  `)) {
    facts.push({
      relativePath: row.relative_path,
      kind: 'chunk',
      values: [row.chunk_index, row.start_line, row.end_line, row.occurrences_hex],
    });
  }

  for (const row of db.all<DefinitionRow>(`
    SELECT d.relative_path,
           r.start_line,
           r.start_char,
           r.end_line,
           r.end_char,
           g.symbol,
           g.display_name,
           g.kind,
           g.documentation,
           CASE WHEN g.signature IS NULL THEN NULL ELSE hex(g.signature) END AS signature_hex,
           g.enclosing_symbol,
           CASE WHEN g.relationships IS NULL THEN NULL ELSE hex(g.relationships) END AS relationships_hex
    FROM defn_enclosing_ranges r
    JOIN documents d ON d.id = r.document_id
    JOIN global_symbols g ON g.id = r.symbol_id
  `)) {
    facts.push({
      relativePath: row.relative_path,
      kind: 'definition',
      values: symbolValues(row, [row.start_line, row.start_char, row.end_line, row.end_char]),
    });
  }

  for (const row of db.all<MentionRow>(`
    SELECT d.relative_path,
           c.chunk_index,
           m.role,
           g.symbol,
           g.display_name,
           g.kind,
           g.documentation,
           CASE WHEN g.signature IS NULL THEN NULL ELSE hex(g.signature) END AS signature_hex,
           g.enclosing_symbol,
           CASE WHEN g.relationships IS NULL THEN NULL ELSE hex(g.relationships) END AS relationships_hex
    FROM mentions m
    JOIN chunks c ON c.id = m.chunk_id
    JOIN documents d ON d.id = c.document_id
    JOIN global_symbols g ON g.id = m.symbol_id
  `)) {
    facts.push({
      relativePath: row.relative_path,
      kind: 'mention',
      values: symbolValues(row, [row.chunk_index, row.role]),
    });
  }

  for (const row of db.all<GlobalSymbolRow>(`
    SELECT g.symbol,
           g.display_name,
           g.kind,
           g.documentation,
           CASE WHEN g.signature IS NULL THEN NULL ELSE hex(g.signature) END AS signature_hex,
           g.enclosing_symbol,
           CASE WHEN g.relationships IS NULL THEN NULL ELSE hex(g.relationships) END AS relationships_hex
    FROM global_symbols g
    WHERE NOT EXISTS (
      SELECT 1 FROM defn_enclosing_ranges r WHERE r.symbol_id = g.id
    ) AND NOT EXISTS (
      SELECT 1 FROM mentions m WHERE m.symbol_id = g.id
    )
  `)) {
    facts.push({ relativePath: GLOBAL_FACTS_UNIT, kind: 'global-symbol', values: symbolValues(row) });
  }

  return digestDocumentFacts(facts);
}

export function digestDocumentFacts(records: readonly DocumentFactRecord[]): Map<string, string> {
  const encodedByPath = new Map<string, string[]>();
  for (const record of records) {
    const encoded = JSON.stringify([record.kind, record.values]);
    const entries = encodedByPath.get(record.relativePath) ?? [];
    entries.push(encoded);
    encodedByPath.set(record.relativePath, entries);
  }

  const digests = new Map<string, string>();
  for (const [relativePath, encodedFacts] of [...encodedByPath].sort(([left], [right]) => left.localeCompare(right))) {
    const hash = createHash('sha256');
    for (const encoded of encodedFacts.sort()) {
      hash.update(String(Buffer.byteLength(encoded)));
      hash.update(':');
      hash.update(encoded);
      hash.update('\n');
    }
    digests.set(relativePath, hash.digest('hex'));
  }
  return digests;
}

export function compareDocumentFactDigests(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): DocumentFactComparison {
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);

  for (const path of [...paths].sort()) {
    const beforeDigest = before.get(path);
    const afterDigest = after.get(path);
    if (beforeDigest === undefined) addedFiles.push(path);
    else if (afterDigest === undefined) deletedFiles.push(path);
    else if (beforeDigest !== afterDigest) modifiedFiles.push(path);
    else unchangedFiles.push(path);
  }

  return {
    addedFiles,
    modifiedFiles,
    deletedFiles,
    changedFiles: [...addedFiles, ...modifiedFiles, ...deletedFiles].sort(),
    unchangedFiles,
  };
}

export function evaluateAffectedSetShadow(
  plan: Pick<AffectedFilePlan, 'mode' | 'affectedFiles'>,
  comparison: DocumentFactComparison,
  projectFileCount: number,
): AffectedSetShadowEvaluation {
  const predicted = new Set(plan.affectedFiles);
  const actual = new Set(comparison.changedFiles);
  const missingFiles =
    plan.mode === 'full-project' ? [] : comparison.changedFiles.filter((path) => !predicted.has(path));
  const extraFiles = plan.affectedFiles.filter((path) => !actual.has(path)).sort();
  const coveredCount = comparison.changedFiles.length - missingFiles.length;

  return {
    passed: missingFiles.length === 0,
    recall: comparison.changedFiles.length === 0 ? 1 : coveredCount / comparison.changedFiles.length,
    affectedRatio: projectFileCount === 0 ? 0 : plan.affectedFiles.length / projectFileCount,
    predictedFiles: [...plan.affectedFiles].sort(),
    actualFiles: [...comparison.changedFiles],
    missingFiles,
    extraFiles,
  };
}

export function collectAffectedSetShadowRecord(
  options: CollectAffectedSetShadowOptions,
  runtime: AffectedSetShadowRuntime = defaultAffectedSetShadowRuntime,
): AffectedSetShadowRecord {
  const startedAt = runtime.now();
  if (!runtime.databaseExists(options.previousDbPath)) {
    return unavailableAffectedSetShadowRecord(
      options.refreshResult,
      'prior-index-unavailable',
      startedAt,
      runtime.now(),
    );
  }
  if (!runtime.databaseExists(options.candidateDbPath)) {
    return unavailableAffectedSetShadowRecord(
      options.refreshResult,
      'candidate-index-unavailable',
      startedAt,
      runtime.now(),
    );
  }

  let previousDb: AffectedShadowDatabase | null = null;
  let candidateDb: AffectedShadowDatabase | null = null;
  try {
    previousDb = runtime.openDatabase(options.projectRoot, options.previousDbPath, options.previousIndexPath);
    candidateDb = runtime.openDatabase(options.projectRoot, options.candidateDbPath, options.candidateIndexPath);
    const projectFiles = [
      ...new Set([...runtime.indexedPaths(previousDb), ...runtime.indexedPaths(candidateDb)]),
    ].sort();
    const manifest = buildProjectChangeManifest(options.previousSnapshot, options.currentSnapshot);
    const projectFileSet = new Set(projectFiles);
    const needsGraph =
      manifest.changes.length > 0 &&
      !classifyAffectedSetFallback(manifest).fullProject &&
      manifest.changes.every((change) => projectFileSet.has(change.path));
    const plan = planAffectedFiles(
      manifest,
      needsGraph ? runtime.dependencyGraph(previousDb) : new Map(),
      projectFiles,
    );
    const comparison = compareDocumentFactDigests(runtime.factDigests(previousDb), runtime.factDigests(candidateDb));
    const finishedAt = runtime.now();
    return {
      version: 1,
      status: 'evaluated',
      refreshResult: options.refreshResult,
      recordedAt: new Date(finishedAt).toISOString(),
      durationMs: Math.max(0, finishedAt - startedAt),
      manifest,
      plan,
      comparison,
      evaluation: evaluateAffectedSetShadow(plan, comparison, projectFiles.length),
    };
  } catch (error) {
    return unavailableAffectedSetShadowRecord(
      options.refreshResult,
      'oracle-error',
      startedAt,
      runtime.now(),
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    closeShadowDatabase(previousDb);
    closeShadowDatabase(candidateDb);
  }
}

export function createUnavailableAffectedSetShadowRecord(
  refreshResult: 'rebuilt' | 'reused',
  reason: AffectedSetShadowUnavailableReason,
  error?: string,
  now = Date.now(),
): UnavailableAffectedSetShadowRecord {
  return unavailableAffectedSetShadowRecord(refreshResult, reason, now, now, error);
}

export function affectedSetShadowPaths(outputDb: string): AffectedSetShadowPaths {
  const cacheDir = dirname(outputDb);
  return {
    latestPath: join(cacheDir, 'affected-shadow-latest.json'),
    historyPath: join(cacheDir, 'affected-shadow.jsonl'),
  };
}

export function writeAffectedSetShadowRecord(
  outputDb: string,
  record: AffectedSetShadowRecord,
  runtime: AffectedSetShadowTelemetryRuntime = defaultAffectedSetShadowTelemetryRuntime,
): AffectedSetShadowPaths {
  const paths = affectedSetShadowPaths(outputDb);
  runtime.appendHistory(paths.historyPath, record);
  runtime.writeLatest(paths.latestPath, record);
  return paths;
}

function symbolValues(row: GlobalSymbolRow, prefix: readonly DocumentFactValue[] = []): DocumentFactValue[] {
  const values: DocumentFactValue[] = [];
  for (const value of prefix) values.push(value);
  values.push(
    row.symbol,
    row.display_name,
    row.kind,
    row.documentation,
    row.signature_hex,
    row.enclosing_symbol,
    row.relationships_hex,
  );
  return values;
}

const defaultAffectedSetShadowRuntime: AffectedSetShadowRuntime = {
  now: () => Date.now(),
  databaseExists: (path) => existsSync(path),
  openDatabase: (projectRoot, dbPath, indexPath) => new ScipDatabase({ projectRoot, dbPath, indexPath }),
  indexedPaths: (db) => indexedDocumentPaths(db as ScipDatabase),
  dependencyGraph: (db) => buildFileDepGraph(db as ScipDatabase),
  factDigests: (db) => readDocumentFactDigests(db),
};

const defaultAffectedSetShadowTelemetryRuntime: AffectedSetShadowTelemetryRuntime = {
  appendHistory: (path, record) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  },
  writeLatest: (path, record) => writeJsonAtomic(path, record, { spacing: 2, trailingNewline: true }),
};

function unavailableAffectedSetShadowRecord(
  refreshResult: 'rebuilt' | 'reused',
  reason: AffectedSetShadowUnavailableReason,
  startedAt: number,
  finishedAt: number,
  error?: string,
): UnavailableAffectedSetShadowRecord {
  return {
    version: 1,
    status: 'unavailable',
    refreshResult,
    recordedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    reason,
    ...(error ? { error } : {}),
  };
}

function closeShadowDatabase(db: AffectedShadowDatabase | null): void {
  try {
    db?.close();
  } catch {
    // Shadow cleanup must not change whether the authoritative generation publishes.
  }
}
