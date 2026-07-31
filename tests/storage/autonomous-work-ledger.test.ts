import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type AttemptCreateRequest, type DecisionCreateRequest } from '../../src/domain/autonomous-work-ledger.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import type { GoalCreateRequest, IntendedChangeCreateRequest } from '../../src/domain/autonomous-work-state.js';
import { NODE_ATOMIC_FILE_RUNTIME, type AtomicFileRuntime } from '../../src/storage/atomic-file.js';
import {
  createAttemptRecordFile,
  createDecisionRecordFile,
  readAttemptRecords,
  readDecisionRecords,
  readWorkHistory,
} from '../../src/storage/autonomous-work-ledger.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const TOOL_VERSION = '0.20.0';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('autonomous work ledger storage', () => {
  it('publishes one attempt durably and recovers a linked-but-unacknowledged retry', () => {
    const root = fixtureDirectory();
    const changeId = createChange(root);
    const runtime: AtomicFileRuntime = {
      ...NODE_ATOMIC_FILE_RUNTIME,
      randomToken: () => 'attempt-unknown-outcome',
      linkFile: (source, target) => {
        NODE_ATOMIC_FILE_RUNTIME.linkFile!(source, target);
        throw Object.assign(new Error('simulated disconnect after attempt publication'), { code: 'EIO' });
      },
    };

    expect(() =>
      createAttemptRecordFile(root, COLLABORATION_DOMAIN, attemptRequest(changeId, 'attempt-1', 'failed'), {
        toolVersion: TOOL_VERSION,
        now: () => '2026-07-30T12:00:00.000Z',
        atomicRuntime: runtime,
      }),
    ).toThrow('simulated disconnect after attempt publication');

    const retry = createAttemptRecordFile(root, COLLABORATION_DOMAIN, attemptRequest(changeId, 'attempt-1', 'failed'), {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:00:00.000Z',
    });
    expect(retry.publication).toBe('existing');
    expect(retry.record.createdAt).toBe('2026-07-30T12:00:00.000Z');
  });

  it('rejects an idempotency collision without overwriting the first attempt', () => {
    const root = fixtureDirectory();
    const changeId = createChange(root);
    const request = attemptRequest(changeId, 'attempt-1', 'failed');
    const first = createAttemptRecordFile(root, COLLABORATION_DOMAIN, request, { toolVersion: TOOL_VERSION });

    expect(() =>
      createAttemptRecordFile(
        root,
        COLLABORATION_DOMAIN,
        { ...request, observedEffect: 'Different effect' },
        { toolVersion: TOOL_VERSION },
      ),
    ).toThrow(/idempotency collision/u);
    expect(readAttemptRecords(root).records).toEqual([first.record]);
  });

  it('preserves distinct branch attempts and decisions under conflict-free filenames', () => {
    const left = fixtureDirectory();
    const right = fixtureDirectory();
    const merged = fixtureDirectory();
    const changeId = createChange(left);
    copyState(left, right);
    copyState(left, merged);
    const leftAttempt = createAttemptRecordFile(
      left,
      COLLABORATION_DOMAIN,
      attemptRequest(changeId, 'left-attempt', 'failed'),
      { toolVersion: TOOL_VERSION },
    ).record;
    const rightAttempt = createAttemptRecordFile(
      right,
      COLLABORATION_DOMAIN,
      attemptRequest(changeId, 'right-attempt', 'succeeded'),
      { toolVersion: TOOL_VERSION },
    ).record;
    const leftDecision = createDecisionRecordFile(
      left,
      COLLABORATION_DOMAIN,
      decisionRequest(changeId, leftAttempt.attemptId, 'left-decision'),
      { toolVersion: TOOL_VERSION },
    ).record;
    const rightDecision = createDecisionRecordFile(
      right,
      COLLABORATION_DOMAIN,
      decisionRequest(changeId, rightAttempt.attemptId, 'right-decision'),
      { toolVersion: TOOL_VERSION },
    ).record;

    copyRelative(left, merged, join('.scipquery', 'attempts', `${leftAttempt.attemptId}.json`));
    copyRelative(right, merged, join('.scipquery', 'attempts', `${rightAttempt.attemptId}.json`));
    copyRelative(left, merged, join('.scipquery', 'decisions', `${leftDecision.decisionId}.json`));
    copyRelative(right, merged, join('.scipquery', 'decisions', `${rightDecision.decisionId}.json`));

    const history = readWorkHistory(merged, changeId);
    expect(history.integrityIssues).toEqual([]);
    expect(history.summary.attempts.map((attempt) => attempt.attemptId).sort()).toEqual(
      [leftAttempt.attemptId, rightAttempt.attemptId].sort(),
    );
    expect(history.summary.decisions.map((decision) => decision.decisionId).sort()).toEqual(
      [leftDecision.decisionId, rightDecision.decisionId].sort(),
    );
  });

  it('blocks unsafe retry decisions until observation-backed reconciliation', () => {
    const root = fixtureDirectory();
    const changeId = createChange(root);
    const unknown = createAttemptRecordFile(
      root,
      COLLABORATION_DOMAIN,
      attemptRequest(changeId, 'unknown-attempt', 'unknown'),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:00:00.000Z' },
    ).record;
    const retry = decisionRequest(changeId, unknown.attemptId, 'retry-decision');
    retry.disposition = 'retry-safe';

    expect(() => createDecisionRecordFile(root, COLLABORATION_DOMAIN, retry, { toolVersion: TOOL_VERSION })).toThrow(
      /unresolved non-idempotent/u,
    );

    createAttemptRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        ...attemptRequest(changeId, 'reconcile-attempt', 'succeeded'),
        evidenceReceipts: [receipt('2026-07-30T12:05:00.000Z', 'after-effect')],
        reconcilesAttemptId: unknown.attemptId,
      },
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:06:00.000Z' },
    );
    const decision = createDecisionRecordFile(root, COLLABORATION_DOMAIN, retry, {
      toolVersion: TOOL_VERSION,
    });

    expect(decision.publication).toBe('created');
    expect(readWorkHistory(root, changeId).summary.unsafeToRepeatAttemptIds).toEqual([]);
  });

  it('rejects stale reconciliation evidence and missing decision bases', () => {
    const root = fixtureDirectory();
    const changeId = createChange(root);
    const unknown = createAttemptRecordFile(
      root,
      COLLABORATION_DOMAIN,
      attemptRequest(changeId, 'unknown-attempt', 'unknown'),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:00:00.000Z' },
    ).record;

    expect(() =>
      createAttemptRecordFile(
        root,
        COLLABORATION_DOMAIN,
        {
          ...attemptRequest(changeId, 'stale-reconciliation', 'failed'),
          evidenceReceipts: [receipt('2026-07-30T11:59:00.000Z', 'before-effect')],
          reconcilesAttemptId: unknown.attemptId,
        },
        { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:06:00.000Z' },
      ),
    ).toThrow(/does not carry an observation/u);

    expect(() =>
      createDecisionRecordFile(
        root,
        COLLABORATION_DOMAIN,
        decisionRequest(changeId, 'SQA-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'missing-basis'),
        { toolVersion: TOOL_VERSION },
      ),
    ).toThrow(/not a readable current record/u);
  });

  it('reports complete compatibility and relationship integrity for the current record set', () => {
    const root = fixtureDirectory();
    const changeId = createChange(root);
    const attempt = createAttemptRecordFile(
      root,
      COLLABORATION_DOMAIN,
      attemptRequest(changeId, 'attempt', 'succeeded'),
      { toolVersion: TOOL_VERSION },
    ).record;
    createDecisionRecordFile(root, COLLABORATION_DOMAIN, decisionRequest(changeId, attempt.attemptId, 'decision'), {
      toolVersion: TOOL_VERSION,
    });

    expect(readAttemptRecords(root)).toEqual(
      expect.objectContaining({
        compatibility: expect.objectContaining({ complete: true }),
        integrityIssues: [],
      }),
    );
    expect(readDecisionRecords(root)).toEqual(
      expect.objectContaining({
        compatibility: expect.objectContaining({ complete: true }),
        integrityIssues: [],
      }),
    );
  });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-work-ledger-'));
  fixtureDirectories.add(directory);
  return directory;
}

function createChange(root: string): string {
  const goal = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
    toolVersion: TOOL_VERSION,
  }).record;
  return createIntendedChangeRecordFile(root, COLLABORATION_DOMAIN, changeRequest(goal.goalId), {
    toolVersion: TOOL_VERSION,
  }).record.changeId;
}

