import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type ObligationAdmissionRequest,
  type ObligationTransitionRequest,
} from '../../src/domain/autonomous-work-obligations.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import type { GoalCreateRequest, IntendedChangeCreateRequest } from '../../src/domain/autonomous-work-state.js';
import {
  createObligationAdmissionFile,
  createObligationTransitionFile,
  readObligationAdmissions,
  readObligationLifecycle,
  readObligationTransitions,
} from '../../src/storage/autonomous-work-obligations.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const TOOL_VERSION = '0.20.0';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('autonomous work obligations storage', () => {
  it('publishes retry-safe admissions and rejects an idempotency collision', () => {
    const root = fixtureDirectory();
    const { changeId } = createChanges(root);
    const request = admissionRequest(changeId, 'residue');
    const first = createObligationAdmissionFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    });
    const retry = createObligationAdmissionFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:00:00.000Z',
    });

    expect(first.publication).toBe('created');
    expect(retry.publication).toBe('existing');
    expect(retry.record.createdAt).toBe(first.record.createdAt);
    expect(() =>
      createObligationAdmissionFile(
        root,
        COLLABORATION_DOMAIN,
        { ...request, requiredCondition: 'A different condition' },
        { toolVersion: TOOL_VERSION },
      ),
    ).toThrow(/idempotency collision/u);
  });

  it('refuses terminal closure without fixed evidence observed after admission', () => {
    const root = fixtureDirectory();
    const { changeId } = createChanges(root);
    const admitted = createObligationAdmissionFile(root, COLLABORATION_DOMAIN, admissionRequest(changeId, 'residue'), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    }).record;

    expect(() =>
      createObligationTransitionFile(
        root,
        COLLABORATION_DOMAIN,
        transitionRequest(changeId, admitted.obligationId, 'stale', 'fulfilled', [
          receipt('2026-07-30T11:59:00.000Z', 'stale'),
        ]),
        { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:10:00.000Z' },
      ),
    ).toThrow(/lacks fixed current evidence/u);
    expect(() =>
      createObligationTransitionFile(
        root,
        COLLABORATION_DOMAIN,
        transitionRequest(changeId, admitted.obligationId, 'future', 'fulfilled', [
          receipt('2026-07-30T12:11:00.000Z', 'future'),
        ]),
        { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:10:00.000Z' },
      ),
    ).toThrow(/lacks fixed current evidence/u);
    expect(readObligationLifecycle(root, changeId).summary.liveObligationIds).toEqual([admitted.obligationId]);
  });

  it('fails closed when an unreadable transition could hide a prior terminal fact', () => {
    const root = fixtureDirectory();
    const { changeId } = createChanges(root);
    const admitted = createObligationAdmissionFile(root, COLLABORATION_DOMAIN, admissionRequest(changeId, 'residue'), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    }).record;
    const transitions = join(root, '.scipquery', 'obligation-transitions');
    mkdirSync(transitions, { recursive: true });
    writeFileSync(
      join(transitions, 'SQT-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json'),
      `${JSON.stringify({
        kind: 'scip-query-obligation-transition',
        schemaVersion: 2,
        transitionId: 'SQT-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      })}\n`,
    );

    expect(() =>
      createObligationTransitionFile(
        root,
        COLLABORATION_DOMAIN,
        transitionRequest(changeId, admitted.obligationId, 'blocked', 'fulfilled', [
          receipt('2026-07-30T12:05:00.000Z', 'blocked'),
        ]),
        { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:10:00.000Z' },
      ),
    ).toThrow(/lifecycle is incomplete or inconsistent/u);
  });

  it('makes a terminal transition idempotent and prevents terminal-to-live resurrection', () => {
    const root = fixtureDirectory();
    const { changeId } = createChanges(root);
    const admitted = createObligationAdmissionFile(root, COLLABORATION_DOMAIN, admissionRequest(changeId, 'residue'), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    }).record;
    const request = transitionRequest(changeId, admitted.obligationId, 'fulfilled', 'fulfilled', [
      receipt('2026-07-30T12:05:00.000Z', 'fulfilled'),
    ]);
    const first = createObligationTransitionFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:10:00.000Z',
    });
    const retry = createObligationTransitionFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:00:00.000Z',
    });

    expect(first.publication).toBe('created');
    expect(retry.publication).toBe('existing');
    expect(() =>
      createObligationTransitionFile(
        root,
        COLLABORATION_DOMAIN,
        {
          ...transitionRequest(changeId, admitted.obligationId, 'invalidate', 'invalidated', [
            receipt('2026-07-30T12:06:00.000Z', 'invalidate'),
          ]),
          reason: 'premise-disproven',
        },
        { toolVersion: TOOL_VERSION },
      ),
    ).toThrow(/terminal obligations cannot transition/u);
    expect(readObligationLifecycle(root, changeId).summary.fulfilledObligationIds).toEqual([admitted.obligationId]);
  });

  it('carries an obligation into a same-goal successor change in one transition file', () => {
    const root = fixtureDirectory();
    const { changeId, nextChangeId } = createChanges(root);
    const admitted = createObligationAdmissionFile(root, COLLABORATION_DOMAIN, admissionRequest(changeId, 'residue'), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    }).record;
    const request: ObligationTransitionRequest = {
      ...transitionRequest(changeId, admitted.obligationId, 'carry', 'carried-forward', [
        receipt('2026-07-30T12:05:00.000Z', 'carry'),
      ]),
      reason: 'successor-change-authorized',
      successor: {
        ...admissionRequest(nextChangeId, 'successor'),
        title: 'Finish residue removal in the successor change',
      },
    };
    const transition = createObligationTransitionFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:10:00.000Z',
    }).record;
    const lifecycle = readObligationLifecycle(root);

    expect(transition.successor?.changeId).toBe(nextChangeId);
    expect(lifecycle.summary.carriedForwardObligationIds).toEqual([admitted.obligationId]);
    expect(lifecycle.summary.liveObligationIds).toEqual([transition.successor?.obligationId]);
    expect(lifecycle.integrityIssues).toEqual([]);
    expect(readObligationLifecycle(root, nextChangeId).summary.liveObligationIds).toEqual([
      transition.successor?.obligationId,
    ]);
  });

  it('preserves concurrent branch transitions and exposes their terminal conflict after merge', () => {
    const left = fixtureDirectory();
    const right = fixtureDirectory();
    const merged = fixtureDirectory();
    const { changeId } = createChanges(left);
    copyState(left, right);
    copyState(left, merged);
    const admitted = createObligationAdmissionFile(left, COLLABORATION_DOMAIN, admissionRequest(changeId, 'residue'), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    }).record;
    copyRelative(left, right, join('.scipquery', 'obligations', `${admitted.obligationId}.json`));
    copyRelative(left, merged, join('.scipquery', 'obligations', `${admitted.obligationId}.json`));
    const fulfilled = createObligationTransitionFile(
      left,
      COLLABORATION_DOMAIN,
      transitionRequest(changeId, admitted.obligationId, 'left', 'fulfilled', [
        receipt('2026-07-30T12:05:00.000Z', 'left'),
      ]),
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:10:00.000Z' },
    ).record;
    const invalidated = createObligationTransitionFile(
      right,
      COLLABORATION_DOMAIN,
      {
        ...transitionRequest(changeId, admitted.obligationId, 'right', 'invalidated', [
          receipt('2026-07-30T12:06:00.000Z', 'right'),
        ]),
        reason: 'premise-disproven',
      },
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:11:00.000Z' },
    ).record;
    copyRelative(left, merged, join('.scipquery', 'obligation-transitions', `${fulfilled.transitionId}.json`));
    copyRelative(right, merged, join('.scipquery', 'obligation-transitions', `${invalidated.transitionId}.json`));
    const lifecycle = readObligationLifecycle(merged, changeId);

    expect(lifecycle.summary.conflictedObligationIds).toEqual([admitted.obligationId]);
    expect(lifecycle.integrityIssues).toEqual([expect.stringContaining('conflicting terminal transitions')]);
    expect(readObligationAdmissions(merged).compatibility.complete).toBe(true);
    expect(readObligationTransitions(merged).compatibility.complete).toBe(true);
  });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-obligations-'));
  fixtureDirectories.add(directory);
  return directory;
}

