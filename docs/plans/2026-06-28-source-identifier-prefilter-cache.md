# Source Identifier Prefilter Plan - 2026-06-28

## Goal

Reduce the cost of source-reference scans used by `dead`, health's dead phase,
and other source-fallback caller paths without changing which files pass the
prefilter or which references are attributed. Done means the Vega 2.0 dead
phase keeps the same output hash and the source prefilter no longer rebuilds
candidate-name metadata for every scanned file.

## Current State

- `sourceMayContainCandidateName()` in
  `src/source/source-identifier-prefilter.ts:4-26` accepts source text and a
  `ReadonlySet<string>` of candidate names. It returns `true` for an empty set
  or a set with no usable names, scans identifier tokens with
  `SOURCE_IDENTIFIER_RE`, and falls back to `source.includes()` for
  non-identifier candidate strings. Source:
  `scip-query trace sourceMayContainCandidateName`.
- The same function rebuilds `nonIdentifierNames` and recomputes
  `hasUsableCandidate` by iterating the whole candidate set on every call.
  Source: `scip-query trace sourceMayContainCandidateName`.
- `scanSourceReferences()` in
  `src/symbols/references/source-reference-scan.ts:44-97` calls
  `sourceMayContainCandidateName(getSourceText(db, sourceFile),
opts.candidateNames)` inside its per-source-file loop before loading
  identifier line maps. Source:
  `scip-query code 'src/symbols/references/source-reference-scan.ts:1-220'`.
- `findCallerFiles()` in
  `src/symbols/identifier-attribution.ts:206-244` builds
  `candidateLeafNames` once, then calls `sourceMayContainCandidateName()` for
  every source file. Source: `scip-query code findCallerFiles -C 18`.
- `dead()` in `src/queries/cleanup/dead.ts:87-151` reaches source scanning via
  `supplementDeadCodeOnlySourceReferences()` and
  `supplementReferencesFromAst()` after loading candidates and SCIP mention
  evidence. Source: `scip-query code dead -C 18`.
- Health's dead phase in `src/queries/health/health.ts:330-334` calls `dead()`
  with the shared health detector profile. That profile sets `deadCodeOnly:
true`, `skipBarrels: true`, and `semantic: false`. Sources:
  `scip-query code summarizeHealthDead -C 10` and
  `scip-query code HEALTH_DETECTOR_PROFILES -C 18`.

## Reuse Audit

- Reuse the existing `sourceMayContainCandidateName()` prefilter behavior rather
  than introducing a new scan. Source:
  `scip-query trace sourceMayContainCandidateName`.
- Similarity found generic set-overlap helpers such as `containment()`, but
  those compute ratios over existing sets and do not tokenize source text or
  handle non-identifier candidate strings. Source:
  `scip-query similar sourceMayContainCandidateName` and
  `scip-query code containment -C 8`.
- New helper justified: the missing abstraction is not set overlap; it is a
  precomputed view of one candidate-name set that preserves the existing token
  scan and non-identifier fallback semantics.

## Design Phases

### 1.1 - Add an explicit reusable matcher

- [x] **File**: `src/source/source-identifier-prefilter.ts:1-26`
- **Source**: `scip-query trace sourceMayContainCandidateName`.
- **What**: The function derives `nonIdentifierNames` and
  `hasUsableCandidate` inside every source-text check.
- **Change**: Add an exported `CandidateNameMatcher` interface and
  `createCandidateNameMatcher(candidateNames)`. The helper stores the original
  `ReadonlySet<string>`, a precomputed `nonIdentifierNames` array, and a
  `hasUsableCandidate` boolean.
- **Why**: Callers that scan many files with the same candidate set can compute
  candidate metadata once while preserving the current match behavior.

### 1.2 - Keep the existing function backward-compatible

- [x] **File**: `src/source/source-identifier-prefilter.ts:4-26`
- **Source**: `scip-query trace sourceMayContainCandidateName`.
- **What**: Existing consumers pass a `ReadonlySet<string>` directly.
- **Change**: Let `sourceMayContainCandidateName()` accept either a
  `ReadonlySet<string>` or a `CandidateNameMatcher`. If it receives a set, it
  creates a matcher internally and returns the same result as before.
- **Why**: Existing call sites and public internal API behavior remain valid.

### 1.3 - Reuse the matcher in source-reference scans

- [x] **File**: `src/symbols/references/source-reference-scan.ts:44-97`
- **Source**: `scip-query code 'src/symbols/references/source-reference-scan.ts:1-220'`.
- **What**: `scanSourceReferences()` checks the same `opts.candidateNames`
  against every source file and then checks exact name membership in `visitName`.
