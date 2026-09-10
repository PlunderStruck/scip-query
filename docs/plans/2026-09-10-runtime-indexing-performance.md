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

## Completed real incremental measurements

All four production-service updates passed with expensive compiler fallback disabled. A warm edit changing the appended arithmetic probe from `+ 1` to `+ 2` still emitted 5,605 documents, although the comparison found **zero changed compiler facts**. Its runtime observations, groups, links and unresolved evidence were all identical to the original graph. The HTTP probe subsequently added exactly one request observation for `/scip-incremental-probe`, changed no existing observations and produced no extraction errors. Restoring the original source restored the complete original runtime graph, including every file-coverage record; the probe symbol was removed, and SQLite quick/integrity-reference checks passed.

| Edit | Complete request wall time | Runtime analysis | Aggregate peak RSS |
| --- | ---: | ---: | ---: |
| First edit after compiler startup | 220.5s | 55.6s | 15.4 GiB |
| Warm arithmetic body edit | 220.7s | 55.9s | 16.8 GiB |
| Warm HTTP request edit | 217.7s | 56.2s | 16.8 GiB |
| Restore original source | 220.7s | 55.8s | 16.9 GiB |

At the warm-body peak, the watch service and its compiler worker accounted for about 10.9 GiB RSS; the indexing requestor accounted for another 5.9 GiB. Aggregate RSS can count shared pages more than once. These measurements concern one file with thousands of transitive dependents, not every one-file edit. The temporary copy, index and watcher were separate from the live worktrees; the temporary watcher has stopped, and all original fixture source bytes were restored. The measurement runner's cache layout and refresh-trigger metadata were corrected during preflight; failed setup attempts are excluded from successful edit timings.

The three committed algorithmic fixes (`8b526c53`) improve cold analysis, but do not fix this broad incremental emission/recomputation. The next work must address both (1) compiler emission stopping when relevant symbol/type outputs remain unchanged and (2) smaller runtime computations recording complete source/compiler/query inputs, with dependency-triggered recomputation. The latter must retain successful empty lookups, changed source locations and conservative behavior when dependency records are insufficient. Do not substitute a changed-file-only heuristic for those proofs.

Fresh local review reported no introduced blockers; source inventory and `appendChunkOccurrence` complexity remain existing findings. Final local reindex completed in 23.1s with the watcher still stopped, and fresh diff impact found 14 changed symbols affecting 42 files. The staged package is byte-for-byte identical to the measured four-worker build across all 458 shipped files; its real CLI smoke checks passed before installation.

## Deployment paused for the confirmed incremental defect

The user challenged the 3m40s warm-edit result. Do not deploy the second candidate yet: this is a blocking performance defect, not an acceptable final result for the indexing task. The canonical dev-agent installation still contains `f960a2d4`; `8b526c53` is committed/pushed and staged but not installed. The two live watchers were only surveyed, not restarted. Continue fixing repeated compiler emission and broad runtime recomputation, then remeasure the same real edit sequence and deploy only after demonstrating the improvement without losing graph correctness. Earlier claims that incremental indexing worked were correctness claims from small fixtures; they did not establish acceptable real-project latency.

Next inspection: `TypeScriptIndexServiceHost` and the compiler document emitter own the retained compiler program and document batches. Establish whether unchanged source/semantic outputs can avoid repeated document emission through the existing compiler program's affected-file machinery. Preserve imported type changes, new/deleted exports, ambient/config changes and anonymous symbol identity; validate every incremental graph against a clean compiler oracle. For runtime propagation, use complete recorded inputs rather than narrowing to changed source files without dependency evidence.

An isolated cache-retention experiment moved declaration-map invalidation from every 128-document batch to compiler-program changes. Its regression test first failed on the old implementation and then passed; all emitted documents matched the original on 1,024 real files in cold and warm rounds. It did **not** materially improve throughput (42.7s/35.7s before, 43.9s/35.0s after, with the after run profiled) and raised observed peak RSS. The experiment is reverted; do not ship it as a performance fix. Use the captured emitter CPU profile to identify the actual cost before making more compiler changes.

## Follow-up experiments and retained mount improvement

