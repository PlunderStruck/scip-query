import type { HealthReport } from '../queries/health/health-report.js';
import type { ProjectCapabilityReport } from './project-readiness.js';

export type HealthReportWithCapability = HealthReport & {
  capabilities: ProjectCapabilityReport;
};

export function discloseHealthCapabilities(
  report: HealthReport,
  capabilities: ProjectCapabilityReport,
): HealthReportWithCapability {
  const capabilityWarnings = unavailableCapabilityWarnings(capabilities);
  return {
    ...report,
    warnings: [...(report.warnings ?? []), ...capabilityWarnings],
    capabilities,
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
