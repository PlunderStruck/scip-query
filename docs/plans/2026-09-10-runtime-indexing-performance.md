# Runtime indexing performance: VM diagnosis

Status: first improvement committed, pushed and deployed (`f960a2d4`); deeper performance work continues because the user considers the remaining five-minute cold index too slow. Starting commit: `cb487ac8`.

Runtime relationship analysis is the indexing stage that reads source and compiler relationships to infer connections such as HTTP requests, registered handlers, database operations and queues. It analyzes code; it does not run the application's services.

## Observed evidence

On 2026-09-10, read the persisted runtime coverage from both active LaunchPoint worktrees, using read-only SQLite connections. Raw coverage and process/status receipts are in `/tmp/scip-query-efficient-install-20260910-SADRtv/` on `dev-agent`.

| Persisted runtime phase                | `t3code-66bd3d33` | `t3code-93516b5b` | Output                         |
| -------------------------------------- | ----------------: | ----------------: | ------------------------------ |
| Direct source extraction               |           162.2 s |           150.2 s | 7,101 / 7,139 observations     |
| HTTP wrapper propagation               |           259.7 s |           276.3 s | 82 observations each           |
| Express route mounting                 |           202.9 s |           202.8 s | 0 observations each            |
| Request-body discriminator propagation |           170.6 s |           235.5 s | 0 observations each            |
| Relation grouping and links            |      under 0.01 s |      under 0.01 s | 666 / 674 groups; 2 links each |

The mount phase records visiting all 9,296 / 9,351 source files. Querying stored observations confirms **zero HTTP handlers eligible for router mounting in either worktree**. The body phase records 189 / 190 inspected files, with 258 / 260 callable body summaries and zero final observations.

These are persisted analysis-phase durations, not a new controlled benchmark. They must not be added to compiler-shard timings to assert an end-to-end total: shards can overlap, and stored phase data can survive reuse. The previous recorded reindex durations were 888.2 and 957.9 seconds; the first deployment's separately measured command wall time was 904.9 seconds.

Both watchers were idle and their indexes fresh before deployment. The output-only update preserved the accepted generations, and both restarted watchers remained idle and fresh. There is no evidence of a current rebuild loop from these observations.

## Findings and next changes

1. **Route mounting performs an unconditional repository sweep.** `src/analysis/runtime-boundaries/http-mounts.ts` builds the eligible-handler map, then calls `collectHttpMounts` even when that map is empty. Collection creates an AST context for every source file before testing its imports for Express. An AST is a parsed tree whose nodes identify source constructs such as imports and function calls. This is a confirmed work-selection problem. Mount collection also produces unresolved-location evidence, so simply returning early could change accuracy even when no links can be created. Preserve that evidence while restricting expensive work to applicable files, preferably reusing module facts already collected during extraction. Avoid text heuristics that would miss aliases or alternative valid import syntax.
2. **HTTP wrapper tracing is the largest individual recorded phase.** `http-summaries.ts` already batches compiler-resolved caller lookups, so replacing it with batching is not a diagnosis. Profile its existing seed, caller-resolution and argument-processing spans on an isolated copy of the real graph. Retain exact/candidate distinctions, unresolved calls, transformations and recursive wrapper handling.
3. **Body propagation needs finer cost attribution.** `carrier-discriminators.ts` traces callable summaries one at a time using the existing call resolver, which has per-database caching. Inspect cache reuse and repeated value-flow work before claiming a particular optimization will help. Zero emitted observations does not prove the work was unnecessary: intermediate summaries and error evidence may be needed.
4. **Analysis caches are invalidated by the entire runtime build.** `src/storage/evidence-cache.ts` includes `cliBuildIdentity()` in file/project evidence keys; `src/platform/cli-version.ts` hashes the full runtime tree. Consequently an output-only runtime change can invalidate these derived caches even while the compiler index remains fresh. That follows from the implementation, but its cost in these recorded runs is unmeasured. Investigate dependency-specific producer identities with invalidation regression tests before narrowing keys; stale facts must never be reused after analysis logic changes.

## Validation

- [x] Capture phase/CPU profiles against isolated real LaunchPoint index copies, preserving live indexes and watcher state.
- [x] Remove unnecessary mount preparation through shared binding/freshness owners; retain the full source sweep because it also discovers unresolved mounts. Test empty handlers, imports/aliases, cycles and path bounds.
- [x] Compare complete observations, links, groups, unresolved evidence, extraction errors and file coverage before/after.
- [x] Investigate wrapper/body costs through measured shared hot paths and test affected value-flow contracts.
- [x] Run the full suite, including real incremental edit histories and comparisons against clean rebuilds. Do not present those correctness cases as a measured LaunchPoint edit-latency benchmark.
- [x] Finish a complete cold LaunchPoint index and measure the normal unchanged-index fast path separately.
- [x] Deploy the verified package under dev-agent and verify only currently active watchers are restarted.

