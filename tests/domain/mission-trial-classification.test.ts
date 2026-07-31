import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyMissionTrialReport,
  pairedCompletionUncertainty,
} from '../../src/domain/mission-trial-classification.js';
import { deriveMissionTrialMetrics } from '../../src/domain/mission-trial-metrics.js';
import {
  createMissionTrialProgram,
  createMissionTrialRun,
  missionTrialConditionDigest,
  type MissionTrialDecisionThresholds,
  type MissionTrialProgramRequest,
  type MissionTrialProgramV1,
  type MissionTrialRunV1,
  type MissionTrialTreatment,
} from '../../src/domain/mission-trials.js';

describe('mission trial classification', () => {
  it('establishes only a probable completion gain with safe and improved efficiency', () => {
    const program = createProgram();
    const runs = Array.from({ length: 4 }, (_, index) =>
      matchedPair(program, `pair-${index + 1}`, {
        controlComplete: false,
        workflowComplete: true,
        controlElapsedMs: 100,
        workflowElapsedMs: 90,
        controlTokens: 1_000,
        workflowTokens: 950,
      }),
    ).flat();

    const result = classifyMissionTrialReport(program, deriveMissionTrialMetrics(program, runs));

    expect(result.classification).toBe('established');
    expect(result.completion).toMatchObject({ result: 'established', rateDifference: 1 });
    expect(result.completion.probabilityTreatmentBetter).toBeCloseTo(0.96875);
    expect(result.safety.result).toBe('within-bounds');
    expect(result.efficiency).toMatchObject({
      result: 'improved',
      elapsedRatio: 0.9,
      tokenRatio: 0.95,
      improvedDimensions: ['elapsed', 'model-tokens'],
    });
  });

  it('keeps directionally positive but uncertain evidence promising', () => {
    const program = createProgram({ confidenceLevel: 0.95 });
    const outcomes = [
      { controlComplete: false, workflowComplete: true },
      { controlComplete: false, workflowComplete: true },
      { controlComplete: true, workflowComplete: true },
      { controlComplete: true, workflowComplete: true },
    ];
    const runs = outcomes.flatMap((outcome, index) =>
      matchedPair(program, `pair-${index + 1}`, {
        ...outcome,
        controlElapsedMs: 100,
        workflowElapsedMs: 90,
        controlTokens: 1_000,
        workflowTokens: 1_000,
      }),
    );

    const result = classifyMissionTrialReport(program, deriveMissionTrialMetrics(program, runs));

    expect(result.classification).toBe('promising');
    expect(result.completion).toMatchObject({
      result: 'positive',
      rateDifference: 0.5,
      requiredProbability: 0.95,
    });
    expect(result.completion.probabilityTreatmentBetter).toBeCloseTo(0.875);
    expect(result.reasonCodes).toContain('full-completion-direction-positive-but-not-established');
  });

  it('reports neutral when efficiency improves without a completion advantage', () => {
    const program = createProgram();
    const runs = Array.from({ length: 4 }, (_, index) =>
      matchedPair(program, `pair-${index + 1}`, {
        controlComplete: true,
        workflowComplete: true,
        controlElapsedMs: 100,
        workflowElapsedMs: 80,
        controlTokens: 1_000,
        workflowTokens: 1_000,
      }),
    ).flat();

    const result = classifyMissionTrialReport(program, deriveMissionTrialMetrics(program, runs));

    expect(result.classification).toBe('neutral');
    expect(result.completion.result).toBe('neutral');
    expect(result.efficiency.result).toBe('improved');
    expect(result.uncertainty.probabilityTreatmentBetter).toBe(0.5);
  });

  it('classifies any pre-registered safety breach as regressed while retaining other dimensions', () => {
    const program = createProgram();
    const runs = Array.from({ length: 4 }, (_, index) =>
      matchedPair(program, `pair-${index + 1}`, {
        controlComplete: false,
        workflowComplete: true,
        workflowArchitectureViolation: index === 0,
        controlElapsedMs: 100,
        workflowElapsedMs: 90,
        controlTokens: 1_000,
        workflowTokens: 900,
      }),
    ).flat();

    const result = classifyMissionTrialReport(program, deriveMissionTrialMetrics(program, runs));

    expect(result.classification).toBe('regressed');
    expect(result.safety).toMatchObject({
      result: 'regressed',
      architectureRegressionRate: 0.25,
    });
    expect(result.efficiency.result).toBe('improved');
    expect(result.reasonCodes).toEqual(['safety-bound-exceeded']);
  });

  it('keeps too few pairs and missing cost evidence insufficient rather than favorable', () => {
    const program = createProgram();
    const runs = Array.from({ length: 3 }, (_, index) =>
      matchedPair(program, `pair-${index + 1}`, {
        controlComplete: false,
        workflowComplete: true,
        controlElapsedMs: 100,
        workflowElapsedMs: 80,
        controlTokens: null,
        workflowTokens: null,
      }),
    ).flat();

    const result = classifyMissionTrialReport(program, deriveMissionTrialMetrics(program, runs));

    expect(result.classification).toBe('insufficient');
    expect(result.sufficiencyIssues).toEqual([
      'below-minimum-paired-trial-count',
      'unknown-paired-model-tokens',
      'unusable-model-token-baseline',
    ]);
  });

  it('does not let one fast but incomplete treatment establish success', () => {
    const program = createProgram({ minimumPairs: 1 });
    const runs = matchedPair(program, 'pair-1', {
      controlComplete: true,
      workflowComplete: false,
      controlElapsedMs: 100,
      workflowElapsedMs: 10,
      controlTokens: 1_000,
      workflowTokens: 100,
    });

    const result = classifyMissionTrialReport(program, deriveMissionTrialMetrics(program, runs));

    expect(result.classification).toBe('regressed');
    expect(result.completion.result).toBe('regressed');
    expect(result.efficiency.result).toBe('improved');
  });

  it('binds threshold changes to a different program identity', () => {
    const original = createProgram({ confidenceLevel: 0.8 });
    const tuned = createProgram({ confidenceLevel: 0.9 });

    expect(tuned.programId).not.toBe(original.programId);
    expect(tuned.semanticDigest).not.toBe(original.semanticDigest);
  });

  it('reports paired uncertainty from the fixed beta prior and direction interval', () => {
    const uncertainty = pairedCompletionUncertainty(4, 0, 0.8);

    expect(uncertainty.probabilityTreatmentBetter).toBeCloseTo(0.96875);
    expect(uncertainty.directionEstimate).toBe(1);
    expect(uncertainty.interval.lower).toBeGreaterThan(0);
    expect(uncertainty.interval.upper).toBeLessThanOrEqual(1);
    expect(pairedCompletionUncertainty(0, 0, 0.8)).toMatchObject({
      directionEstimate: null,
      probabilityTreatmentBetter: 0.5,
      interval: { lower: 0, upper: 1 },
    });
  });

  it('publishes the stable classification vocabulary as a schema contract', () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs', 'schemas', 'mission-trial-classification.schema.json'), 'utf8'),
    ) as {
      properties: {
        version: { const: number };
        classification: { enum: string[] };
      };
    };

    expect(schema.properties.version.const).toBe(1);
    expect(schema.properties.classification.enum).toEqual([
      'established',
      'promising',
      'neutral',
      'regressed',
      'insufficient',
    ]);
  });
});

