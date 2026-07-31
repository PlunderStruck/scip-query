import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPLETION_PREDICATES,
  type CompletionEvaluationRequest,
  type CompletionPredicate,
} from '../../src/domain/autonomous-completion.js';
import type { ObligationAdmissionRequest } from '../../src/domain/autonomous-work-obligations.js';
import type { GoalCreateRequest, IntendedChangeCreateRequest } from '../../src/domain/autonomous-work-state.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import {
  COMPLETION_EVALUATIONS_DIR,
  createCompletionEvaluationFiles,
  readCompletionHistory,
} from '../../src/storage/autonomous-completion.js';
import { createObligationAdmissionFile } from '../../src/storage/autonomous-work-obligations.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';
import { NODE_ATOMIC_FILE_RUNTIME, type AtomicFileRuntime } from '../../src/storage/atomic-file.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const TOOL_VERSION = '0.20.0';
const EVALUATED_AT = '2026-07-30T12:10:00.000Z';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('autonomous completion storage', () => {
  it('publishes one complete evaluation and transition idempotently', () => {
    const root = fixtureDirectory();
    const { goalId, changeId } = createChange(root);
    const request = evaluationRequest(goalId, changeId, 'complete');

    const first = createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, request, {
      toolVersion: TOOL_VERSION,
      now: () => EVALUATED_AT,
    });
    const retry = createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, request, {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:10:00.000Z',
    });

    expect(first.evaluation.publication).toBe('created');
    expect(first.transition?.publication).toBe('created');
    expect(retry.evaluation.publication).toBe('existing');
    expect(retry.transition?.publication).toBe('existing');
    expect(retry.evaluation.record.createdAt).toBe(EVALUATED_AT);
    expect(readCompletionHistory(root, changeId)).toEqual(
      expect.objectContaining({
        integrityIssues: [],
        summary: expect.objectContaining({
          states: [expect.objectContaining({ state: 'complete', changeId })],
        }),
      }),
    );
  });

  it('recovers a transition published before its acknowledgement', () => {
    const root = fixtureDirectory();
    const { goalId, changeId } = createChange(root);
    const request = evaluationRequest(goalId, changeId, 'unknown-outcome');
    let publications = 0;
    const runtime: AtomicFileRuntime = {
      ...NODE_ATOMIC_FILE_RUNTIME,
      randomToken: () => `completion-${publications}`,
      linkFile: (source, target) => {
        NODE_ATOMIC_FILE_RUNTIME.linkFile!(source, target);
        publications += 1;
        if (publications === 2) {
          throw Object.assign(new Error('simulated disconnect after transition publication'), {
            code: 'EIO',
          });
        }
      },
    };

    expect(() =>
      createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, request, {
        toolVersion: TOOL_VERSION,
        now: () => EVALUATED_AT,
        atomicRuntime: runtime,
      }),
    ).toThrow('simulated disconnect after transition publication');

    const retry = createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, request, {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:10:00.000Z',
    });
    expect(retry.evaluation.publication).toBe('existing');
    expect(retry.transition?.publication).toBe('existing');
    expect(readCompletionHistory(root, changeId).integrityIssues).toEqual([]);
  });

  it('refuses claimed completion while a live obligation remains', () => {
    const root = fixtureDirectory();
    const { goalId, changeId } = createChange(root);
    createObligationAdmissionFile(root, COLLABORATION_DOMAIN, admissionRequest(changeId), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    });

    expect(() =>
      createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, evaluationRequest(goalId, changeId, 'premature'), {
        toolVersion: TOOL_VERSION,
        now: () => EVALUATED_AT,
      }),
    ).toThrow(/obligations-reconciled cannot be established/u);

    const blocked = createCompletionEvaluationFiles(
      root,
      COLLABORATION_DOMAIN,
      evaluationRequest(goalId, changeId, 'blocked', {
        'obligations-reconciled': 'unknown',
      }),
      { toolVersion: TOOL_VERSION, now: () => EVALUATED_AT },
    );
    expect(blocked.evaluation.record.decision).toEqual(
      expect.objectContaining({
        state: 'blocked',
        unknownPredicates: ['obligations-reconciled'],
      }),
    );
    expect(blocked.transition).toBeUndefined();
  });

  it('refuses completion without fixed same-domain evidence and direct successor authority', () => {
    const root = fixtureDirectory();
    const { goalId, changeId } = createChange(root);
    const unstable = evaluationRequest(goalId, changeId, 'unstable');
    unstable.context.targetObservation = {
      ...unstable.context.targetObservation,
      stabilityProofs: [{ source: 'repository-snapshot', kind: 'bracketed' }],
    };

    expect(() =>
      createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, unstable, {
        toolVersion: TOOL_VERSION,
        now: () => EVALUATED_AT,
      }),
    ).toThrow(/fixed, same-domain target observation/u);

    const successor = evaluationRequest(goalId, changeId, 'successor') as CompletionEvaluationRequest & {
      authorizedSuccessor: { transitionRuleId: string; successorGoalId: string };
    };
    successor.authorizedSuccessor = {
      transitionRuleId: 'SQTR-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      successorGoalId: goalId,
    };
    expect(() =>
      createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, successor, {
        toolVersion: TOOL_VERSION,
      }),
    ).toThrow(/stored transition rule/u);
  });

  it('refuses an established predicate with no admissible evidence', () => {
    const root = fixtureDirectory();
    const { goalId, changeId } = createChange(root);
    const unsupported = evaluationRequest(goalId, changeId, 'unsupported-claim');
    unsupported.predicates = unsupported.predicates.map((judgment) =>
      judgment.predicate === 'goal-fulfilled' ? { ...judgment, evidenceReceipts: [] } : judgment,
    );

    expect(() =>
      createCompletionEvaluationFiles(root, COLLABORATION_DOMAIN, unsupported, {
        toolVersion: TOOL_VERSION,
        now: () => EVALUATED_AT,
      }),
    ).toThrow(/goal-fulfilled cannot be established without fixed, same-domain evidence/u);
  });

  it('composes distinct branch evaluations without filename conflicts', () => {
    const left = fixtureDirectory();
    const right = fixtureDirectory();
    const merged = fixtureDirectory();
    const { goalId, changeId } = createChange(left);
    copyState(left, right);
    copyState(left, merged);

    const leftResult = createCompletionEvaluationFiles(
      left,
      COLLABORATION_DOMAIN,
      evaluationRequest(goalId, changeId, 'left'),
      { toolVersion: TOOL_VERSION, now: () => EVALUATED_AT },
    );
    const rightResult = createCompletionEvaluationFiles(
      right,
      COLLABORATION_DOMAIN,
      evaluationRequest(goalId, changeId, 'right'),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:11:00.000Z' },
    );
    copyCompletion(left, merged, leftResult);
    copyCompletion(right, merged, rightResult);

    const history = readCompletionHistory(merged, changeId);
    expect(history.integrityIssues).toEqual([]);
    expect(history.summary.evaluations).toHaveLength(2);
    expect(history.summary.transitions).toHaveLength(2);
    expect(history.summary.states).toEqual([expect.objectContaining({ state: 'complete' })]);
  });

  it('reports future evaluation records as incomplete compatibility', () => {
    const root = fixtureDirectory();
    const directory = join(root, COMPLETION_EVALUATIONS_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SQE-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json'),
      `${JSON.stringify({
        kind: 'scip-query-completion-evaluation',
        schemaVersion: 2,
        evaluationId: 'SQE-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      })}\n`,
    );

    const history = readCompletionHistory(root);
    expect(history.evaluations.compatibility.complete).toBe(false);
    expect(history.evaluations.compatibility.unsupportedFuture).toBe(1);
  });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-completion-'));
  fixtureDirectories.add(directory);
  return directory;
}

