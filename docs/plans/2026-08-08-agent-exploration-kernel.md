# Agent Exploration Kernel

**Date:** 2026-08-08
**Status:** Superseded by [`2026-08-08-open-ended-typed-subgraph-exploration.md`](./2026-08-08-open-ended-typed-subgraph-exploration.md)
**Mission:** Let an agent accurately answer arbitrary questions about an indexed repository using no more exploration tokens than native text-search and source-reading tools.

> **Decision correction:** The proof-obligation and proof-path-selection design below would still require scip-query to infer task relevance and guide the model's next move. The successor plan retains the compact surface, honest evidence, and transport separation, but replaces relevance inference with agent-selected typed subgraph projections and topology-preserving compression. This document remains as decision history.

## Outcome

scip-query presents agents with a small deterministic exploration kernel that locates exact referents, traverses explicitly requested relationships, reads selected behavior, and reports only material gaps. The larger analysis suite remains available for humans and specialized workflows, but it is no longer part of the default decision surface an exploring agent must understand.

Accuracy remains the first gate. Token savings count only when the treatment establishes at least the same material facts as the native control on the same frozen checkout, prompt, model, and rubric.

## Definitions

An **exploration surface** is the set of commands and outputs through which an agent perceives a repository. Its defining characteristic is that it controls which repository facts enter the agent's context and which possible next actions compete for its attention.

An **evidence provider** is a mechanism that derives repository facts from a particular observable source. SCIP occurrences, compiler resolution, syntax trees, static value evaluation, Git history, and configured architectural rules are different providers because each can establish different relationships and has different coverage limits.

An **edge** is an evidenced directional relationship between two program referents, such as one function calling another, one module importing another, or one queue send corresponding to a consumer. An edge establishes only the relationship named by its subtype and provenance; its existence does not imply execution, value transfer, or timing unless that is the relationship proved.

A **runtime boundary** is a relationship in which control or information passes between code locations through a runtime mechanism instead of an ordinary compiler-visible call. HTTP requests and handlers, queue sends and consumers, and registry dispatches and handlers are runtime-boundary referents.

**Relevance** is the property of evidence whose presence or absence can change whether a named material claim is established. Repository facts cannot be classified as relevant in the abstract; relevance requires a root, a requested relationship, a direction, and a stopping condition or endpoint.

A **proof obligation** is a relationship the agent has explicitly committed to establish, exclude, or report unsupported before answering. For an end-to-end explanation, typical obligations are entry, behavior-changing predicates, data transformation, state changes, runtime crossings, emitted effects, terminal returns, and failures.

## Current evidence foundation

scip-query assembles its repository model from several sources rather than receiving one complete graph from SCIP.

| Provider | Observable referents | What it establishes | Material limitation |
| --- | --- | --- | --- |
| SCIP index | Compiler symbols, definitions, occurrences, documents, source ranges | Stable symbol identity, definitions, references, symbol kinds, and indexed dependency evidence | Not a complete call graph, value-flow graph, runtime trace, or behavioral explanation |
| Tree-sitter AST and source facts | Calls, conditions, loops, assignments, returns, awaits, syntax ownership | Local constructs, callsites, behavior skeletons, mutations, lexical order, and adapter patterns | Local syntax does not by itself resolve arbitrary cross-file identity |
| ts-morph TypeScript provider | TypeScript compiler symbols and project configuration | Imports, references, callees, signatures, hierarchy, package exports, and cross-file resolution | TypeScript-only and limited to the semantic operations exposed by the provider |
| Static value flow | Literals, constants, identifiers, finite alternatives, symbolic expressions | Paths, keys, discriminators, and other values used to join runtime observations | Stops when a value is dynamic or unsupported; it is not general runtime evaluation |
| Runtime-boundary extractors | HTTP, Effect HTTP API, child process, registry, persistence, queue, carrier, and mount patterns | Source-grounded producer and consumer observations and mechanically joined handoffs | Exact only within supported adapters and resolvable keys; unresolved observations are not traversable edges |
| Git, package metadata, conventions, and config | Diffs, commit history, exports, entry roots, architecture rules | Change impact, co-change, public surfaces, operational roots, and project-owned constraints | Contextual metadata rather than executable program reachability |
| Similarity and cleanup analyzers | Callee sets, source-token sets, dependency profiles, frontend structure | Ranked reuse, duplication, drift, and cleanup candidates | Heuristic leads, not causal navigation edges |

