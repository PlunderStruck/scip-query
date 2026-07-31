import { describe, expect, it } from 'vitest';

import {
  deriveMissionEffectiveness,
  invalidMissionEffectiveness,
  unavailableMissionEffectiveness,
} from '../../src/domain/mission-effectiveness.js';
import { createMissionTrialProgram, type MissionTrialProgramRequest } from '../../src/domain/mission-trials.js';

describe('mission effectiveness evidence', () => {
  it('keeps protected mission evidence separate and exactly scoped even when insufficient', () => {
    const program = createMissionTrialProgram(programRequest(), {
      now: () => '2026-07-30T12:00:00.000Z',
      toolVersion: '0.20.0',
    });

    const evidence = deriveMissionEffectiveness(program, [], ['one protected run record was malformed']);

    expect(evidence).toMatchObject({
      availability: 'available',
      authority: 'protected-matched-trials',
      program: {
        programId: program.programId,
        semanticDigest: program.semanticDigest,
      },
      supportedScope: {
        provider: 'openai',
        model: 'gpt-5',
        runtime: 'codex',
        fixtureIds: ['overhaul'],
      },
      classification: {
        classification: 'insufficient',
      },
      metrics: {
        matchedPairCount: 0,
        integrityIssues: ['one protected run record was malformed'],
      },
      recordIssues: ['one protected run record was malformed'],
    });
  });

  it('distinguishes absent evidence from invalid evidence', () => {
    expect(unavailableMissionEffectiveness('not supplied')).toMatchObject({
      availability: 'unavailable',
      authority: 'none',
      reason: 'not supplied',
      classification: null,
    });
    expect(invalidMissionEffectiveness('bad program')).toMatchObject({
      availability: 'invalid',
      authority: 'none',
      reason: 'bad program',
      classification: null,
    });
  });
});

function programRequest(): MissionTrialProgramRequest {
  return {
    title: 'Mission evidence scope',
    fixedPredecessorCommit: 'b'.repeat(40),
    fixtures: [
      {
        fixtureId: 'overhaul',
        description: 'Replace obsolete dispatch behavior',
        authorizedGoal: 'Feature: obsolete behavior remains unreachable',
        repositoryArchive: { relativePath: 'fixture.tar', sha256: 'a'.repeat(64) },
        protectedEvaluator: { relativePath: 'evaluator.mjs', sha256: 'd'.repeat(64) },
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