- **Change**: Build one matcher before the `for (const sourceFile of
opts.paths)` loop when `opts.candidateNames` exists; pass that matcher to
  `sourceMayContainCandidateName()` while keeping exact `opts.candidateNames.has`
  checks in `visitName`.
- **Why**: Removes repeated candidate metadata derivation without widening or
  narrowing attribution.

### 1.4 - Reuse the matcher in bulk caller attribution

- [x] **File**: `src/symbols/identifier-attribution.ts:206-244`
- **Source**: `scip-query code findCallerFiles -C 18`.
- **What**: `findCallerFiles()` builds `candidateLeafNames` once and then
  prefilters each source file with that same set.
- **Change**: Build one matcher from `candidateLeafNames` and pass it to
  `sourceMayContainCandidateName()` inside the file loop.
- **Why**: The dead-code source-fallback path uses this bulk caller scan; the
  same per-scan matcher removes repeated candidate-set work there too.

### 1.5 - Add focused tests

- [x] **File**: `tests/source/source-identifier-prefilter.test.ts`
- **Source**: `scip-query affected sourceMayContainCandidateName`.
- **What**: No focused test currently covers the prefilter helper directly.
- **Change**: Add Vitest coverage proving a matcher and the raw candidate set
  return the same result for empty sets, simple identifiers, absent
  identifiers, and non-identifier names.
- **Why**: The change is meant to preserve exact prefilter truth values.

## Stress-Test Findings

- Understanding: this is a pure prefilter optimization. A true result only
  permits downstream exact attribution; it does not itself record a reference.
  Sources: `scip-query code 'src/symbols/references/source-reference-scan.ts:1-220'`
  and `scip-query code findCallerFiles -C 18`.
- Blast radius: `sourceMayContainCandidateName()` affects
  `scanSourceReferences()` and `findCallerFiles()`, then flows into dead,
  isolated, stale-abstraction, and source-fallback consumer evidence. Source:
  `scip-query affected sourceMayContainCandidateName`.
- Reversibility: callers can return to passing the raw set and the helper can
  be removed without schema, CLI, or output-contract migration.
- Failure mode: a stale matcher would be wrong if a caller mutated its set
  after matcher creation. The edited call sites build the matcher after
  populating the set and do not mutate the set afterwards. Source:
  `scip-query code 'src/symbols/references/source-reference-scan.ts:1-220'`
  and `scip-query code findCallerFiles -C 18`.
- Concurrency: the matcher is local to one scan call, so it introduces no
  shared mutable state.
- User impact: no CLI options or JSON fields change; correctness is verified by
  output hashes and focused tests.

## Execution Order

1. Add matcher helper and backward-compatible function support.
2. Update the two scan call sites to build and reuse matchers.
3. Add focused tests.
4. Run targeted tests and Vega hash/timing checks for `__health-phase dead
--full`, `dead --json --full`, and `health --json`.
5. Reindex and run `scip-query diff-gate --json`.

## Ship Order

Single reversible internal optimization. No one-way doors.

## Verification

- `npm run typecheck`: passed.
- `npm test -- tests/source/source-identifier-prefilter.test.ts tests/source/source-backed-accuracy.test.ts tests/queries/cleanup/dead-output.test.ts tests/queries/cleanup/recent-duplicates-pruning.test.ts`:
  passed 13 tests.
- `npm run build`: passed.
- Vega_2.0 `scip-query __health-phase dead --full`: output stayed 189 bytes
  with SHA-256
  `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`.
- Vega_2.0 `scip-query dead --json --full`: output stayed 3,803,655 bytes
  with SHA-256
  `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`.
- Vega_2.0 `scip-query health --json`: output stayed 15,342 bytes with
  SHA-256
  `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`.
- Vega_2.0 `scip-query health --json --full`: output stayed 15,360 bytes with
  SHA-256
  `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff`.
- `scip-query reindex`: passed in 3.4s.
- `scip-query diff-impact --json`: changed seven source files and seventeen
  symbols in the current optimization worktree.
- `scip-query diff-gate --json`: passed with zero findings; the only emitted
  item was the already-accepted React/Vue cache echo suppression
  `SQ58DA50428777`.
- `scip-query recent-duplicates --json`: passed with zero findings.
- `scip-query stale-abstractions --json`: reported one unrelated
  `SemanticReferenceCacheEntry` single-consumer signal outside this change.

## Summary

Files changed:

- `src/source/source-identifier-prefilter.ts`
- `src/symbols/references/source-reference-scan.ts`
- `src/symbols/identifier-attribution.ts`
- `tests/source/source-identifier-prefilter.test.ts`
- `docs/benchmarks/2026-06-28-dead-full-ledger.md`
- `docs/benchmarks/2026-06-28-health-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
