# Baseline Metadata Inheritance Result

Date: 2026-06-21

## Scope

This slice implements the baseline calibration action: when `diff-gate` reports a new finding against `.scipquery-baseline.json`, the finding should carry the underlying analyzer identity and action tier instead of only an opaque baseline string.

Implemented changes:

- `DiffGateFinding` now includes optional `sourceAnalyzer`.
- `DiffGateFinding` now includes optional `rootCauseKey`.
- Baseline findings now set `actionTier`.
- Baseline findings now set `groupKey` using the analyzer and parsed root cause.
- Baseline findings now set `file` and `relatedFiles` where the baseline identity contains file paths.
- Baseline messages and remediation now mention the underlying analyzer family.
- `.scipquery-baseline.json` remains version 1 with string findings.

## Regression Coverage

Updated `tests/queries/impact/incomplete-migration.test.ts`:

- The existing git-backed diff-gate fixture writes a temporary baseline missing one current health finding.
- The resulting `baseline` finding includes `sourceAnalyzer`, `rootCauseKey`, `groupKey`, inherited `actionTier`, and tier-aware remediation.

## Local Smoke

Repository: `/Users/aydansalois/Documents/GitHub/scip-query`

Raw output:

- `/tmp/scip-query-baseline-metadata-diff-gate.json`

Command:

```text
node dist/cli.js diff-gate --json
```

Result:

- Baseline check ran against `.scipquery-baseline.json`.
- No new baseline findings were produced in the current working tree.
- The only current findings remain:
  - `echo` on `isCompileTimeContractAssertion()` as `signal`.
  - `doc-reference` on `README.md` as `configuration-example` / `support`.

## Verification

Commands run successfully:

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "baseline findings"`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js diff-gate --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

`recent-duplicates` and `unused-params` returned zero rows.

Final `node dist/cli.js diff-gate --json` still exits 1 with the same two accepted findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` is now `citationKind: configuration-example` and `actionTier: support`.

## Judgment

Confirmed. Baseline findings can now inherit analyzer family, action tier, file evidence, and root-cause grouping without changing baseline file format.

## Next Action

The first implementation-priority queue from the calibration memo is complete. Continue with second-repo confirmation: expand the validation run to `Vega_2.0` and `SynthRunnerRust`, then compare whether the calibrated output fields behave across React-heavy and Rust/capability-boundary corpora.
