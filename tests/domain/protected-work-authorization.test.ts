import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PROTECTED_WORK_AUTHORIZATION_KIND,
  PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION,
  createProtectedWorkAuthorization,
  decodeProtectedWorkAuthorization,
  decodeProtectedWorkAuthorizationRequest,
  type ProtectedWorkAuthorizationRequest,
} from '../../src/domain/protected-work-authorization.js';

const COLLABORATION_DOMAIN = '123e4567-e89b-42d3-a456-426614174000';

describe('protected work authorization', () => {
  it('fixes one exact goal, change, prompt, and protected artifact transition', () => {
    const record = createAuthorization();

    expect(record.authorizationId).toMatch(/^SQWA-[A-F0-9]{32}$/u);
    expect(record.goal.authorization).toEqual({
      kind: 'repository-delegation',
      principal: 'repository-owner',
      source: `protected-work-intent:${record.intentDigest}`,
    });
    expect(record.change.goalId).toBe(record.goal.goalId);
    expect(decodeProtectedWorkAuthorization(record)).toEqual({ state: 'current', record });
  });

  it('rejects candidate edits to the embedded goal, change, or grant', () => {
    const record = createAuthorization();
    const changedGoal = {
      ...record,
      goal: {
        ...record.goal,
        authorization: { ...record.goal.authorization, source: 'candidate-assertion' },
      },
    };
    const changedTransition = {
      ...record,
      artifactTransitions: [
        {
          ...record.artifactTransitions[0]!,
          successorDigest: digest('weaker configuration'),
        },
      ],
    };

    expect(decodeProtectedWorkAuthorization(changedGoal)).toMatchObject({ state: 'malformed' });
    expect(decodeProtectedWorkAuthorization(changedTransition)).toMatchObject({ state: 'malformed' });
  });

  it('makes different external prompts produce different protected identities', () => {
    const first = createAuthorization();
    const second = createProtectedWorkAuthorization({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: { ...request(), promptSha256: digest('another explicit user request') },
      createdAt: '2026-07-31T12:00:00.000Z',
      toolVersion: '0.20.0',
    });

    expect(second.intentDigest).not.toBe(first.intentDigest);
    expect(second.authorizationId).not.toBe(first.authorizationId);
  });

  it('requires canonical exact artifact transitions', () => {
    const decoded = decodeProtectedWorkAuthorizationRequest({
      ...request(),
      artifactTransitions: [
        {
          class: 'configuration',
          path: '.scipquery.json',
          predecessorDigest: digest('before'),
          successorDigest: digest('after'),
        },
        {
          class: 'baseline',
          path: '.scipquery-baseline.json',
          predecessorDigest: digest('old baseline'),
          successorDigest: digest('new baseline'),
        },
      ],
    });

    expect(decoded).toEqual({ ok: false, error: 'artifactTransitions must be canonically ordered' });
  });

  it('publishes request and record schemas aligned with the runtime boundary', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const requestSchema = JSON.parse(
      readFileSync(join(schemas, 'protected-work-authorization-request.schema.json'), 'utf8'),
    ) as { required: string[]; additionalProperties: boolean };
    const recordSchema = JSON.parse(
      readFileSync(join(schemas, 'protected-work-authorization-record.schema.json'), 'utf8'),
    ) as {
      required: string[];
      properties: Record<string, { const?: unknown; $ref?: string }>;
      additionalProperties: boolean;
    };

    expect(requestSchema.required).toEqual(
      expect.arrayContaining(['principal', 'promptSha256', 'goal', 'change', 'artifactTransitions']),
    );
    expect(requestSchema.additionalProperties).toBe(false);
    expect(recordSchema.properties['kind']?.const).toBe(PROTECTED_WORK_AUTHORIZATION_KIND);
    expect(recordSchema.properties['schemaVersion']?.const).toBe(PROTECTED_WORK_AUTHORIZATION_SCHEMA_VERSION);
    expect(recordSchema.properties['goal']?.$ref).toBe('./goal-record.schema.json');
    expect(recordSchema.properties['change']?.$ref).toBe('./intended-change-record.schema.json');
    expect(recordSchema.required).toEqual(
      expect.arrayContaining(['authorizationId', 'intentDigest', 'goal', 'change', 'artifactTransitions']),
    );
    expect(recordSchema.additionalProperties).toBe(false);
  });
});

function createAuthorization() {
  return createProtectedWorkAuthorization({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: request(),
    createdAt: '2026-07-31T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
}

function request(): ProtectedWorkAuthorizationRequest {
  return {
    principal: 'repository-owner',
    promptSha256: digest('explicit user request'),
    goal: {
      feature: 'Policy-driven alert delivery is complete',
      invariants: ['The candidate cannot weaken its own completion standard'],
      acceptanceScenarios: [
        {
          name: 'all delivery paths use policy',
          given: ['the legacy router is present'],
          when: ['the authorized overhaul completes'],
          then: ['all delivery paths use the domain policy'],
        },
      ],
    },
    change: {
      idempotencyKey: 'policy-routing-overhaul',
      title: 'Policy routing overhaul',
      intendedOutcome: 'Replace legacy severity routing without residue',
    },
    artifactTransitions: [
      {
        class: 'configuration',
        path: '.scipquery.json',
        predecessorDigest: digest('before'),
        successorDigest: digest('after'),
      },
    ],
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
