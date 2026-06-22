# Public Surface Caveats Result

Date: 2026-06-22

## Verdict

The public package/export caveat slice is complete for `redundant-reexports` and the dead-code package-surface gate.

A package public surface is the set of files a package declares as externally importable through `package.json` entry fields. Its referents are source or generated entry files that consumers outside the local SCIP index may import. The important cleanup fact is that zero local consumers is incomplete evidence for those files.

## Implementation

- `redundant-reexports` now emits `actionTier`, `surfaceEvidence`, and `recommendation`.
- Package-public barrels are `signal` rows with explicit surface evidence and a package-API review recommendation.
- Private barrels remain `direct` rows with the existing zero-consumer cleanup meaning.
- JavaScript/TypeScript `export ... from` statements are now included in the source fallback through `getReExports()`.
- Package-surface derivation now maps package entry targets such as `dist/runtime.js` to `src/runtime/index.ts`.
- Package-surface derivation now reads nested package manifests, so monorepo packages such as `packages/shared/package.json` contribute their own published source surfaces.
- Dead-code coverage now pins that package-exported source files are skipped as externally live.

## Validation Samples

Focused regressions:

- `tests/analysis/package-surface.test.ts`: 8 tests passed, including nested package manifest and source directory index mapping.
- `tests/queries/cleanup/redundant-reexports-fallback.test.ts`: 3 tests passed, including a direct private Rust barrel and a signal package-public TypeScript barrel.
- `tests/queries/cleanup/dead-output.test.ts`: 1 test passed, including a package-exported `publicApi()` symbol that is not reported as dead.

Corpus sample:

| Corpus              | Command output                                      | Judgment                                                                                                      |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `scip-query`        | 10 redundant-reexport rows: 9 `signal`, 1 `direct`. | Public root/runtime package barrels are now review signals; one internal cleanup barrel remains direct.       |
| `Vega_2.0`          | Top 30 rows split into 13 `signal` and 17 `direct`. | Nested `packages/shared` exported barrels are now package-surface signals instead of direct cleanup.          |
| `SynthRunnerRust`   | 0 rows.                                             | No redundant re-export evidence in this corpus.                                                               |
| `Stable_Management` | Top 30 rows split into 13 `signal` and 17 `direct`. | `shared/package.json` public barrels now carry package-surface caveats; private frontend barrels stay direct. |

## Judgment

Confirmed. Redundant re-export findings are still direct when the barrel is private and has zero local barrel/direct consumers. Package-public barrels should not be framed as direct deletion work, because external consumers may import through the published barrel even when the local index does not.

The dead-code gate already used package-surface rooted-symbol filtering; this slice adds a regression that protects that behavior and improves package-surface discovery for directory index and nested package manifests.

Remaining public-surface work is narrower: framework-discovered entrypoints and non-`package.json` publish metadata still need separate evidence. The package/export blocker from the output-schema list is closed.

## Verification

Completed during implementation:

- `npx vitest run tests/analysis/package-surface.test.ts tests/queries/cleanup/redundant-reexports-fallback.test.ts tests/queries/cleanup/dead-output.test.ts`
- `npm run typecheck`
- `npm run build`
- Corpus outputs recorded under `/tmp/scip-query-validation/2026-06-22-public-surface-*`

Full verification gate is recorded with the final work session output.
