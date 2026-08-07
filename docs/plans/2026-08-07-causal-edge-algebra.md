# Causal Edge Algebra and Current SkipQuery Capabilities

**Status:** Design direction and current-state inventory  
**Date:** 2026-08-07  
**Purpose:** Define the repository-independent relationship model that should drive accurate, token-efficient exploration, record what SkipQuery can already derive, and identify the machinery still missing.

## The decision

SkipQuery should represent program knowledge through six semantic relationship families:

1. **Identity** — which program entities are the same entity, own another entity, or resolve to one another.
2. **Contract** — which declarations constrain the values or behavior another entity may accept, provide, or substitute for.
3. **Control** — which event, condition, or operation can cause another operation to execute or prevent it from executing.
4. **Data** — which value or computation can influence another value or computation.
5. **State** — which operation observes or changes a resource whose value can outlive that operation.
6. **Temporal** — which operation must occur before, after, during, exclusively with, or eventually because of another operation.

These are the closed **top-level families** we should design around. Their subtypes are deliberately extensible. A new framework may introduce a new subtype or a new way to prove an existing subtype, but it should not require a new top-level family merely because it uses a different API name.

This is a design hypothesis, not a claim of mathematical proof. It remains valid only while every supported program relationship can be translated into these families without losing information needed to answer a material question. A construct that cannot be translated is evidence that the algebra must be revised, not something to force into the nearest category.

SkipQuery should preserve the existing analyzers and add a canonical projection over their results. The projection gives exploration and rendering one shared vocabulary while retaining the original analyzer, evidence strength, source location, and coverage limitations.

## Essential concepts

A **program relationship** is an evidenced connection between two identifiable program facts. What distinguishes it from mere textual proximity is that a compiler, parser, framework extractor, or explicit derivation establishes why the two facts are connected.

A **primitive family** is a broad kind of program relationship that describes the fundamental way one fact bears on another. It is not tied to a language feature or framework API. `control` is primitive in this sense; `HTTP request` is not, because an HTTP request combines control and data relationships across execution contexts.

A **composite relationship** is a useful, named program construct whose behavior is explained by several primitive edges plus contextual annotations. A function call, database write, registry dispatch, queue message, transaction, or lock is a composite relationship.

An **answer-determinative fact** is repository evidence whose alteration could change the truth or category of a material claim in the answer. If removing a predicate could change whether an operation is authorized, that predicate is answer-determinative. If removing a constant could change a hard limit, that constant is answer-determinative. Token compression may fold other evidence, but it must not silently omit these facts.

A **causal corridor** is the smallest evidenced subgraph connecting the selected anchors to the observable outcomes that can answer the question, closed over the facts required to interpret those paths correctly. It is not simply the shortest path: it must include complete predicates, required constants and defaults, relevant sibling outcomes, failure and cleanup paths, runtime participants, and explicit unresolved frontiers.

An **unresolved frontier** is a disclosed place where a potentially relevant relationship leaves current proof coverage. It says that the analyzer could not establish what happens next. It is not evidence that no relationship exists.

## Why this is the appropriate level of abstraction

The top-level families should be stable; language and framework vocabulary should live in subtypes and evidence methods. Otherwise every new transport, database, registry, scheduler, or dependency-injection framework expands an endless flat taxonomy.

Examples:

| Program construct     | Primitive explanation                                                                                                                  | Context that must be retained                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Direct function call  | control from caller to callee; data from arguments to parameters; data from return to receiver; exceptional control back to the caller | dispatch kind and exact callable identity                  |
| HTTP request          | control and serialized data crossing execution contexts                                                                                | method, route, producer, consumer, process or service      |
| Queue publish/consume | data written into a message; state change in the queue; later control of a consumer; temporal separation                               | queue/topic key, message discriminator, delivery semantics |
| Database write        | data changing persistent state; temporal placement relative to reads, commits, or rollback                                             | resource identity, operation kind, transaction             |
| Registry dispatch     | state establishing a key-to-handler association; data selecting the key; control transferring to the resolved handler                  | registry identity, key, registration and lookup sites      |
| Lock                  | state representing ownership plus temporal exclusion of competing operations                                                           | lock identity, protected scope, acquire/release paths      |
| Retry                 | repeated control plus a temporal relation between attempts                                                                             | trigger, bound/backoff, terminal outcome                   |

