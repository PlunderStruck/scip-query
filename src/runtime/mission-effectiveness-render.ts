import type { MissionEffectivenessEvidence } from '../domain/mission-effectiveness.js';
import { sanitizeTerminalLine } from '../platform/terminal-output.js';

export function formatMissionEffectiveness(evidence: MissionEffectivenessEvidence | undefined): string[] {
  if (!evidence) {
    return ['Mission effectiveness: unavailable — this report predates protected mission-evidence attachment.'];
  }
  if (evidence.availability !== 'available') {
    return [
      `Mission effectiveness: ${evidence.availability} — ${sanitizeTerminalLine(evidence.reason ?? 'no reason recorded')}`,
    ];
  }
  const classification = evidence.classification!;
  const scope = evidence.supportedScope!;
  return [
    `Mission effectiveness: ${classification.classification} (${classification.matchedPairs} matched pair(s), program ${evidence.program!.programId})`,
    `  Supported scope: ${sanitizeTerminalLine(scope.provider)}/${sanitizeTerminalLine(scope.model)} via ${sanitizeTerminalLine(scope.runtime)}; fixtures ${scope.fixtureIds.map(sanitizeTerminalLine).join(', ')}`,
    `  Agent parameters SHA-256: ${scope.parametersSha256}`,
    `  Authority: protected matched trials; detector calibration and health scores remain separate.`,
  ];
}
