# Navigation Inference Retirement

**Date:** 2026-08-08
**Status:** Implementation repaired after held failures; acceptance rerun pending
**Scope:** Remove inferred task relevance from the canonical exploration path while preserving exact graph facts, explicit projections, lossless compression, and public compatibility.

## Outcome

scip-query exposes one canonical repository-graph operation in which the agent supplies exact roots, relationship families or subtypes, direction, and bounds. The CLI resolves identities, derives typed relationships, orders facts deterministically, compresses the selected topology without semantic loss, and reports exact recovery handles. It does not interpret English task intent, select a supposedly relevant subsystem, choose the next anchor, or decide which proof path matters.

The existing `anchors` and `system-map` surfaces become compatibility or expert views rather than prerequisites for agent exploration. Their public contracts remain usable during a deprecation window, but their ranking machinery is not reused by the canonical graph path.

## Essential distinctions

An **anchor** is a concrete program referent used as a graph root, such as a compiler symbol, source construct, file location, or runtime address. What makes it an anchor is not a score or inferred importance; it is the agent's explicit choice to begin a graph operation there.

A **locator candidate** is a repository referent whose exact text, identity, path, or source ownership matches a locator request. Candidate ordering helps a user resolve ambiguity, but it does not establish that one candidate is relevant to the larger task.

A **projection** is a subgraph whose membership is determined by explicit roots, relationship types, directions, and bounds. It differs from a ranked result set because every included and omitted unit follows from declared graph operations rather than a guess about intent.

A **relevance ranking** is an ordering intended to predict which repository facts matter to a natural-language task. Its defining dependency is on an unproved interpretation of the task, so it does not belong in the graph core.

An **evidence ordering** is a stable ordering among facts already eligible under an explicit projection. It may prefer exact evidence over derived or candidate evidence, but it cannot make an otherwise eligible relationship disappear without coverage accounting.

A **structural selection** is a graph operation whose result follows from topology, such as a shortest path between explicit roots, an incoming reachability cone, a strongly connected component, or a fold expansion. It is valid when the agent explicitly requests the operation and every excluded relationship is outside the declared contract or recoverably accounted.

A **semantic contract** is executable metadata that states what a command observes, which graph operation it performs, which units and relationships it can return, what its evidence can establish, what it cannot establish, and how coverage is reported. Its purpose is to let the agent choose a suitable operation without learning scip-query through trial and error.

## Current path

The current implementation has several correct evidence mechanisms, but it mixes them with three separate attempts to choose what the agent should see.

1. `discoverAnchors()` in [`src/queries/navigation/anchor-discovery.ts`](../../src/queries/navigation/anchor-discovery.ts) starts from query terms, but the 2,641-line module also constructs connected flows, parallel paths, cross-boundary groups, effect-owner groups, group rankings, path-vocabulary rankings, and generated `system-map` commands. `compareGroups()` orders groups through query-path matches, group kind, file kind, connectivity, discriminative term coverage, and matched-term counts.
2. `systemMapNextAnchorPacket()` in [`src/queries/internal/next-anchor-candidates.ts`](../../src/queries/internal/next-anchor-candidates.ts) performs another selection pass. `nextAnchorPriority()` scores evidence strength, mutations, exceptions, returns, awaits, file crossings, direction, runtime roles, and source-step roles. `coverageDiverseNextAnchors()` reserves packet space by repository area, query terms, connector roles, and inferred downstream evidence dimensions.
3. `selectExplorationTopology()` in [`src/queries/internal/exploration-topology.ts`](../../src/queries/internal/exploration-topology.ts) correctly connects explicit roots and accounts for folds, but it also calls `queryAlignedCausalSpineNodeIds()` and automatically selects ranked upstream paths. The former scores paths by query-vocabulary overlap and runtime crossings; the latter chooses among public entries, runtime boundaries, and traversal roots without an explicit route request.
4. `graphEvidence()` in [`src/queries/navigation/graph-evidence.ts`](../../src/queries/navigation/graph-evidence.ts) explicitly projects selected semantic families, but `selectCoverageDiverseEdges()` then round-robins families under the output cap after distance and structural ranking. Family diversity is not proof of task relevance.
5. The public surface is real. `AnchorDiscoveryResult` and `discoverAnchors()` are exported from `./queries`; `SystemMapResult.nextAnchors` and `SystemMapOptions.selectionTerms` appear in the generated API contract; CLI options include `--selection-term`, `--gap-callee`, and `--gap-recovery-only`. Removal therefore needs a compatibility policy rather than silent deletion.
6. A descriptor center already exists. `CommandAgentContract` in [`src/runtime/command-kit/command-descriptor-types.ts`](../../src/runtime/command-kit/command-descriptor-types.ts) owns agent questions, result units, inputs, coverage, operation, and contrasts. The new semantic contract should extend this center as a discriminated contract, not create a second command registry.
7. Agent guidance and capability output are still hand-maintained. [`src/runtime/agent-setup.ts`](../../src/runtime/agent-setup.ts), [`skills/scip-query/SKILL.md`](../../skills/scip-query/SKILL.md), [`skills/scip-explore/SKILL.md`](../../skills/scip-explore/SKILL.md), and `renderCapabilityReport()` in [`src/runtime/commands/command-handlers.ts`](../../src/runtime/commands/command-handlers.ts) repeat command meanings that should be rendered from executable contracts where possible.

