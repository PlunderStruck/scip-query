import type { HealthReport } from '../queries/health/health-report.js';
import type { ProjectCapabilityReport } from './project-readiness.js';

export interface HealthScoreInterpretation {
  status: 'experimental-composite';
  comparableAcrossLanguages: false;
  scope: 'completed-analyses-only';
  note: string;
}

export type HealthReportWithCapability = HealthReport & {
  capabilities: ProjectCapabilityReport;
  scoreInterpretation: HealthScoreInterpretation;
};

const SCORE_INTERPRETATION: HealthScoreInterpretation = {
  status: 'experimental-composite',
  comparableAcrossLanguages: false,
  scope: 'completed-analyses-only',
  note: 'The score summarizes analyses that completed under the attached capability matrix. It is not normalized across languages or frameworks and is not suitable for a public leaderboard.',
};

export function discloseHealthCapabilities(
  report: HealthReport,
  capabilities: ProjectCapabilityReport,
): HealthReportWithCapability {
  const capabilityWarnings = unavailableCapabilityWarnings(capabilities);
  return {
    ...report,
    warnings: [...(report.warnings ?? []), SCORE_INTERPRETATION.note, ...capabilityWarnings],
    capabilities,
    scoreInterpretation: SCORE_INTERPRETATION,
  };
}

function unavailableCapabilityWarnings(capabilities: ProjectCapabilityReport): string[] {
  return capabilities.matrix.flatMap((row) => {
    const unavailable = [row.indexing, row.sourceFacts, row.semantic, row.cleanupVerification]
      .map((capability) => {
        if (/syntax only/i.test(capability.reason)) return `${capability.label}=partial (syntax only)`;
        return capability.status === 'available' ? null : `${capability.label}=${capability.status}`;
      })
      .filter((entry): entry is string => entry !== null);
    return unavailable.length === 0
      ? []
      : [`${row.language} capability limits: ${unavailable.join(', ')}. Unsupported analyses are not clean zeros.`];
  });
}
