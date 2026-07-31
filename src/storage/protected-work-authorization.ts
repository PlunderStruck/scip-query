import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  decodeProtectedWorkAuthorization,
  isProtectedWorkAuthorizationId,
  protectedWorkAuthorizationMatchesRecords,
  type ProtectedWorkAuthorizationV1,
} from '../domain/protected-work-authorization.js';
import { stableJson } from '../domain/stable-json.js';
import { readSmallArtifactText } from '../filesystem/bounded-file.js';
import {
  createFileAtomicExclusive,
  isExclusivePublicationConflict,
  type AchievedFileDurability,
  type AtomicFileRuntime,
} from './atomic-file.js';
import { assertProtectedRootOutsideCandidate } from './mission-trials.js';
import {
  createGoalRecordFile,
  createIntendedChangeRecordFile,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
} from './autonomous-work-state.js';

export const PROTECTED_WORK_AUTHORIZATIONS_DIR = 'work-authorizations';

export interface ProtectedWorkAuthorizationWriteOptions {
  atomicRuntime?: AtomicFileRuntime;
}

export interface ProtectedWorkAuthorizationWriteResult {
  record: ProtectedWorkAuthorizationV1;
  path: string;
  publication: 'created' | 'existing';
  achievedDurability: AchievedFileDurability | 'existing';
}

export type ProtectedWorkAuthorizationReadResult =
  | { state: 'current'; path: string; recordSha256: string; record: ProtectedWorkAuthorizationV1 }
  | {
      state: 'missing' | Exclude<ReturnType<typeof decodeProtectedWorkAuthorization>['state'], 'current'>;
      path: string;
      error: string;
    };

export interface ProtectedWorkAuthorizationCollection {
  records: ProtectedWorkAuthorizationV1[];
  issues: Array<{ path: string; state: string; reason: string }>;
}

export interface ActivatedProtectedWorkAuthorization {
  authorizationId: string;
  goal: WorkStateCreateResult<ProtectedWorkAuthorizationV1['goal']>;
  change: WorkStateCreateResult<ProtectedWorkAuthorizationV1['change']>;
}

export function writeProtectedWorkAuthorization(
  protectedRoot: string,
  candidateRoot: string,
  record: ProtectedWorkAuthorizationV1,
  options: ProtectedWorkAuthorizationWriteOptions = {},
): ProtectedWorkAuthorizationWriteResult {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  const decoded = decodeProtectedWorkAuthorization(record);
  if (decoded.state !== 'current') throw new Error(decoded.error);
  assertAuthorizationDirectory(protectedRoot);
  const path = protectedWorkAuthorizationPath(protectedRoot, record.authorizationId);
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
    const existing = readProtectedWorkAuthorization(protectedRoot, candidateRoot, record.authorizationId);
    if (existing.state !== 'current' || stableJson(existing.record) !== stableJson(record)) {
      throw new Error(`immutable protected work authorization collision at ${path}`, { cause: error });
    }
    return {
      record: existing.record,
      path,
      publication: 'existing',
      achievedDurability: 'existing',
    };
  }
}

export function readProtectedWorkAuthorization(
  protectedRoot: string,
  candidateRoot: string,
  authorizationId: string,
): ProtectedWorkAuthorizationReadResult {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  if (!isProtectedWorkAuthorizationId(authorizationId)) {
    throw new Error(`invalid protected work authorization identity: ${authorizationId}`);
  }
  assertAuthorizationDirectory(protectedRoot);
  const path = protectedWorkAuthorizationPath(protectedRoot, authorizationId);
  if (!existsSync(path)) return { state: 'missing', path, error: 'protected work authorization is missing' };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        state: 'malformed',
        path,
        error: 'protected work authorization path must be a regular non-symlink file',
      };
    }
    const before = lstatSync(path);
    const source = readSmallArtifactText(path, 'protected work authorization');
    const after = lstatSync(path);
    if (!sameFileObservation(before, after)) {
      return {
        state: 'malformed',
        path,
        error: 'protected work authorization moved while it was being read',
      };
    }
    const decoded = decodeProtectedWorkAuthorization(JSON.parse(source));
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

export function readProtectedWorkAuthorizations(
  protectedRoot: string,
  candidateRoot: string,
): ProtectedWorkAuthorizationCollection {
  assertProtectedRootOutsideCandidate(protectedRoot, candidateRoot);
  const directory = join(resolve(protectedRoot), PROTECTED_WORK_AUTHORIZATIONS_DIR);
  if (!existsSync(directory)) return { records: [], issues: [] };
  assertAuthorizationDirectory(protectedRoot);
  const records: ProtectedWorkAuthorizationV1[] = [];
  const issues: ProtectedWorkAuthorizationCollection['issues'] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith('.json')) continue;
    const authorizationId = entry.slice(0, -'.json'.length);
    if (!isProtectedWorkAuthorizationId(authorizationId)) {
      issues.push({ path: join(directory, entry), state: 'malformed', reason: 'filename is not an authorization ID' });
      continue;
    }
    const decoded = readProtectedWorkAuthorization(protectedRoot, candidateRoot, authorizationId);
    if (decoded.state !== 'current') {
      issues.push({ path: decoded.path, state: decoded.state, reason: decoded.error });
      continue;
    }
    records.push(decoded.record);
  }
  return { records, issues };
}

export function activateProtectedWorkAuthorization(
  projectRoot: string,
  collaborationDomainId: string,
  authorization: ProtectedWorkAuthorizationV1,
  options: Pick<WorkStateCreateOptions, 'atomicRuntime'> = {},
): ActivatedProtectedWorkAuthorization {
  if (authorization.collaborationDomainId !== collaborationDomainId) {
    throw new Error(
      `protected work authorization ${authorization.authorizationId} belongs to collaboration domain ${authorization.collaborationDomainId}, not ${collaborationDomainId}`,
    );
  }
  const goal = createGoalRecordFile(
    projectRoot,
    collaborationDomainId,
    {
      feature: authorization.goal.gherkin.feature,
      invariants: authorization.goal.gherkin.invariants,
      acceptanceScenarios: authorization.goal.gherkin.acceptanceScenarios,
      authorization: authorization.goal.authorization,
    },
    {
      ...options,
      toolVersion: authorization.goal.writer.version,
      now: () => authorization.goal.createdAt,
    },
  );
  const change = createIntendedChangeRecordFile(
    projectRoot,
    collaborationDomainId,
    { ...authorization.changeRequest, goalId: authorization.goal.goalId },
    {
      ...options,
      toolVersion: authorization.change.writer.version,
      now: () => authorization.change.createdAt,
    },
  );
  if (!protectedWorkAuthorizationMatchesRecords(authorization, goal.record, change.record)) {
    throw new Error(`protected work authorization ${authorization.authorizationId} materialized conflicting records`);
  }
  return { authorizationId: authorization.authorizationId, goal, change };
}

export function protectedWorkAuthorizationPath(protectedRoot: string, authorizationId: string): string {
  if (!isProtectedWorkAuthorizationId(authorizationId)) {
    throw new Error(`invalid protected work authorization identity: ${authorizationId}`);
  }
  return join(resolve(protectedRoot), PROTECTED_WORK_AUTHORIZATIONS_DIR, `${authorizationId}.json`);
}

function assertAuthorizationDirectory(protectedRoot: string): void {
  const directory = join(resolve(protectedRoot), PROTECTED_WORK_AUTHORIZATIONS_DIR);
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('protected work authorization directory must be a real non-symlink directory');
  }
}

function sameFileObservation(before: Stats, after: Stats): boolean {
  return (
    before.isFile() &&
    !before.isSymbolicLink() &&
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}