## Role inventory

| Role                          | Referents                                                                                                    | Disposition                                                  | Reason                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Exact location                | Literal search, outline, exact symbols, file/line ownership, runtime keys                                    | Preserve                                                     | Produces concrete graph roots without claiming task relevance                              |
| Ambiguity presentation        | Exact candidate cardinality, complete identity manifests, deterministic candidate order                      | Preserve                                                     | Lets the agent choose a root while keeping every candidate visible or recoverable          |
| Graph fact derivation         | SCIP identity, compiler calls, AST constructs, value facts, runtime-boundary joins, state and temporal facts | Preserve and harden                                          | These are the evidence substrate                                                           |
| Explicit graph projection     | Roots, edge families or subtypes, direction, depth, connecting paths, endpoint bounds                        | Make canonical                                               | Membership follows from reproducible graph operations                                      |
| Structural compression        | Linear folds, SCC folds, branch/join preservation, exact expansion handles                                   | Preserve and strengthen                                      | Reduces output without inferring irrelevance                                               |
| Deterministic evidence order  | Root distance within the selected projection, evidence strength, stable identity tie-breaks                  | Preserve only as rendering order                             | Stable order is useful as long as it does not silently redefine eligibility                |
| English-query graph grouping  | Connected/parallel/cross-boundary/effect-owner anchor groups                                                 | Retire from the canonical path                               | It predicts which graph region matters before exploration                                  |
| Query-vocabulary path scoring | `selectionTerms`, query-aligned causal spines, term reservations                                             | Delete from the core; deprecate publicly                     | It is task-relevance inference under another name                                          |
| Automatic route choice        | Ranked upstream entries and runtime paths chosen without an explicit route selector                          | Retire as a default                                          | Route catalogues are facts; choosing one is the agent's decision                           |
| Next-anchor recommendation    | Priority-scored next anchors and evidence-dimension reservations                                             | Supersede with inventories and exact frontiers               | The graph should expose available directions, not recommend the next thought               |
| Family round-robin            | One edge per requested family until the cap fills                                                            | Replace                                                      | Diversity is neither completeness nor relevance                                            |
| Compatibility surfaces        | `anchors`, `system-map`, `nextAnchors`, selection-related JSON fields                                        | Keep as thin, deprecated shells for one compatibility window | Avoids an unversioned public break while removing them from the product's core interaction |

## Opportunity ledger