function createChange(root: string): { goalId: string; changeId: string } {
  const goal = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
    toolVersion: TOOL_VERSION,
  }).record;
  const change = createIntendedChangeRecordFile(root, COLLABORATION_DOMAIN, changeRequest(goal.goalId), {
    toolVersion: TOOL_VERSION,
  }).record;
  return { goalId: goal.goalId, changeId: change.changeId };
}

function goalRequest(): GoalCreateRequest {
  return {
    feature: 'An agent completes repository work without losing required conditions',
    invariants: ['Unknown completion facts block completion without becoming false'],
    acceptanceScenarios: [
      {
        name: 'Completion is protected',
        given: ['one required fact is unknown'],
        when: ['the completion controller evaluates the change'],
        then: ['the change remains blocked'],
      },
    ],
    authorization: {
      kind: 'repository-delegation',
      principal: 'repository-owner',
      source: 'codex-task',
    },
  };
}

function changeRequest(goalId: string): IntendedChangeCreateRequest {
  return {
    goalId,
    idempotencyKey: 'completion-change',
    title: 'Protect autonomous completion',
    intendedOutcome: 'Only controller-established completion reaches the complete state',
  };
}

function evaluationRequest(
  goalId: string,
  changeId: string,
  idempotencyKey: string,
  overrides: Partial<Record<CompletionPredicate, 'established' | 'disproven' | 'unknown'>> = {},
): CompletionEvaluationRequest {
  return {
    goalId,
    changeId,
    idempotencyKey,
    context: {
      policyId: 'autonomous-completion',
      policyVersion: 1,
      evaluatorId: 'scip-query-controller',
      evaluatorVersion: TOOL_VERSION,
      targetObservation: receipt('2026-07-30T12:05:00.000Z', idempotencyKey),
    },
    predicates: COMPLETION_PREDICATES.map((predicate) => ({
      predicate,
      state: overrides[predicate] ?? 'established',
      reasons: [`${predicate} was evaluated from fixed repository evidence`],
      evidenceReceipts: [receipt('2026-07-30T12:05:00.000Z', `${idempotencyKey}-${predicate}`)],
    })),
  };
}

function admissionRequest(changeId: string): ObligationAdmissionRequest {
  return {
    changeId,
    idempotencyKey: 'live-obligation',
    category: 'residue',
    title: 'Remove obsolete adapter',
    requiredCondition: 'The obsolete adapter has no remaining source or consumer',
    source: { kind: 'agent-discovery', referent: 'src/obsolete-adapter.ts' },
    basisAttemptIds: [],
    evidenceReceipts: [],
  };
}

function receipt(observedAt: string, identity: string): ObservationReceiptV2 {
  const content = createObservationIdentity('scip-query:repository-content', 1, identity);
  return {
    schemaVersion: 2,
    observedAt,
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}

function copyState(sourceRoot: string, targetRoot: string): void {
  for (const relativeDirectory of [join('.scipquery', 'goals'), join('.scipquery', 'changes')]) {
    mkdirSync(join(targetRoot, relativeDirectory), { recursive: true });
    for (const entry of readdirSync(join(sourceRoot, relativeDirectory))) {
      copyRelative(sourceRoot, targetRoot, join(relativeDirectory, entry));
    }
  }
}

function copyCompletion(
  sourceRoot: string,
  targetRoot: string,
  result: ReturnType<typeof createCompletionEvaluationFiles>,
): void {
  copyRelative(sourceRoot, targetRoot, result.evaluation.path);
  if (result.transition) copyRelative(sourceRoot, targetRoot, result.transition.path);
}

function copyRelative(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, relativePath), target);
}
