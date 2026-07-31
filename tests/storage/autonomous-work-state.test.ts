import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createIntendedChangeRecord,
  type GoalCreateRequest,
  type IntendedChangeCreateRequest,
} from '../../src/domain/autonomous-work-state.js';
import { NODE_ATOMIC_FILE_RUNTIME, type AtomicFileRuntime } from '../../src/storage/atomic-file.js';
import {
  createGoalRecordFile,
  createIntendedChangeRecordFile,
  readGoalRecordFile,
  readGoalRecords,
  readIntendedChangeRecords,
} from '../../src/storage/autonomous-work-state.js';

const COLLABORATION_DOMAIN = '5ea57d1a-936c-4c91-b58f-5d61e45173a5';
const TOOL_VERSION = '0.20.0';
const fixtureDirectories = new Set<string>();

afterEach(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  fixtureDirectories.clear();
});

describe('autonomous work-state storage', () => {
  it('publishes a goal durably and makes an unknown-outcome retry idempotent', () => {
    const root = fixtureDirectory();
    const first = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    });
    const retry = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:00:00.000Z',
    });

    expect(first.publication).toBe('created');
    expect(first.achievedDurability).toBe(process.platform === 'win32' ? 'file-flushed' : 'directory-durable');
    expect(retry).toEqual({
      record: first.record,
      path: first.path,
      publication: 'existing',
      achievedDurability: 'existing',
    });
    expect(JSON.parse(readFileSync(join(root, first.path), 'utf8'))).toEqual(first.record);
  });

  it('reconciles an unknown create outcome after the public name was linked', () => {
    const root = fixtureDirectory();
    const runtime: AtomicFileRuntime = {
      ...NODE_ATOMIC_FILE_RUNTIME,
      randomToken: () => 'unknown-outcome',
      linkFile: (source, target) => {
        NODE_ATOMIC_FILE_RUNTIME.linkFile!(source, target);
        throw Object.assign(new Error('simulated connection loss after publication'), { code: 'EIO' });
      },
    };

    expect(() =>
      createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
        toolVersion: TOOL_VERSION,
        now: () => '2026-07-30T12:00:00.000Z',
        atomicRuntime: runtime,
      }),
    ).toThrow('simulated connection loss after publication');

    const retry = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:00:00.000Z',
    });

    expect(retry.publication).toBe('existing');
    expect(retry.record.createdAt).toBe('2026-07-30T12:00:00.000Z');
  });

  it('rejects same-identity goal metadata drift instead of overwriting history', () => {
    const root = fixtureDirectory();
    createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), { toolVersion: TOOL_VERSION });

    expect(() =>
      createGoalRecordFile(
        root,
        COLLABORATION_DOMAIN,
        {
          ...goalRequest(),
          authorization: {
            kind: 'repository-delegation',
            principal: 'repository-owner',
            source: 'different-delegation',
          },
        },
        { toolVersion: TOOL_VERSION },
      ),
    ).toThrow(/identity collision/u);
  });

  it('uses the intended-change retry key as an exclusive uniqueness constraint', () => {
    const root = fixtureDirectory();
    const goal = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), { toolVersion: TOOL_VERSION }).record;
    const request = changeRequest(goal.goalId, 'change-key-a');
    const first = createIntendedChangeRecordFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: TOOL_VERSION,
      now: () => '2026-07-30T12:00:00.000Z',
    });
    const retry = createIntendedChangeRecordFile(root, COLLABORATION_DOMAIN, request, {
      toolVersion: '99.0.0',
      now: () => '2026-07-31T12:00:00.000Z',
    });

    expect(retry.publication).toBe('existing');
    expect(retry.record).toEqual(first.record);
    expect(() =>
      createIntendedChangeRecordFile(
        root,
        COLLABORATION_DOMAIN,
        { ...request, intendedOutcome: 'A different effect' },
        { toolVersion: TOOL_VERSION },
      ),
    ).toThrow(/idempotency collision/u);
  });

  it('preserves distinct branch records under conflict-free filenames', () => {
    const left = fixtureDirectory();
    const right = fixtureDirectory();
    const merged = fixtureDirectory();
    const goal = createGoalRecordFile(left, COLLABORATION_DOMAIN, goalRequest(), { toolVersion: TOOL_VERSION }).record;
    copyRelative(left, right, join('.scipquery', 'goals', `${goal.goalId}.json`));
    copyRelative(left, merged, join('.scipquery', 'goals', `${goal.goalId}.json`));
    const leftChange = createIntendedChangeRecordFile(
      left,
      COLLABORATION_DOMAIN,
      changeRequest(goal.goalId, 'left-branch'),
      { toolVersion: TOOL_VERSION },
    ).record;
    const rightChange = createIntendedChangeRecordFile(
      right,
      COLLABORATION_DOMAIN,
      changeRequest(goal.goalId, 'right-branch'),
      { toolVersion: TOOL_VERSION },
    ).record;

    copyRelative(left, merged, join('.scipquery', 'changes', `${leftChange.changeId}.json`));
    copyRelative(right, merged, join('.scipquery', 'changes', `${rightChange.changeId}.json`));
    const status = readIntendedChangeRecords(merged);

    expect(status.compatibility.complete).toBe(true);
    expect(status.integrityIssues).toEqual([]);
    expect(status.records.map((record) => record.changeId).sort()).toEqual(
      [leftChange.changeId, rightChange.changeId].sort(),
    );
  });

  it('reports forward versions, malformed filenames, symlinks, and missing goal references', () => {
    const root = fixtureDirectory();
    const goal = createGoalRecordFile(root, COLLABORATION_DOMAIN, goalRequest(), { toolVersion: TOOL_VERSION }).record;
    const future = { ...goal, schemaVersion: 2 };
    writeJson(join(root, '.scipquery', 'goals', 'future.json'), future);
    symlinkSync(
      join(root, '.scipquery', 'goals', `${goal.goalId}.json`),
      join(root, '.scipquery', 'goals', 'link.json'),
    );
    const orphan = createIntendedChangeRecord({
      collaborationDomainId: COLLABORATION_DOMAIN,
      request: changeRequest('SQG-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'orphan'),
      createdAt: '2026-07-30T12:00:00.000Z',
      toolVersion: TOOL_VERSION,
    });
    writeJson(join(root, '.scipquery', 'changes', `${orphan.changeId}.json`), orphan);

    const goals = readGoalRecords(root);
    const changes = readIntendedChangeRecords(root, goals);

    expect(goals.records).toEqual([goal]);
    expect(goals.compatibility).toEqual(
      expect.objectContaining({ complete: false, unsupportedFuture: 1, malformed: 1, omitted: 2 }),
    );
    expect(changes.integrityIssues).toEqual([
      `${orphan.changeId} references missing or incompatible goal ${orphan.goalId}`,
    ]);
    expect(readGoalRecordFile(root, 'SQG-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')).toEqual(
      expect.objectContaining({ state: 'missing' }),
    );
  });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-work-state-'));
  fixtureDirectories.add(directory);
  return directory;
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

function changeRequest(goalId: string, idempotencyKey: string): IntendedChangeCreateRequest {
  return {
    goalId,
    idempotencyKey,
    title: 'Durable autonomous state',
    intendedOutcome: 'The work survives interruption and collaboration',
  };
}

function copyRelative(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, relativePath), target);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
