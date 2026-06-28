# Diff Gate Echo IDF Plan - 2026-06-28

## Goal

Speed up `scip-query diff-gate --json` by reducing repeated work in the echo
check while preserving the exact JSON output, finding IDs, similarity scores,
and exit behavior. Done means Vega 2.0 `diff-gate --json` keeps the
3,089-byte output hash
`4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` and the
full gate runtime improves from the current 3.097s-4.555s warm band.

## Current State

- `diffGate()` in `src/queries/impact/diff-gate.ts:160-246` computes a diff
  impact plan, changed files, base-content reader, and base preexistence
  checker, then runs `echo`, `incomplete-migration`, `co-change-partner`,
  `doc-reference`, `unused-params`, and `new-dead` checks serially. Source:
  `scip-query plan-context diffGate`.
- Vega 2.0 currently has four changed files and eight changed symbols for the
  benchmark diff. Source: `scip-query diff-impact --json` in
  `/Users/aydansalois/Documents/GitHub/Vega_2.0`.
- Vega 2.0 `diff-gate --json` exits 1 with one finding, one root-cause group,
  checks `["echo","incomplete-migration","co-change-partner","doc-reference","unused-params","new-dead"]`,
  3,089 stdout bytes, and SHA-256
  `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.
  Source: pre-plan hash probe.
- Skip probes show the base diff-gate setup with all checks skipped is 0.416s,
  echo-only is 2.723s, and incomplete-migration-only is 1.548s. Source:
  `scip-query bench --json` skip matrix in Vega 2.0.
- `runEchoCheck()` in `src/queries/impact/diff-gate.ts:351-412` pushes the
  `echo` check name, loops over new changed symbols, calls
  `similar(db, changedSymbol.symbol, { minSimilarity, limit: 5, scanLimit, semantic })`,
  drops matches where the other file is also changed, and records one finding
  from eligible matches. Source: `scip-query code runEchoCheck -C 8`.
- `similar()` in `src/queries/cleanup/similar.ts:73-90` resolves the target
  symbol, calls `compareAgainstFingerprints()`, returns its top results, and
  falls back to source-shape similarity only if no callee-fingerprint results
  exist. Source: `scip-query code similar -C 8`.
- `compareAgainstFingerprints()` in
  `src/queries/cleanup/similar.ts:92-120` builds or gets the callee
  fingerprint index, finds candidate fingerprints, recomputes IDF with
  `computeIdf([target, ...index.corpus].map((fp) => fp.callees))`, computes the
  median, then compares each candidate with `comparePair()`. Source:
  `scip-query plan-context compareAgainstFingerprints`.
- `buildCalleeFingerprintIndex()` in
  `src/queries/cleanup/similar.ts:403-433` already computes `docFreq`,
  corpus-level `idfWeights`, `weightedMagnitudes`, and `medianIdf` for the same
  corpus. Source: `scip-query plan-context buildCalleeFingerprintIndex`.
- `comparePair()` in `src/queries/cleanup/similar.ts:132-172` already accepts
  optional `magnitudeA` and `magnitudeB`; when both are present it uses
  `weightedCosineWithMagnitudes()` instead of recomputing magnitudes inside
  `weightedCosine()`. Source: `scip-query trace comparePair`.

## Reuse Audit

- Reuse `computeIdfFromDocFreq()` from `src/analysis/similarity.ts` rather than
  keeping the broader `computeIdf()` corpus walk. The target-specific document
  frequencies can be derived from `index.docFreq` plus one count for each
  target callee, with document count `index.corpus.length + 1`, which is the
  same document set as `computeIdf([target, ...index.corpus])`. Sources:
  `scip-query plan-context compareAgainstFingerprints` and
  `scip-query plan-context buildCalleeFingerprintIndex`.
- Reuse `weightedMagnitude()` and `weightedCosineWithMagnitudes()` already
  imported by `src/queries/cleanup/similar.ts`. Source:
  `scip-query trace comparePair`.
- No new public CLI option, schema, cache, or exported API is needed. The new
  helper can stay private to `src/queries/cleanup/similar.ts` if introduced.

## Design Phases

### 1.1 - Derive target-specific IDF from indexed document frequencies

- [x] **File**: `src/queries/cleanup/similar.ts:92-120`
- **Source**: `scip-query plan-context compareAgainstFingerprints`.
- **What**: `compareAgainstFingerprints()` recomputes IDF by mapping the target
  and every corpus fingerprint back to callee sets, then calling
  `computeIdf()`.
- **Change**: Replace that full corpus walk with a private helper that clones
  `index.docFreq`, increments every target callee once, and calls
  `computeIdfFromDocFreq(docFreq, index.corpus.length + 1)`.
- **Why**: This preserves the exact target-plus-corpus IDF semantics while
  avoiding an O(corpus features) pass for every echo target.

### 1.2 - Reuse target and candidate magnitudes in target similarity

- [x] **File**: `src/queries/cleanup/similar.ts:107-117`
- **Source**: `scip-query trace comparePair`.
- **What**: `compareAgainstFingerprints()` currently calls `comparePair()`
  without magnitudes, so `weightedCosine()` recomputes the target magnitude for
  every candidate.
- **Change**: Compute `targetMagnitude = weightedMagnitude(target.callees,
idfWeights)` once. For each candidate, compute `candidateMagnitude =
weightedMagnitude(candidate.callees, idfWeights)` once and pass both magnitudes
  to `comparePair()`.
- **Why**: The optional magnitude path already exists and preserves
  `weightedCosine()` results when the same IDF map is used.

### 1.3 - Add exactness tests for target IDF derivation

- [x] **File**: relevant existing similarity tests
- **Source**: `scip-query plan-context compareAgainstFingerprints` and
  `scip-query plan-context buildCalleeFingerprintIndex`.
- **What**: The important invariant is that the derived IDF map exactly matches
  `computeIdf([target, ...corpus].map((fp) => fp.callees))`.
- **Change**: Add a focused test around the new private helper if it is
  exported for tests, or cover it through public `similar()`/`similarAll()`
  output hash checks if keeping it private is cleaner.
- **Why**: The speedup is only safe if score semantics are unchanged.

### 1.4 - Record diff-gate benchmark evidence

- [x] **File**: `docs/benchmarks/2026-06-28-diff-gate-ledger.md`
- **Source**: `scip-query plan-context diffGate`.
- **What**: No dedicated diff-gate optimization ledger exists yet.
- **Change**: Add output contract, skip-matrix baseline, accepted/rejected
  decision, before/after timing, hash comparison, and remaining bottlenecks.
- **Why**: The hyper-optimization workflow requires the measurement and
  decision to be written down.

### 2.1 - Reuse the cached callee fingerprint index in incomplete migration

- [x] **File**: `src/queries/impact/incomplete-migration.ts:139-140`
- **Source**: `scip-query plan-context incompleteMigration`.
- **What**: `incompleteMigration()` gets cached callee fingerprints, then calls
  `buildCalleeFingerprintIndex(candidates)` locally on every run.
- **Change**: Export `getCalleeFingerprintIndex()` from
  `src/queries/cleanup/similar.ts:380-400` and call it directly with the same
  `minCallees`, `scanLimit`, and `semantic` options.
- **Why**: The accessor already caches the exact same index per database and
  options. A full `diff-gate` echo check often builds this index first, so
  incomplete-migration can reuse it instead of rebuilding.

## Stress-Test Findings

- Understanding: this pass changes callee-similarity scoring setup only; it
  does not change diff-gate check ordering, skip behavior, finding formatting,
  suppression handling, source-shape fallback, or pair classification. Sources:
  `scip-query plan-context diffGate`, `scip-query code runEchoCheck -C 8`, and
  `scip-query code similar -C 8`.
- Incomplete-migration index reuse keeps the same candidate set because
  `getCalleeFingerprintIndex()` builds from `getAllCalleeFingerprints()` with
  the same `minCallees`, `scanLimit`, and `semantic` key. Sources:
  `scip-query code incompleteMigration -C 10` and
  `scip-query code getCalleeFingerprintIndex -C 10`.
- Blast radius: `compareAgainstFingerprints()` affects `similar()`, which feeds
  diff-gate echo findings. Source: `scip-query affected
