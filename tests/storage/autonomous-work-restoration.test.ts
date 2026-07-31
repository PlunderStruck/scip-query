import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createObligationAdmissionFile } from '../../src/storage/autonomous-work-obligations.js';
import { readAutonomousRestorationProjection } from '../../src/storage/autonomous-work-restoration.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const TOOL_VERSION = '0.20.0';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('autonomous work restoration storage', () => {
  it('projects committed work records and fails closed when a collection omits an unreadable candidate', () => {
    const root = fixture();
    const goal = createGoalRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        feature: 'An agent resumes work without a transcript',
        invariants: ['Committed obligations remain visible'],
        acceptanceScenarios: [
          {
            name: 'Fresh process',
            given: ['a prior process committed work state'],
            when: ['another process starts'],
            then: ['the current work state is reconstructed'],
          },
        ],
        authorization: {
          kind: 'repository-delegation',
          principal: 'repository-owner',
          source: 'test',
        },
      },
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:00:00.000Z' },
    ).record;
    const change = createIntendedChangeRecordFile(
      root,
      COLLABORATION_DOMAIN,
      {
        goalId: goal.goalId,
        idempotencyKey: 'restore',
        title: 'Restore committed work',
        intendedOutcome: 'Session start recovers the live repository objective',
      },
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:01:00.000Z' },
    ).record;
    const obligation = createObligationAdmissionFile(
      root,
      COLLABORATION_DOMAIN,
      {
        changeId: change.changeId,
        idempotencyKey: 'verification',
        category: 'verification',
        title: 'Verify fresh-process restoration',
        requiredCondition: 'The session-start hook reports this live obligation',
        source: { kind: 'agent-discovery', referent: 'storage restoration test' },
        basisAttemptIds: [],
        evidenceReceipts: [],
      },
      { toolVersion: TOOL_VERSION, now: () => '2026-07-30T12:02:00.000Z' },
    ).record;

    const current = readAutonomousRestorationProjection(root);
    expect(current.safeToContinue).toBe(true);
    expect(current.changes[0]?.liveObligations[0]?.obligationId).toBe(obligation.obligationId);

    const attempts = join(root, '.scipquery', 'attempts');
    mkdirSync(attempts, { recursive: true });
    writeFileSync(join(attempts, 'SQA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json'), '{bad json\n');
    const incomplete = readAutonomousRestorationProjection(root);

    expect(incomplete.safeToContinue).toBe(false);
    expect(incomplete.issues).toEqual([
      expect.stringContaining(
        'attempt record .scipquery/attempts/SQA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json is malformed',
      ),
    ]);
    expect(incomplete.changes[0]?.liveObligations[0]?.obligationId).toBe(obligation.obligationId);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-restoration-'));
  roots.push(root);
  return root;
}
