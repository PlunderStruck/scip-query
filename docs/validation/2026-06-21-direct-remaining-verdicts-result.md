# Direct Remaining Verdicts Result

Date: 2026-06-21

## Verdict

This AVL-002 slice is complete for `passthrough-candidates`, real `cycles`, and broken `doc-drift` references.

A literal passthrough is a function or method whose body only forwards its arguments to one callee. That source shape is weaker than a deletion claim: the wrapper may still be the stable name, adapter boundary, facade, trait/interface surface, or public API that consumers should depend on.

A direct doc-drift finding is a documentation reference to a code path that no longer exists. Ordinary doc staleness from churn is a contextual signal because the correct repair may be update, archive, split, or leave historical notes intact.

Raw output was captured under `/tmp/scip-query-validation/2026-06-21-direct-remaining`.

## Corpus Counts

| Repo                | `passthrough-candidates` | `cycles` | `doc-drift` |
| ------------------- | -----------------------: | -------: | ----------: |
| `scip-query`        |                        0 |        0 |           2 |
| `Vega_2.0`          |                      131 |        0 |          20 |
| `Stable_Management` |                        0 |        0 |          20 |
| `SynthRunnerRust`   |                        2 |       13 |           9 |

## `passthrough-candidates`

Verdict: valid shape detector, not safe as a direct repair claim without boundary evidence.

Reviewed examples:

| Repo              | Candidate                                                                        | Verdict           | Evidence                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `Vega_2.0`        | `OrgStorageAdapter.decryptKey()` -> `decryptStoredSecret()`                      | `accepted_design` | Adapter method preserves the storage boundary and stable vocabulary while delegating encryption mechanics. |
| `Vega_2.0`        | `AISettingsService.getModelProfiles()` -> `AIProviderManager.getModelProfiles()` | `accepted_design` | Service facade boundary; consumers should not necessarily import the provider manager directly.            |
| `Vega_2.0`        | `LocalStorageProvider.getDownloadUrl()` -> `getPublicUrl()`                      | `needs_judgment`  | Could be direct alias cleanup, but URL semantics may intentionally differ by provider contract.            |
| `Vega_2.0`        | `StorageService.delete()` -> provider `delete()`                                 | `accepted_design` | Public service/provider boundary, not just avoidable indirection.                                          |
| `SynthRunnerRust` | `app::run()` -> `build_app().run()`                                              | `accepted_design` | Public app entrypoint with readable lifecycle name.                                                        |
| `SynthRunnerRust` | `BubbleTrail.render_particles()` -> slot mapping helper                          | `needs_judgment`  | Shape is passthrough-like, but the method preserves object API vocabulary around render output.            |

Calibration decision:

- Move passthrough from default direct repair to contextual signal unless output can show no boundary role.
- Future precision work should emit `actionTier`, boundary evidence, and recommendation text, similar to wrappers.
- Health scoring should eventually count only direct passthrough rows or use a lower signal pressure weight.

## `cycles`

Verdict: real cycles remain direct architecture repairs.

Corpus result:

- `scip-query`: 0
- `Vega_2.0`: 0
- `Stable_Management`: 0
- `SynthRunnerRust`: 13

Reviewed SynthRunnerRust samples:

| Cycle                                                           | Verdict           | Evidence                                                                        |
| --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `src/pool.rs -> src/world.rs -> src/pool.rs`                    | `tp`              | Files mutually depend on runtime world types and pool constants/entities.       |
| `src/app.rs -> src/world_visuals.rs -> src/app.rs`              | `tp`              | App assembly imports visual sync while visual code imports app/world resources. |
| `src/diagnostics.rs -> src/visualizer.rs -> src/diagnostics.rs` | `tp`              | Diagnostics and visualizer are mutually coupled.                                |
| `src/world.rs -> tests/resource_split.rs -> src/world.rs`       | `accepted_design` | Correctly classified as `module-hierarchy`, not a real repair.                  |

Calibration decision: keep `cycles` direct only for `kind: "real"`. `module-hierarchy` should remain support/output context and should not reduce score like architectural cycles.

## `doc-drift`

Verdict: broken references are direct; staleness-only rows are signal.

Corpus result:

- `scip-query`: 2 staleness-only rows, 0 broken references.
- `Vega_2.0`: 20 rows, 140 broken references.
- `Stable_Management`: 20 staleness-only rows, 0 broken references.
- `SynthRunnerRust`: 9 staleness-only rows, 0 broken references.

Reviewed Vega broken references:

| Doc                                   | Broken reference                                                        | Verdict |
| ------------------------------------- | ----------------------------------------------------------------------- | ------- |
| `docs/root-docs/ORPHANED_FEATURES.md` | `reports/regression/2026-04-14-billing-ui-and-role-helper-removal.md`   | `tp`    |
| `docs/root-docs/ORPHANED_FEATURES.md` | `apps/api/src/modules/vega-assistant/runtime/vega-run-state.service.ts` | `tp`    |
| `docs/root-docs/ORPHANED_FEATURES.md` | `apps/web/src/components/landing/persona/PersonaPillRail.tsx`           | `tp`    |
| `docs/CLEANUP_AUDIT_FINDINGS.md`      | `packages/companion/src/local-llm/premium-agent-loop.ts`                | `tp`    |
| `docs/CLEANUP_AUDIT_FINDINGS.md`      | `apps/web/src/routes/platform/PlatformInstances.tsx`                    | `tp`    |

Each sampled path was absent from the Vega working tree. The repair is direct doc cleanup: update the path, remove the stale citation, or archive the doc if it is historical.

Calibration decision:

- Keep `brokenReferences.length > 0` as direct doc cleanup.
- Keep churn/reference staleness without broken paths as signal.
- Do not score staleness-only rows as direct repair debt.

## Remaining Precision Work

- Add `actionTier` and boundary evidence to `passthrough-candidates`.
- Adjust health scoring so passthrough rows do not all deduct as direct hygiene debt.
- Keep `cycles` direct only for `kind: "real"`.
- Keep `doc-drift` direct only for broken references; staleness-only rows should be contextual signal.

## Verification

Completed after this doc update:

- `npm run typecheck`
- `npm run build`: completed in the preceding implementation slice after the redundant-reexports fix.
- `npm test`: 64 files, 324 tests. Vitest passed; it still prints the existing noisy `git diff` usage warning from one test path.
- `node dist/cli.js recent-duplicates --json`: no findings.
- `node dist/cli.js unused-params --json`: no findings.
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

Continue AVL-002 with the remaining deletion-family verdicts: `dead`, `isolated`, `new-dead`, `cleanup-plan`, and `doc-reference`/`incomplete-migration` direct-gate evidence that has not yet been summarized into one closing direct-family ledger result.
