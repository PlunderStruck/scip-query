# Cold TypeScript indexing time and memory

Status: measured runtime improvements and lower-memory default implemented and validated; 90s target remains open. Baseline code `25281702`; current HEAD `20773a96` records the baseline measurement. Preserve the unrelated untracked LaunchPoint validation document and all active/disabled VM watchers.

## Requested outcome

Bring a complete cold LaunchPoint backend index toward **90 seconds**, with substantially lower memory than **23.41 GiB**. Investigate an **8 GiB** working memory budget; report actual results without hiding remaining cost or reducing relationship coverage. Cold means empty scip-query artifacts and no retained worker/shared generation; dependencies and OS page cache are available. No agent benchmarks.

Baseline: `docs/benchmarks/runtime-indexing/2026-09-11-cold-launchpoint.json`. Main LaunchPoint source `dd611a94`, 9,485 indexed files, 7,359 runtime observations, no runtime extraction errors. Wall 219.32s; compiler 77.97s, conversion 11.03s, runtime graph 123.07s. Four simultaneous compiler workers each reach about 5.6–5.9 GiB. Runtime direct extraction 53.91s, HTTP summaries 25.36s, mounts 16.12s, body summaries 22.88s. Preserve source, compiler facts, graph objects, and publication/recovery guarantees.

## Existing flow

CLI reindex reaches `runtime/project-reindex.ts:reindexConfiguredProject`, then `reindex/index.ts:reindex` for fingerprinting, locks, language planning and publication. `prepareBoundedTypeScriptCompilerShardRuns` creates five emission subsets for this repository, using `typescript-compiler-shards.ts` to select four concurrent children. Each `typescript-indexer.ts` child calls the existing upstream compiler with our declaration identity/visitor-failure adapters. `typescript-project-emission.ts:installTypeScriptProjectEmission` limits emitted documents only **after constructing the complete compiler program**. This repeats the full shared compiler context in every child. Upstream `ProjectIndexer.index` already writes one SCIP document at a time; determine what still grows before introducing another emitter.

The coordinator converts SCIP to SQLite, checkpoints source, then calls `runtimeBoundaryAugmentationStage` and `collectRuntimeBoundaryGraph`. Direct extractors produce per-file observations. HTTP, mount, body and carrier phases derive relationships through existing readers and phase records. `resolvedCallSitesForDefinitions` is shared by propagation. Immutable generation publication, dependency products, and final source validation complete the same coordinator flow. The current context queries for compiler sharding and the runtime graph are saved in `/tmp/scip-cold-benchmark-20260911` for existing callers/dependencies.

## Comparable features and conventions

- `typescript-document-emitter.ts` and the retained compiler service already preserve a complete program while emitting bounded documents, adapting declaration identities and failing on visitor errors. Reuse their identity/emission contracts and independent full-compiler comparisons.
- The upstream full compiler streams documents and shares symbol/constructor maps within its project. Inspect their growth and release rules before choosing shared-program emission or changing shard policy. Simply serializing five complete compiler builds would reduce memory while wasting more time.
- Runtime direct file products and retained phase records already define invalidation from actual source/compiler facts. Reuse those owners. Cold processing cannot assume cached negative evidence or omit uncertain relationships.
- HTTP mount discovery records unresolved mount frontiers independently of successful handler composition. Any relevance gate must preserve these frontiers.
- The existing immutable publication store now retains actual manifest filenames for augmentation recovery. Keep its reader leases, atomic handoff, interruption behavior and source validation.

## Reuse and ownership decisions

Keep the CLI/coordinator, compiler adapter, and runtime graph collector as the live path. Use measurements to choose changes inside existing owners. Do not replace compiler facts with text guesses, disable extractors, lower accuracy checks, or claim cache hits on a cold run. Any removal or replacement of the shard path must name compatibility/tool override consumers and preserve small/workspace/project-tool behavior.

## Work list

- [x] Profile a single complete compiler program independently; distinguish compiler context growth from document/emitter retention. Compare its output with the sharded baseline.
- [x] Trace expensive call-site resolution, persistence/capability extraction, per-file hashing, and mount scanning. Record concrete repeated work and supported reuse before edits.
- [x] Bound compiler concurrency without changing identity and failure contracts. Compiler memory per worker and the 90s goal remain unresolved.
- [x] Implement runtime changes that preserve direct observations, derived groups/links/frontiers and invalidation behavior.
- [x] Run distinguishing regressions and stable-build full tests, types/lint/API, source review, fresh impact and relevant architecture checks.
- [x] Benchmark a frozen candidate from an empty cache on the same source snapshot; compare compiler documents and complete runtime graph facts. Exercise incremental edits after the cold build; recovery remains covered by the full-suite generation-store tests (no new VM interruption injection).
- [ ] Commit/push and update dev-agent with only the watcher identities still active at deployment; record final timings, memory and limits.