## Existing flow, conventions and ownership

`src/reindex/index.ts:805` runs `runtimeBoundaryAugmentationStage` through the existing asynchronous augmentation owner. `src/reindex/runtime-boundaries.ts:23` opens one accepted compiler database, reuses a compatible stored graph or calls `collectRuntimeBoundaryGraph`, then persists the complete graph after closing its reader. Errors remain reported by the reindex coordinator. `src/analysis/runtime-boundaries/graph.ts:161` owns ordered direct extraction, HTTP summaries, mounting, body propagation, grouping, links and unresolved evidence. Existing changed-file products record consulted source and reference dependencies; derived reuse must retain those invalidation rules.

Comparable shared mechanisms: direct extraction reuses per-file evidence products and yields the event loop to release native parser trees. HTTP summaries already batch `resolvedCallSitesForDefinitions`; body propagation calls its one-definition counterpart, which uses the same per-database cache. Both ultimately consume compiler occurrence ranges and `parameterValueFlowAtCall`, so optimize their shared hot paths where profiling supports it. `sourceBindingResolver` centralizes binding identity, module references, writes and callable resolution; mounting must reuse that authority rather than introduce a second import parser.

The local `context` query identified the expected reindex and analysis consumers, but its index was initially stale; source reads establish the flow above, and impact verification will require freshness after edits.

## Execution plan

1. Profile an isolated SQLite snapshot of LaunchPoint with an empty evidence cache, reading the real source and checking its content hash before/after. Preserve live indexes and watchers. Capture the full graph plus an unchanged run, phase timings and a CPU profile. The temporary runner invokes the production collector directly; it is not a new shipped analysis path.
2. Remove unnecessary route-mount preparation using existing source-binding machinery. Preserve malformed-source behavior, unresolved mounts, aliases, shadowing, cycles and bounded composition. Test observed graph outputs and avoided expensive work.
3. Use the measured CPU and phase costs to optimize shared wrapper/body resolution without changing evidence rules. Add regression checks for the affected cache lifetime and semantic cases.
4. Compare all graph observations, relations, links, unresolved evidence and extraction errors on the same source snapshot. Then measure fresh-cache, unchanged and changed-file workloads, retaining explicit cache/build identities.
5. Run focused accuracy/incremental tests, required repository checks, review and fresh diff impact. Record limitations, commit and push the completed change. Deploy a verified speed improvement using the existing VM installation procedure and restart only watchers still active at replacement time.

## Implementation findings

- The profile records 82.3 seconds in direct HTTP extraction for `integration-tests/http/campaigns/redeem-code-contract.integration.test.ts`. `collectMethodCall` evaluated the first argument of every method named `get`, `delete`, etc. before establishing that its receiver was an HTTP client/router. The candidate now establishes the receiver first, avoiding imported schema/value analysis for unrelated database and collection methods. The HTTP evidence contract is unchanged.
- `readRepositoryTextFile` rebuilt the full indexed-document set and decoded the whole generation metadata for each individual file read. The candidate uses the existing `createPerDbValue` owner to retain those two immutable views for the reader lifetime. Every source read still reads/hashes current bytes; tests cover edit/revert freshness and old/new reader isolation.
- `sourceBindingResolver` eagerly built mutation effects and two node indexes, even for module-reference-only consumers. Those views are now independently lazy and remain scoped to the same parsed root. Tests prove import queries avoid mutation work, mutation queries compute it once, and separate source revisions remain isolated.
- No cache-key scope or relationship rules have been weakened. Full-runtime evidence-product invalidation is retained until a separate measured need justifies a producer-identity redesign.

Measurement artifacts: local `/tmp/scip-runtime-perf-20260910/`; VM `/tmp/scip-query-runtime-perf-20260910-KPytGB/`. Baseline and candidate use separately copied compiler databases, initially empty evidence stores, the same real source with before/after hashes, and the same profiler settings. Live watch processes and compiler generations are untouched during measurement.

No indexing-performance fix is claimed by the efficient-output deployment. No agent benchmarks were run.

## Additional verified changes

