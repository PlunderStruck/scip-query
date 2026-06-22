# Direct Small Analyzer Verdicts Result

Date: 2026-06-21

## Verdict

This AVL-002 slice is complete for `unused-imports`, `unused-params`, and `redundant-reexports`.

A direct small analyzer is a low-blast-radius cleanup detector whose finding should correspond to a local edit, such as removing one unused import, one unused parameter, or one unused barrel re-export. Its value comes from being boringly precise: if it cannot distinguish a public surface or executable entrypoint from dead cleanup, it should not be treated as automatic repair evidence.

Raw output was captured under `/tmp/scip-query-validation/2026-06-21-direct-verdicts`.

## Corpus

| Repo                | Revision                                   | Working tree note                                            |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `scip-query`        | `7aa69e4c6701c04213106c803ce2c4a9e167ccec` | current validation branch/worktree                           |
| `Vega_2.0`          | `6288855333faf33ba395fa804eb9b03c0a04989e` | clean during status check                                    |
| `Stable_Management` | `2354b4e385088aa90559c20ea8b270f14bfa47f3` | existing dirty user worktree; read-only run                  |
| `SynthRunnerRust`   | `658a52d355e8733d6ce759e77b84735a47ef3048` | existing dirty user worktree from prior slice; read-only run |

## `unused-imports`

Verdict: true positives in sampled TypeScript/Vue files.

Scans:

- `Vega_2.0`: scanned 350 TypeScript/TSX files, found 3 files with findings.
- `Stable_Management`: scanned 350 TypeScript/TSX/Vue files, found 2 files with findings.

Reviewed samples:

| Repo                | File                                                   | Finding                                                                                | Verdict | Evidence                                                                      |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `Stable_Management` | `backend/src/effect/responseEnvelope.ts`               | `AppServices`                                                                          | `tp`    | The name appears in the import and an example comment, not in live type code. |
| `Stable_Management` | `backend/src/workflows/serviceTasks.ts`                | `HorseHistoryRow`                                                                      | `tp`    | The name appears only in the type import list.                                |
| `Vega_2.0`          | `packages/companion/src/cli.ts`                        | `registerDevice`, `discoverCompanionAgentCapabilities`, `writeJson`                    | `tp`    | Each name appears only in the import list.                                    |
| `Vega_2.0`          | `packages/companion/src/agent-project-context.test.ts` | `AgentRepoBindingSelectionInput`                                                       | `tp`    | The type name appears only in the import list.                                |
| `Vega_2.0`          | `packages/shared/tests/coding-agent-activity.test.ts`  | `WorkSessionActivityEventLike`, `WorkSessionActivityProjection`, `WorkSessionItemType` | `tp`    | Each type name appears only in the import list.                               |

Repair outcome: `not_attempted` in external repos, but the local edit is clear: remove the unused named import from the file. This analyzer remains direct.

Residual risk: the command is file-scoped, so whole-repo validation requires a wrapper scan or future repo-wide mode.

## `unused-params`

Verdict: clean corpus sample.

Repo-wide results:

- `scip-query`: 0
- `Vega_2.0`: 0
- `Stable_Management`: 0
- `SynthRunnerRust`: 0

Judgment: no live positive rows were available in this slice. The analyzer remains direct by contract, but this slice cannot add repair-outcome evidence beyond confirming it does not emit noisy field rows on the sampled corpus.

## `redundant-reexports`

Initial verdict: false positives on executable `index.ts` entrypoints.

Before the fix, `Vega_2.0` reported 21 rows under `apps/api/src/index.ts`. Source review showed that file imports startup dependencies and calls them; it does not export symbols. Examples included `createApp`, `checkDatabaseConnection`, `runMigrations`, `initializeRateLimitStores`, and websocket handler registration functions.

Precision action: fixed root detection.

- `findScipRedundantReexports()` now skips SCIP-backed candidates when the candidate barrel file has no source-level exports.
- Added a regression test proving an executable `src/index.ts` that imports and calls `boot()` is not treated as a redundant re-export barrel.

After the fix:

- `Vega_2.0` `redundant-reexports --json`: 0 rows.
- Targeted regression: `tests/queries/cleanup/redundant-reexports-fallback.test.ts` now has 2 passing tests.

Judgment: this analyzer remains direct only for files that are actually export barrels and not package-public API. Executable entrypoints must be excluded, and public package API barrels are now signal rows with package-surface evidence.

## Calibration Decision

- Keep `unused-imports` as direct repair.
- Keep `unused-params` as direct repair, but mark this slice as clean-corpus rather than positive repair validation.
- Keep `redundant-reexports` as direct only after source-export gating and package-surface classification. Do not auto-apply removals for package public API barrels; those now emit signal-tier caveats.

## Verification

Completed for the implementation fix:

- `npx vitest run tests/queries/cleanup/redundant-reexports-fallback.test.ts`
- `npx vitest run tests/queries/cleanup/redundant-reexports-fallback.test.ts tests/queries/health/debloat-health.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm test`: 64 files, 324 tests. Vitest passed; it still prints the existing noisy `git diff` usage warning from one test path.
- `Vega_2.0` `redundant-reexports --json` after rebuild: 0 rows.
- `node dist/cli.js recent-duplicates --json`: no findings.
- `node dist/cli.js unused-params --json`: no findings.
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

Continue AVL-002 with the remaining direct repair families: `passthrough-candidates`, real `cycles`, broken `doc-drift` references, and the remaining direct/deletion analyzers not already covered by the precision slices.
