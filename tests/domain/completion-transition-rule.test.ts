import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMPLETION_PREDICATES } from '../../src/domain/autonomous-completion.js';
import {
  createCompletionTransitionRuleRecord,
  decodeCompletionTransitionRuleRecord,
  evaluateCompletionTransitionRule,
  transitionRuleAuthorizedReferents,
  type CompletionTransitionRuleRequest,
} from '../../src/domain/completion-transition-rule.js';
import { createGoalRecord } from '../../src/domain/autonomous-work-state.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CREATED_AT = '2026-07-30T12:00:00.000Z';

describe('completion transition rules', () => {
  it('binds an exact semantic successor and evidence contract to one predecessor', () => {
    const predecessor = predecessorGoal();
    const rule = createCompletionTransitionRuleRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      predecessorGoal: predecessor,
      request: ruleRequest(predecessor.goalId),
      createdAt: CREATED_AT,
      toolVersion: '0.20.0',
    });

    expect(rule.transitionRuleId).toMatch(/^SQTR-[A-F0-9]{32}$/u);
    expect(rule.successorGoal.predecessorGoalId).toBe(predecessor.goalId);
    expect(rule.successorChange.goalId).toBe(rule.successorGoal.goalId);
    expect(rule.permittedGoalFields).toEqual(['feature', 'acceptance-scenarios']);
    expect(rule.preservedInvariants).toEqual(predecessor.gherkin.invariants);
    expect(decodeCompletionTransitionRuleRecord(rule)).toEqual({ state: 'current', record: rule });
    expect(transitionRuleAuthorizedReferents(rule)).toEqual({
      goal: `transition-rule:${rule.transitionRuleId}#goal`,
    });
  });

  it('rejects a permission list that does not exactly describe the successor change', () => {
    const predecessor = predecessorGoal();
    const request = ruleRequest(predecessor.goalId);
    request.permittedGoalFields = ['feature'];

    expect(() =>
      createCompletionTransitionRuleRecord({
        collaborationDomainId: COLLABORATION_DOMAIN,
        predecessorGoal: predecessor,
        request,
        createdAt: CREATED_AT,
        toolVersion: '0.20.0',
      }),
    ).toThrow(/must name exactly the changed goal fields/u);
  });

  it('requires every named evidence qualification before a successor is applicable', () => {
    const predecessor = predecessorGoal();
    const rule = createCompletionTransitionRuleRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      predecessorGoal: predecessor,
      request: ruleRequest(predecessor.goalId),
      createdAt: CREATED_AT,
      toolVersion: '0.20.0',
    });
    const target = receipt();
    const predicates = COMPLETION_PREDICATES.map((predicate) => ({
      predicate,
      state: predicate === 'goal-fulfilled' ? ('unknown' as const) : ('established' as const),
      reasons: ['fixed evidence'],
      evidenceReceipts: [target],
    }));

    expect(evaluateCompletionTransitionRule(rule, { goalId: predecessor.goalId, predicates }, new Map())).toEqual({
      state: 'unsatisfied',
      reasons: ['goal-fulfilled is not established'],
    });
  });

  it('keeps packaged request and record discriminators aligned with runtime version 1', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const request = JSON.parse(
      readFileSync(join(schemas, 'completion-transition-rule-request.schema.json'), 'utf8'),
    ) as {
      required: string[];
      additionalProperties: boolean;
    };
    const record = JSON.parse(readFileSync(join(schemas, 'completion-transition-rule-record.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };

    expect(request.required).toEqual(
      expect.arrayContaining([
        'predecessorGoalId',
        'successorGoal',
        'successorChange',
        'permittedGoalFields',
        'requiredEvidence',
      ]),
    );
    expect(request.additionalProperties).toBe(false);
    expect(record.properties['kind']?.const).toBe('scip-query-completion-transition-rule');
    expect(record.properties['schemaVersion']?.const).toBe(1);
    expect(record.required).toEqual(
      expect.arrayContaining([
        'transitionRuleId',
        'predecessorGoal',
        'successorGoal',
        'successorChangeRequest',
        'successorChange',
      ]),
    );
    expect(record.additionalProperties).toBe(false);
  });
});

function predecessorGoal() {
  return createGoalRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      feature: 'Agents finish one protected repository goal',
      invariants: ['Unknown completion evidence remains blocking'],
      acceptanceScenarios: [
        {
          name: 'Original completion',
          given: ['one intended change'],
          when: ['all protected predicates are established'],
          then: ['the change reaches completion'],
        },
      ],
      authorization: {
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'test-fixture',
      },
    },
    createdAt: CREATED_AT,
    toolVersion: '0.20.0',
  });
}

function ruleRequest(predecessorGoalId: string): CompletionTransitionRuleRequest {
  return {
    predecessorGoalId,
    successorGoal: {
      feature: 'Agents finish one protected repository goal and continue autonomously',
      invariants: ['Unknown completion evidence remains blocking'],
      acceptanceScenarios: [
        {
          name: 'Autonomous successor',
          given: ['one completed predecessor'],
          when: ['a fixed transition rule qualifies the evidence'],
          then: ['the successor becomes active without a human prompt'],
        },
      ],
      authorization: {
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'test-fixture',
      },
    },
    successorChange: {
      idempotencyKey: 'successor-change',
      title: 'Continue under the successor goal',
      intendedOutcome: 'The exact successor goal governs the next autonomous change',
    },
    permittedGoalFields: ['feature', 'acceptance-scenarios'],
    preservedInvariants: ['Unknown completion evidence remains blocking'],
    artifactTransitions: [],
    requiredEvidence: COMPLETION_PREDICATES.map((predicate) => ({
      predicate,
      minimumReceipts: 1,
      requiredSources: ['repository-snapshot'],
    })),
  };
}

function receipt(): ObservationReceiptV2 {
  const content = createObservationIdentity('scip-query:repository-content', 1, 'transition-target');
  return {
    schemaVersion: 2,
    observedAt: CREATED_AT,
    facts: {
      collaborationDomain: createObservationIdentity('scip-query:collaboration-domain', 1, COLLABORATION_DOMAIN),
      wholeContent: content,
    },
    observedSources: [{ kind: 'repository-snapshot', identity: content }],
    stabilityProofs: [{ source: 'repository-snapshot', kind: 'fixed-snapshot' }],
  };
}
