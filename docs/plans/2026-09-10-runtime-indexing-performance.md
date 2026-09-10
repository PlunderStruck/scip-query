# Runtime indexing performance: VM diagnosis

Status: measured slowdown confirmed; implementation changes remain to be made and validated.

Runtime relationship analysis is the indexing stage that reads source and compiler relationships to infer connections such as HTTP requests, registered handlers, database operations and queues. It analyzes code; it does not run the application's services.

## Observed evidence

On 2026-09-10, read the persisted runtime coverage from both active LaunchPoint worktrees, using read-only SQLite connections. Raw coverage and process/status receipts are in `/tmp/scip-query-efficient-install-20260910-SADRtv/` on `dev-agent`.

| Persisted runtime phase | `t3code-66bd3d33` | `t3code-93516b5b` | Output |
| --- | ---: | ---: | --- |
| Direct source extraction | 162.2 s | 150.2 s | 7,101 / 7,139 observations |
| HTTP wrapper propagation | 259.7 s | 276.3 s | 82 observations each |
| Express route mounting | 202.9 s | 202.8 s | 0 observations each |
| Request-body discriminator propagation | 170.6 s | 235.5 s | 0 observations each |
| Relation grouping and links | under 0.01 s | under 0.01 s | 666 / 674 groups; 2 links each |

The mount phase records visiting all 9,296 / 9,351 source files. Querying stored observations confirms **zero HTTP handlers eligible for router mounting in either worktree**. The body phase records 189 / 190 inspected files, with 258 / 260 callable body summaries and zero final observations.

These are persisted analysis-phase durations, not a new controlled benchmark. They must not be added to compiler-shard timings to assert an end-to-end total: shards can overlap, and stored phase data can survive reuse. The previous recorded reindex durations were 888.2 and 957.9 seconds; the first deployment's separately measured command wall time was 904.9 seconds.

Both watchers were idle and their indexes fresh before deployment. The output-only update preserved the accepted generations, and both restarted watchers remained idle and fresh. There is no evidence of a current rebuild loop from these observations.

## Findings and next changes

1. **Route mounting performs an unconditional repository sweep.** `src/analysis/runtime-boundaries/http-mounts.ts` builds the eligible-handler map, then calls `collectHttpMounts` even when that map is empty. Collection creates an AST context for every source file before testing its imports for Express. An AST is a parsed tree whose nodes identify source constructs such as imports and function calls. This is a confirmed work-selection problem. Mount collection also produces unresolved-location evidence, so simply returning early could change accuracy even when no links can be created. Preserve that evidence while restricting expensive work to applicable files, preferably reusing module facts already collected during extraction. Avoid text heuristics that would miss aliases or alternative valid import syntax.
2. **HTTP wrapper tracing is the largest individual recorded phase.** `http-summaries.ts` already batches compiler-resolved caller lookups, so replacing it with batching is not a diagnosis. Profile its existing seed, caller-resolution and argument-processing spans on an isolated copy of the real graph. Retain exact/candidate distinctions, unresolved calls, transformations and recursive wrapper handling.
3. **Body propagation needs finer cost attribution.** `carrier-discriminators.ts` traces callable summaries one at a time using the existing call resolver, which has per-database caching. Inspect cache reuse and repeated value-flow work before claiming a particular optimization will help. Zero emitted observations does not prove the work was unnecessary: intermediate summaries and error evidence may be needed.
4. **Analysis caches are invalidated by the entire runtime build.** `src/storage/evidence-cache.ts` includes `cliBuildIdentity()` in file/project evidence keys; `src/platform/cli-version.ts` hashes the full runtime tree. Consequently an output-only runtime change can invalidate these derived caches even while the compiler index remains fresh. That follows from the implementation, but its cost in these recorded runs is unmeasured. Investigate dependency-specific producer identities with invalidation regression tests before narrowing keys; stale facts must never be reused after analysis logic changes.

## Validation required before a performance claim

- [ ] Capture a phase/CPU profile against an isolated real LaunchPoint index, preserving the active worktrees and stopped watchers.
- [ ] Optimize applicable-file selection for mounting; test empty handlers, Express imports/aliases, unresolved mounts, cycles and path bounds.
- [ ] Compare complete observations, links, groups, unresolved evidence and errors before/after; do not compare only final link counts.
- [ ] Measure cold, unchanged and one-file-change work separately, with cache state and build identity recorded.
- [ ] Investigate wrapper/body costs using their measured hot paths, then test the affected value-flow contracts.
- [ ] Run the appropriate runtime-boundary and incremental-cache accuracy tests before deployment.

No indexing-performance fix is claimed by the efficient-output deployment. No agent benchmarks were run.
