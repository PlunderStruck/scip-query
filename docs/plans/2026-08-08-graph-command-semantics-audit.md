# Graph Command Semantics Audit

Status: implemented semantic baseline; deeper language-semantic providers remain incremental work

## Purpose

scip-query must not make an agent infer what a graph command means from a convenient label. Every command must identify the graph it observes, the nodes and directed edges in that graph, the operation it performs, the precision of its evidence, and the ways the result can be incomplete.

A **graph projection** is a selected part of an existing graph: it returns nodes and relationships chosen by roots, edge families, direction, and bounds. A **graph analysis** computes a property of a named graph, such as reachability, strongly connected components, degree, or a longest path. A **heuristic detector** ranks observations by a project-defined score; it is not a graph fact merely because its inputs came from a graph.

These three classes are the vocabulary for the public command surface. “Subgraph generation command” is a reasonable informal phrase, but **graph projection** is more exact when the command exposes relationships and **graph analysis** is more exact when it derives a property from them.

## External semantic baseline

- A call graph has callable program units as nodes and directed caller-to-callee edges. Unknown or external control targets remain explicit when static analysis cannot resolve them.
- A data-dependence edge connects a definition of a value to a use that may receive that value. Interprocedural data dependence also includes argument-to-parameter and return-to-call-result transfer.
- A control-dependence edge connects a predicate or controlling construct to an outcome whose execution depends on that construct.
- A program-dependence graph combines data dependence and control dependence. A backward slice is the portion that may affect a selected program point and value; a forward slice is the portion that may be affected by it. An interprocedural slice crosses calls through explicit call, parameter, and return relationships.
- A file dependency graph must state what creates an edge. An import graph, a symbol-reference graph, and a build/package dependency graph are different graphs even when they overlap.
- A cycle analysis should identify every cyclic strongly connected component in the selected graph. It may return one witness path per component, but a witness must not be presented as an enumeration of every simple cycle.
- A longest dependency-chain analysis operates on a directed acyclic graph. If the input contains cycles, it must first condense each strongly connected component and disclose that each returned component can contain several files.

