# Wrapper Consumer Prefilter Plan

Date: 2026-06-28

## Goal

Make the `wrapper-candidates` health phase faster without changing wrapper
findings. Done means the Vega_2.0 hashes for `health --json`,
`__health-phase wrapper-candidates`, and `wrapper-candidates --json --full`
stay unchanged, while wrapper source fallback runs only for candidates that
cheap indexed/semantic evidence cannot already rule out.

## Current State

- `health --json` is currently the slowest Vega warm command at 3.077s in the
  latest full matrix. Source:
  `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`.
- `health()` runs `withHealthRun()`, `runHealthAnalyses()`, and
  `buildHealthReport()`. Source: `scip-query plan-context health`;
  `scip-query code health -C 8`.
- The CLI path runs health phases in isolated subprocesses via
  `runIsolatedHealthReport()`, `healthPhaseTasks()`, and
  `runHealthPhaseTaskProcess()`. Source:
  `scip-query code runIsolatedHealthReport -C 8`;
  `scip-query code healthPhaseTasks -C 8`;
  `scip-query code runHealthPhaseTaskProcess -C 8`.
- `wrapperCandidates()` loads production callable candidates, prepares
  `definitionConsumerFileMap()`, evaluates each symbol, and keeps symbols with
  exactly one real external caller whose caller has enough fan-in. Source:
  `scip-query plan-context wrapperCandidates`;
  `scip-query code wrapperCandidates -C 8`;
  `scip-query code wrapperCandidateForSymbol -C 8`.
- `definitionConsumerFileMap()` composes indexed/semantic caller evidence with
  source fallback through `ProjectIndex.callerFileMap()`. Source:
  `scip-query code definitionConsumerFileMap -C 8`;
  `scip-query code callerFileEvidenceMap -C 8`.

## Reuse Audit

- Reuse the existing stale-abstractions pruning pattern:
  `consumerMapForPossiblyStaleTypeCandidates()` first builds indexed evidence,
  prunes candidates that cannot still be stale, optionally adds semantic
  evidence, prunes again, and only then runs source fallback. Source:
  `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 8`.
- Reuse `mergeSetMaps()` from caller evidence to combine cheap and fallback
  maps. Source: `scip-query code mergeSetMaps -C 4`;
  `scip-query refs mergeSetMaps`.
- Reuse `externalCallerFiles()` as the wrapper-specific viability predicate
  rather than duplicating real-consumer policy. Source:
  `scip-query code externalCallerFiles -C 8`.

## Design Phases

### 1.1 — Add a wrapper-specific consumer map builder

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts:45-66`
- **Source**: `scip-query code wrapperCandidates -C 8`;
  `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 8`
- **What**: `wrapperCandidates()` asks `definitionConsumerFileMap()` for full
  caller evidence, including source fallback, for every scan-limited symbol.
- **Change**: Add a private `consumerMapForWrapperCandidates()` helper that:
  builds indexed/semantic evidence with `sourceFallback: false`, filters to
  candidates whose `externalCallerFiles()` length is `<= 1`, runs
  `index.sourceFallbackCallerFiles()` only for that viable subset, and merges
  the maps.
- **Why**: A symbol with more than one real external caller before source
  fallback cannot become a wrapper candidate because source fallback can only
  add caller files.

### 1.2 — Route wrapper preparation through the helper

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts:56-60`
- **Source**: `scip-query code wrapperCandidates -C 8`
- **What**: The prepare block directly calls `definitionConsumerFileMap()`.
- **Change**: Replace the direct call with
  `consumerMapForWrapperCandidates(db, index, symbols, { semantic: opts?.semantic !== false })`.
- **Why**: Keeps the public command and result shape unchanged while shrinking
  the expensive source fallback candidate set.

### 1.3 — Verify hashes and health impact

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts`
- **Source**:
  `scip-query change-surface src/queries/cleanup/wrapper-candidates.ts --json --full`
- **What**: Wrapper candidates feed cleanup CLI output, health, health
  baselines, and diff-gate baseline checks.
- **Change**: Run focused tests, typecheck, build, Vega hashes for
  `wrapper-candidates --json --full`, `__health-phase wrapper-candidates`, and
  `health --json`, then full Vega bench and scip gates.
- **Why**: The prefilter must be exact, not merely faster.

## Execution Notes

- The accepted helper reduced the Vega_2.0 source fallback batch from 3,310
  wrapper scan symbols to 3,020 symbols in the debug trace.
- A broader version that added arbitrary enclosing caller functions to the
  fallback batch was rejected because it changed wrapper fan-in evidence from
  file-level fallback to function-level evidence for callers that were not in
  the original candidate batch. The accepted version only adds enclosing
  symbols when those symbols are already present in the original wrapper symbol
  set.
- Baseline/current Vega comparison after the correction:

| Command | Baseline | Current | stdout bytes | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `scip-query wrapper-candidates --json --full` | 2.165s | 2.147s | 78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query __health-phase wrapper-candidates` | 2.079s | 2.081s | 1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query health --json` | 2.991s | 2.890s | 15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

- Current-only warm medians after the accepted patch:

| Command | Median | Repeats |
| --- | ---: | --- |
| `scip-query wrapper-candidates --json --full` | 2.150s | 2.169s, 2.124s, 2.150s |
| `scip-query __health-phase wrapper-candidates` | 2.096s | 2.064s, 2.096s, 2.107s |
| `scip-query health --json` | 2.879s | 2.871s, 2.879s, 2.932s |

## Stress-Test Findings

- **Understand before touching**: Wrapper findings require exactly one real
  external caller and sufficient fan-in behind that caller.
- **Blast radius**: Medium. `wrapperCandidates()` has consumers in health,
  health baseline, query exports, and runtime cleanup handlers. Source:
  `scip-query trace wrapperCandidates`.
- **Intermediate validity**: The helper is private and the exported result type
  does not change.
- **Reversibility**: Reverting the helper call restores the previous full
  caller evidence map.
- **Failure design**: Any SQL/source failure still occurs through the existing
  evidence builders.
- **Concurrency**: Per-command caches stay scoped to one `ScipDatabase`
  instance; no shared mutable process state is added.
- **Data integrity**: Readonly index queries only.
- **Reuse**: Mirrors the existing stale-abstractions pruning pattern and reuses
  `mergeSetMaps()` plus `externalCallerFiles()`.

## Execution Order

1. Add the helper and import `mergeSetMaps()`.
2. Route `wrapperCandidates()` prepare through it.
3. Format, test, benchmark, update ledgers/scoreboard, run scip gates, and
   commit/push without a version bump.

## Summary

Touched files:

- `src/queries/cleanup/wrapper-candidates.ts`
- `docs/benchmarks/2026-06-28-health-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- `docs/plans/2026-06-28-wrapper-consumer-prefilter.md`
