# Health Findings Cleanup

## Goal

Fix every legitimate current health finding without disturbing the optimization work. A health finding is a scip-query report about a concrete source symbol or file that either lowers the health score or appears in the health action list because it may represent removable risk or hygiene debt.

## Current State

- `node dist/cli.js reindex` completed before the sweep.
- `node dist/cli.js health --full --json` reports score `99`, risk `100`, hygiene `99`.
- The only score deduction is `similar`: `8 similar function pair(s)`.
- Health actions also report `1` dead symbol, `5` stale abstractions, and `2` extraction candidates.
- `node dist/cli.js cleanup-plan --verify --json` verified two production-dead exports:
  - `src:analysis:similarity:computeIdf()` in `src/analysis/similarity.ts:66`.
  - `src:queries:public-query-entries:QUERY_SOURCE_PATHS` in `src/queries/public-query-entries.ts:184`.
- `node dist/cli.js stale-abstractions --json --full` reported five medium-confidence single-consumer type/interface signals:
  - `FileEvidenceKind`, `ReactComponentProfileOptions`, `VueComponentProfileOptions`, `SemanticReferenceCacheEntry`, and `FileAddRecord`.
- `node dist/cli.js extract-candidates --json --limit 2` reported only workflow-orchestration signals for `runProjectSetup()` and `buildChunkCalleeMap()`.
- `node dist/cli.js similar --json --full` and `node dist/cli.js __health-phase similar` showed the eight score-affecting similar pairs are all `actionTier: "signal"`, mostly access/query scaffolding or mixed orchestration.

## Reuse Audit

- `computeIdfFromDocFreq()` is the production helper that remains. The dead `computeIdf()` wrapper only builds document frequencies for tests and has no callers.
- `PUBLIC_QUERY_SOURCE_PATHS` and `PRIVATE_QUERY_SOURCE_PATHS` already hold the manifest data. The dead combined `QUERY_SOURCE_PATHS` export can move into the CLI contract test as local test setup.
- Source suppression comments are already the detector-owned mechanism for accepted broad-candidate findings. `ProjectIndex.hasSuppressionComment()` and `productionCallableDefinitions()` use those comments before stale/similar/extract detectors score candidates.

## Design Phases

1. Delete true dead exports.
   - Remove `computeIdf()` from `src/analysis/similarity.ts`.
   - Update similarity tests to assert `computeIdfFromDocFreq()` directly.
   - Remove exported `QUERY_SOURCE_PATHS` from `src/queries/public-query-entries.ts`.
   - Build the combined manifest locally in `tests/runtime/cli-contract.test.ts`.

2. Record accepted heuristic signals at the source definitions.
   - Add `scip-query: ignore-stale` comments to the five named cache/profile/history record types because each is a named boundary record, not an accidental one-use type.
   - Add `scip-query: ignore-extract` comments to `runProjectSetup()` and `buildChunkCalleeMap()` because both reports are workflow-orchestration signals whose current sequence preserves behavior and performance evidence.
   - Add `scip-query: ignore-similar` comments to one side of each accepted similar family so the health detector omits scaffolding/parallel-command overlap without requiring risky abstraction.

3. Verify behavior and health.
   - Run focused tests for similarity, similar cleanup, CLI contract, project setup/call graph if available.
   - Run typecheck/build as the repo supports.
   - Run `node dist/cli.js reindex`.
   - Run `node dist/cli.js diff-gate --json`.
   - Run `node dist/cli.js health --full --json` and confirm no legitimate unhandled finding remains.

## Stress Test

- Removing `computeIdf()` must not alter IDF math because `computeIdfFromDocFreq()` stays unchanged.
- Moving `QUERY_SOURCE_PATHS` into the test must not publish a new public manifest API.
- Suppression comments must sit within the detector's five-line scan window above the target definition.
- Accepted comments must explain the boundary or orchestration role so they are not score-hiding noise.
- If health still reports new lower-ranked similar rows after comments, classify them with the same standard before adding more comments.

## Execution Order

1. Patch source/test imports and local test helpers.
2. Patch accepted-finding comments near the target definitions.
3. Run focused tests.
4. Reindex and run health/diff-gate.
5. Adjust only if new direct findings appear.

## Ship Order

Ship as one cleanup change: true dead-code deletion plus accepted health-signal documentation. This keeps the health score aligned with reviewer intent and preserves optimization-sensitive code paths.

