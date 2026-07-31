import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  completionTransitionRuleRequestMatchesRecord,
  createCompletionTransitionRuleRecord,
  decodeCompletionTransitionRuleRecord,
  evaluateCompletionTransitionRule,
  isCompletionTransitionRuleId,
  type CompletionTransitionRuleRecordV1,
  type CompletionTransitionRuleRequest,
} from '../domain/completion-transition-rule.js';
import type { CompletionAuthorityPredecessor, CompletionEvaluationRequest } from '../domain/autonomous-completion.js';
import { normalizeSafeProjectRelativePath } from '../domain/path-normalization.js';
import { stableJson } from '../domain/stable-json.js';
import { sha256FileWithinLimit } from '../filesystem/bounded-file.js';
import {
  createGoalRecordFile,
  createIntendedChangeRecordFile,
  parseRecordFile,
  publishWorkStateRecord,
  readGoalRecordFile,
  readGoalRecords,
  readRecordDirectory,
  readRecordFile,
  workStateNow,
  type WorkStateCollectionReadResult,
  type WorkStateCreateOptions,
  type WorkStateCreateResult,
  type WorkStateRecordReadResult,
} from './autonomous-work-state.js';

export const COMPLETION_TRANSITION_RULES_DIR = join('.scipquery', 'transition-rules');

const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;
const MAX_TRANSITION_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface CompletionTransitionRuleCollection extends WorkStateCollectionReadResult<CompletionTransitionRuleRecordV1> {
  integrityIssues: string[];
}

export type CompletionTransitionRuleSelection =
  | { state: 'none'; consideredRuleIds: readonly string[] }
  | {
      state: 'selected';
      rule: CompletionTransitionRuleRecordV1;
      consideredRuleIds: readonly string[];
    }
  | {
      state: 'conflicted';
      ruleIds: readonly string[];
      reasons: readonly string[];
    };

export interface MaterializedTransitionSuccessor {
  goal: WorkStateCreateResult<CompletionTransitionRuleRecordV1['successorGoal']>;
  change: WorkStateCreateResult<CompletionTransitionRuleRecordV1['successorChange']>;
}

export function createCompletionTransitionRuleFile(
  projectRoot: string,
  collaborationDomainId: string,
  request: CompletionTransitionRuleRequest,
  options: WorkStateCreateOptions,
): WorkStateCreateResult<CompletionTransitionRuleRecordV1> {
  const predecessor = readGoalRecordFile(projectRoot, request.predecessorGoalId);
  if (predecessor.state !== 'current') {
    throw new Error(`transition-rule predecessor ${request.predecessorGoalId} is not a readable current goal`);
  }
  if (predecessor.record.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`transition-rule predecessor ${request.predecessorGoalId} belongs to another collaboration domain`);
  }
  const record = createCompletionTransitionRuleRecord({
    collaborationDomainId,
    predecessorGoal: predecessor.record,
    request,
    createdAt: (options.now ?? workStateNow)(),
    toolVersion: options.toolVersion,
  });
  const artifactIssues = predecessorArtifactIssues(projectRoot, record);
  if (artifactIssues.length > 0) {
    throw new Error(`transition-rule predecessor artifacts do not match: ${artifactIssues.join('; ')}`);
  }
  return publishWorkStateRecord(
    projectRoot,
    {
      relativeDirectory: COMPLETION_TRANSITION_RULES_DIR,
      identity: record.transitionRuleId,
      record,
      readExisting: () => readCompletionTransitionRuleFile(projectRoot, record.transitionRuleId),
      matchesExisting: (existing) =>
        completionTransitionRuleRequestMatchesRecord(collaborationDomainId, predecessor.record, request, existing),
      collisionMessage: (relativePath) =>
        `completion transition-rule identity collision at ${relativePath}: existing rule has different meaning`,
    },
    options,
  );
}

export function readCompletionTransitionRuleFile(
  projectRoot: string,
  transitionRuleId: string,
): WorkStateRecordReadResult<CompletionTransitionRuleRecordV1> {
  if (!isCompletionTransitionRuleId(transitionRuleId)) {
    throw new Error(`invalid completion transition-rule identity: ${transitionRuleId}`);
  }
  return readRecordFile(
    projectRoot,
    join(COMPLETION_TRANSITION_RULES_DIR, `${transitionRuleId}.json`),
    decodeCompletionTransitionRuleRecord,
  );
}