Three contextual-query caching experiments (program-wide `getContextualType`, per-document contextual types, and per-document contextual types plus resolved signatures) preserved all 1,024 emitted document hashes in cold and warm rounds. They saved only about 1–2 seconds per round: baseline 42.7s/35.7s versus approximately 41.5–41.7s/33.5–33.8s. Observed peak RSS was higher than the baseline. These small measurements do not establish a worthwhile whole-index improvement; all three compiler-cache variants have been removed. Do not deploy or report them as fixes.

The retained runtime change caches the existing AST-based Express-import applicability result by source content through the file-evidence product owner. Each pass still inventories and hashes current source. Successful negative results avoid rebuilding AST/binding contexts; positive files still run the current mount resolver, including unresolved mounts. Missing contexts are not cached as negative evidence. No text/regex import filter or narrower inventory was introduced. Regression tests cover cache hits across new database readers, escaped module specifiers, misleading comments/string values, import edits/removal/reversion, repeated positive resolution and parser-context recovery. The focused runtime/storage suite passed 95 tests; type checking and changed-file lint passed.

Controlled complete runtime collection took 110.5s cold, with every original observation, relation group, link and frontier preserved. Stored per-file body-summary metadata differed; see the stale-definition finding below. Its forced warm collector sweep fell to 9.0s (previous second-candidate measurement 24.3s); the mount phase took 0.564s warm versus 16.2s cold. This is a forced collector measurement, not a complete incremental index. An initial fresh-process measurement used a standalone diagnostic bundle without package metadata; that correctly received a process-private cache identity and cannot establish persistent-cache performance. Repeating with a stable package runtime identity gave 37.84s for a fresh collector process, including a 0.437s mount pass. Its first process took 111.22s, including a 16.38s mount pass. This remains a collector measurement rather than complete incremental index timing. The benchmark input hash remains `de015e5b1ee71c8ecfeb048af4a6a9361fa652434c2d9a69e6d9e10947999ad4`.

### Compiler affected-file experiment and required definition-origin guard

A separate compiler-planning experiment used TypeScript's semantic builder on the isolated LaunchPoint copy. Initial builder creation took 11.7s. Establishing declaration signatures after the next edit took 23.9s and visited 5,604 files. The following two arithmetic edits each visited only one file in 2.44s and 3.02s. These are planning measurements, not completed SCIP index updates, and the source was restored afterward.

Do not replace the current planner with the semantic builder alone. A verified counterexample has an exported generic returning either of two structurally identical objects, selected by `choose<true >()` versus equal-width `choose<false>()`. The provider's entire SCIP document and emitted `.d.ts` text are identical, yet a consumer's `chosen.value` reference changes from the first object's property definition to the second. Therefore even combining an unchanged declaration signature with an unchanged provider SCIP document is insufficient to stop graph invalidation. `tests/reindex/typescript-document-emitter.test.ts` now locks down that concrete case against a clean compiler oracle.

A sound smaller compiler update needs both the compiler's type-change analysis and preservation of the actual declaration targets visible through exported values/types. Existing source-position identities must also be accounted for. Missing or unsupported boundary evidence must retain conservative propagation. Do not introduce a special arithmetic/body-only probe shortcut, treat identical type shapes as identical definition origins, or claim the 2–3s planning experiment is the completed fix. The VM remains on the first deployed build; the broad incremental performance defect is still open.


### Persisted request-body definition identities

Comparing a newly collected graph against the previously stored graph exposed stale `documentId` values in request-body summaries. Those IDs describe rows in one SQLite generation; they are not stable across publication. Previously cached summary metadata also retained obsolete documentation ordering. These metadata differences do not establish changed runtime relationships: all observations, groups, links and frontiers still matched. A targeted regression subsequently demonstrated a real consequence of stale **symbol** IDs: a forwarded request-body summary disappeared (2 summaries instead of 3) with no error.

