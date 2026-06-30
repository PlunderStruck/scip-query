# Config Declared-Coupling Freshness Result

Date: 2026-06-21

Ledger item: AVL-013

## Verdict

Complete. Declared coupling paths now identify current files in this repository, and `config-validate` now warns when a declared-coupling file path is stale.

A declared coupling is a project config entry that names files intentionally maintained as one unit. It lets history-based co-change analysis avoid treating known file groups as hidden coordination. The defining requirement is that each named path still resolves to a real file; a stale path turns an intentional relationship into inert text.

## Evidence

Before the slice, a filesystem check of `.scipquery.json` found 18 stale declared-coupling paths. The stale entries came from earlier directory moves:

- Cleanup and maintainability queries moved under `src/queries/cleanup/`.
- Complexity hotspots moved under `src/queries/quality/`.
- Graph queries moved under `src/queries/graph/`.
- Navigation queries moved under `src/queries/navigation/`.
- Runtime command dispatch moved under `src/runtime/commands/`.
- `doc-drift` moved to `src/queries/cleanup/doc-drift.ts`.

2026-06-22 note: the later `doc-drift.ts` lint cleanup does not change this declared-coupling freshness claim or the current file path.

2026-06-22 locality-config note: the later `locality.architecturalBoundarySegments` validation extends the same `validateProjectConfig()` path; this declared-coupling freshness example still points at the intended file.

2026-06-23 setup-command note: `src/runtime/commands/command-handlers.ts` still passes `projectRoot` to `validateProjectConfig()` for `config-validate`; the new `setup` orchestration also validates project config with `projectRoot` before indexing.

2026-06-28 doc-drift cache note: `src/queries/cleanup/doc-drift.ts` is still the intended current file path. The path-evidence cache change affects repeated markdown citation scanning, not declared-coupling path freshness.

After the slice:

- `.scipquery.json` has 0 stale declared-coupling paths.
- `node dist/cli.js config-validate --json` returns an empty diagnostics list for this repo.
- `validateProjectConfig()` accepts `projectRoot` and emits a warning for each nonblank declared-coupling file path that does not exist.
- `handleConfigValidate()` passes the resolved project root into config validation.
- `tests/runtime/runtime-config.test.ts` covers the stale-file warning.

## Code Changes

- `src/runtime/config.ts`: checks declared-coupling file existence when a project root is supplied.
- `src/runtime/commands/command-handlers.ts`: passes `projectRoot` to `validateProjectConfig()`.
- `.scipquery.json`: refreshes the moved query and runtime command paths.
- `tests/runtime/runtime-config.test.ts`: adds regression coverage for stale declared-coupling paths.

## Validation

Completed checks:

```text
npx vitest run tests/runtime/runtime-config.test.ts
node dist/cli.js config-validate --json
filesystem stale-path check of .scipquery.json
npm run typecheck
npm run build
npm test
node dist/cli.js recent-duplicates --json
node dist/cli.js unused-params --json
node dist/cli.js reindex
node dist/cli.js diff-gate --json
```

Repository verification passed. The full test suite reported 64 passing test files and 319 passing tests. `recent-duplicates` returned no findings. `unused-params` returned an empty result. Reindexing completed successfully.

`diff-gate` still reports the two accepted warnings already tracked in this validation pass:

- `SQ36D93309ABEA`, `echo`: changed `isCompileTimeContractAssertion()` shares symbol parsing helpers with established `indexedDefinitionFromRow()`, but the semantics are different.
- `SQ30E6CF5F9B38`, `doc-reference`: README configuration examples cite changed cleanup query files; the example target remains intentional.

## Judgment

This was an output-trust and analyzer-context repair, not a detector algorithm change. Co-change and hidden-coupling analyzers use declared coupling paths literally, so stale paths remove intended context without producing an obvious error. Warning at config-validation time is the right behavior: it protects current analysis while still allowing historical configs or intentionally removed files to be reviewed by a maintainer.

## 2026-06-28 Bench Profiling Handler Addendum

`src/runtime/commands/command-handlers.ts` now also owns benchmark progress and
profile-event wiring. The declared-coupling freshness claim above is unchanged:
`config-validate` still passes `projectRoot` into `validateProjectConfig()`, and
the profiling path does not affect project config validation.

## 2026-06-30 Evidence Product Follow-Up

The `src/queries/cleanup/doc-drift.ts` freshness references remain accurate
after the file evidence product registry migration. Doc path evidence still
uses the same content-hash guard and citation extraction; only the persistent
cache read/write path moved to `src/storage/evidence-products.ts`.
