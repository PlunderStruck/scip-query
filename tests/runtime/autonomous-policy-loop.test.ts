import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CompletionEvaluationRecordV1 } from '../../src/domain/autonomous-completion.js';
import type { DiffGateResult } from '../../src/queries/impact/diff-gate.js';
import { formatAutonomousNextActions, publishAutonomousNextAction } from '../../src/runtime/autonomous-policy-loop.js';
import { buildObservationReceipt } from '../../src/runtime/observation-receipt.js';
import { readDecisionRecords } from '../../src/storage/autonomous-work-ledger.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('autonomous policy publication', () => {
  it('publishes one replay-stable decision and renders the exact bounded next action', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-policy-loop-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const goal = createGoalRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        feature: 'An agent resumes useful work autonomously',
        invariants: ['The goal cannot be weakened by a retry policy'],
        acceptanceScenarios: [
          {
            name: 'Gather named evidence',
            given: ['a fixed completion judgment'],
            when: ['goal evidence is unknown'],
            then: ['the next action names the missing evidence'],
          },
        ],
        authorization: {
          kind: 'repository-delegation',
          principal: 'repository-owner',
          source: 'policy-loop test',
        },
      },
      { toolVersion: '0.20.0' },
    ).record;
    const change = createIntendedChangeRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        goalId: goal.goalId,
        idempotencyKey: 'policy-loop-test',
        title: 'Publish autonomous next actions',
        intendedOutcome: 'The Stop controller emits one durable action',
      },
      { toolVersion: '0.20.0' },
    ).record;
    const evaluation = blockedEvaluation(root, goal.goalId, change.changeId);
    const first = publishAutonomousNextAction({
      projectRoot: root,
      collaborationDomainId: COLLABORATION_DOMAIN,
      evaluation,
      result: passingGate(),
      options: { toolVersion: '0.20.0', now: () => '2026-07-30T13:00:01.000Z' },
    });
    const replay = publishAutonomousNextAction({
      projectRoot: root,
      collaborationDomainId: COLLABORATION_DOMAIN,
      evaluation,
      result: passingGate(),
      options: { toolVersion: '99.0.0', now: () => '2026-07-31T13:00:01.000Z' },
    });

    expect(first.action).toMatchObject({
      kind: 'gather-evidence',
      namedPredicates: ['goal-fulfilled'],
    });
    expect(first.decision.publication).toBe('created');
    expect(replay.decision.publication).toBe('existing');
    expect(replay.decision.record.decisionId).toBe(first.decision.record.decisionId);
    expect(readDecisionRecords(root).records).toHaveLength(1);
    expect(formatAutonomousNextActions([first])).toContain(`Autonomous next action (gather-evidence, work):`);
    expect(formatAutonomousNextActions([first])).toContain('retry limit 3; strategy deadline 30m');

    const external = publishAutonomousNextAction({
      projectRoot: root,
      collaborationDomainId: COLLABORATION_DOMAIN,
      evaluation,
      result: passingGate(),
      externalGoalEvidenceRequired: true,
      options: { toolVersion: '0.20.0', now: () => '2026-07-30T13:00:02.000Z' },
    });
    expect(external.action).toMatchObject({ kind: 'halt-authority', blocker: 'missing-authorization' });
    expect(external.decision.record.nextAction).toContain('host must run the fixed protected evaluator');
    expect(readDecisionRecords(root).records).toHaveLength(2);
  });

  it('publishes protected evaluator findings as the decision-equivalent repair action', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-policy-loop-protected-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const goal = createGoalRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        feature: 'An independently evaluated feature is complete',
        invariants: ['Protected evaluator findings remain authoritative'],
        acceptanceScenarios: [
          {
            name: 'Actionable protected repair',
            given: ['a fixed protected evaluator result'],
            when: ['the evaluator disproves completion'],
            then: ['the next action carries each failed condition'],
          },
        ],
        authorization: {
          kind: 'repository-delegation',
          principal: 'repository-owner',
          source: 'protected policy-loop test',
        },
      },
      { toolVersion: '0.20.0' },
    ).record;
    const change = createIntendedChangeRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        goalId: goal.goalId,
        idempotencyKey: 'protected-policy-loop-test',
        title: 'Publish actionable protected findings',
        intendedOutcome: 'The Stop controller names the failed goal conditions',
      },
      { toolVersion: '0.20.0' },
    ).record;
    const evaluation = blockedEvaluation(root, goal.goalId, change.changeId, 'disproven');
    const published = publishAutonomousNextAction({
      projectRoot: root,
      collaborationDomainId: COLLABORATION_DOMAIN,
      evaluation,
      result: passingGate(),
      protectedGoalEvidence: {
        evidenceId: 'SQGE-0123456789ABCDEF0123456789ABCDEF',
        goalId: goal.goalId,
        changeId: change.changeId,
        result: {
          goalSatisfied: false,
          invariantsPreserved: true,
          affectedSurfaceReconciled: false,
          missedAffectedArtifacts: ['Reconcile the desktop sidebar width bounds.'],
          residueDefects: ['Remove duplicate seam borders from chat side panels.'],
          reintroducedBehaviors: [],
          architectureViolations: [],
        },
      },
      options: { toolVersion: '0.20.0', now: () => '2026-07-30T13:00:01.000Z' },
    });

    expect(published.action.namedPredicates).toEqual(['goal-fulfilled', 'coverage-complete']);
    expect(published.decision.record.nextAction).toContain('desktop sidebar width bounds');
    expect(published.decision.record.nextAction).toContain('duplicate seam borders');
    expect(formatAutonomousNextActions([published])).toContain('2 blocking finding(s)');

    const unrelated = publishAutonomousNextAction({
      projectRoot: root,
      collaborationDomainId: COLLABORATION_DOMAIN,
      evaluation,
      result: passingGate(),
      protectedGoalEvidence: {
        evidenceId: 'SQGE-FEDCBA9876543210FEDCBA9876543210',
        goalId: 'SQG-UNRELATED',
        changeId: change.changeId,
        result: {
          goalSatisfied: false,
          invariantsPreserved: true,
          affectedSurfaceReconciled: false,
          missedAffectedArtifacts: ['This finding belongs to another goal.'],
          residueDefects: [],
          reintroducedBehaviors: [],
          architectureViolations: [],
        },
      },
      options: { toolVersion: '0.20.0', now: () => '2026-07-30T13:00:02.000Z' },
    });
    expect(unrelated.action.instruction).toContain('Audit the fixed goal clause-by-clause');
    expect(unrelated.action.instruction).not.toContain('another goal');
  });
});

