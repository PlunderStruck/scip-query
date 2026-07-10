# Full-Pass Semantic Cache Bulk Read

Date: 2026-07-08

## Goal

Make full-mode analysis faster by replacing warm semantic cache reads that scale
with definition count with reads that scale with file count. The target corpus is
VegaAssistant, where `health --full` currently takes about 83s and the dominant
profile spans are semantic callee/reference cache scans with all or nearly all
entries already cached.

## Current State

`ProjectIndex.calleeMap()` delegates to `buildCalleeMap()`, which merges AST,
semantic, and SCIP chunk evidence. Source:
`node dist/cli.js code ProjectIndex.calleeMap -C 80`.

`cachedSemanticCalleeMap()` already avoids semantic provider startup on warm
runs, but it loops one definition at a time and calls
`readCachedSemanticCallees()` for each definition. Source:
`node dist/cli.js code cachedSemanticCalleeMap -C 120`.

`materializeSemanticReferenceBatch()` has the same shape for caller evidence:
one warm `readCachedSemanticReferences()` call per definition. Source:
`node dist/cli.js code materializeSemanticReferenceBatch -C 120`.

VegaAssistant full-pass baseline:

| Command                             | Runtime | Output hash  | Profile evidence                                                                 |
| ----------------------------------- | ------: | ------------ | -------------------------------------------------------------------------------- |
| `complexity-hotspots --json --full` |   34.2s | `f13288253854` | standalone profiled bench 28.0s; semantic cache scans about 10.5s + 10.4s        |
| `twin-drift --json --full`          |    4.0s | `a3612fbe3da7` | no semantic cache bottleneck                                                     |
| `similar --json --full`             |   57.6s | `c2649571d100` | health profile shows semantic callee cache scan 48.6s for 23,420 definitions     |
| `health --full --json`              |   83.0s | cached hash: `1bed3b9ffbe7` | profile spans: similar 50.2s, complexity 40.7s, extract 31.9s, wrappers 21.8s |

Run history:

- `docs/benchmarks/runs/2026-07-08-full-pass-optimization.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-health.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-complexity.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-twin.profile.jsonl`

## Reuse Audit

Reuse the existing `evidence.db` semantic cache tables instead of adding a new
project-level product in this slice. The hot path is warm cache lookup overhead,
not provider computation, so bulk table reads are the lowest-risk test of the
hypothesis.

Reuse the existing semantic cache key contract: current rows are matched by
`relative_path`, source content hash, dependency digest, project fingerprint,
and payload version; legacy package-version drift rows are still read through
the same storage boundary. The materializers do not need per-symbol fallback
after a successful file-level read because the file query covers the same
current and legacy keys as the single-row query.

Do not change command budgets, `--full` semantics, detector scoring, or semantic
provider behavior.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Read all current semantic callee rows for one file with one storage call | `readCachedSemanticCalleesForFile()` | temp `ScipDatabase`/`evidence.db` | map returned by symbol | SQLite statements | same payloads as single-row reads for matching content hash and deps digest |
| Read all current semantic reference rows for one file with one storage call | `readCachedSemanticReferencesForFile()` | temp `ScipDatabase`/`evidence.db` | map returned by symbol | SQLite statements | same payloads as single-row reads for matching project fingerprint |
| Use bulk reads during semantic materialization while preserving misses | `cachedSemanticCalleeMap()` and `materializeSemanticReferenceBatch()` | fixture DB plus existing semantic cache | grouping by file and symbol | cache read/provider fallback | output hashes match pre-change full-mode commands |

## Design Phases

### 1. Add bulk storage reads

- [x] **File**: `src/storage/evidence-cache.ts`
- **Source**: `rg -n "readCachedSemanticCallees|readCachedSemanticReferences" src/storage/evidence-cache.ts tests/storage/evidence-cache.test.ts`
- **What**: single-row readers are the only public read path for semantic callee/reference cache tables.
- **Change**: add `readCachedSemanticCalleesForFile()` and `readCachedSemanticReferencesForFile()` that return `Map<symbol, payload>` for current-version rows matching a file key.
- **Testability**: extend `tests/storage/evidence-cache.test.ts` to assert bulk reads match planted rows and ignore stale hash/fingerprint rows.
- **Validation**: `npm test -- tests/storage/evidence-cache.test.ts`.
- **Why**: this converts the dominant warm-cache path from thousands of SQLite statements to hundreds.

