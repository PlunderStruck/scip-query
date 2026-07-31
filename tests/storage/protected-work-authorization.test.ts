import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createProtectedWorkAuthorization,
  type ProtectedWorkAuthorizationRequest,
} from '../../src/domain/protected-work-authorization.js';
import { readGoalRecordFile, readIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';
import {
  activateProtectedWorkAuthorization,
  protectedWorkAuthorizationPath,
  readProtectedWorkAuthorization,
  readProtectedWorkAuthorizations,
  writeProtectedWorkAuthorization,
} from '../../src/storage/protected-work-authorization.js';

const COLLABORATION_DOMAIN = '123e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('protected work authorization storage', () => {
  it('publishes outside the candidate and activates exact mergeable work records idempotently', () => {
    const candidateRoot = temporary('candidate-');
    const protectedRoot = temporary('protected-');
    const authorization = createAuthorization();

    const firstWrite = writeProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization);
    const retryWrite = writeProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization);
    const firstActivation = activateProtectedWorkAuthorization(candidateRoot, COLLABORATION_DOMAIN, authorization);
    const retryActivation = activateProtectedWorkAuthorization(candidateRoot, COLLABORATION_DOMAIN, authorization);

    expect(firstWrite.publication).toBe('created');
    expect(retryWrite.publication).toBe('existing');
    expect(firstActivation.goal.publication).toBe('created');
    expect(firstActivation.change.publication).toBe('created');
    expect(retryActivation.goal.publication).toBe('existing');
    expect(retryActivation.change.publication).toBe('existing');
    expect(readGoalRecordFile(candidateRoot, authorization.goal.goalId)).toMatchObject({
      state: 'current',
      record: authorization.goal,
    });
    expect(readIntendedChangeRecordFile(candidateRoot, authorization.change.changeId)).toMatchObject({
      state: 'current',
      record: authorization.change,
    });
    expect(readProtectedWorkAuthorizations(protectedRoot, candidateRoot)).toMatchObject({
      records: [{ authorizationId: authorization.authorizationId }],
      issues: [],
    });
  });

  it('rejects candidate-controlled roots, symlinked authorization directories, and symlinked records', () => {
    const candidateRoot = temporary('candidate-');
    const authorization = createAuthorization();

    expect(() =>
      writeProtectedWorkAuthorization(join(candidateRoot, 'protected'), candidateRoot, authorization),
    ).toThrow('outside the candidate-editable worktree');

    const disguisedRoot = join(temporary('links-'), 'protected');
    symlinkSync(join(candidateRoot, 'candidate-owned'), disguisedRoot);
    mkdirSync(join(candidateRoot, 'candidate-owned'));
    expect(() => writeProtectedWorkAuthorization(disguisedRoot, candidateRoot, authorization)).toThrow(
      'real non-symlink directory',
    );

    const directoryLinkRoot = temporary('directory-link-');
    symlinkSync(candidateRoot, join(directoryLinkRoot, 'work-authorizations'));
    expect(() => writeProtectedWorkAuthorization(directoryLinkRoot, candidateRoot, authorization)).toThrow(
      'authorization directory must be a real non-symlink directory',
    );

    const protectedRoot = temporary('protected-');
    const target = join(protectedRoot, 'target.json');
    writeFileSync(target, `${JSON.stringify(authorization)}\n`);
    const link = protectedWorkAuthorizationPath(protectedRoot, authorization.authorizationId);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);

    expect(readProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization.authorizationId)).toMatchObject({
      state: 'malformed',
      error: 'protected work authorization path must be a regular non-symlink file',
    });
  });

  it('refuses an immutable identity collision after protected bytes move', () => {
    const candidateRoot = temporary('candidate-');
    const protectedRoot = temporary('protected-');
    const authorization = createAuthorization();
    const publication = writeProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization);
    const changed = JSON.parse(readFileSync(publication.path, 'utf8')) as Record<string, unknown>;
    changed['principal'] = 'different-principal';
    writeFileSync(publication.path, `${JSON.stringify(changed)}\n`);

    expect(() => writeProtectedWorkAuthorization(protectedRoot, candidateRoot, authorization)).toThrow(
      'immutable protected work authorization collision',
    );
  });

  it('refuses to activate an authorization from another collaboration domain before writing records', () => {
    const candidateRoot = temporary('candidate-');
    const authorization = createAuthorization();

    expect(() =>
      activateProtectedWorkAuthorization(candidateRoot, '123e4567-e89b-42d3-a456-426614174001', authorization),
    ).toThrow('belongs to collaboration domain');
    expect(readGoalRecordFile(candidateRoot, authorization.goal.goalId).state).toBe('missing');
    expect(readIntendedChangeRecordFile(candidateRoot, authorization.change.changeId).state).toBe('missing');
  });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

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
      invariants: ['The completion standard remains external'],
      acceptanceScenarios: [
        {
          name: 'the repository reaches the requested outcome',
          given: ['an authorized request exists'],
          when: ['the work completes'],
          then: ['the protected evaluator accepts the repository'],
        },
      ],
    },
    change: {
      idempotencyKey: 'policy-routing-overhaul',
      title: 'Policy routing overhaul',
      intendedOutcome: 'Replace legacy severity routing without residue',
    },
    artifactTransitions: [],
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
