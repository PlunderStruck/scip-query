# Candidate Pipeline Contracts — 2026-06-30

## Goal

The user wants the eighth structural optimization item completed in order. A candidate pipeline is a reusable analysis path that starts with possible findings and narrows them through loading, cheap rejection, bulk evidence preparation, exact scoring, sorting, and limiting until it emits command results. Its essential job is to make candidate narrowing a measured shared contract instead of a convention each detector remembers privately.

Done means `runCandidateAnalysis()` exposes explicit cheap-filter and profile-counter stages, current consumers name their pipelines for benchmark output, at least one consumer uses the cheap-filter stage, and the result contract stays source-compatible for existing callers.

## Current State

- `src/queries/internal/candidate-scan.ts:18-33` loads candidates, optionally sorts them, applies `scanLimit`, prepares one context object for the scanned candidates, evaluates each candidate, sorts results, and applies `limit`. Source: `node dist/cli.js plan-context runCandidateAnalysis`, `node dist/cli.js trace runCandidateAnalysis`.
- `src/queries/internal/candidate-scan.ts:3-11` defines `CandidateAnalysis` with `candidates`, `orderCandidates`, `scanLimit`, `prepare`, `evaluate`, `orderResults`, and `limit`; it has no cheap-filter stage and no standardized profile counters. Source: `node dist/cli.js surface src/queries/internal/candidate-scan.ts`.
- `src/queries/query-utils.ts:10-15` owns the existing `applyScanLimit()` behavior, returning the original array unless a positive scan limit is smaller than the input. Source: `node dist/cli.js code applyScanLimit -C 5`.
- `src/instrumentation/profile.ts:26-50` provides `profileSpan()` for JSONL profile spans when profiling is enabled. Source: `node dist/cli.js code profileSpan -C 8`, `node dist/cli.js trace profileSpan`.
- `src/queries/cleanup/extract-candidates.ts:61-88`, `passthrough-candidates.ts:43-57`, `stale-abstractions.ts:98-167`, `wrapper-candidates.ts:52-72`, `unused-params.ts:35-86`, and `complexity-hotspots.ts:32-61` already call `runCandidateAnalysis()`. Source: `node dist/cli.js plan-context runCandidateAnalysis`, `node dist/cli.js code extractCandidates -C 8`, `node dist/cli.js code passthroughCandidates -C 8`, `node dist/cli.js code staleAbstractions -C 8`, `node dist/cli.js code wrapperCandidates -C 8`, `node dist/cli.js code unusedParams -C 8`, `node dist/cli.js code complexityHotspots -C 8`.
- `src/queries/cleanup/unused-params.ts:41-52` currently folds a TypeScript-family source filter into the candidate callback after loading production callable definitions. Source: `node dist/cli.js code unusedParams -C 8`.
- The runner has 6 direct consumer functions and 18 affected symbols across 10 files, including health and diff-gate wrappers. Source: `node dist/cli.js affected runCandidateAnalysis`, `node dist/cli.js change-surface src/queries/internal/candidate-scan.ts`.
- The structural inventory doc has no doc-drift findings and recent-duplicates is clean before this slice. Source: `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`, `node dist/cli.js recent-duplicates --json`.

Non-obvious invariants to preserve:

- `prepare` must receive exactly the scanned candidate list, not all loaded candidates, because current consumers use it to bulk-load evidence for the bounded work set. Source: `node dist/cli.js code extractCandidates -C 8`, `node dist/cli.js code complexityHotspots -C 8`.
- Existing callers must keep receiving `TResult[]`; changing the return shape would ripple into health, baseline, and diff-gate consumers. Source: `node dist/cli.js affected runCandidateAnalysis`.
- Result ordering and limiting must stay after evaluation because current command outputs depend on detector-specific scores and tiers. Source: `node dist/cli.js code staleAbstractions -C 8`, `node dist/cli.js code wrapperCandidates -C 8`.

## Reuse Audit

- Use the existing `runCandidateAnalysis()` instead of adding a parallel runner. Source: `node dist/cli.js plan-context runCandidateAnalysis`; `node dist/cli.js similar runCandidateAnalysis` found no similar symbols.
- Reuse `applyScanLimit()` for scan limiting; do not introduce a second limit helper. Source: `node dist/cli.js code applyScanLimit -C 5`.
- Reuse `profileSpan()` for profile output; do not write JSONL directly from the runner. Source: `node dist/cli.js code profileSpan -C 8`, `node dist/cli.js code writeProfileEvent -C 5`.
- Keep consumer-specific evidence loading in `prepare`; the candidate runner should measure the stage, not know about `ProjectIndex`, consumer maps, callee maps, or evidence products. Source: `node dist/cli.js code extractCandidates -C 8`, `node dist/cli.js code wrapperCandidates -C 8`, `node dist/cli.js code complexityHotspots -C 8`.
- `node dist/cli.js similar-files src/queries/internal/candidate-scan.ts` found no similar file pairs, and `node dist/cli.js similar-chains` only surfaced runtime/domain chain similarities unrelated to candidate analysis.