| ID  | Opportunity                                                                    | Evidence                                                                                                        | Disposition                                           | Public constraint                                                                                                   |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| N1  | Separate exact candidate location from graph grouping in `anchor-discovery.ts` | `discoverAnchors()`, `compareGroups()`, and `selectDisplayedGroups()` share one module                          | Supersede                                             | Keep the current CLI/API callable during deprecation; do not recommend it in the installed skill                    |
| N2  | Remove query terms from downstream graph selection                             | `SystemMapOptions.selectionTerms`, `--selection-term`, and `selectionTermMatches` flow into next-anchor ranking | Delete core behavior; deprecate option                | Accept the old option as a no-op with a deprecation notice before removing it in a major release                    |
| N3  | Remove automatic query-aligned causal-spine selection                          | `selectExplorationTopology()` calls `queryAlignedCausalSpineNodeIds()`                                          | Delete                                                | Preserve explicit roots, shortest connectors, junctions, folds, and frontier accounting                             |
| N4  | Stop automatically selecting upstream routes                                   | `selectUpstreamCausalPaths()` ranks public entries, runtime boundaries, and repository areas                    | Supersede                                             | Preserve `catalogExplorationRoutes()` and explicit route IDs; make unrequested route selection zero by default      |
| N5  | Replace next-anchor packets with neutral graph recovery                        | `nextAnchorPriority()` and `coverageDiverseNextAnchors()` score what to inspect next                            | Supersede                                             | Keep `nextAnchors` as a deprecated adapter over exact adjacent/frontier identities for one compatibility window     |
| N6  | Replace family round-robin with explicit projection plus lossless folds        | `selectCoverageDiverseEdges()` interleaves families under `maxEdges`                                            | Replace                                               | Preserve explicit bounds, deterministic output, exact omission counts, and stable expansion                         |
| N7  | Make command meaning executable                                                | Existing `CommandAgentContract` lacks graph operation, direction, relationship semantics, and non-claims        | Enforce                                               | Extend the existing descriptor system with discriminated semantic contracts                                         |
| N8  | Generate agent capability guidance                                             | Setup, skill prose, capability output, and command docs repeat meanings                                         | Generate                                              | Keep genuinely instructional epistemic guidance handwritten; generate finite command facts and support tables       |
| N9  | Report provider support per relation                                           | `project-readiness.ts` reports broad indexing/source/semantic categories rather than edge-level support         | Extract and generate                                  | Report exact, partial, candidate, or unsupported by language/provider without claiming universal availability       |
| N10 | Implement genuine TypeScript definition-use and control dependence             | Current plan and semantic audit show local reaching-definition and control-dependence gaps                      | Defer until N1-N9 establish the stable graph contract | Revisit after a compiler-representation prototype over alias, branch, closure, field, argument, and return fixtures |

## Target architecture

```text
User request
    |
    v
Agent chooses an operation from generated semantic contracts
    |
    +-- locate exact referents -------------------------------+
    |                                                        |
    +-- project roots + edge types + direction + bound ------+
                                                             v
                                                Canonical typed multigraph
                                                - provider provenance
                                                - evidence strength
                                                - coverage/support
                                                             |
                                  +--------------------------+-------------------------+
                                  |                                                    |
                                  v                                                    v
                       topology-preserving compression                     exact behavior/source read
                       - branches and joins                               for an agent-selected gap
                       - cycles
                       - stable folds
                       - exact expansion
                                  |
                                  v
                   faithful subgraph + neutral recovery handles
```

The semantic contract tells the agent what operation can answer which kind of repository question. It does not translate the user's request into proof obligations or automatically invoke commands. The agent remains responsible for choosing roots, projections, drilldowns, and the stopping point.

## Semantic contract design

Extend `CommandAgentContract` rather than adding another registry. Use a discriminated union so the descriptor cannot become a bag of unrelated optional fields.

```ts
type CommandSemanticContract =
  | {
      kind: 'locator';
      locates: readonly ('text' | 'file' | 'symbol' | 'construct' | 'runtime-key')[];
      ranking: 'identity-only' | 'none';
      nonClaims: readonly string[];
    }
  | {
      kind: 'graph-projection';
      rootKinds: readonly ProgramNodeKind[];
      edgeFamilies: readonly ProgramEdgeFamily[];
      directions: readonly ('incoming' | 'outgoing' | 'both')[];
      operations: readonly ('adjacency' | 'reachability' | 'connecting' | 'slice')[];
      compression: readonly ('none' | 'linear' | 'scc' | 'topology')[];
      nonClaims: readonly string[];
    }
  | {
      kind: 'source-read';
      reads: readonly ('behavior' | 'construct' | 'exact-source')[];
      nonClaims: readonly string[];
    }
  | {
      kind: 'analysis';
      analysis: string;
      resultMeaning: string;
      nonClaims: readonly string[];
    }
  | {
      kind: 'maintenance';
      effect: string;
      nonClaims: readonly string[];
    };
```

Existing descriptor fields continue to own evidence origin, coverage policy, operation effects, result units, and command contrasts. Provider-specific edge support belongs beside the program-edge/provider registry, then joins the command contract at render time; it should not be copied into every command descriptor.

