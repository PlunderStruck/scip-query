# Complete Exploration Surface Program

## Outcome

For every tracked, indexed nonbinary repository file, an agent can locate referents, navigate proved relationships, inspect behavior, and retrieve exact source without native repository search or source-reading tools. Accuracy and disclosed coverage must match or exceed a native-tool control before any token-efficiency result is accepted.

The agent owns interpretation of the user's task. scip-query owns repository observability: it must expose exact text, compiler identities, typed directed relationships, runtime handoffs, source proof, and every folded or unsupported frontier through one hierarchical surface.

## Product contract

The surface follows one invariant:

> Find by text, identify by compiler identity, navigate by evidenced relationships, compress only after connectivity is established, and retrieve exact source at the resolution the decision requires.

The abstraction ladder is:

1. **Locate** — literal, regex, path, symbol, syntax, comment, configuration key, route, event, or error text over exact indexed source.
2. **Orient** — owner, construct kind, package/workspace, public surface, ambiguity, nearby state, and effects.
3. **Navigate** — around, forward, backward, between, and impact over typed evidence edges.
4. **Accounted frontier** — every discovered direction is emitted, folded into an expandable group, excluded by an explicit rule, or reported unsupported.
5. **Connected behavior** — selected units are ordered by their relationships rather than rendered as unrelated snippets.
6. **Exact source** — lossless batched file, range, symbol, and construct reads from the same indexed generation or current worktree overlay.

Every relationship carries direction, kind, evidence strength, source identity, source location, and coverage. Compiler-resolved and mechanically derived edges remain distinct from candidates. Missing evidence never becomes an absence claim.

## Performance measure and environment

The product is judged on the final repository answer, not on tool activity:

1. required fact recall and claim precision;
2. zero native exploration reads for indexed content;
3. cumulative model input tokens and exploration decisions;
4. explicit accounting for omissions, unsupported relations, and stale semantic generations.

The environment is partially observable, sequential, dynamic, and may be modified by other worktrees or agents. The durable semantic generation plus per-worktree overlay is the sensor state. Exact text freshness and semantic-relationship freshness must be reported separately. The exploration ledger is derived automatically from successful query outputs; the agent must not maintain bookkeeping manually.

## Preregistered baselines and gates

### Self-hosted runtime-boundary question

Question: “How does scip-query collect runtime-boundary evidence during indexing and then use it to connect otherwise disconnected regions in `system-map`?”

Observed on commit `8fcf2c5f`:

- accuracy: all five required path facts recovered;
- native source/search reads: 0;
- exploration after status: 9 commands;
- rendered exploration characters: 129,673;
- avoidable behavior: all 11 structural root regions expanded; 9 of 12 emitted drill anchors were unrelated; exact `systemMap` evidence selected 66,845 characters and required three continuations.

Required facts:

1. `runtimeBoundaryAugmentationStage` invokes graph collection during post-index augmentation;
2. `collectRuntimeBoundaryGraph` extracts/retains observations and derives relation groups and links;
3. `writeRuntimeBoundaryGraph` persists the graph and indexed participant tables;
4. `systemMap` loads it through `readRuntimeBoundaryGraph`;
5. traversal adds both endpoints of a proved runtime link when either endpoint reaches the current frontier.

Acceptance target:

- all five facts, with exact source identities and no unsupported claim;
- at most 3 semantic exploration commands after status;
- at most 15,000 rendered characters before optional exact-source expansion;
- no unrelated root-region representative selected as a behavior drill;
- completion says what the query established, never that the user's task is finished.

### Repository gates

- `npm run lint` passes.
- `npm test` passes with at least the existing 271 files / 2,170 tests.
- `node dist/cli.js architecture` reports every indexed file and declared boundary mapped with no forbidden edge.
- `node dist/cli.js diff-impact` completes and reports all changed symbols/consumers.
- A final matched model benchmark must meet the accuracy gate before its token result is interpreted.

## Current path and direct evidence

