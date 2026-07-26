import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildProjectChangeManifest } from '../domain/project-input.js';
import { monotonicNowMs } from '../domain/time.js';
import type { FileDependencyGraph, ProjectChangeManifest, ProjectInputSnapshot } from '../domain/project-input.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { ScipDatabase } from '../storage/db.js';
import { isRecord, stringArray } from '../storage/evidence-payload.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { buildFileDepGraph } from '../symbols/graph/file-dep-graph.js';
import { classifyAffectedSetFallback, planAffectedFiles, type AffectedFilePlan } from './affected-set.js';
import { appendRotatingJsonlRecord, ROTATING_JSONL_PREVIOUS_SUFFIX } from './rotating-jsonl.js';
import { readSourceArtifactText } from '../platform/bounded-file.js';

export const GLOBAL_FACTS_UNIT = '<global-symbols>';

export type DocumentFactValue = string | number | null;

// scip-query: ignore-stale — reviewed S1 owned contract; the shadow evaluator constructs and validates this document fact.
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

// scip-query: ignore-stale — reviewed S1 owned contract; this record is the persisted evaluated shadow result.
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

interface AffectedSetShadowHistoryRecordBase {
  historyVersion: 1;
  sourceVersion: 1;
  refreshResult: 'rebuilt' | 'reused';
  recordedAt: string;
  durationMs: number;
}

export type AffectedSetShadowHistoryRecord =
  | (AffectedSetShadowHistoryRecordBase & {
      status: 'evaluated';
      mode: AffectedFilePlan['mode'];
      passed: boolean;
      recall: number;
      affectedRatio: number;
      predictedFileCount: number;
      actualFileCount: number;
      missingFileCount: number;
      fallbackReasons: string[];
    })
  | (AffectedSetShadowHistoryRecordBase & {
      status: 'unavailable';
      reason: AffectedSetShadowUnavailableReason;
      error?: string;
    });

export interface AffectedSetShadowPaths {
  latestPath: string;
  historyPath: string;
}

export type AffectedSetShadowStatusUnavailableReason =
  | AffectedSetShadowUnavailableReason
  | 'telemetry-missing'
  | 'telemetry-unreadable'
  | 'telemetry-malformed'
  | 'unsupported-record-version';

// scip-query: ignore-stale — reviewed S1 owned contract; the status union makes every shadow-read state explicit.
export type AffectedSetShadowStatus =
  | {
      state: 'passing' | 'failing';
      latestPath: string;
      historyPath: string;
      recordedAt: string;
      refreshResult: 'rebuilt' | 'reused';
      durationMs: number;
      mode: AffectedFilePlan['mode'];
      recall: number;
      affectedRatio: number;
      predictedFiles: string[];
      actualFiles: string[];
      missingFiles: string[];
      fallbackReasons: string[];
    }
  | {
      state: 'unavailable';
      latestPath: string;
      historyPath: string;
      reason: AffectedSetShadowStatusUnavailableReason;
      recordedAt?: string;
      refreshResult?: 'rebuilt' | 'reused';
      durationMs?: number;
      error?: string;
    };

// scip-query: ignore-stale — reviewed S1 owned contract; shadow evaluation owns this narrowed database boundary.
export interface AffectedShadowDatabase extends DocumentFactQuery {
  close(): void;
}

// scip-query: ignore-stale — reviewed S1 owned contract; this interface is the injectable shadow-runtime boundary.
export interface AffectedSetShadowRuntime {
  /** @deprecated Use wallNow and monotonicNow when the clocks must be tested independently. */
  now(): number;
  wallNow?(): number;
  monotonicNow?(): number;
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function collectAffectedSetShadowRecord(
  options: CollectAffectedSetShadowOptions,
  runtime: AffectedSetShadowRuntime = defaultAffectedSetShadowRuntime,
): AffectedSetShadowRecord {
  const legacyClock = runtime.wallNow === undefined && runtime.monotonicNow === undefined;
  const monotonicNow = runtime.monotonicNow ?? runtime.now;
  const wallNow = runtime.wallNow ?? runtime.now;
  const startedAt = monotonicNow();
  const finishUnavailable = (
    reason: AffectedSetShadowUnavailableReason,
    error?: string,
  ): UnavailableAffectedSetShadowRecord => {
    const finishedAt = monotonicNow();
    return unavailableAffectedSetShadowRecord(
      options.refreshResult,
      reason,
      legacyClock ? finishedAt : wallNow(),
      Math.max(0, finishedAt - startedAt),
      error,
    );
  };
  if (!runtime.databaseExists(options.previousDbPath)) {
    return finishUnavailable('prior-index-unavailable');
  }
  if (!runtime.databaseExists(options.candidateDbPath)) {
    return finishUnavailable('candidate-index-unavailable');
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
    const finishedAt = monotonicNow();
    return {
      version: 1,
      status: 'evaluated',
      refreshResult: options.refreshResult,
      recordedAt: new Date(legacyClock ? finishedAt : wallNow()).toISOString(),
      durationMs: Math.max(0, finishedAt - startedAt),
      manifest,
      plan,
      comparison,
      evaluation: evaluateAffectedSetShadow(plan, comparison, projectFiles.length),
    };
  } catch (error) {
    return finishUnavailable('oracle-error', error instanceof Error ? error.message : String(error));
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
  return unavailableAffectedSetShadowRecord(refreshResult, reason, now, 0, error);
}

export function affectedSetShadowPaths(outputDb: string): AffectedSetShadowPaths {
  const cacheDir = dirname(outputDb);
  return {
    latestPath: join(cacheDir, 'affected-shadow-latest.json'),
    historyPath: join(cacheDir, 'affected-shadow.jsonl'),
  };
}

// scip-query: ignore-extract — reviewed E3 feature-local pipeline; validation and telemetry classify one shadow-status read.
export function readAffectedSetShadowStatus(
  outputDb: string,
  readFile: (path: string) => string = (path) => readSourceArtifactText(path, 'affected-shadow source file'),
): AffectedSetShadowStatus {
  const paths = affectedSetShadowPaths(outputDb);
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(paths.latestPath)) as unknown;
  } catch (error) {
    const missing = isMissingFileError(error);
    const reason = missing ? 'telemetry-missing' : telemetryReadFailureReason(error);
    return unavailableShadowStatus(
      paths,
      reason,
      missing ? undefined : error instanceof Error ? error.message : String(error),
    );
  }

