# Exploration surface audit

## Outcome

scip-query's current architectural premise is correct: the agent decides what repository facts matter, while the tool performs declared observations over exact text, compiler identities, typed relationships, and source. The current product surface does not yet express that premise consistently. The CLI exposes 99 commands, the canonical skill names ten, the ordinary exploration loop needs six, several instruction layers disagree, and representative probes exposed two incorrect sensor readings.

An exploration surface is a set of repository sensors an agent deliberately operates. Its essential characteristic is that each control answers a declared question without choosing the user's objective, relevant subsystem, preferred route, or stopping point. An edge family is a class of code relationships whose members establish the same kind of fact. Coverage is the accounting that distinguishes returned evidence, recoverably withheld evidence, and evidence the current providers cannot establish.

## Intended control loop

1. The agent privately identifies the material facts the answer must establish.
2. A locator returns concrete text, file, entry, symbol, or source-location referents without ranking task relevance.
3. The agent chooses relationship families and directions capable of establishing each unresolved fact.
4. `evidence` performs that explicit projection and reports facts, evidence strength, coverage, and recoverable omissions.
5. `inspect` or `code` reads only a named behavioral or syntactic gap.
6. The agent stops when every material fact is established, explicitly unsupported, or justified as immaterial.

The CLI must never substitute query-vocabulary ranking, automatic route selection, next-symbol scoring, file similarity, or a query-count target for the agent's judgment.

## Current instruction chain

| Layer | Current responsibility | Direct evidence |
|---|---|---|
| Repository guidance | Condensed locate → project → read workflow | `AGENTS.md:4-35` |
| `scip-explore` | Material-fact ledger, completeness judgment, stopping rule | `skills/scip-explore/SKILL.md:8-34` |
| `scip-query` | Command choice, relationship meanings, evidence and coverage interpretation | `skills/scip-query/SKILL.md:48-76` |
| Held benchmark prompt | Read-only enforcement and a duplicated exploration workflow | `scripts/codex-exploration-trial-core.mjs:25-43` |
| Generated command reference | Syntax, categories, relationship providers, options, and compatibility commands | `docs/COMMAND_REFERENCE.md:1-254` |

The intended responsibility split is sound. The benchmark prompt still exposes a four-query efficiency target and permits one `anchors` fallback. The capability renderer also calls anchors an optional discovery fallback. These contradict the evidence-driven stopping rule and deprecated compatibility status.

## Current controls

### Canonical exploration controls

| Stage | Control | Declared reading |
|---|---|---|
| Locate | `search` | Exact text cardinality, compiler/source owners, representative source, and structural recovery scopes |
| Locate | `outline` | Compiler-owned constructs and ranges in one known file |
| Locate | `entrypoints` | Possible external entry constructs with entry evidence and indexed caller counts |
| Project | `evidence` | Explicitly selected typed relationships from exact roots |
| Read | `inspect` | Deduplicated behavior or source for several named gaps |
| Read | `code` | Exact definitions, exact ranges, or file surfaces when syntax matters |

`context`, `diff-impact`, `architecture`, and `health` are task-specific analyzers, not ordinary exploration phases. The remaining commands are specialized single-relation views, impact and cleanup analyses, maintenance operations, formal-model operations, or compatibility aliases. They may remain callable without appearing as one undifferentiated default agent palette.

### Relationship controls

| Material question | Family and usual direction | Establishes | Does not establish |
|---|---|---|---|
| Who can call or reach this? | `execution incoming` | Static may-call or local control reachability | That an invocation occurred at runtime |
| What can this call or reach? | `execution outgoing` | Static downstream reachability | Delivery, success, or runtime selection |
| Where can this value come from? | `dataflow incoming` | Supported definition, argument, parameter, return, or state-value transfer | General heap, alias, exceptional, or whole-program flow |
| Where can this value go? | `dataflow outgoing` | Supported value transfer | Every eventual runtime consumer |
| What resource is observed or changed? | `state` | Reads, writes, creates, deletes, enqueues, or consumes an identified resource | Transactionality, durability, or exclusive ownership unless separately qualified |
| What occurs before or after this? | `temporal` | Reported local or boundary ordering | Cross-process happens-before or durable completion |
| Which producer and consumer rendezvous? | `runtime both` | Source-grounded runtime handoff or discriminator dispatch | Successful delivery, retry, or handling for unresolved/candidate joins |
| What interface constrains this? | `contract` | Compiler/source contract identity | Runtime invocation or behavioral conformance |
| Are these the same entity? | `identity` | Compiler/source identity | Execution or value transfer |
| What contains or owns this? | `ownership` | Structural containment or observation ownership | Runtime lifetime or singleton scope |
| What does this statically rely on? | `dependencies` | Imports and indexed dependencies | Execution |
| How are selected roots connected? | selected families plus `--connecting` | Deterministic paths within the declared projection | Relevance of that connection to the task |

The nine families are a sufficient extensible top-level vocabulary. New analyzers should register subtypes and evidence providers under them rather than create task-specific relevance concepts.

## Findings

### Correctness defects

