# Runtime indexing performance: VM diagnosis

Status: implementation, regression tests and controlled runtime comparison complete; whole-index timing and VM deployment in progress. Starting commit: `cb487ac8`.

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
- [ ] Finish a complete cold LaunchPoint index and measure the normal unchanged-index fast path separately.
- [ ] Deploy the verified package under dev-agent and verify only currently active watchers are restarted.

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

The remaining dominant runtime cost is conservative object-mutation/alias tracing, including LaunchPoint's 18,240-line schema module. In the final profile, direct extraction took 123.8 seconds, HTTP summaries 146.0 seconds, mounting 15.5 seconds and body propagation 21.0 seconds. Shared preparation can move between phases, so phase deltas alone do not establish independent speedups; use total runtime collection for the comparison. These changes reduce redundant work without changing relationship rules or accepting stale evidence. They do not establish that indexing is maximally optimized or that every possible TypeScript program is equally fast.

Full-build evidence cache invalidation is deliberately retained. Narrowing producer identities is a separate correctness-sensitive design change, not required for this verified improvement. No source-size cutoff, timeout, unsupported claim of absence or new dependency rule was introduced.