## Design Phases

### 1.1 — Extend the candidate runner contract

- [x] **File**: `src/queries/internal/candidate-scan.ts:1-107`
- **Source**: `node dist/cli.js plan-context runCandidateAnalysis`, `node dist/cli.js code applyScanLimit -C 5`, `node dist/cli.js code profileSpan -C 8`
- **What**: `CandidateAnalysis` lacks an explicit cheap-filter stage and the runner returns results without standardized counts for loaded, filtered, scanned, evaluated, matched, and emitted rows.
- **Change**: Add exported `CandidatePipelineCounters`, `CandidatePipelineProfile`, and `CandidatePipelineMetadata` types. Add optional `filterCandidate`, `profile`, and `onProfile` fields to `CandidateAnalysis`. Update `runCandidateAnalysis()` to execute stages in this order: load candidates, apply `filterCandidate`, sort candidates, apply `scanLimit`, prepare context, evaluate scanned candidates, sort results, apply `limit`, then emit counters through `onProfile` and `profileSpan('candidate-pipeline:<name>', ...)` when `profile` is supplied.
- **Why**: Candidate analysis should expose the same stage counters across detectors before more commands are migrated into the runner.

### 1.2 — Name current candidate pipelines

- [x] **File**: `src/queries/cleanup/extract-candidates.ts:61-90`
- **Source**: `node dist/cli.js code extractCandidates -C 8`
- **What**: The extraction detector already uses the runner but does not name its candidate pipeline for profiling.
- **Change**: Add `profile: { name: 'extract-candidates' }` to the runner call.
- **Why**: Benchmarks should be able to compare candidate counts across detector families.

- [x] **File**: `src/queries/cleanup/passthrough-candidates.ts:43-59`
- **Source**: `node dist/cli.js code passthroughCandidates -C 8`
- **What**: Passthrough detection uses ordered candidates and bulk callee-map preparation without profile counters.
- **Change**: Add `profile: { name: 'passthrough-candidates' }` to the runner call.
- **Why**: This gives the runner a measured path for small-wrapper detectors.

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:98-169`
- **Source**: `node dist/cli.js code staleAbstractions -C 8`
- **What**: Stale abstraction detection performs the most complex runner `prepare` stage, including consumer maps and singleton-backed class evidence.
- **Change**: Add `profile: { name: 'stale-abstractions' }` to the runner call.
- **Why**: The new counters need to cover heavy bulk evidence preparation without changing its semantics.

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts:52-74`
- **Source**: `node dist/cli.js code wrapperCandidates -C 8`
- **What**: Wrapper detection prepares consumer maps and reverse file fan-in through the runner but does not emit shared counters.
- **Change**: Add `profile: { name: 'wrapper-candidates' }` to the runner call.
- **Why**: Wrapper detection is one of the health-score inputs, so candidate counts should be structurally observable.

- [x] **File**: `src/queries/quality/complexity-hotspots.ts:32-63`
- **Source**: `node dist/cli.js code complexityHotspots -C 8`
- **What**: Complexity hotspots already bulk-load caller maps, callee maps, source language, and Clojure callable IDs in `prepare`.
- **Change**: Add `profile: { name: 'complexity-hotspots' }` to the runner call.
- **Why**: Complexity health phases should produce the same pipeline counters as cleanup detectors.

### 1.3 — Move one source-family rejection into the cheap-filter stage

- [x] **File**: `src/queries/cleanup/unused-params.ts:35-87`
- **Source**: `node dist/cli.js code unusedParams -C 8`
- **What**: `unusedParams()` loads production callable definitions and then filters to TypeScript-family files inside the `candidates` callback.
- **Change**: Return the production callable definitions directly from `candidates`, move the TypeScript-family check to `filterCandidate`, and add `profile: { name: 'unused-params' }`.
- **Why**: This proves the cheap-filter stage on a real detector while preserving the exact filtered candidate set before evaluation.

### 1.4 — Test the contract and benchmark it

- [x] **File**: `tests/queries/internal/candidate-scan.test.ts` (new test file; tests are not indexed by scip-query)
- **Source**: `node dist/cli.js plan-context runCandidateAnalysis`
- **What**: No tests currently exercise the runner contract directly.
- **Change**: Add focused tests asserting stage order, `filterCandidate`, scan-limit behavior, result-limit behavior, and `onProfile` counters.
- **Why**: The runner is now an architectural contract; tests should pin the contract independently from detector outputs.

