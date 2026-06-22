# Direct Deletion Family Closure Result

Date: 2026-06-21

## Verdict

AVL-002 is complete. Every direct repair analyzer in the ledger now has a reviewed verdict, an implementation fix, or an explicit tier correction.

A deletion-family analyzer is a detector whose claim is that a code or docs surface can usually be removed, wired, or corrected locally because the analyzer has found missing consumers, an unfinished migration, a broken reference, or a dependency cycle. The essential distinction is repairability: direct rows should point to a bounded action, while contextual rows should only guide review.

Raw output for the final spot checks was captured under `/tmp/scip-query-validation/2026-06-21-direct-remaining` and `/tmp/scip-query-validation/2026-06-21-direct-deletion-family-closure`.

## Closing Matrix

| Analyzer                      | Verdict                                                            | Evidence                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanup-plan`                | Direct and verified                                                | `SynthRunnerRust` `cleanup-plan --verify --json` removed two dead functions across 9 LOC and passed `cargo check --quiet --manifest-path Cargo.toml` in a temporary worktree.                                  |
| `dead`                        | Direct only for `kind: dead-code`                                  | `SynthRunnerRust` `dead --only-dead --json` produced two `dead-code` rows; `scip-query` produced 0 shown dead-code rows. Earlier output-schema work clarified `shown.deadCode` versus file-internal inventory. |
| `isolated`                    | Direct when present; clean sampled corpus                          | `scip-query` and `SynthRunnerRust` both returned 0 rows in the final spot check.                                                                                                                               |
| `unused-imports`              | Direct                                                             | Stable and Vega sampled file scans produced true positives where imported names appeared only in import lists or comments.                                                                                     |
| `unused-params`               | Direct by contract; clean sampled corpus                           | `scip-query`, `Vega_2.0`, `Stable_Management`, and `SynthRunnerRust` returned 0 rows.                                                                                                                          |
| `redundant-reexports`         | Direct only for actual export barrels                              | Vega false positives on executable `apps/api/src/index.ts` were fixed by requiring source-level exports when source text is available; after rebuild Vega returned 0 rows.                                     |
| `passthrough-candidates`      | Signal until boundary evidence exists                              | Vega and Synth samples were mostly adapters, facades, service/provider boundaries, public entrypoints, or object API vocabulary. Direct repair needs new boundary evidence fields.                             |
| `cycles`                      | Direct for `kind: real`                                            | SynthRunnerRust produced real cycles such as `src/pool.rs -> src/world.rs -> src/pool.rs`; module-hierarchy/test cycles remain non-direct.                                                                     |
| Broken `doc-drift` references | Direct                                                             | Vega produced 140 missing path references; sampled paths were absent from the working tree. Staleness-only doc drift remains signal.                                                                           |
| `new-dead`                    | Direct for runtime symbols, filtered for compile-time contracts    | The type-contract filter prevents `_Assert*`/compile-time assertion aliases from being treated as new runtime dead code.                                                                                       |
| `doc-reference`               | Direct only for behavior/doc-claim citations; support for examples | Citation-kind output now marks README declared-coupling examples as `configuration-example` / `support` instead of direct doc-update debt.                                                                     |
| `incomplete-migration`        | Direct only with helper-shape/semantic containment evidence        | Earlier calibration found callee-containment-only rows too broad; implementation added stronger helper-shape and support classifications.                                                                      |

## Residual Precision Actions

- Add `actionTier`, boundary evidence, and score weighting to `passthrough-candidates`.
- Keep `doc-reference` warning-level unless citation kind indicates a behavioral claim or broken doc contract.
- Keep `doc-drift` staleness-only rows as signal.
- Keep `isolated` and `dead` guarded by entry/root/framework detection.
- Keep direct analyzer repair behavior tied to checker-backed validation where possible.

## Ledger Decision

AVL-002 moves to `complete`.

The remaining open validation work is no longer about direct verdict coverage. It is:

- AVL-003 contextual signal analyzer verdict closure.
- AVL-006 score calibration finalization.
- AVL-007 output/schema quality finalization.

## Verification

Completed after the implementation and closure doc updates:

- `npm run typecheck` passed.
- `npm run build` passed during the redundant-reexports executable-index fix.
- `npm test` passed 64 files / 324 tests. The run still prints the known noisy `git diff` usage warning from an existing test path.
- `node dist/cli.js recent-duplicates --json` returned no findings.
- `node dist/cli.js unused-params --json` returned no findings.
- `node dist/cli.js reindex` rebuilt the TypeScript shard successfully.
- `node dist/cli.js diff-gate --json` exited with two accepted warning-level findings:
  - `echo`: `src:queries:impact:diff-gate:isCompileTimeContractAssertion()` remains intentionally parallel to `src:symbols:definition-catalog:indexedDefinitionFromRow()` because both parse symbol leaf names, but they make different product decisions.
  - `doc-reference`: `README.md` cites `dead.ts` and `stale-abstractions.ts` as declared-coupling configuration examples; the example target is still intentional, so no README edit is required.

## Next Slice

Completed by `docs/validation/2026-06-21-contextual-signal-closure-result.md`.