### 2. Use bulk reads in semantic materializers

- [x] **File**: `src/symbols/graph/call-graph-evidence.ts`
- **Source**: `node dist/cli.js code cachedSemanticCalleeMap -C 120`
- **What**: warm full-mode callee scans call the storage layer once per definition.
- **Change**: group definitions by file, compute the file key once, read all cached callee payloads for that file once, then fall back to the existing single-row reader only for rows missing from the bulk map.
- **Testability**: existing semantic/call-graph tests should keep output shape; Vega hash checks prove no full-mode output regression.
- **Validation**: targeted tests plus Vega `complexity-hotspots --json --full` and `similar --json --full` hashes.
- **Why**: `semantic.callees.cache-scan` is the largest measured warm full-mode cost.

### 3. Use bulk reads for semantic references

- [x] **File**: `src/semantic/shared-primitives.ts`
- **Source**: `node dist/cli.js code materializeSemanticReferenceBatch -C 120`
- **What**: warm full-mode caller/reference scans call the storage layer once per definition.
- **Change**: group definitions by file, compute the cache fingerprint once, bulk read references once per file, and fall back to single-row reads for missing rows.
- **Testability**: existing semantic reference tests plus Vega `complexity-hotspots --json --full` hash check.
- **Validation**: targeted tests plus full-mode command hashes.
- **Why**: complexity and wrappers both pay repeated reference scan cost in full health.

## Stress-Test Findings

Purpose: reduce warm full-pass overhead without changing semantic precision.

Blast radius: semantic callee/reference evidence feeds `similar`,
`complexity-hotspots`, `extract-candidates`, wrappers, passthroughs, dead,
isolated, diff-gate, and self-audit.

Valid intermediate state: storage bulk readers can land independently. The
semantic materializer changes are internal and can fall back to single-row
reads, so corrupt or legacy rows remain safe misses.

Failure: bulk readers must not return rows for stale file hashes, stale deps
digests, or different project fingerprints.

Concurrency: storage remains read-only for these paths; existing write
transactions are unchanged.

Human experience: no new flags or changed output. Full mode should simply feel
less punishing once caches are warm.

## Verification

- [x] `npm test -- tests/storage/evidence-cache.test.ts tests/semantic/rust/rust-semantic-cache-gate.test.ts tests/queries/quality/complexity-hotspots.test.ts tests/queries/cleanup/similar-topk.test.ts tests/queries/navigation/command-accuracy.test.ts`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] VegaAssistant hash/timing reruns for `complexity-hotspots --json --full`, `similar --json --full`, and `health --full --json`
- [x] `npm run lint`
- [x] `node dist/cli.js reindex`
- [x] `node dist/cli.js diff-gate --json`

## Results

Run history:

- `docs/benchmarks/runs/2026-07-08-full-pass-optimization.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-complexity-after-bulk-final-repeat.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-similar-after-bulk-final.profile.jsonl`
- `docs/benchmarks/runs/2026-07-08-full-pass-vega-health-after-bulk-final.profile.jsonl`

Final representative VegaAssistant results:

| Command | Baseline | Final | Delta | Hash |
| --- | ---: | ---: | ---: | --- |
| `complexity-hotspots --json --full` | 34.2s | 8.2s | 4.2x faster | `f13288253854` |
| `similar --json --full` | 57.6s | 2.7s | 21.5x faster | `c2649571d100` |
| `health --full --json` | 83.0s profiled uncached | 11.3s profiled uncached | 7.3x faster | `1bed3b9ffbe` |
| `twin-drift --json --full` | 4.0s | 4.0s | unchanged | `a3612fbe3da7` |

Profile deltas:

- `complexity-hotspots`: `semantic.callees.cache-scan` dropped from 10.5s to 1.0s, and `semantic.references.cache-scan` from 10.4s to 1.0s.
- `similar`: final full run spends 1.6s in `semantic.callees.cache-scan`, down from the 49.6s callee-map span seen inside baseline health.
- `health --full`: accumulated `semantic.callees.cache-scan` time dropped from 116.0s to 8.9s, and accumulated `semantic.references.cache-scan` time from 43.1s to 4.9s.

One final profiled standalone `complexity-hotspots` run took 24.6s with the same
hash immediately after rebuild. The repeat direct and profiled runs were 8.2s,
and the final health profile put its `complexity-hotspots` phase at 9.5s, so the
24.6s sample is recorded as an outlier rather than the representative result.
