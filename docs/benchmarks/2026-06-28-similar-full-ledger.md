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
  Source: `scip-query code 'src/queries/cleanup/similar.ts:428-457'`.
- 2026-06-28 focus-pruning refresh: `similarAll()` can now accept an internal
  focus-file set so `recent-duplicates --full` skips old-old pairs that cannot
  become findings. Direct `similar --full` output remains unchanged because the
  public command does not pass that option.
- 2026-06-28 bounded source-fallback refresh: targeted `similar()` now passes
  its scan limit into the lexical source-shape fallback. Bounded callers such as
  diff-gate echo use a bounded source-fingerprint corpus, while unbounded
  `similar --json --full` still builds the complete corpus.
- 2026-06-28 source-fingerprint evidence refresh: targeted source-shape
  fallback now persists per-file source-token fingerprints behind source bytes
  and callable-range keys. This preserves the same source-token comparison
  contract while avoiding repeated corpus tokenization across fresh CLI
  processes.
- 2026-06-28 bench sub-profiling refresh: `bench --profile` can now run any
  command with JSONL phase spans. `similarAll` reports callee fingerprint
  resolution, corpus building, callee-index construction, pair scanning, and
  sort/project phases.
- 2026-06-28 cold semantic-callee refresh: TypeScript semantic callee
  resolution now batches definitions by provider, preloads indexed TypeScript
  source files into the ts-morph projects before checker creation, reuses the
  TypeScript compiler checker per project, and traverses raw compiler AST nodes
  instead of wrapping every descendant in ts-morph nodes.
- `comparePair` computes weighted cosine similarity, drops weak pairs, shortens
  symbols, computes unique callee sets, and classifies evidence.
  Source: `scip-query code comparePair -C 8`.

## Measurements

| Case                                                               |                           Before |            After |                 Delta | Evidence                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------: | ---------------: | --------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 full-suite `similar --json --full`                        |                           300.7s |          pending |               pending | `docs/validation/2026-06-28-vega-2-heavy-benchmark-result.md`                                                                                                                            |
| Vega_2.0 focused warm `similar --json --full`                      |                           315.3s |           2.160s | -313.2s / 146x faster | `scip-query bench --json --command "similar --json --full" --timeout-ms 600000`; stdout 88,859 bytes before and after                                                                    |
| Vega_2.0 focused warm `similar --json --full` confirmation         |                           315.3s |           1.503s | -313.8s / 210x faster | Same command rerun; stdout 88,859 bytes                                                                                                                                                  |
| Vega_2.0 refreshed heavy matrix `similar --json --full`            |                           300.7s |           1.443s | -299.3s / 208x faster | `scip-query bench --json --include-heavy --timeout-ms 600000`; stdout 88,859 bytes                                                                                                       |
| Vega_2.0 after `0.10.9` package bump, package-versioned cache miss |             1.5s warm-cache band | >30s before kill |            regression | Local `dist/cli.js` rebuilt at `0.10.9`; process reached multi-GB RSS because semantic rows existed under `0.10.8` only                                                                  |
| Vega_2.0 stable evidence cache version                             | >30s miss / 1.5s warm-cache band |           2.169s |    restores warm path | `node dist/cli.js bench --json --command "similar --json --full"`; stdout 88,859 bytes; SHA-256 `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf`                       |
| Vega_2.0 focused bench sub-profile                                 |                     300.7s heavy |           2.047s | -298.7s / 147x faster | `node dist/cli.js bench --json --command "similar --json --full" --profile --profile-out /tmp/scip-query-vega-similar-profile.jsonl --progress --timeout-ms 600000`; stdout 88,859 bytes |
| Vega_2.0 focused unprofiled control                                |                     300.7s heavy |           1.054s | -299.6s / 285x faster | Same focused command without `--profile`; active Vega index was stale but present, 104,090 symbols, 1,779 indexed files                                                                  |

### Cold Semantic-Callee Rebuild Control

These runs delete only Vega's `semantic_callees` evidence rows before the cold
case. The SCIP index itself stays present, so this isolates the slow path users
hit when a command must derive missing semantic callee evidence before
answering.

| Case                                                      |   Before |   After | Delta                    | Evidence                                                                                                                                                               |
| --------------------------------------------------------- | -------: | ------: | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 cold `similar --json --full`, profiled           | 291.197s | 13.628s | -277.569s / 21.4x faster | `/tmp/scip-query-vega-similar-cold-profile.jsonl` -> `/tmp/scip-query-vega-similar-cold-profile-after-checker-cache-no-prefilter.jsonl`; stdout 88,859 bytes both runs |
| Vega_2.0 cold `similar --json --full`, unprofiled control | 298.781s | 12.047s | -286.734s / 24.8x faster | `/tmp/scip-query-vega-similar-cold-unprofiled-bench.json` -> `/tmp/scip-query-vega-similar-cold-unprofiled-after-checker-cache-no-prefilter-bench.json`                |
| Vega_2.0 warm `similar --json --full`, unprofiled control |   1.658s |  1.037s | -0.621s / 1.6x faster    | `/tmp/scip-query-vega-similar-warm-unprofiled-bench.json` -> `/tmp/scip-query-vega-similar-warm-unprofiled-after-checker-cache-no-prefilter-bench.json`                |
| Vega_2.0 warm `similar --json --full`, profiled           |   0.984s |  1.004s | neutral diagnostic cost  | `/tmp/scip-query-vega-similar-warm-profiled-bench.json` -> `/tmp/scip-query-vega-similar-warm-profiled-after-checker-cache-no-prefilter-bench.json`                    |

