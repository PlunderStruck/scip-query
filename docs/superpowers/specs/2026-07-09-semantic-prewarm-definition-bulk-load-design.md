# Semantic Prewarm Definition Bulk Load Design

Date: 2026-07-09

## Purpose

Reduce the serial semantic-prewarm phase that runs before full-health detector
processes fan out. On the accepted VegaAssistant response-reuse control,
`health.semantic-prewarm` took 24.704 seconds inside a 41.933-second command.
The target for this slice is at most 10 seconds for that phase and at most 30
seconds for warm Vega full health, without changing any command or semantic
payload.

Semantic candidate definitions are indexed source definitions whose files have
a registered compiler-semantic provider. They are the input set for prewarming
references and callees; what distinguishes them from all indexed definitions
is that scip-query can ask a language-specific provider for semantic facts about
them.

A bulk definition load is a database retrieval strategy that selects the
project's definition rows in set-oriented queries, groups them by file once,
and then applies the same row-merging and source-range correction rules. Its
essential difference from the current path is removal of one cache/SQL workflow
per indexed file, not a change to which definitions qualify.

## Current Evidence

The accepted Vega warm profile is
`docs/benchmarks/runs/durable-response-cache-v1-vega-20260710T004124Z-session-warm.profile.jsonl`.
It reports:

- full command: 41.933s;
- `health.semantic-prewarm`: 24.704s for 38,222 definitions;
- semantic reference provider work: 3.130s;
- largest reference cache scan: 1.327s;
- largest callee cache scan: 2.960s;
- reference and callee cache writes together: 0.209s;
- durable semantic response request: 0.680s;
- zero incomplete Rust references and exact readiness-v2 payload digests.

The named child spans do not account for roughly 15 seconds of prewarm wall
time. The unmeasured work begins with `candidateDefinitions` and ends with the
two existing materializers. The current default candidate loader calls
`ProjectIndex.scopedDefinitions()`, which delegates to
`getScopedDefinitions()`. That function enumerates indexed document paths and
calls `getDefinitionsForFile()` once per file. The source evidence is:

- `scip-query code runHealthSemanticPrewarm`
- `scip-query code 'src/runtime/cli-support.ts:227-241'`
- `scip-query code scopedDefinitions`
- `scip-query code 'src/symbols/definition-catalog.ts:317-359'`
- `scip-query code getDefinitionsForFile`
- `scip-query code computeDefinitionsForFile`

2026-07-23 verification: the anchored `src/runtime/cli-support.ts:227-241`
reference names `DEFAULT_HEALTH_SEMANTIC_PREWARM_RUNTIME` and its bulk
candidate-definition path. The later health capability-disclosure change only
affects command rendering after the cached detector report is assembled.
The subsequent candidate-language correction also changes only rendering; the
anchored prewarm runtime remains at the cited lines with the same behavior.
The architecture-coherence change adds one zero-valued field to deferred drift
output later in the file and does not change prewarm selection or caching.

The repository already contains a set-oriented definition path:
`getScopedDefinitionsMatchingSymbols()` loads primary and fallback rows for the
scope, groups by file, applies `mergeMixedSymbolQueryRows()`, and corrects ranges
from source. It is the reuse target; this slice does not add a second catalog or
native helper.

## Alternatives

### 1. Instrument, then reuse the existing set-oriented catalog path

Add child spans around candidate loading, reference materialization, callee
materialization, and marker writing. If candidate loading owns the missing
time, expose a narrowly named bulk catalog entry point by extracting the
existing set-oriented implementation and use it only from semantic prewarm.

This is the selected approach. It tests the N+1 hypothesis with the smallest
reversible change and keeps the same TypeScript/SQLite boundary.

### 2. Parallelize the current per-file loader

Worker threads could split file loads, but each worker would need source and
SQLite access, duplicate cache state, and return tens of thousands of objects.
This preserves the repeated work and adds coordination overhead. It is rejected
unless set-oriented loading fails and a later profile isolates CPU-heavy range
correction that is safely partitionable by file.

### 3. Port definition loading directly to Rust

A Rust worker could decode rows and correct ranges in parallel, but the existing
one-shot native experiments show that small or partially prepared batches lose
their advantage at the JSON/process boundary. Rust remains a later option only
if this slice leaves a large contiguous, measured range-correction phase that
can cross a persistent or in-process boundary once.

## Architecture

The outer prewarm control flow remains unchanged:

1. Resolve project and semantic-engine fingerprints.
2. Read the complete prewarm marker.
3. Load semantic candidate definitions.
4. Materialize references while prefetching callees.
5. Materialize the complete callee map.
6. Write the marker only when reference materialization is complete.

