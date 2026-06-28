# Bulk Caller Source Prefilter Plan — 2026-06-28

## Goal

Reduce detector time in `wrapper-candidates`, `stale-abstractions`, and other consumer-evidence commands without changing what counts as a reference. Done means the bulk caller-file source fallback skips source files whose raw text cannot contain any candidate leaf before it asks `getFileIdentifiers` to parse/source-fact the file.

## Current State

`src/symbols/identifier-attribution.ts:205-241` builds `candidateLeaves`, then loops every `getSourceFiles(db)` entry and calls `getFileIdentifiers(db, file)` before checking whether that file has any candidate leaf. Source: `scip-query plan-context findCallerFiles`.

`src/symbols/identifier-index.ts:80-91` shows `getFileIdentifiers` either returns persisted source facts or derives identifiers from `getIdentifierLineMap`, which is parser-backed fallback work when source facts are missing or insufficient. Source: `scip-query plan-context getFileIdentifiers`.

`src/symbols/identifier-attribution.ts:138-192` already gates single-symbol `findReferences` with `getSourceText(db, file)` and `source.indexOf(identifier) === -1` before attribution. Source: `scip-query code findReferences -C 8`.

`src/symbols/references/source-reference-scan.ts:101-123` already has an accuracy-preserving raw-source candidate-name prefilter, and `src/symbols/references/source-reference-scan.ts:61` uses it before identifier-map construction. Source: `scip-query plan-context sourceMayContainCandidateName`.

`src/source/source-text.ts:20-31` provides cached source text reads and returns an empty string for missing files. Source: `scip-query plan-context getSourceText`.

Profiling `wrapper-candidates --json` on Stable_Management showed tree-sitter parsing and Vue SFC parsing as top samples. The bulk caller fallback is a direct route to that parser work. Source: CPU profile `/tmp/scip-wrapper-stable.cpuprofile`.

## Reuse Audit

Reuse the existing raw-source prefilter behavior from `sourceMayContainCandidateName`; do not create a second tokenizer policy in `identifier-attribution.ts`. Source: `scip-query plan-context sourceMayContainCandidateName`.

Move the helper into a source-layer module so `source-reference-scan.ts` and `identifier-attribution.ts` can both import it without introducing a cycle. `source-reference-scan.ts` currently imports `attributeIdentifier` from `identifier-attribution.ts`, so importing `source-reference-scan.ts` back from `identifier-attribution.ts` would be cyclic. Source: `scip-query plan-context sourceMayContainCandidateName`; `scip-query plan-context findCallerFiles`.

No structurally similar source-reference module exists to reuse. Source: `scip-query similar-files src/symbols/references/source-reference-scan.ts --json` returned no rows; `scip-query similar sourceMayContainCandidateName --json --full` returned no rows.

## Design Phases

### 1.1 — Extract the Candidate-Name Text Gate

- [x] **File**: `src/symbols/references/source-reference-scan.ts:101-123`
- **Source**: `scip-query plan-context sourceMayContainCandidateName`
- **What**: `sourceMayContainCandidateName` and its regex constants live in `source-reference-scan.ts`.
- **Change**: Move that helper and its constants into a new source-layer module, `src/source/source-identifier-prefilter.ts`, then import it back into `source-reference-scan.ts`.
- **Why**: The helper becomes reusable by source attribution without a circular dependency.

### 1.2 — Gate Bulk Caller Source Fallback Before Parsing

- [x] **File**: `src/symbols/identifier-attribution.ts:221-223`
- **Source**: `scip-query plan-context findCallerFiles`; `scip-query plan-context getSourceText`; `scip-query plan-context getFileIdentifiers`
- **What**: `findCallerFiles` asks every source file for identifiers before testing candidate leaves.
- **Change**: Build a `Set` from `candidateLeaves.keys()`. For each source file, call `sourceMayContainCandidateName(getSourceText(db, file), candidateLeafNames)` before `getFileIdentifiers`; skip the file when false.
- **Why**: A file cannot attribute a candidate leaf if its raw text lacks every candidate leaf. This avoids parser/source-fact work for known-impossible files.

### 1.3 — Keep Existing Prefilter Tests, Add Bulk Caller Coverage

- [x] **File**: `tests/symbols/source-reference-scan.test.ts`
- **Source**: `scip-query plan-context sourceMayContainCandidateName`
- **What**: The tests currently cover helper semantics through the old module path.
- **Change**: Update the import to the new source-layer helper module.
- **Why**: Keep the exact-token/non-identifier/empty-candidate behavior pinned.

- [x] **File**: `tests/symbols/identifier-attribution.test.ts`
- **Source**: `scip-query plan-context findCallerFiles`
- **What**: Existing identifier attribution tests cover reference correctness but do not pin the new pre-parse gate.
- **Change**: Add or adapt coverage proving `findCallerFiles` still reports cross-file callers for candidate leaves present in source text.
- **Why**: The optimization must preserve caller evidence.

## Stress Test

- Accuracy: the gate only skips files when no candidate leaf token/string appears in raw source. If a file references a candidate, the candidate leaf must appear in that source text, so false negatives are not introduced.
- Blast radius: `findCallerFiles` feeds `sourceFallbackCallerEvidenceMap`, then `callerFileEvidenceMap`, then consumer-evidence detectors including wrapper/stale/locality. Source: `scip-query plan-context findCallerFiles`.
- Reversibility: this is a pure internal prefilter and helper move; rollback is restoring the helper to `source-reference-scan.ts` and removing the guard in `findCallerFiles`.
- Concurrency: no shared mutable state is added; `getSourceText` uses the existing per-DB source-text cache.
- Failure handling: missing files produce empty source text, so the guard skips them just as parser fallback would produce no identifiers.
- Human impact: outputs remain the same; commands spend less time parsing files that cannot contain candidate references.

## Execution Order

1. Extract helper to `src/source/source-identifier-prefilter.ts`.
2. Update `source-reference-scan.ts` and tests to import it.
3. Add the guard in `findCallerFiles`.
4. Run focused tests, typecheck, build, benchmarks, post-checks, reindex, and diff-gate.

## Summary

Files changed: `src/source/source-identifier-prefilter.ts`, `src/symbols/references/source-reference-scan.ts`, `src/symbols/identifier-attribution.ts`, relevant tests, and this plan.

## Results

- Stable_Management warm `wrapper-candidates --json` improved to about `2010ms-2052ms`, from the prior `2411ms-2533ms` repeated-run range. Output size stayed `22415` bytes before and after.
- This repo on a fresh index: warm `health --json` was `1370ms`, warm `wrapper-candidates --json` reached `629ms` after semantic/reference caches were warm, and `dead --json --skip-barrels --min-loc 3 --only-dead` was `1100ms`.
- Post-checks passed: `similar sourceMayContainCandidateName`, `similar source-identifier-prefilter`, `recent-duplicates --full`, `unused-params --full`, and `incomplete-migration --json`.
- `co-change src/symbols/identifier-attribution.ts --json` reported only broad-sweep historical partners with no focused or structural coupling, so no partner edits were required.
- Verification passed: typecheck, focused attribution/prefilter tests, `npm run build`, and full `npm test -- --run` (`74` files, `407` tests).
