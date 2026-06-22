# Performance and Budget Behavior Result

Date: 2026-06-21

## Verdict

AVL-008 is complete. The large-index budget behavior is honest: default `health` warns when candidate-style checks are capped, `health --full` warns that caps are removed, standalone candidate commands cap by default, and `--full` lifts the result cap. The remaining risk is latency, not misleading output: default health on the two large corpora took 78-114 seconds even with candidate caps.

## Corpus

- `Stable_Management`
  - status: fresh index
  - symbols: 108,885
  - files: 1,619
  - working tree: existing dirty tree; run was read-only against current files
- `Vega_2.0`
  - status: fresh index
  - symbols: 102,689
  - files: 1,758
  - languages: TypeScript and Python
  - working tree: clean during status check

Raw JSON was captured under `/tmp/scip-query-validation/2026-06-21-budget`.

## Composite Health Measurements

| Repo | Command | Time | Warning | Key Count Changes |
| --- | --- | ---: | --- | --- |
| Stable_Management | `health --json` | 78.25s | capped: scans top 2,500 symbols and reports top 50 findings | `similarPairs` 50, `staleTypes` 50 |
| Stable_Management | `health --full --json` | 74.95s | unbounded because `--full` was supplied | `similarPairs` 109, `staleTypes` 63 |
| Vega_2.0 | `health --json` | 114.30s | capped: scans top 2,500 symbols and reports top 50 findings | `reactHookCandidatePairs` 50, `wrappers` 50, `passthroughs` 50, `staleTypes` 50, `hiddenCouplingPairs` 50 |
| Vega_2.0 | `health --full --json` | 117.57s | unbounded because `--full` was supplied | `reactHookCandidatePairs` 87, `reactLargeComponentPressureFiles` 192, `wrappers` 92, `passthroughs` 102, `staleTypes` 110, `hiddenCouplingPairs` 139 |

Judgment: the cap is visible and materially changes counts. The similar runtime for default and full means the current cap mainly limits candidate result volume and some candidate scan work; it does not make composite health fast on large repos.

## Standalone Candidate Measurements

On `Vega_2.0`:

- `react-hook-candidates --json`: 2.47s, 20 rows.
- `react-hook-candidates --full --json`: 2.52s, 87 rows: 45 `signal`, 42 `support`.
- `react-hook-candidates --full --limit 5 --json`: failed with `--full cannot be combined with --limit. Use --full for all findings, or --limit N for a capped report.`

Judgment: standalone budget behavior is correct and clear.

## Residual Risk

- Composite `health` still takes more than a minute on large TypeScript corpora even in capped mode.
- The warning explains count caps, but not expected runtime. If we want a stricter performance target, add a future benchmark gate with explicit wall-clock expectations per corpus size.
- Mixed-language capability boundaries are reported in `status`; `health` itself does not repeat Python semantic-provider limitations. That is acceptable for this slice because AVL-010 already records capability-matrix behavior.

## Verification

Completed after doc and package-export updates:

- `npm run typecheck`
- `npm test`: 64 files, 323 tests.
- `npm run build`
- `node -e "import('./dist/queries/unused-imports.js')..."`
- `./dist/cli.js recent-duplicates --json`: no findings.
- `./dist/cli.js unused-params --json`: no findings.
- `./dist/cli.js reindex`
- `./dist/cli.js diff-gate`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

The next validation slice should be AVL-011, agent repair outcomes. The analyzer taxonomy, command surface, implementation wiring, capability boundaries, and budget behavior now have enough validation to test whether acting on findings improves code rather than producing churn.
