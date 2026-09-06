/**
 * Directory-based suppression store: one file per suppression under
 * .scipquery/suppressions/<name>.json in the target repo.
 *
 * Why a directory instead of the .scipquery.json suppressions[] array:
 * different suppressions land in different files, so concurrent branches
 * adding suppressions merge without conflict by construction. The only
 * possible collision is two branches suppressing the same finding with
 * different reasons — rare, and a one-line human resolution.
 *
 * Database-backed analysis loads these together with the legacy config array.
 * The legacy array remains readable but is no longer written by `suppress`.
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type FindingSuppression, type SuppressionDecision } from '../domain/config-types.js';
import { isSuppressionDecision } from '../domain/suppression-adjudication.js';
import { isRecordObject } from '../domain/record-validation.js';
import { readSmallArtifactText } from '../filesystem/bounded-file.js';
import {
  summarizeRecordCompatibility,
  type RecordCompatibilityObservation,
  type RecordCompatibilityState,
  type RecordCompatibilitySummary,
} from '../domain/record-compatibility.js';

export const SUPPRESSION_DIR = join('.scipquery', 'suppressions');
export const SUPPRESSION_FILE_KIND = 'scip-query-suppression';
export const LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION = 1;
export const SUPPRESSION_FILE_SCHEMA_VERSION = 2;

interface SuppressionFileRecordEnvelope {
  kind: typeof SUPPRESSION_FILE_KIND;
  suppressionIdentity: string;
  writer: {
    tool: 'scip-query';
    version: string;
  };
  createdAt: string;
  updatedAt?: string;
}

// scip-query: ignore-stale -- Named legacy schema is required for versioned suppression-file compatibility.
export type SuppressionFileRecordV1 = Omit<FindingSuppression, 'createdAt' | 'decision'> &
  SuppressionFileRecordEnvelope & {
    schemaVersion: typeof LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION;
    decision?: never;
  };

export type SuppressionFileRecordV2 = Omit<FindingSuppression, 'createdAt' | 'decision'> &
  SuppressionFileRecordEnvelope & {
    schemaVersion: typeof SUPPRESSION_FILE_SCHEMA_VERSION;
    decision: SuppressionDecision;
  };

export type SuppressionFileRecord = SuppressionFileRecordV1 | SuppressionFileRecordV2;

export interface DecodedSuppressionFile {
  state: 'legacy' | 'current';
  suppression: FindingSuppression;
  record: FindingSuppression | (Omit<SuppressionFileRecord, 'kind'> & { kind?: typeof SUPPRESSION_FILE_KIND });
  schemaVersion: 0 | typeof LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION | typeof SUPPRESSION_FILE_SCHEMA_VERSION;
}

export interface RejectedSuppressionFile {
  state: Exclude<RecordCompatibilityState, 'legacy' | 'current'>;
  error: string;
}

export interface SuppressionDirReadResult {
  suppressions: FindingSuppression[];
  compatibility: RecordCompatibilitySummary;
  /** Human-readable notes corresponding one-to-one with omitted record candidates. */
  warnings: string[];
}

export function suppressionDirPath(projectRoot: string): string {
  return join(projectRoot, SUPPRESSION_DIR);
}

/**
 * Stable, deterministic filename for a suppression: the finding id when
 * present (the common agent path), otherwise a short hash of the
 * check+file identity so the same policy target has one conflict domain.
 */
export function suppressionFileName(suppression: FindingSuppression): string {
  const identity = suppressionIdentity(suppression);
  // Preserve portable legacy names; reserve ID- for encoded identities.
  if (/^[A-Za-z0-9_-]{1,120}$/.test(identity) && !/^(ID-|CON$|PRN$|AUX$|NUL$|COM[1-9]$|LPT[1-9]$)/i.test(identity)) {
    return `${identity}.json`;
  }
  return `ID-${createHash('sha256').update(identity).digest('hex')}.json`;
}