1. **Leaf-name call collisions are rendered as causal recovery.** `inspect --view behavior` over `sourceSearchScopeRows()` presented ordinary `.push()` and `.slice()` calls as uniquely resolved project call targets in unrelated files. `inspectSource()` constructs its causal frontier through `sourceRangeNextAnchorPacket()` (`src/queries/navigation/source-inspection.ts:410`). The fallback at `src/queries/internal/next-anchor-candidates.ts:795-844` searches the repository-wide leaf index when compiler and imported-member resolution fail, then emits a single same-name definition as a candidate recovery target. A lexical name collision is not executable reachability and must not become an exact drill-down command.
2. **Exact repository paths can inherit unrelated semantic overlays.** `outline AGENTS.md` returned every definition in `src/runtime/project-setup.ts`, and `code AGENTS.md` attached those definitions as omitted AGENTS members. `outline()` calls `resolveIndexedPaths()` (`src/queries/navigation/outline.ts:22-24`), whose `resolveDocumentCandidates()` falls back from an unindexed document path to `findFirstSymbolMatch()` (`src/queries/internal/file-resolution.ts:60-77`). Exact tracked-text paths must never fall through to symbol-text resolution.

### Instruction and control-surface defects

1. The benchmark advertises a semantic-query target even though accuracy is the completion criterion (`scripts/codex-exploration-trial-core.mjs:25-37`). Query count should remain an external measurement.
2. The benchmark and capability renderer retain anchors as fallback discovery (`scripts/codex-exploration-trial-core.mjs:37`; `src/runtime/commands/command-handlers.ts:1363`) while the canonical skill marks anchors deprecated.
3. `evidence` is two operations under one name. A positional invocation runs legacy qualified source evidence; an explicit selector/edge invocation runs graph projection (`src/runtime/query-commands/navigation.ts:1813-1885`). The canonical control must have one meaning.
4. `context` emits `REUSE DECISIONS` and `READ NEXT` (`src/runtime/query-commands/planning.ts:154-174`). Its next-read rows combine definitions, references, callers, callees, and heuristic reuse candidates (`src/runtime/query-commands/planning.ts:229-244`). This is a planning analysis and must not be presented as task relevance or remain in the ordinary exploration shortlist.
5. Default `--help` exposes 99 commands in one flat surface. Compatibility aliases and maintenance operations compete visually with primary exploration controls.
6. Only four descriptor regions declare `contrasts`, so the generated metadata does not yet explain most overlapping commands (`refs` versus `evidence`, `call-graph` versus execution projection, `value-flow` versus dataflow projection, and similar pairs).

### Readout defects

1. Human graph rows use `exact`, `mixed`, `derived`, `candidate`, and `unknown`, but agent guidance explains only exact and candidate.
2. Human evidence output can state that additional blind spots exist only in JSON, while the skill tells agents to prefer human output and not rerun a successful command as JSON.
3. `evidence` emits a warning, request description, inventory, materialized edges, folds, coverage, several blind spots, and hidden blind-spot counts without a stable facts-first hierarchy.
4. Inventory counts such as incoming, outgoing, and both are not defined sufficiently for an agent to explain apparent non-additivity.
5. `inspect --view behavior` can render the selected construct verbatim while compressing only helpers. The term `behavior` therefore does not reliably imply compressed behavioral representation.
6. `entrypoints` labels package-public exports as roots even when public visibility is the only established property. Exported entry candidates must remain distinct from framework, executable, or externally invoked entry points.
7. `status --capabilities` mixes index, watcher, cache, and reindex telemetry with semantic navigation guidance. `capabilities` should own the instrument manual; `status` should own operational state.

## Analytical ceilings that must remain explicit

- TypeScript local reaching definitions and control dependence do not establish general interprocedural, heap, alias, exceptional, or closure-invocation flow.
- Runtime-boundary joins cannot cover arbitrary reflection, generated names, dependency-injection containers, framework registries, or data-mediated dispatch without a registered adapter or exact source evidence.
- Local temporal order does not establish cross-process ordering or durability.
- Package exports and zero indexed callers do not alone establish runtime ingress.
- Language support is provider-dependent. Unsupported language/relationship pairs must be reported unavailable rather than approximated as exact.

These are not reasons to add an intent oracle. They are calibration limits that let the pilot know which instruments are unavailable.

## Preserve, retire, and add

Preserve exact selectors, explicit edge choice and direction, provider provenance, evidence strength, source-grounded runtime joins, stable folds, complete cardinality, exact recovery commands, session receipts, and coverage honesty.

Retire from the canonical surface query-vocabulary anchors, automatic routes, next-anchor recommendations, leaf-name recovery targets, relevance-scored reads, agent-visible query targets, dual-mode evidence semantics, hidden human-output limitations, and flat presentation of compatibility commands.

Add a descriptor-generated exploration manual, a relationship decision table, definitions for every evidence-strength state, neutral task-specific analyzer language, a uniform human readout contract, collision fixtures, and repeated accuracy-first held evaluations.

## Acceptance standard

- A sensor may report unresolved rather than guess; it may never present a lexical or path collision as executable or semantic identity.
- Every canonical control has one primary meaning, declared inputs, facts returned, evidence ceiling, cost, contrasts, and exact gap-closing controls.
- Human output contains every material limitation needed to interpret the result.
- The agent-visible prompt contains no query-count target, anchor fallback, automatic route, or next-symbol recommendation.
- Held treatment accuracy must not regress. Equal accuracy should cost no more than baseline when practical; a modest token increase is acceptable only for a material, repeatable accuracy gain.