Generated surfaces should include:

- a compact agent command catalogue grouped as locate, project, read, analyze, and maintain;
- a relation table stating direction and exactly what each family or subtype establishes;
- explicit non-claims, such as “reference does not establish execution” and “candidate runtime join does not establish a handoff”;
- the current project's provider support by language and relationship;
- command examples assembled from descriptors;
- deprecation notices for compatibility-only surfaces.

## Implementation slices

| Change                                                                              | Direct evidence                                                                                                                                                                  | Preserve                                                                                                                         | Retire                                                                                                  | Prove                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Characterize the current public surface and freeze the benchmark baseline        | Generated API includes `AnchorDiscoveryResult`, `SystemMapOptions.selectionTerms`, and `SystemMapResult.nextAnchors`; CLI descriptors expose `anchors` and selection/gap options | Current JSON shapes, command names, held checkout/prompt/model/rubric, and working provider facts                                | Unrecorded assumptions about compatibility                                                              | API snapshots and focused CLI golden tests capture every field and option before edits; benchmark metadata identifies the exact commit and index generation                                                                                                  |
| 2. Add discriminated semantic contracts to the existing descriptor center           | `CommandAgentContract` already owns answers, returns, inputs, scope, coverage, operation, result units, and contrasts                                                            | Existing contract fields and registration validation                                                                             | A second independent command registry and hand-copied command meanings                                  | Type tests reject incomplete contracts; every public command has one semantic kind; generated catalogue matches registered commands                                                                                                                          |
| 3. Add a provider/relation support registry and generate capability views           | `PROGRAM_EDGE_FAMILIES` and projected subtypes exist, while `project-readiness.ts` reports only broad language capabilities                                                      | Per-edge provenance, strength, exact/partial/candidate/unsupported states, and current runtime probes                            | Claims that one language/provider supports every representable edge                                     | Fixtures enumerate every emitted subtype and provider; capability output changes when a provider is unavailable; no supported edge is absent from the matrix                                                                                                 |
| 4. Make `evidence` the canonical explicit projection contract                       | `evidence` already accepts repeated exact roots, graph families, depth, and optional source; `graphEvidence()` already projects semantic edges                                   | Batched roots, ambiguity failures, family/subtype selection, explicit direction and bounds, evidence strength, coverage          | Hidden all-relation traversal as a user-visible semantic claim and command-specific graph shapes        | Contract tests cover incoming/outgoing/both, multiple roots, multiple families/subtypes, depth, connecting paths, and inventory-only mode without query text                                                                                                 |
| 5. Add edge inventory before large materialization                                  | The current first packet can spend its budget before the agent knows incoming/outgoing cardinality by type                                                                       | Exact counts within provider coverage, compact root identities, and one batched follow-up                                        | Automatic choice of which available direction matters                                                   | Inventory fixtures match the fully expanded graph by direction/family/subtype; the inventory contains no relevance score                                                                                                                                     |
| 6. Remove relevance selection from topology construction                            | `queryAlignedCausalSpineNodeIds()` scores query overlap and runtime crossings; `selectUpstreamCausalPaths()` chooses unrequested routes                                          | Explicit-root connectors, explicit route selection, adjacent branch/join preservation, folds, exact frontier accounting          | Query-aligned spines and default upstream route selection                                               | Changing root labels or unrelated query terms cannot change a projection; explicit route selection remains deterministic and lossless                                                                                                                        |
| 7. Replace graph family round-robin with projection-complete structural compression | `selectCoverageDiverseEdges()` round-robins requested families under `maxEdges`                                                                                                  | Explicit requested families, root distance as stable render order, evidence strength, hard bounds, complete omission accounting  | Family diversity as a proxy for relevance                                                               | Expanding every fold reconstructs the identical selected node/edge multiset; every eligible bounded edge is emitted or belongs to one stable fold                                                                                                            |
| 8. Remove next-anchor recommendations from normal output                            | `nextAnchorPriority()` and `coverageDiverseNextAnchors()` score effects, roles, repository areas, and query terms                                                                | Exact adjacent identities, ambiguous alternatives, relation type, evidence strength, and recovery selectors                      | Priority scores, recommended-next language, query-term reservations, inferred downstream dimensions     | Normal output contains inventories/folds but no recommendation; requesting a printed fold or exact adjacent identity yields the same underlying evidence                                                                                                     |
| 9. Move `anchors` and legacy `system-map` guidance behind compatibility boundaries  | `anchors` is public and `system-map` exposes public next-anchor fields                                                                                                           | Callable legacy commands and JSON types during the deprecation window                                                            | Mandatory anchor phase, generated map commands as the default workflow, anchor ranking in skills/status | Agent setup and capability output identify the canonical locate/project/read path; compatibility tests keep old commands callable; deprecation text is stable                                                                                                |
| 10. Generate finite docs and setup text from contracts, then simplify the skills    | Command meanings are duplicated across descriptors, capability output, `agent-setup.ts`, command reference, and skills                                                           | Handwritten accuracy discipline, coverage honesty, and agent-owned relevance                                                     | Repeated command catalogues, task-template obligations as CLI semantics, and generic frontier chasing   | Generated command reference and setup blocks are snapshot-tested; skills contain only the operational principle and epistemic rules that cannot be generated                                                                                                 |
| 11. Validate the interaction before expanding analytical providers                  | Previous benchmarks show interface behavior can dominate provider value                                                                                                          | Frozen sandboxes, disposable worktrees, one reusable checkout-local index lineage, identical prompts/models, manual fact rubrics | Benchmark-driven code branches and development-task leakage                                             | Held tasks across at least three unseen repositories and several task shapes show treatment fact recovery is non-inferior to native, aggregate exploration tokens do not exceed native, and native source reads occur only after an explicit unsupported gap |
| 12. Prototype and then implement true definition-use/control dependence             | The current `value-flow` and `dependence-slice` work is conservative and the semantic audit identifies local reaching-definition gaps                                            | Existing exact argument/parameter/static-value facts, conservative unknowns, and typed-edge contracts                            | Call/reference proxies being presented as general dataflow or slicing                                   | Preregistered compiler fixtures cover assignments, aliases, branches, closures, fields, arguments, returns, and control predicates before the provider is connected to the canonical graph                                                                   |

