import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PlanContractRequest } from '../../src/change-control/plan-contract.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';
import { applyPlanContract } from '../../src/runtime/plan-contract-compiler.js';
import { readObligationLifecycle } from '../../src/storage/autonomous-work-obligations.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';
import { readGoalRecords, readIntendedChangeRecords } from '../../src/storage/autonomous-work-state.js';
import { readPlanContractRecords } from '../../src/storage/plan-contract.js';

const DOMAIN = '70a26367-a22f-46a7-aa64-f4ea5f09cc51';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plan contract compiler', () => {
  it('turns one readable plan into one immutable contract and retries safely after time advances', () => {
    const state = repository();
    const plan = contract(state.goalId, state.changeId);
    writeFileSync(state.planPath, `# Plan\n\n\`\`\`scip-query-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);

    const result = applyPlanContract(state.root, 'plan.md', {
      collaborationDomainId: DOMAIN,
      toolVersion: '0.20.0',
      now: () => '2026-08-01T12:00:00.000Z',
      captureObservation: () => receipt(),
    });
    const retry = applyPlanContract(state.root, 'plan.md', {
      collaborationDomainId: DOMAIN,
      toolVersion: '0.20.0',
      now: () => '2026-08-01T12:05:00.000Z',
      captureObservation: () => ({ ...receipt(), observedAt: '2026-08-01T12:05:00.000Z' }),
    });

    expect(result.plan.publication).toBe('created');
    expect(retry.plan).toMatchObject({ publication: 'existing', record: { planId: result.plan.record.planId } });
    expect(result.obligations).toHaveLength(2);
    expect(retry.obligations.every((entry) => entry.publication === 'existing')).toBe(true);
    expect(readPlanContractRecords(state.root).currentRecords).toHaveLength(1);
    expect(readObligationLifecycle(state.root, state.changeId).summary.liveObligationIds).toHaveLength(2);
  });

  it('validates the complete contract before writing any plan or obligation record', () => {
    const state = repository();
    writeFileSync(state.planPath, '# Plan\n\n```scip-query-plan\n{"schemaVersion":1}\n```\n');

    expect(() =>
      applyPlanContract(state.root, 'plan.md', {
        collaborationDomainId: DOMAIN,
        toolVersion: '0.20.0',
        captureObservation: () => receipt(),
      }),
    ).toThrow(/goalId/i);
    expect(readPlanContractRecords(state.root).records).toEqual([]);
    expect(readObligationLifecycle(state.root, state.changeId).summary.obligations).toEqual([]);
  });

  it('creates a missing goal and intended change from the same plan action', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-plan-compiler-inline-'));
    roots.push(root);
    const plan = {
      ...contract('SQG-0123456789ABCDEF0123456789ABCDEF', 'SQC-0123456789ABCDEF0123456789ABCDEF'),
      goalId: undefined,
      changeId: undefined,
      goal: {
        feature: 'A migration reaches coherent completion',
        invariants: ['Unrelated behavior remains true'],
        acceptanceScenarios: [
          {
            name: 'Legacy behavior is retired',
            given: ['A legacy path exists'],
            when: ['The migration completes'],
            then: ['The old path no longer remains reachable'],
          },
        ],
        authorization: {
          kind: 'repository-delegation' as const,
          principal: 'repository-owner',
          source: 'user-request',
        },
      },
      change: {
        idempotencyKey: 'migration',
        title: 'Migration',
        intendedOutcome: 'Retire the legacy path',
      },
    };
    writeFileSync(join(root, 'plan.md'), `# Plan\n\n\`\`\`scip-query-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);

    const result = applyPlanContract(root, 'plan.md', {
      collaborationDomainId: DOMAIN,
      toolVersion: '0.20.0',
      now: () => '2026-08-01T12:00:00.000Z',
      captureObservation: () => receipt(),
    });

    expect(result.goal).toMatchObject({ publication: 'created', record: { gherkin: { language: 'gherkin' } } });
    expect(result.change).toMatchObject({
      publication: 'created',
      record: { goalId: result.goal?.record.goalId },
    });
    expect(result.plan.record).toMatchObject({
      goalId: result.goal?.record.goalId,
      changeId: result.change?.record.changeId,
    });
    expect(readGoalRecords(root).records).toHaveLength(1);
    expect(readIntendedChangeRecords(root).records).toHaveLength(1);
  });

  it('continues existing work from compact input without creating duplicate work records', () => {
    const state = repository();
    const plan = {
      schemaVersion: 1,
      form: 'compact',
      goalId: state.goalId,
      changeId: state.changeId,
      class: 'relational',
      seeds: [{ id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry' }],
      preserve: [{ condition: 'Preserve other outcomes', evidence: ['tests'] }],
      evidence: { tests: 'Run focused tests' },
    };
    writeFileSync(state.planPath, `# Plan\n\n\`\`\`scip-query-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);

    const result = applyPlanContract(state.root, 'plan.md', {
      collaborationDomainId: DOMAIN,
      toolVersion: '0.20.0',
      now: () => '2026-08-01T12:00:00.000Z',
      captureObservation: () => receipt(),
    });

    expect(result.goal).toBeUndefined();
    expect(result.change).toBeUndefined();
    expect(result.plan.record).toMatchObject({ goalId: state.goalId, changeId: state.changeId });
    expect(readGoalRecords(state.root).records).toHaveLength(1);
    expect(readIntendedChangeRecords(state.root).records).toHaveLength(1);
  });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'scip-plan-compiler-'));
  roots.push(root);
  const options = { toolVersion: '0.20.0', now: () => '2026-08-01T12:00:00.000Z' };
  const goal = createGoalRecordFile(
    root,
    DOMAIN,
    {
      feature: 'A migration reaches coherent completion',
      invariants: ['Unrelated behavior remains true'],
      acceptanceScenarios: [
        {
          name: 'Legacy behavior is retired',
          given: ['A legacy path exists'],
          when: ['The migration completes'],
          then: ['The old path no longer remains reachable'],
        },
      ],
      authorization: { kind: 'repository-delegation', principal: 'repository-owner', source: 'test' },
    },
    options,
  ).record;
  const change = createIntendedChangeRecordFile(
    root,
    DOMAIN,
    {
      goalId: goal.goalId,
      idempotencyKey: 'migration',
      title: 'Migration',
      intendedOutcome: 'Retire the legacy path',
    },
    options,
  ).record;
  return { root, planPath: join(root, 'plan.md'), goalId: goal.goalId, changeId: change.changeId };
}

function contract(goalId: string, changeId: string): PlanContractRequest {
  return {
    schemaVersion: 1,
    goalId,
    changeId,
    workflowClass: 'relational',
    affectedSeeds: [{ id: 'entry', kind: 'symbol', referent: 'queueDelivery', role: 'entry' }],
    preserve: [{ id: 'outcomes', condition: 'Preserve other outcomes', evidenceIds: ['tests'] }],
    retirements: [
      {
        id: 'legacy',
        kind: 'identity',
        referent: 'legacyRetry',
        responsibility: 'fixed delay',
        condition: 'Remove the legacy retry identity',
        evidenceIds: ['search'],
      },
    ],
    allowedSurvivors: [],
    reuseAuthorities: [],
    architecture: [
      {
        id: 'owner',
        predicate: 'configured-policy-clean',
        condition: 'Keep the configured architecture policy clean',
        evidenceIds: ['architecture'],
      },
    ],
    completionEvidence: [
      { id: 'tests', description: 'Run tests' },
      { id: 'search', description: 'Search retirement closure' },
      { id: 'architecture', description: 'Run architecture gate' },
    ],
    slices: [],
  };
}

function receipt(): ObservationReceiptV2 {
  const content = createObservationIdentity('repository-content', 1, 'pre-edit');
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