export function suppressionIdentity(suppression: FindingSuppression): string {
  if (suppression.id && suppression.id.trim() !== '') return suppression.id.trim();
  const identity = `${suppression.check ?? ''}\0${suppression.file ?? ''}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12).toUpperCase();
  return `CHECK-${hash}`;
}

/** Reject symbolic storage components before reading or mutating a record. */
export function assertSuppressionPath(projectRoot: string, path: string): void {
  const root = resolve(projectRoot);
  const within = relative(root, resolve(path));
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) {
    throw new Error('Suppression path must remain inside the project.');
  }
  let current = root;
  for (const component of within.split(sep)) {
    current = join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in suppression storage: ${current}`);
  }
}

/** Existing nested records stay in their original revision/conflict domain. New records use safe flat names. */
export function suppressionWritePath(projectRoot: string, suppression: FindingSuppression): string {
  const dir = suppressionDirPath(projectRoot);
  const path = join(dir, suppressionFileName(suppression));
  assertSuppressionPath(projectRoot, path);
  const legacy = join(dir, `${suppressionIdentity(suppression)}.json`);
  const within = relative(resolve(dir), resolve(legacy));
  if (legacy !== path && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)) {
    assertSuppressionPath(projectRoot, legacy);
    if (existsSync(legacy)) {
      if (existsSync(path)) throw new Error(`Duplicate suppression records require reconciliation: ${path}, ${legacy}`);
      return legacy;
    }
  }
  return path;
}

export function decodeSuppressionFile(
  value: unknown,
  expectedIdentity?: string,
): DecodedSuppressionFile | RejectedSuppressionFile {
  if (!isRecordObject(value)) return { state: 'malformed', error: 'not a suppression object' };
  const version = suppressionRecordVersion(value);
  if (typeof version !== 'number') return version;
  const decisionError = suppressionDecisionError(value.decision, version);
  if (decisionError) return { state: 'malformed', error: decisionError };
  const suppression = decodeSuppressionTarget(value);
  if ('error' in suppression) return suppression;
  if (version === 0) {
    return { state: 'legacy', suppression, record: value as unknown as FindingSuppression, schemaVersion: 0 };
  }
  const metadataError = suppressionMetadataError(value, suppression, expectedIdentity);
  if (metadataError) return { state: 'malformed', error: metadataError };
  return {
    state: version === SUPPRESSION_FILE_SCHEMA_VERSION ? 'current' : 'legacy',
    suppression,
    record: value as Omit<SuppressionFileRecord, 'kind'> & { kind?: typeof SUPPRESSION_FILE_KIND },
    schemaVersion: version,
  };
}

function suppressionRecordVersion(candidate: Record<string, unknown>): 0 | 1 | 2 | RejectedSuppressionFile {
  const version = candidate.schemaVersion;
  if (version === undefined) {
    if (['kind', 'suppressionIdentity', 'writer'].some((key) => candidate[key] !== undefined)) {
      return { state: 'malformed', error: 'suppression envelope metadata requires schemaVersion' };
    }
    return 0;
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return { state: 'malformed', error: 'schemaVersion must be a positive safe integer' };
  }
  if (version !== LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION && version !== SUPPRESSION_FILE_SCHEMA_VERSION) {
    return {
      state: version > SUPPRESSION_FILE_SCHEMA_VERSION ? 'unsupported-future' : 'unsupported-older',
      error: `unsupported schemaVersion ${String(version)}`,
    };
  }
  if (candidate.kind !== undefined && candidate.kind !== SUPPRESSION_FILE_KIND) {
    return { state: 'malformed', error: `kind must be ${SUPPRESSION_FILE_KIND}` };
  }
  return version;
}

function suppressionDecisionError(decision: unknown, version: 0 | 1 | 2): string | null {
  if (version === LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION && decision !== undefined) {
    return 'schemaVersion 1 cannot carry automated adjudication metadata';
  }
  if (version === SUPPRESSION_FILE_SCHEMA_VERSION && !isSuppressionDecision(decision)) {
    return 'schemaVersion 2 requires a valid automated adjudication decision';
  }
  if (version === 0 && decision !== undefined && !isSuppressionDecision(decision)) {
    return 'invalid automated adjudication decision';
  }
  return null;
}

