# Open-Ended Typed Subgraph Exploration

**Date:** 2026-08-08  
**Status:** Current design direction  
**Supersedes:** [`2026-08-08-agent-exploration-kernel.md`](./2026-08-08-agent-exploration-kernel.md)

## Outcome

scip-query becomes an open-ended repository exploration surface in which an agent selects exact roots, relationship types, directions, and bounds, and receives a faithful compressed subgraph. The CLI resolves graph facts and coverage but does not infer the task, declare one authoritative subsystem, generate proof obligations, rank task relevance, or decide what the agent should inspect next.

The same query model works for every indexed repository. Language and framework providers may differ in which edges they can establish, but the navigation contract, edge provenance, structural compression, and recovery behavior remain uniform.

## Decision correction

The previous proposal tried to derive answer contracts and proof obligations from a natural-language request and then select proof paths that satisfied them. That still placed an inference layer between the agent and the repository. It required scip-query or its skill to predict which facts would matter before the agent had explored the code, introduced ceremony into an open-ended interaction, and risked overfitting task templates to benchmark questions.

The corrected division of responsibility is:

```text
Agent
  chooses roots, graph projections, directions, depth, and when to stop

scip-query
  resolves identities, materializes typed edges, compresses topology,
  reports coverage, and expands selected folds
```

The agent may privately reason about what it still needs to understand, but proof obligations are not a CLI concept or a prerequisite for graph traversal.

## Essential concepts

A **program graph** is a representation of program entities connected by evidenced relationships. Its distinguishing capability is that each relationship retains its direction and meaning instead of reducing the repository to textual co-occurrence.

A **typed multigraph** is a program graph that can connect the same entities through several different relationship types. A function may call another function, pass a value to it, depend on its contract, and share a state resource with it; these are separate edges because each establishes a different fact.

A **projection** is the subgraph produced by selecting roots, edge types, directions, and bounds. It differs from an inferred subsystem because its membership follows entirely from explicit graph operations and can be reproduced on any repository with the same available edge providers.

A **program slice** is a dependence-based subgraph around a selected program point or value. A backward slice contains upstream definitions and predicates that may affect the selection; a forward slice contains downstream statements and values that the selection may affect. A genuine interprocedural slice crosses calls through argument-to-parameter and return-to-use edges.

**Topology-preserving compression** is a representation that folds structurally repetitive graph regions while retaining every branch, join, cycle, boundary, omitted-edge count, and exact expansion handle. Its distinguishing feature is that it reduces presentation size without guessing which facts the user considers relevant.

A **system** is not one uniquely discoverable graph component. In repository exploration, it is a useful view of entities connected under a selected relationship set: a request call path, one value flow, one stateful workflow, and one package dependency region may overlap without having identical boundaries.

## Findings

### 1. Task relevance should not be a graph responsibility

