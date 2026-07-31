import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProtectedWorkAuthorization } from '../../src/domain/protected-work-authorization.js';
import {
  PROTECTED_WORK_AUTHORIZATION_ID_ENV,
  PROTECTED_WORK_AUTHORIZATION_ROOT_ENV,
  activateConfiguredProtectedWorkAuthorization,
  assertFixedProtectedWorkAuthorization,
  readConfiguredProtectedWorkAuthorization,
} from '../../src/runtime/protected-work-authorization-controller.js';
import {
  createGoalRecordFile,
  readGoalRecordFile,
  readIntendedChangeRecordFile,
} from '../../src/storage/autonomous-work-state.js';
import {
  protectedWorkAuthorizationPath,
  writeProtectedWorkAuthorization,
} from '../../src/storage/protected-work-authorization.js';

const COLLABORATION_DOMAIN = '123e4567-e89b-42d3-a456-426614174000';
const PROMPT = 'Implement the authorized routing change';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('protected work authorization controller', () => {
  it('activates a matching prompt once and lets later prompts reuse only the same exact records', () => {
    const fixture = authorizationFixture();

    const activated = activateConfiguredProtectedWorkAuthorization({
      projectRoot: fixture.candidateRoot,
      collaborationDomainId: COLLABORATION_DOMAIN,
      prompt: PROMPT,
      environment: fixture.environment,
    });
    const replay = activateConfiguredProtectedWorkAuthorization({
      projectRoot: fixture.candidateRoot,
      collaborationDomainId: COLLABORATION_DOMAIN,
      prompt: 'continue',
      environment: fixture.environment,
    });

    expect(activated?.publication).toBe('activated');
    expect(replay?.publication).toBe('existing');
    expect(readGoalRecordFile(fixture.candidateRoot, fixture.authorization.goal.goalId)).toMatchObject({
      state: 'current',
      record: fixture.authorization.goal,
    });
    expect(readIntendedChangeRecordFile(fixture.candidateRoot, fixture.authorization.change.changeId)).toMatchObject({
      state: 'current',
      record: fixture.authorization.change,
    });
  });

  it('rejects a substituted prompt before publishing either work record', () => {
    const fixture = authorizationFixture();

    expect(() =>
      activateConfiguredProtectedWorkAuthorization({
        projectRoot: fixture.candidateRoot,
        collaborationDomainId: COLLABORATION_DOMAIN,
        prompt: 'broaden the task',
        environment: fixture.environment,
      }),
    ).toThrow('prompt does not match');
    expect(readGoalRecordFile(fixture.candidateRoot, fixture.authorization.goal.goalId).state).toBe('missing');
    expect(readIntendedChangeRecordFile(fixture.candidateRoot, fixture.authorization.change.changeId).state).toBe(
      'missing',
    );
  });

  it('recovers an exact partial activation but rejects a wrong prompt for that recovery', () => {
    const fixture = authorizationFixture();
    createGoalRecordFile(
      fixture.candidateRoot,
      COLLABORATION_DOMAIN,
      {
        feature: fixture.authorization.goal.gherkin.feature,
        invariants: fixture.authorization.goal.gherkin.invariants,
        acceptanceScenarios: fixture.authorization.goal.gherkin.acceptanceScenarios,
        authorization: fixture.authorization.goal.authorization,
      },
      {
        toolVersion: fixture.authorization.goal.writer.version,
        now: () => fixture.authorization.goal.createdAt,
      },
    );

    expect(() =>
      activateConfiguredProtectedWorkAuthorization({
        projectRoot: fixture.candidateRoot,
        collaborationDomainId: COLLABORATION_DOMAIN,
        prompt: 'continue',
        environment: fixture.environment,
      }),
    ).toThrow('prompt does not match');
    expect(
      activateConfiguredProtectedWorkAuthorization({
        projectRoot: fixture.candidateRoot,
        collaborationDomainId: COLLABORATION_DOMAIN,
        prompt: PROMPT,
        environment: fixture.environment,
      })?.publication,
    ).toBe('activated');
  });

  it('invalidates a lease when the external source bytes move', () => {
    const fixture = authorizationFixture();
    const lease = readConfiguredProtectedWorkAuthorization(
      fixture.candidateRoot,
      COLLABORATION_DOMAIN,
      fixture.environment,
    )!;
    writeFileSync(
      protectedWorkAuthorizationPath(fixture.protectedRoot, fixture.authorization.authorizationId),
      `${JSON.stringify(fixture.authorization)}\n\n`,
    );

    expect(() => assertFixedProtectedWorkAuthorization(lease)).toThrow('changed while completion was being evaluated');
  });

  it('requires one complete absolute host configuration and the matching collaboration domain', () => {
    const fixture = authorizationFixture();
    expect(() =>
      readConfiguredProtectedWorkAuthorization(fixture.candidateRoot, COLLABORATION_DOMAIN, {
        [PROTECTED_WORK_AUTHORIZATION_ID_ENV]: fixture.authorization.authorizationId,
      }),
    ).toThrow('must be configured together');
    expect(() =>
      readConfiguredProtectedWorkAuthorization(fixture.candidateRoot, COLLABORATION_DOMAIN, {
        ...fixture.environment,
        [PROTECTED_WORK_AUTHORIZATION_ROOT_ENV]: 'relative/protected',
      }),
    ).toThrow('must be an absolute path');
    expect(() =>
      readConfiguredProtectedWorkAuthorization(
        fixture.candidateRoot,
        '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
        fixture.environment,
      ),
    ).toThrow('belongs to collaboration domain');
  });
});

function authorizationFixture() {
  const candidateRoot = temporary('candidate-');
  const protectedRoot = temporary('protected-');
  const authorization = createProtectedWorkAuthorization({
    collaborationDomainId: COLLABORATION_DOMAIN,
    request: {
      principal: 'repository-owner',
      promptSha256: digest(PROMPT),
      goal: {
        feature: 'Authorized routing behavior is complete',
        invariants: ['The candidate cannot broaden the protected intent'],
        acceptanceScenarios: [
          {
            name: 'matching request',
            given: ['one protected execution envelope'],
            when: ['the matching prompt reaches the coding agent'],
            then: ['the exact goal and intended change are activated'],
          },
        ],
      },
      change: {
        idempotencyKey: 'authorized-routing-change',
        title: 'Implement authorized routing',
        intendedOutcome: 'Only the fixed routing behavior is introduced',
      },
      artifactTransitions: [],
    },
    createdAt: '2026-07-31T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
  writeProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization);
  return {
    candidateRoot,
    protectedRoot,
    authorization,
    environment: {
      [PROTECTED_WORK_AUTHORIZATION_ROOT_ENV]: protectedRoot,
      [PROTECTED_WORK_AUTHORIZATION_ID_ENV]: authorization.authorizationId,
    },
  };
}

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `scip-query-${prefix}`));
  roots.push(root);
  return root;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