## Dependency order

1. Freeze public and benchmark behavior so later deletions are measurable.
2. Add semantic contracts and provider support metadata; these become the single source for the new surface.
3. Extend the canonical projection API with direction, subtype, connecting, and inventory operations.
4. Remove query-aligned and automatic-route selection from topology construction.
5. Replace round-robin truncation with lossless structural compression and exact expansion.
6. Remove next-anchor recommendations from normal rendering and place legacy fields behind compatibility adapters.
7. Demote `anchors` and legacy `system-map` in setup, skill, status, and documentation.
8. Run graph-reconstruction and command-contract validation before any agent benchmark.
9. Run held native-versus-scip-query benchmarks before implementing new dependence providers.
10. Prototype and implement genuine TypeScript definition-use and control-dependence only on the stable graph contract.

## Compatibility policy

- Do not immediately delete `discoverAnchors()`, `AnchorDiscoveryResult`, `SystemMapResult.nextAnchors`, or `SystemMapOptions.selectionTerms` from the published API.
- Mark the CLI options and exported fields deprecated, remove them from generated examples and agent guidance, and prevent them from affecting the canonical `evidence` path.
- During the compatibility window, `--selection-term` is accepted but cannot alter the canonical projection. Legacy `system-map` may retain its old rendering only behind an explicit legacy mode if exact compatibility is required.
- Add replacement examples and machine-readable deprecation metadata before removal.
- Delete the compatibility shells only in a major release after repository and external consumer references have been checked.

## Validation standard

### Semantic correctness

- Every graph edge has a declared family, subtype, direction, provenance, and strength.
- Every command contract states what the result establishes and its material non-claims.
- A projection's node and edge set is invariant under changes to natural-language query vocabulary when roots and graph options are unchanged.
- A backward operation follows upstream causes and a forward operation follows downstream consequences; compatibility aliases cannot reverse these meanings.

### Compression correctness

- The uncompressed selected graph is the oracle.
- Expanding all folds reproduces the same node identities, edge identities, directions, subtypes, evidence strengths, branches, joins, and cycles.
- Every eligible relationship is emitted, folded with an exact handle, explicitly excluded by the request, or reported unsupported.

### Agent-product correctness

