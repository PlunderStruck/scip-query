import { describe, expect, it } from 'vitest';

import {
  AUTONOMOUS_RESTORATION_CONTEXT_BUDGET_BYTES,
  buildAutonomousRestorationProjection,
  renderAutonomousRestorationProjection,
} from '../../src/domain/autonomous-work-restoration.js';
import {
  createAttemptRecord,
  createDecisionRecord,
  foldWorkHistory,
  type AttemptOutcome,
} from '../../src/domain/autonomous-work-ledger.js';
import { createObligationAdmission, foldObligationLifecycle } from '../../src/domain/autonomous-work-obligations.js';
import { createGoalRecord, createIntendedChangeRecord } from '../../src/domain/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const TOOL_VERSION = '0.20.0';

describe('autonomous work restoration projection', () => {
  it('recovers the governing goal, current condition, last strategy, failed families, decision, and live obligations', () => {
    const { goal, change } = workState();
    const failed = attempt(change.changeId, 'compile', 'failed', '2026-07-30T12:00:00.000Z');
    const supersedingSuccess = attempt(change.changeId, 'compile', 'succeeded', '2026-07-30T12:01:00.000Z');
    const unknown = attempt(change.changeId, 'publish', 'unknown', '2026-07-30T12:02:00.000Z');
    const decision = createDecisionRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: {
        changeId: change.changeId,
        idempotencyKey: 'decision',
        basisAttemptIds: [unknown.attemptId],
        evidenceReceipts: [],
        disposition: 'change-strategy',
        rationale: 'Publishing did not return an acknowledgment',
        nextAction: 'Reconcile the published artifact before another write',
      },
      createdAt: '2026-07-30T12:03:00.000Z',
      toolVersion: TOOL_VERSION,
    });
    const obligation = createObligationAdmission({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: {
        changeId: change.changeId,
        idempotencyKey: 'restore-test',
        category: 'verification',
        title: 'Confirm restored behavior',
        requiredCondition: 'A new process can recover the complete live work state',
        source: { kind: 'agent-discovery', referent: 'restoration test' },
        basisAttemptIds: [unknown.attemptId],
        evidenceReceipts: [],
      },
      createdAt: '2026-07-30T12:04:00.000Z',
      toolVersion: TOOL_VERSION,
    });

    const projection = buildAutonomousRestorationProjection({
      goals: [goal],
      changes: [change],
      workHistory: foldWorkHistory([unknown, supersedingSuccess, failed], [decision]),
      obligationLifecycle: foldObligationLifecycle([obligation], []),
    });

    expect(projection.safeToContinue).toBe(true);
    expect(projection.changes).toHaveLength(1);
    expect(projection.changes[0]).toMatchObject({
      changeId: change.changeId,
      currentCondition: 'Reconcile the published artifact before another write',
      goal: {
        goalId: goal.goalId,
        feature: 'An agent resumes repository work from durable facts',
      },
      latestAttempt: { attemptId: unknown.attemptId, outcome: 'unknown' },
      latestDecision: { decisionId: decision.decisionId, disposition: 'change-strategy' },
      unsafeToRepeatAttemptIds: [unknown.attemptId],
    });
    expect(projection.changes[0]?.lastDistinctUnsuccessfulAttempts.map((value) => value.attemptId)).toEqual([
      unknown.attemptId,
    ]);
    expect(projection.changes[0]?.liveObligations).toEqual([
      expect.objectContaining({ obligationId: obligation.obligationId }),
    ]);
    expect(renderAutonomousRestorationProjection(projection)).toContain(
      `Unsafe to repeat until reconciled: ${unknown.attemptId}`,
    );
    expect(renderAutonomousRestorationProjection(projection)).toContain(
      `scip-query obligation status ${change.changeId}`,
    );
  });

  it('keeps abandoned work visible only while unresolved facts still constrain it', () => {
    const { goal, change } = workState();
    const failed = attempt(change.changeId, 'compile', 'failed', '2026-07-30T12:00:00.000Z');
    const abandoned = createDecisionRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: {
        changeId: change.changeId,
        idempotencyKey: 'abandon',
        basisAttemptIds: [failed.attemptId],
        evidenceReceipts: [],
        disposition: 'abandon',
        rationale: 'The authorized work is no longer required',
      },
      createdAt: '2026-07-30T12:01:00.000Z',
      toolVersion: TOOL_VERSION,
    });

    const settled = buildAutonomousRestorationProjection({
      goals: [goal],
      changes: [change],
      workHistory: foldWorkHistory([failed], [abandoned]),
      obligationLifecycle: foldObligationLifecycle([], []),
    });
    const obligation = createObligationAdmission({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: {
        changeId: change.changeId,
        idempotencyKey: 'unsettled',
        category: 'documentation',
        title: 'Document the abandonment',
        requiredCondition: 'The durable record explains why the work ended',
        source: { kind: 'policy', referent: 'completion accountability' },
        basisAttemptIds: [failed.attemptId],
        evidenceReceipts: [],
      },
      createdAt: '2026-07-30T12:02:00.000Z',
      toolVersion: TOOL_VERSION,
    });
    const unsettled = buildAutonomousRestorationProjection({
      goals: [goal],
      changes: [change],
      workHistory: foldWorkHistory([failed], [abandoned]),
      obligationLifecycle: foldObligationLifecycle([obligation], []),
    });

    expect(settled.changes).toEqual([]);
    expect(unsettled.changes).toHaveLength(1);
  });

  it('is input-order deterministic, fails closed on omitted records, and honors its byte budget', () => {
    const { goal, change } = workState();
    const first = attempt(change.changeId, 'compile', 'failed', '2026-07-30T12:00:00.000Z');
    const second = attempt(change.changeId, 'test', 'failed', '2026-07-30T12:01:00.000Z');
    const input = {
      goals: [goal],
      changes: [change],
      workHistory: foldWorkHistory([first, second], []),
      obligationLifecycle: foldObligationLifecycle([], []),
      coverageIssues: Array.from(
        { length: 100 },
        (_, index) => `attempt record .scipquery/attempts/bad-${index}.json is malformed: invalid JSON`,
      ),
    };
    const left = buildAutonomousRestorationProjection(input);
    const right = buildAutonomousRestorationProjection({
      ...input,
      workHistory: foldWorkHistory([second, first], []),
    });
    const rendered = renderAutonomousRestorationProjection(left, 1_024);

    expect(left.cursor).toBe(right.cursor);
    expect(left.safeToContinue).toBe(false);
    expect(left.issues).toHaveLength(100);
    expect(rendered).toContain('UNVERIFIED');
    expect(rendered).toContain('scip-query obligation status');
    expect(Buffer.byteLength(rendered ?? '', 'utf8')).toBeLessThanOrEqual(1_024);
    expect(AUTONOMOUS_RESTORATION_CONTEXT_BUDGET_BYTES).toBe(16 * 1_024);
  });
});

