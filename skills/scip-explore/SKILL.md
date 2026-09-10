---
name: scip-explore
description: Understand existing implementation paths, callers, consumers and dependencies with targeted relationship queries and ordinary source reads.
---

# SCIP Explore

Load `$scip-query` for mechanics when the question crosses code locations or module boundaries. Use ordinary search and file tools for a local lookup or implementation read.

A repository system is cooperating code and resources that turns an initiating input into observable results. Establish only the parts whose behavior could change the requested answer or edit. For substantial work, keep concise notes on established facts and remaining questions; a formal evidence ledger is not required.

## Find the existing path

Start with locations named by the request or found through ordinary search. Use `system --source` when module structure is unknown, `entrypoints` when the initiating surface is unclear, and `context <target>` when existing reuse or impact candidates matter. Avoid repeating source through another command once its behavior is established.

When several implementations appear relevant, compare their entry surfaces, incoming execution, runtime connections and consumers. Path, recency and result order do not establish the live implementation. Keep distinct paths separate until routing or behavior resolves which serves the request.

Before planning new behavior, find a comparable working feature and the central path it uses. Identify the existing owners and extension points. Use `$scip-plan` to document this flow and the reuse decisions before implementation.

## Resolve relationships and behavior

Choose the relationship that answers the next concrete question: incoming execution for callers; outgoing execution for callees; runtime for producer/consumer handoffs; dataflow for value transfer; dependencies for module reliance. Batch related roots. Use another family only when its meaning matches the missing fact. The [command guide](../scip-query/references/command-guide.md#exploration) covers specialist choices.

Read implementations and relevant invocations with ordinary tools to verify predicates, arguments and effects. Preserve the decisions that matter: authorization, precedence, bounds, transformations, state writes, returned defaults, notifications, owner lifetime, concurrency, errors and recovery. Follow queued work to its consumer when completion depends on it.

Read saved results selectively. Expand a graph or recover omitted details only when they could change the conclusion. A bounded call list cannot establish what every caller passes, and a local slice cannot establish whole-program value history. Do not treat missing or unsupported relationships as proof of absence.

Stop when the relevant behavior and consequences are established or the remaining limitation is explicit. Do not collect unrelated symbols, read every file in a result or run every available analysis.

## Explain what matters

Connect the initiating surface, existing owners, decisions, effects and observed result in the order needed to understand them. Cite exact files/lines or symbols. Preserve material alternative outcomes and uncertainty without adding a routine coverage footer or a transcript of the exploration.

Read [the information model](references/information-model.md) only for uncertain relationship support. The [external evidence protocol](references/external-evidence.md) applies only when an explicit runner supplies `SCIP_EXPLORE_EVIDENCE_DIR` and `SCIP_EXPLORE_LEDGER`; its checkpoint machinery is not the ordinary workflow. Use [delegated exploration](references/delegated-exploration.md) only when delegation and that checkpoint protocol are explicitly requested.
