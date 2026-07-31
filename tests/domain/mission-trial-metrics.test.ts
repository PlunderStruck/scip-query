import { describe, expect, it } from 'vitest';

import {
  deriveMissionTrialMetrics,
  missionTrialFalseBlocking,
  missionTrialFullCompletion,
} from '../../src/domain/mission-trial-metrics.js';
import {
  createMissionTrialProgram,
  createMissionTrialRun,
  missionTrialConditionDigest,
  type MissionTrialEvaluation,
  type MissionTrialProgramRequest,
  type MissionTrialProgramV1,
  type MissionTrialRunRequest,
  type MissionTrialRunV1,
  type MissionTrialTelemetry,
  type MissionTrialTreatment,
} from '../../src/domain/mission-trials.js';

describe('mission trial metric derivation', () => {
  it('matches hand-calculated paired quality and efficiency observations deterministically', () => {
    const program = createProgram();
    const runs = [
      createRun(program, {
        pairId: 'pair-1',
        treatment: 'control',
        evaluation: {
          missedAffectedArtifacts: ['src/forgotten.ts'],
        },
        telemetry: { elapsedMs: 100, modelTokens: 1_000 },
        failureOrigin: 'detector-miss',
      }),
      createRun(program, {
        pairId: 'pair-1',
        treatment: 'workflow',
        telemetry: { elapsedMs: 80, modelTokens: 800 },
      }),
      createRun(program, {
        pairId: 'pair-2',
        treatment: 'control',
        telemetry: { elapsedMs: 200, modelTokens: null },
      }),
      createRun(program, {
        pairId: 'pair-2',
        treatment: 'workflow',
        evaluation: { controllerBlocked: true, blockerWasValid: false },
        telemetry: { elapsedMs: 240, modelTokens: 1_000 },
        failureOrigin: 'controller-miss',
      }),
    ];

    const report = deriveMissionTrialMetrics(program, runs);
    const reordered = deriveMissionTrialMetrics(program, [...runs].reverse());

    expect(reordered).toEqual(report);
    expect(report.matchedPairCount).toBe(2);
    expect(report.quality.control.fullCompletion).toEqual({
      observed: 2,
      positive: 1,
      unknown: 0,
      rate: 0.5,
    });
    expect(report.quality.workflow.fullCompletion.rate).toBe(1);
    expect(report.quality.fullCompletionRateDifference).toBe(0.5);
    expect(report.quality).toMatchObject({
      improvedPairs: 1,
      regressedPairs: 0,
      tiedPairs: 1,
      unknownPairs: 0,
    });
    expect(report.quality.workflow.falseBlocking.rate).toBe(0.5);
    expect(report.efficiency.elapsedMs).toEqual({
      observedPairs: 2,
      unknownPairs: 0,
      medianControl: 150,
      medianWorkflow: 160,
      medianDifference: 10,
      medianRatio: 1,
    });
    expect(report.efficiency.modelTokens).toEqual({
      observedPairs: 1,
      unknownPairs: 1,
      medianControl: 1_000,
      medianWorkflow: 800,
      medianDifference: -200,
      medianRatio: 0.8,
    });
    expect(report.failureOrigins.control.detectorMiss).toBe(1);
    expect(report.failureOrigins.workflow.controllerMiss).toBe(1);
    expect(report.rawSamples.find((sample) => sample.runId === runs[0]!.runId)).toMatchObject({
      fullCompletion: false,
      missedAffectedArtifacts: ['src/forgotten.ts'],
    });
  });

  it('retains unknown judgments and telemetry without imputing zero or success', () => {
    const program = createProgram();
    const control = createRun(program, {
      pairId: 'pair-unknown',
      treatment: 'control',
      evaluation: unknownEvaluation(),
      telemetry: unknownTelemetry(),
    });
    const workflow = createRun(program, {
      pairId: 'pair-unknown',
      treatment: 'workflow',
      evaluation: unknownEvaluation(),
      telemetry: unknownTelemetry(),
    });

    const report = deriveMissionTrialMetrics(program, [workflow, control]);

    expect(report.pairs[0]?.fullCompletionDifference).toBeNull();
    expect(report.quality.control.fullCompletion).toEqual({
      observed: 0,
      positive: 0,
      unknown: 1,
      rate: null,
    });
    expect(report.efficiency.elapsedMs).toEqual({
      observedPairs: 0,
      unknownPairs: 1,
      medianControl: null,
      medianWorkflow: null,
      medianDifference: null,
      medianRatio: null,
    });
    expect(report.rawSamples.every((sample) => sample.telemetry.elapsedMs === null)).toBe(true);
  });

  it('selects only the first eligible candidate outcome while allowing an apparatus retry', () => {
    const program = createProgram();
    const apparatusFailure = createRun(program, {
      pairId: 'pair-retry',
      treatment: 'control',
      failureOrigin: 'apparatus-failure',
      status: 'crashed',
    });
    const recoveredControl = createRun(program, {
      pairId: 'pair-retry',
      treatment: 'control',
      rerunOrdinal: 1,
    });
    const primaryWorkflow = createRun(program, {
      pairId: 'pair-retry',
      treatment: 'workflow',
      evaluation: { residueDefects: ['src/residue.ts'] },
    });
    const replacementWorkflow = createRun(program, {
      pairId: 'pair-retry',
      treatment: 'workflow',
      rerunOrdinal: 1,
    });

    const report = deriveMissionTrialMetrics(program, [
      replacementWorkflow,
      recoveredControl,
      primaryWorkflow,
      apparatusFailure,
    ]);

    expect(report.matchedPairCount).toBe(1);
    expect(report.pairs[0]?.control.runId).toBe(recoveredControl.runId);
    expect(report.pairs[0]?.workflow.runId).toBe(primaryWorkflow.runId);
    expect(report.rawSamples.find((sample) => sample.runId === apparatusFailure.runId)).toMatchObject({
      selection: 'excluded',
      exclusionReasons: ['apparatus failure does not score a candidate outcome'],
    });
    expect(report.rawSamples.find((sample) => sample.runId === replacementWorkflow.runId)).toMatchObject({
      selection: 'superseded',
      exclusionReasons: ['rerun cannot replace an already recorded candidate outcome'],
    });
  });

  it('excludes out-of-policy, contaminated, and unpaired records with explicit reasons', () => {
    const program = createProgram();
    const missingPrimary = createRun(program, {
      pairId: 'pair-missing-primary',
      treatment: 'control',
      rerunOrdinal: 1,
    });
    const excessiveRerun = createRun(program, {
      pairId: 'pair-excessive',
      treatment: 'control',
      rerunOrdinal: program.maximumRerunsPerCondition + 1,
    });
    const contaminated = createRun(program, {
      pairId: 'pair-contaminated',
      treatment: 'workflow',
      conditionDigest: 'f'.repeat(64),
    });
    const unmatched = createRun(program, {
      pairId: 'pair-unmatched',
      treatment: 'workflow',
    });

    const report = deriveMissionTrialMetrics(program, [missingPrimary, excessiveRerun, contaminated, unmatched]);

    expect(report.matchedPairCount).toBe(0);
    expect(report.unmatched.map((sample) => sample.runId)).toEqual([unmatched.runId]);
    expect(reasonsFor(report, missingPrimary)).toContain('condition has no primary run at rerun ordinal 0');
    expect(reasonsFor(report, excessiveRerun)).toContain(
      `rerun ordinal ${program.maximumRerunsPerCondition + 1} exceeds maximum ${program.maximumRerunsPerCondition}`,
    );
    expect(reasonsFor(report, contaminated)).toContain('agent, budget, or treatment condition drifted');
  });

  it('defines completion and false blocking from protected observations', () => {
    const complete = completeEvaluation();

    expect(missionTrialFullCompletion('completed', complete)).toBe(true);
    expect(
      missionTrialFullCompletion('completed', {
        ...complete,
        architectureViolations: ['src/feature.ts imports forbidden layer'],
      }),
    ).toBe(false);
    expect(missionTrialFullCompletion('completed', { ...complete, residueDefects: null })).toBeNull();
    expect(missionTrialFullCompletion('timed-out', unknownEvaluation())).toBe(false);
    expect(missionTrialFalseBlocking({ ...complete, controllerBlocked: true, blockerWasValid: false })).toBe(true);
    expect(missionTrialFalseBlocking({ ...complete, controllerBlocked: true, blockerWasValid: null })).toBeNull();
  });
});