`runtime-boundary` should therefore remain a valuable composite and query concept, but not become a seventh primitive family. It annotates control and data edges that cross execution contexts and records the protocol-specific evidence that joins the participants.

Likewise, an **effect** should describe an operation or endpoint—such as a database write, emitted event, response, or exception—not act as an undifferentiated primitive edge. The graph should say what changes, what value reaches it, and under what control and temporal conditions.

## What SkipQuery exposes today

### User-visible relationship surfaces

`system-map` currently exposes five selectable relation kinds:

- `call`
- `contract-symbol`
- `import`
- `reference`
- `runtime-boundary`

The CLI also exposes specialized graph surfaces rather than routing every relationship through `system-map`:

- `call-graph`, `entrypoints`, and `entry-map` for executable reachability.
- `dataflow` for definition sites, usage sites, producers, and consumers.
- `slice` for backward and forward reference-level influence.
- `refs`, `trace`, `evidence`, `hierarchy`, `members`, `imports`, `imported-by`, `deps`, `rdeps`, and `surface` for compiler identity, ownership, references, module use, and public consumption.
- `architecture` for project-owned dependency rules.
- `affected`, `change-surface`, and `diff-impact` for downstream change exposure.
- Heuristic commands for similarity and cleanup candidates. These are leads and must remain separate from exact and derived program facts.

The current project has SCIP indexing for TypeScript and Rust, semantic providers through ts-morph and rust-analyzer, source fallbacks, and heuristic cleanup detectors. These capabilities differ by language and evidence source, so the canonical graph must retain how each edge was proved.

### Current implementation evidence

The following inventory records what is present, not what the proposed design assumes:

| Existing capability                                                  | What it can establish today                                                                                                                                       | Semantic family projection                                          | Current limitation                                                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| SCIP symbol definitions and occurrences                              | Exact compiler identities, definitions, references, and some exact callsites                                                                                      | identity; control for eligible callsites                            | Coverage depends on the indexer and indexed language. Dynamic or source-only constructs need fallback evidence.                                       |
| AST/source callsite derivation                                       | Caller-to-callee relationships when compiler call evidence is absent or incomplete                                                                                | control, with argument/return data added where proved               | Many member calls remain unresolved; derived evidence must not be presented as exact.                                                                 |
| Imports, re-exports, dependencies, consumers, hierarchy, and members | Structural ownership and module dependency relationships                                                                                                          | identity and contract context                                       | A file dependency does not itself prove runtime control or value flow.                                                                                |
| `contract-symbol` topology                                           | A symbol-level contract relationship available to `system-map`                                                                                                    | contract                                                            | It is not yet one unified model for type conformance, API compatibility, schemas, and runtime validation.                                             |
| `dataflow` and forward/backward `slice`                              | Reference-level producers, consumers, and influence paths                                                                                                         | data                                                                | The results are a specialized surface and are not yet fused with control, state, runtime, and temporal edges in one causal corridor.                  |
| Connected behavior                                                   | Ordered source evidence with construct ownership and tags such as branch, call, await, mutation, return, throw, catch, and finally                                | evidence for control, state, and temporal edges                     | These are primarily rendered statement facts. Branch control dependence, resource state, and temporal guarantees are not all first-class graph edges. |
| Runtime-boundary observations and relation groups                    | Protocol, action, role, strength, source scope, resolution, owner symbol, location, producer/consumer/declaration participants, and unresolved frontiers          | annotated control, data, and sometimes state/temporal relationships | Exact coverage depends on supported extractors and join proofs. Unsupported frameworks, reflection, and unresolved dispatch remain frontiers.         |
| Runtime carrier discriminator propagation                            | Parameter value flow through resolved callsites, with proof spans and bounded propagation                                                                         | data joined to identity and control                                 | This machinery is currently specialized for runtime-boundary extraction rather than reusable as the general data-edge layer.                          |
| Database work-queue derivation                                       | `database.write`/`persistence-insert` and `database.read`/`persistence-skip-locked-claim` observations matched by resource and reclassified as queue send/consume | state, data, control, and temporal composite                        | It recognizes a specific evidenced pattern; it is not yet a general persistent-resource and scheduling model.                                         |
| Architecture dependency graph                                        | Imported boundaries, permitted reachability, and violations                                                                                                       | identity/contract context                                           | Architectural permission is not proof that execution or data flow occurs.                                                                             |
| Heuristic detectors                                                  | Similarity, wrapper, drift, extraction, and cleanup candidates                                                                                                    | none until confirmed; navigation leads only                         | Heuristics must never silently enter the causal corridor as facts.                                                                                    |

