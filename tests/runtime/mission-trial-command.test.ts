import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMissionTrialProgram,
  createMissionTrialRun,
  missionTrialConditionDigest,
  type MissionTrialProgramRequest,
  type MissionTrialProgramV1,
  type MissionTrialTreatment,
} from '../../src/domain/mission-trials.js';
import { writeMissionTrialProgram, writeMissionTrialRun } from '../../src/storage/mission-trials.js';
import { handleMissionTrial } from '../../src/runtime/commands/mission-trial-handlers.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mission-trial command', () => {
  it('validates a registered program and reports exact condition identities', () => {
    const protectedRoot = temporary('mission-protected-');
    const candidateRoot = temporary('mission-candidate-');
    writeFileSync(join(protectedRoot, 'fixture.tar'), 'fixture');
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'evaluator');
    const program = createMissionTrialProgram(programRequest(), {
      now: () => '2026-07-30T14:00:00.000Z',
      toolVersion: '0.20.0',
    });
    const stored = writeMissionTrialProgram(protectedRoot, program);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));

    handleMissionTrial('validate', stored.path, { protectedRoot, candidateRoot });

    expect(process.exitCode).not.toBe(1);
    expect(output[0]).toBe(`Program ${program.programId}: valid`);
    expect(output).toContainEqual(expect.stringContaining('control: disabled'));
    expect(output).toContainEqual(expect.stringContaining('workflow: autonomous-completion-v1'));
  });

  it('rejects a protected root nested inside the candidate worktree', () => {
    const candidateRoot = temporary('mission-candidate-');
    const protectedRoot = join(candidateRoot, 'protected');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)));

    handleMissionTrial('validate', join(protectedRoot, 'program.json'), { protectedRoot, candidateRoot });

    expect(process.exitCode).toBe(1);
    expect(errors).toContainEqual(expect.stringContaining('outside the candidate-editable worktree'));
  });

  it('reports paired quality and efficiency without hiding unknown measurements', () => {
    const protectedRoot = temporary('mission-protected-');
    const candidateRoot = temporary('mission-candidate-');
    writeFileSync(join(protectedRoot, 'fixture.tar'), 'fixture');
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'evaluator');
    const program = createMissionTrialProgram(programRequest(), {
      now: () => '2026-07-30T14:00:00.000Z',
      toolVersion: '0.20.0',
    });
    const stored = writeMissionTrialProgram(protectedRoot, program);
    writeMissionTrialRun(protectedRoot, candidateRoot, completedRun(program, 'control', 120));
    writeMissionTrialRun(protectedRoot, candidateRoot, completedRun(program, 'workflow', 90));
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)));

    handleMissionTrial('report', stored.path, { protectedRoot, candidateRoot });

    expect(process.exitCode).not.toBe(1);
    expect(output).toContain('Matched pairs: 1');
    expect(output).toContain('Full completion: control 100.0%, workflow 100.0%, difference +0.0pp');
    expect(output).toContain('Median workflow/control ratio: elapsed 0.75x, model tokens unknown');
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

function programRequest(): MissionTrialProgramRequest {
  return {
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
}

function completedRun(program: MissionTrialProgramV1, treatment: MissionTrialTreatment, elapsedMs: number) {
  const fixture = program.fixtures[0]!;
  return createMissionTrialRun(
    {
      programId: program.programId,
      pairId: 'pair-1',
      fixtureId: fixture.fixtureId,
      treatment,
      rerunOrdinal: 0,
      startedAt: '2026-07-30T14:01:00.000Z',
      completedAt: '2026-07-30T14:02:00.000Z',
      programDigest: program.semanticDigest,
      conditionDigest: missionTrialConditionDigest(program, treatment),
      fixtureArchive: {
        expectedSha256: fixture.repositoryArchive.sha256,
        beforeSha256: fixture.repositoryArchive.sha256,
        afterSha256: fixture.repositoryArchive.sha256,
      },
      protectedEvaluator: {
        expectedSha256: fixture.protectedEvaluator.sha256,
        beforeSha256: fixture.protectedEvaluator.sha256,
        afterSha256: fixture.protectedEvaluator.sha256,
      },
      status: 'completed',
      exclusionReasons: [],
      telemetry: {
        elapsedMs,
        modelTokens: null,
        toolCalls: 10,
        failedAttempts: 0,
        reworkEdits: 0,
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
    },
    {
      now: () => '2026-07-30T14:03:00.000Z',
      toolVersion: '0.20.0',
    },
  );
}