## Stress-Test Findings

1. Understand before touch: the runner is the small shared path for detectors that can bulk-prepare evidence for a bounded candidate set. Source: `node dist/cli.js plan-context runCandidateAnalysis`.
2. Blast radius: direct changes affect 6 runner consumers plus health, baseline, and diff-gate downstream paths. Source: `node dist/cli.js affected runCandidateAnalysis`.
3. Valid intermediate states: adding optional fields is source-compatible; consumer migrations can happen one at a time.
4. Reversibility: this is an internal TypeScript refactor with no schema change and no CLI output change.
5. Failure design: profiling must not be able to fail commands; `profileSpan()` already preserves command errors and `writeProfileEvent()` swallows write failures after warning once. Source: `node dist/cli.js code profileSpan -C 8`, `node dist/cli.js code writeProfileEvent -C 5`.
6. Concurrency: the runner has no shared mutable state; profile output uses the existing append-only profile writer.
7. Boundaries: no CLI input boundaries change; command options continue to be parsed by the command modules.
8. Data integrity: no database writes or persistent evidence payloads are introduced.
9. Observability: the new counters make loaded, filtered, scanned, evaluated, matched, and emitted row counts visible to benchmarks.
10. Human impact: command outputs should remain unchanged because result shaping remains in detector modules.
11. Reuse: this extends the existing runner and existing profile utility rather than creating a new pipeline framework. Source: `node dist/cli.js similar runCandidateAnalysis`, `node dist/cli.js similar-files src/queries/internal/candidate-scan.ts`.

## Execution Order

1. Extend `src/queries/internal/candidate-scan.ts` with optional contract fields and counters.
2. Add focused tests for the runner contract.
3. Add pipeline profile names to the five existing runner consumers that do not need logic changes.
4. Move `unusedParams()` TypeScript-family rejection into `filterCandidate` and name its pipeline.
5. Run focused tests and command smokes for the six migrated commands.
6. Run typecheck, build, structural checks, full tests, benchmark, health, reindex, and diff-gate.

## Ship Order

Ship as one internal refactor. There are no one-way doors: the public return type stays `TResult[]`, all new fields are optional, and no command output format changes.

## Verification Progress

- [x] Focused runner tests passed: `npm test -- tests/queries/internal/candidate-scan.test.ts`.
- [x] Typecheck passed: `npm run typecheck`.
- [x] Build passed: `npm run build`.
- [x] Compiled command smokes passed for `extract-candidates`, `passthrough-candidates`, `stale-abstractions`, `wrapper-candidates`, `unused-params`, and `complexity-hotspots`.
- [x] CLI profiling smoke passed: `SCIP_QUERY_PROFILE=1 ... node dist/cli.js wrapper-candidates --json` emitted `candidate-pipeline:wrapper-candidates` with loaded, filtered, scanned, evaluated, matched, and emitted counters.
- [x] Reindex passed: `node dist/cli.js reindex`.
- [x] Structural checks are clean: `wrapper-candidates --json`, `incomplete-migration --json`, `recent-duplicates --json`, and `unused-params --json`.
- [x] Stale-abstraction follow-up passed: `CandidatePipelineCounters` was preserved with `scip-query: ignore-stale` because it is the exported profile-counter contract; `stale-abstractions --json` returned to the pre-slice baseline of 5 findings.
- [x] Full test suite passed: `npm test` (84 files, 466 tests).
- [x] Evidence-product benchmark passed: `npm run bench:evidence-products -- --warm-iterations 0 --no-clear --out /tmp/candidate-pipeline-contracts.jsonl` with 0 failed commands.
- [x] Diff impact completed: `node dist/cli.js diff-impact --json`.
- [x] Health check completed: `node dist/cli.js health --full` reported 99/100 with only the existing similarity deduction.
- [x] Final gate passed: `node dist/cli.js reindex && node dist/cli.js diff-gate --json`.

## Summary

Files modified/created:

- `src/queries/internal/candidate-scan.ts`
- `src/queries/cleanup/extract-candidates.ts`
- `src/queries/cleanup/passthrough-candidates.ts`
- `src/queries/cleanup/stale-abstractions.ts`
- `src/queries/cleanup/wrapper-candidates.ts`
- `src/queries/cleanup/unused-params.ts`
- `src/queries/quality/complexity-hotspots.ts`
- `tests/queries/internal/candidate-scan.test.ts`

Expected net effect: existing candidate-based detectors keep their outputs, but the shared runner now owns cheap-filter staging and emits consistent pipeline counters for the benchmark work that decides whether broader detector families should migrate next.

Accepted structural note: `CandidatePipelineCounters` is intentionally preserved as an exported counter contract even while it has one production consumer today; the nearby `ignore-stale` comment records that boundary.
