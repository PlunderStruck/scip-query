import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginAutomaticOperationCapture,
  completeAutomaticOperationCapture,
  materializeAutomaticOperationAttempts,
  readAutomaticOperationJournal,
} from '../../src/runtime/autonomous-operation-journal.js';
import { buildObservationReceipt } from '../../src/runtime/observation-receipt.js';
import { createGoalRecordFile, createIntendedChangeRecordFile } from '../../src/storage/autonomous-work-state.js';
import { readAttemptRecords } from '../../src/storage/autonomous-work-ledger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('automatic autonomous operation journal', () => {
  it('coalesces an equal successful read while preserving a distinct repository observation', () => {
    const { projectRoot, cacheDir } = fixture();
    const receipt = buildObservationReceipt({ projectRoot });
    const first = beginAutomaticOperationCapture({
      projectRoot,
      cacheDir,
      command: 'status',
      operationRole: 'repository-observation',
      argv: ['status', '--json', '--output-page-size', '12000'],
      preReceipt: receipt,
      operationId: 'first',
      now: '2026-07-31T10:00:00.000Z',
    });
    expect(first).toBeDefined();
    completeAutomaticOperationCapture({
      capture: first!,
      exitCode: 0,
      postReceipt: receipt,
      now: '2026-07-31T10:00:01.000Z',
    });

    const replay = beginAutomaticOperationCapture({
      projectRoot,
      cacheDir,
      command: 'status',
      operationRole: 'repository-observation',
      argv: ['status', '--result-only', '--output-cursor', 'transport-only'],
      preReceipt: receipt,
      operationId: 'replay',
      now: '2026-07-31T10:01:00.000Z',
    });
    completeAutomaticOperationCapture({
      capture: replay!,
      exitCode: 0,
      postReceipt: receipt,
      now: '2026-07-31T10:01:01.000Z',
    });

    expect(readAutomaticOperationJournal(cacheDir)).toHaveLength(1);
    expect(readAutomaticOperationJournal(cacheDir)[0]).toMatchObject({
      operationId: 'first',
      argv: ['status'],
      state: 'completed',
      exitCode: 0,
    });
  });

  it('materializes completed and interrupted operations into one active change without replay duplication', () => {
    const { projectRoot, cacheDir } = fixture();
    const { changeId } = activeChange(projectRoot);
    const receipt = buildObservationReceipt({ projectRoot });
    const completed = beginAutomaticOperationCapture({
      projectRoot,
      cacheDir,
      command: 'diff-gate',
      operationRole: 'repository-observation',
      argv: ['diff-gate'],
      preReceipt: receipt,
      operationId: 'completed-operation',
      now: '2026-07-31T10:00:00.000Z',
    });
    completeAutomaticOperationCapture({
      capture: completed!,
      exitCode: 1,
      postReceipt: receipt,
      error: 'blocking findings',
      now: '2026-07-31T10:00:01.000Z',
    });
    beginAutomaticOperationCapture({
      projectRoot,
      cacheDir,
      command: 'setup',
      operationRole: 'composite',
      argv: ['setup', '--yes'],
      preReceipt: receipt,
      operationId: 'interrupted-operation',
      now: '2026-07-31T10:01:00.000Z',
    });

    const first = materializeAutomaticOperationAttempts(projectRoot, cacheDir, '0.20.0');
    expect(first).toMatchObject({ pendingOperationCount: 2 });
    expect(first.skippedReason, JSON.stringify(first)).toBeUndefined();
    expect(first.createdAttemptIds).toHaveLength(2);
    const attempts = readAttemptRecords(projectRoot).records;
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          changeId,
          outcome: 'failed',
          action: expect.objectContaining({ family: 'scip-query:diff-gate', effectClass: 'read-only' }),
        }),
        expect.objectContaining({
          changeId,
          outcome: 'unknown',
          action: expect.objectContaining({ family: 'scip-query:setup', effectClass: 'non-idempotent-write' }),
        }),
      ]),
    );

    expect(materializeAutomaticOperationAttempts(projectRoot, cacheDir, '0.20.0')).toEqual({
      createdAttemptIds: [],
      reusedAttemptIds: [],
      pendingOperationCount: 0,
    });
  });
});

function fixture(): { projectRoot: string; cacheDir: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-operation-journal-'));
  roots.push(projectRoot);
  execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
  return { projectRoot, cacheDir: join(projectRoot, '.cache') };
}

function activeChange(projectRoot: string): { changeId: string } {
  const goal = createGoalRecordFile(
    projectRoot,
    '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
    {
      feature: 'Useful operations become durable work history',
      invariants: ['No metadata-entry command is required'],
      acceptanceScenarios: [
        {
          name: 'Automatic capture',
          given: ['one active intended change'],
          when: ['a useful operation completes'],
          then: ['its outcome is durably linked to the change'],
        },
      ],
      authorization: { kind: 'repository-delegation', principal: 'repository-owner', source: 'test' },
    },
    { toolVersion: '0.20.0' },
  ).record;
  return createIntendedChangeRecordFile(
    projectRoot,
    goal.collaborationDomainId,
    {
      goalId: goal.goalId,
      idempotencyKey: 'automatic-operation-test',
      title: 'Capture useful operations',
      intendedOutcome: 'Every useful operation updates the durable work history automatically',
    },
    { toolVersion: '0.20.0' },
  ).record;
}