- `systemMap()` owns anchor resolution, compiler/runtime traversal, structural regions, expansion, drill-down, coverage, and blind spots in `src/queries/graph/system-map.ts:335-957` (`scip-query evidence <exact systemMap symbol>`).
- It loads persisted runtime evidence at `system-map.ts:383` and traverses proved links at `system-map.ts:664-694`.
- `buildSystemMapExpansion()` ranks whole structural regions and selects up to twelve at `system-map.ts:959-991` (`scip-query inspect --at system-map.ts:959`).
- `buildSystemMapDrilldown()` chooses one candidate per expanded file and then optimizes coverage diversity at `system-map.ts:1123-1175` (`scip-query inspect --at system-map.ts:1123`).
- CLI construction and presentation are owned by `src/runtime/query-commands/graph.ts:460` and its system-map rendering helpers.
- Runtime evidence production and persistence are already separated behind `collectRuntimeBoundaryGraph`, `runtimeBoundaryAugmentationStage`, `writeRuntimeBoundaryGraph`, and `readRuntimeBoundaryGraph`; this program preserves those contracts.

## Implementation slices

| Slice | Exact change | Direct evidence | Preserve | Retire | Prove |
| --- | --- | --- | --- | --- | --- |
| 1. Accuracy harness | Add a deterministic exploration benchmark schema and self-host/fixture audit that fixes required facts, command count, output characters, and native fallback count outside the agent under test. Prove the grader rejects one removed fact before trusting it. | Manual self-host baseline above; existing `tests/queries/graph/system-map.test.ts` owns topology fixtures. | Existing unit/integration test harness and protected external model runs. | Ad-hoc character counts and accuracy judgments that exist only in a conversation. | Mutation probe fails; unmodified baseline records 5/5 facts and 129,673-character manual baseline metadata. |
| 2. Universal result model | Extract anchor, edge, path/frontier, provenance, and coverage types from the monolithic system-map result into a query-level exploration topology that existing `systemMap` can populate without a CLI break. | `systemMap()` currently builds `files`, `symbols`, `pendingRelations`, runtime links, regions, expansion, and drilldown in one function. | Existing public API snapshot and current system-map JSON fields. | Ranking logic that can only reason about directory regions. | API compatibility check and topology unit tests over compiler and runtime edges. |
| 3. Query-centric selection | Compute anchor-relevant connectors and first-edge frontier groups. Retain anchors, connecting paths, branch/merge points, state/runtime/external junctions, and unresolved cuts; fold everything else with exact membership counts. Rank structural diversity only after connector relevance. | The self-host run expanded 11/11 regions although only `reindex`, `analysis`, `storage`, and the query consumer could close the question. | Complete closure accounting and bounded output. | Default “expand every ranked root region” and one-representative-per-region drill selection. | Every reachable fixture node is emitted, frontier-accounted, explicitly excluded, or unsupported; expanding all groups reconstructs the oracle graph. |
| 4. Connected behavior packet | Add one batched packet that orders selected constructs by graph edges and includes compact behavior plus the evidence for each transition. Preserve raw source when compression is not cheaper or cannot retain predicates/effects. | Current emitted `inspect` command returns independent units and does not include the writer/reader/consumer path. | Existing source-inspection compression and whole-unit guarantees. | An emitted “next command” whose anchors are unrelated to the unresolved path. | Self-host required path appears in one packet under 15,000 characters; behavior/source mutation tests fail when a decisive edge or predicate is removed. |
| 5. Lossless sensor contract | Treat `search` plus exact `code`/read operations as the lossless bottom layer for all tracked nonbinary source, including paths with no compiler facts. Add regex/path/text and batched exact-range parity tests against a fixed native oracle; report exact-text and semantic freshness separately. | Existing `source-search`, `source-inspection`, `code`, project snapshots, and source-text storage already provide most primitives. | Current CLI compatibility and citation-ready absolute line identities. | Skill-sanctioned native fallback for an indexed file merely because the semantic map was insufficient. | Fixed corpus parity with native literal/regex/range reads and zero omitted bytes; stale semantic overlay remains explicit. |
| 6. Evidence budgets and completion semantics | Give definition behavior, exact source, callers, callees, production references, and test references independent selection budgets. Replace `stop-ready` with query-scoped states such as `selection-complete`, `connector-complete`, `frontier-accounted`, and `coverage-incomplete`. Prefer exact callable leaves over same-prefix type names. | Exact `systemMap` evidence selected 66,845 characters; `systemMap` resolved against 44 same-prefix definitions; inspect said `stop-ready` while the question remained unanswered. | Complete candidate sets and explicit commands for true ambiguity. | Generic completion language and unbounded mixed evidence defaults. | Exact callable lookup is singular; selective evidence returns decisive lines without test-reference expansion; old compatibility fields remain machine-readable through one deprecation window if public. |
| 7. Exploration ledger | Persist generation-bound receipts for exact returned units/edges and let later packets reference rather than repeat them. Invalidate on generation change and never suppress evidence without a visible receipt reference. | Current commands repeat definitions and source already present in earlier packets; observation receipts demonstrate a content/generation-bound reuse pattern. | Stateless command correctness and reproducible full-output option. | Paying for unchanged locating evidence on every later reasoning step. | Same-generation second query emits a smaller delta with recoverable references; generation mutation forces re-emission. |
| 8. Agent protocol and model benchmarks | Rewrite the skill around the locate → orient → navigate → frontier → behavior → exact-source ladder. Run scip-only model tasks with native repository reads disabled, then matched Luna-max treatment/control benchmarks across several repositories and task shapes. | Current skill instructed the self-host agent to expand all emitted regions and then trust `stop-ready`. | Agent owns user-goal interpretation, implementation, and acceptance. | Command-manual guidance that compensates for selection defects. | Accuracy parity or win on every task; zero indexed native reads; treatment cumulative tokens below matched control before merge consideration. |