function goalRequest(): GoalCreateRequest {
  return {
    feature: 'An agent completes repository work',
    invariants: ['Unknown external effects are not repeated'],
    acceptanceScenarios: [
      {
        name: 'Work resumes safely',
        given: ['an action has an unknown outcome'],
        when: ['another process resumes'],
        then: ['the action is reconciled before repetition'],
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
    idempotencyKey: 'work-ledger-change',
    title: 'Append-only work history',
    intendedOutcome: 'Attempts and decisions survive interruption',
  };
}

function attemptRequest(
  changeId: string,
  idempotencyKey: string,
  outcome: AttemptCreateRequest['outcome'],
): AttemptCreateRequest {
  return {
    changeId,
    idempotencyKey,
    intendedCondition: 'The migration has one effect',
    action: {
      family: 'database-migration',
      summary: 'Apply migration once',
      effectClass: 'non-idempotent-write',
    },
    evidenceReceipts: [],
    observedEffect: outcome === 'unknown' ? 'The connection ended before acknowledgment' : `The action ${outcome}`,
    outcome,
  };
}

function decisionRequest(changeId: string, attemptId: string, idempotencyKey: string): DecisionCreateRequest {
  return {
    changeId,
    idempotencyKey,
    basisAttemptIds: [attemptId],
    evidenceReceipts: [],
    disposition: 'change-strategy',
    rationale: 'The recorded effect determines the next safe strategy',
    nextAction: 'Continue with the evidence-supported strategy',
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
  for (const relativePath of [join('.scipquery', 'goals'), join('.scipquery', 'changes')]) {
    mkdirSync(join(targetRoot, relativePath), { recursive: true });
  }
  const goal = createGoalRecordFile(sourceRoot, COLLABORATION_DOMAIN, goalRequest(), {
    toolVersion: TOOL_VERSION,
  }).record;
  const change = createIntendedChangeRecordFile(sourceRoot, COLLABORATION_DOMAIN, changeRequest(goal.goalId), {
    toolVersion: TOOL_VERSION,
  }).record;
  copyRelative(sourceRoot, targetRoot, join('.scipquery', 'goals', `${goal.goalId}.json`));
  copyRelative(sourceRoot, targetRoot, join('.scipquery', 'changes', `${change.changeId}.json`));
}

function copyRelative(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, relativePath), target);
}