export function readCompletionTransitionRulePath(path: string) {
  return parseRecordFile(path, 'completion transition-rule record', decodeCompletionTransitionRuleRecord);
}

export function readCompletionTransitionRules(projectRoot: string): CompletionTransitionRuleCollection {
  const result = readRecordDirectory(
    projectRoot,
    COMPLETION_TRANSITION_RULES_DIR,
    'completion transition-rule record',
    decodeCompletionTransitionRuleRecord,
    (record) => record.transitionRuleId,
  );
  const goals = readGoalRecords(projectRoot);
  const goalsById = new Map(goals.records.map((goal) => [goal.goalId, goal]));
  const integrityIssues = result.records.flatMap((rule) => {
    const issues: string[] = [];
    const predecessor = goalsById.get(rule.predecessorGoal.goalId);
    if (!predecessor) {
      issues.push(`${rule.transitionRuleId} references missing predecessor goal ${rule.predecessorGoal.goalId}`);
    } else if (stableJson(predecessor) !== stableJson(rule.predecessorGoal)) {
      issues.push(`${rule.transitionRuleId} embeds a predecessor meaning that differs from the goal record`);
    }
    const successor = goalsById.get(rule.successorGoal.goalId);
    if (successor && stableJson(successor) !== stableJson(rule.successorGoal)) {
      issues.push(`${rule.transitionRuleId} successor goal materialization has conflicting meaning`);
    }
    return issues;
  });
  return { ...result, integrityIssues: [...new Set(integrityIssues)].sort() };
}

/**
 * Selects only a rule whose own file was not changed by the candidate and
 * whose exact artifact transition and evidence qualifications hold.
 */
export function selectCompletionTransitionRule(
  projectRoot: string,
  evaluation: Pick<CompletionEvaluationRequest, 'goalId' | 'predicates'>,
  predecessor: CompletionAuthorityPredecessor,
  changedPaths: readonly string[],
): CompletionTransitionRuleSelection {
  const rules = readCompletionTransitionRules(projectRoot);
  if (!rules.compatibility.complete || rules.integrityIssues.length > 0) {
    return {
      state: 'conflicted',
      ruleIds: rules.records.map((rule) => rule.transitionRuleId).sort(),
      reasons: [
        ...rules.compatibility.issues.map((issue) => `${issue.path}: ${issue.reason}`),
        ...rules.integrityIssues,
      ].sort(),
    };
  }
  const changed = new Set(changedPaths.map((path) => normalizeSafeProjectRelativePath(path)));
  const candidates = rules.records.filter(
    (rule) =>
      rule.predecessorGoal.goalId === evaluation.goalId &&
      !changed.has(transitionRulePath(rule.transitionRuleId)) &&
      transitionRuleIsFixedInPredecessor(projectRoot, predecessor, rule),
  );
  const applicable = candidates.filter((rule) => {
    const artifactMatches = new Map(
      rule.artifactTransitions.map((transition) => [
        transition.path,
        protectedArtifactTransitionMatches(projectRoot, predecessor, transition),
      ]),
    );
    return evaluateCompletionTransitionRule(rule, evaluation, artifactMatches).state === 'applicable';
  });
  const consideredRuleIds = candidates.map((rule) => rule.transitionRuleId).sort();
  if (applicable.length === 0) return { state: 'none', consideredRuleIds };
  if (applicable.length === 1) {
    return { state: 'selected', rule: applicable[0]!, consideredRuleIds };
  }
  const ruleIds = applicable.map((rule) => rule.transitionRuleId).sort();
  return {
    state: 'conflicted',
    ruleIds,
    reasons: [`multiple fixed transition rules authorize different successors: ${ruleIds.join(', ')}`],
  };
}

/**
 * Materialization is recoverable cache publication. The rule and superseding
 * evaluation already carry the atomic meaning; retries recreate ordinary
 * goal/change files byte-for-byte without inventing a second transition.
 */
