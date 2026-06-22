# scip-query Setup Skill and Locality Config Plan

Date: 2026-06-22

## Objective

Add repo-specific configuration for locality architectural boundary folders, create a setup skill that tells agents how to adopt scip-query properly, and run a validation pass focused on when `locality-candidates` should still emit an exact `suggestedHome`.

An architectural boundary folder is a source directory that groups code because it owns a system-level responsibility, such as effects, errors, routes, workflow orchestration, schemas, or persistence. Its defining trait is that a broad consumer set can be evidence that the boundary is doing its job, so locality review should not automatically demote it into a generic `shared` folder.

A suggested home is an exact destination directory emitted by `locality-candidates` when indexed consumer evidence points to an existing, source-root-safe owner. Its defining trait is that it is strong enough to name a destination while still remaining a review signal, not an automatic move instruction.

## Code Evidence

- `src/domain/config-types.ts:67` defines `ScipQueryConfig`, and `src/domain/config-types.ts:88` defines the project `.scipquery.json` shape that can carry repo-specific settings.
- `src/runtime/config.ts:63` validates `.scipquery.json`, so new config should reject malformed boundary segment entries.
- `src/runtime/cli-context.ts:39` maps project config into the database config used by query commands.
- `src/runtime/query-commands/cleanup/handlers.ts:158` invokes `queries.localityCandidates()` for the CLI command.
- `src/queries/cleanup/locality-candidates.ts:134` currently hardcodes architectural boundary folder names, and `src/queries/cleanup/locality-candidates.ts:668` uses them to withhold generic shared destinations.

## Checklist

- [x] Extend config types with `locality.architecturalBoundarySegments`.
- [x] Validate that the locality boundary setting is an array of non-empty strings.
- [x] Pass configured boundary segments from CLI project config into `locality-candidates`.
- [x] Merge configured boundary segments with built-in defaults inside the analyzer.
- [x] Apply boundary-folder withholding to direct and existing shared-owner destinations, not only invented `shared` folders.
- [x] Add regression tests proving repo-specific and built-in boundary names withhold exact destinations.
- [x] Create a repo-local `skills/scip-query-setup` skill using the skill scaffold workflow.
- [x] Run and record a positive `suggestedHome` validation pass on real repositories.
- [x] Update the analyzer validation ledger with the new validation result.
- [x] Run lint, typecheck, tests, build, `scip-query reindex`, and `scip-query diff-gate`.

## Validation Strategy

The validation pass will search for rows where `destinationConfidence` is `exact` and `suggestedHome` is non-null. At least a small sample should be manually inspected to distinguish:

- true exact homes where the existing destination is a better owner;
- exact but low-action same-file or sibling-folder rows;
- false exact homes that need another withholding rule or a repo-specific boundary segment.

Raw command output should stay under `/tmp/scip-query-validation/2026-06-22-locality-positive-suggested-home`.