function reasonsFor(report: ReturnType<typeof deriveMissionTrialMetrics>, run: MissionTrialRunV1): readonly string[] {
  return report.rawSamples.find((sample) => sample.runId === run.runId)?.exclusionReasons ?? [];
}

function createProgram(): MissionTrialProgramV1 {
  return createMissionTrialProgram(programRequest(), {
    now: () => '2026-07-30T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
}

function programRequest(): MissionTrialProgramRequest {
  return {
    title: 'Metric derivation trial',
    fixedPredecessorCommit: 'b'.repeat(40),
    fixtures: [
      {
        fixtureId: 'overhaul',
        description: 'Replace a dispatcher and remove obsolete residue',
        authorizedGoal: 'Feature: only the current dispatcher remains reachable',
        repositoryArchive: { relativePath: 'fixtures/overhaul.tar', sha256: 'a'.repeat(64) },
        protectedEvaluator: { relativePath: 'evaluators/overhaul.mjs', sha256: 'd'.repeat(64) },
        affectedSurface: ['src/dispatch.ts', 'src/obsolete.ts'],
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
      minimumPairs: 2,
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

function createRun(
  program: MissionTrialProgramV1,
  options: {
    pairId: string;
    treatment: MissionTrialTreatment;
    rerunOrdinal?: number;
    status?: MissionTrialRunRequest['status'];
    conditionDigest?: string;
    evaluation?: Partial<MissionTrialEvaluation> | MissionTrialEvaluation;
    telemetry?: Partial<MissionTrialTelemetry> | MissionTrialTelemetry;
    failureOrigin?: MissionTrialRunRequest['failureOrigin'];
  },
): MissionTrialRunV1 {
  const fixture = program.fixtures[0]!;
  const request: MissionTrialRunRequest = {
    programId: program.programId,
    pairId: options.pairId,
    fixtureId: fixture.fixtureId,
    treatment: options.treatment,
    rerunOrdinal: options.rerunOrdinal ?? 0,
    startedAt: '2026-07-30T12:01:00.000Z',
    completedAt: '2026-07-30T12:05:00.000Z',
    programDigest: program.semanticDigest,
    conditionDigest: options.conditionDigest ?? missionTrialConditionDigest(program, options.treatment),
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
    status: options.status ?? 'completed',
    exclusionReasons: [],
    telemetry: { ...completeTelemetry(), ...options.telemetry },
    evaluation: { ...completeEvaluation(), ...options.evaluation },
    failureOrigin: options.failureOrigin ?? null,
    artifacts: [],
  };
  return createMissionTrialRun(request, {
    now: () => `2026-07-30T12:${String(options.rerunOrdinal ?? 0).padStart(2, '0')}:00.000Z`,
    toolVersion: '0.20.0',
  });
}

function completeEvaluation(): MissionTrialEvaluation {
  return {
    goalSatisfied: true,
    invariantsPreserved: true,
    affectedSurfaceReconciled: true,
    missedAffectedArtifacts: [],
    residueDefects: [],
    reintroducedBehaviors: [],
    architectureViolations: [],
    controllerBlocked: false,
    blockerWasValid: null,
  };
}

function unknownEvaluation(): MissionTrialEvaluation {
  return {
    goalSatisfied: null,
    invariantsPreserved: null,
    affectedSurfaceReconciled: null,
    missedAffectedArtifacts: null,
    residueDefects: null,
    reintroducedBehaviors: null,
    architectureViolations: null,
    controllerBlocked: null,
    blockerWasValid: null,
  };
}

function completeTelemetry(): MissionTrialTelemetry {
  return {
    elapsedMs: 100,
    modelTokens: 1_000,
    toolCalls: 10,
    failedAttempts: 0,
    reworkEdits: 0,
    metadataCommands: 0,
    repeatedContextTokens: 0,
  };
}

function unknownTelemetry(): MissionTrialTelemetry {
  return {
    elapsedMs: null,
    modelTokens: null,
    toolCalls: null,
    failedAttempts: null,
    reworkEdits: null,
    metadataCommands: null,
    repeatedContextTokens: null,
  };
}
