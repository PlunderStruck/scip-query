# Source Reference Prefilter Performance Plan

## Objective

Make source-backed cleanup analysis faster without reducing accuracy by skipping expensive AST identifier-map construction for files whose raw source text cannot contain any candidate name.

## External Comparison

- Pulled `/tmp/flesler-scip-cli` at `3d66786` (`v2.2.1`, 2026-06-27). Its speed work favors early reduction: SQLite read PRAGMAs, per-TypeScript-project parallel indexing, copy-filtered indexes, SQL-first analysis, bounded graph traversal, and coarse perf guards.
- `scip-query` already has the SQLite read PRAGMAs in `src/storage/db.ts:44-53`, so this plan transfers the same principle rather than the same code: filter cheaply before deeper analysis.

## Measurements

- This repo, phase benchmark: `scip-query __health-phase dead` was `1065ms`; `wrapper-candidates` was `651ms`; `stale-abstractions` was `601ms`; aggregate `health --json` was `1497ms`.
- Vega_2.0, stale index but representative size: `__health-phase dead` was `2992ms`; `wrapper-candidates` was `2324ms`; `stale-abstractions` was `2167ms`; aggregate `health --json` was `4336ms`.
- CPU profile of `__health-phase dead` showed `Parser.parse`, tree-sitter node unmarshalling, SQLite `all`, filesystem/source loading, and GC among the top samples. The target is to avoid tree-sitter and identifier-map work for files with no candidate names.

## Checklist

- [x] In `src/symbols/references/source-reference-scan.ts:23-33`, extend `ScanSourceReferencesOptions` only if needed; prefer keeping the existing `candidateNames` option as the trigger so callers do not change.
  - Source: `scip-query code 'src/symbols/references/source-reference-scan.ts:1-92'`

- [x] In `src/symbols/references/source-reference-scan.ts:50-56`, before `getIdentifierLineMap(db, sourceFile)` runs, add a raw-source prefilter when `opts.candidateNames` is present and non-empty. Read `getSourceText(db, sourceFile)` and skip the file when no candidate name appears in the raw source.
  - Source: `scip-query code 'src/symbols/references/source-reference-scan.ts:1-92'`

- [x] Implement the prefilter as an accuracy-preserving negative test: tokenize raw source with a broad identifier regex and check candidate membership, and fall back to `source.includes(candidate)` for candidate names that are not simple identifiers. This may allow false positives, but must not produce false negatives.
  - Source: `scip-query plan-context getIdentifierLineMap`

- [x] Keep framework-source references correct. `scanSourceReferences` also visits `frameworkSourceReferences` at `src/symbols/references/source-reference-scan.ts:77-85`; the raw source prefilter is still safe because a framework reference name must occur in the source text before it can be returned.
  - Source: `scip-query code 'src/symbols/references/source-reference-scan.ts:1-92'`

- [x] Add focused tests for the prefilter helper: identifier candidates, non-identifier candidates, absent candidates, and substring false-positive avoidance (`Foo` should not match only `FooBar` via token matching).
  - Source: `scip-query change-surface src/symbols/references/source-reference-scan.ts`

- [x] Verify affected consumers: `dead` source fallback uses `candidateNames` at `src/queries/cleanup/dead.ts:283-314` and `src/queries/cleanup/dead.ts:329-365`; `drift` source scan is the other direct caller and must keep behavior when it passes candidate names.
  - Source: `scip-query refs candidateNames --json`

- [x] Benchmark after build: this repo `__health-phase dead`, `dead --json --skip-barrels --min-loc 3 --only-dead`, and Vega/Stable_Management `__health-phase dead` and `health --json`.
  - Source: `scip-query bench --json`

- [x] Run verification: typecheck, focused tests, full tests if focused passes, `scip-query reindex`, `scip-query diff-gate --json`.
  - Source: `scip-query status --capabilities`

## Stress Test

- Accuracy: the prefilter only skips when the raw source lacks every candidate name, so it cannot hide an identifier, string-dispatch, or framework attribute reference to that candidate.
- Concurrency: no shared mutable global state is added; the existing per-db source-text cache remains the only cache touched.
- Failure: unreadable files still behave as no-source files because `getSourceText` returns an empty string for missing paths.
- Reversibility: one small internal helper and one call-site guard can be removed without schema or output-contract changes.
- Human impact: interactive cleanup commands keep their current outputs; the change only avoids unnecessary parsing before producing the same evidence.

## Results

- This repo, warm runs after build: `__health-phase dead` was `956ms`; `dead --json --skip-barrels --min-loc 3 --only-dead` was `960ms`; `health --json` was `1340ms`.
- Stable_Management, stale but representative large index: warm `health --json` was `3386ms`; `__health-phase dead` was `1967ms`.
- Verification passed: typecheck, focused tests, full `npm test -- --run`, `scip-query reindex`, and `scip-query diff-gate --json`.
