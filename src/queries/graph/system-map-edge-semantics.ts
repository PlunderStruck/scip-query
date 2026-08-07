import type { ProgramEdgeSemantic } from '../internal/exploration-topology.js';

export const SYSTEM_MAP_RELATION_KINDS = [
  'call',
  'contract-symbol',
  'import',
  'reference',
  'runtime-boundary',
] as const;

export type SystemMapRelationKind = (typeof SYSTEM_MAP_RELATION_KINDS)[number];

export type SystemMapSyntheticEdgeKind = 'structural-membership' | 'boundary-observation' | 'external-import';

interface SystemMapSemanticRuntimeParticipant {
  protocol: string;
}

interface SystemMapSemanticRelation {
  kind: SystemMapRelationKind;
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
  return [
    {
      family: 'control',
      subtype: 'runtime-handoff',
      context: {
        crossesRuntimeBoundary: true,
        ...(protocol ? { protocol } : {}),
        ...(relation.runtimeBoundaryKey ? { runtimeKey: relation.runtimeBoundaryKey } : {}),
      },
    },
  ];
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
