import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { ProtectedWorkAuthorizationV1 } from '../domain/protected-work-authorization.js';
import { stableJson } from '../domain/stable-json.js';
import { readGoalRecordFile, readIntendedChangeRecordFile } from '../storage/autonomous-work-state.js';
import {
  activateProtectedWorkAuthorization,
  readProtectedWorkAuthorization,
} from '../storage/protected-work-authorization.js';

export const PROTECTED_WORK_AUTHORIZATION_ROOT_ENV = 'SCIP_QUERY_WORK_AUTHORIZATION_ROOT';
export const PROTECTED_WORK_AUTHORIZATION_ID_ENV = 'SCIP_QUERY_WORK_AUTHORIZATION_ID';

export type ProtectedWorkAuthorizationEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * A fixed protected-work lease is one observation of principal-issued bytes
 * outside the candidate repository. It is distinguished from the decoded
 * authorization by also fixing where those bytes were read and their exact
 * source digest, so movement can invalidate a later completion judgment.
 */
export interface FixedProtectedWorkAuthorizationLease {
  projectRoot: string;
  protectedRoot: string;
  path: string;
  recordSha256: string;
  record: ProtectedWorkAuthorizationV1;
}

export interface ProtectedWorkActivationResult {
  lease: FixedProtectedWorkAuthorizationLease;
  publication: 'activated' | 'existing';
}

export function readConfiguredProtectedWorkAuthorization(
  projectRoot: string,
  collaborationDomainId: string,
  environment: ProtectedWorkAuthorizationEnvironment = process.env,
): FixedProtectedWorkAuthorizationLease | undefined {
  const protectedRoot = environment[PROTECTED_WORK_AUTHORIZATION_ROOT_ENV];
  const authorizationId = environment[PROTECTED_WORK_AUTHORIZATION_ID_ENV];
  if (protectedRoot === undefined && authorizationId === undefined) return undefined;
  if (!protectedRoot || !authorizationId) {
    throw new Error(
      `${PROTECTED_WORK_AUTHORIZATION_ROOT_ENV} and ${PROTECTED_WORK_AUTHORIZATION_ID_ENV} must be configured together`,
    );
  }
  if (!isAbsolute(protectedRoot)) {
    throw new Error(`${PROTECTED_WORK_AUTHORIZATION_ROOT_ENV} must be an absolute path`);
  }
  const canonicalProjectRoot = realpathSync(resolve(projectRoot));
  const absoluteProtectedRoot = resolve(protectedRoot);
  const observed = readProtectedWorkAuthorization(absoluteProtectedRoot, canonicalProjectRoot, authorizationId);
  if (observed.state !== 'current') {
    throw new Error(`protected work authorization ${authorizationId} is ${observed.state}: ${observed.error}`);
  }
  if (observed.record.collaborationDomainId !== collaborationDomainId) {
    throw new Error(
      `protected work authorization ${authorizationId} belongs to collaboration domain ${observed.record.collaborationDomainId}, not ${collaborationDomainId}`,
    );
  }
  return {
    projectRoot: canonicalProjectRoot,
    protectedRoot: realpathSync(absoluteProtectedRoot),
    path: observed.path,
    recordSha256: observed.recordSha256,
    record: observed.record,
  };
}

export function activateConfiguredProtectedWorkAuthorization(input: {
  projectRoot: string;
  collaborationDomainId: string;
  prompt: string;
  environment?: ProtectedWorkAuthorizationEnvironment;
}): ProtectedWorkActivationResult | undefined {
  const lease = readConfiguredProtectedWorkAuthorization(
    input.projectRoot,
    input.collaborationDomainId,
    input.environment ?? process.env,
  );
  if (!lease) return undefined;
  const goal = readGoalRecordFile(lease.projectRoot, lease.record.goal.goalId);
  const change = readIntendedChangeRecordFile(lease.projectRoot, lease.record.change.changeId);
  const goalIsExact = currentRecordEquals(goal, lease.record.goal, 'goal');
  const changeIsExact = currentRecordEquals(change, lease.record.change, 'intended change');
  if (goalIsExact && changeIsExact) return { lease, publication: 'existing' };

  const promptSha256 = createHash('sha256').update(input.prompt).digest('hex');
  if (promptSha256 !== lease.record.promptSha256) {
    throw new Error(
      `prompt does not match protected work authorization ${lease.record.authorizationId}; exact work records were not activated`,
    );
  }
  const activation = activateProtectedWorkAuthorization(lease.projectRoot, input.collaborationDomainId, lease.record);
  return {
    lease,
    publication:
      activation.goal.publication === 'created' || activation.change.publication === 'created'
        ? 'activated'
        : 'existing',
  };
}

export function assertFixedProtectedWorkAuthorization(lease: FixedProtectedWorkAuthorizationLease): void {
  const observed = readProtectedWorkAuthorization(lease.protectedRoot, lease.projectRoot, lease.record.authorizationId);
  if (observed.state !== 'current' || observed.recordSha256 !== lease.recordSha256) {
    throw new Error(
      `protected work authorization ${lease.record.authorizationId} changed while completion was being evaluated; discard the judgment and retry`,
    );
  }
}

function currentRecordEquals<RecordType>(
  observed: { state: string; record?: RecordType; error?: string },
  expected: RecordType,
  label: string,
): boolean {
  if (observed.state === 'missing') return false;
  if (observed.state !== 'current' || observed.record === undefined) {
    throw new Error(`authorized ${label} record is ${observed.state}: ${observed.error ?? 'record is unreadable'}`);
  }
  if (stableJson(observed.record) !== stableJson(expected)) {
    throw new Error(`authorized ${label} record conflicts with the protected work authorization`);
  }
  return true;
}
