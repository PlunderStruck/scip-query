import type { ProgramEdgeSemantic } from '../internal/exploration-topology.js';

export type SystemMapRelationKind = 'call' | 'contract-symbol' | 'import' | 'reference' | 'runtime-boundary';

export const SYSTEM_MAP_RELATION_KINDS = [
  'call',
  'contract-symbol',
  'import',
  'reference',
  'runtime-boundary',
] as const satisfies readonly SystemMapRelationKind[];

export type SystemMapSyntheticEdgeKind = 'structural-membership' | 'boundary-observation' | 'external-import';

interface SystemMapSemanticRuntimeParticipant {
  protocol: string;
  action?: string;
  role?: string;
}

interface SystemMapSemanticRelation {
  kind: SystemMapRelationKind;
  evidence?: string;
  runtimeBoundaryKey?: string;
  fromBoundaryParticipant?: SystemMapSemanticRuntimeParticipant;
  toBoundaryParticipant?: SystemMapSemanticRuntimeParticipant;
}

const STATIC_RELATION_SEMANTICS = {
  call: [{ family: 'control', subtype: 'call' }],
  'contract-symbol': [{ family: 'contract', subtype: 'uses-contract-symbol' }],
  import: [{ family: 'identity', subtype: 'imports' }],
  reference: [{ family: 'identity', subtype: 'references' }],
} as const satisfies Record<Exclude<SystemMapRelationKind, 'runtime-boundary'>, readonly ProgramEdgeSemantic[]>;

const SYNTHETIC_EDGE_SEMANTICS = {
  'structural-membership': [{ family: 'identity', subtype: 'contains' }],
  'boundary-observation': [{ family: 'identity', subtype: 'owns-runtime-observation' }],
  'external-import': [{ family: 'identity', subtype: 'imports-external' }],
} as const satisfies Record<SystemMapSyntheticEdgeKind, readonly ProgramEdgeSemantic[]>;

/** Map one proved system-map relation without claiming data or timing evidence it does not contain. */
export function systemMapRelationProgramSemantics(relation: SystemMapSemanticRelation): ProgramEdgeSemantic[] {
  if (relation.kind !== 'runtime-boundary') return cloneSemantics(STATIC_RELATION_SEMANTICS[relation.kind]);

  const protocol = relation.fromBoundaryParticipant?.protocol ?? relation.toBoundaryParticipant?.protocol;
  const context = {
    crossesRuntimeBoundary: true as const,
    ...(protocol ? { protocol } : {}),
    ...(relation.runtimeBoundaryKey ? { runtimeKey: relation.runtimeBoundaryKey } : {}),
  };
  const semantics: ProgramEdgeSemantic[] = [
    {
      family: 'control',
      subtype: 'runtime-handoff',
      context,
    },
  ];
  if (relation.evidence === 'runtime-boundary:carrier.discriminator') {
    semantics.push({
      family: 'control',
      subtype: 'discriminator-dispatch',
      context: { ...context },
      attributes: {
        joinRule: 'carrier.discriminator',
        ...(relation.fromBoundaryParticipant?.action
          ? { producerAction: relation.fromBoundaryParticipant.action }
          : {}),
        ...(relation.toBoundaryParticipant?.action ? { consumerAction: relation.toBoundaryParticipant.action } : {}),
      },
    });
    semantics.push({
      family: 'data',
      subtype: 'serialized-discriminator-transfer',
      context: { ...context },
      attributes: { joinRule: 'carrier.discriminator' },
    });
  }
  return semantics;
}

/** Map topology-only relationships that do not originate in SystemMapRelation. */
export function systemMapSyntheticEdgeProgramSemantics(kind: SystemMapSyntheticEdgeKind): ProgramEdgeSemantic[] {
  return cloneSemantics(SYNTHETIC_EDGE_SEMANTICS[kind]);
}

function cloneSemantics(semantics: readonly ProgramEdgeSemantic[]): ProgramEdgeSemantic[] {
  return semantics.map((semantic) => ({
    ...semantic,
    ...(semantic.context ? { context: { ...semantic.context } } : {}),
    ...(semantic.attributes ? { attributes: { ...semantic.attributes } } : {}),
  }));
}
