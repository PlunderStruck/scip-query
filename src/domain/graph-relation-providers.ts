import type { GraphEvidenceFamily, GraphProjectionDirection } from './graph-exploration-contract.js';

export type GraphRelationEvidenceStrength = 'exact' | 'derived' | 'candidate' | 'mixed' | 'unknown';
export type GraphRelationSupportCeiling = 'exact' | 'partial' | 'candidate';
export type GraphRelationProviderRequirement = 'indexed-graph' | 'source-facts' | 'typescript-semantic';

export const GRAPH_EVIDENCE_STRENGTH_DEFINITIONS: Readonly<Record<GraphRelationEvidenceStrength, string>> = {
  exact: "Direct compiler or source evidence establishes this relationship within the provider's reported coverage.",
  derived:
    'A deterministic analysis computed this relationship from reported input facts; it was not directly observed.',
  candidate: 'Ambiguous or heuristic evidence identifies a lead that requires exact graph or source confirmation.',
  mixed:
    'The relationship combines evidence of different strengths; its constituent methods and strengths remain disclosed.',
  unknown:
    'The relationship has no calibrated evidence strength and cannot support a stronger claim than its raw observation.',
};

/**
 * One relationship that a concrete analyzer can emit. The subtype matcher
 * connects runtime edge values to the provider that created them; the support
 * ceiling describes analytical coverage, not the strength of one returned
 * edge.
 */
export interface GraphRelationSubtypeContract {
  family: GraphEvidenceFamily;
  subtype: string;
  match?: 'exact' | 'prefix';
  directions: readonly GraphProjectionDirection[];
  evidenceStrengths: readonly GraphRelationEvidenceStrength[];
  supportCeiling: GraphRelationSupportCeiling;
  establishes: string;
  nonClaims: readonly string[];
  recoverWith: readonly string[];
}

/**
 * A graph-relation provider is one implemented analyzer whose availability is
 * determined by named project capabilities and whose emitted relationship
 * subtypes have one executable semantic contract.
 */
export interface GraphRelationProviderContract {
  id: string;
  label: string;
  requirements: readonly GraphRelationProviderRequirement[];
  relations: readonly GraphRelationSubtypeContract[];
}

/**
 * One analysis limit that no registered provider closes. These are capability
 * frontiers, not observed graph edges: they explain which relationship could
 * exist without being present in a projection.
 */
export interface GraphRelationUnavailableFrontier {
  id: string;
  families: readonly GraphEvidenceFamily[];
  capability: string;
  consequence: string;
  recoverWith: readonly string[];
}

export const GRAPH_RELATION_UNAVAILABLE_FRONTIERS: readonly GraphRelationUnavailableFrontier[] = [
  {
    id: 'general-interprocedural-value-flow',
    families: ['dataflow'],
    capability: 'Whole-program definition-use flow through arbitrary calls and returns is unavailable.',
    consequence: 'Missing dataflow edges cannot establish that a value never crosses an unmodeled call.',
    recoverWith: ['value-flow', 'dependence-slice', 'inspect', 'code'],
  },
  {
    id: 'heap-aliasing',
    families: ['dataflow', 'state'],
    capability: 'Heap points-to and cross-instance alias analysis are unavailable.',
    consequence: 'Missing field or state edges cannot establish that two references never reach the same object.',
    recoverWith: ['value-flow', 'dependence-slice', 'inspect', 'code'],
  },
  {
    id: 'exceptional-flow',
    families: ['execution', 'dataflow', 'temporal'],
    capability: 'Interprocedural exception propagation and finally completion flow are unavailable.',
    consequence: 'Normal-path reachability and ordering do not establish behavior after a throw or rejection.',
    recoverWith: ['dependence-slice', 'inspect', 'code'],
  },
  {
    id: 'reflection',
    families: ['execution', 'runtime', 'identity', 'dependencies'],
    capability:
      'Reflective lookup, dynamic loading, and name-computed invocation are unavailable without exact evidence.',
    consequence: 'Missing static edges cannot establish that a construct is unreachable through reflection.',
    recoverWith: ['search', 'inspect', 'code'],
  },
  {
    id: 'generated-dispatch',
    families: ['execution', 'runtime', 'identity'],
    capability: 'Dispatch tables or names created only by generated or unavailable source are unavailable.',
    consequence: 'Missing dispatch edges cannot establish that no generated consumer exists.',
    recoverWith: ['search', 'inspect', 'code'],
  },
  {
    id: 'unsupported-framework-adapters',
    families: ['runtime', 'dataflow', 'state', 'temporal'],
    capability: 'Framework runtime crossings without a registered source adapter are unavailable.',
    consequence:
      'Missing boundary edges cannot establish that no producer, consumer, state effect, or ordering exists.',
    recoverWith: ['search', 'inspect', 'code'],
  },
] as const;

