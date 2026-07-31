import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  decodeProtectedGoalEvidence,
  isProtectedGoalEvidenceId,
  type ProtectedGoalEvidenceV1,
} from '../domain/protected-goal-evidence.js';
import { stableJson } from '../domain/stable-json.js';
import { readSmallArtifactText } from '../filesystem/bounded-file.js';
import {
  createFileAtomicExclusive,
  isExclusivePublicationConflict,
  type AchievedFileDurability,
  type AtomicFileRuntime,
} from './atomic-file.js';
import { assertProtectedRootOutsideCandidate } from './mission-trials.js';
import { assertProtectedStorageDirectory, sameProtectedFileObservation } from './protected-work-authorization.js';

export const PROTECTED_GOAL_EVIDENCE_DIR = 'goal-evidence';

export type ProtectedGoalEvidenceReadResult =
  | { state: 'current'; path: string; recordSha256: string; record: ProtectedGoalEvidenceV1 }
  | {
      state: 'missing' | Exclude<ReturnType<typeof decodeProtectedGoalEvidence>['state'], 'current'>;
      path: string;
      error: string;
    };

export function writeProtectedGoalEvidence(
  protectedRoot: string,
  candidateRoot: string,
  record: ProtectedGoalEvidenceV1,
  options: { atomicRuntime?: AtomicFileRuntime } = {},
): {
  record: ProtectedGoalEvidenceV1;
  path: string;
  publication: 'created' | 'existing';
  achievedDurability: AchievedFileDurability | 'existing';
} {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  const decoded = decodeProtectedGoalEvidence(record);
  if (decoded.state !== 'current') throw new Error(decoded.error);
  assertProtectedStorageDirectory(protectedRoot, PROTECTED_GOAL_EVIDENCE_DIR, 'goal evidence');
  const path = protectedGoalEvidencePath(protectedRoot, record.evidenceId);
  try {
    const publication = createFileAtomicExclusive(path, `${JSON.stringify(record, null, 2)}\n`, {
      durability: 'durable',
      ...(options.atomicRuntime ? { runtime: options.atomicRuntime } : {}),
    });
    return {
      record,
      path,
      publication: 'created',
      achievedDurability: publication.achievedDurability,
    };
  } catch (error) {
    if (!isExclusivePublicationConflict(error)) throw error;
    const existing = readProtectedGoalEvidence(protectedRoot, candidateRoot, record.evidenceId);
    if (existing.state !== 'current' || stableJson(existing.record) !== stableJson(record)) {
      throw new Error(`immutable protected goal evidence collision at ${path}`, { cause: error });
    }
    return {
      record: existing.record,
      path,
      publication: 'existing',
      achievedDurability: 'existing',
    };
  }
}

export function readProtectedGoalEvidence(
  protectedRoot: string,
  candidateRoot: string,
  evidenceId: string,
): ProtectedGoalEvidenceReadResult {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  if (!isProtectedGoalEvidenceId(evidenceId))
    throw new Error(`invalid protected goal evidence identity: ${evidenceId}`);
  assertProtectedStorageDirectory(protectedRoot, PROTECTED_GOAL_EVIDENCE_DIR, 'goal evidence');
  const path = protectedGoalEvidencePath(protectedRoot, evidenceId);
  if (!existsSync(path)) return { state: 'missing', path, error: 'protected goal evidence is missing' };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { state: 'malformed', path, error: 'protected goal evidence path must be a regular non-symlink file' };
    }
    const before = lstatSync(path);
    const source = readSmallArtifactText(path, 'protected goal evidence');
    const after = lstatSync(path);
    if (!sameProtectedFileObservation(before, after)) {
      return { state: 'malformed', path, error: 'protected goal evidence moved while it was being read' };
    }
    const decoded = decodeProtectedGoalEvidence(JSON.parse(source));
    return decoded.state === 'current'
      ? {
          state: 'current',
          path,
          recordSha256: createHash('sha256').update(source).digest('hex'),
          record: decoded.record,
        }
      : { state: decoded.state, path, error: decoded.error };
  } catch (error) {
    return { state: 'malformed', path, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readProtectedGoalEvidenceCollection(protectedRoot: string, candidateRoot: string) {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  const directory = join(resolve(protectedRoot), PROTECTED_GOAL_EVIDENCE_DIR);
  if (!existsSync(directory)) return { records: [] as ProtectedGoalEvidenceV1[], issues: [] };
  assertProtectedStorageDirectory(protectedRoot, PROTECTED_GOAL_EVIDENCE_DIR, 'goal evidence');
  const records: ProtectedGoalEvidenceV1[] = [];
  const issues: Array<{ path: string; state: string; reason: string }> = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith('.json')) continue;
    const evidenceId = entry.slice(0, -'.json'.length);
    if (!isProtectedGoalEvidenceId(evidenceId)) {
      issues.push({ path: join(directory, entry), state: 'malformed', reason: 'filename is not an evidence ID' });
      continue;
    }
    const decoded = readProtectedGoalEvidence(protectedRoot, candidateRoot, evidenceId);
    if (decoded.state !== 'current') {
      issues.push({ path: decoded.path, state: decoded.state, reason: decoded.error });
      continue;
    }
    records.push(decoded.record);
  }
  return { records, issues };
}

export function protectedGoalEvidencePath(protectedRoot: string, evidenceId: string): string {
  if (!isProtectedGoalEvidenceId(evidenceId))
    throw new Error(`invalid protected goal evidence identity: ${evidenceId}`);
  return join(resolve(protectedRoot), PROTECTED_GOAL_EVIDENCE_DIR, `${evidenceId}.json`);
}
