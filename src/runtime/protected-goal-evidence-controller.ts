import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

import {
  createProtectedGoalEvidence,
  decodeProtectedGoalEvaluatorResult,
  type ProtectedGoalEvidenceV1,
} from '../domain/protected-goal-evidence.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { isPathInsideProject } from '../domain/path-normalization.js';
import { stableJson } from '../domain/stable-json.js';
import { hashIdentity } from '../domain/autonomous-work-state.js';
import { sha256FileWithinLimit, SOURCE_ARTIFACT_MAX_BYTES } from '../filesystem/bounded-file.js';
import { readProtectedGoalEvidence, writeProtectedGoalEvidence } from '../storage/protected-goal-evidence.js';
import { readProtectedWorkAuthorization } from '../storage/protected-work-authorization.js';
import { loadProjectConfig } from './config.js';
import type {
  FixedProtectedWorkAuthorizationLease,
  ProtectedWorkAuthorizationEnvironment,
} from './protected-work-authorization-controller.js';
import {
  assertRepositoryEvaluationSnapshotFixed,
  createRepositoryEvaluationSnapshot,
} from './repository-evaluation-snapshot.js';

export const PROTECTED_GOAL_EVIDENCE_ROOT_ENV = 'SCIP_QUERY_GOAL_EVIDENCE_ROOT';
export const PROTECTED_GOAL_EVIDENCE_ID_ENV = 'SCIP_QUERY_GOAL_EVIDENCE_ID';

const EVALUATOR_TIMEOUT_MS = 180_000;
const EVALUATOR_OUTPUT_MAX_BYTES = 40 * 1024 * 1024;

/**
 * A fixed protected-goal-evidence lease is one byte-stable observation of an
 * evaluator-issued receipt outside the candidate worktree. The controller
 * keeps the source digest so a moved receipt invalidates the whole judgment.
 */
export interface FixedProtectedGoalEvidenceLease {
  projectRoot: string;
  protectedRoot: string;
  path: string;
  recordSha256: string;
  record: ProtectedGoalEvidenceV1;
}