function blockedEvaluation(
  root: string,
  goalId: string,
  changeId: string,
  goalState: 'unknown' | 'disproven' = 'unknown',
): CompletionEvaluationRecordV1 {
  const targetObservation = buildObservationReceipt({ projectRoot: root });
  return {
    kind: 'scip-query-completion-evaluation',
    schemaVersion: 1,
    evaluationId: 'SQE-0123456789ABCDEF0123456789ABCDEF',
    collaborationDomainId: COLLABORATION_DOMAIN,
    changeId,
    goalId,
    context: {
      contextId: 'SQX-0123456789ABCDEF0123456789ABCDEF',
      policyId: 'SQX-0123456789ABCDEF0123456789ABCDEF',
      policyVersion: 1,
      evaluatorId: 'test-evaluator',
      evaluatorVersion: 'test-build',
      targetObservation,
    },
    predicates: [
      {
        predicate: 'goal-fulfilled',
        state: goalState,
        reasons: ['The goal scenario still needs independent evidence.'],
        evidenceReceipts: [targetObservation],
      },
      ...[
        'invariants-preserved',
        'evidence-compatible',
        'coverage-complete',
        'obligations-reconciled',
        'policy-permitted',
      ].map((predicate) => ({
        predicate: predicate as CompletionEvaluationRecordV1['predicates'][number]['predicate'],
        state: 'established' as const,
        reasons: [`${predicate} is established`],
        evidenceReceipts: [targetObservation],
      })),
    ],
    decision: {
      state: 'blocked',
      blockedPredicates: ['goal-fulfilled'],
      unknownPredicates: goalState === 'unknown' ? ['goal-fulfilled'] : [],
    },
    idempotency: {
      version: 1,
      algorithm: 'sha256',
      keyDigest: 'a'.repeat(64),
      requestDigest: 'b'.repeat(64),
    },
    createdAt: '2026-07-30T13:00:00.000Z',
    writer: { tool: 'scip-query', version: '0.20.0' },
  };
}

function passingGate(): DiffGateResult {
  return {
    base: 'HEAD',
    changedFiles: [],
    changedSymbols: 0,
    checksRun: ['architecture'],
    skipped: [],
    suppressed: [],
    findings: [],
    attributionNotes: [],
    evidenceTiers: [],
  };
}
