# Next-anchor selection

## Outcome

After an agent identifies the first exact repository anchor, `system-map` exposes a small, evidence-ranked set of additional callable anchors whose behavior can extend the selected flow. The feature derives candidates from compiler/type evidence, graph edges, and every repository-resolvable callsite in the behavior already shown; it does not infer repository-specific concerns from English. Control/effect structure changes rank but never decides whether a visible call is eligible.

The observable success condition is higher strict-fact recovery on the concept-led durability and cross-cutting mutation benchmarks without native tracked-source reads. Token optimization follows after accuracy holds.

## Current path

`systemMap()` resolves explicit anchors, traverses relation families, builds a universal topology, selects one query-aligned causal spine, and then builds connected behavior (`scip-query context 'src:queries:graph:system-map:systemMap()'`; `src:queries:graph:system-map:systemMap()`). The selected topology is consumed by `connectedBehaviorPacket()`, which materializes at most twelve graph-ordered constructs and records omitted node identities (`src:queries:internal:connected-behavior:connectedBehaviorPacket()`). Human rendering is owned by `handleSystemMap` (`src:runtime:query-commands:graph.ts:460`).

The universal call traversal invokes `ProjectIndex.calleeMap(..., { semantic: false })`, while the semantic callee product is durably cached. On the benchmark repository, `scip-query evidence 'src:commands:download:executeDownload()' --include definition,callees` proves that the semantic tier resolves `context.library.addPdf` to `LibraryStore.addPdf()` and resolves the client member calls that the existing system-map reports as unresolved. A live prototype showed that enabling semantic resolution for the whole traversal expanded the universal graph from 87 to 153 nodes and displaced the relevant persistence path with valid but lower-value network detail. Semantic resolution therefore belongs at the bounded next-anchor selection boundary, not in the universal traversal.

`selectExplorationTopology()` adds one query-aligned causal spine and adjacent junctions. It does not select several independent downstream branches merely because each contains a behavior-changing operation (`src:queries:internal:exploration-topology:selectExplorationTopology()` and `queryAlignedCausalSpineNodeIds()`). The current expanded-region drilldown chooses one symbol per child file and is not available in the normal connected-behavior view (`src:queries:graph:system-map:buildSystemMapDrilldown()`).

## Implementation slices

| Change                                                                               | Direct evidence                                                                                                                                       | Preserve                                                                                                      | Retire                                                                           | Prove                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Batch cached semantic-callee resolution only for constructs in the returned behavior | The existing semantic port materializes and persists only cache misses; a universal semantic traversal measurably enlarged and degraded the first map | Evidence strength, source-scope filtering, depth bounds, compact first-map selection, and candidate labeling  | Whole-traversal semantic expansion as the way to discover the next drill targets | Focused tests plus the live arxiv map show exact `executeDownload → addPdf` and correct receiver-specific mapping for both `get` methods |
| Build a next-anchor packet from returned behavior and the already-accounted topology | `connectedBehaviorPacket()` retains source lines, behavior signals, graph node ids, transitions, and omitted node ids                                 | Every target keeps its source callsite, exact identity when known, evidence strength, ambiguity, and recovery | A bare unresolved-member-call count with no actionable identities                | Unit tests account for selected plus withheld candidates; ambiguous alternatives remain candidate-only                                   |
| Rank mechanically rather than by domain concern                                      | Behavior lines already label `mutation`, `await`, `return`, `throw`, `catch`, and `finally`; graph edges retain exact/derived/candidate strength      | The model decides which anchors answer the English question                                                   | Proposed `--effect` and `--concern` intent inference in the first implementation | A mutation/await call such as `addPdf` ranks above ordinary helper calls without any durability vocabulary                               |
| Preserve behavior tags when exact source is the cheaper representation               | A construct whose outline fails the savings threshold previously rendered raw source with an empty signal set                                         | Exact source bytes and representation choice                                                                  | Treating raw source as semantically empty                                        | `addPdf` retains call/await/return/finally tags and can propose its lock, append, compaction, and cleanup callees                        |
| Render a concise next-anchor section and batched recovery commands                   | `handleSystemMap` already renders connected behavior and exact recovery commands                                                                      | Existing human and JSON output remain additive and coverage-accounted                                         | Long SCIP-symbol selectors and unidentifiable omitted counts                     | Commands use compact `--at file:line` selectors; selected and withheld candidates exactly sum to total coverage                          |
| Diversify the visible target budget across the causal slice                          | One large outlined anchor previously occupied all six visible slots while the exact callee of the shared serialization connector was withheld         | Global evidence/effect ranking remains the fallback and every withheld target stays recoverable               | Flat top-N selection that repeatedly exposes helpers from one source step        | One exact connector continuation appears first, then explicit anchor steps receive one slot before repeated targets                      |
| Update agent guidance and rerun frozen benchmarks                                    | The baseline is `docs/benchmarks/2026-08-06-exploration-surface-baseline.md`                                                                          | Accuracy-first stopping rule and zero native source reads                                                     | Guidance that treats one root anchor as sufficient for every concern             | Guided Sol stays 7/7; concept-led durability and mutations reach 6/6 before token claims are accepted                                    |