export function graphRelationUnavailableFrontiersFor(
  families: readonly GraphEvidenceFamily[],
): GraphRelationUnavailableFrontier[] {
  const selected = new Set(families);
  return GRAPH_RELATION_UNAVAILABLE_FRONTIERS.filter((frontier) =>
    frontier.families.some((family) => selected.has(family)),
  );
}

export function graphRelationUnavailableBlindSpots(families: readonly GraphEvidenceFamily[]): string[] {
  return graphRelationUnavailableFrontiersFor(families).map(
    (frontier) =>
      `[${frontier.id}] ${frontier.capability} ${frontier.consequence} Recover selected paths with: ${frontier.recoverWith
        .map((command) => `scip-query ${command}`)
        .join(', ')}.`,
  );
}

const BOTH = ['incoming', 'outgoing', 'both'] as const;

function relation(
  family: GraphEvidenceFamily,
  subtype: string,
  establishes: string,
  options: {
    match?: 'exact' | 'prefix';
    strengths?: readonly GraphRelationEvidenceStrength[];
    supportCeiling?: GraphRelationSupportCeiling;
    nonClaims?: readonly string[];
    recoverWith?: readonly string[];
  } = {},
): GraphRelationSubtypeContract {
  return {
    family,
    subtype,
    ...(options.match ? { match: options.match } : {}),
    directions: BOTH,
    evidenceStrengths: options.strengths ?? ['exact', 'derived', 'mixed'],
    supportCeiling: options.supportCeiling ?? 'partial',
    establishes,
    nonClaims: options.nonClaims ?? [],
    recoverWith: options.recoverWith ?? ['inspect', 'code'],
  };
}

export const PARSER_CONTROL_RELATION_SUBTYPES = [
  'predicate-consequence',
  'predicate-alternative',
  'predicate-fallthrough',
  'predicate-case',
  'predicate-default',
  'predicate-return',
  'predicate-throw',
  'loop-iteration',
  'loop-exit',
  'exception-handler',
  'finally-cleanup',
  'handler-return',
  'handler-throw',
] as const;
export type ParserControlRelationSubtype = (typeof PARSER_CONTROL_RELATION_SUBTYPES)[number];

export const PARSER_STATE_VALUE_RELATION_SUBTYPES = [
  'captured-value-to-state',
  'constant-to-state',
  'expression-to-state',
  'property-to-state',
  'return-to-state',
  'value-to-state',
] as const;
export type ParserStateValueRelationSubtype = (typeof PARSER_STATE_VALUE_RELATION_SUBTYPES)[number];

export const PARSER_TEMPORAL_RELATION_SUBTYPES = [
  'await-completion-before',
  'awaits-completion',
  'inside-lock-scope',
  'lexical-successor',
] as const;
export type ParserTemporalRelationSubtype = (typeof PARSER_TEMPORAL_RELATION_SUBTYPES)[number];