Scratch: local `/tmp/scip-cold-benchmark-20260911`; isolated baseline `/tmp/scip-query-cold-launchpoint-20260911-dc2hj72s` on dev-agent. The original source and watchers were verified unchanged after the cold benchmark.

Single-program pilot: the installed upstream-backed adapter with all roots and an 8 GiB heap failed with OOM around 115s of Node execution, having emitted a partial 320 MB artifact. The measured process lifecycle was 200s including fatal termination/core handling; it is not a successful indexing time. No accepted index was replaced. Thus merely disabling sharding is not a fix. Existing SCIP documents are streamed, but compiler state continues growing. Next investigation: isolate emitted-document dependency closure while retaining all global/ambient inputs, and profile expensive compiler operations before changing semantics.

Runtime baseline spans: incoming HTTP call-site resolution 23.27s, capability extraction 14.69s, persistence extraction 12.20s, tokenized source hashes 7.65s. Mount collection parses every file through a local binding checker just to discover Express imports. HTTP/body propagation use fresh readers deliberately so cached source/SQL dependencies cannot escape their phase proofs; preserve that reason when removing repeated work. CPU profiling is running against the accepted baseline SQLite with a separate empty evidence cache.


## Confirmed runtime changes (in working tree)

- `boundaryFileContext` now reuses one precise callable list and owner map instead of building full source facts for every observation. Shared `callableFactsFromRoot` preserves columns/parameters; the public range-only view retains its shape.
- Imported definition lookup uses the shared node-type index rather than walking every node per call.
- Module import discovery parses TypeScript directly and binds a checker only for require shadowing; negative Express files do not need tree-sitter contexts. Malformed/missing source is not accepted as negative evidence; unresolved positive mounts remain frontiers.
- Incoming call resolution restricts value/mutation proofs to compiler declarations actually requested. All matches for a selected call remain present for ambiguity handling. Replaced the earlier whole-range cache experiment; phase readers remain separate and record their actual dependencies.
- Token hashes concatenate the same framed bytes into one native hash update per token. Definition correction splits source lines once per file.

Standalone empty-evidence-cache runtime measurements on baseline accepted SCIP/SQLite:
- Baseline with CPU profile: 124.194s.
- First candidate with CPU profile: 80.432s; all observations/groups/links/frontiers equal.
- Targeted incoming candidate: 66.243s; all observations/groups/links/frontiers **and fileCoverage** equal (7,359 observations, 689 groups, 2 links, 6,386 frontiers). Direct 29.233s, HTTP 14.916s, mounts 5.513s, body 12.639s, carrier 1.469s.
- Latest hash/line changes still need frozen-candidate measurement.
- Latest focused batch: 134/134 tests passing. Scoped call test added afterward; full build/checks pending.

## Compiler experiments (diagnostic scripts only, not shipped)

Remote baseline directory contains compiler-profile, compiler-pruned, compiler-closure, compiler-closure-direct, compiler-context-cache, compiler-heap4. All use the same 1,552-file first emission subset and installed adapters. No accepted index or live watcher changes.

- Full-context shard profile: 49.33s profiled; about 6.07 GiB sampled RSS. Complete TS program has 17,963 loaded files including 9,485 configured inputs. TypeScript contextual typing/JSX overload resolution is the large compiler cost; output is already streamed.
- Pruned roots plus ALL ambient declaration files: 50.73s / 5.98GiB max RSS (discovery and new compiler coexist); 12,844 loaded files. No occurrence/symbol/relationship differences in 1,552 emitted documents; documentation differences include equivalent union ordering.
- Pruned roots plus global/non-module/module-augmentation contributors only: 974 ambient inputs, 11,518 loaded files; 50.70s / 5.93GiB (same coexistence overhead). All 1,552 documents' non-documentation facts equal baseline. This does not yet establish universal semantic equivalence; not adopted.
- Same latter closure with ambient manifest already available (no full discovery in emission process): 43.08s / 4.83GiB max RSS. Discovery overhead still needs accounting in a real full cold path.
- Per-file external getContextualType memoization: 47.04s / 5.84GiB. 101,164 hits / 41,605 misses. Too little gain to justify a new checker adaptation without stronger evidence; not adopted.
- 4GiB heap full-context shard pilot running. A lower limit must complete without excessive GC; never publish partial output.

The ~90s whole-index target is **not met**. Runtime optimization is real but compiler memory remains the limiting open item. Do not deploy diagnostic pruning or claim the goal achieved based on component timings.


Latest validation: stable build 2 + full suite: **3,925 tests / 426 files passed** (405.68s). The earlier full run mixed a cached source transform with an edited test and failed that one new branch-absence assertion; the clean rerun passes. No production compiler changes have been made.

