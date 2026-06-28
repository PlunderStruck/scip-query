# similar --full Optimization Ledger

## Output Contract

- Target command: `scip-query similar --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: return the same JSON envelope shape for the `similar`
  command and preserve the ranked `SimilarSymbolResult` contract:
  `symbolA`, `shortNameA`, `fileA`, `symbolB`, `shortNameB`, `fileB`,
  `similarity`, `similarityBasis`, `sharedCallees`, `uniqueToA`, `uniqueToB`,
  and evidence classification fields.
- Correctness checks: focused unit tests for similarity behavior, output
  identity checks on representative repositories, and `scip-query diff-gate`.

## Current Pipeline

- Entry point: cleanup query command handlers call `queries.similar` or
  `queries.similarAll` for the public `similar` command and health/detector
  consumers.
  Source: `scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:1-220'`.
- `similarAll` builds a callee fingerprint index with
  `getCalleeFingerprintIndex`, iterates every fingerprint, gathers candidate
  pairs from shared non-ubiquitous callees, filters parameter-count mismatches,
  scores pairs with `comparePair`, and keeps the top results with
  `insertTopSimilarResult`.
  Source: `scip-query code similarAll -C 8`.
- `buildCalleeFingerprints` creates a `ProjectIndex`, loads production callable
  definitions, builds a callee map for those definitions, converts each
  callable into a callee-set fingerprint, reads callable signature parameter
  counts, and filters fingerprints below `minCallees`.
  Source: `scip-query code buildCalleeFingerprints -C 8`.
- `buildCalleeFingerprintIndex` computes callee document frequencies, IDF
  weights, a ubiquity threshold, a callee-to-fingerprint index, cached weighted
  magnitudes, and median IDF.
  Source: `scip-query code 'src/queries/cleanup/similar.ts:424-454'`.
- 2026-06-28 focus-pruning refresh: `similarAll()` can now accept an internal
  focus-file set so `recent-duplicates --full` skips old-old pairs that cannot
  become findings. Direct `similar --full` output remains unchanged because the
  public command does not pass that option.
- `comparePair` computes weighted cosine similarity, drops weak pairs, shortens
  symbols, computes unique callee sets, and classifies evidence.
  Source: `scip-query code comparePair -C 8`.

## Measurements

| Case                                                               |                           Before |            After |                 Delta | Evidence                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------: | ---------------: | --------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vega_2.0 full-suite `similar --json --full`                        |                           300.7s |          pending |               pending | `docs/validation/2026-06-28-vega-2-heavy-benchmark-result.md`                                                                                                      |
| Vega_2.0 focused warm `similar --json --full`                      |                           315.3s |           2.160s | -313.2s / 146x faster | `scip-query bench --json --command "similar --json --full" --timeout-ms 600000`; stdout 88,859 bytes before and after                                              |
| Vega_2.0 focused warm `similar --json --full` confirmation         |                           315.3s |           1.503s | -313.8s / 210x faster | Same command rerun; stdout 88,859 bytes                                                                                                                            |
| Vega_2.0 refreshed heavy matrix `similar --json --full`            |                           300.7s |           1.443s | -299.3s / 208x faster | `scip-query bench --json --include-heavy --timeout-ms 600000`; stdout 88,859 bytes                                                                                 |
| Vega_2.0 after `0.10.9` package bump, package-versioned cache miss |             1.5s warm-cache band | >30s before kill |            regression | Local `dist/cli.js` rebuilt at `0.10.9`; process reached multi-GB RSS because semantic rows existed under `0.10.8` only                                            |
| Vega_2.0 stable evidence cache version                             | >30s miss / 1.5s warm-cache band |           2.169s |    restores warm path | `node dist/cli.js bench --json --command "similar --json --full"`; stdout 88,859 bytes; SHA-256 `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |

## Current-Pipeline Optimization Candidates

- Separate corpus-build time from pair-scoring time before editing. The code
  comment at `CALLEE_FINGERPRINT_CORPUS` says fingerprint construction is the
  dominant cost, but the Vega runtime requires measurement before accepting
  that as the current bottleneck.
- Reduce repeated pair work inside `similarAll` by caching per-fingerprint
  magnitudes, weighted feature data, or shared-candidate scores if profiling
  shows pair scoring dominates.
- Reduce corpus construction cost by batching signature lookup or avoiding
  per-definition work that can be derived while building the callee map.
- Preserve the existing candidate-index pruning semantics unless output
  identity checks prove a stricter pruning rule is equivalent.

## Alternative Designs

- Precompute callee fingerprints during indexing or post-index augmentation so
  `similar --full` reads a compact SQLite-backed feature table instead of
  reconstructing fingerprints per process.
- Push more candidate generation into SQLite using symbol/callee edge tables
  and aggregate shared-callee counts before JS scoring.
- Use a two-stage retrieval model: cheap shared-callee count or weighted upper
  bound first, exact weighted cosine only for candidate pairs that can still
  reach `minSimilarity`.

## Decisions

- Accepted: precompute each fingerprint's weighted magnitude once in the callee
  fingerprint index, then pass those magnitudes into the exact same weighted
  cosine calculation during `similarAll` pair scoring. This preserves the
  existing candidate generation and scoring formula while avoiding repeated
  vector-length work per candidate pair.
- Accepted: replace package-version evidence-cache reads with a stable payload
  contract version plus compatible fallback reads keyed by content hash,
  dependency digest, or project fingerprint. This restored Vega's existing
  `0.10.8` semantic callee cache after the `0.10.9` package bump without
  changing the `similar --json --full` output hash.
- Rejected: a provider-local `definitionFromSymbol` cache. It passed focused
  tests but did not make the Vega semantic callee-map phase complete within the
  30s diagnostic window, so the source change was reverted.
- Deferred: persistent index-time fingerprint tables are promising but larger
  than the first optimization batch; first measure where the current 300s is
  spent.
## 2026-06-28 Non-Function Target Follow-Up

The callee fingerprint index contract above is unchanged. `similar()` now
returns before constructing `ProjectIndex` or reading callee rows when the
matched target is not function-like, preserving the same empty-result behavior
for type/interface/module-like targets while avoiding wasted setup.
