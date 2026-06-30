# Framework Entry Caveats Result

Date: 2026-06-22

Plan: `docs/plans/2026-06-22-framework-entry-caveats.md`

## Scope

This slice closes the framework-discovered entrypoint caveat for direct cleanup analyzers.

A framework-discovered entrypoint is a source-level export whose real caller is a framework runtime or build step that finds it from a conventional file path and export name. The important maintenance distinction is symbol-level: a route handler such as `GET` in `app/**/route.ts` may be externally live without local imports, while an unrelated helper in the same file can still be ordinary dead code.

## Implementation

- Added framework-discovered rooted-symbol detection to `isRootedSymbol()`.
- Covered Next.js app route/page exports, Next.js pages exports, Remix route exports, SvelteKit route exports, and Vite/Vue route-component default exports.
- Narrowed the older TS/JS route exclusion in `framework-patterns` so route-like files are no longer skipped as whole-file dead-code exclusions.
- Preserved test-file and React custom-hook framework exclusions.
- Added a dead-code fixture where `GET()` in a Next.js app route is not reported but `unusedRouteHelper()` in the same file is reported.

2026-06-27 follow-up: `src/analysis/framework-patterns.ts` now uses a source-text prefilter before TS/JS exclusion AST parsing. Marker-positive test-file, React custom-hook, and `scip-query` suppression cases still take the AST path; `tests/analysis/framework-patterns.test.ts` covers those preserved exclusions.

2026-06-28 follow-up: the same `src/analysis/framework-patterns.ts` prefilter now uses a declaration-shaped React custom-hook marker instead of treating every `use[A-Z]` identifier as AST-worthy. Ordinary React hook calls such as `useState` skip the framework-exclusion AST path, while top-level custom hook declarations, test framework files, and `scip-query` suppression comments still take it.

2026-06-28 regex-guard follow-up: `src/analysis/framework-patterns.ts` now checks for test-framework names and the literal `use` before running the exact TS/JS exclusion regexes. This keeps the same test-file, custom-hook, and suppression behavior while avoiding regex work when a match is impossible.

2026-06-28 definition-exclusion cache follow-up: `src/analysis/framework-patterns.ts` now persists framework definition exclusions as content-hash-keyed file evidence. The persisted payload is the same exclusion entry list produced by the TS/JS and Rust analyzers, so test-file, custom-hook, and `scip-query` suppression behavior is unchanged while repeat CLI processes avoid reparsing unchanged files.

## Verification

- `npx vitest run tests/queries/cleanup/dead-output.test.ts` passed: 1 file, 1 test.
- `npx prettier --check src/analysis/file-classifier.ts src/analysis/framework-patterns.ts tests/queries/cleanup/dead-output.test.ts docs/plans/2026-06-22-framework-entry-caveats.md` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- 2026-06-28 follow-up verification: `npx vitest run tests/analysis/framework-patterns.test.ts`, `npm run typecheck`, `npm test`, and `npm run build` passed after the declaration-shaped hook prefilter. Vega_2.0 output hashes stayed unchanged for `dead --json --full`, `__health-phase dead --full`, and `health --json`.
- 2026-06-28 regex-guard verification: `npm test -- tests/analysis/framework-patterns.test.ts tests/queries/internal/dead-candidate-gate.test.ts tests/queries/cleanup/dead-output.test.ts`, `npm run typecheck`, `npm run build`, and `npm test` passed. Vega_2.0 output hashes stayed unchanged for `dead --json --full`, `__health-phase dead`, and `health --json`.
- 2026-06-28 definition-exclusion cache verification: `npm test -- tests/analysis/framework-patterns.test.ts tests/queries/cleanup/dead-output.test.ts tests/storage/evidence-cache.test.ts tests/runtime/cli-support.test.ts`, `npm test`, `npm run typecheck`, and `npm run build` passed. Paired Vega_2.0 probes kept output hashes unchanged for `dead --json --full`, `__health-phase dead --full`, and `health --json`.
- `node dist/cli.js similar isFrameworkDiscoveredEntrypointSymbol --json` returned no rows.
- `node dist/cli.js recent-duplicates --json` returned no findings and no root-cause groups.
- `node dist/cli.js unused-params --json`, `wrapper-candidates --json`, `passthrough-candidates --json`, `cycles --json`, and `isolated --json` returned no findings.
- `node dist/cli.js incomplete-migration --json` returned no findings.
- `node dist/cli.js dead --only-dead --json` reported `deadCodeCount: 0`.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `npm test` passed: 66 files, 334 tests. The run still prints the known noisy `git diff` usage warning from the existing incomplete-migration fixture.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js diff-gate --json` returned the two previously accepted warnings only:
  - `SQ36D93309ABEA`: accepted signal-tier echo for `isCompileTimeContractAssertion()` vs. `indexedDefinitionFromRow()` because both use symbol leaf helpers but answer different questions.
  - `SQ30E6CF5F9B38`: accepted support-tier README configuration-example doc-reference because the example still points at the intended cleanup detector files.

## Judgment

Verdict: implemented. Framework-discovered exports now receive the same external-live treatment as package/public roots without hiding ordinary same-file helpers. This turns the previous whole-file route skip into a narrower rooted-symbol policy.

## 2026-06-30 Evidence Product Follow-Up

The `src/analysis/framework-patterns.ts` framework-entry caveats remain
accurate after the file evidence product registry migration. Definition
exclusions still use the same Rust and TS/JS detection semantics; only the
persistent evidence read/write adapter moved to `src/storage/evidence-products.ts`.