Concrete examples from the current implementation:

- Runtime graphs persist observations with `protocol`, `action`, `role`, `strength`, `source_scope`, `resolution`, exact source range, and `owner_symbol`, then persist producer, consumer, and declaration participants in relation groups (`src/analysis/runtime-boundaries/storage.ts:10-68`).
- The runtime augmentation reuses a stored graph when its extractor version matches, otherwise collects it and reports observations, links, unresolved frontiers, files scanned, and extraction errors (`src/reindex/runtime-boundaries.ts:22-77`).
- Carrier analysis propagates serialized-body parameter positions backward through resolved callsites using `parameterValueFlowAtCall`, with a bounded depth of eight and retained proof spans (`src/analysis/runtime-boundaries/carrier-discriminators.ts:74-122`).
- The database work-queue adapter matches persistent insert and skip-locked claim observations by resource and derives `queue.send` and `queue.consume` observations (`src/analysis/runtime-boundaries/database-work-queues.ts:9-39`).
- The source behavior renderer already preserves constructs and ordered statement evidence, including branches, calls, awaits, mutation, returns, throws, catch, and finally. This was visible in `reindex` at `src/reindex/index.ts:305` and the exact write transaction at `src/analysis/runtime-boundaries/storage.ts:10-68`.
- The current slice entry point chooses a backward or forward reference-level slice and delegates to the corresponding analyzer (`src/queries/navigation/slice.ts:33-48`).

## Coverage by proposed family

### 1. Identity — strong but fragmented

SkipQuery already has compiler symbols, definitions, occurrences, construct ownership, hierarchy, members, imports, file regions, and owner symbols on runtime observations. This is enough to serve as the backbone of a canonical identity layer.

Missing work:

- Normalize compiler symbols, source-owned constructs, runtime observations, resources, and external participants into stable node identities.
- Project aliases, re-exports, containment, implementation ownership, and runtime participant identity into explicit subtypes.
- Preserve ambiguity rather than selecting one identity when dispatch cannot be proved.

### 2. Contract — partial

SkipQuery exposes `contract-symbol`, public surfaces, imports, signatures, semantic providers, and architecture rules. These describe different constraints but are not yet one composable contract graph.

Missing work:

- Add explicit subtypes for declares, exports, imports, extends, implements, type-of, conforms-to, validates, serializes-as, and schema-consumer relationships where the language provider can prove them.
- Keep architecture permission separate from type or runtime compatibility.
- Represent incomplete language-provider coverage explicitly.

### 3. Control — strong for calls, partial for conditions and dispatch

Calls, callers, callees, entry points, entry maps, runtime participants, throws, and returns already exist across graph and behavior surfaces.

Missing work:

- Add first-class branch-control edges from complete predicates to the operations they govern.
- Model returns, exceptions, callbacks, registry dispatch, and runtime transitions as explicit control subtypes.
- Retain every relevant sibling outcome so a selected path does not erase rejection, no-op, rollback, or cleanup behavior.

### 4. Data — useful machinery exists but is not unified

Reference-level dataflow and slicing exist. Runtime carrier analysis already propagates parameter positions through resolved callsites and retains proof spans. This shows that reusable argument-to-parameter machinery is feasible.

Missing work:

- Unify definition/use, assignment, argument-to-parameter, return-to-receiver, property/field, captured value, serialization, message payload, and persistent-value edges.
- Carry constants, defaults, discriminators, bounds, and identity fields into a corridor whenever they can change a material claim.
- Join data edges to call and runtime transitions instead of returning them as a separate exploration surface.

### 5. State — partial and pattern-specific

Connected behavior identifies mutations, and runtime extractors identify some database reads/writes, queue operations, and protocol observations. Database queue derivation already matches operations through a resource key.

Missing work:

