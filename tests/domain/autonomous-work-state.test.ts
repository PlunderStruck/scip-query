import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GOAL_RECORD_KIND,
  GOAL_RECORD_SCHEMA_VERSION,
  INTENDED_CHANGE_RECORD_KIND,
  INTENDED_CHANGE_RECORD_SCHEMA_VERSION,
  createGoalRecord,
  createIntendedChangeRecord,
  decodeGoalCreateRequest,
  decodeGoalRecord,
  decodeIntendedChangeRecord,
  goalRequestMatchesRecord,
  intendedChangeRequestMatchesRecord,
  renderGoalGherkin,
  type GoalCreateRequest,
} from '../../src/domain/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const CREATED_AT = '2026-07-30T12:00:00.000Z';

describe('autonomous work-state domain records', () => {
  it('gives formatting-equivalent Gherkin one clone-independent goal identity', () => {
    const first = goalRecord(goalRequest());
    const reformatted = goalRecord({
      ...goalRequest(),
      feature: '  An agent   completes repository work  ',
      invariants: ['  Completion retains   every live obligation '],
      acceptanceScenarios: [
        {
          name: '  Work resumes ',
          given: [' an interrupted   attempt '],
          when: [' another process resumes '],
          then: [' the same goal remains current '],
        },
      ],
    });

    expect(reformatted.goalId).toBe(first.goalId);
    expect(reformatted.semanticIdentity).toEqual(first.semanticIdentity);
    expect(reformatted.gherkin).toEqual(first.gherkin);
  });

  it('creates a successor identity for semantic revision without overwriting its predecessor', () => {
    const predecessor = goalRecord(goalRequest());
    const successor = goalRecord({
      ...goalRequest(),
      feature: 'An agent completes repository work without routine human intervention',
      predecessorGoalId: predecessor.goalId,
    });

    expect(successor.goalId).not.toBe(predecessor.goalId);
    expect(successor.predecessorGoalId).toBe(predecessor.goalId);
    expect(decodeGoalRecord(predecessor)).toEqual({ state: 'current', record: predecessor });
    expect(decodeGoalRecord(successor)).toEqual({ state: 'current', record: successor });
  });

  it('keeps timestamps and writer versions outside semantic goal identity while detecting metadata collision', () => {
    const request = goalRequest();
    const first = goalRecord(request);
    const later = createGoalRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request,
      createdAt: '2026-07-31T12:00:00.000Z',
      toolVersion: '99.0.0',
    });

    expect(later.goalId).toBe(first.goalId);
    expect(goalRequestMatchesRecord(COLLABORATION_DOMAIN, request, first)).toBe(true);
    expect(
      goalRequestMatchesRecord(
        COLLABORATION_DOMAIN,
        {
          ...request,
          authorization: { ...request.authorization, source: 'different-delegation' },
        },
        first,
      ),
    ).toBe(false);
  });

  it('derives an opaque retry-stable change identity and binds its request meaning independently', () => {
    const goal = goalRecord(goalRequest());
    const request = {
      goalId: goal.goalId,
      idempotencyKey: 'agent-change-1',
      title: '  Durable work state ',
      intendedOutcome: ' Goal and attempts survive interruption ',
    };
    const first = createIntendedChangeRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request,
      createdAt: CREATED_AT,
      toolVersion: '0.20.0',
    });
    const retry = createIntendedChangeRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request,
      createdAt: '2026-07-31T12:00:00.000Z',
      toolVersion: '99.0.0',
    });
    const collision = createIntendedChangeRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: { ...request, title: 'Different work' },
      createdAt: CREATED_AT,
      toolVersion: '0.20.0',
    });

    expect(first.changeId).toMatch(/^SQC-[A-F0-9]{32}$/u);
    expect(retry.changeId).toBe(first.changeId);
    expect(collision.changeId).toBe(first.changeId);
    expect(collision.idempotency.requestDigest).not.toBe(first.idempotency.requestDigest);
    expect(intendedChangeRequestMatchesRecord(COLLABORATION_DOMAIN, request, first)).toBe(true);
    expect(
      intendedChangeRequestMatchesRecord(COLLABORATION_DOMAIN, { ...request, title: 'Different work' }, first),
    ).toBe(false);
    expect(decodeIntendedChangeRecord(first)).toEqual({ state: 'current', record: first });
  });

  it('classifies malformed, older, and future records without casting them current', () => {
    const goal = goalRecord(goalRequest());

    expect(decodeGoalRecord({ ...goal, schemaVersion: 0 })).toEqual(
      expect.objectContaining({ state: 'unsupported-older' }),
    );
    expect(decodeGoalRecord({ ...goal, schemaVersion: 2 })).toEqual(
      expect.objectContaining({ state: 'unsupported-future' }),
    );
    expect(decodeGoalRecord({ ...goal, schemaVersion: 1, goalId: 'SQG-INVALID' })).toEqual(
      expect.objectContaining({ state: 'malformed' }),
    );
    expect(
      decodeIntendedChangeRecord({
        ...createIntendedChangeRecord({
          collaborationDomainId: COLLABORATION_DOMAIN,
          request: {
            goalId: goal.goalId,
            idempotencyKey: 'change',
            title: 'Work',
            intendedOutcome: 'Outcome',
          },
          createdAt: CREATED_AT,
          toolVersion: '0.20.0',
        }),
        schemaVersion: 0,
      }),
    ).toEqual(expect.objectContaining({ state: 'unsupported-older' }));
  });

  it('renders concise structured Gherkin and rejects empty acceptance meaning', () => {
    const goal = goalRecord(goalRequest());
    expect(renderGoalGherkin(goal.gherkin)).toBe(
      [
        'Feature: An agent completes repository work',
        '',
        '  Rule: Completion retains every live obligation',
        '',
        '  Scenario: Work resumes',
        '    Given an interrupted attempt',
        '    When another process resumes',
        '    Then the same goal remains current',
        '',
      ].join('\n'),
    );
    expect(decodeGoalCreateRequest({ ...goalRequest(), acceptanceScenarios: [] })).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it('keeps the packaged JSON Schemas aligned with runtime discriminators and request boundaries', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const goal = JSON.parse(readFileSync(join(schemas, 'goal-record.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, { const?: unknown; $ref?: unknown }>;
      additionalProperties: boolean;
    };
    const change = JSON.parse(readFileSync(join(schemas, 'intended-change-record.schema.json'), 'utf8')) as {
      required: string[];
      properties: Record<string, { const?: unknown; $ref?: unknown }>;
      additionalProperties: boolean;
    };
    const goalRequestSchema = JSON.parse(readFileSync(join(schemas, 'goal-create-request.schema.json'), 'utf8')) as {
      required: string[];
      additionalProperties: boolean;
    };
    const changeRequestSchema = JSON.parse(
      readFileSync(join(schemas, 'intended-change-create-request.schema.json'), 'utf8'),
    ) as { required: string[]; additionalProperties: boolean };

    expect(goal.properties['kind']?.const).toBe(GOAL_RECORD_KIND);
    expect(goal.properties['schemaVersion']?.const).toBe(GOAL_RECORD_SCHEMA_VERSION);
    expect(goal.required).toEqual(expect.arrayContaining(['goalId', 'gherkin', 'semanticIdentity', 'authorization']));
    expect(goal.additionalProperties).toBe(false);
    expect(change.properties['kind']?.const).toBe(INTENDED_CHANGE_RECORD_KIND);
    expect(change.properties['schemaVersion']?.const).toBe(INTENDED_CHANGE_RECORD_SCHEMA_VERSION);
    expect(change.required).toEqual(expect.arrayContaining(['changeId', 'goalId', 'idempotency']));
    expect(change.additionalProperties).toBe(false);
    expect(goalRequestSchema.required).toEqual(
      expect.arrayContaining(['feature', 'invariants', 'acceptanceScenarios', 'authorization']),
    );
    expect(goalRequestSchema.additionalProperties).toBe(false);
    expect(changeRequestSchema.required).toEqual(
      expect.arrayContaining(['goalId', 'idempotencyKey', 'title', 'intendedOutcome']),
    );
    expect(changeRequestSchema.additionalProperties).toBe(false);
  });
});

function goalRecord(request: GoalCreateRequest) {
  return createGoalRecord({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request,
    createdAt: CREATED_AT,
    toolVersion: '0.20.0',
  });
}

function goalRequest(): GoalCreateRequest {
  return {
    feature: 'An agent completes repository work',
    invariants: ['Completion retains every live obligation'],
    acceptanceScenarios: [
      {
        name: 'Work resumes',
        given: ['an interrupted attempt'],
        when: ['another process resumes'],
        then: ['the same goal remains current'],
      },
    ],
    authorization: {
      kind: 'repository-delegation',
      principal: 'repository-owner',
      source: 'codex-task',
    },
  };
}