- Capability descriptors now establish that a callable handler exists before evaluating their `name` or `id`. Objects used only for display or persistence no longer trigger capability-value tracing.
- Binding effects now have separate lazy computations for lexical reassignment, aliases, property mutation and exported value exposure. A lexical reassignment is an assignment that replaces the value held by a named variable; a property mutation changes a member of a referenced object. These require different evidence. The existing traversals and conservative treatment of unknown calls remain unchanged.
- Mounting still visits the complete source inventory and retains unresolved mounts even without known handlers. Its redundant generation metadata and eager mutation preparation were removed through the shared owners instead of adding another import parser.

The controlled first candidate reduced runtime collection from 809.7 to 333.4 seconds; complete graph observations, links, relation groups, frontiers and file coverage matched exactly. Only timing/phase coverage differed. The final candidate took 306.5 seconds (2.64× faster, 62% less time). The forced warm collector sweep fell from 218.2 to 22.7 seconds (9.60× faster). This second sweep is not the normal unchanged-index fast path. Complete graph equality passed again: 7,185 observations, 666 groups, 2 links, 6,232 frontiers and zero extraction errors across 9,296 source files. Source hashes matched before and after each run. See [the machine-readable comparison](../benchmarks/runtime-indexing/2026-09-10.json).

Validation so far: the first full suite had one watcher-termination timeout (3,812 passing tests), and an isolated retry reproduced that cleanup timeout. The next full suite passed all 3,813 tests without a watcher change. The final build passed all **3,815 tests across 416 files**. Type checking (including property fixtures and public API consumers), focused formatting/lint, the 66-path API contract and skill-link checks passed. Do not describe the earlier timeout as fixed. The repository's own manual index refresh completed in 31.2 seconds, retaining its disabled watcher, and fresh diff impact found 17 changed indexed symbols with consumers in 13 files. Five nonindexed paths were disclosed and covered by source-based review/tests. Review reports no introduced blocking findings; eight existing complexity/architecture findings in the touched modules remain outside this performance change.

## Remaining cost and scope

The remaining profile is dominated by conservative object-mutation/alias tracing and source-fact/definition preparation. The initial attribution to LaunchPoint's 18,240-line schema module was not established: a later isolated check of all of that file's variable write/exposure queries took less than a second. Nested repository queries must be measured to identify the actual costly files. In the final profile, direct extraction took 123.8 seconds, HTTP summaries 146.0 seconds, mounting 15.5 seconds and body propagation 21.0 seconds. Shared preparation can move between phases, so phase deltas alone do not establish independent speedups; use total runtime collection for the comparison. These changes reduce redundant work without changing relationship rules or accepting stale evidence. They do not establish that indexing is maximally optimized or that every possible TypeScript program is equally fast.

Full-build evidence cache invalidation is deliberately retained. Narrowing producer identities is a separate correctness-sensitive design change, not required for this verified improvement. No source-size cutoff, timeout, unsupported claim of absence or new dependency rule was introduced.

## Whole-index validation

The staged Linux build indexed 9,221 TypeScript inputs in five compiler shards (four concurrent) into an empty output directory with shared cache and watch-service reuse disabled. Total command wall time was **326.6 seconds**; the indexer's reported duration was 324.3 seconds. All five shards ran in full mode, no languages were skipped, and the complete stored runtime graph matched the original baseline, including all unresolved evidence and file coverage. This run had no CPU profiler, so its runtime-phase timings should not be substituted for the controlled before/after comparison.

The normal unchanged-index fast path then completed in **1.13 seconds**, reusing the compiler index, all 7,185 runtime observations and both links. These measurements validate initial creation and ordinary reuse; one-file incremental correctness is covered by the completed full suite rather than a new LaunchPoint edit-latency benchmark. The two existing live worktrees stayed fresh and idle throughout the isolated measurements.

## First deployment and next investigation

The dev-agent canonical installation now contains `f960a2d4`. All 458 shipped files and 19 skill files were verified against the package; all 12 skill links resolve to that installation. Only the two watchers active at deployment were restarted (3817650 → 3850875 and 3817788 → 3851020); both remained fresh and idle on their existing compiler generations. The installed CLI passed indexing, complexity, call, health, relationship and output smoke checks. See [deployment receipt](../benchmarks/runtime-indexing/2026-09-10-vm-install.json).

The user requested a substantially faster result after seeing the five-minute timing. Continue through the actual remaining algorithmic costs. The isolated persistence extraction for `src/lib/campaigns/warmup/infra/list-state-queries.test.ts` is the initial reproducer: it consumed 67.6 seconds in the full profile, although its own standalone binding effects and those of the schema module are fast. Instrument nested binding-effect, source-fact and definition calls in an unshipped diagnostic bundle to identify their real referents before changing more production code. Preserve the full graph comparison and all incremental correctness guarantees.

## Second iteration: verified causes and changes in progress