- Introduce stable resource nodes for variables, object fields, registries, files, database tables/rows where resolvable, queues/topics, caches, and external resources.
- Emit reads, writes, creates, deletes, mutates, publishes, and consumes edges with exact operation and record-identity fields.
- Distinguish durable state changes from in-memory mutation and merely attempted writes.
- Keep resource alias uncertainty visible.

### 6. Temporal — weakest

Source order, `await`, try/catch/finally structure, database transactions, locks, retries, and queue patterns can be observed in parts of the current source and analyzer output. `temporal` is not currently a `system-map` relation, and the anchor query found no normalized repository vocabulary for it. SkipQuery does not yet expose one general temporal graph.

Missing work:

- Emit explicit program-order and await-completion edges where semantics are exact.
- Model lock acquire/release and protected scope as mutual exclusion, not merely calls to lock helpers.
- Model transaction membership, commit, rollback, and atomicity evidence.
- Model spawn/join, enqueue/consume, retry, timeout, compensation, and later repair as subtypes with appropriate evidence strength.
- Never infer ordering solely from nearby lines when concurrency or callbacks can invalidate it.

## Canonical edge representation

The precise TypeScript shape may change during implementation, but the semantic contract should resemble:

```ts
interface ProgramEdge {
  family: 'identity' | 'contract' | 'control' | 'data' | 'state' | 'temporal';
  subtype: string;
  from: NodeId;
  to: NodeId;
  context?: {
    crossesRuntimeBoundary?: boolean;
    process?: string;
    protocol?: string;
    transaction?: string;
    synchronizationScope?: string;
  };
  evidence: {
    strength: 'exact' | 'derived' | 'candidate';
    method: string;
    location: SourceLocation;
    proofSpans?: readonly SourceLocation[];
  };
  coverage: {
    status: 'complete' | 'bounded' | 'unsupported' | 'ambiguous';
    frontierId?: string;
  };
}
```

The edge must not discard the source analyzer's richer payload. The canonical representation is an index and traversal contract; protocol-specific observations, compiler facts, and proof objects remain available for rendering and verification.

## How arbitrary exploration should use the graph

1. Convert the user's request into explicit material claims, without asking a model to invent repository-specific stages.
2. Locate initial anchors through exact literals/symbols or evidence-attributed repository vocabulary.
3. Find observable outcomes relevant to the claim categories: returned values, externally visible effects, durable state changes, notifications, failures, and cleanup.
4. Traverse forward from the anchors and backward from the outcomes over the applicable control, data, state, and temporal edges.
5. Intersect and rank those traversals to form candidate causal corridors.
6. Close each corridor over identity and contract facts, complete predicates, referenced constants/defaults, relevant sibling outcomes, failure/cleanup, and runtime participants.
7. Render the smallest complete abstraction that preserves every answer-determinative fact.
8. Emit every omitted direction as recoverably folded, explicitly excluded, unsupported, ambiguous, or unresolved.

The graph determines what is causally connected. It does not determine which connection matters to the user's question. Relevance remains a selection judgment constrained by material claims and coverage; the CLI must not hide uncertainty behind a relevance score.

## Implementation sequence

### Slice 0: Lock the current benchmark and evidence contracts

- Preserve the current proven benchmark baseline and strict fact rubric.
- Add fixtures demonstrating every existing `system-map` relation and specialized graph surface.
- Record exact/derived/candidate behavior and current frontiers before changing traversal.

### Slice 1: Add the canonical schema and adapters

- Define canonical nodes, the six edge families, open subtypes, evidence provenance, and coverage.
- Adapt existing call, contract-symbol, import, reference, runtime-boundary, compiler ownership, dataflow, and slice results without changing existing command output.
- Add an inventory command or diagnostic that reports available edge families, subtypes, evidence methods, and per-language support.

### Slice 2: Complete control dependence

- Derive exact control edges from predicates to governed statements and sibling outcomes.
- Add return, throw, catch, finally, callback, and dispatch subtypes.
- Test that removing any material predicate or terminal branch causes a completeness failure.

### Slice 3: Generalize data dependence

- Reuse and extract the existing callsite parameter-flow machinery.
- Add argument/parameter, return/receiver, assignment, property, captured-value, constant/default, serialization, and discriminator edges.
- Join dataflow to calls and runtime boundaries in `system-map` rather than requiring a separate exploratory detour.