The current `graphEvidence()` implementation already states that it performs no task-relevance inference, but it then approximates useful selection through root distance, structural penalties, evidence strength, fixed family ordering, and round-robin family diversity. See [`src/queries/navigation/graph-evidence.ts`](../../src/queries/navigation/graph-evidence.ts#L108), [`compareGraphEdges()`](../../src/queries/navigation/graph-evidence.ts#L331), and [`selectCoverageDiverseEdges()`](../../src/queries/navigation/graph-evidence.ts#L208).

Graph proximity and family diversity are not task relevance. Replacing them with another inferred relevance or proof-ranking mechanism would preserve the same fundamental problem. The general operation is explicit projection: the agent requests the relationships it wants to see.

### 2. Nodes cannot be limited to symbols

Compiler symbols are appropriate nodes for definitions, calls, references, ownership, imports, and contracts. They cannot precisely represent which argument, return, assignment, predicate outcome, state resource, or runtime address participates in another relationship.

The canonical graph therefore needs a controlled node vocabulary:

```text
symbol
callsite
value-or-definition
predicate
state-resource
runtime-participant
source-construct
structural-region
```

Provider-specific detail belongs in node attributes and edge subtypes rather than new universal top-level categories.

### 3. The existing semantic family vocabulary is usable

The current universal semantic families are:

```text
identity
contract
control
data
state
temporal
```

They are defined in [`src/queries/internal/exploration-topology.ts`](../../src/queries/internal/exploration-topology.ts#L19). Ownership and dependencies can remain identity subtypes; execution and runtime handoffs can remain control subtypes. The agent should be able to select either a broad family or a precise subtype.

Similarity is not part of this causal multigraph. It compares fingerprints or source shapes to find candidates and belongs in the separate analysis suite.

### 4. The current call graph is real but fused from several providers

Incoming call edges identify possible callers; outgoing call edges identify callees. Recursive traversal produces upstream and downstream call cones, but neither cone alone defines a semantic subsystem.

scip-query currently fuses AST callsites, ts-morph semantic callees, and SCIP mentions in [`src/symbols/graph/call-graph-evidence.ts`](../../src/symbols/graph/call-graph-evidence.ts#L42). Each edge must preserve its evidence method and strength so the agent can distinguish compiler resolution from syntax or mention-based fallback.

### 5. The current `dataflow` and `slice` names overstate their implementations

The current `dataflow` command reports callees as producers and callers or referencing owners as consumers in [`src/queries/navigation/dataflow.ts`](../../src/queries/navigation/dataflow.ts#L90). This is a reference/call neighborhood rather than general value flow.

The current slice implementation is also not standard program slicing:

- `backwardSlice()` recursively follows callees in [`src/queries/navigation/slice.ts`](../../src/queries/navigation/slice.ts#L53).
- `forwardSlice()` lists up to 30 enclosing symbols that reference the target in [`src/queries/navigation/slice.ts`](../../src/queries/navigation/slice.ts#L109).

These operations should be renamed according to their actual referents or replaced by genuine dependence-based slicing. Backward means upstream causes; forward means downstream consequences.

### 6. Existing value flow is useful but deliberately narrow

The current parameter-flow provider recognizes direct forwarding when a call argument exactly names one of the caller's parameters. Other arguments are reported as unknown in [`src/symbols/graph/value-flow.ts`](../../src/symbols/graph/value-flow.ts#L100).

Static value evaluation can resolve bounded literals, concatenations, identifiers, member accesses, and some call returns, with explicit depth and unsupported-expression results in [`src/symbols/graph/static-value-flow.ts`](../../src/symbols/graph/static-value-flow.ts#L23). System-map data elements apply these providers at resolved callsites in [`src/queries/graph/program-data-edges.ts`](../../src/queries/graph/program-data-edges.ts#L156).

This foundation can support exact argument-to-parameter edges and some static values. It is not yet a general definition-use graph across local assignments, branches, object fields, closures, returns, aliases, and subsequent calls.

### 7. Genuine slicing requires program dependence

A program-dependence graph combines:

```text
data dependence
  which definition or value may reach which use

control dependence
  which predicate outcome determines whether a construct executes
```

Interprocedural slicing additionally requires:

```text
argument -> parameter
return expression -> call result
call result -> assignment or enclosing expression
captured value -> closure use
field write -> reachable field read, within stated alias precision
```

scip-query does not currently contain a general definition-use, control-dependence, or program-dependence provider. This is the largest analytical capability gap between the current graph and the proposed open-ended surface.

### 8. `deep-chains` does not discover execution chains

`deep-chains` builds a file dependency graph, collapses dependency cycles into strongly connected components, and reports representative longest paths through the resulting acyclic graph. See [`src/queries/graph/deep-chains.ts`](../../src/queries/graph/deep-chains.ts#L34) and [`src/symbols/graph/file-dep-graph.ts`](../../src/symbols/graph/file-dep-graph.ts#L46).

It is a transitive dependency-depth analysis. It does not locate the beginning or termination of a function call chain, dataflow path, or runtime workflow.

### 9. “System detection” should become structural graph operations

There is no single exact algorithm that can recover the semantic system containing an arbitrary symbol because different relationship types induce different, overlapping regions. Accurate general-purpose operations include:

- incoming or outgoing reachability under selected edges;
- all paths connecting several roots;
- entry-to-effect or producer-to-consumer corridors;
- backward or forward dependence slices;
- all owners touching one state resource;
- all producers and consumers of one runtime address;
- strongly connected components;
- dominators and post-dominators;
- branch and join nodes;
- connected components under an explicit edge set.

These operations may help an agent perceive a broader system, but the CLI should describe exactly which structural region it computed rather than naming it as the authoritative subsystem.

### 10. Open-ended does not mean omniscient

Reflection, generated code, dynamic property access, runtime dependency injection, external services, unresolved aliases, and unsupported language or framework constructs can make static edges unknowable. Generalization means that every provider participates through the same typed-edge and coverage contract, not that every indexed repository yields a complete runtime model.

Exact, mechanically derived, candidate, ambiguous, unsupported, and unresolved evidence must remain distinct.

## Proposed interaction

The primary command should expose one composable subgraph operation rather than many overlapping navigation commands. A provisional shape is:

```bash
scip-query graph \
  --symbol <root> \
  --edge call \
  --edge data \
  --direction both \
  --depth 3
```

Multiple roots and connector paths:

```bash
scip-query graph \
  --symbol <producer> \
  --symbol <consumer> \
  --edge call \
  --edge data \
  --edge runtime \
  --connecting
```

True dependence slicing:

```bash
scip-query slice \
  --at <file:line> \
  --direction backward \
  --edge data \
  --edge control
```

The exact command name is a compatibility choice. The material contract is:

```text
roots
edge families or subtypes
direction: incoming, outgoing, or both
bound: depth, edge count, endpoint kind, or connecting paths
compression mode
coverage and expansion handles
```

The first response around a root should expose compact edge cardinality before materializing a large projection:

```text
processUser()

incoming: call 4, data 2, reference 11, ownership 1
outgoing: call 3, data 5, state 1, runtime 0, temporal 2
```

The agent can then request several relationship types in one subgraph instead of shuttling through separate command-specific abstractions.

## Abstraction through structural compression

The representation should expose progressively more detail about the same selected subgraph:

```text
1. Edge inventory around selected roots
2. Compressed topology with branches, joins, cycles, boundaries, and effects
3. Exact nodes and typed edges
4. Local behavior, predicates, value transformations, and state operations
5. Exact source
```

These are display resolutions, not inferred semantic systems.

Default compression may:

- fold linear paths whose internal nodes have no selected-edge branch or join;
- collapse strongly connected components while retaining their full membership;
- group parallel edges with identical endpoints, subtype, and provenance class;
- group repeated leaf structures under one owner;
- surface entry, branch, join, runtime-boundary, state-effect, and terminal nodes;
- report folded node and edge counts by type and direction;
- assign every fold a stable exact expansion selector.

Compression may not:

- remove an unreported edge;
- merge different edge semantics;
- imply that a folded path is irrelevant;
- turn a candidate into an exact relationship;
- claim complete coverage when a provider is unresolved or unsupported.

## Agent guidance

The installed skill should need only a short operational principle:

> Start from one or more exact repository referents. Select the relationship types and directions that expose the view you need; combine several types when the behavior crosses calls, values, state, time, or runtime mechanisms. Expand folds only where more detail changes your understanding. scip-query reports graph facts and coverage; you decide what is relevant and when the task is complete.

No mandatory anchor phase, proof-obligation manifest, evidence contract ceremony, inferred relevance ranking, or authoritative system-detection step should be required.

## Implementation slices

| Change | Direct evidence | Preserve | Retire | Prove |
| --- | --- | --- | --- | --- |
| Record the current edge-provider inventory and honest semantics | Existing call, parameter-flow, static-value, runtime, state, temporal, contract, identity, and dependency owners cited above | Per-edge provenance, strength, and coverage | One display label being treated as an independent analytical provider | Provider-contract tests enumerate every emitted subtype and source method |
| Correct misleading navigation terminology before expanding behavior | Current `dataflow`, `slice`, and `deep-chains` implementations establish different referents from their names | Backward-compatible aliases or explicit deprecation where public contracts require it | Claims that current reference neighborhoods are program slices or full dataflow | CLI and API tests state actual direction, edge set, bound, and coverage |
| Define one canonical typed-multigraph query contract | `ExplorationTopology` and `ProgramEdgeSemantic` already carry nodes, typed semantics, evidence, dispositions, and frontiers | Six semantic families, provider subtypes, exact roots, and recoverable omissions | Command-specific graph shapes that cannot be composed | Contract tests accept multiple roots, edge types, directions, and bounds without task inference |
| Add edge inventory and explicit projection traversal | Current `evidence` resolves roots but constructs all low-level relation kinds before display filtering | Batched roots, deterministic results, strength ordering, and coverage | Family round-robin as the default selector | Tests prove incoming/outgoing traversal and combined projections return every eligible edge within the stated bound |
| Add topology-preserving compression | Existing topology already represents folded, emitted, excluded, and unsupported dispositions | Exact expansion, branch/join visibility, cycles, and omission accounting | Relevance-based pruning and verbose default ledgers | Expanding every fold reconstructs the same selected subgraph and edge multiset |
| Build a genuine definition-use provider for TypeScript | Existing resolved callsites, ASTs, ts-morph identities, direct parameter transfer, and static values provide reusable inputs | Explicit unknowns, bounded analysis, and source provenance | The current call/reference proxy being called dataflow | Fixtures prove assignment, argument, parameter, return, field, and closure cases with conservative unknowns |
| Build control-dependence edges and compose true slices | Behavior skeletons already identify branches, loops, returns, throws, awaits, and containing constructs | Predicate source, branch outcome, exception paths, and provider coverage | Current directionally misleading slice behavior | Backward and forward slice fixtures match preregistered upstream-cause and downstream-consequence sets |
| Simplify agent instructions around projection and expansion | Current skills expose many commands, completion states, and workflow exceptions | Exact-evidence discipline and unsupported-gap honesty | Proof obligations, mandatory maps, task-relevance inference, and generic frontier chasing | Agents can begin and navigate held tasks without command help or native source search |
| Rebench on held repositories and task shapes | Previous runs show interface behavior can dominate token cost and accuracy | Frozen checkouts, native controls, identical models/prompts, manual fact rubrics, and disposable environments | Changes justified only by the development task | Treatment accuracy is non-inferior and exploration tokens do not exceed native across multiple held tasks |

## Open uncertainties

1. Whether to evolve `evidence` into the canonical projection command or introduce `graph` while keeping `evidence` as a compatibility adapter. Resolve through API-consumer and CLI-contract inspection before changing command names.
2. Which TypeScript compiler representation should supply control-flow and definition-use facts: ts-morph/TypeScript flow nodes, a dedicated compiler pass, or a conservative AST-based provider. Resolve with a prototype over representative alias, closure, branch, and return fixtures before selecting the implementation.
3. Which compression primitives yield the best token reduction without increasing navigation calls. Resolve by replaying identical selected subgraphs through uncompressed, linear-folded, SCC-folded, and combined renderers; do not use agent-answer benchmarks until graph reconstruction equivalence passes.
4. Whether runtime participants and state resources should be persistent indexed nodes or query-time nodes with stable identities. Resolve by comparing incremental invalidation cost and cross-query identity requirements.

## Game plan

Freeze the current branch as the evidence-provider baseline, correct the meanings of `dataflow`, `slice`, and `deep-chains`, unify existing provider facts behind one multi-root typed-subgraph query with explicit edge types and directions, add lossless topology-based compression and stable expansion, then implement genuine TypeScript definition-use and control-dependence providers so forward and backward slices have their standard meanings; simplify the skill to teach graph projection rather than workflow ceremony, and validate the design first with graph reconstruction and provider-accuracy fixtures and then with held native-versus-scip-query exploration benchmarks.
