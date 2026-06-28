# Dead JS Exclusion Prefilter Plan

Date: 2026-06-28

## Goal

Make the `dead --json --full` detector faster on large TypeScript-heavy
repositories without changing any reported dead symbols. Done means Vega_2.0
keeps the same `dead --json --full` stdout hash and the same health hash, while
the JS/TS framework-exclusion gate avoids regex work when a match is impossible.

## Current State

- The refreshed Vega_2.0 heavy warm matrix ranks `health --json` at 2.845s,
  `diff-gate --json` at 2.815s, and `dead --json --full` at 2.691s. Source:
  `scip-query bench --json --include-heavy --timeout-ms 600000`.
- `dead()` loads candidate definitions, mention reference counts, source
  fallback references, caller-map references, then projects rows and summary.
  Source: `scip-query code dead -C 12 --json`.
- `deadCandidateDefinitions()` calls `buildFileExclusionPredicate()` and then
  applies `deadCandidateDecision()` to every scoped definition. Source:
  `scip-query code deadCandidateDefinitions -C 30 --json`;
  `scip-query code deadCandidateDecision -C 12 --json`.
- `buildFileExclusionPredicate()` is the only external consumer of
  `getDefinitionExclusions()`, and `dead.ts` is the only consumer of the
  predicate. Source:
  `scip-query trace buildFileExclusionPredicate --json`.
- For JS/TS files, `getDefinitionExclusions()` delegates to
  `getJsTestExclusions()`, which calls `mayContainJsExclusion()` before parsing
  the AST. Source: `scip-query code getDefinitionExclusions -C 12 --json`;
  `scip-query code getJsTestExclusions -C 12 --json`.
- `mayContainJsExclusion()` currently returns
  `source.includes('scip-query') || TEST_FRAMEWORK_CALL_RE.test(source) ||
REACT_HOOK_DECLARATION_RE.test(source)`. Source:
  `scip-query code getJsTestExclusions -C 12 --json`.
- `src/analysis/framework-patterns.ts` has medium file-level risk because
  `getDefinitionExclusions()` has an external consumer, but
  `mayContainJsExclusion()` itself is private and low risk. Source:
  `scip-query change-surface src/analysis/framework-patterns.ts --json --full`.

## Reuse Audit

- Reuse the existing `TEST_FRAMEWORK_NAMES` set and both existing regexes from
  `src/analysis/framework-patterns.ts`; do not introduce a second list of test
  framework names. Source: `scip-query code getJsTestExclusions -C 12 --json`.
- Reuse the existing source-prefilter pattern from
  `sourceMayContainCandidateName()` only as a design precedent: cheap textual
  exclusion before expensive exact matching. Its identifier-set API does not fit
  the regex-specific hook/test detector. Source:
  `scip-query code sourceMayContainCandidateName -C 8 --json`;
  `scip-query similar mayContainJsExclusion --json --full`.
- No new exported helper is needed. The change stays private to
  `mayContainJsExclusion()`. Source:
  `scip-query refs mayContainJsExclusion --json`.

## Design Phases

### 1.1 — Guard test-framework regex with name presence

- [x] **File**: `src/analysis/framework-patterns.ts:161-163`
- **Source**: `scip-query code getJsTestExclusions -C 12 --json`
- **What**: `mayContainJsExclusion()` always runs
  `TEST_FRAMEWORK_CALL_RE.test(source)` when the source does not contain the
  literal `scip-query`.
- **Change**: Before running `TEST_FRAMEWORK_CALL_RE`, check whether any value
  in `TEST_FRAMEWORK_NAMES` appears in the source. If none appear, the exact
  regex cannot match.
- **Why**: Vega source-text probing avoided 184 test-framework regex calls with
  zero boolean mismatches.

### 1.2 — Guard React-hook regex with `use` presence

- [x] **File**: `src/analysis/framework-patterns.ts:161-163`
- **Source**: `scip-query code getJsTestExclusions -C 12 --json`
- **What**: `mayContainJsExclusion()` always runs
  `REACT_HOOK_DECLARATION_RE.test(source)` when the earlier checks are false.
- **Change**: Run `REACT_HOOK_DECLARATION_RE` only when the source contains the
  literal `use`, which every `use[A-Z]` declaration matched by the regex must
  contain.
- **Why**: Vega source-text probing avoided 1,367 hook-regex checks with zero
  boolean mismatches.

### 1.3 — Verify output hashes and detector speed

- [x] **File**: `src/analysis/framework-patterns.ts`
- **Source**: `scip-query change-surface src/analysis/framework-patterns.ts --json --full`
- **What**: Framework exclusions feed dead-code candidate eligibility.
- **Change**: Run focused framework tests, full tests if focused coverage is
  weak, Vega hash comparisons for `dead --json --full` and `health --json`,
  then `scip-query reindex && scip-query diff-gate --json`.
- **Why**: The optimization is acceptable only if it is output-preserving.

## Execution Notes

- Vega source-text probe: 2,277 JS/TS files, 1,032 positive exclusion probes
  before and after, zero boolean mismatches, and 640 regex evaluations avoided.
- Paired Vega baseline/current comparison after implementation:

| Command                          | Baseline median | Current median | stdout bytes | SHA-256                                                            |
| -------------------------------- | --------------: | -------------: | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`  |          2.689s |         2.674s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead` |          1.985s |         2.008s |           55 | `decdc3187d74e82cb158362174e58a4de3f8a490dd798571e16794f90f7a65e5` |
| `scip-query health --json`       |          2.975s |         2.932s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

- Accepted as a micro-optimization: output hashes are unchanged, standalone
  `dead --full` and composite `health` improved slightly in the paired sample,
  and the dead health phase remained within noise.

## Stress-Test Findings

- **Understand before touching**: The exclusion gate protects framework-owned
  symbols that the SCIP graph cannot see. This change does not alter exact
  matching or AST exclusion construction; it only avoids impossible regexes.
- **Blast radius**: `getDefinitionExclusions()` is consumed through
  `buildFileExclusionPredicate()` by `deadCandidateDefinitions()`. Source:
  `scip-query trace buildFileExclusionPredicate --json`.
- **Intermediate validity**: One private function changes; no exported API or
  JSON shape changes.
- **Reversibility**: Reverting `mayContainJsExclusion()` restores the previous
  regex order.
- **Failure design**: No new IO, async work, cache, or error path is added.
- **Concurrency**: No shared state is added; existing regexes are non-global.
- **Data integrity**: Readonly source-string checks only.
- **Observability**: No user-facing behavior changes; benchmark ledger records
  accepted/rejected evidence.
- **Human impact**: Faster large-repo detector runs with identical findings.
- **Reuse**: Existing constants and regexes stay canonical.

## Execution Order

1. Patch `mayContainJsExclusion()`.
2. Format and run focused tests around framework patterns/dead candidate gates.
3. Build and compare Vega hashes/timings.
4. Update benchmark docs, run scip gates, commit and push without a version
   bump if accepted.

## Summary

Touched files:

- `src/analysis/framework-patterns.ts`
- `docs/plans/2026-06-28-dead-js-exclusion-prefilter.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