- A one-file occurrence decode called `getAllDefinitions`, which source-corrected all repository definitions before decoding its first reference. The isolated 146-line persistence test actually spent 79.6 seconds loading unrelated definitions; selective exact-symbol catalog lookup cut that to 1.7 seconds with all five observations identical. The lookup retains the complete per-file primary/fallback merge before filtering requested symbols, so narrow queries cannot promote normally excluded fallback members. Regression tests cover unrelated reads, absent/external symbols, batched large requests, and mixed-row exclusions.
- Definitions requested only callable ranges through `getCallableSites`, which built every source fact (identifiers, calls, branches, etc.). Reuse the existing `callableSitesFromRoot` range traversal for these consumers; preserve other-language fallback paths and the same corrected ranges.
- The remaining repeated mutation cost is a cache-lifetime defect, not evidence that the alias algorithm itself requires minutes. A native tree holds root-node wrappers weakly. Garbage collection can discard the wrapper and its root-keyed analysis even while `TREE_CACHE` retains the native tree. A standalone native-parser experiment reproduced this loss. The full profile repeatedly spent about 250ms rebuilding `MediaPlayerModal.tsx` mutation effects; one standalone complete computation took about 257ms, and all subsequent variable queries were cheap.
- The AST cache now retains each root beside its tree for the existing bounded 256-entry lifetime. It does not change the native parser or retain trees beyond replacement/invalidation/eviction. Regression tests force actual GC across event-loop turns: mutation analysis survives while cached, an evicted root is collected, and changed source bytes produce fresh analysis.
- Selective symbol lookup alone improved the isolated query but worsened full cold collection (376.3 seconds versus 306.5), because it changed cache/work ordering while root eviction still caused repeated preparation. Do not deploy that intermediate alone or claim its microbenchmark predicts whole-index speed. The combined range-only and retained-root candidate is undergoing full graph/timing comparison and the complete test suite.

Current uncommitted production ownership: `src/symbols/definition-catalog.ts` owns selective exact-symbol resolution and range-only preparation; `src/symbols/graph/scip-chunk-occurrences.ts` resolves only decoded nonlocal reference symbols; `src/source/ast/ast-core.ts` owns bounded tree/root lifetime. No new parsers, evidence cutoffs, heuristics or relaxed invalidation rules were added.

The combined second candidate completed controlled runtime collection in **114.7 seconds**, versus 306.5 seconds for the first deployed fix and 809.7 seconds originally. Complete graph equality passed again, including every observation, group, link, frontier, extraction error and file-coverage record. The original-source hash is unchanged. Its forced second collector sweep took 24.3 seconds; ordinary unchanged-index reuse remains a separate measurement. See [second comparison](../benchmarks/runtime-indexing/2026-09-10-fast.json).

Second-candidate checks so far: type checking, lint on changed files, the public API contract/consumer and skill-link checks passed. Review reports no introduced blocking findings (two existing findings remain in the touched modules). The local index refreshed in 34.5 seconds with the watcher still disabled; fresh diff impact identified 14 changed symbols and consumers in 42 files, explicitly disclosing five nonindexed paths. The complete test suite and staged full cold/reuse measurements must finish before deployment.

The first full cold run of the second candidate took **197.7 seconds**, with unchanged reuse at **1.03 seconds**. The complete rebuilt runtime graph matched the original graph. The full suite passed 3,819 cases and hit the previously observed forced watcher-stop timeout in the anonymous-type indexing history; that exact test passed separately on retry. This cleanup timeout is not claimed fixed by the performance change.

The compiler stage also had a fixed four-child cap in `src/reindex/typescript-compiler-shards.ts`, in addition to its existing CPU/memory limits. LaunchPoint emits five shards, so the fifth started only after the first wave. The VM has 24 CPUs and about 62 GiB physical memory; the existing half-memory/half-CPU budgets permit five estimated 6 GiB compiler children. An isolated run using the existing five-child environment override reduced compiler wall time from about 74 to 55 seconds. An experimental production change removed the four-child cap while retaining both hardware budgets and explicit overrides; it was subsequently reverted after measuring the aggregate memory cost. Shard membership, source-byte balancing, merge order and compiler context remain unchanged. Full-index graph and compiler-fact equality passed at both concurrency settings. The memory result below determines the retained default.

## Memory concern and incremental verification

The user questioned the 29.6 GiB peak and asked whether incremental indexing still works. Keep the earlier **four-worker default**: five workers saved only about 20 seconds while the complete cold-index process set peaked at 31,070,892 KiB RSS (minimum machine available memory 8,607,968 KiB). The experimental cap-removal code has been reverted before deployment. Retain the algorithmic lookup/range/cache-lifetime fixes, whose complete cold build took 197.7 seconds and unchanged reuse 1.03 seconds. Five-way compiler fact equality and graph equality passed, but it remains opt-in rather than the new default.