function createChanges(root: string): { changeId: string; nextChangeId: string } {
  const goal = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
    toolVersion: TOOL_VERSION,
  }).record;
  const changeId = createIntendedChangeRecordFile(root, COLLABORATION_DOMAIN, changeRequest(goal.goalId, 'first'), {
    toolVersion: TOOL_VERSION,
  }).record.changeId;
  const nextChangeId = createIntendedChangeRecordFile(root, COLLABORATION_DOMAIN, changeRequest(goal.goalId, 'next'), {
    toolVersion: TOOL_VERSION,
  }).record.changeId;
  return { changeId, nextChangeId };
}

function goalRequest(): GoalCreateRequest {
  return {
    feature: 'An agent completes repository work without losing obligations',
    invariants: ['No live obligation disappears without fixed current evidence'],
    acceptanceScenarios: [
      {
        name: 'Work resumes with every obligation',
        given: ['branches have recorded unfinished work'],
        when: ['their records merge'],
        then: ['every unfinished obligation remains live or conflicted'],
      },
    ],
    authorization: {
      kind: 'repository-delegation',
      principal: 'repository-owner',
      source: 'codex-task',
    },
  };
}

function changeRequest(goalId: string, key: string): IntendedChangeCreateRequest {
  return {
    goalId,
    idempotencyKey: `obligation-${key}`,
    title: `${key} obligation change`,
    intendedOutcome: 'Obligation lifecycle facts survive collaboration',
  };
}

function admissionRequest(changeId: string, idempotencyKey: string): ObligationAdmissionRequest {
  return {
    changeId,
    idempotencyKey,
    category: 'residue',
    title: 'Remove obsolete adapter',
    requiredCondition: 'The obsolete adapter has no remaining source or consumer',
    source: { kind: 'agent-discovery', referent: 'src/obsolete-adapter.ts' },
    basisAttemptIds: [],
    evidenceReceipts: [],
  };
}

function transitionRequest(
  changeId: string,
  obligationId: string,
  idempotencyKey: string,
  to: ObligationTransitionRequest['to'],
  evidenceReceipts: readonly ObservationReceiptV2[],
): ObligationTransitionRequest {
  return {
    changeId,
    obligationId,
    idempotencyKey,
    to,
    reason: to === 'fulfilled' ? 'condition-established' : 'premise-disproven',
    basisAttemptIds: [],
    evidenceReceipts,
    rationale: 'A fixed current repository observation establishes this terminal fact',
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
    const source = join(sourceRoot, relativeDirectory);
    for (const entry of readdirSync(source)) {
      copyRelative(sourceRoot, targetRoot, join(relativeDirectory, entry));
    }
  }
}

function copyRelative(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, relativePath), target);
}