- An agent can begin with exact search, outline, entry points, or one compatibility locator without invoking help repeatedly.
- The first graph response exposes enough cardinality and semantic information for the agent to choose several useful directions in one call.
- The CLI never labels a next step relevant or recommended; it describes what an available operation would expand.
- Across held repositories and prompts, treatment accuracy is at least native accuracy. Token savings count only after that gate passes.
- Treatment exploration tokens do not exceed native in aggregate, and any per-task regression is investigated rather than averaged away.
- The benchmark trace records whether the agent used native repository reads; such use is acceptable only for a concrete capability the scip-query packet reported unsupported.

## Deferred register

| Opportunity                                                        | Blocking fact                                                                                                          | Revisit condition                                                                  | Priority |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Delete the exported `anchors` API and all group types              | They are present in the generated public API and may have external consumers                                           | Next major release after reference audit and deprecation window                    | High     |
| Delete `SystemMapResult.nextAnchors` and selection-related options | They are public JSON/API fields and CLI options                                                                        | Next major release after the canonical inventory/frontier replacement is available | High     |
| Choose the TypeScript definition-use implementation                | No completed prototype yet compares TypeScript flow nodes, ts-morph, and a conservative AST pass on the required cases | Prototype passes preregistered alias/branch/closure/field/return fixtures          | High     |
| Persist runtime-participant and state-resource nodes in the index  | Incremental invalidation cost and cross-query identity requirements are not yet measured                               | Canonical graph contract is stable and a query-time/persistent comparison exists   | Medium   |

## Final sense-check

- The plan removes three concepts from the canonical path: inferred anchor groups, recommended next anchors, and query-aligned graph selection.
- It adds one concept: a discriminated semantic contract attached to the existing command descriptor center.
- It preserves the valuable substrate: exact roots, typed edges, provider provenance, explicit routes, structural graph operations, lossless folds, and coverage honesty.
- It does not replace one relevance heuristic with another. The agent selects the view; scip-query reports the graph faithfully.
- It does not make a breaking API deletion before a compatibility decision is explicit.
- The largest remaining analytical gap after this compression is genuine definition-use and control dependence, not another anchor-ranking tweak.

## Implementation record

Completed on 2026-08-08:

- Extended the existing command descriptor center with discriminated semantic operation contracts and generated provider/relation support.
- Made `evidence` the canonical explicit projection surface with incoming, outgoing, both, exact subtype, connecting, and inventory-only operations.
- Replaced family round-robin selection with deterministic projection membership and stable, reconstructable folds.
- Removed query-aligned causal-spine selection, automatic unrequested upstream-route selection, priority-scored next anchors, repository-area reservations, query-term reservations, and inferred downstream evidence dimensions.
- Kept `anchors`, `system-map`, `selectionTerms`, and legacy next-anchor fields callable as deprecated compatibility surfaces. Selection terms no longer change topology or adjacent-target membership.
- Changed normal system-map rendering from recommendations to a neutral adjacent-recovery inventory.
- Generated command/reference facts from registered contracts, marked compatibility commands as deprecated, and removed them from the normal generated operation catalogue.
- Updated the installed scip-query skills and generated `AGENTS.md` block to teach locate → explicit project → selective read, with no required anchor-discovery phase.
- Replaced the former forced graph-first sequencing rule with a query-neutral bounded protocol: identify private material claims, use at most one locator when no exact root is known, batch explicit roots and relationship directions in one projection, and read only the unsupported or still-missing behavioral gaps. The CLI does not decide which claim or path matters.
- Extended the source-emission ledger so a byte-identical exact subset of a previously emitted exact source range is replaced by a visible, generation-bound receipt. Preview coverage still cannot suppress an exact unit.
- Kept newly returned library metadata optional so existing result consumers remain structurally valid. The repository API gate records a conservative breaking boundary because the larger branch adds public operations and changes generated declaration-module aliases; no legacy command or result field was deleted in this slice.
- Added TypeScript local reaching-definition and postdominator control-dependence analysis. Exact same-callable definition/use and control relationships are emitted separately from candidate closure-capture and cross-callable field relationships; exceptional, destructuring, heap, and closure-order gaps remain explicit unsupported coverage.
- Made the held treatment prompt teach only the canonical locate → explicit project → targeted read protocol. It no longer asks the model to rank anchor groups, choose a recommended route, or follow next-anchor scores. Query count remains a measured efficiency outcome rather than a hard correctness limit; the stopping condition is that every material fact is established, explicitly unsupported, or explicitly excluded.
- Fixed the cache-lifecycle race in which a temporary or process-lock entry could disappear between directory enumeration and hardening; missing descendants are tolerated while a missing managed root still fails.
- Made the generated agent command catalogue reproducibly Prettier-clean so generation and validation no longer rewrite each other's output.
- After the first bounded held runs, made graph projection parameters explicit at the canonical CLI boundary: materialized projections now require selected edge families, direction, finite depth, and a finite edge budget. Library defaults remain for compatibility. This prevents a broad `complete` projection from being an accidental discovery operation.
- Made every plain `file:line` selector resolve through the same narrowest indexed-declaration lookup as a range selector, with a source-callable fallback for unindexed constructs. The TSLint held run had exposed an interface line that was incorrectly reported as a missing symbol.
- Replaced one fold per disconnected local component with query-neutral structural folds grouped by relationship family, subtype inventory, and file region. Human output states exact fold recovery once and renders compact fold rows. Every omitted edge ID remains in exactly one recoverable fold.
- Changed broad literal search coverage into a complete structural file manifest. Small regions enumerate every matching file and exact starting constructs; large regions remain recoverable with one scoped search, and files with additional constructs point to an exact `outline` command. Ordering remains lexical and makes no relevance claim.
- Made broad-search manifests adaptively roll directory regions upward until the complete count-and-recovery manifest fits the transport budget. This keeps every match recoverable without paying one row per shallow monorepo directory.
- Separated graph projection from source materialization. A graph-form `evidence --include ...` request now returns the typed graph and one exact batched `inspect` recovery command instead of appending source for every root. Deferred source changes coverage to incomplete rather than becoming a silent omission. Legacy positional evidence reads remain compatible.