  if (isRecord(raw) && typeof raw['version'] === 'number' && raw['version'] !== 1) {
    return unavailableShadowStatus(paths, 'unsupported-record-version', `Unsupported version ${raw['version']}.`);
  }
  if (!hasValidShadowRecordBase(raw)) {
    return unavailableShadowStatus(paths, 'telemetry-malformed');
  }
  if (raw['status'] === 'unavailable') {
    if (!isShadowUnavailableReason(raw['reason'])) return unavailableShadowStatus(paths, 'telemetry-malformed');
    return {
      state: 'unavailable',
      ...paths,
      reason: raw['reason'],
      recordedAt: raw['recordedAt'],
      refreshResult: raw['refreshResult'],
      durationMs: raw['durationMs'],
      ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
    };
  }
  if (raw['status'] !== 'evaluated') return unavailableShadowStatus(paths, 'telemetry-malformed');
  const plan = raw['plan'];
  const comparison = raw['comparison'];
  const evaluation = raw['evaluation'];
  if (!isRecord(raw['manifest']) || !isRecord(plan) || !isRecord(comparison) || !isRecord(evaluation)) {
    return unavailableShadowStatus(paths, 'telemetry-malformed');
  }

  const mode = plan['mode'];
  const planAffectedFiles = stringArray(plan['affectedFiles']);
  const fallbackReasons = stringArray(plan['reasons']);
  const changedFiles = stringArray(comparison['changedFiles']);
  const predictedFiles = stringArray(evaluation['predictedFiles']);
  const actualFiles = stringArray(evaluation['actualFiles']);
  const missingFiles = stringArray(evaluation['missingFiles']);
  const recall = evaluation['recall'];
  const affectedRatio = evaluation['affectedRatio'];
  if (
    (mode !== 'none' && mode !== 'closure' && mode !== 'full-project') ||
    planAffectedFiles === null ||
    fallbackReasons === null ||
    changedFiles === null ||
    predictedFiles === null ||
    actualFiles === null ||
    missingFiles === null ||
    typeof evaluation['passed'] !== 'boolean' ||
    !isUnitRatio(recall) ||
    !isUnitRatio(affectedRatio)
  ) {
    return unavailableShadowStatus(paths, 'telemetry-malformed');
  }
  const expectedRecall = actualFiles.length === 0 ? 1 : (actualFiles.length - missingFiles.length) / actualFiles.length;
  if (
    !sameOrderedStrings(planAffectedFiles, predictedFiles) ||
    !sameOrderedStrings(changedFiles, actualFiles) ||
    evaluation['passed'] !== (missingFiles.length === 0) ||
    Math.abs(recall - expectedRecall) > Number.EPSILON ||
    missingFiles.some((file) => !actualFiles.includes(file) || predictedFiles.includes(file))
  ) {
    return unavailableShadowStatus(paths, 'telemetry-malformed');
  }

  return {
    state: evaluation['passed'] ? 'passing' : 'failing',
    ...paths,
    recordedAt: raw['recordedAt'],
    refreshResult: raw['refreshResult'],
    durationMs: raw['durationMs'],
    mode,
    recall,
    affectedRatio,
    predictedFiles,
    actualFiles,
    missingFiles,
    fallbackReasons,
  };
}

