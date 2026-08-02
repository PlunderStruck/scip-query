import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PlanContractRequest } from '../../src/change-control/plan-contract.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import { createPlanContractRecordFile, readPlanContractRecords } from '../../src/storage/plan-contract.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      // Vitest temporary roots are outside the repository and contain only test records.
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup.
    }
  }
});

describe('plan contract storage', () => {
  it('publishes one retry-safe current plan after its derived state can be prepared', () => {
    const state = repository();
    const first = createPlanContractRecordFile(
      state.root,
      DOMAIN,
      contract(state.goalId, state.changeId),
      { path: 'plan.md', sha256: 'a'.repeat(64) },
      receipt('first'),
      options(),
    );
    const retry = createPlanContractRecordFile(
      state.root,
      DOMAIN,
      contract(state.goalId, state.changeId),
      { path: 'plan.md', sha256: 'a'.repeat(64) },
      receipt('first'),
      options(),
    );

    expect(first.publication).toBe('created');
    expect(retry).toMatchObject({ publication: 'existing', record: { planId: first.record.planId } });
    expect(readPlanContractRecords(state.root).currentRecords).toMatchObject([{ planId: first.record.planId }]);
  });

  it('selects an append-only successor and reports a fork instead of silently choosing one', () => {
    const state = repository();
    const first = createPlanContractRecordFile(
      state.root,
      DOMAIN,
      contract(state.goalId, state.changeId),
      { path: 'plan.md', sha256: 'a'.repeat(64) },
      receipt('first'),
      options(),
    ).record;
    const successor = createPlanContractRecordFile(
      state.root,
      DOMAIN,
      { ...contract(state.goalId, state.changeId), predecessorPlanId: first.planId },
      { path: 'plan.md', sha256: 'b'.repeat(64) },
      receipt('second'),
      options(),
    ).record;
    expect(readPlanContractRecords(state.root).currentRecords).toMatchObject([{ planId: successor.planId }]);

    createPlanContractRecordFile(
      state.root,
      DOMAIN,
      {
        ...contract(state.goalId, state.changeId),
        predecessorPlanId: first.planId,
        preserve: [{ id: 'other', condition: 'Preserve another outcome', evidenceIds: ['tests'] }],
      },
      { path: 'plan.md', sha256: 'c'.repeat(64) },
      receipt('third'),
      options(),
    );
    const forked = readPlanContractRecords(state.root);
    expect(forked.integrityIssues).toEqual(expect.arrayContaining([expect.stringContaining('fork')]));
    expect(forked.currentRecords).toEqual([]);
  });

  it('rejects a goal/change mismatch before publishing the plan', () => {
    const state = repository();
    expect(() =>
      createPlanContractRecordFile(
        state.root,
        DOMAIN,
        contract('SQG-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', state.changeId),
        { path: 'plan.md', sha256: 'a'.repeat(64) },
        receipt('first'),
        options(),
      ),
    ).toThrow(/goal/i);
    expect(readPlanContractRecords(state.root).records).toEqual([]);
  });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'scip-plan-contract-'));
  roots.push(root);
  const goal = createGoalRecordFile(
    root,
    DOMAIN,
    {
      feature: 'A retry migration reaches coherent completion',
      invariants: ['Unrelated behavior remains true'],
      acceptanceScenarios: [
        {
          name: 'Legacy retry is retired',
          given: ['A legacy retry path exists'],
          when: ['The migration completes'],
          then: ['The old path no longer remains reachable'],
        },
      ],
      authorization: { kind: 'repository-delegation', principal: 'repository-owner', source: 'test' },
    },
    options(),
  ).record;
  const change = createIntendedChangeRecordFile(
    root,
    DOMAIN,
    {
      goalId: goal.goalId,
      idempotencyKey: 'retry-migration',
      title: 'Retry migration',
      intendedOutcome: 'The legacy retry path is retired',
    },
    options(),
  ).record;
  return { root, goalId: goal.goalId, changeId: change.changeId };
}

function contract(goalId: string, changeId: string): PlanContractRequest {
  return {
    schemaVersion: 1,
    goalId,
    changeId,
    workflowClass: 'relational',
    affectedSeeds: [{ id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry' }],
    preserve: [{ id: 'outcomes', condition: 'Preserve non-retry outcomes', evidenceIds: ['tests'] }],
    retirements: [
      {
        id: 'legacy',
        kind: 'identity',
        referent: 'legacyRetry',
        responsibility: 'fixed delay',
        condition: 'Remove the legacy identity',
        evidenceIds: ['search'],
      },
    ],
    allowedSurvivors: [],
    reuseAuthorities: [],
    architecture: [],
    completionEvidence: [
      { id: 'tests', description: 'Run tests' },
      { id: 'search', description: 'Search the closure' },
    ],
    slices: [],
  };
}

function receipt(value: string): ObservationReceiptV2 {
  const content = createObservationIdentity('repository-content', 1, value);
  return {
    schemaVersion: 2,
    observedAt: '2026-08-01T12:00:00.000Z',
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}

function options() {
  return { toolVersion: '0.20.0', now: () => '2026-08-01T12:00:00.000Z' };
}