function decodeSuppressionTarget(candidate: Record<string, unknown>): FindingSuppression | RejectedSuppressionFile {
  if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') {
    return { state: 'malformed', error: 'missing reason' };
  }
  const suppression = suppressionFromRecord(candidate as unknown as FindingSuppression);
  if (!suppression.id?.trim() && !suppression.check?.trim()) {
    return { state: 'malformed', error: 'needs an id or a check' };
  }
  return suppression;
}

function suppressionMetadataError(
  candidate: Record<string, unknown>,
  suppression: FindingSuppression,
  expectedIdentity?: string,
): string | null {
  if (
    candidate.suppressionIdentity !== suppressionIdentity(suppression) ||
    (expectedIdentity !== undefined &&
      candidate.suppressionIdentity !== expectedIdentity &&
      suppressionFileName(suppression).slice(0, -'.json'.length) !== expectedIdentity)
  ) {
    return 'suppressionIdentity does not match the suppression target or filename';
  }
  if (!isSuppressionWriter(candidate.writer)) return 'missing valid writer metadata';
  if (!isTimestamp(candidate.createdAt)) return 'missing valid createdAt timestamp';
  if (candidate.updatedAt !== undefined && !isTimestamp(candidate.updatedAt)) return 'invalid updatedAt timestamp';
  return null;
}

function isSuppressionWriter(value: unknown): boolean {
  return (
    isRecordObject(value) &&
    value.tool === 'scip-query' &&
    typeof value.version === 'string' &&
    value.version.trim() !== ''
  );
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function readSuppressionDir(projectRoot: string): SuppressionDirReadResult {
  const dir = suppressionDirPath(projectRoot);
  assertSuppressionPath(projectRoot, dir);
  if (!existsSync(dir)) {
    return { suppressions: [], compatibility: summarizeRecordCompatibility([]), warnings: [] };
  }

  const records = new Map<string, { suppression: FindingSuppression; path: string }>();
  const conflicts = new Set<string>();
  const observations: RecordCompatibilityObservation[] = [];
  for (const entry of suppressionEntries(dir, observations)) {
    const path = join(dir, entry);
    const recordPath = `${SUPPRESSION_DIR}/${entry}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readSmallArtifactText(path, 'suppression record'));
    } catch {
      observations.push({ path: recordPath, state: 'malformed', reason: 'malformed JSON' });
      continue;
    }
    const decoded = decodeSuppressionFile(parsed, entry.slice(0, -'.json'.length));
    if ('error' in decoded) {
      observations.push({ path: recordPath, state: decoded.state, reason: decoded.error });
      continue;
    }
    const identity = suppressionIdentity(decoded.suppression);
    const previous = records.get(identity);
    if (previous && JSON.stringify(previous.suppression) !== JSON.stringify(decoded.suppression)) {
      conflicts.add(identity);
      observations.push({
        path: recordPath,
        state: 'malformed',
        reason: `conflicting suppression identity also in ${previous.path}`,
      });
    } else {
      observations.push({ path: recordPath, state: decoded.state });
      records.set(identity, { suppression: decoded.suppression, path: recordPath });
    }
  }
  const compatibility = summarizeRecordCompatibility(observations);
  return {
    suppressions: [...records].filter(([identity]) => !conflicts.has(identity)).map(([, record]) => record.suppression),
    compatibility,
    warnings: compatibility.issues.map((issue) => `${issue.path}: ${issue.reason} — ignored`),
  };
}

function suppressionEntries(dir: string, observations: RecordCompatibilityObservation[], prefix = ''): string[] {
  const entries: string[] = [];
  for (const item of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const entry = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) {
      observations.push({
        path: `${SUPPRESSION_DIR}/${entry}`,
        state: 'malformed',
        reason: 'symbolic suppression storage entry',
      });
    } else if (item.isDirectory()) {
      entries.push(...suppressionEntries(dir, observations, entry));
    } else if (item.isFile() && entry.endsWith('.json')) {
      entries.push(entry);
    }
  }
  return entries;
}

function suppressionFromRecord(record: FindingSuppression): FindingSuppression {
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.check === 'string' ? { check: record.check } : {}),
    ...(typeof record.file === 'string' ? { file: record.file } : {}),
    reason: record.reason,
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    ...(record.decision ? { decision: record.decision } : {}),
  };
}