### Slice 4: Introduce resource-centered state edges

- Define resource identities and alias confidence.
- Adapt current mutation and runtime persistence observations.
- Emit exact operation kinds and resource or record-identity fields.
- Distinguish durable, transactional, external, and in-memory changes.

### Slice 5: Introduce temporal edges

- Start with semantically exact program order, await completion, transaction membership, and recognized lock scope.
- Add queue separation, retry, timeout, compensation, and repair only when the extractor can retain proof and limitations.
- Treat framework adapters as evidence producers for canonical subtypes, not new primitive families.

### Slice 6: Build causal-corridor selection and rendering

- Intersect forward anchor slices with backward outcome slices.
- Apply completeness closure before compression.
- Rank and fold only after answer-determinative facts are protected.
- Carry an omission and frontier manifest with every rendered abstraction.

### Slice 7: Validate generality and token efficiency

- Test multiple languages, repositories, frameworks, and task shapes.
- Include focused questions, open-ended end-to-end explanations, cross-process flows, stateful mutations, authorization paths, failure recovery, and concurrency.
- Measure strict fact recovery first, then exploration tokens, source-read fallback, command count, latency, and unresolved coverage.
- Require equal or better strict accuracy before accepting token savings.

## Acceptance invariants

- No exact existing relationship is downgraded or silently replaced by a heuristic.
- Every emitted edge identifies its evidence method, strength, source, and coverage.
- A bounded analysis cannot establish absence or completeness beyond its stated coverage.
- Every potentially material unknown is recoverable or explicitly reported as unsupported, ambiguous, external, or unresolved.
- Compression may remove repetition and non-determinative syntax; it may not remove a fact whose alteration can change a material claim.
- Framework support adds adapters and subtypes, not task-specific ranking hacks.
- The same edge model serves arbitrary exploration tasks; task-specific behavior is limited to selecting claim-relevant corridors.
- Accuracy gates optimization. A change that saves tokens but loses a strict fact does not pass.

## What not to build

- A flat, supposedly exhaustive list of framework operations.
- A model that guesses repository-specific stages from English and presents them as facts.
- A relevance score that silently drops unselected graph directions.
- A runtime-boundary resolver that treats text similarity alone as a proven producer/consumer link.
- A compressed behavior format that removes complete predicates, constants, sibling outcomes, ownership, failure, or cleanup needed to interpret a path.
- A second graph implementation that duplicates current callgraph, dataflow, SCIP, semantic-provider, or runtime-extractor machinery.

## Immediate next move

Implement Slice 0 and Slice 1 first. They are the smallest way to test the design without destabilizing the working exploration surface: inventory and adapt the relationships SkipQuery already knows, expose their coverage, and verify that the six-family projection loses no information. Only after that mapping passes should we add missing control, data, state, and temporal derivations.

The first falsification test is simple: take every relationship currently emitted by `system-map`, callgraph, dataflow, slice, architecture, compiler identity, and runtime-boundary extraction. If any relationship cannot be represented in the six-family schema while preserving its task-relevant meaning, evidence strength, and recovery path, revise the schema before building corridor selection on top of it.

## Implementation checkpoint: 2026-08-07

The first canonical projection slice is implemented on the feature branch:

- The universal topology defines the six semantic families, additive semantic descriptors, evidence-preserving `ProgramEdge` projection, and per-family mapping inventory.
- Every proved `system-map` relation kind is mapped conservatively. Calls become control edges; contract-symbol relationships become contract edges; imports and references become identity edges; runtime links become control handoffs with their protocol and rendezvous key retained.
- Structural membership, runtime-observation ownership, and external imports are mapped as identity relationships.
- Unresolved runtime-boundary frontiers remain unsupported and unmapped. The projection does not invent data, state, or temporal edges merely because a runtime link exists.
- Focused contracts, TypeScript checks, lint/API/build checks, and the complete 2,277-test suite pass.

The next implementation slice should adapt the existing dataflow and parameter-flow machinery into canonical data edges. After that adapter reports its coverage, add missing control-dependence edges for complete predicates and sibling outcomes. New framework detectors should wait until these existing analyzers are projected, because the inventory will then identify the remaining evidence gaps precisely.
