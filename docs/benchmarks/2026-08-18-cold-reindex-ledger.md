# Cold reindex optimization ledger — 2026-08-18

## Output Contract

The cold path must produce a usable SCIP file and SQLite generation for every successfully indexed language, persist the exact runtime-boundary graph, validate before promotion, and expose the new generation only through the existing atomic publication path. Failures must leave the prior accepted generation readable, clean the run directory, record failure activity best-effort, and release the index, cache-lifecycle, and shared-build locks.

## Target Selection

The first isolated cold run took 24.4s. Its status telemetry assigned 15.2s, or about 62% of wall time, to runtime-boundary direct extraction. Fingerprinting took tens to hundreds of milliseconds and language indexing plus publication outside direct extraction could not explain the dominant delay.

## Current Pipeline

1. Detect languages and build or delta-update the project-input fingerprint.
2. Resolve shared-generation eligibility and acquire shared-build, cache-lifecycle, and reindex locks in that order.
3. Reuse an accepted generation when eligible; otherwise ensure the SCIP converter exists and create an isolated run directory.
4. Classify language/project shards and run missing language indexers with bounded concurrency.
5. Materialize a complete SCIP companion when required, then convert or incrementally patch SQLite.
6. Augment auxiliary documents and runtime-boundary facts, optimize SQLite indexes, and collect affected-set shadow evidence.
7. Write metadata, atomically promote the validated generation, carry eligible dependency data forward, prune overlays/fragments, persist activity, and release resources in `finally`.

## Run History Location

`docs/benchmarks/runs/2026-08-18-cold-reindex-campaign.jsonl`

## Profile Spans

The campaign reused `src/instrumentation/profile.ts`. Existing coarse spans cover fingerprinting, lock acquisition, reuse checking, converter readiness, fresh indexing, language indexers, and publication. This campaign added profile-only per-file context spans and per-extractor spans under `runtime-boundaries.*`; the allowed reindex layer supplies the profiler to the analysis layer, and when profiling is disabled it executes the original callback directly.

## Bottleneck Candidates

| Rank | Measured operation before accepted fixes | Cost | Cardinality | Decision |
| --- | --- | ---: | ---: | --- |
| 1 | Runtime-boundary direct extraction | 16,130ms profiled | 683 context builds | optimize now |
| 2 | Eager definition catalogs | 7,343ms | 683 files | make lazy |
| 3 | Capability-registry traversal | 6,294ms after fix 1 | 647 files | prune impossible files |
| 4 | Language indexers | 6,500ms profiled control | TypeScript + Rust | retain; next independent target |
| 5 | Eager literal constants | 1,197ms | 683 files | make lazy |

## Measurements

| Stage | Cold wall | Direct extraction | Observations | Decision |
| --- | ---: | ---: | ---: | --- |
| Starting unprofiled control | 24,406ms | 15,171ms | 593 | baseline |
| Starting profiled control | 25,198ms | 16,130ms | 593 | baseline/profile |
| Lazy context, profiled | 19,975ms | 10,459ms | 593 | accepted |
| Over-tight capability prefilter, profiled | 14,798ms | 6,444ms | 548 | rejected: 45 observations missing |
| Corrected necessary-shape prefilter, profiled | 14,901ms | 6,666ms | 593 | accepted |
| Final unprofiled series | 16,256 / 16,331 / 16,362ms | 6,828–7,677ms | 593 each | accepted, 16,331ms median |
| Post-architecture verification, unprofiled | 14,667ms | 6,258ms | 593 | accepted smoke; cold/warm artifact pair identical |

The conservative unprofiled comparison is 24,406ms to 16,331ms: 8,075ms lower, or 33.1% faster. The profiled comparison is 25,198ms to 14,901ms: 10,297ms lower, or 40.9% faster. Direct extraction improved from 16,130ms to 6,666ms, or 58.7%.

A later two-iteration record contains a 39,375ms contended sample followed by a 14,296ms sample. It remains in run history. A subsequent process inspection found another reindex worker at about 4.2GiB RSS and 98% CPU plus a separate analysis worker at about 0.9GiB RSS and 100% CPU. Because that series was not stationary and two samples do not yield a useful median, it is not the accepted comparison.

The post-architecture smoke verifies that moving profiling ownership out of the analysis boundary did not regress the optimized path. It is one sample, so the three-run median remains the conservative scoreboard value.

## Current-Pipeline Optimizations

### Accepted: lazy boundary ownership context

Definition catalogs, source-fact callables, and literal constants are now built on first use. The context exists only during one file's extraction, so the cached values do not acquire a long-lived owner. The direct caller also passes already-read source text instead of reading it again.

Measured effects: definition builds fell from 683 files/7,343ms to 174 files/2,201–2,438ms. Literal-constant builds fell from 683 files/1,197ms to zero on the measured cold path.

### Accepted: necessary-shape capability prefilter

The capability extractor now enters the AST only when source text contains a shape that every possible emitted observation requires: a `name`/`id` identity plus an execution field, an identifier with `_` or `-` followed by `(`, or an instruction verb followed by a callable capability name. This reduced applicable files from 647 to 160 on the profiled repository run.

The first, narrower version wrongly assumed a capability reference began and ended on one source line; it suppressed 45 observations embedded in multiline strings. That version was rejected. The corrected version preserves the necessary substring without assuming quote placement.

## Alternative Designs

- Build one per-file typed-node index and let all boundary extractors reuse it instead of recursively walking the same AST. This is the next current-pipeline candidate, but it is a wider representation change and needs ordering-parity tests.
- Run benchmark iterations in separate coordinator processes and sample the complete descendant process tree for RSS. This is the next harness improvement required for defensible whole-build memory and OOM claims.
- Parallelize SQLite conversion and runtime-boundary extraction. Rejected for now: runtime boundaries read the converted database, augmentation and query-index maintenance mutate that candidate, and validation/promotion must remain ordered after all mutations.
- Persist more runtime-boundary inputs outside SQLite. Deferred: the existing graph already reuses unchanged/incremental facts; a second cache would add invalidation and durability surface before remaining cold costs are profiled.

## Decisions

- Keep both accepted runtime-boundary optimizations.
- Keep the rejected 548-observation run in history as negative evidence.
- Keep profile-only context/extractor spans because they expose the next bottleneck without affecting unprofiled execution semantics.
- Treat coordinator RSS as scoped evidence only; make no whole-build memory reduction claim from this harness version.

## Scoreboard

| Measure | Starting | Current | Delta |
| --- | ---: | ---: | ---: |
| Isolated cold wall, conservative unprofiled comparison | 24,406ms | 16,331ms median | 33.1% faster |
| Profiled cold wall | 25,198ms | 14,901ms | 40.9% faster |
| Runtime-boundary direct extraction | 16,130ms | 6,666ms | 58.7% faster |
| Immediate unchanged warm | 399ms single control | 216ms median | informational; not optimization target |
| Runtime-boundary observations | 593 | 593 | preserved |
| Runtime-boundary links/frontiers | 0 / 225 | 0 / 225 | preserved |
| Repeated SCIP SHA-256 | not repeated at baseline | one identity across final runs | stable |

## Remaining Ranked Opportunities

1. Language-indexer cold work: about 5.9–6.9s in profiled runs.
2. Capability-registry traversal: about 2.7s across 160 eligible files.
3. Definition ownership materialization: about 2.2s across 174 files.
4. Node child-process traversal: about 1.6s across 83 files.
5. Process-isolated benchmark orchestration and complete process-tree RSS/OOM accounting.