The regression failed before the fix. Persistent body summaries now retain only the stable symbol, file and source span. The existing definition catalog resolves their current definition records once per distinct seed file through its complete catalog before propagation. Missing definitions are reported as errors, not silently treated as absence. Legacy numeric fields cannot control the lookup. Runtime extractor version advances to v31 so older direct/derived payloads are rebuilt. The focused runtime/storage tests passed 96 cases after the first fix; the final missing-definition assertions and all 100 focused cases passed.

Current production edits are mount import applicability caching and stable persisted body-summary identities, plus their shared evidence manifest/version/type wiring. The TypeScript document emitter has no production edits; it only gains the definition-origin regression described above. No compiler-query cache or builder-based pruning experiment remains in production. A full suite started before the body-summary correction and is preliminary; complete final affected-area checks and rebuild/API validation after the final edits. Keep deployment paused: the main broad compiler emission defect is not fixed by this batch.


The final v31 collector completed in 111.27s for its first process and 37.37s in a fresh second process using persisted evidence; forced same-process sweeps took 8.98s and 7.67s. The fresh-process mount phase took 0.439s. Every runtime observation, relation group, link, frontier and extraction error exactly matched the fresh v30 baseline on the same database (7,185 / 666 / 2 / 6,232 / zero errors). File coverage also matched after projecting old body-summary definitions to the six stable fields now persisted. This normalization is intentional schema simplification, not suppression of changed relationship evidence. Source hashes remained identical.

The preliminary full suite ran while the new stale-ID regression was being developed: 3,823 passed and that regression failed before its fix. It is not a final passing run. The final focused suite passed all 100 tests, including restored forwarding despite stale IDs and explicit errors for missing definitions. Type checking, changed-file lint, the 66-path public API contract and skill-link checks passed. Final full-suite and latest-bundle checks are still running. Local source review found no findings or blockers. The repository index refreshed with its watcher still disabled; diff impact identified nine changed symbols and consumers in five files, disclosing six nonindexed paths. Repeat the final build/refresh if the last catalog lookup adjustment changed the indexed source snapshot.


## Final verification for the runtime cache batch

The final build, type checks, public API/consumer checks, skill-link checks and changed-file formatting/lint passed. Source review reports no findings or blockers. The latest local index refresh took 27.1s, with the local watcher still disabled; fresh diff impact found nine changed symbols with consumers in five files and explicitly disclosed six nonindexed paths.

The complete test run recorded **3,818 passing tests, six timeouts and one Vitest worker RPC timeout**. Two failures were forced watcher-shutdown timeouts; four were CLI contract timeouts. A subsequent serial run of all three affected test files passed **46 tests**, including every failed case. The focused runtime/cache/compiler regressions passed **100 tests**; after the final file-catalog lookup adjustment, the two runtime suites passed all **66 tests** again. Do not describe the original full run as clean, attribute every timeout to a proven root cause, or claim the shutdown timeout was fixed by this cache change. The two reported timed-out watcher PIDs were no longer present when checked.

This batch is ready to commit and push. Keep the VM on its existing installation for now: the second build and this follow-up are not deployed, and no VM watcher was stopped or restarted. The main compiler-invalidation defect remains a separate required follow-up. The runtime collector's 37.4s fresh-process result and the builder's 2–3s affected-file experiment are not complete incremental index timings.

Remaining implementation work:

- [ ] Replace broad compiler re-emission with a proven dependency boundary that accounts for type changes **and** declaration origins visible to consumers. Use the existing TypeScript compiler and document adapter; preserve the equal-provider-document counterexample, anonymous identities, aliases, inferred/generic types, ambient changes and module/configuration changes.
- [ ] Persist complete inputs for smaller HTTP/body derivations, including unsuccessful queries and cache-hit dependencies, before relying on narrower runtime recomputation. Stable symbols/source spans are now safe to retain; database row IDs are resolved when consumed.
- [ ] Repeat real incremental edits in the isolated LaunchPoint copy, including edits to existing inferred functions, additions/removals and changed callers. Compare every result with a fresh compiler/runtime graph and record complete request latency and aggregate memory. Do not optimize only the arithmetic probe.
- [ ] Deploy the verified resulting build to the dev-agent profile, resurveying watchers at deployment time and restarting only those actually active then. The previous survey and staged 8b526c53 package are stale for a later deployment.