## Working agreement

- One commit per slice; every commit must leave the repository buildable and testable.
- Before trusting a new benchmark or gate, run a deliberate mutation/input that makes it fail, then remove only that probe and observe green.
- Run focused tests during a slice and the full repository gates before each slice is declared complete.
- If source contradicts an anchor or a benchmark target becomes invalid, record the deviation here before changing course; never improvise silently.
- API snapshots and additive-change records are committed with the slice that changes the public surface.
- Local `.codex/hooks.json` and `.claude/settings.local.json` are never staged.

## Deferred until evidence requires it

- More repository-specific runtime-adapter patterns.
- LLM-authored business-stage labels.
- Natural-language intent parsing inside the CLI.
- Runtime traces or production-state claims from a static index.
- Removing existing commands before the replacement surface has accuracy and compatibility evidence.

## Program self-report

### Slice 1 — deterministic exploration benchmark

- **Benchmarks:** the self-host runtime-boundary case now fixes five required facts and gates accuracy, forbidden claims, total calls, semantic queries, rendered characters, and native exploration reads independently. The current manual baseline remains 5/5 facts, 9 exploration calls after status, 129,673 rendered characters, and no native source reads.
- **Discriminating probe:** removing the `system-map-loads` fact from the trial produced exit code 1, 4/5 facts, `accuracy: false`, and named the missing fact. The complete fixture produced exit code 0 and 5/5 facts.
- **Verification:** focused harness tests passed 4/4; `npm run lint` passed including the public API check; the full suite passed 272 files and 2,174 tests.
- **Deviations:** scip-query could not enumerate the exact `.mjs` script paths or retrieve `package.json` by exact file path, so this slice used one native file-inventory query and exact native reads for four harness files after the indexed surface reported them missing. Exact `context` resolution of the `systemMap` symbol also resolved as a module target rather than the callable. These are recorded product gaps for the lossless-sensor slice, not accepted exploration behavior.
- **Deferred:** external model-token comparison waits until a complete connected packet exists, so the benchmark measures a meaningful treatment rather than another partial interface.
- **Folded learnings:** `scripts/exploration-benchmark-core.mjs`, the CLI wrapper, fixtures, tests, and this plan now carry the accuracy and efficiency contract outside the conversation.

Future slices append their evidence here rather than replacing this record.

### Slice 2 — universal typed graph result