Complete frozen runtime candidate, explicitly two compiler workers: `/tmp/scip-query-cold-candidate-20260911-61m5d0kn`, archive `6b1f2d7437276a6b7ac741e27d697a20b0dc72b8eab8753d5511246efe6a5523`. 196.038s, 11.724GiB peak, no swap; 9,485 files / 511,199 symbols; freshness and publication/SQLite checks passed. **Every one of the 9,485 SCIP documents is byte-identical to the accepted baseline** (metadata roots excluded). Latest full runtime phases: direct25.20s, HTTP14.33s, mounts5.76s, body11.70s, carrier1.41s. Concurrency 2 is a benchmark override, not yet the default. This is still far above 90s.

Compiler-diagnostic caveat: standalone scripts imported/parsed TypeScript before changing working directory, while TypeScript memoizes its current directory. These pilots loaded a different automatic ambient-typing context from a normal CLI invocation. Their mutual compiler comparisons do **not** establish equality to the accepted cold index. The runtime comparisons and complete two-worker benchmark are unaffected: those run with the project working directory from process launch and compare directly to accepted SCIP/SQLite. Do not adopt pruning based on these pilots. An additional guard comparing global contributors and order also failed; compiler context reduction remains unaccepted.

Next bounded runtime experiment: reuse successful, immutable TS/JS syntax trees across the collector's fresh phase readers, scoped to one project/collection and bounded by entry count and source text size. `getAst` must still obtain/report the current reader's actual source before reuse; SQL/compiler caches stay per-reader. Root-keyed consumers audited: node-type index, callable-node index, literal string decoding and local source binding/effects are source-only. Missing parse results must not be shared. Preserve different-project/source-revision isolation and release the scope after success/failure. Keep only if full graph/proof/incremental tests and measurements validate it.


Final policy decision: cap automatic compiler concurrency at two instead of four; retain the explicit override. This controls the known memory multiplier without narrowing compiler context. It is a memory/throughput tradeoff, not a claim that the remaining compiler cost is solved. The matching policy regression passes.

Rejected cross-phase AST-tree sharing: isolated runtime measured 60.82s / about 3GiB; no material improvement over the accepted approximately 59s runtime result. Removed the experimental scope/cache and its tests; retained the shared node-index tests relevant to the accepted changes.

Final focused validation after the default-concurrency change: **93 tests / 6 files passed**. Runtime production changes otherwise match the stable full-suite run. Final default-policy cold measurement, incremental smoke, review and deployment remain to do.


Final packaged default-policy run: `/tmp/scip-query-cold-final-20260911-f2df9j3l`, archive `993b0fa4bb7e6db53d70ebe5113bf519d702fc246133d4e01c8829a6aa2ea1eb`. **199.915s, 12.103GiB peak, zero swap**, 9,485 files / 511,199 symbols. No concurrency override. Every compiler document is byte-identical to the accepted baseline; observations, relation groups, links, frontiers and all 9,566 file-coverage entries are exactly equal. Runtime phases: direct25.01s, HTTP14.10s, mounts5.89s, body11.56s, carrier1.42s.

Final build, format, types (including property-test types), ESLint, public API contract/consumer and skill links pass. Fresh local reindex completed in20.5s; diff-impact reports19 changed symbols and28 affected files, with8 changed paths excluded from that index (tests/docs). Architecture finds no cycles or forbidden edges; its existing source file limit (72>67) remains. Review's renamed callable-filter callback has the unchanged predicate/metric; the definition-binding loop replaces the existing callback (cyclomatic14 to15), and the scoped-call selection adds a guard (cyclomatic11). These are understood local control-flow costs, not reasons to remove ambiguity/range checks or change thresholds.


Five incremental requests passed with whole-project fallback forbidden: first worker28.86s, body12.92s, inferred/imported-call change13.69s, runtime change14.69s, restoration16.46s; peak5.14–5.27GiB. The runtime edit added exactly the expected observation/group/frontier; all original graph objects remained unchanged. Restoration exactly matched original runtime objects and file coverage, removed the probe symbol, restored source/config bytes and stopped the private worker. Initial benchmark setup correctly refused a disabled watcher; the retry explicitly enabled only the private clone for the test and restored its config afterward. Existing VM watchers remained untouched during measurement.

Remaining performance work: the complete compiler stage is121.08s with two workers. A safe compiler change must preserve configured roots, automatic ambient typings, module augmentations, reference ordering and the existing declaration-identity/visitor-error contract. Compare exact compiler documents against a normal CLI invocation launched in the project directory, then run the ambient/overload/incremental conformance cases before adopting any reduced context. Do not count retained artifacts or defer runtime publication to claim a90s cold index.