Output contract evidence: the accepted cold/warm runs still emit 88,859 bytes,
SHA-256
`59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf`,
`corpusSize: 922`, `insertedResults: 42`, and `candidateCount: 5920`.

Cold profile after the accepted optimization:

- `similar.all`: 13.373s.
- `similar.callee-fingerprints.callee-map`: 12.888s.
- `semantic.callees.provider-loop`: 11.977s for 5,915 definitions.
- `semantic.callees.cache-scan`: 318ms; `semantic.callees.cache-write`: 26ms.
- 1,111 TypeScript source files traversed in 7.319s total file span time:
  source-file lookup 539ms, cached checker lookup 1.688s, raw traversal
  5.082s, expression symbol lookup 4.700s, target lookup 45ms.

The decisive pre-fix diagnostic was the path-indexed but uncached-checker run:
`checkerLookupMs` alone consumed 188.862s of 197.840s total file span time.
That proved the 300s cold wait was repeated TypeScript checker access during
semantic callee extraction, not profile bookkeeping, SQLite cache writes, or
the final pair scan.

## Current-Pipeline Optimization Candidates

- Continue reducing cold semantic callee construction. The accepted cold profile
  now spends most remaining time in raw TypeScript traversal and expression
  symbol lookup; the final `similar.all.pair-scan` is only 10ms.
- Continue reducing warm cache-row shaping. The accepted warm profile measured
  `semantic.callees.cache-scan` at 271ms and callee fingerprint map assembly at
  674ms.
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
- Accepted: persist source-token fingerprints for targeted source-shape
  fallback. The cache key combines the source file content hash with
  symbol/start/end/leaf definition identity, so changed source bytes or changed
  callable ranges rebuild tokens. Vega targeted `similar` probes and
  `diff-gate` stayed byte-identical.
- Accepted: batch semantic callee resolution by provider and let TypeScript
  resolve all requested definitions file-by-file in one pass. This keeps the
  exact semantic callee output while removing scalar provider dispatch overhead.
- Accepted: preload indexed TypeScript source files into the ts-morph project
  before creating a compiler checker, then cache the raw TypeScript checker per
  project. This removed the repeated checker path that consumed 188.862s in the
  cold profile.
- Accepted: traverse raw TypeScript compiler AST nodes for callee extraction
  instead of creating ts-morph wrapper nodes for every descendant. This keeps
  the same checker-backed symbol resolution while cutting the remaining
  traversal cost into the low-second range.
- Rejected: a provider-local `definitionFromSymbol` cache. It passed focused
  tests but did not make the Vega semantic callee-map phase complete within the
  30s diagnostic window, so the source change was reverted.
- Rejected: a syntactic `minCallees` prefilter before semantic callee
  extraction. It reduced the cold run to roughly 12.5s but changed the
  full-command corpus from 922 to 912 and changed the emitted JSON size from
  88,859 to 88,858 bytes, so it violated the output contract.
- Deferred: persistent index-time fingerprint tables are promising but larger
  than the first optimization batch; first measure where the current 300s is
  spent.

## 2026-06-28 Non-Function Target Follow-Up

The callee fingerprint index contract above is unchanged. `similar()` now
returns before constructing `ProjectIndex` or reading callee rows when the
matched target is not function-like, preserving the same empty-result behavior
for type/interface/module-like targets while avoiding wasted setup.

## 2026-06-28 Bounded Source-Fallback Follow-Up

The `similar --full` contract remains unchanged. The source-shape fallback now
uses the same scan-limit budget as callee fingerprints for bounded callers, but
the public unbounded `similar --json --full` command still uses the complete
source-fingerprint corpus.

## 2026-06-28 Source-Fingerprint Evidence Follow-Up

The source-shape similarity contract remains unchanged. Targeted `similar()`
now reads cached source-token fingerprints when the source bytes and
symbol/start/end/leaf definition key match; stale or missing rows fall back to
the same `definitionSnippet()` plus `sourceTokens()` path documented above.

## 2026-06-28 Zero-Callee Target Follow-Up

The `similar --json --full` contract remains unchanged. The latest
`similar.ts` edit only skips callee-index construction for targeted symbols
with zero meaningful callees, then uses the same source-shape fallback already
documented above. Source-fingerprint cache hits also avoid splitting source
lines until a token row is missing; stale or missing rows still rebuild through
the same snippet and token pipeline.

## 2026-06-30 Evidence Product Follow-Up

The `src/queries/cleanup/similar.ts` full-scan notes remain accurate after the
file evidence product registry migration. The source-fingerprint cache still
stores the same serialized token entries behind the file content hash; only the
persistent read/write plumbing moved to `src/storage/evidence-products.ts`.

## 2026-06-30 Health Cleanup Follow-Up

The `src/queries/cleanup/similar.ts` full-scan notes remain accurate after the
health cleanup. The new suppression comments classify accepted signal-tier
parallelism; tokenization, IDF inputs, pair scoring, and persistent
source-fingerprint payloads are unchanged.

2026-07-01 round-2 remediation note: the `src/queries/cleanup/similar.ts` and
cleanup handler guide references remain current after `similar --plan` folded
the convergence preview into the weighted-cosine path. This ledger still
describes the same full-scan implementation family and command surface.