Validation completed:

- TypeScript typecheck, formatting, ESLint, generated API check, public-consumer compilation, and skill-link validation pass through `npm run lint`.
- The full suite passes 2,343/2,343 tests across 285 files with two workers. A four-worker run produced one timeout-only failure in a subprocess-heavy CLI assertion; that file passed 19/19 alone and the entire suite passed at the lower-concurrency validation setting.
- A packaged-CLI inventory request over `graphEvidence()` reported 458 matching typed relationships and materialized zero. A five-edge outgoing execution projection emitted five exact relationships and represented the 47 withheld relationships in six human-readable recoverable fold rows.
- A packaged-CLI session probe emitted `graph-evidence.ts:1-140` once, then replaced a later exact request for lines 30-60 with a one-line receipt referencing session emission 1.
- Agent setup refreshed `AGENTS.md`. The architecture policy maps 469/469 indexed files across 36 declared boundaries and reports no forbidden dependency edges.
- A direct TSLint replay reduced the formerly 155,700-character broad evidence packet to 19,224 characters for a 32-edge execution/dataflow projection, 21,799 characters for 48 edges, and 28,716 characters when ownership was also selected. The same replay now reports `src/configuration.ts:33` as a matched interface root and exposes `src/runner.ts` in the initial broad-search structural manifest. These are packet-shape probes, not acceptance results.

Historical held Luna 5.6 max treatment result (`v27`, pinned OpenCode compaction task):

- The run used scip-query exclusively for repository reads, but spent 4,348,631 total tokens and rendered 442,659 repository-output characters across 72 semantic queries. That is 31.5% more tokens than the frozen 3,306,711-token native control, despite rendering 65.3% fewer repository characters.
- The automated strict evaluator scored 0/7. A manual audit found at most 1/7 compound facts fully established; the answer distinguished the two implementations, but repeatedly omitted one required predicate, owner, constant, event, or terminal behavior from otherwise plausible descriptions.
- Trace inspection showed the causal failure: before its first successful graph projection, the model issued dozens of overlapping `search` and `code` requests, including repeated subranges of files it had already read. It used scip-query as a grep/sed replacement rather than as a graph-first exploration surface.
- The graph-first guidance and contained exact-read receipts above are general responses to those observed causes; they do not encode OpenCode facts.

Same-prompt Luna 5.6 max repeat after those fixes (`v28`):