- **Benchmarks:** `systemMap` now populates one schema-versioned topology containing structural regions, exact symbol nodes, directed typed edges, evidence strength and source identity, anchors, reversible frontier records, and query-scoped coverage. Existing CLI fields remain unchanged; the new result and per-relation provenance fields are additive and optional for older serialized consumers.
- **Discriminating probe:** temporarily removing every runtime-boundary relation from topology construction made the compiler/runtime integration test fail while compiler call edges remained present. Restoring only that filter produced a passing targeted test. Independent contract tests also reject missing edge endpoints and a frontier count that exceeds its identified members.
- **Verification:** focused topology/system-map tests passed 20/20; the full suite passed 273 files and 2,179 tests. Lint and the public API compatibility check passed against accepted compatible-correction record `de343eb7e279ae76`. `architecture` mapped 445/445 indexed files across 36/36 declared boundaries with no forbidden edge; `diff-impact` reported 32 changed symbols and zero affected consumer files.
- **Deviations:** the first implementation placed the contract under `queries-navigation`; the architecture gate correctly rejected `queries-graph -> queries-navigation`, so the contract moved to the shared `queries-internal` boundary and the unchanged policy then passed. The watcher exhausted its automatic rebuild budget after two source refreshes; one manual incremental reindex was therefore required and refreshed 32 TypeScript documents in 13.9 seconds. That breadth and latency remain evidence for the separate indexing/cache work, not a reason to weaken this program's freshness gate.
- **Deferred:** connector paths and first-edge folded frontier groups remain slice 3; this slice supplies the validated representation they need.
- **Folded learnings:** the universal model and its referential-integrity tests live in `src/queries/internal/exploration-topology.ts`; the system-map adapter proves both compiler and runtime evidence survive conversion without reducing symbols to directory regions.

### Slice 3 — query-centric connector selection

- **Benchmarks:** the self-host query `system-map --symbol runtimeBoundaryAugmentationStage --symbol systemMap --depth 4` now renders 10,153 characters before optional source expansion, down from the 129,673-character manual baseline. It selects three connector-relevant structural regions instead of expanding all eleven roots. The bounded packet retains 24 of 932 topology nodes and exposes 45 reversible frontier groups; the remaining breadth is largely caused by `systemMap` matching same-prefix type declarations, which slice 6 addresses as an identity-selection defect.
- **Discriminating probe:** temporarily omitting internal folded-component edges from a frontier made the deep-frontier test fail with `Folded exploration edge(s) are not frontier-accounted: bootstrap-edge`. Restoring complete frontier membership made the targeted test pass. Expanding every emitted frontier reconstructs the fixture oracle with no folded node or edge left unaccounted.
- **Verification:** connector/topology, system-map, CLI-contract, and generated-command tests passed 69/69. The complete suite passed 273 files and 2,182 tests with one worker; lint and public API compatibility passed against compatible-correction record `f28b16969939b37f`. `architecture` mapped 445/445 indexed files across 36/36 boundaries with no forbidden edge; `diff-impact` reported 18 changed symbols and two affected consumer files.
- **Deviations:** the repository's default high-parallelism test run produced nondeterministic five-second timeouts in unrelated child-process tests. The unchanged suite passed in 203 seconds with one worker, so this slice does not alter product code or inflate individual timeouts to mask machine contention. The connector search traverses evidence in either direction when finding a path *between* anchors while preserving the original direction on every emitted edge; structural-membership edges are excluded from causal shortcuts.
- **Deferred:** the map now identifies and accounts for the relevant connector graph, but it intentionally does not paraphrase independent source units into a causal narrative. The next slice adds a connected behavior packet containing ordered constructs and transition evidence.
- **Folded learnings:** frontier IDs are stable short hashes over exact hidden membership; each frontier records every hidden node and every crossing or internal hidden edge. Multiple frontier IDs can be expanded in one command, so reversibility does not force repeated shuttling between abstraction levels.

### Slice 4 — connected behavior packet

