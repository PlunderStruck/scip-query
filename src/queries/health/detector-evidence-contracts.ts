import {
  graphRelationProviderFor,
  type GraphRelationEvidenceStrength,
  type GraphRelationProviderRequirement,
  type GraphRelationSupportCeiling,
} from '../../domain/graph-relation-providers.js';
import type { GraphEvidenceFamily } from '../graph/graph-evidence.js';

export type DetectorEvidenceCalibration = 'exact' | 'derived' | 'candidate' | 'mixed' | 'unsupported';

export interface DetectorRelationRequirement {
  family: GraphEvidenceFamily;
  subtype: string;
  minimumStrength: GraphRelationEvidenceStrength;
}

export interface DetectorEvidenceContract {
  id: string;
  detector: string;
  claim: string;
  relationRequirements: readonly DetectorRelationRequirement[];
  structuralEvidence: readonly string[];
  calibration: Exclude<DetectorEvidenceCalibration, 'unsupported'>;
  providerCoverage: GraphRelationSupportCeiling;
  nonClaims: readonly string[];
  recoverWith: string;
}

export interface DetectorEvidenceAssessment extends DetectorEvidenceContract {
  status: DetectorEvidenceCalibration;
  providerIds: string[];
  unavailableRequirements: GraphRelationProviderRequirement[];
}

export const DETECTOR_EVIDENCE_CONTRACTS: readonly DetectorEvidenceContract[] = [
  {
    id: 'dead-visible-references',
    detector: 'dead',
    claim: 'The symbol has no visible repository reference after entry, framework, and rooted-symbol exclusions.',
    relationRequirements: [
      { family: 'identity', subtype: 'references', minimumStrength: 'exact' },
      { family: 'execution', subtype: 'call', minimumStrength: 'exact' },
    ],
    structuralEvidence: [
      'entry-surface exclusions',
      'framework/source fallback references',
      'rooted-symbol exclusions',
    ],
    calibration: 'mixed',
    providerCoverage: 'partial',
    nonClaims: [
      'Absence of visible references does not prove absence of reflection, generated dispatch, or external use.',
    ],
    recoverWith:
      'scip-query evidence --symbol <symbol> --edge execution --edge runtime --edge identity --direction both --depth 2 --max-edges 100',
  },
  {
    id: 'isolated-visible-connectivity',
    detector: 'isolated',
    claim:
      'The callable has no visible non-self caller or callee after entry, framework, and rooted-symbol exclusions.',
    relationRequirements: [
      { family: 'execution', subtype: 'call', minimumStrength: 'exact' },
      { family: 'identity', subtype: 'references', minimumStrength: 'exact' },
    ],
    structuralEvidence: ['entry-surface exclusions', 'framework contract exclusions', 'source fallback callers'],
    calibration: 'mixed',
    providerCoverage: 'partial',
    nonClaims: [
      'Visible graph isolation does not establish runtime unreachability through reflection or generated dispatch.',
    ],
    recoverWith:
      'scip-query evidence --symbol <symbol> --edge execution --edge runtime --edge identity --direction both --depth 2 --max-edges 100',
  },
  {
    id: 'wrapper-indirection-candidate',
    detector: 'wrapper-candidates',
    claim:
      'A small callable has one visible consumer and wrapper-shaped delegation, after boundary evidence is disclosed.',
    relationRequirements: [
      { family: 'execution', subtype: 'call', minimumStrength: 'exact' },
      { family: 'ownership', subtype: 'contains', minimumStrength: 'exact' },
    ],
    structuralEvidence: ['callable body shape', 'public and runtime-boundary signals', 'consumer fan-in'],
    calibration: 'candidate',
    providerCoverage: 'partial',
    nonClaims: [
      'Wrapper shape does not prove that an API, ownership, observability, or compatibility boundary is unnecessary.',
    ],
    recoverWith: 'scip-query inspect --symbol <symbol> --view behavior',
  },
  {
    id: 'passthrough-forwarding-candidate',
    detector: 'passthrough-candidates',
    claim: 'A small callable visibly forwards to one callee, with public-facade and boundary signals disclosed.',
    relationRequirements: [
      { family: 'execution', subtype: 'call', minimumStrength: 'exact' },
      { family: 'contract', subtype: 'uses-contract-symbol', minimumStrength: 'exact' },
    ],
    structuralEvidence: ['statement-complete forwarding shape', 'public facade evidence', 'runtime-boundary signals'],
    calibration: 'mixed',
    providerCoverage: 'partial',
    nonClaims: [
      'Literal forwarding does not prove the callable has no contract, naming, policy, or compatibility role.',
    ],
    recoverWith: 'scip-query inspect --symbol <symbol> --view behavior',
  },
  {
    id: 'stale-abstraction-candidate',
    detector: 'stale-abstractions',
    claim: 'A type-like abstraction has zero or one visible real consumer after re-export and ownership distinctions.',
    relationRequirements: [
      { family: 'identity', subtype: 'references', minimumStrength: 'exact' },
      { family: 'ownership', subtype: 'contains', minimumStrength: 'exact' },
    ],
    structuralEvidence: ['definition kind', 'barrel-only consumer distinction', 'defining-file usage'],
    calibration: 'mixed',
    providerCoverage: 'partial',
    nonClaims: ['Low visible consumer count does not prove a public contract or runtime-registered type is obsolete.'],
    recoverWith:
      'scip-query evidence --symbol <symbol> --edge identity --edge ownership --edge contract --direction both --depth 2 --max-edges 100',
  },
  {
    id: 'complexity-control-pressure',
    detector: 'complexity-hotspots',
    claim: 'A callable concentrates local branch/control pressure and graph fan-in or fan-out.',
    relationRequirements: [
      { family: 'execution', subtype: 'predicate-consequence', minimumStrength: 'exact' },
      { family: 'execution', subtype: 'call', minimumStrength: 'exact' },
    ],
    structuralEvidence: ['AST branch count or disclosed regex fallback', 'call fan-in', 'callee count'],
    calibration: 'mixed',
    providerCoverage: 'partial',
    nonClaims: [
      'Structural complexity does not establish runtime frequency, latency, defect density, or a required refactor.',
    ],
    recoverWith: 'scip-query inspect --symbol <symbol> --view behavior',
  },
  {
    id: 'decorative-checker-terminal-behavior',
    detector: 'decorative-checkers',
    claim: 'A checker-shaped callable lacks a visible failure terminal directly or through one resolved delegate.',
    relationRequirements: [
      { family: 'execution', subtype: 'returns', minimumStrength: 'exact' },
      { family: 'execution', subtype: 'throws', minimumStrength: 'exact' },
    ],
    structuralEvidence: ['checker naming shape', 'direct terminal behavior', 'one-hop delegate body'],
    calibration: 'mixed',
    providerCoverage: 'partial',
    nonClaims: [
      'No visible terminal does not prove the checker cannot fail through an opaque call, exception, or process exit.',
    ],
    recoverWith: 'scip-query inspect --symbol <symbol> --view behavior',
  },
  {
    id: 'duplicate-structural-candidate',
    detector: 'duplicate and similarity detectors',
    claim: 'Two source units share the detector-specific structural or token pattern.',
    relationRequirements: [],
    structuralEvidence: ['normalized source/token/JSX/template similarity'],
    calibration: 'candidate',
    providerCoverage: 'partial',
    nonClaims: ['Structural similarity does not establish shared domain identity or justify consolidation.'],
    recoverWith: 'scip-query inspect --symbol <symbol-a> --symbol <symbol-b> --view behavior',
  },
] as const;