export function materializeCompletionTransitionSuccessor(
  projectRoot: string,
  collaborationDomainId: string,
  rule: CompletionTransitionRuleRecordV1,
  options: WorkStateCreateOptions,
): MaterializedTransitionSuccessor {
  if (rule.collaborationDomainId !== collaborationDomainId) {
    throw new Error(`transition rule ${rule.transitionRuleId} belongs to another collaboration domain`);
  }
  const goal = createGoalRecordFile(
    projectRoot,
    collaborationDomainId,
    {
      feature: rule.successorGoal.gherkin.feature,
      invariants: rule.successorGoal.gherkin.invariants,
      acceptanceScenarios: rule.successorGoal.gherkin.acceptanceScenarios,
      authorization: rule.successorGoal.authorization,
      predecessorGoalId: rule.predecessorGoal.goalId,
    },
    {
      ...options,
      toolVersion: rule.successorGoal.writer.version,
      now: () => rule.successorGoal.createdAt,
    },
  );
  if (stableJson(goal.record) !== stableJson(rule.successorGoal)) {
    throw new Error(`transition rule ${rule.transitionRuleId} materialized a conflicting successor goal`);
  }
  const change = createIntendedChangeRecordFile(
    projectRoot,
    collaborationDomainId,
    {
      ...rule.successorChangeRequest,
      goalId: rule.successorGoal.goalId,
    },
    {
      ...options,
      toolVersion: rule.successorChange.writer.version,
      now: () => rule.successorChange.createdAt,
    },
  );
  if (stableJson(change.record) !== stableJson(rule.successorChange)) {
    throw new Error(`transition rule ${rule.transitionRuleId} materialized a conflicting successor change`);
  }
  return { goal, change };
}

export function transitionRulePath(transitionRuleId: string): string {
  return join(COMPLETION_TRANSITION_RULES_DIR, `${transitionRuleId}.json`).replaceAll('\\', '/');
}

function predecessorArtifactIssues(projectRoot: string, rule: CompletionTransitionRuleRecordV1): string[] {
  return rule.artifactTransitions.flatMap((transition) => {
    const observed = currentArtifactDigest(projectRoot, transition.path);
    return observed === transition.predecessorDigest
      ? []
      : [`${transition.path} expected ${transition.predecessorDigest ?? 'absent'}, observed ${observed ?? 'absent'}`];
  });
}

export function protectedArtifactTransitionMatches(
  projectRoot: string,
  predecessor: CompletionAuthorityPredecessor,
  transition: CompletionTransitionRuleRecordV1['artifactTransitions'][number],
): boolean {
  if (predecessor.kind !== 'git-tree') return false;
  return (
    gitArtifactDigest(projectRoot, predecessor.treeOid, transition.path) === transition.predecessorDigest &&
    currentArtifactDigest(projectRoot, transition.path) === transition.successorDigest
  );
}

function transitionRuleIsFixedInPredecessor(
  projectRoot: string,
  predecessor: CompletionAuthorityPredecessor,
  rule: CompletionTransitionRuleRecordV1,
): boolean {
  if (predecessor.kind !== 'git-tree') return false;
  const path = transitionRulePath(rule.transitionRuleId);
  const fixedDigest = gitArtifactDigest(projectRoot, predecessor.treeOid, path);
  return fixedDigest !== null && fixedDigest === currentArtifactDigest(projectRoot, path);
}

function currentArtifactDigest(projectRoot: string, relativePath: string): string | null {
  const safePath = normalizeSafeProjectRelativePath(relativePath);
  const absolutePath = join(projectRoot, safePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return sha256FileWithinLimit(absolutePath, {
      inputKind: 'completion transition artifact',
      maxBytes: MAX_TRANSITION_ARTIFACT_BYTES,
    });
  } catch {
    return null;
  }
}

function gitArtifactDigest(projectRoot: string, treeOid: string, relativePath: string): string | null {
  if (!GIT_OBJECT_ID.test(treeOid)) return null;
  const safePath = normalizeSafeProjectRelativePath(relativePath);
  const result = spawnSync('git', ['-C', projectRoot, 'cat-file', 'blob', `${treeOid}:${safePath}`], {
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer: MAX_TRANSITION_ARTIFACT_BYTES,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  return createHash('sha256').update(result.stdout).digest('hex');
}
