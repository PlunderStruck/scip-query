# Diff Gate Performance Plan

## Gate A - Goal

Make `scip-query diff-gate` complete in time proportional to the current diff, so large repositories do not pay for a full health-baseline scan unless the caller explicitly asks for that global ratchet.

Done means a normal `diff-gate --json` run no longer executes the baseline health comparison by default, while an explicit option still preserves the old full-baseline behavior for CI or humans who want it.

Sources:

- `scip-query plan-context diff-gate`
- `/usr/bin/time -p scip-query diff-gate --json`
- `/usr/bin/time -p scip-query diff-gate --json --skip baseline`

## Gate B - Current Flow

- In `src/queries/impact/diff-gate.ts:160-223`, `diffGate()` computes `diffImpactPlan()` and `diffImpact()`, then runs each gate check serially, including `runBaselineCheck()` at lines 217-218.
  Source: `scip-query trace diffGate`

- In `src/queries/impact/diff-gate.ts:330-389`, `runEchoCheck()` caps changed symbols with `maxEchoChecks`, but each checked symbol calls `similar()` without a `scanLimit`.
  Source: `scip-query code runEchoCheck -C 12`

- In `src/queries/cleanup/similar.ts:64-81`, `similar()` calls `compareAgainstFingerprints()`, and `src/queries/cleanup/similar.ts:369-390` builds a whole-corpus callee fingerprint index unless a scan limit reaches `getAllCalleeFingerprints()`.
  Source: `scip-query code similar -C 12` and `scip-query trace getCalleeFingerprintIndex`

- In `src/queries/impact/incomplete-migration.ts:90-210`, `incompleteMigration()` caps helpers with `maxHelpers`, but it still builds the candidate index from `getAllCalleeFingerprints()` without a `scanLimit`.
  Source: `scip-query code incompleteMigration -C 12`

- In `src/queries/impact/diff-gate.ts:782-819`, `runBaselineCheck()` calls `checkHealthBaseline(db)` whenever `.scipquery-baseline.json` exists.
  Source: `scip-query code runBaselineCheck -C 12`

- In `src/queries/health/health-baseline.ts:135-155`, `checkHealthBaseline()` reads the committed baseline and calls `collectBaselineFindings(db)`.
  Source: `scip-query code checkHealthBaseline -C 12`

- In `src/queries/health/health-baseline.ts:62-112`, `collectBaselineFindings()` runs dead, isolated, cycles, similar, extract, wrapper, passthrough, stale, and drift detectors. This is a repository health scan, not a diff-sized check.
  Source: `scip-query code collectBaselineFindings -C 12`

- On the current workspace diff, normal `diff-gate --json` took about 6.5s, `--skip baseline` took about 2.6s, and baseline alone took about 4.25s. The baseline finding reported files unrelated to the changed files, showing the check is global.
  Source: `/usr/bin/time -p scip-query diff-gate --json --skip echo --skip incomplete-migration --skip co-change-partner --skip doc-reference --skip unused-params --skip new-dead`

## Gate C - Reuse Audit

- Keep `checkHealthBaseline()` and `writeHealthBaseline()` as the existing global ratchet used by `health --baseline`; do not duplicate health-baseline comparison logic.
  Source: `scip-query refs checkHealthBaseline`

- Reuse `DIFF_GATE_CHECKS` validation for the existing `--skip baseline` behavior and add only one explicit option to `diff-gate`.
  Source: `scip-query code DIFF_GATE_CHECKS -C 12`

- Reuse the existing large-index budget helper from `src/runtime/cli-support.ts:61-85`, which supplies `scanLimit` plus a semantic-analysis toggle and already backs other bounded cleanup commands.
  Source: `scip-query code commandAnalysisBudget -C 25`

## Steps

- [x] In `src/queries/impact/diff-gate.ts:162-170` and `src/queries/impact/diff-gate.ts:217-218`, add `includeBaseline?: boolean`, `scanLimit?: number`, and `semantic?: boolean` options. Run `runBaselineCheck()` only when `includeBaseline` is true. Pass the scan budget into echo and incomplete-migration.
      Source: `scip-query trace diffGate`

- [x] In `src/queries/impact/incomplete-migration.ts:90-210`, add `scanLimit?: number` to the query options and pass it to `getAllCalleeFingerprints()`.
      Source: `scip-query code incompleteMigration -C 12`

- [x] In `src/runtime/query-commands/impact.ts:193-213`, compute the shared command analysis budget with hook/json quieting, pass `includeBaseline`, `scanLimit`, and `semantic` into `diffGate()`, and add a `--full` option as the escape hatch for unbounded semantic analysis on large indexes.
      Source: `scip-query code src/runtime/query-commands/impact.ts:190-340`

- [x] In `src/runtime/query-commands/impact.ts:319-340`, add `--baseline` with copy that says it runs the full health-baseline comparison.
      Source: `scip-query code src/runtime/query-commands/impact.ts:295-380`

- [x] Update the user-facing description in `src/runtime/query-commands/impact.ts:319-340` so the default check list no longer implies a global baseline run.
      Source: `scip-query code src/runtime/query-commands/impact.ts:295-380`

- [x] Add or update tests for the default path and explicit baseline path in the existing CLI/runtime tests discovered after code inspection, taking care not to overwrite unrelated working-tree edits.
      Source: `scip-query rdeps src/runtime/query-commands/impact.ts`

- [x] Verify the speed regression directly: time `scip-query diff-gate --json` and `scip-query diff-gate --json --baseline` after the change.
      Source: `/usr/bin/time -p scip-query diff-gate --json --skip baseline`

- [x] Run `scip-query reindex`, `scip-query diff-impact --json`, relevant postchecks for changed CLI options, and `scip-query diff-gate --json`.
      Source: `scip-query affected diffGate --json`