export function assessDetectorEvidenceContracts(
  available: ReadonlySet<GraphRelationProviderRequirement> = new Set(['indexed-graph', 'source-facts']),
): DetectorEvidenceAssessment[] {
  return DETECTOR_EVIDENCE_CONTRACTS.map((contract) => {
    const providers = contract.relationRequirements.map((requirement) => {
      const match = graphRelationProviderFor(requirement.family, requirement.subtype);
      if (!match)
        throw new Error(
          `Detector ${contract.id} names an unregistered relation ${requirement.family}/${requirement.subtype}`,
        );
      if (!match.relation.evidenceStrengths.includes(requirement.minimumStrength)) {
        throw new Error(
          `Detector ${contract.id} requires unsupported strength ${requirement.minimumStrength} for ${requirement.family}/${requirement.subtype}`,
        );
      }
      return match.provider;
    });
    const unavailableRequirements = [...new Set(providers.flatMap((provider) => provider.requirements))].filter(
      (requirement) => !available.has(requirement),
    );
    return {
      ...contract,
      status: unavailableRequirements.length > 0 ? 'unsupported' : contract.calibration,
      providerIds: [...new Set(providers.map((provider) => provider.id))],
      unavailableRequirements,
    };
  });
}

export function renderDetectorEvidenceContractsMarkdown(): string {
  const lines = ['# Detector evidence contracts', '', 'Generated from `DETECTOR_EVIDENCE_CONTRACTS`.', ''];
  for (const contract of DETECTOR_EVIDENCE_CONTRACTS) {
    lines.push(`## ${contract.detector}`, '', contract.claim, '');
    lines.push(`- Calibration: \`${contract.calibration}\`; provider coverage: \`${contract.providerCoverage}\`.`);
    lines.push(
      `- Relations: ${contract.relationRequirements.length ? contract.relationRequirements.map((row) => `\`${row.family}/${row.subtype}\` (${row.minimumStrength})`).join(', ') : 'none; structural detector'}.`,
    );
    lines.push(`- Structural evidence: ${contract.structuralEvidence.join('; ')}.`);
    lines.push(`- Does not establish: ${contract.nonClaims.join(' ')}`);
    lines.push(`- Recover with: \`${contract.recoverWith}\``, '');
  }
  return `${lines.join('\n')}\n`;
}