interface PairOptions {
  controlComplete: boolean;
  workflowComplete: boolean;
  controlElapsedMs: number | null;
  workflowElapsedMs: number | null;
  controlTokens: number | null;
  workflowTokens: number | null;
  workflowArchitectureViolation?: boolean;
}

function matchedPair(program: MissionTrialProgramV1, pairId: string, options: PairOptions): MissionTrialRunV1[] {
  return [
    createRun(program, pairId, 'control', {
      complete: options.controlComplete,
      elapsedMs: options.controlElapsedMs,
      modelTokens: options.controlTokens,
      architectureViolation: false,
    }),
    createRun(program, pairId, 'workflow', {
      complete: options.workflowComplete,
      elapsedMs: options.workflowElapsedMs,
      modelTokens: options.workflowTokens,
      architectureViolation: options.workflowArchitectureViolation ?? false,
    }),
  ];
}

function createRun(
  program: MissionTrialProgramV1,
  pairId: string,
  treatment: MissionTrialTreatment,
  outcome: {
    complete: boolean;
    elapsedMs: number | null;
    modelTokens: number | null;
    architectureViolation: boolean;
  },
): MissionTrialRunV1 {
  const fixture = program.fixtures[0]!;
  return createMissionTrialRun(
    {
      programId: program.programId,
      pairId,
      fixtureId: fixture.fixtureId,
      treatment,
      rerunOrdinal: 0,
      startedAt: '2026-07-30T12:01:00.000Z',
      completedAt: '2026-07-30T12:05:00.000Z',
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
        elapsedMs: outcome.elapsedMs,
        modelTokens: outcome.modelTokens,
        toolCalls: 10,
        failedAttempts: 0,
        reworkEdits: 0,
        metadataCommands: 0,
        repeatedContextTokens: 0,
      },
      evaluation: {
        goalSatisfied: outcome.complete,
        invariantsPreserved: true,
        affectedSurfaceReconciled: true,
        missedAffectedArtifacts: [],
        residueDefects: outcome.complete ? [] : ['src/residue.ts'],
        reintroducedBehaviors: [],
        architectureViolations: outcome.architectureViolation ? ['src/feature.ts imports a forbidden layer'] : [],
        controllerBlocked: false,
        blockerWasValid: null,
      },
      failureOrigin: outcome.complete ? null : 'agent-failure',
      artifacts: [],
    },
    {
      now: () => '2026-07-30T12:06:00.000Z',
      toolVersion: '0.20.0',
    },
  );
}

function createProgram(thresholdOverrides: Partial<MissionTrialDecisionThresholds> = {}): MissionTrialProgramV1 {
  const request: MissionTrialProgramRequest = {
    title: 'Pre-registered classifier trial',
    fixedPredecessorCommit: 'b'.repeat(40),
    fixtures: [
      {
        fixtureId: 'overhaul',
        description: 'Replace a dispatcher and remove plausible obsolete residue',
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
      minimumPairs: 4,
      minimumFullCompletionRateDelta: 0.05,
      maximumTreatmentFalseBlockingRate: 0.1,
      maximumArchitectureRegressionRate: 0,
      maximumElapsedRegressionRatio: 1.2,
      maximumTokenRegressionRatio: 1.2,
      confidenceLevel: 0.8,
      requireEfficiencyImprovement: 'elapsed-or-tokens',
      ...thresholdOverrides,
    },
  };
  return createMissionTrialProgram(request, {
    now: () => '2026-07-30T12:00:00.000Z',
    toolVersion: '0.20.0',
  });
}
