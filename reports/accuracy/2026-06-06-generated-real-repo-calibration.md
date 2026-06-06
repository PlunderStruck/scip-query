# Vega Accuracy Calibration

Date: 2026-06-06

This report records what happened when scip-query was tested against the
Vega_2.0 codebase. Treat every finding as untrusted until sampled against
source evidence.

## Vega_2.0

Path: `/Users/aydansalois/Documents/GitHub/Vega_2.0`

### Full reindex

Status: failed closed.

```text
Detected languages: typescript, python
Indexing typescript with scip-typescript...
Indexing python with scip-python...
Skipping python: scip-python indexer failed
Indexed 1 of 2 languages; skipped python.
error: Failed to index all required languages; preserving the previous index.
```

The full configured reindex failed closed because Vega_2.0 declares both
TypeScript and Python and `scip-python` failed during indexing. This is the
right reliability posture: preserve the previous index unless the user asks for
`--allow-partial`.

### TypeScript-only calibration

A TypeScript-only index was built with an isolated cache:

```text
Indexed 1,404 files
87,428 symbols
58.7 MB
33.5s
```

Health on that TypeScript-only index:

```text
Score: 93/100
Dead code: 41 symbols, 596 LOC
Similar pairs: 50
Extract candidates: 5
Wrapper functions: 50
Passthroughs: 50
Stale abstractions: 50
```

### Verified false positive

`dead apps/api/src/db --min-loc 5 --skip-barrels --only-dead` reported:

```text
apps/api/src/db/migrate.ts
  488-560  (73 LOC)  src:db:migrate:runMigrations()
```

Source evidence showed this was wrong:

```text
apps/api/src/index.ts imports runMigrations from ./db/migrate.js
apps/api/src/index.ts awaits runMigrations() inside main()
call-graph runMigrations reports caller src:index:main()
```

Root cause: `apps/api/src/index.ts` was classified as an inactive barrel when
`--skip-barrels` was enabled. That erased the bootstrap file's reference before
dead-code classification. The fix classifies `apps/*/src/index.ts` and
`services/*/src/index.ts` as entry surfaces, not barrels.

After the fix:

```text
$ scip-query dead apps/api/src/db --min-loc 5 --skip-barrels --only-dead
No matching dead-code symbols found.
```

### Additional dead-code guardrails

- Data members are excluded from `dead` by default unless `--include-members`
  is set. Field/property liveness is weaker across SCIP indexers and should not
  be labeled safe-to-delete by default.
- Unused import bindings no longer count as liveness evidence in `dead`.
  Importing a symbol without using the local binding is not enough to mark the
  exported symbol live.
- `dead` now supplements raw mention evidence with caller-row evidence so a
  callable with a recovered call-graph caller is not reported as dead.

### Remaining command accuracy concerns

- `stale-abstractions` still needs calibration for framework/controller
  singleton patterns. Vega examples like controller classes instantiated in the
  same module need stricter interpretation before removal recommendations.
- `drift` is noisy at Vega scale because many sibling directories naturally
  have unique dependency edges. Unique dependency edges are observations, not
  automatic architectural violations.
- Full multi-language calibration is blocked until the Vega Python indexing
  failure is diagnosed or the calibration harness supports intentional
  language-scoped runs.
