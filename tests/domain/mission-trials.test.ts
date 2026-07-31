import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createMissionTrialProgram,
  createMissionTrialRun,
  decodeMissionTrialProgram,
  decodeMissionTrialRun,
  missionTrialConditionDigest,
  missionTrialRunExclusionReasons,
  type MissionTrialProgramRequest,
  type MissionTrialRunRequest,
} from '../../src/domain/mission-trials.js';

describe('mission trial records', () => {
  it('gives equal program meaning one identity while keeping creation provenance', () => {
    const request = programRequest();
    const first = createMissionTrialProgram(request, {
      now: () => '2026-07-30T12:00:00.000Z',
      toolVersion: '0.20.0',
    });
    const second = createMissionTrialProgram(request, {
      now: () => '2026-07-30T13:00:00.000Z',
      toolVersion: '0.21.0',
    });

    expect(second.programId).toBe(first.programId);
    expect(second.semanticDigest).toBe(first.semanticDigest);
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(decodeMissionTrialProgram(first)).toEqual({ state: 'current', record: first });
  });

  it('makes workflow enablement the only possible treatment difference', () => {
    const program = createProgram();
    const contaminated = structuredClone(program) as unknown as Record<string, unknown>;
    const conditions = contaminated['conditions'] as Record<string, Record<string, unknown>>;
    conditions['treatment']!['extraPrompt'] = 'make the treatment easier';

    expect(decodeMissionTrialProgram(contaminated)).toEqual({
      state: 'malformed',
      error: 'conditions must differ only by disabled vs autonomous-completion-v1 workflow',
    });
    expect(missionTrialConditionDigest(program, 'control')).not.toBe(missionTrialConditionDigest(program, 'workflow'));
  });

  it('retains null telemetry instead of converting missing observations to zero', () => {
    const program = createProgram();
    const run = createMissionTrialRun(runRequest(program), {
      now: () => '2026-07-30T12:06:00.000Z',
      toolVersion: '0.20.0',
    });

    expect(run.telemetry.modelTokens).toBeNull();
    expect(run.evaluation.goalSatisfied).toBeNull();
    expect(decodeMissionTrialRun(run)).toEqual({ state: 'current', record: run });
  });

  it('gives every rerun a distinct immutable identity', () => {
    const program = createProgram();
    const first = createMissionTrialRun(runRequest(program), {
      now: () => '2026-07-30T12:06:00.000Z',
      toolVersion: '0.20.0',
    });
    const second = createMissionTrialRun(
      { ...runRequest(program), rerunOrdinal: 1 },
      {
        now: () => '2026-07-30T12:07:00.000Z',
        toolVersion: '0.20.0',
      },
    );

    expect(second.runId).not.toBe(first.runId);
  });

  it('excludes identity, condition, evaluator, and fixture contamination with explicit reasons', () => {
    const program = createProgram();
    const request = runRequest(program);
    const reasons = missionTrialRunExclusionReasons(program, {
      ...request,
      conditionDigest: 'f'.repeat(64),
      protectedEvaluator: { ...request.protectedEvaluator, afterSha256: '0'.repeat(64) },
    });

    expect(reasons).toEqual([
      'agent, budget, or treatment condition drifted',
      'protected evaluator was unavailable or changed before or during the trial',
    ]);
  });

  it('publishes program and run schema contracts', () => {
    const schemas = join(process.cwd(), 'docs', 'schemas');
    const program = JSON.parse(readFileSync(join(schemas, 'mission-trial-program.schema.json'), 'utf8')) as {
      properties: { kind: { const: string }; schemaVersion: { const: number } };
    };
    const run = JSON.parse(readFileSync(join(schemas, 'mission-trial-run.schema.json'), 'utf8')) as {
      properties: { kind: { const: string }; schemaVersion: { const: number } };
    };

    expect(program.properties.kind.const).toBe('scip-query-mission-trial-program');
    expect(program.properties.schemaVersion.const).toBe(1);
    expect(run.properties.kind.const).toBe('scip-query-mission-trial-run');
    expect(run.properties.schemaVersion.const).toBe(1);
  });
});

function createProgram() {
  return createMissionTrialProgram(programRequest(), {
    now: () => '2026-07-30T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
}

function programRequest(): MissionTrialProgramRequest {
  return {
    title: 'Autonomous completion matched trial v1',
    fixedPredecessorCommit: 'b'.repeat(40),
    fixtures: [
      {
        fixtureId: 'obsolete-dispatch-overhaul',
        description: 'Replace a dispatcher without reviving plausible obsolete wiring',
        authorizedGoal: [
          'Feature: Dispatch uses the current route table',
          '  Scenario: An obsolete route remains in the repository',
          '    When dispatch is executed',
          '    Then the obsolete route is not reachable',
        ].join('\n'),
        repositoryArchive: { relativePath: 'fixtures/overhaul.tar', sha256: 'a'.repeat(64) },
        protectedEvaluator: { relativePath: 'evaluators/overhaul.mjs', sha256: 'd'.repeat(64) },
        affectedSurface: ['src/dispatch.ts', 'src/obsolete.ts', 'tests/dispatch.test.ts'],
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

function runRequest(program: ReturnType<typeof createProgram>): MissionTrialRunRequest {
  return {
    programId: program.programId,
    pairId: 'pair-1',
    fixtureId: 'obsolete-dispatch-overhaul',
    treatment: 'workflow',
    rerunOrdinal: 0,
    startedAt: '2026-07-30T12:01:00.000Z',
    completedAt: '2026-07-30T12:05:00.000Z',
    programDigest: program.semanticDigest,
    conditionDigest: missionTrialConditionDigest(program, 'workflow'),
    fixtureArchive: {
      expectedSha256: 'a'.repeat(64),
      beforeSha256: 'a'.repeat(64),
      afterSha256: 'a'.repeat(64),
    },
    protectedEvaluator: {
      expectedSha256: 'd'.repeat(64),
      beforeSha256: 'd'.repeat(64),
      afterSha256: 'd'.repeat(64),
    },
    status: 'completed',
    exclusionReasons: [],
    telemetry: {
      elapsedMs: 240_000,
      modelTokens: null,
      toolCalls: 42,
      failedAttempts: 1,
      reworkEdits: 2,
      metadataCommands: 0,
      repeatedContextTokens: 0,
    },
    evaluation: {
      goalSatisfied: null,
      invariantsPreserved: true,
      affectedSurfaceReconciled: true,
      residueDefects: [],
      reintroducedBehaviors: [],
      architectureViolations: [],
      controllerBlocked: false,
      blockerWasValid: null,
    },
    failureOrigin: null,
    artifacts: [{ kind: 'transcript', relativePath: 'artifacts/pair-1-workflow.jsonl', sha256: 'e'.repeat(64) }],
  };
}
