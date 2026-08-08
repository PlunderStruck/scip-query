import { GRAPH_EVIDENCE_FAMILIES, type GraphEvidenceFamily } from './graph-exploration-contract.js';
import { GRAPH_RELATION_PROVIDER_CONTRACTS, type GraphRelationSubtypeContract } from './graph-relation-providers.js';

export interface GraphRelationContract {
  family: GraphEvidenceFamily;
  establishes: string;
  nonClaims: readonly string[];
  providers: readonly string[];
  relations: ReadonlyArray<GraphRelationSubtypeContract & { providerId: string; providerLabel: string }>;
}

const CONTRACTS = {
  execution: {
    establishes: 'Static may-call reachability between resolved program constructs.',
    nonClaims: ['A may-call edge does not prove that a runtime invocation occurred.'],
  },
  runtime: {
    establishes: 'A source-grounded handoff between producer and consumer participants through a runtime mechanism.',
    nonClaims: ['An unresolved or candidate join does not prove a runtime handoff.'],
  },
  dataflow: {
    establishes:
      'A value, definition, argument, parameter, return, or statically resolved value may flow to another construct.',
    nonClaims: ['Current partial providers do not establish general interprocedural definition-use coverage.'],
  },
  state: {
    establishes: 'A construct reads, writes, creates, deletes, or otherwise changes an identified state resource.',
    nonClaims: ['A state edge does not prove transactionality, durability, or exclusive ownership unless qualified.'],
  },
  temporal: {
    establishes:
      'One observed construct is locally ordered before or after another under the reported source evidence.',
    nonClaims: ['Source order does not imply cross-process happens-before or durability.'],
  },
  contract: {
    establishes: 'A program construct implements, constrains, or is typed by an identified contract.',
    nonClaims: ['Contract identity does not prove runtime invocation or conformance outside reported checks.'],
  },
  identity: {
    establishes: 'Two observations refer to the same compiler-owned or source-owned program entity.',
    nonClaims: ['Shared identity does not establish execution or value transfer.'],
  },
  ownership: {
    establishes:
      'A source construct, symbol, runtime observation, or state resource is contained or owned by another program entity.',
    nonClaims: [
      'Structural ownership does not establish lifetime, singleton scope, or runtime execution unless qualified.',
    ],
  },
  dependencies: {
    establishes: 'A file, module, or symbol statically relies on another indexed entity.',
    nonClaims: ['A dependency edge does not establish that the depended-on code executes.'],
  },
} as const satisfies Record<GraphEvidenceFamily, Pick<GraphRelationContract, 'establishes' | 'nonClaims'>>;

function providerRelationsFor(
  family: GraphEvidenceFamily,
): Array<GraphRelationSubtypeContract & { providerId: string; providerLabel: string }> {
  return GRAPH_RELATION_PROVIDER_CONTRACTS.flatMap((provider) =>
    provider.relations
      .filter((relation) => relation.family === family)
      .map((relation) => ({ ...relation, providerId: provider.id, providerLabel: provider.label })),
  );
}

function providersFor(family: GraphEvidenceFamily): string[] {
  return [
    ...new Set(
      GRAPH_RELATION_PROVIDER_CONTRACTS.filter((provider) =>
        provider.relations.some((relation) => relation.family === family),
      ).map((provider) => provider.label),
    ),
  ];
}

export const GRAPH_RELATION_CONTRACTS: readonly GraphRelationContract[] = GRAPH_EVIDENCE_FAMILIES.map((family) => ({
  family,
  ...CONTRACTS[family],
  providers: providersFor(family),
  relations: providerRelationsFor(family),
}));

export function graphRelationContract(family: GraphEvidenceFamily): GraphRelationContract {
  return {
    family,
    ...CONTRACTS[family],
    providers: providersFor(family),
    relations: providerRelationsFor(family),
  };
}