The first implementation phase adds nested profile spans without changing this
flow. Each span records the definition count or result cardinality so the
unattributed time becomes a falsifiable measurement.

If candidate loading is dominant, `src/symbols/definition-catalog.ts` will gain
one bulk public entry point backed by the same private primary/fallback row
loaders, `mergeMixedSymbolQueryRows()`, `indexedDefinitionFromRow()`, and
`correctDefinitionRangesFromSource()`. The existing
`getScopedDefinitionsMatchingSymbols()` will share that implementation rather
than duplicating it. `src/runtime/cli-support.ts` will request the bulk set and
then apply the existing semantic-provider path predicate.

Per-file `getDefinitionsForFile()` and its durable file-evidence product remain
unchanged for all existing consumers. This confines the behavior and rollback
surface to health prewarm.

## Correctness and Failure Handling

The bulk and scalar catalog paths must return deeply equal ordered
`IndexedDefinition[]` values for the same scope. Equality includes symbol IDs,
symbols, paths, ranges, kinds, display names, documentation, enclosing symbols,
leaf names, parent types, and row order. Ignored paths, mixed primary/fallback
rows, Rust implementation range correction, and empty scopes must remain
identical.

The bulk path uses the existing synchronous database and source boundaries. A
query or source failure therefore follows the current command error behavior;
it does not silently drop definitions or mark the prewarm complete. No new
cache format, schema, environment flag, or fallback behavior is introduced.

The prewarm marker remains fail closed: unavailable provider results or
incomplete Rust references cannot produce a reusable marker.

## Test Strategy

Test first in `tests/symbols/definition-catalog.test.ts` with a mixed fixture
containing primary definitions, fallback-only definitions, ignored paths,
callable range corrections, and scoped paths. Assert exact deep equality
between the existing scalar catalog result and the proposed bulk result.

Extend `tests/runtime/cli-support.test.ts` only for observable prewarm ordering
and span metadata seams; keep its injected `HealthSemanticPrewarmRuntime` as the
side-effect boundary. The production profile smoke must show four nested spans
whose durations fit inside `health.semantic-prewarm` and whose cardinalities
match the outer result.

Corpus acceptance uses the existing evidence-cold harness on scip-query,
SynthRunnerRust, and VegaAssistant. External corpora must retain the accepted
stdout hashes, ordered reference/callee digests, row/fact counts, zero
incomplete Rust references, expected durable dispositions, and no worker
fallback.

## Performance Decision

The instrumentation is retained because it improves diagnosis without changing
behavior. The bulk path is accepted only if:

- Vega candidate loading is proven to own a material part of the missing time;
- warm Vega `health.semantic-prewarm` is at most 10 seconds;
- warm Vega `health --full --json` is at most 30 seconds;
- local and external correctness gates remain exact; and
- no other representative corpus regresses materially.

If the bulk path misses these gates, revert it, retain its measurements, and
select the new largest child span. Move to a Rust design only when that span is
a large contiguous CPU-bound phase rather than external compiler time, SQLite
write serialization, or repeated boundary crossings.

## Scope

This slice does not change cold language indexing, enable durable Rust routing
by default, add worker threads, change SQLite schema, alter detector budgets,
or create a Rust engine. It creates the evidence needed to decide whether the
next remaining phase belongs in a persistent native engine.

## Outcome

Completed on 2026-07-09. The hierarchical profiler was accepted and retained;
the set-oriented candidate route was rejected and reverted.

The decisive pre-change Vega response-cache-hit control measured 45.918s for
the full command and 26.055s for semantic prewarm. Its child spans accounted
for all but 40ms: candidate definitions took 13.837s, references 4.849s,
callees 7.329s, and marker writing 0ms. Candidate loading therefore passed the
5s experiment gate.

The proposed route preserved the exact accepted Vega output hash and all
38,222 reference and callee rows, but it did not make candidate loading faster.
The post-change Vega warm control measured 49.074s for the full command,
28.658s for prewarm, and 14.050s for candidate definitions. It missed both
performance gates and was reverted by commit `8b8dcdcf`.

The experiment disproved the N+1 SQL explanation. The existing scalar route
reads durable corrected-definition evidence per file, while the set-oriented
route reloads rows and repeats source-range correction per file; exchanging
those paths did not remove the dominant work. The next design should first
split candidate loading into evidence validation, evidence decoding, fallback
row loading, and source-range correction. A Rust boundary is not justified by
this result alone.

Machine-readable controls and absolute profile paths are recorded in
`docs/benchmarks/runs/2026-07-09-semantic-prewarm-bulk-load.jsonl`.