Before deploying, measure an actual incremental edit in an isolated copy of LaunchPoint. Preserve live worktrees and disabled watchers. Use the existing accepted generation where compatible; start a temporary watcher only for the isolated fixture with a long debounce so manual index requests own the measurement. Record the first edit after worker startup and a subsequent warm edit separately, with `allowExpensiveRebuild: false`, reported publication strategy/affected files and aggregate process memory. Restore the fixture and stop its watcher afterward. The existing full suite and successful anonymous-type retry establish correctness, but they do not establish LaunchPoint incremental memory use.

## Preventing unnecessary broad runtime work

The user asked how to prevent broader runtime-graph analysis after small edits. A runtime graph records supported connections such as an HTTP request and its handler, router mounting, or a value passed through a serialized request body. Some connections require combining evidence from multiple files.

Confirmed current limits in `src/analysis/runtime-boundaries/graph.ts`:

- Direct extraction already stores consulted source hashes and complete symbol-reference file sets, including empty sets. Reuse must preserve those dependencies.
- HTTP-summary reuse is a whole-phase decision based on affected shape, proof files and seeds. A relevant change reruns propagation for all seeds.
- Carrier/body propagation has a whole-phase reuse gate that also requires HTTP-summary reuse.
- HTTP mounting calls `collectHttpMounts` over the entire source inventory whenever whole-graph reuse fails, even if only another relationship family changed.
- Per-file cache validation and narrow recomputation are distinct: retaining old results without validating their full inputs would trade speed for stale evidence.

Next implementation direction, subject to the actual edit measurements:

1. Cache mount extraction per file through the existing evidence-product owner; preserve the complete source inventory, successful empty results, unresolved mounts, consulted files and reference membership. Recompose affected router connections from those extracted facts.
2. Make individual HTTP wrapper/body summaries reusable computations keyed by exact compiler/source inputs and all consulted queries. Record empty caller results as dependencies so newly added callers invalidate the old answer. Public derivation source spans alone are insufficient: unsuccessful lookups can influence an answer without appearing in a displayed proof.
3. Propagate changed summary outputs to their consumers, stopping when the full downstream input is unchanged. Include changed source locations in that input because graph evidence must remain correctly located even when meaning is unchanged.
4. Treat source/compiler/configuration changes, missing dependency records and analyzer-version changes explicitly. Retain conservative broader recomputation whenever the recorded dependencies cannot justify narrower reuse.
5. Test correctness and avoided work together. Apply unrelated edits, added/deleted callers, imported constants, new/removed mounts, body-flow changes, errors/recovery and restarts; compare every incremental result with a fresh graph, and assert unrelated expensive computations were not called. No claims based only on elapsed-time thresholds.

This is a further work-selection improvement, not a claim that the three current lookup/range/root-cache fixes already implement per-summary invalidation. Measure the current behavior first, then implement bounded changes with the same complete-graph oracle.

The first real edit in the isolated LaunchPoint copy succeeded through the incremental service, but it is not a fast edit: 5,607 compiler documents were emitted and patched across 44 batches for one changed source file. The accepted comparison reported 874 changed compiler-fact digests. Runtime then took about 56 seconds (direct extraction 2.2s, HTTP summaries 20.3s, mounts 15.5s, body propagation 17.4s). Complete request wall time was 220.5s and the sampled requestor/watch-service process set peaked at 15.4 GiB RSS. This is lower than five concurrent cold compilers, but still substantial; do not describe ordinary incremental memory/latency as solved.

The runtime handoff at `src/reindex/index.ts` passes the compiler's predicted affected files, although incremental SQLite publication already computes actual changed compiler-fact paths. These are different sets. Narrowing runtime work must combine actual changed compiler facts, changed source bytes and recorded runtime dependencies. Passing only the changed source files would miss imported values and newly resolved callers; passing only changed compiler facts would miss runtime-relevant literal/body edits that leave compiler relationships unchanged. Record query inputs/answers sufficiently to detect both changed membership and changed resolution within an existing referencing file.

A read of the saved compiler dependency graph confirmed the measured warmup query file has only three direct consumers but thousands of transitive consumers. One recorded dependency chain reaches the schema module through warmup, auto-live imports and creator-read code. This explains the conservative scope expansion; it does not prove every member needs new compiler output. Do not replace transitive invalidation with direct-import-only updates. A separate compiler optimization needs stable symbol/type output comparisons before it can stop propagation safely.