For TypeScript, ts-morph is the semantic query provider; scip-query is not using a TypeScript LSP for this role. The incremental TypeScript index service and document emitter produce SCIP material, Tree-sitter supplies the source syntax layer, and Volar augments Vue-specific references.

Direct evidence:

- The semantic provider exposes import usage, references, callees, and signatures in [`src/semantic/types.ts`](../../src/semantic/types.ts#L83).
- The TypeScript compiler-backed implementation is in [`src/semantic/typescript/ts-morph-provider.ts`](../../src/semantic/typescript/ts-morph-provider.ts#L166).
- Call evidence fuses AST callsites, semantic callees, and SCIP mentions in [`src/symbols/graph/call-graph-evidence.ts`](../../src/symbols/graph/call-graph-evidence.ts#L42).
- Runtime-boundary adapters are registered in [`src/analysis/runtime-boundaries/extractors.ts`](../../src/analysis/runtime-boundaries/extractors.ts#L28), and their join rules are explicit in [`src/analysis/runtime-boundaries/graph.ts`](../../src/analysis/runtime-boundaries/graph.ts#L41).

## Current graph layers

The graph vocabulary currently has three layers that should not be presented as if they were independent analytical capabilities.

### Raw relations

The system map begins with five primary relation kinds:

```text
call
contract-symbol
import
reference
runtime-boundary
```

It also creates synthetic structural membership, runtime-observation ownership, and external-import relations.

### Semantic families

Raw relations and source-derived program facts are interpreted through six general families:

```text
identity
contract
control
data
state
temporal
```

These families are a general representational vocabulary. A provider can add a framework-specific subtype without adding a new top-level family. This does not mean that current providers can detect every relationship representable by the vocabulary.

### Agent-facing categories

The evidence command expands the semantic families into nine display categories:

```text
execution
runtime
dataflow
state
temporal
contract
identity
ownership
dependencies
```

Examples:

```text
call                  -> control/call             -> execution
runtime-boundary      -> control/runtime-handoff  -> runtime
import                -> identity/imports         -> dependencies
structural-membership -> identity/contains        -> ownership
```

The mapping is implemented in [`src/queries/navigation/graph-evidence.ts`](../../src/queries/navigation/graph-evidence.ts#L258). Similarity is outside this causal graph: callee fingerprints use weighted cosine similarity, while the source-token fallback uses Jaccard similarity in [`src/queries/cleanup/similar.ts`](../../src/queries/cleanup/similar.ts#L187).

The current `dataflow` command is also narrower than its name suggests. It reports outgoing callees as producers and incoming callers or reference sites as consumers in [`src/queries/navigation/dataflow.ts`](../../src/queries/navigation/dataflow.ts#L90). That is reference-level neighborhood evidence, not a general interprocedural definition-to-use analysis.

## Current selection and output behavior

`graphEvidence()` explicitly performs no task-relevance inference. It constructs the full supported system-map relation set, projects semantic categories, sorts edges primarily by distance from selected roots, penalizes structural-only endpoints, prefers stronger evidence, and then round-robins across requested families. The default packet permits 48 edges and uses a wider 50,000-character internal topology budget.

Direct evidence:

- The absence of task-relevance inference and current budgets are stated in [`src/queries/navigation/graph-evidence.ts`](../../src/queries/navigation/graph-evidence.ts#L100).
- Distance, structural penalty, strength, and fixed family ordering determine ranking in [`src/queries/navigation/graph-evidence.ts`](../../src/queries/navigation/graph-evidence.ts#L331).
- Coverage-diverse family round-robin determines final selection in [`src/queries/navigation/graph-evidence.ts`](../../src/queries/navigation/graph-evidence.ts#L208).

This selection rule optimizes graph proximity and category diversity. It does not optimize whether an edge can establish one of the agent's material claims.

The human renderer also gives substantial space to epistemic bookkeeping. Source inspection currently emits an evidence packet, literal values, an omission ledger, a next causal frontier, packet coverage, and query completion. The section assembly is in [`src/runtime/query-commands/navigation.ts`](../../src/runtime/query-commands/navigation.ts#L600).

Transport pagination is a different concern. It snapshots already-selected output and asks the agent to rerun with an output cursor until the selected bytes are delivered; it does not select more graph evidence. Its implementation is in [`src/runtime/output-pagination.ts`](../../src/runtime/output-pagination.ts#L490). The agent setup explicitly requires draining `Continue exactly:` commands in [`src/runtime/agent-setup.ts`](../../src/runtime/agent-setup.ts#L99).

## Benchmark evidence and diagnosis

The latest held task used the same frozen OpenCode checkout and question for a Sol medium treatment and native control.

| Run | Total tokens | Uncached tokens | Tool calls | Human fact recovery |
| --- | ---: | ---: | ---: | ---: |
| Current scip-query treatment | 2,402,269 | 156,739 | 30 | About 2/7 complete and 4.5/7 partial |
| Native control | 1,207,455 | 103,381 | 18 | About 3/7 complete and 6/7 partial |

Both scored 0/7 under the overly brittle strict matcher, so human fact review is the material comparison. The treatment made two consequential mistakes: it selected the HTTP V2 POST route instead of the intended public native `OpenCode.sessions.prompt` path, and it reported the legacy retention clamp as 4,000–20,000 instead of 2,000–8,000.

Only one treatment operation required actual transport continuation. The dominant excess was repeated search and inspect activity. The treatment did not meaningfully use the direct `evidence` traversal as intended.

The current failure is therefore best explained by four interacting causes:

1. The agent-facing command set mixes exploration, cleanup analysis, architecture, change planning, and index administration.
2. Several labels imply stronger or more uniform semantics than their implementations provide, especially `dataflow`, slices, and similarity.
3. Edge selection optimizes proximity and family diversity rather than proof relevance.
4. Coverage and recovery metadata gives every possible frontier visual salience, encouraging the agent to treat optional graph directions as unfinished work.

The evidence substrate is not fundamentally invalid. The current product boundary and default interaction contract are the primary experiment to change next.

## Design decisions

### 1. Expose a small exploration kernel

The default agent workflow should have four conceptual operations:

```text
locate
  Find exact textual, file, location, or compiler referents.

traverse
  Request named relationships, directions, bounds, and stopping conditions.

read
  Materialize connected behavior or exact source only for selected gaps.

gaps
  Report only requested relationships that were bounded, ambiguous, or unsupported.
```

Existing commands remain available as compatibility aliases and expert tools. Cleanup detectors, architecture reports, cache administration, and specialized frontend analyses should not appear in the default exploration instructions.

### 2. Use an explicit selection contract instead of intent inference

The CLI should not infer what a natural-language task means. The agent names:

- exact roots;
- relationship families or subtypes;
- direction;
- depth or endpoint condition;
- whether the request requires exhaustive coverage.

An edge is eligible for the main packet when it participates in a proof path for the requested relationship or represents a material sibling outcome on that path. Evidence strength breaks ties: exact before mechanically derived, mechanically derived before candidate.

For an open-ended end-to-end explanation, the skill requires the agent to establish entry, behavior-changing predicates, data transformation, state change, runtime crossings, external effects, terminal return, and failure behavior. These obligations provide the stopping rule; generic frontier availability does not.

### 3. Make the compact packet the default

The default response should contain:

```text
ROOTS
PROOF PATHS AND EFFECTS
MATERIAL SIBLING BRANCHES
COVERAGE: one compact line
NEXT: at most one recovery batch, only when a requested obligation remains unresolved
```

Detailed omission groups, provider diagnostics, full frontier manifests, and selection accounting remain recoverable behind an explicit verbose or coverage-explanation option. A bounded relevant relationship may never disappear silently; it is counted in the compact coverage receipt and recoverable by a stable selector.

### 4. Separate transport from semantic recovery

Transport continuation should be automatic in the agent integration where possible. If a selected packet requires several byte pages, the integration should concatenate those pages before returning control to the model. A transport cursor must never resemble a semantic recommendation.

Semantic recovery remains model-visible only when a requested relationship could not fit or could not be resolved.

### 5. Repair terminology before expanding providers

- Rename or clearly qualify `dataflow` as reference/usage flow unless and until it becomes a genuine definition-to-use provider.
- Describe forward and backward slices by the actual edges they traverse.
- Keep similarity in the candidate-analysis suite rather than the causal edge taxonomy.
- Publish a provider-support matrix for each runtime-boundary subtype and evidence strength.
- Preserve the six universal semantic families while allowing extensible provider-specific subtypes.

## Implementation slices

| Change | Direct evidence | Preserve | Retire | Prove |
| --- | --- | --- | --- | --- |
| Freeze the current branch as the analytical and benchmark baseline; record treatment/control artifacts and manual rubric judgments | Existing baseline ledger and the run artifacts named above | Current graph providers, index behavior, and held-task comparability | Unrecorded benchmark interpretations | A fresh report can reproduce run metadata and manual scoring without rerunning the agents |
| Reduce installed agent guidance to the four-operation kernel and explicit end-to-end obligations | `skills/scip-query/SKILL.md`, `skills/scip-explore/SKILL.md`, and `src/runtime/agent-setup.ts` own the current instructions | Exact-evidence discipline, coverage honesty, and no native-source fallback | Overlapping command catalogues and generic frontier-chasing rules | Agent-setup contract tests show the smaller guidance; a trace shows the model can begin without invoking help |
| Add a compact default evidence/source renderer with verbose accounting available explicitly | `graphEvidence()` returns fact and coverage fields; `sourceInspectionSections()` currently assembles all ledger sections | Every withheld requested edge remains counted and recoverable | Default omission ledger, full frontier catalogue, repeated provider prose, and multiple recovery batches | Golden CLI tests prove compact output, one recovery batch maximum, and lossless verbose recovery |
| Replace family round-robin with request-aligned proof-path selection | `selectCoverageDiverseEdges()` currently round-robins by display family after root-distance ranking | Determinism, evidence strength, explicit bounds, and coverage accounting | Diversity as the default proxy for relevance | Graph tests show irrelevant sibling families cannot displace a requested exact path; material sibling branch outcomes remain present |
| Separate transport completion from semantic gap recovery | `output-pagination.ts` owns snapshot pages and `agent-setup.ts` requires model-visible draining | Bounded memory, stable output snapshots, and exact byte recovery | Model-visible cursor work in integrations that can auto-drain | Pagination tests prove automatic concatenation is byte-identical and semantic coverage is reported once |
| Correct capability names and publish a source/proof matrix | `dataflow.ts`, `similar.ts`, runtime-boundary rules, and graph semantic projection establish the current meanings | Backward-compatible command aliases and JSON contracts where required | Claims that reference flow is full dataflow or similarity is causal reachability | Command-reference and API tests describe exactly what each relation proves |
| Rebench the interface-only treatment before changing evidence providers | The latest trace shows repeated command selection, not transport paging, dominated the regression | Frozen checkout, prompt, model, rubric, token accounting, and native control | Any interface version that spends more than native while recovering fewer facts | Held tasks across at least two repositories and two task shapes meet the accuracy gate and do not exceed native exploration tokens |
| Improve providers only for facts that remain missing after the simplified-interface benchmark | Runtime-boundary frontiers and true value-flow gaps identify unsupported proofs | General semantic families and source-grounded provenance | Provider additions motivated only by hypothetical completeness | Each provider change recovers a preregistered held-out fact without increasing false exact edges |

## Benchmark gate

Every comparison must use:

- the same disposable frozen checkout;
- one treatment with scip-query and its index;
- one control without scip-query or its index;
- the same model, reasoning setting, prompt, timeout policy, and answer rubric;
- preregistered material facts with manual review in addition to a strict matcher;
- total tokens, uncached tokens, rendered characters, semantic queries, native reads, wall time, and recovered facts;
- retained run artifacts but automatic removal of disposable worktrees and per-run caches.

The first acceptance gate is non-inferiority: treatment accuracy must be at least control accuracy and treatment exploration tokens must not exceed control. Token savings become an optimization target only after that gate holds on multiple held-out tasks. A change is not generalized merely because it improves the repository or task used to develop it.

## Open uncertainties

1. Whether the existing `evidence` result contains enough endpoint and branch information for proof-path selection without changing the graph schema. Resolve by testing exact call, runtime, state, and temporal obligations against current topology fixtures before adding fields.
2. Whether automatic transport draining belongs in the CLI process, benchmark harness, or agent integration. Resolve by mapping all current consumers of `continueCliOutput()` before changing the public pagination contract.
3. Whether the current material-claim ledger belongs entirely in the skill or needs an opaque CLI obligation identifier. Begin skill-only; add persisted obligation state only if traces show the agent repeatedly loses its stopping condition.

## Game plan

Preserve the current graph implementation as the baseline, simplify the installed agent guidance to a four-operation exploration kernel, make evidence output compact and obligation-driven, replace family-diverse edge selection with deterministic proof-path selection, and hide transport pagination from the model where the integration can drain it automatically; then rerun frozen treatment/control benchmarks across held-out tasks before modifying runtime-boundary or value-flow providers, adding analytical machinery only when a preregistered missing fact proves that the simplified interface still lacks evidence rather than merely presenting existing evidence poorly.
