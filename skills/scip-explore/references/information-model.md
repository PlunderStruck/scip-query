# scip-query information model

Use this map to decide what kind of repository fact a ledger row requires. It inventories information classes rather than prescribing a route. For command selection and current index prerequisites, use the shared [command decision guide](../../scip-query/references/command-guide.md). `scip-query --help-all` remains the runtime inventory; `scip-query capabilities --matrix` reports current provider support when that is a named uncertainty.

## Direct system evidence

| Information kind | What its real referents are | What it can establish | What it cannot establish alone |
|---|---|---|---|
| Current text | Exact current project bytes, occurrences, paths, and aligned compiler owners | Cardinality and location within reported text coverage | Task relevance or executable reachability |
| Source structure | Compiler-owned files, symbols, members, methods, nesting, and ranges | What constructs exist and contain one another | That a construct runs or is externally active |
| Entry and consumer surfaces | Callables where control may enter and symbols outside consumers actually use | Candidate ingress, static downstream reach, and published use | Runtime invocation from visibility or zero callers alone |
| Execution and control | Calls, callbacks, returns, throws, branches, loops, handlers, and local control dependence | Static may-call and supported control reachability | That an invocation occurred, completed, or selected a candidate target at runtime |
| Data movement | Arguments, parameters, definitions, uses, returns, captures, field uses, serialized discriminators, and values written to state | Supported local and bounded cross-call value transfers | General interprocedural definition-use flow, heap aliasing, or every eventual consumer |
| Runtime handoff | Source-grounded producers and consumers joined by queues, events, commands, discriminators, or registered adapters | Supported producer/consumer rendezvous and dispatch identity | Successful delivery, retry, or an unregistered framework crossing |
| State interaction | Identified resources read, written, deleted, enqueued, or consumed | Which construct performs which observed state operation | Transactionality, durability, alias identity, or exclusive ownership unless separately evidenced |
| Temporal order | Local successors, await completion, lock scope, and supported enqueue-before-consume order | Reported local or adapter-backed before/after relations | Cross-process happens-before, durable completion, or exceptional completion |
| Contracts | Interfaces, types, and other compiler/source contracts used by a construct | The identified constraint relationship | Runtime invocation or unchecked behavioral conformance |
| Identity | Compiler- or source-owned observations that refer to the same entity | Same-entity references within coverage | Execution, value transfer, or active product selection |
| Ownership | Structural containment or observation ownership between code, runtime observations, and state resources | What contains or owns an observed unit | Lifetime, singleton scope, or per-session sharing unless source behavior establishes it |
| Dependencies and topology | Imports, reverse imports, file dependencies, cycles, depth, coupling, and cross-file coordination hubs | Static reliance and structural shape | Execution, runtime contention, or architectural intent by itself |
| Implementation behavior | Exact statements and connected source units selected for a named gap | Current source behavior for materialized units | Callers, runtime reachability, or relevance without surrounding evidence |

The eleven `evidence` controls are incoming and outgoing `execution`, incoming and outgoing `dataflow`, plus `runtime`, `state`, `temporal`, `contract`, `identity`, `ownership`, and `dependencies`. They cover nine top-level relationship classes.

## Task-specific analyses

Select the required information first, then consult the relevant command-guide section:

- [Planning and actual change review](../../scip-query/references/command-guide.md#orientation-and-change-review): reuse candidates, changed metrics and downstream consumers.
- [Architecture and dependencies](../../scip-query/references/command-guide.md#architecture-and-dependencies): policy, structural connections, historical coordination and placement.
- [Simplification and cleanup](../../scip-query/references/command-guide.md#simplification-and-cleanup): complexity, slices, duplication and possible removal.
- [Framework investigations](../../scip-query/references/command-guide.md#framework-investigations): React and Vue behavior patterns.
- [Implementation integrity](../../scip-query/references/command-guide.md#implementation-integrity): promises, live routing, placeholders, checks and migrations.
- [Tool operations](../../scip-query/references/command-guide.md#tool-operations): index freshness, capability, installation and repair.

These analyses are optional answers to specific questions, not ordinary stages in every exploration. Their measurements and candidates do not establish design quality or runtime behavior by themselves.

## Calibration limits

Evidence strength controls the strongest claim available:

- `exact` is directly established by compiler or source evidence within reported coverage;
- `derived` is deterministically computed from disclosed input facts;
- `candidate` is ambiguous or heuristic and requires confirmation;
- `mixed` preserves constituents of different strengths;
- `unknown` has no calibrated strength and cannot support a stronger claim than the raw observation.

The current general blind spots are whole-program interprocedural value flow, heap and cross-instance aliasing, interprocedural exceptional flow, reflection, generated dispatch, and framework crossings without a registered adapter. Missing edges across one of these frontiers are unknown, not proof that the behavior is absent. Close only the named material gap with `dependence-slice`, `inspect`, `code`, or an exact text search as the reported recovery permits.
