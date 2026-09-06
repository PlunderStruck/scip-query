# scip-query information model

Use this map to decide what kind of repository fact a ledger row requires. It inventories information classes rather than prescribing a route. `scip-query --help-all` remains the complete runtime command inventory, and `scip-query capabilities --matrix` remains the authority on which providers and evidence ceilings are available in the current project.

## Direct system evidence

| Information kind | What its real referents are | Primary controls | What it can establish | What it cannot establish alone |
|---|---|---|---|---|
| Current text | Exact tracked bytes, occurrences, paths, and aligned compiler owners | `search`, `files` | Cardinality and location within reported text coverage | Task relevance or executable reachability |
| Source structure | Compiler-owned files, symbols, members, methods, nesting, and ranges | `outline`, `methods`, `members`, `hierarchy`, `by-kind`, `kind-counts` | What constructs exist and contain one another | That a construct runs or is externally active |
| Entry and consumer surfaces | Callables where control may enter and symbols outside consumers actually use | `entrypoints`, `entry-map`, `surface`, `fan-in` | Candidate ingress, static downstream reach, and published use | Runtime invocation from visibility or zero callers alone |
| Execution and control | Calls, callbacks, returns, throws, branches, loops, handlers, and local control dependence | `evidence --edge execution`, `call-graph`, `dependence-slice` | Static may-call and supported control reachability | That an invocation occurred, completed, or selected a candidate target at runtime |
| Data movement | Arguments, parameters, definitions, uses, returns, captures, field uses, serialized discriminators, and values written to state | `evidence --edge dataflow`, `dependence-slice` | Supported local and bounded cross-call value transfers | General interprocedural definition-use flow, heap aliasing, or every eventual consumer |
| Runtime handoff | Source-grounded producers and consumers joined by queues, events, commands, discriminators, or registered adapters | `evidence --edge runtime` | Supported producer/consumer rendezvous and dispatch identity | Successful delivery, retry, or an unregistered framework crossing |
| State interaction | Identified resources read, written, deleted, enqueued, or consumed | `evidence --edge state` | Which construct performs which observed state operation | Transactionality, durability, alias identity, or exclusive ownership unless separately evidenced |
| Temporal order | Local successors, await completion, lock scope, and supported enqueue-before-consume order | `evidence --edge temporal` | Reported local or adapter-backed before/after relations | Cross-process happens-before, durable completion, or exceptional completion |
| Contracts | Interfaces, types, and other compiler/source contracts used by a construct | `evidence --edge contract` | The identified constraint relationship | Runtime invocation or unchecked behavioral conformance |
| Identity | Compiler- or source-owned observations that refer to the same entity | `evidence --edge identity`, `refs` | Same-entity references within coverage | Execution, value transfer, or active product selection |
| Ownership | Structural containment or observation ownership between code, runtime observations, and state resources | `evidence --edge ownership`, `hierarchy`, `members` | What contains or owns an observed unit | Lifetime, singleton scope, or per-session sharing unless source behavior establishes it |
| Dependencies and topology | Imports, reverse imports, file dependencies, cycles, depth, coupling, and cross-file coordination hubs | `evidence --edge dependencies`, `deps`, `rdeps`, `imports`, `imported-by`, `system`, `cycles`, `dependency-depth`, `coupling`, `fan-out`, `bottlenecks`, `hotspots` | Static reliance and structural shape | Execution, runtime contention, or architectural intent by itself |
| Implementation behavior | Exact statements and connected source units selected for a named gap | `inspect`, `code` | Current source behavior for materialized units | Callers, runtime reachability, or relevance without surrounding evidence |

The eleven `evidence` controls are incoming and outgoing `execution`, incoming and outgoing `dataflow`, plus `runtime`, `state`, `temporal`, `contract`, `identity`, `ownership`, and `dependencies`. They cover nine top-level relationship classes.

## Task-specific analyses

These controls expose additional information, but they are not ordinary stages in every exploration.

| Information kind | Controls | Use when |
|---|---|---|
| Change impact | `diff-impact`, `affected`, `change-surface` | A current or proposed edit must preserve downstream consumers, public surface, or operational roots |
| Declared architecture | `architecture` | Project-owned boundary and dependency rules constrain the answer or edit |
| Historical coupling and migration state | `co-change`, `incomplete-migration`, `doc-drift` | Git history or partial rollout can expose hidden coordination, residual sites, or stale documentation |
| Complexity and structural pressure | `complexity`, `fan-in`, `fan-out`, `coupling`, `dependency-depth`, `bottlenecks` | Maintainability or structural concentration is the question; reference counts are not runtime load |
| Duplication, reuse, and cleanup candidates | `similar`, `similar-files`, `slice-cohesion`, `locality-candidates`, `recent-duplicates`, `duplicate-bodies`, `twin-drift`, `passthrough-candidates`, `redundant-reexports` | The task asks whether code can be consolidated, reused, moved, or removed; heuristic results remain candidates |
| Framework health and implementation integrity | `health`, `dead`, `isolated`, `unused-imports`, `unused-params`, `not-implemented`, `decorative-checkers`, `test-quality`, and the React/Vue detectors | The task asks for cleanup, incomplete behavior, or configured framework findings; detector evidence contracts govern each claim |
| Index and provider capability | `status`, `capabilities`, `doctor`, `stats` | A claim depends on freshness, language support, provider availability, or an analytical ceiling; these describe the instrument, not the repository system's behavior |
| Delivered evidence state | `session`, transport continuations, coverage and recovery sections | You must determine what evidence has already been delivered, what was withheld recoverably, and what remains unavailable |

## Calibration limits

Evidence strength controls the strongest claim available:

- `exact` is directly established by compiler or source evidence within reported coverage;
- `derived` is deterministically computed from disclosed input facts;
- `candidate` is ambiguous or heuristic and requires confirmation;
- `mixed` preserves constituents of different strengths;
- `unknown` has no calibrated strength and cannot support a stronger claim than the raw observation.

The current general blind spots are whole-program interprocedural value flow, heap and cross-instance aliasing, interprocedural exceptional flow, reflection, generated dispatch, and framework crossings without a registered adapter. Missing edges across one of these frontiers are unknown, not proof that the behavior is absent. Close only the named material gap with `dependence-slice`, `inspect`, `code`, or an exact text search as the reported recovery permits.
