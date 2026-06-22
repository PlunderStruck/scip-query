# Extract Candidate Evidence Classification Result

Date: 2026-06-21

## Scope

This slice implements the extraction-candidate output-quality action: the detector should not only list isolated callee clusters; it should explain the kind of extraction signal and remind reviewers that extraction is contextual design work.

Implemented changes:

- `ExtractCandidate` now includes `extractionKind`.
- `ExtractCandidate` now includes `actionTier: 'signal'`.
- `ExtractCandidate` now includes `evidenceReasons`.
- `ExtractCandidate` now includes `recommendation`.
- `extract-candidates` text output prints kind, tier, recommendation, and evidence reasons before cluster details.
- Health scoring and baseline identities are unchanged.

## Regression Coverage

Added `tests/queries/cleanup/extract-candidates-output.test.ts`:

- Builds a focused SCIP fixture with one orchestration function and two disconnected callee groups.
- Asserts the row remains visible.
- Asserts `extractionKind: 'workflow-orchestration'`.
- Asserts `actionTier: 'signal'`.
- Asserts evidence reasons include callee count, cluster count, and isolation evidence.
- Asserts the recommendation warns reviewers to preserve orchestration when it is clearer.

## Local Smoke

Repository: `/Users/aydansalois/Documents/GitHub/scip-query`

Command:

```text
node dist/cli.js extract-candidates --json --limit 5
```

Top rows now include the new review fields:

| Symbol | Kind | Tier | Evidence reason |
| --- | --- | --- | --- |
| `src:queries:impact:incomplete-migration:incompleteMigration()` | `workflow-orchestration` | `signal` | `callee breadth suggests orchestration: 11 callees` |
| `src:queries:cleanup:cleanup-plan:cleanupPlan()` | `workflow-orchestration` | `signal` | `callee breadth suggests orchestration: 16 callees` |
| `src:queries:frontend:vue-composable-candidates:compareProfiles()` | `broad-helper-cluster` | `signal` | `one isolated helper group is broad enough to deserve a named review` |
| `src:queries:frontend:react-hook-candidates:compareProfiles()` | `broad-helper-cluster` | `signal` | `one isolated helper group is broad enough to deserve a named review` |
| `src:queries:impact:diff-gate:runEchoCheck()` | `workflow-orchestration` | `signal` | `caller verb suggests orchestration: run` |

## Vega Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
Revision: `6288855333faf33ba395fa804eb9b03c0a04989e`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/extract-candidate-evidence-classification/extract-candidates-full.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js extract-candidates --full --json
```

Result:

- Total rows: 213
- Action tiers: `signal` 213
- Extraction kinds: `workflow-orchestration` 174, `broad-helper-cluster` 14, `cohesive-helper-cluster` 25

Top sample rows were mostly React route/component controller or orchestration functions. The new output makes that visible: rows still point at possible helper clusters, but the recommendation no longer implies that extraction is automatically correct.

## Verification

Commands run successfully before final gate:

- `npx vitest run tests/queries/cleanup/extract-candidates-output.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js extract-candidates --json --limit 5`
- Vega `extract-candidates --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with the same two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

`npm test` still prints a noisy `git diff` usage warning from an existing test path, but Vitest reports all 314 tests passed.

## Judgment

Confirmed. `extract-candidates` now behaves like a contextual extraction-pressure analyzer in both schema and prose. The detector still returns the same rows, but agents now get enough evidence to distinguish workflow orchestration from a broad helper cluster and to avoid direct-repair framing.

## Next Action

Continue the contextual signal review with `stale-abstractions`, focusing on whether its current `confidence` and `reason` fields are enough or need action-tier/recommendation output.