export function evaluateAndWriteProtectedGoalEvidence(input: {
  projectRoot: string;
  protectedRoot: string;
  authorizationId: string;
  evaluatorPath: string;
  toolVersion: string;
  now?: () => string;
}) {
  const projectRoot = realpathSync(resolve(input.projectRoot));
  const evaluatorPath = canonicalProtectedEvaluatorPath(projectRoot, input.evaluatorPath);
  const authorization = readProtectedWorkAuthorization(input.protectedRoot, projectRoot, input.authorizationId);
  if (authorization.state !== 'current') {
    throw new Error(
      `protected work authorization ${input.authorizationId} is ${authorization.state}: ${authorization.error}`,
    );
  }
  const expectedEvaluator = authorization.record.protectedEvaluator;
  if (!expectedEvaluator) throw new Error('protected work authorization does not fix a protected evaluator');
  const evaluatorBefore = evaluatorDigest(evaluatorPath);
  if (evaluatorBefore !== expectedEvaluator.artifactSha256) {
    throw new Error('protected evaluator bytes do not match the evaluator fixed before candidate work');
  }
  const config = loadProjectConfig(projectRoot);
  if (config.collaborationDomainId !== authorization.record.collaborationDomainId) {
    throw new Error('candidate repository belongs to another collaboration domain');
  }
  const snapshot = createRepositoryEvaluationSnapshot({
    projectRoot,
    config,
    collaborationDomainId: authorization.record.collaborationDomainId,
  });
  try {
    const invocation = evaluatorInvocation(evaluatorPath, snapshot.root);
    const evaluated = spawnSync(invocation.command, invocation.args, {
      cwd: realpathSync(resolve(input.protectedRoot)),
      encoding: 'utf8',
      timeout: EVALUATOR_TIMEOUT_MS,
      maxBuffer: EVALUATOR_OUTPUT_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (evaluated.error || evaluated.status !== 0) {
      const detail = evaluated.error?.message ?? evaluated.stderr?.trim() ?? `exit ${evaluated.status ?? 'unknown'}`;
      throw new Error(`protected evaluator failed: ${detail}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(evaluated.stdout);
    } catch {
      throw new Error('protected evaluator stdout must be one JSON result');
    }
    const result = decodeProtectedGoalEvaluatorResult(parsed);
    if (!result.ok) throw new Error(result.error);
    assertRepositoryEvaluationSnapshotFixed(snapshot, config, authorization.record.collaborationDomainId);
    if (evaluatorDigest(evaluatorPath) !== evaluatorBefore) {
      throw new Error('protected evaluator bytes changed while the evaluator was running');
    }
    const rereadAuthorization = readProtectedWorkAuthorization(input.protectedRoot, projectRoot, input.authorizationId);
    if (rereadAuthorization.state !== 'current' || rereadAuthorization.recordSha256 !== authorization.recordSha256) {
      throw new Error('protected work authorization changed while the evaluator was running');
    }
    const record = createProtectedGoalEvidence({
      collaborationDomainId: authorization.record.collaborationDomainId,
      authorization: authorization.record,
      authorizationRecordSha256: authorization.recordSha256,
      targetObservation: snapshot.receipt,
      evaluatorResult: result.result,
      createdAt: (input.now ?? (() => new Date().toISOString()))(),
      toolVersion: input.toolVersion,
    });
    return {
      evaluatorStdout: evaluated.stdout,
      evaluatorStderr: evaluated.stderr,
      ...writeProtectedGoalEvidence(input.protectedRoot, projectRoot, record),
    };
  } finally {
    snapshot.dispose();
  }
}

export function readConfiguredProtectedGoalEvidence(
  projectRoot: string,
  collaborationDomainId: string,
  authorization: FixedProtectedWorkAuthorizationLease | undefined,
  environment: ProtectedWorkAuthorizationEnvironment = process.env,
): FixedProtectedGoalEvidenceLease | undefined {
  const protectedRoot = environment[PROTECTED_GOAL_EVIDENCE_ROOT_ENV];
  const evidenceId = environment[PROTECTED_GOAL_EVIDENCE_ID_ENV];
  if (protectedRoot === undefined && evidenceId === undefined) return undefined;
  if (!protectedRoot || !evidenceId) {
    throw new Error(
      `${PROTECTED_GOAL_EVIDENCE_ROOT_ENV} and ${PROTECTED_GOAL_EVIDENCE_ID_ENV} must be configured together`,
    );
  }
  if (!authorization) throw new Error('protected goal evidence requires a configured protected work authorization');
  if (!isAbsolute(protectedRoot)) throw new Error(`${PROTECTED_GOAL_EVIDENCE_ROOT_ENV} must be an absolute path`);
  const canonicalProjectRoot = realpathSync(resolve(projectRoot));
  const observed = readProtectedGoalEvidence(resolve(protectedRoot), canonicalProjectRoot, evidenceId);
  if (observed.state !== 'current') {
    throw new Error(`protected goal evidence ${evidenceId} is ${observed.state}: ${observed.error}`);
  }
  assertEvidenceMatchesAuthorization(observed.record, authorization, collaborationDomainId);
  return {
    projectRoot: canonicalProjectRoot,
    protectedRoot: realpathSync(resolve(protectedRoot)),
    path: observed.path,
    recordSha256: observed.recordSha256,
    record: observed.record,
  };
}

export function assertProtectedGoalEvidenceMatchesTarget(
  evidence: FixedProtectedGoalEvidenceLease,
  target: ObservationReceiptV2,
): void {
  if (
    stableJson(evidence.record.targetObservation.facts.collaborationDomain) !==
      stableJson(target.facts.collaborationDomain) ||
    stableJson(evidence.record.targetObservation.facts.wholeContent) !== stableJson(target.facts.wholeContent)
  ) {
    throw new Error('protected goal evidence names a different repository state');
  }
}

export function assertFixedProtectedGoalEvidence(lease: FixedProtectedGoalEvidenceLease): void {
  const observed = readProtectedGoalEvidence(lease.protectedRoot, lease.projectRoot, lease.record.evidenceId);
  if (observed.state !== 'current' || observed.recordSha256 !== lease.recordSha256) {
    throw new Error(
      `protected goal evidence ${lease.record.evidenceId} changed while completion was being evaluated; discard the judgment and retry`,
    );
  }
}

function assertEvidenceMatchesAuthorization(
  evidence: ProtectedGoalEvidenceV1,
  authorization: FixedProtectedWorkAuthorizationLease,
  collaborationDomainId: string,
): void {
  if (
    evidence.collaborationDomainId !== collaborationDomainId ||
    evidence.authorizationId !== authorization.record.authorizationId ||
    evidence.authorizationRecordSha256 !== authorization.recordSha256 ||
    evidence.goalId !== authorization.record.goal.goalId ||
    evidence.goalRecordDigest !== hashIdentity(stableJson(authorization.record.goal)) ||
    evidence.changeId !== authorization.record.change.changeId ||
    evidence.changeRecordDigest !== hashIdentity(stableJson(authorization.record.change)) ||
    stableJson(evidence.evaluator) !== stableJson(authorization.record.protectedEvaluator)
  ) {
    throw new Error('protected goal evidence does not match the fixed work authorization');
  }
}

function canonicalProtectedEvaluatorPath(projectRoot: string, evaluatorPath: string): string {
  if (!isAbsolute(evaluatorPath)) throw new Error('protected evaluator path must be absolute');
  const canonical = realpathSync(resolve(evaluatorPath));
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('protected evaluator must be a regular non-symlink file');
  if (isPathInsideProject(projectRoot, canonical)) {
    throw new Error('protected evaluator must be outside the candidate-editable worktree');
  }
  return canonical;
}

function evaluatorDigest(path: string): string {
  return sha256FileWithinLimit(path, {
    inputKind: 'protected evaluator',
    maxBytes: SOURCE_ARTIFACT_MAX_BYTES,
  });
}

function evaluatorInvocation(path: string, projectRoot: string): { command: string; args: string[] } {
  return ['.js', '.mjs', '.cjs'].includes(extname(path))
    ? { command: process.execPath, args: [path, projectRoot] }
    : { command: path, args: [projectRoot] };
}
