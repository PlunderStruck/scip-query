# similar --full Hyper Optimization Plan

## Target

Apply the hyper-optimization workflow to `scip-query similar --json --full`,
using `/Users/aydansalois/Documents/GitHub/Vega_2.0` as the large benchmark
corpus. The first baseline to beat is `315.3s` from:

```sh
scip-query bench --json --command "similar --json --full" --timeout-ms 600000
```

## Output Contract

The command must keep returning the same `SimilarSymbolResult` JSON shape and
the same evidence meaning: ranked symbol pairs with weighted callee similarity,
shared evidence, unique callees, and evidence classification.

## Trace Evidence

- `scip-query plan-context src/queries/cleanup/similar.ts`
- `scip-query code similarAll -C 8`
- `scip-query code buildCalleeFingerprints -C 16`
- `scip-query code ProjectIndex:calleeMap -C 16`
- `scip-query code ProjectIndex:productionCallableDefinitions -C 16`
- `scip-query call-graph weightedCosine`

Current flow:

1. `similarAll` calls `getCalleeFingerprintIndex`.
2. `getCalleeFingerprintIndex` memoizes `buildCalleeFingerprintIndex`.
3. `buildCalleeFingerprintIndex` computes corpus-wide document frequency, IDF
   weights, median IDF, and a non-ubiquitous callee candidate index.
4. `similarAll` loops each fingerprint, gathers candidate pair indexes, applies
   file and parameter-count filters, then calls `comparePair`.
5. `comparePair` calls `weightedCosine`, which recomputes weighted magnitudes
   from both callee sets for every candidate pair.

## First Optimization Batch

Weighted magnitude means the length of one symbol's IDF-weighted callee vector;
it is a per-symbol number derived from that symbol's callee set and the
corpus-wide IDF weights. Because it depends only on one fingerprint and the
index weights, not on the other side of a pair, recomputing it per pair is
avoidable.

- [x] Add a reusable `weightedMagnitude` helper to the similarity math kernel.
- [x] Add a `weightedCosineWithMagnitudes` helper that uses precomputed
      magnitudes while preserving `weightedCosine` output semantics.
- [x] Store per-corpus magnitudes in `CalleeFingerprintIndex`.
- [x] Pass the precomputed pair magnitudes from `similarAll` into `comparePair`.
- [x] Add unit coverage proving the optimized cosine path matches the existing
      path.
- [x] Compare JSON output size parity from the benchmark and exact optimized
      scorer equivalence in unit tests.
- [x] Rerun the Vega focused benchmark and update the ledger.

## Deferred Alternatives

- Precompute callee fingerprints during indexing.
- Push candidate pair aggregation into SQLite.
- Add an exact upper-bound rejection stage before full result construction.
