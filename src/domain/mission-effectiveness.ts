import { classifyMissionTrialReport, type MissionTrialClassificationResult } from './mission-trial-classification.js';
import { deriveMissionTrialMetrics, type MissionTrialMetricReport } from './mission-trial-metrics.js';
import type { MissionTrialProgramV1, MissionTrialRunV1 } from './mission-trials.js';

export const MISSION_EFFECTIVENESS_EVIDENCE_VERSION = 1 as const;

export type MissionEffectivenessAvailability = 'available' | 'unavailable' | 'invalid';

export interface MissionEffectivenessEvidence {
  version: typeof MISSION_EFFECTIVENESS_EVIDENCE_VERSION;
  capability: 'autonomous-completion-v1';
  availability: MissionEffectivenessAvailability;
  authority: 'protected-matched-trials' | 'none';
  reason: string | null;
  program: {
    programId: string;
    semanticDigest: string;
    title: string;
    fixedPredecessorCommit: string;
  } | null;
  supportedScope: {
    provider: string;
    model: string;
    runtime: string;
    parametersSha256: string;
    fixtureIds: readonly string[];
  } | null;
  classification: MissionTrialClassificationResult | null;
  metrics: MissionTrialMetricReport | null;
  runIds: readonly string[];
  recordIssues: readonly string[];
}

export function unavailableMissionEffectiveness(reason: string): MissionEffectivenessEvidence {
  return emptyMissionEffectiveness('unavailable', reason);
}

export function invalidMissionEffectiveness(reason: string): MissionEffectivenessEvidence {
  return emptyMissionEffectiveness('invalid', reason);
}

export function deriveMissionEffectiveness(
  program: MissionTrialProgramV1,
  runs: readonly MissionTrialRunV1[],
  recordIssues: readonly string[] = [],
): MissionEffectivenessEvidence {
  const derived = deriveMissionTrialMetrics(program, runs);
  const metrics =
    recordIssues.length === 0
      ? derived
      : {
          ...derived,
          integrityIssues: [...new Set([...derived.integrityIssues, ...recordIssues])].sort(),
        };
  return {
    version: MISSION_EFFECTIVENESS_EVIDENCE_VERSION,
    capability: 'autonomous-completion-v1',
    availability: 'available',
    authority: 'protected-matched-trials',
    reason: null,
    program: {
      programId: program.programId,
      semanticDigest: program.semanticDigest,
      title: program.title,
      fixedPredecessorCommit: program.fixedPredecessorCommit,
    },
    supportedScope: {
      ...program.agent,
      fixtureIds: program.fixtures.map((fixture) => fixture.fixtureId),
    },
    classification: classifyMissionTrialReport(program, metrics),
    metrics,
    runIds: metrics.rawSamples.map((sample) => sample.runId),
    recordIssues: [...recordIssues].sort(),
  };
}

function emptyMissionEffectiveness(
  availability: Exclude<MissionEffectivenessAvailability, 'available'>,
  reason: string,
): MissionEffectivenessEvidence {
  return {
    version: MISSION_EFFECTIVENESS_EVIDENCE_VERSION,
    capability: 'autonomous-completion-v1',
    availability,
    authority: 'none',
    reason,
    program: null,
    supportedScope: null,
    classification: null,
    metrics: null,
    runIds: [],
    recordIssues: [],
  };
}