## Resolved design uncertainty

Semantic call expansion did increase the universal graph and caused irrelevant branches to dominate. The implementation now leaves universal traversal bounded and asks the cached semantic provider only about constructs already returned. Semantic callee evidence also retains the source callsite line; without it, two receiver methods with the same leaf such as `QueryCache.get` and `ArxivClient.get` could be attached to the wrong line. Older durable callee rows are invalidated through a schema-key revision.

The bounded packet now exposes `SqliteMutex.acquire()` from the shared `withSqliteMutex()` connector ahead of repeated helpers from one mutation anchor. A focused inspect proves that acquisition opens the configured SQLite database and retries `BEGIN IMMEDIATE`, which closed the prior process-local-versus-cross-process gap. The full-accuracy mutation rerun recovered 6/6 manually audited facts with zero native source reads and remained below both the frozen treatment and native control token totals. Run-to-run token variance remains material, so repeated trials are still required before claiming a stable percentage.

## Follow-on: open-ended anchor discovery

The first post-selection Sol durability run used 384,027 tokens and manually recovered about 5/6 facts, compared with 245,219 tokens and 5/6 for the frozen Sol treatment. Its four separate maps began from weak literal guesses. This establishes an upstream failure: a recoverable next-anchor contract does not save tokens when the agent pays repeatedly to find the first relevant owners.

The follow-on locator is `scip-query anchors '<question>'`. It does not classify the task as durability, security, persistence, or another inferred concern. It:

1. mechanically splits natural-language and compound identifiers into normalized words;
2. matches those words against symbol names, paths, compiler documentation, and current source text;
3. attributes source matches to the smallest compiler-owned construct;
4. ranks owners by distinct word coverage, identity evidence, term rarity, callable/file role, and deterministic location;
5. semantically enriches only the highest-ranked owners through two bounded call hops;
6. merges owners when one is reachable from another, then prints compact connected sets and exact multi-anchor `system-map` commands;
7. accounts for matched, unmatched, analyzed, and withheld evidence without materializing function source.

The live arxiv trial turns the full durability question into one top set containing `executeDownload`, `LibraryStore.addPdf`, `withSqliteMutex`, `reconcileLocked`, `appendLibraryEvent`, and duplicate-file discovery. The first human packet is roughly eight kilobytes and recommends one map rooted at the download entry, persistence owner, and duplicate-discovery branch. This is functional evidence only; the frozen Sol benchmark remains the acceptance test for end-to-end token and fact recovery.

## Follow-on: evidence-backed cross-boundary composition

Lexical discovery can find the producer and consumer sides of one behavior as separate connected sets because an HTTP request, queue message, event discriminator, or registry lookup does not appear as an ordinary source-level call. The locator now composes those sets only when the persisted runtime-boundary graph contains a non-candidate producer-to-consumer link and a bounded downstream call path reaches a separately discovered owner. It does not guess a product-specific stage or effect from the question.

The composed group preserves three distinct kinds of evidence:

1. the producer owner and exact runtime carrier key;
2. the consumer owner reached across that carrier;
3. compiler- or AST-backed calls from the consumer into the downstream owners already matched by the question.

The generated `system-map` command selects at most three representative anchors across the composed path. The locator also searches one level upstream from the producer for a callable whose identifier shares at least two normalized terms with the producer. That upstream entry is not added to the first map, because doing so can expand a module-scale construct and overwhelm the packet. Instead it is named as one optional location to include in a single batched behavior inspection when command validation or authorization can change the answer.

This is a general structural contract: runtime evidence authorizes crossing disconnected call graphs; call evidence authorizes continuation inside each execution domain; lexical evidence establishes that the destination owners are relevant to the question. Candidate runtime links and unconnected lexical matches cannot create a composite group. The resulting packet therefore reduces navigation work without claiming that every arbitrary runtime relationship is statically knowable.

## Benchmark isolation correction

Agent trials now run against one resolved commit in a disposable detached worktree with a private scip-query cache. Treatment indexing happens before the measured model turn; cleanup removes the worktree registration, repository files, and generated cache even when the run fails. This closes the measurement defect exposed by the first Vega attempts: concurrent edits in the source worktree can no longer make the index stale, trigger demand reindexing, or cause the agent to repeat navigation commands. The live-repository mode is retained only as an explicit debugging option.
