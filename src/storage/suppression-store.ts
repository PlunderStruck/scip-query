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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FindingSuppression } from '../domain/config-types.js';

export const SUPPRESSION_DIR = join('.scipquery', 'suppressions');
export const SUPPRESSION_FILE_SCHEMA_VERSION = 1;

export interface SuppressionFileRecordV1 extends FindingSuppression {
  schemaVersion: typeof SUPPRESSION_FILE_SCHEMA_VERSION;
  suppressionIdentity: string;
  writer: {
    tool: 'scip-query';
    version: string;
  };
  createdAt: string;
  updatedAt?: string;
}

export interface DecodedSuppressionFile {
  suppression: FindingSuppression;
  record: FindingSuppression | SuppressionFileRecordV1;
  schemaVersion: 0 | typeof SUPPRESSION_FILE_SCHEMA_VERSION;
}

export interface SuppressionDirReadResult {
  suppressions: FindingSuppression[];
  /** Human-readable notes for files that could not be used (malformed JSON, missing reason). */
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
): DecodedSuppressionFile | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'not a suppression object' };
  }
  const candidate = value as Partial<SuppressionFileRecordV1>;
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== SUPPRESSION_FILE_SCHEMA_VERSION) {
    return { error: `unsupported schemaVersion ${String(candidate.schemaVersion)}` };
  }
  if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') {
    return { error: 'missing reason' };
  }
  if (!candidate.id && !candidate.check) {
    return { error: 'needs an id or a check' };
  }
  const suppression = suppressionFromRecord(candidate as FindingSuppression);
  if (candidate.schemaVersion === undefined) {
    return { suppression, record: candidate as FindingSuppression, schemaVersion: 0 };
  }
  const identity = suppressionIdentity(suppression);
  if (
    candidate.suppressionIdentity !== identity ||
    (expectedIdentity !== undefined && candidate.suppressionIdentity !== expectedIdentity)
  ) {
    return { error: 'suppressionIdentity does not match the suppression target or filename' };
  }
  if (
    !candidate.writer ||
    candidate.writer.tool !== 'scip-query' ||
    typeof candidate.writer.version !== 'string' ||
    candidate.writer.version.trim() === ''
  ) {
    return { error: 'missing valid writer metadata' };
  }
  if (typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt))) {
    return { error: 'missing valid createdAt timestamp' };
  }
  if (
    candidate.updatedAt !== undefined &&
    (typeof candidate.updatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.updatedAt)))
  ) {
    return { error: 'invalid updatedAt timestamp' };
  }
  return {
    suppression,
    record: candidate as SuppressionFileRecordV1,
    schemaVersion: SUPPRESSION_FILE_SCHEMA_VERSION,
  };
}

export function readSuppressionDir(projectRoot: string): SuppressionDirReadResult {
  const dir = suppressionDirPath(projectRoot);
  if (!existsSync(dir)) return { suppressions: [], warnings: [] };

  const suppressions: FindingSuppression[] = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      warnings.push(`${SUPPRESSION_DIR}/${entry}: malformed JSON — ignored`);
      continue;
    }
    const decoded = decodeSuppressionFile(parsed, entry.slice(0, -'.json'.length));
    if ('error' in decoded) {
      warnings.push(`${SUPPRESSION_DIR}/${entry}: ${decoded.error} — ignored`);
      continue;
    }
    suppressions.push(decoded.suppression);
  }
  return { suppressions, warnings };
}

function suppressionFromRecord(record: FindingSuppression): FindingSuppression {
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.check === 'string' ? { check: record.check } : {}),
    ...(typeof record.file === 'string' ? { file: record.file } : {}),
    reason: record.reason,
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
  };
}
