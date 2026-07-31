import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMissionTrialProgram, type MissionTrialProgramRequest } from '../../src/domain/mission-trials.js';
import { formatMissionEffectiveness } from '../../src/runtime/mission-effectiveness-render.js';
import { loadMissionEffectiveness } from '../../src/runtime/mission-effectiveness.js';
import { writeMissionTrialProgram } from '../../src/storage/mission-trials.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mission effectiveness loading', () => {
  it('loads only the registered program under the protected root', () => {
    const protectedRoot = temporary('mission-evidence-protected-');
    const candidateRoot = temporary('mission-evidence-candidate-');
    writeFileSync(join(protectedRoot, 'fixture.tar'), 'fixture');
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'evaluator');
    const program = createMissionTrialProgram(programRequest(), {
      now: () => '2026-07-30T12:00:00.000Z',
      toolVersion: '0.20.0',
    });
    const stored = writeMissionTrialProgram(protectedRoot, program);

    const evidence = loadMissionEffectiveness({
      programPath: stored.path,
      protectedRoot,
      candidateRoot,
    });

    expect(evidence).toMatchObject({
      availability: 'available',
      program: { programId: program.programId },
      classification: { classification: 'insufficient' },
    });
    expect(formatMissionEffectiveness(evidence)).toContain(`  Agent parameters SHA-256: ${'c'.repeat(64)}`);
  });

  it('reports absent, partial, and misplaced inputs without inventing evidence', () => {
    const protectedRoot = temporary('mission-evidence-protected-');
    const candidateRoot = temporary('mission-evidence-candidate-');
    const outsideProgram = join(temporary('mission-evidence-other-'), 'program.json');
    writeFileSync(join(protectedRoot, 'fixture.tar'), 'fixture');
    writeFileSync(join(protectedRoot, 'evaluator.mjs'), 'evaluator');
    const program = createMissionTrialProgram(programRequest(), {
      now: () => '2026-07-30T12:00:00.000Z',
      toolVersion: '0.20.0',
    });
    writeMissionTrialProgram(protectedRoot, program);
    writeFileSync(outsideProgram, `${JSON.stringify(program)}\n`);

    expect(loadMissionEffectiveness({ candidateRoot })).toMatchObject({
      availability: 'unavailable',
    });
    expect(loadMissionEffectiveness({ candidateRoot, protectedRoot })).toMatchObject({
      availability: 'invalid',
      reason: expect.stringContaining('requires both'),
    });
    expect(
      loadMissionEffectiveness({
        candidateRoot,
        protectedRoot,
        programPath: outsideProgram,
      }),
    ).toMatchObject({
      availability: 'invalid',
      reason: expect.stringContaining('registered under the protected root'),
    });
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
    title: 'Protected mission evidence',
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
