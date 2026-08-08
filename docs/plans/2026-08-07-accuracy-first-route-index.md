# Accuracy-First Exploration Route Index

## Objective

Make scip-query a sufficient exploration surface for arbitrary repository
questions. The immediate priority is to recover at least as much material truth
as an agent using native source tools while keeping exploration at or below the
native token cost. Further token reductions are valuable only after that
accuracy constraint is satisfied.

## The governing principle

A repository graph is a collection of compiler- and source-supported
relationships between code identities. Each relationship may prove only the
kind of connection its evidence establishes. Call and exact runtime-transition
edges can establish executable reachability. Dataflow edges establish value
propagation. State edges establish reads and writes. Temporal edges establish
ordering. Contract edges establish interface or type obligations. Ownership and
dependency edges establish structural containment or reliance.

The exploration surface must preserve those distinctions. It should use the
whole graph to explain a selected path, but it must not turn every related edge
into a claim that one operation executes another.

## Failure in the current selector

The graph can contain several proved upstream paths from an anchor. The current
selector normally materializes one preferred path before the agent sees the
alternatives. Ranking therefore acts as an evidence gate: if the preferred path
is real but is not the path needed by the question, the answer can omit a
material fact even though the index contains it.

The OpenCode v23 trial demonstrated this failure. The selected `summarize`
HTTP path was a valid external path, but the frozen rubric required the
`prompt` and `prompt_async` paths. Adding another ranking heuristic increased
cost without recovering those paths. The result argues against further
best-route ranking as the accuracy mechanism.

## Proposed architecture

### 1. Complete compact route catalogue

Before evidence is folded, enumerate every distinct proved public-entry or exact
runtime-boundary endpoint reachable from each selected anchor within the
graph's declared coverage, represented by one deterministic shortest path.
This preserves every entrance without enumerating exponentially many cyclic or
internally equivalent paths. Give every route:

- a stable route ID derived from graph identities rather than display order;
- its anchor and upstream endpoint identities and exact locations;
- its ordered nodes and edges;
- endpoint kind and evidence strength;
- the relationship families present on the route and adjacent to it;
- an explicit coverage record, including anchors for which no proved route was
  found.

The catalogue is compact navigation evidence. It does not dump route source or
pretend that a bounded graph is globally exhaustive.

### 2. Multi-route selection

Allow one system-map request to select several route IDs. Materialize the union
of their nodes and edges so an agent can compare sibling paths without shuttling
between abstraction levels. Preserve the existing automatically selected path
for compatibility, but never make it the only discoverable path.

### 3. Edge-role preservation

Use executable call/control and exact runtime-boundary edges to construct route
spines. Use all other indexed edge families to characterize and expand those
routes:

- data: values entering, leaving, or being transformed;
- state: persistent or in-memory reads and writes;
- temporal: required order, scheduling, and later repair;
- contract: types, interfaces, registrations, and declared obligations;
- identity/ownership/dependency: where behavior lives and what it relies on.

Candidate evidence remains a lead. Unsupported relationships remain explicit
coverage gaps. Neither is silently upgraded into a proved route.

### 4. Coverage-first stopping rule

For each question, derive material evidence obligations: behavior-changing
branches, authorization, data reshaping, hard bounds, runtime crossings,
durable changes, notifications, and returned values on the selected causal
path. Exploration may stop only when each obligation is proved, explicitly
irrelevant, or reported unsupported. A selection being complete is not the same
as the user's question being answered.

### 5. Token controller

After route selection is reliable, allocate output in this order:

1. the complete compact route catalogue;
2. connected behavior for all selected routes;
3. relationship-family manifests and unresolved frontiers;
4. exact source only for named remaining obligations.

The controller may fold evidence only when it emits a stable, selectable
recovery identity and an honest coverage statement. Its first constraint is not
to exceed the measured native baseline; its optimization target is then to
minimize tokens while preserving recovered facts.

## Delivery slices

1. Implement and unit-test the complete route catalogue as an additive API.
2. Add repeatable multi-route selection and compact human output.
3. Update agent guidance to select all routes capable of changing a material
   claim, not merely the highest-ranked route.
4. Add an evidence-obligation ledger and coverage audit.
5. Add a baseline-aware token controller.
6. Run frozen, sandboxed comparisons across unrelated repositories, question
   types, and model capability levels.

## Acceptance criteria

- Every distinct proved public/runtime upstream endpoint in the bounded input
  graph has a stable selectable shortest-route ID.
- Selecting multiple IDs returns the union of their exact spines without
  dropping their relationship semantics.
- Catalogue coverage distinguishes complete enumeration of the bounded input
  from unsupported or unindexed repository evidence.
- Existing system-map consumers remain compatible.
- Neutral tests cover multiple entry paths, runtime crossings, duplicate
  display labels, unsupported anchors, stable IDs, and mixed edge families.
- Frozen trials recover at least the control's material facts without exceeding
  the control's exploration tokens before token-minimization work proceeds.

## Non-goals

- Inferring the user's intent from repository vocabulary.
- Treating ranking as proof of relevance.
- Claiming global completeness from a depth-bounded graph.
- Replacing exact source when syntax itself can change the decision.
- Adding repository-specific route names or benchmark-specific preferences.