function workState() {
  const goal = createGoalRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      feature: 'An agent resumes repository work from durable facts',
      invariants: ['No live obligation disappears during restoration'],
      acceptanceScenarios: [
        {
          name: 'Process death',
          given: ['committed work records exist'],
          when: ['a new process starts'],
          then: ['the agent recovers the current goal and every live obligation'],
        },
      ],
      authorization: {
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'test',
      },
    },
    createdAt: '2026-07-30T11:00:00.000Z',
    toolVersion: TOOL_VERSION,
  });
  const change = createIntendedChangeRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      goalId: goal.goalId,
      idempotencyKey: 'restoration',
      title: 'Restore autonomous work',
      intendedOutcome: 'A new process resumes from committed facts',
    },
    createdAt: '2026-07-30T11:01:00.000Z',
    toolVersion: TOOL_VERSION,
  });
  return { goal, change };
}

function attempt(changeId: string, family: string, outcome: AttemptOutcome, createdAt: string) {
  return createAttemptRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      changeId,
      idempotencyKey: `${family}-${outcome}`,
      intendedCondition: `${family} establishes the intended repository condition`,
      action: {
        family,
        summary: `Run the ${family} strategy`,
        effectClass: family === 'publish' ? 'non-idempotent-write' : 'idempotent-write',
      },
      evidenceReceipts: [],
      observedEffect: `${family} ended with ${outcome}`,
      outcome,
    },
    createdAt,
    toolVersion: TOOL_VERSION,
  });
}
