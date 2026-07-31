import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION,
  completionCommandRegistry,
  completionProtectedArtifactSet,
  createCompletionContextSnapshotRecord,
  decodeCompletionContextSnapshotRecord,
  type CompletionContextSnapshotRequest,
} from '../../src/domain/autonomous-completion-context.js';
import { createGoalRecord, createIntendedChangeRecord } from '../../src/domain/autonomous-work-state.js';
import { createObservationIdentity, type ObservationReceiptV2 } from '../../src/domain/observation-receipt.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CREATED_AT = '2026-07-30T12:00:00.000Z';

describe('autonomous completion context domain', () => {
  it('fixes goal, policy, evaluator, registry, protected classes, and target in one deterministic identity', () => {
    const request = contextRequest();
    const first = contextRecord(request);
    const replay = contextRecord(request, '2026-07-31T12:00:00.000Z');

    expect(first.contextSnapshotId).toMatch(/^SQCX-[A-F0-9]{32}$/u);
    expect(replay.contextSnapshotId).toBe(first.contextSnapshotId);
    expect(first.goalRecordDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.commandRegistry.entries).toEqual(['diff-gate:architecture', 'diff-gate:new-dead']);
    expect(first.protectedArtifacts.rules.map((rule) => rule.class)).toEqual([
      'goal',
      'transition-rule',
      'evaluator',
      'test',
      'baseline',
      'suppression',
      'configuration',
    ]);
    expect(decodeCompletionContextSnapshotRecord(first)).toEqual({ state: 'current', record: first });
  });

  it('rejects a future schema and an identity that no longer matches its fixed target', () => {
    const record = contextRecord(contextRequest());

    expect(
      decodeCompletionContextSnapshotRecord({
        ...record,
        schemaVersion: COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION + 1,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-future' }));
    expect(
      decodeCompletionContextSnapshotRecord({
        ...record,
        targetObservation: receipt('another-target'),
      }),
    ).toEqual(
      expect.objectContaining({
        state: 'malformed',
        error: 'contextSnapshotId does not match completion-context meaning',
      }),
    );
  });

  it('keeps the packaged schema discriminator and required context inputs aligned', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'completion-context-record.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown }>;
      additionalProperties: boolean;
    };

    expect(schema.properties['kind']?.const).toBe('scip-query-completion-context');
    expect(schema.properties['schemaVersion']?.const).toBe(COMPLETION_CONTEXT_RECORD_SCHEMA_VERSION);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'contextSnapshotId',
        'goalRecordDigest',
        'policy',
        'evaluator',
        'commandRegistry',
        'protectedArtifacts',
        'targetObservation',
      ]),
    );
    expect(schema.additionalProperties).toBe(false);
  });
});

function contextRecord(request: CompletionContextSnapshotRequest, capturedAt = CREATED_AT) {
  return createCompletionContextSnapshotRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    capturedAt,
    toolVersion: '0.20.0',
  });
}

function contextRequest(): CompletionContextSnapshotRequest {
  const goal = createGoalRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    createdAt: CREATED_AT,
    toolVersion: '0.20.0',
    request: {
      feature: 'An agent can finish one protected repository change',
      invariants: ['Unknown evidence cannot become success'],
      acceptanceScenarios: [
        {
          name: 'Fixed judgment',
          given: ['one repository target'],
          when: ['the controller evaluates it'],
          then: ['later source changes cannot alter that judgment'],
        },
      ],
      authorization: {
        kind: 'repository-delegation',
        principal: 'repository-owner',
        source: 'codex-task',
      },
    },
  });
  const change = createIntendedChangeRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    createdAt: CREATED_AT,
    toolVersion: '0.20.0',
    request: {
      goalId: goal.goalId,
      idempotencyKey: 'completion-context-test',
      title: 'Bind completion inputs',
      intendedOutcome: 'One replayable judgment refers to one fixed set of inputs',
    },
  });
  return {
    goal,
    change,
    policy: {
      policyId: 'scip-query:test-policy',
      policyVersion: 1,
      stopMode: 'block',
      requiredPredicates: [
        'goal-fulfilled',
        'invariants-preserved',
        'evidence-compatible',
        'coverage-complete',
        'obligations-reconciled',
        'policy-permitted',
      ],
    },
    evaluator: {
      evaluatorId: 'scip-query:test-evaluator',
      evaluatorVersion: '0.20.0',
      buildIdentity: 'a'.repeat(64),
    },
    commandRegistry: completionCommandRegistry(['diff-gate:new-dead', 'diff-gate:architecture']),
    protectedArtifacts: completionProtectedArtifactSet([
      { class: 'configuration', selectors: ['.scipquery.json'], authority: 'fixed-predecessor' },
      { class: 'goal', selectors: ['.scipquery/goals/*.json'], authority: 'fixed-predecessor' },
      { class: 'transition-rule', selectors: ['.scipquery/transition-rules/*.json'], authority: 'fixed-predecessor' },
      { class: 'evaluator', selectors: ['src/evaluator.ts'], authority: 'bootstrap-trust-root' },
      { class: 'test', selectors: ['**/*.test.ts'], authority: 'fixed-predecessor' },
      { class: 'baseline', selectors: ['.scipquery-baseline.json'], authority: 'fixed-predecessor' },
      { class: 'suppression', selectors: ['.scipquery/suppressions/*.json'], authority: 'fixed-predecessor' },
    ]),
    targetObservation: receipt('target'),
  };
}

function receipt(identity: string): ObservationReceiptV2 {
  const content = createObservationIdentity('scip-query:repository-content', 1, identity);
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