compareAgainstFingerprints`.
- Exactness risk: using the corpus-level `index.idfWeights` directly would not
  be equivalent because the current target path adds the target as an extra IDF
  document. The plan avoids that by deriving a target-specific doc-frequency
  map from `index.docFreq`.
- Reversibility: the helper and magnitude arguments can be removed to restore
  the current `computeIdf()` path.
- Concurrency/data integrity: no shared mutable state changes; the derived map
  is local to one `similar()` call.

## Execution Order

1. Update `compareAgainstFingerprints()` to derive exact target-specific IDF
   from `index.docFreq`.
2. Pass precomputed target/candidate magnitudes to `comparePair()`.
3. Export and reuse `getCalleeFingerprintIndex()` in incomplete-migration.
4. Add or adjust focused tests.
5. Run targeted tests, typecheck, and build.
6. Compare Vega `diff-gate --json` hash/timing plus echo-only and
   incomplete-migration-only skip probes.
7. Update the diff-gate ledger and scoreboard if accepted.
8. Reindex if stale, then run `scip-query diff-impact --json` and
   `scip-query diff-gate --json`.

## Ship Order

Single reversible internal optimization. No migration or one-way door.

## Summary

Files changed:

- `src/queries/cleanup/similar.ts`
- `src/queries/impact/incomplete-migration.ts`
- `tests/queries/cleanup/similar-topk.test.ts`
- `docs/benchmarks/2026-06-28-diff-gate-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`

Verification completed:

- Focused tests passed: 58 tests across similarity, similar top-k,
  incomplete-migration, and recent-duplicates pruning.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: passed 77 files / 422 tests.
- Vega `diff-gate --json` kept the same 3,089-byte output hash
  `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.
  Latest warm repeats: 3.123s, 3.036s, 3.053s.
- `scip-query reindex` left the index fresh.
- `scip-query diff-gate --json` passed with zero findings after doc-reference
  validation notes were refreshed.