export function formatAffectedSetShadowStatus(status: AffectedSetShadowStatus): string {
  if (status.state === 'unavailable') return `unavailable (${status.reason})`;
  const missing = status.missingFiles.length > 0 ? `, ${status.missingFiles.length} missed` : '';
  const fallback = status.fallbackReasons.length > 0 ? `; fallback: ${status.fallbackReasons.join(', ')}` : '';
  return (
    `${status.state}, ${(status.recall * 100).toFixed(1)}% recall, ` +
    `${status.predictedFiles.length} predicted / ${status.actualFiles.length} changed, ` +
    `${(status.affectedRatio * 100).toFixed(1)}% of project${missing}${fallback}`
  );
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

export const AFFECTED_SET_SHADOW_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const AFFECTED_SET_SHADOW_HISTORY_PREVIOUS_SUFFIX = ROTATING_JSONL_PREVIOUS_SUFFIX;

export function summarizeAffectedSetShadowRecord(record: AffectedSetShadowRecord): AffectedSetShadowHistoryRecord {
  const base: AffectedSetShadowHistoryRecordBase = {
    historyVersion: 1,
    sourceVersion: record.version,
    refreshResult: record.refreshResult,
    recordedAt: record.recordedAt,
    durationMs: record.durationMs,
  };
  if (record.status === 'unavailable') {
    return {
      ...base,
      status: 'unavailable',
      reason: record.reason,
      ...(record.error ? { error: record.error } : {}),
    };
  }
  return {
    ...base,
    status: 'evaluated',
    mode: record.plan.mode,
    passed: record.evaluation.passed,
    recall: record.evaluation.recall,
    affectedRatio: record.evaluation.affectedRatio,
    predictedFileCount: record.evaluation.predictedFiles.length,
    actualFileCount: record.evaluation.actualFiles.length,
    missingFileCount: record.evaluation.missingFiles.length,
    fallbackReasons: [...record.plan.reasons],
  };
}

export function appendAffectedSetShadowHistory(
  path: string,
  record: AffectedSetShadowRecord,
  maxBytes = AFFECTED_SET_SHADOW_HISTORY_MAX_BYTES,
): void {
  appendRotatingJsonlRecord(path, summarizeAffectedSetShadowRecord(record), {
    maxSegmentBytes: maxBytes,
    previousSuffix: AFFECTED_SET_SHADOW_HISTORY_PREVIOUS_SUFFIX,
  });
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
  wallNow: () => Date.now(),
  monotonicNow: monotonicNowMs,
  databaseExists: (path) => existsSync(path),
  openDatabase: (projectRoot, dbPath, indexPath) => new ScipDatabase({ projectRoot, dbPath, indexPath }),
  indexedPaths: (db) => indexedDocumentPaths(db as ScipDatabase),
  dependencyGraph: (db) => buildFileDepGraph(db as ScipDatabase),
  factDigests: (db) => readDocumentFactDigests(db),
};

const defaultAffectedSetShadowTelemetryRuntime: AffectedSetShadowTelemetryRuntime = {
  appendHistory: appendAffectedSetShadowHistory,
  writeLatest: (path, record) => writeJsonAtomic(path, record, { spacing: 2, trailingNewline: true }),
};

function unavailableAffectedSetShadowRecord(
  refreshResult: 'rebuilt' | 'reused',
  reason: AffectedSetShadowUnavailableReason,
  recordedAtMs: number,
  durationMs: number,
  error?: string,
): UnavailableAffectedSetShadowRecord {
  return {
    version: 1,
    status: 'unavailable',
    refreshResult,
    recordedAt: new Date(recordedAtMs).toISOString(),
    durationMs,
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

function hasValidShadowRecordBase(value: unknown): value is Record<string, unknown> & {
  version: 1;
  recordedAt: string;
  refreshResult: 'rebuilt' | 'reused';
  durationMs: number;
} {
  return (
    isRecord(value) &&
    value['version'] === 1 &&
    typeof value['recordedAt'] === 'string' &&
    (value['refreshResult'] === 'rebuilt' || value['refreshResult'] === 'reused') &&
    typeof value['durationMs'] === 'number' &&
    Number.isFinite(value['durationMs']) &&
    value['durationMs'] >= 0
  );
}

function isShadowUnavailableReason(value: unknown): value is AffectedSetShadowUnavailableReason {
  return value === 'prior-index-unavailable' || value === 'candidate-index-unavailable' || value === 'oracle-error';
}

function isUnitRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unavailableShadowStatus(
  paths: AffectedSetShadowPaths,
  reason: AffectedSetShadowStatusUnavailableReason,
  error?: string,
): AffectedSetShadowStatus {
  return { state: 'unavailable', ...paths, reason, ...(error ? { error } : {}) };
}

function telemetryReadFailureReason(error: unknown): 'telemetry-unreadable' | 'telemetry-malformed' {
  return error instanceof SyntaxError ? 'telemetry-malformed' : 'telemetry-unreadable';
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
