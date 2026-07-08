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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FindingSuppression } from '../domain/config-types.js';

export const SUPPRESSION_DIR = join('.scipquery', 'suppressions');

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
 * check+file identity so re-suppressing the same target overwrites
 * rather than duplicates.
 */
export function suppressionFileName(suppression: FindingSuppression): string {
  if (suppression.id && suppression.id.trim() !== '') return `${suppression.id.trim()}.json`;
  const identity = `${suppression.check ?? ''}\0${suppression.file ?? ''}`;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12).toUpperCase();
  return `CHECK-${hash}.json`;
}

export function writeSuppressionFile(
  projectRoot: string,
  suppression: FindingSuppression,
  now: Date = new Date(),
): { path: string } {
  if (!suppression.reason || suppression.reason.trim() === '') {
    throw new Error('suppression requires a non-empty reason');
  }
  if (!suppression.id && !suppression.check) {
    throw new Error('suppression requires an id or a check');
  }
  const dir = suppressionDirPath(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, suppressionFileName(suppression));
  const record: FindingSuppression = {
    ...suppression,
    createdAt: suppression.createdAt ?? now.toISOString(),
  };
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return { path };
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push(`${SUPPRESSION_DIR}/${entry}: not a suppression object — ignored`);
      continue;
    }
    const candidate = parsed as FindingSuppression;
    if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') {
      warnings.push(`${SUPPRESSION_DIR}/${entry}: missing reason — ignored`);
      continue;
    }
    if (!candidate.id && !candidate.check) {
      warnings.push(`${SUPPRESSION_DIR}/${entry}: needs an id or a check — ignored`);
      continue;
    }
    suppressions.push(candidate);
  }
  return { suppressions, warnings };
}