- **Benchmarks:** the self-host query `system-map --symbol runtimeBoundaryAugmentationStage --symbol systemMap --depth 4` now returns one graph-ordered packet containing all five preregistered facts in 14,280 rendered characters. It identifies the indexing stage calling collection and persistence, the collection pipeline deriving relation groups and links, the SQLite graph/observation/group/participant writes, `systemMap` loading the graph, and the traversal loop admitting both endpoints whenever either endpoint has reached the current frontier. This is below the 15,000-character slice gate and 89.0% below the 129,673-character manual baseline.
- **Discriminating probes:** replacing the fixture's decisive realtime-event predicate with an unconditional call made the predicate-retention test fail on the missing comparison. Temporarily filtering `runtime-boundary` transitions from the packet made the connector-evidence test fail on the absent exact HTTP transition. Restoring each fact made the focused suite pass.
- **Verification:** connected-behavior/system-map and CLI contract tests passed 54/54; the complete suite passed 273 files and 2,184 tests with one worker. Lint, type checking, and public API compatibility passed against compatible-correction record `cd60db88fa76ce49`. `architecture` mapped 446/446 indexed files across 36/36 declared boundaries with no forbidden edge; `diff-impact` reported 25 changed symbols and zero affected consumer files.
- **Deviations:** top-level framework registrations do not always have a compiler owner. The runtime adapter therefore adds a conservative derived handler-identifier bridge only when exactly one indexed same-file definition is named inside the observation span; the original network transition retains its exact evidence and is not upgraded. The watcher again paused after exhausting its automatic rebuild budget, requiring one manual incremental refresh; it processed 32 affected TypeScript documents and reused the Rust shard in 6.8 seconds.
- **Deferred:** connector slices currently follow JavaScript/TypeScript local bindings to the first governing branch or loop; language-general def-use enrichment belongs in the evidence-budget slice. Exact text, regex, path, and range parity for non-semantic files remains slice 5.
- **Folded learnings:** compression is applied only after graph connectivity selects constructs. The packet preserves original edge direction, evidence strength and method, decisive predicates and effects, omitted node identities, omitted statement counts, and one exact-source recovery command. Full source is retained when it is cheaper than an outline or when a small selected construct is itself the decisive persistence effect.

### Slice 5 — lossless source sensor

- **Benchmarks:** `files` now enumerates the current project rather than only compiler documents; `search` scans every readable UTF-8 project file and reports exact current-text coverage; and `code` reads exact paths and ranges without requiring a compiler row. The two concrete gaps recorded in slice 1 are closed: one batched command returned exact citation-ready ranges from `scripts/exploration-benchmark-core.mjs` and `package.json`, with 2/2 selectors resolved and current-byte freshness for both.
- **Discriminating probes:** temporarily restricting project enumeration to compiler documents made the native-oracle test lose Markdown, Dockerfile, YAML, and binary path identities. Temporarily classifying a changed indexed file as aligned made the stale-semantic test fail. Restoring current project enumeration and SHA-256 comparison made both probes pass.
- **Verification:** literal and bounded-regex search matched a direct filesystem oracle over indexed TypeScript, unindexed Markdown/YAML, an extensionless Dockerfile, and an explicitly disclosed binary exclusion. Batched range and whole-file reads matched current filesystem bytes, including CRLF preservation and paths with no compiler facts. Focused tests passed 72/72; the complete suite passed 274 files and 2,187 tests with one worker. Lint, type checking, generated command documentation, and public API compatibility passed against compatible-correction record `fc51084e2ed352bd`. `architecture` mapped 447/447 indexed files across 36/36 boundaries with no forbidden edge; `diff-impact` reported 43 changed symbols and three affected consumer files, all covered by the full suite.
- **Deviations:** binary inputs remain path-visible but are intentionally outside the text-search contract. Unreadable and over-limit paths are named explicitly and force invocation coverage to unknown rather than supporting an absence claim. Exact text is always read from current working-tree bytes; compiler ownership is suppressed when its indexed fingerprint is provably stale, while legacy generations with no usable fingerprint remain visibly `unavailable` rather than being called aligned.
- **Indexing evidence:** the watcher had paused after consuming its two automatic rebuild slots. After source changes stopped, one manual incremental refresh reused the Rust shard, emitted and patched 37 affected TypeScript documents, reused 722 runtime-boundary observations, and completed in 7.6 seconds. This again confirms that incremental publication works while the watcher budget policy remains a separate operational concern.
- **Deferred:** independent evidence budgets, exact callable preference, and query-scoped completion states remain slice 6. Same-generation non-repetition remains slice 7; this slice deliberately establishes the lossless evidence floor before adding session memory.
- **Folded learnings:** current text and semantic relationships are two different observations and therefore have separate freshness claims. Text search can be lossless without pretending every text file has a compiler identity; the semantic graph is an overlay that may enrich a current line only when its relationship to those bytes is disclosed.
