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
 * The gate consumes these via readSuppressionDir() unioned with the
 * legacy config array (see diff-gate.ts); the legacy array keeps working
 * but is no longer written to by the `suppress` command.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type FindingSuppression, type SuppressionDecision } from '../domain/config-types.js';
import { isSuppressionDecision } from '../domain/suppression-adjudication.js';
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
  if (suppression.id && suppression.id.trim() !== '') return `${suppression.id.trim()}.json`;
  const identity = `${suppression.check ?? ''}\0${suppression.file ?? ''}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12).toUpperCase();
  return `CHECK-${hash}.json`;
}

export function suppressionIdentity(suppression: FindingSuppression): string {
  return suppressionFileName(suppression).slice(0, -'.json'.length);
}

export function decodeSuppressionFile(
  value: unknown,
  expectedIdentity?: string,
): DecodedSuppressionFile | RejectedSuppressionFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'malformed', error: 'not a suppression object' };
  }
  const candidate = value as Partial<SuppressionFileRecord> & Record<string, unknown>;
  if (
    candidate.schemaVersion === undefined &&
    (candidate.kind !== undefined || candidate.suppressionIdentity !== undefined || candidate.writer !== undefined)
  ) {
    return { state: 'malformed', error: 'suppression envelope metadata requires schemaVersion' };
  }
  if (candidate.schemaVersion !== undefined) {
    if (!Number.isSafeInteger(candidate.schemaVersion)) {
      return { state: 'malformed', error: 'schemaVersion must be a positive safe integer' };
    }
    if (
      candidate.schemaVersion !== LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION &&
      candidate.schemaVersion !== SUPPRESSION_FILE_SCHEMA_VERSION
    ) {
      return {
        state: candidate.schemaVersion > SUPPRESSION_FILE_SCHEMA_VERSION ? 'unsupported-future' : 'unsupported-older',
        error: `unsupported schemaVersion ${String(candidate.schemaVersion)}`,
      };
    }
    if (candidate.kind !== undefined && candidate.kind !== SUPPRESSION_FILE_KIND) {
      return { state: 'malformed', error: `kind must be ${SUPPRESSION_FILE_KIND}` };
    }
  }
  if (candidate.schemaVersion === LEGACY_SUPPRESSION_FILE_SCHEMA_VERSION && candidate.decision !== undefined) {
    return { state: 'malformed', error: 'schemaVersion 1 cannot carry automated adjudication metadata' };
  }
  if (candidate.schemaVersion === SUPPRESSION_FILE_SCHEMA_VERSION && !isSuppressionDecision(candidate.decision)) {
    return { state: 'malformed', error: 'schemaVersion 2 requires a valid automated adjudication decision' };
  }
  if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') {
    return { state: 'malformed', error: 'missing reason' };
  }
  if (!candidate.id && !candidate.check) {
    return { state: 'malformed', error: 'needs an id or a check' };
  }
  const suppression = suppressionFromRecord(candidate as FindingSuppression);
  if (candidate.schemaVersion === undefined) {
    return { state: 'legacy', suppression, record: candidate as FindingSuppression, schemaVersion: 0 };
  }
  const identity = suppressionIdentity(suppression);
  if (
    candidate.suppressionIdentity !== identity ||
    (expectedIdentity !== undefined && candidate.suppressionIdentity !== expectedIdentity)
  ) {
    return { state: 'malformed', error: 'suppressionIdentity does not match the suppression target or filename' };
  }
  if (
    !candidate.writer ||
    candidate.writer.tool !== 'scip-query' ||
    typeof candidate.writer.version !== 'string' ||
    candidate.writer.version.trim() === ''
  ) {
    return { state: 'malformed', error: 'missing valid writer metadata' };
  }
  if (typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt))) {
    return { state: 'malformed', error: 'missing valid createdAt timestamp' };
  }
  if (
    candidate.updatedAt !== undefined &&
    (typeof candidate.updatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.updatedAt)))
  ) {
    return { state: 'malformed', error: 'invalid updatedAt timestamp' };
  }
  const current = candidate.schemaVersion === SUPPRESSION_FILE_SCHEMA_VERSION;
  return {
    state: current ? 'current' : 'legacy',
    suppression,
    record: candidate as Omit<SuppressionFileRecord, 'kind'> & { kind?: typeof SUPPRESSION_FILE_KIND },
    schemaVersion: candidate.schemaVersion,
  };
}

export function readSuppressionDir(projectRoot: string): SuppressionDirReadResult {
  const dir = suppressionDirPath(projectRoot);
  if (!existsSync(dir)) {
    return { suppressions: [], compatibility: summarizeRecordCompatibility([]), warnings: [] };
  }

  const suppressions: FindingSuppression[] = [];
  const observations: RecordCompatibilityObservation[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
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
    observations.push({ path: recordPath, state: decoded.state });
    suppressions.push(decoded.suppression);
  }
  const compatibility = summarizeRecordCompatibility(observations);
  return {
    suppressions,
    compatibility,
    warnings: compatibility.issues.map((issue) => `${issue.path}: ${issue.reason} — ignored`),
  };
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