Primary references: [Mark Weiser, “Program Slicing” (1981)](https://courses.cs.washington.edu/courses/cse503/11au/readings/weiser-slicing-icse81.pdf); [Ferrante, Ottenstein, and Warren, “The Program Dependence Graph and Its Use in Optimization” (1987)](https://doi.org/10.1145/24039.24041); [Horwitz, Reps, and Binkley, “Interprocedural Slicing Using Dependence Graphs” (1990)](https://doi.org/10.1145/77606.77608); [LLVM `CallGraph` documentation](https://llvm.org/doxygen/CallGraph_8h_source.html).

## Current command classification and findings

| Public command | Actual referents | Class | Verdict |
| --- | --- | --- | --- |
| `refs`, `trace` | compiler-identified definitions and references | projection | Conceptually sound when coverage is disclosed. |
| `call-graph`, `entry-map` | callable nodes and statically resolved call edges | projection / reachability analysis | Sound static call-graph semantics; unresolved dynamic/external targets must remain visible. |
| `deps`, `rdeps` | files connected by cross-file SCIP symbol references or resolved source imports | projection | Sound only when described as a **file symbol-reference dependency graph**. It is broader than imports. |
| `imports`, `imported-by` | import declarations and resolved imported symbols | projection | Sound import relation. |
| `hierarchy` | lexical/compiler ownership from a symbol to enclosing constructs | projection | The algorithm is useful, but `hierarchy` is too broad and can be mistaken for type inheritance. Prefer `ownership-chain`; keep the old name as a compatibility alias. |
| `system` | matched files, documented symbols, and one-hop file reference dependencies | projection | The algorithm is a module summary, not a discovered “system.” Prefer `module-map`; keep the old name as an alias. |
| `surface` | callable symbols in a module used by external files | analysis | Sound when described as a consumer-observed callable surface, not the full language export surface. |
| `dataflow` | definition/reference sites plus callers and callees | projection | Incorrectly named. Calls and references are not definition-use value flow. Preserve it as `reference-neighborhood`; deprecate the misleading name. |
| `slice` | recursive callees for “backward” and direct referrers for “forward” | analysis | Incorrect direction and incorrect graph. Replace with dependence-graph slicing; preserve the old behavior only as `reference-reachability` compatibility. |
| `evidence --edge data`, `value-flow` | proved parameter/static-value/used-call-result transfers in the typed program graph | projection | Correct but currently partial: direct parameter forwarding, bounded static values, and callee-return-to-consumed-call-result transfer are covered; general local definition-use, aliases, heap/field flow, and downstream use after a call result are not yet complete. |
| `affected` | reverse caller/reference transitive closure | reachability analysis | A conservative **possible impact closure**, not proof that behavior will break. Rename output language accordingly. |
| `fan-in` | number of distinct external files referencing one exact symbol | degree analysis | Sound after stating the node and unit counted. This is not raw call-graph in-degree. |
| `fan-out` | number of external symbols used by a file, grouped by defining file in detailed mode | degree analysis | Sound after stating the asymmetric node and unit counted. |
| `coupling` | symbols defined in one of two files and referenced by the other | heuristic metric | Useful shared-symbol coupling metric, not general coupling. The subtype already records this; command help must too. |
| `hotspots` | symbols ranked by cross-file reference count | heuristic ranking | Useful reference hotspots, not proof of change risk or runtime contention. |
| `bottlenecks` | callable symbols with incoming caller/reference evidence files and external callable targets; score is their product | heuristic ranking | Useful coordination-hub heuristic, not a graph-theoretic articulation-point analysis. Prefer `coordination-hubs`; keep the old name as an alias. |
| `cycles` | cyclic strongly connected components in a selected file-dependency relation | cycle analysis | Sound after the correction: SCC-complete for the selected relation, with one disclosed deterministic witness per component rather than every simple cycle. |
| `deep-chains` | longest path through SCC-condensed all-reference file dependency graph | longest-path analysis | Core algorithm is sound. Rename/describe as `dependency-depth`; report component membership and edge basis. |
| `similar`, `similar-files`, `similar-chains` | fingerprints and similarity scores | heuristic ranking | Must remain labeled candidate/heuristic; similarity is not a causal edge. |
| `system-map` | a bounded heterogeneous topology assembled from compiler, parser, runtime-boundary, and structural evidence | projection | Sound only as a typed evidence topology. It must not imply task relevance or completeness beyond reported coverage. |

## Implementation findings and corrections

The first implementation pass established the following:

- `dataflow` did not compute data dependence. It combined definition sites, reference sites, incoming evidence, and outgoing calls. That behavior remains available under the honest name `reference-neighborhood`; `value-flow` now emits only typed `data` edges and publishes its unsupported relations.
- `slice` did not compute a program slice and reversed the ordinary meaning of backward and forward slicing. The old traversal remains available as `reference-reachability`; `dependence-slice` now traverses data and parser-proved control dependence in the requested direction while marking ownership, call, and runtime connectors as supporting rather than as value flow.
- Direct argument-to-parameter flow and bounded static arguments already existed. The provider now also emits exact `return-to-call-result` transfer when a compiler-resolved call result is consumed, and a discarded call is a tested non-example. It still does not claim general local reaching definitions, aliases, heap flow, or downstream local use of the result.
- `deep-chains` already attempted the right graph operation but obscured its basis. `dependency-depth` now runs longest-path analysis over the strongly-connected-component condensation, counts a cycle as one depth component, retains full component membership, reports file count separately, and states whether the edges came from symbol-reference dependencies or imports.
- `cycles` used an import-only DFS while its surrounding command family implied the broader dependency relation. It now enumerates every cyclic strongly connected component in the selected relation and returns one deterministic witness per component. The old depth option remains only as a deprecated compatibility field and no longer truncates the result.
- Targeted `fan-out` silently changed from “number of external symbols” to “number of dependency files” when SCIP mention rows were absent. Those are now separate `externalSymbolFanOut` and `fileDependencyOutDegree` analyses. The CLI uses the former because that is its published contract; the old mixed `fanOut` function remains deprecated for compatibility.
- `affected` said “full transitive closure” despite a default depth of five and a per-symbol evidence cap. `possibleImpactClosure` now reports its edge basis, reached depth, remaining frontier, per-symbol cap, and whether the result is accounted, bounded, or incomplete. The CLI renders that coverage and does not describe reachability as predicted breakage.
- `surface` unioned observed external consumers with every callable definition in the module. `consumerSurface` now returns only symbols with an observed external reference; the legacy union remains deprecated.
- Ranked coupling produced both orientations of the same file pair. It now canonicalizes file pairs and agrees with the direct shared-symbol count for every ranked pair.
- Call-graph and entry-map results now preserve exact versus candidate evidence. A resolved AST or semantic call is a call edge; SCIP chunk co-occurrence and generic incoming references remain explicitly labeled candidates. Entry-map coverage reports whether candidate reachability participated instead of presenting all selected evidence as one uniform exact graph.
- Reference hotspots now state whether they count SCIP mention occurrences or distinct source-backed incoming evidence rows. Coordination hubs report which incoming and outgoing inputs are candidates. These remain heuristics, not articulation points or causal change-risk facts.
- `deps` and `rdeps` now publish their edge basis with each result: cross-file SCIP references plus resolved source imports. Their missing output still cannot prove that no dependency exists outside indexed and parsed coverage.
- Selectable cycle semantics now live on the additive `dependencyCycles` and `dependencyCycleSummary` APIs. The legacy `cycles` and `cycleSummary` signatures remain exact and use the documented symbol-reference dependency graph by default. Likewise, `dependencyDepth` owns edge-basis selection while `deepChains` remains a deprecated signature-compatible wrapper.

## Remaining semantic gaps

These gaps are deliberately visible rather than filled with name-based guesses:

1. General local reaching-definition and definition-use flow is not implemented. A correct provider needs control-flow-sensitive treatment of branches, loops, exceptions, reassignment, and language-specific binding and scope rules. A straight-line name matcher would be smaller, but it would manufacture exact-looking edges under shadowing and joins.
2. Alias, field, heap, collection, and pointer flow are unsupported except where a bounded static evaluator proves a concrete transfer. These require a points-to or equivalent language-semantic provider.
3. Used call results reach an explicit call-result node, but downstream local uses of that result remain unsupported until local definition-use exists.
4. Dynamic dispatch, reflection, generated names, and unindexed external callees remain call-graph frontiers. Candidate evidence can guide inspection but cannot be promoted to an exact call.
5. Parser-derived state writes and lexical temporal successors describe syntax-proved operations and order inside the selected construct. They are not transaction atomicity, cross-thread happens-before, or durable persistence unless separate evidence establishes those properties.
6. Entry-point discovery is necessarily a rootedness analysis over package surfaces, configured roots, framework adapters, and absence of indexed incoming evidence. “No indexed caller” is candidate evidence, never proof that runtime control enters there.

The stopping rule for this audit is not “every conceivable edge exists.” It is that each public command has one stable concept, selects one stated graph or metric, distinguishes exact facts from candidates, exposes its coverage bounds, and has a contrast fixture that rejects the nearest misleading interpretation.

## Validation record

- The complete repository suite passes: 283 test files and 2,334 tests.
- TypeScript typechecking, Prettier, ESLint, command-reference consistency, package build, public API manifest, public API consumer fixture, and skill-link validation pass.
- The public surface now contains 82 package paths. Legacy query signatures are preserved; the acceptance record classifies the semantic repairs and generated declaration-chunk reordering as a compatible correction.
- Contrast fixtures cover the nearest misleading alternatives: references versus calls, imports versus symbol-reference dependencies, external symbols versus dependency files, cycle witnesses versus cyclic components, consumed versus discarded call results, and possible impact versus certain breakage.
- The audit does **not** certify unsupported local definition-use, alias/heap flow, dynamic dispatch, or concurrency/durability ordering. Those remain explicit provider gaps above.

### Luna-max exploration benchmark

The corrected build was run through the disposable detached-worktree benchmark runner against `arxiv-durability-discovery-v1` at arxiv-agent-cli commit `d25b1fa2308627a23040946a043e661d96e38e2e`. Index setup took 1.7 seconds outside the measured turn. The measured Luna 5.6 max turn took 350.1 seconds, used 262,257 total model tokens, 43,915 uncached input tokens, four semantic queries plus one transport continuation, and 68,424 rendered exploration characters. It made zero native tracked-source reads. The runner removed the worktree and private cache in its `finally` cleanup.

A strict manual audit credits 4/6 compound facts, matching the published earlier Luna treatment and exceeding the published 2/6 native control. The answer established the SQLite-backed mutex and precommit sweep/reconciliation, duplicate idempotence, ordered rename/event/compaction/finally cleanup, and the non-atomic crash window. It did not establish the complete reconciliation case split, and it did not explicitly name the safe destination-path derivation strongly enough to satisfy that whole compound fact. The deterministic phrase evaluator reported 1/6 and remains a diagnostic rather than the accuracy authority.

Relative to the published earlier treatment baseline, total tokens fell from 488,449 to 262,257, a 46.3% reduction, while manual accuracy remained 4/6. Relative to the published native control, total tokens were 58.8% lower while manual accuracy was two facts higher. This is a baseline comparison rather than a newly rerun matched control because the older artifacts do not record an observed commit identity.

The run used `anchors`, `system-map`, and batched `inspect`; it did not invoke `value-flow` or `dependence-slice`. It therefore validates persistent efficiency of the overall exploration protocol after the semantic corrections, but it does not demonstrate that agents will select the two new analyses. Their conceptual accuracy is established by contrast fixtures; command discoverability and proof-obligation selection remain a separate agent-behavior problem. The treatment also exceeded the 60,000-character budget by 8,424 characters and still missed one independent reconciliation owner, so promotion should remain gated on better coverage selection rather than further relabeling of graph facts.

Artifact: `/tmp/arxiv-durability-graph-semantics-luna-max-20260808.json`.

## Compatibility rule

Names, defaults, result fields, JSON shapes, and exit behavior are public API. We will not silently change an existing command’s meaning. Correct replacements are additive. Misleading commands remain temporarily as deprecated aliases or receive honest compatibility names. A future major release may remove the aliases after callers and generated documentation have migrated.

## Implementation order

1. Add honest compatibility names for the existing reference neighborhood, reference reachability, dependency depth, ownership chain, module map, shared-symbol coupling, reference hotspots, and coordination hubs.
2. Add a typed value-flow projection that exposes only proved data-dependence edges and reports unsupported flow kinds.
3. Add a dependence slice whose criterion, edge basis, direction, bounds, and coverage are explicit. Its initial implementation may be conservative, but it may not relabel calls or references as data flow.
4. Replace file-cycle DFS with SCC-complete detection and a deterministic witness per cyclic component. Make the file-edge basis an explicit option shared by `deps`, `cycles`, and dependency-depth analysis.
5. Audit every remaining graph-derived command against a fixture that distinguishes its claimed concept from a nearby but different concept: reference versus call, import versus reference dependency, ownership versus inheritance, possible impact versus certain effect, and metric versus causal fact.

## Acceptance standard

A graph projection or analysis is releasable only when all of the following are true:

- Its documentation names the node set, edge relation, direction, operation, evidence strength, bounds, and unsupported cases.
- A positive fixture proves the standard case.
- A contrast fixture proves that a nearby non-example is excluded or honestly labeled.
- Cycles, ambiguity, dynamic dispatch, aliases, external targets, and budget truncation are either handled or surfaced as coverage limitations.
- Human and JSON output agree on semantics.
- Existing public behavior is preserved through aliases or an explicitly versioned breaking change.
- Typecheck, focused tests, full tests, build, API report, and command-reference generation pass.
