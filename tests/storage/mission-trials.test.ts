import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMissionTrialProgram,
  missionTrialConditionDigest,
  type MissionTrialProgramRequest,
  type MissionTrialRunRequest,
} from '../../src/domain/mission-trials.js';
import {
  assertProtectedRootOutsideCandidate,
  finalizeMissionTrialRun,
  observeMissionTrialArtifacts,
  readMissionTrialRuns,
  writeMissionTrialProgram,
  writeMissionTrialRun,
} from '../../src/storage/mission-trials.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mission trial protected storage', () => {
  it('observes protected artifacts and publishes immutable program and run records', () => {
    const candidateRoot = temporary('candidate-');
    const protectedRoot = temporary('protected-');
    writeFileSync(join(protectedRoot, 'fixture.tar'), 'fixture');
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'evaluator');
    const program = createProgram(protectedRoot);

    const programWrite = writeMissionTrialProgram(protectedRoot, program);
    const repeatedProgramWrite = writeMissionTrialProgram(protectedRoot, program);
    const observed = observeMissionTrialArtifacts(protectedRoot, program).observations[0]!;
    const run = finalizeMissionTrialRun(program, runRequest(program, observed), {
      now: () => '2026-07-30T13:10:00.000Z',
      toolVersion: '0.20.0',
    });
    const runWrite = writeMissionTrialRun(protectedRoot, candidateRoot, run);
    const repeatedRunWrite = writeMissionTrialRun(protectedRoot, candidateRoot, run);

    expect(programWrite.publication).toBe('created');
    expect(repeatedProgramWrite.publication).toBe('existing');
    expect(runWrite.publication).toBe('created');
    expect(repeatedRunWrite.publication).toBe('existing');
    expect(run.exclusionReasons).toEqual([]);
    expect(readMissionTrialRuns(protectedRoot, program.programId)).toMatchObject({
      records: [{ runId: run.runId }],
      issues: [],
    });
    expect(JSON.parse(readFileSync(runWrite.path, 'utf8'))).toEqual(run);
  });

  it('refuses to store protected results inside the candidate worktree', () => {
    const candidateRoot = temporary('candidate-');
    expect(() => assertProtectedRootOutsideCandidate(join(candidateRoot, 'trial-results'), candidateRoot)).toThrow(
      'outside the candidate-editable worktree',
    );
  });

  it('excludes a run when an evaluator changed after the work started', () => {
    const protectedRoot = temporary('protected-');
    writeFileSync(join(protectedRoot, 'fixture.tar'), 'fixture');
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'evaluator');
    const program = createProgram(protectedRoot);
    const before = observeMissionTrialArtifacts(protectedRoot, program).observations[0]!;
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'candidate changed evaluator');
    const after = observeMissionTrialArtifacts(protectedRoot, program).observations[0]!;
    const request = runRequest(program, {
      ...before,
      protectedEvaluator: {
        ...before.protectedEvaluator,
        afterSha256: after.protectedEvaluator.afterSha256,
      },
    });

    const run = finalizeMissionTrialRun(program, request, {
      now: () => '2026-07-30T13:10:00.000Z',
      toolVersion: '0.20.0',
    });

    expect(run.exclusionReasons).toEqual(['protected evaluator was unavailable or changed before or during the trial']);
  });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createProgram(protectedRoot: string) {
  const request: MissionTrialProgramRequest = {
    title: 'Protected program',
    fixedPredecessorCommit: 'b'.repeat(40),
    fixtures: [
      {
        fixtureId: 'overhaul',
        description: 'Protected overhaul fixture',
        authorizedGoal: 'Feature: obsolete behavior remains unreachable',
        repositoryArchive: { relativePath: 'fixture.tar', sha256: digest('fixture') },
        protectedEvaluator: { relativePath: 'evaluator.mjs', sha256: digest('evaluator') },
        affectedSurface: ['src/current.ts', 'src/obsolete.ts'],
      },
    ],
    agent: {
      provider: 'openai',
      model: 'gpt-5',
      runtime: 'codex',
      parametersSha256: 'c'.repeat(64),
    },
    budgets: {
      maxElapsedMs: 1_800_000,
      maxModelTokens: 200_000,
      maxToolCalls: 300,
      maxAttempts: 30,
    },
    maximumRerunsPerCondition: 2,
    decisionThresholds: {
      version: 1,
      minimumPairs: 4,
      minimumFullCompletionRateDelta: 0.05,
      maximumTreatmentFalseBlockingRate: 0.1,
      maximumArchitectureRegressionRate: 0,
      maximumElapsedRegressionRatio: 1.2,
      maximumTokenRegressionRatio: 1.2,
      confidenceLevel: 0.8,
      requireEfficiencyImprovement: 'elapsed-or-tokens',
    },
  };
  expect(protectedRoot).toBeTruthy();
  return createMissionTrialProgram(request, {
    now: () => '2026-07-30T13:00:00.000Z',
    toolVersion: '0.20.0',
  });
}

function runRequest(
  program: ReturnType<typeof createProgram>,
  observation: ReturnType<typeof observeMissionTrialArtifacts>['observations'][number],
): MissionTrialRunRequest {
  return {
    programId: program.programId,
    pairId: 'pair-1',
    fixtureId: 'overhaul',
    treatment: 'workflow',
    rerunOrdinal: 0,
    startedAt: '2026-07-30T13:01:00.000Z',
    completedAt: '2026-07-30T13:09:00.000Z',
    programDigest: program.semanticDigest,
    conditionDigest: missionTrialConditionDigest(program, 'workflow'),
    fixtureArchive: observation.fixtureArchive,
    protectedEvaluator: observation.protectedEvaluator,
    status: 'completed',
    exclusionReasons: [],
    telemetry: {
      elapsedMs: 480_000,
      modelTokens: null,
      toolCalls: 50,
      failedAttempts: 1,
      reworkEdits: 2,
      metadataCommands: 0,
      repeatedContextTokens: 0,
    },
    evaluation: {
      goalSatisfied: true,
      invariantsPreserved: true,
      affectedSurfaceReconciled: true,
      missedAffectedArtifacts: [],
      residueDefects: [],
      reintroducedBehaviors: [],
      architectureViolations: [],
      controllerBlocked: false,
      blockerWasValid: null,
    },
    failureOrigin: null,
    artifacts: [],
  };
}
