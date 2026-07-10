# Full-Pass Optimization Ledger

Date: 2026-07-08

## Output Contract

Full mode is the command mode selected by `--full`; it means the command should
prefer complete project evidence over bounded shortcuts. A full-pass speedup is
valid only when command output bytes stay identical or when an approved accuracy
correction is documented.

Warm semantic cache reads are reads from `evidence.db` rows produced by earlier
semantic analysis. They are cache reads, not semantic recomputation: the real
objects are per-symbol callee/reference payloads stored next to the project
index and keyed by source fingerprints.

This slice preserves these output hashes on VegaAssistant:

| Command | Hash |
| --- | --- |
| `complexity-hotspots --json --full` | `f13288253854ec178fcdfa4bbecddd118d9667c68c7c598ea733a88d34b144a2` |
| `similar --json --full` | `c2649571d1004ce2c4765f745eac58151bc73b3ccf9ef3ae84335b049a8dd243` |
| `health --full --json` | `1bed3b9ffbe72061bf9bebd095da78abcde3e6b841bab0faee6617a9dd6fa81b` |
| `twin-drift --json --full` | `a3612fbe3da74a28dfafc9bcfb4090a096f458d762c9877fcb4e30c48245980f` |

## Target Selection

The representative corpus is VegaAssistant:
`/Users/aydansalois/Documents/GitHub/VegaAssistant`.

The starting profile showed full health dominated by already-cached semantic
callee/reference lookups. The expensive work was not launching TypeScript or
Rust semantic providers; it was issuing thousands of scalar SQLite reads for
rows that were already warm.

## Current Pipeline

`complexity-hotspots`, `similar`, and health phases ask the symbol graph for
semantic callees and references. Before this slice, each definition read its
semantic cache row independently. A file with many definitions therefore paid
one SQLite query per definition for callees and one per definition for
references.

The new pipeline groups definitions by source file, computes the same cache key
once per file, reads all matching rows for that file in one storage call, then
materializes misses using the existing semantic provider path.

## Run History

Machine-readable run history:
`docs/benchmarks/runs/2026-07-08-full-pass-optimization.jsonl`.

Profile files:

- `docs/benchmarks/runs/2026-07-08-full-pass-vega-health.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-complexity.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-twin.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-complexity-after-bulk-final-repeat.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-similar-after-bulk-final.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-health-after-bulk-final.profile.jsonl`

## Measurements

| Command | Baseline | Final representative | Change | Output |
| --- | ---: | ---: | ---: | --- |
| `complexity-hotspots --json --full` | 34.2s | 8.2s | 4.2x faster | identical |
| `similar --json --full` | 57.6s | 2.7s | 21.5x faster | identical |
| `health --full --json` | 83.0s uncached profiled | 11.3s uncached profiled | 7.3x faster | identical |
| `twin-drift --json --full` | 4.0s | 4.0s | unchanged | identical |

Final profile deltas:

| Span | Before | After | Note |
| --- | ---: | ---: | --- |
| `complexity` callee cache scan | 10.5s | 1.0s | standalone repeat profile |
| `complexity` reference cache scan | 10.4s | 1.0s | standalone repeat profile |
| `health` accumulated callee cache scan | 116.0s | 8.9s | six spans |
| `health` accumulated reference cache scan | 43.1s | 4.9s | four spans |
| `similar` callee-map path | 49.6s in baseline health | 1.9s standalone final | bulk callee map |

One final profiled `complexity-hotspots` sample took 24.6s with the same output
hash. The immediately repeated direct and profiled samples were 8.2s, and final
health measured its `complexity-hotspots` phase at 9.5s. Keep the outlier in the
run history, but use the repeat as the representative warm-cache result.

## Accepted Change

Add file-level semantic cache readers in `src/storage/evidence-cache.ts`:

- `readCachedSemanticCalleesForFile()`
- `readCachedSemanticReferencesForFile()`

Use them from:

- `src/symbols/graph/call-graph-evidence.ts`
- `src/semantic/shared-primitives.ts`

The storage readers include current `evidence-v1` rows plus legacy package
version drift rows. The materializers no longer perform per-symbol fallback
after a file-level read because both query shapes use the same cache keys.

## Decisions

- Do not change full-mode budgets or detector thresholds in this slice.
- Do not add project-level semantic products yet; the file-level batch read
  removed the dominant warm-cache N+1 cost with lower risk.
- Keep single-row storage readers because tests and direct storage consumers
  still use them, but do not use them inside the full-mode hot materializers.
- Continue toward durable LSP/session architecture later; this slice only
  improves cached semantic evidence retrieval.

## Next Bottlenecks

After this slice, VegaAssistant `health --full` is around 11s uncached. The next
visible costs are shared detector product reads and repeated full-health phase
orchestration:

- `consumer-evidence.product`
- `candidate-pipeline:wrapper-candidates`
- `candidate-pipeline:passthrough-candidates`
- `candidate-pipeline:extract-candidates`
- `evidence-product.file.read` across many repeated product calls

The next speed slice should reuse or prefetch shared evidence products across
health phases rather than making each detector re-read the same file products.