export const GRAPH_RELATION_PROVIDER_CONTRACTS: readonly GraphRelationProviderContract[] = [
  {
    id: 'indexed-program-identity',
    label: 'SCIP/compiler identity and source ownership',
    requirements: ['indexed-graph'],
    relations: [
      relation('execution', 'call', 'The source construct may call the resolved target.', {
        nonClaims: ['Static may-call reachability does not prove that an invocation occurred at runtime.'],
        recoverWith: ['call-graph', 'inspect', 'code'],
      }),
      relation(
        'execution',
        'result-callback',
        'The referenced callable can produce the result consumed by this path.',
        {
          nonClaims: ['A callback relationship does not prove invocation order or runtime selection.'],
          recoverWith: ['call-graph', 'inspect', 'code'],
        },
      ),
      relation('contract', 'uses-contract-symbol', 'The source construct refers to the identified contract symbol.', {
        supportCeiling: 'exact',
        nonClaims: ['Contract identity does not prove runtime invocation or behavioral conformance.'],
        recoverWith: ['hierarchy', 'inspect', 'code'],
      }),
      relation('identity', 'references', 'The occurrence resolves to the identified compiler-owned symbol.', {
        supportCeiling: 'exact',
        nonClaims: ['A reference does not establish execution or value transfer.'],
        recoverWith: ['refs', 'trace', 'inspect'],
      }),
      relation('ownership', 'contains', 'The owner contains the identified program construct.', {
        supportCeiling: 'exact',
        nonClaims: ['Structural containment does not establish runtime lifetime or sharing scope.'],
        recoverWith: ['outline', 'inspect'],
      }),
      relation('ownership', 'contains-', 'The owner contains the identified program construct.', {
        match: 'prefix',
        supportCeiling: 'exact',
        nonClaims: ['Structural containment does not establish runtime lifetime or sharing scope.'],
        recoverWith: ['outline', 'inspect'],
      }),
      relation('ownership', 'owns-', 'The owner owns the identified source or runtime observation.', {
        match: 'prefix',
        supportCeiling: 'exact',
        nonClaims: ['Observation ownership does not establish singleton lifetime or exclusive ownership.'],
        recoverWith: ['inspect', 'code'],
      }),
      relation('dependencies', 'imports', 'The source file or module statically imports the indexed target.', {
        nonClaims: ['An import does not establish that imported code executes.'],
        recoverWith: ['imports', 'deps', 'code'],
      }),
      relation('dependencies', 'imports-external', 'The source region statically imports an external package.', {
        nonClaims: ['An external import does not establish which package behavior executes.'],
        recoverWith: ['imports', 'code'],
      }),
    ],
  },
  {
    id: 'runtime-boundary-join',
    label: 'source-grounded runtime-boundary joins',
    requirements: ['indexed-graph', 'source-facts'],
    relations: [
      relation('runtime', 'runtime-handoff', 'A producer and consumer share a source-grounded runtime rendezvous.', {
        strengths: ['exact', 'derived', 'candidate', 'mixed'],
        nonClaims: ['A candidate or unresolved join does not prove a runtime handoff.'],
        recoverWith: ['evidence', 'inspect', 'code'],
      }),
      relation('runtime', 'discriminator-dispatch', 'A serialized discriminator selects the reported consumer.', {
        strengths: ['exact', 'derived', 'mixed'],
        nonClaims: ['The dispatch edge does not prove delivery, retry, or successful handling.'],
        recoverWith: ['evidence', 'inspect', 'code'],
      }),
      relation(
        'dataflow',
        'serialized-discriminator-transfer',
        'The producer serializes the discriminator consumed by dispatch.',
        {
          strengths: ['exact', 'derived', 'mixed'],
          nonClaims: ['This edge does not establish the flow of every payload field.'],
          recoverWith: ['value-flow', 'inspect', 'code'],
        },
      ),
      relation(
        'temporal',
        'enqueue-before-consume',
        'The reported enqueue precedes a possible consume through the queue.',
        {
          strengths: ['exact', 'derived', 'mixed'],
          nonClaims: ['Queue order does not establish delivery time, uniqueness, retry count, or durability.'],
          recoverWith: ['evidence', 'inspect', 'code'],
        },
      ),
    ],
  },
  {
    id: 'parser-control-dependence',
    label: 'parser-proved intraprocedural control dependence',
    requirements: ['indexed-graph', 'source-facts'],
    relations: [
      ...PARSER_CONTROL_RELATION_SUBTYPES.map((subtype) =>
        relation('execution', subtype, 'The outcome is control-dependent on the reported predicate or handler.', {
          strengths: ['exact'],
          nonClaims: ['Local control dependence does not establish that the containing function executes.'],
          recoverWith: ['dependence-slice', 'inspect', 'code'],
        }),
      ),
      relation('execution', 'returns', 'The selected construct contains the reported return terminal.', {
        strengths: ['exact'],
        nonClaims: ['A local return terminal does not establish that the containing callable executes.'],
        recoverWith: ['inspect', 'code'],
      }),
      relation('execution', 'throws', 'The selected construct contains the reported throw terminal.', {
        strengths: ['exact'],
        nonClaims: ['A local throw terminal does not establish propagation, handling, or callable execution.'],
        recoverWith: ['inspect', 'code'],
      }),
    ],
  },
  {
    id: 'bounded-static-value-flow',
    label: 'compiler callsites and bounded static value evaluation',
    requirements: ['indexed-graph', 'source-facts'],
    relations: [
      ...[
        'argument-to-parameter',
        'constant-to-parameter',
        'property-to-parameter',
        'return-to-parameter',
        'return-to-call-result',
      ].map((subtype) =>
        relation(
          'dataflow',
          subtype,
          'The reported value may reach the target through the evidenced callsite transfer.',
          {
            strengths: ['exact', 'derived', 'mixed'],
            nonClaims: ['This provider does not establish general local definition-use, alias, field, or heap flow.'],
            recoverWith: ['value-flow', 'dependence-slice', 'inspect', 'code'],
          },
        ),
      ),
    ],
  },
  {
    id: 'typescript-local-dependence',
    label: 'TypeScript compiler identities, control-flow graph, and reaching definitions',
    requirements: ['typescript-semantic'],
    relations: [
      relation(
        'dataflow',
        'definition-to-use',
        'The definition reaches the reported read on a feasible local control-flow path.',
        {
          strengths: ['exact'],
          nonClaims: [
            'Local reaching definitions do not establish heap aliasing, exceptional flow, or the runtime order of closure invocation.',
          ],
          recoverWith: ['value-flow', 'dependence-slice', 'inspect', 'code'],
        },
      ),
      relation(
        'dataflow',
        'value-to-definition',
        'The reported right-hand-side read supplies the assigned local definition.',
        {
          strengths: ['exact'],
          nonClaims: ['A local assignment edge does not establish field or heap points-to flow.'],
          recoverWith: ['value-flow', 'dependence-slice', 'inspect', 'code'],
        },
      ),
      relation(
        'dataflow',
        'closure-capture',
        'The nested callable reads the reported binding from an enclosing callable.',
        {
          strengths: ['candidate'],
          supportCeiling: 'candidate',
          nonClaims: ['Closure capture does not establish whether or when the nested callable executes.'],
          recoverWith: ['call-graph', 'inspect', 'code'],
        },
      ),
      relation(
        'dataflow',
        'field-definition-to-use',
        'The reported same-owner field definition can reach the field read.',
        {
          strengths: ['exact', 'candidate'],
          nonClaims: ['Field-name identity does not establish whole-program heap aliasing or cross-instance flow.'],
          recoverWith: ['value-flow', 'dependence-slice', 'inspect', 'code'],
        },
      ),
      relation(
        'execution',
        'control-dependence',
        'Execution of the reported statement depends on the outcome of the predicate.',
        {
          strengths: ['exact'],
          nonClaims: ['Intraprocedural control dependence does not establish that the containing callable executes.'],
          recoverWith: ['dependence-slice', 'inspect', 'code'],
        },
      ),
    ],
  },
  {
    id: 'parser-state-temporal',
    label: 'parser-proved local state and temporal facts',
    requirements: ['indexed-graph', 'source-facts'],
    relations: [
      ...PARSER_STATE_VALUE_RELATION_SUBTYPES.map((subtype) =>
        relation('dataflow', subtype, 'The reported source value is assigned into the identified state resource.', {
          strengths: ['exact'],
          nonClaims: ['The edge does not establish alias, heap, or later read flow.'],
          recoverWith: ['value-flow', 'inspect', 'code'],
        }),
      ),
      ...['writes-resource', 'deletes-resource', 'reads-resource', 'enqueues-resource', 'consumes-resource'].map(
        (subtype) =>
          relation(
            'state',
            subtype,
            'The reported construct performs the named operation on the identified resource.',
            {
              strengths: ['exact'],
              nonClaims: ['A state operation does not establish transactionality, durability, or exclusive ownership.'],
              recoverWith: ['evidence', 'inspect', 'code'],
            },
          ),
      ),
      ...PARSER_TEMPORAL_RELATION_SUBTYPES.map((subtype) =>
        relation('temporal', subtype, 'The reported source constructs have the named local ordering relationship.', {
          strengths: ['exact'],
          nonClaims: ['Local source order does not establish cross-process happens-before or durable completion.'],
          recoverWith: ['evidence', 'inspect', 'code'],
        }),
      ),
    ],
  },
] as const;

export function graphRelationProviderFor(
  family: GraphEvidenceFamily,
  subtype: string,
): { provider: GraphRelationProviderContract; relation: GraphRelationSubtypeContract } | null {
  const matches = GRAPH_RELATION_PROVIDER_CONTRACTS.flatMap((provider) =>
    provider.relations
      .filter(
        (candidate) =>
          candidate.family === family &&
          (candidate.match === 'prefix' ? subtype.startsWith(candidate.subtype) : subtype === candidate.subtype),
      )
      .map((candidate) => ({ provider, relation: candidate })),
  );
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous graph relation provider for ${family}/${subtype}: ${matches.map((row) => row.provider.id).join(', ')}`,
    );
  }
  return matches[0] ?? null;
}