- Graph-first ordering improved mechanically: after two exact locators, Luna issued a batched inventory projection before behavioral or exact-source reads. It never used native repository reads.
- The answer became materially more complete. A strict manual audit credits approximately 2/7 compound facts (resume behavior and later-context/pruning behavior), while the automated exact evaluator remained 0/7. The remaining rows usually established most of a fact but omitted one required owner, predicate, constant, event, or terminal condition.
- The efficiency gate regressed further: 8,103,280 total tokens, 270,694 rendered repository characters, 54 semantic queries, and 30.9 minutes. That is 86.3% more tokens than `v27` and 145.0% more than the frozen native control. A response-stream disconnect and automatic retry contaminated wall time, but does not explain the 54-query exploration trace.
- The new causal failure is round-trip accumulation. The model repeatedly alternated inventory projections, behavior packets, searches, and small gap reads across the two implementations. Even though rendered bytes fell 38.8% from `v27`, every additional reasoning round paid again for the accumulated context.
- These historical runs established that smaller rendered output alone does not control token use: serial reasoning rounds repeatedly repay the accumulated context. They also established that a hard interaction cap can hide material facts. The accepted protocol therefore measures query count but stops on evidence completion, not a fixed command count.

Acceptance rule:

- Accuracy and claim precision are the primary gates. Reject a cheaper treatment that loses material facts. When accuracy is equal, prefer the lower-token surface. A modest token overage is acceptable when it buys a material, repeatable accuracy gain; a large overage for a marginal or inconsistent gain is not.
- Run treatment and native control against at least three held repositories and task shapes in disposable sandboxes. Record manual compound-fact recovery, the literal matcher separately, exploration tokens, rendered characters, native-read fallbacks, model, prompt, checkout, index generation, and every transport continuation.
- Do not treat the benchmark's literal alternative matcher as authoritative when a correct answer paraphrases a compound fact. Publish both its score and a strict manual audit that requires every material clause.

Canonical evidence-completion results after the general contract repairs:

- TSLint configuration inheritance, Luna 5.6 max: treatment recovered about 6/7 strict compound facts, matching the native control, while using 595,723 versus 1,216,133 total model tokens (51.0% fewer), 82,209 versus 247,902 rendered characters, and zero versus 17 native repository reads. The remaining omission in both answers was `require.cache` eviction.
- Meta-harness Bash lifecycle, Luna 5.6 max: treatment and native control both recovered approximately 5–6/7 strict compound facts. Treatment used 475,122 versus 463,504 total model tokens (2.5% more), 101,875 versus 268,568 rendered characters, and zero versus 18 native repository reads. This is accuracy-noninferior but not a token win; a no-status repeat varied upward to 591,938 tokens, so capability disclosure remains optional and the efficiency result must be treated as a distribution rather than a deterministic constant.
- OpenCode session compaction, Sol 5.6 medium: the first canonical treatment recovered about 6/7 strict facts but used 1,787,700 tokens because a broad search and one graph-with-source request produced eight continuation pages. Adaptive search rollup and graph/source separation reduced the exact same held treatment to 433,892 tokens, 12 semantic queries, two continuations, 153,123 rendered characters, and zero native reads. The frozen native control used 508,976 tokens and ten native reads and recovered about 2/7 strict facts. The repaired treatment therefore recovered roughly four additional compound facts while using 14.8% fewer model tokens.
- Every canonical treatment ran against a fixed commit in a detached worktree with a private index; each artifact reports `cleaned: true`. The result artifacts are `/tmp/tslint-config-inheritance-canonical-evidence-stop-treatment-luna-max.json`, `/tmp/meta-harness-bash-lifecycle-canonical-evidence-stop-treatment-luna-max.json`, and `/tmp/opencode-session-compaction-canonical-bounded-treatment-sol-medium.json`, with their corresponding frozen controls recorded alongside them.

Current conclusion:

- The canonical direction is validated across these three held repositories at the current experimental standard: no treatment lost strict manual accuracy, two were materially cheaper, and the third traded a 2.5% token increase for comparable accuracy while rendering far less repository text. The strongest unseen-repository result improved manual accuracy from about 2/7 to about 6/7 while also saving tokens.
- This does not establish universal superiority. Before a main-branch merge or npm publication, repeat each task enough times to estimate variance, add held tasks in other languages and question shapes, audit package/API compatibility, and investigate the one recurrent accuracy gap: agents still sometimes stop after establishing most rather than all clauses of one compound proof obligation.
