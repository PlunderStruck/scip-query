# Second-Corpus Score-Weight Confirmation Result

Date: 2026-06-22

## Verdict

The second-corpus score-weight slice is complete. Clean `Vega_2.0` confirmed that broad candidate families are mostly behaving conservatively, but it exposed one score-weight bug: raw hidden-coupling counts treated broad-sweep contract migrations as full-strength focused coupling.

A score weight is the numeric strength an analyzer row contributes to health scoring. It should preserve the raw finding count for review while discounting rows whose evidence is weaker. For co-change evidence, a focused recent pair is stronger because it shows two files repeatedly moving together in small commits; a broad-sweep pair is weaker because it may come from large migration work rather than an ongoing coordination contract.

## Raw Outputs

Raw output root:

```text
/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0
```

Repository:

- Path: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Revision: `6288855333faf33ba395fa804eb9b03c0a04989e`
- Working tree: clean
- `reindex`: reused existing TypeScript/Python index

Commands captured:

- `health --full --json`
- `similar --full --json`
- `wrapper-candidates --json`
- `wrapper-candidates --limit 200 --json`
- `passthrough-candidates --json`
- `passthrough-candidates --limit 200 --json`
- `react-component-duplicates --full --json`
- `react-hook-candidates --full --json`
- `react-large-component-pressure --full --json`
- `co-change --json`
- `diff-gate --json`
- `stale-abstractions --json`
- `extract-candidates --json`
- post-change `health --full --json`

## Corpus Evidence

Before the score-weight change, Vega health reported:

| Metric                   | Value |
| ------------------------ | ----: |
| Overall score            |    77 |
| Risk score               |    89 |
| Hygiene score            |    77 |
| Hidden-coupling pairs    |   139 |
| Hidden-coupling points   |     5 |
| Hidden-coupling pressure |     6 |

The top hidden-coupling rows were broad-sweep recent contract/doc migration pairs such as `docs/api-standardization-inventory.md` with `docs/backend-http-route-api-standard.md`, and `docs/api-standardization-inventory.md` with `packages/shared/src/contracts/coverage.ts`. Their subject labels were mostly `contracts`, `docs`, `fix`, and `refactor`, and their sample subjects were contract-migration commits.

Other score families behaved as expected:

| Family                | Raw count | Score-weight behavior                                                                   |
| --------------------- | --------: | --------------------------------------------------------------------------------------- |
| Similarity            |        42 | 40 signal, 2 direct; only domain-behavior rows were direct.                             |
| Wrappers              |        79 | 74 signal, 5 direct; score-weighted count 23.5 under the 200-row sample.                |
| Passthroughs          |        91 | 74 signal, 17 direct; score-weighted count 35.5 under the 200-row sample.               |
| React hook candidates |        87 | 45 signal, 42 support; health score-weighted count 5.5.                                 |
| React large pressure  |       248 | Large React pressure remains the dominant hygiene issue, with route/component guidance. |
| Stale abstractions    |        30 | 2 direct unused abstractions, 28 signal rows.                                           |
| Extraction candidates |         4 | 4 workflow-orchestration signal rows.                                                   |

## Implementation

- `src/queries/health/health.ts` now computes `hiddenCoupling.scoreCount` from `commitScope` and `recency`.
- `src/queries/health/health-types.ts` exposes the score-weighted hidden-coupling count and per-top-row `scoreWeight`.
- `src/queries/health/health-report.ts` uses the weighted count for hidden-coupling base and pressure scoring, while preserving raw `hiddenCouplingPairs`.
- `tests/queries/health/health-report.test.ts` covers broad-sweep hidden coupling so raw pair count no longer creates a pressure row by itself.

Weights:

| Commit scope / recency | Score weight |
| ---------------------- | -----------: |
| Focused recent         |         1.00 |
| Focused stale          |         0.50 |
| Mixed recent           |         0.50 |
| Mixed stale            |         0.25 |
| Broad-sweep recent     |         0.25 |
| Broad-sweep stale      |         0.00 |

## Post-Change Confirmation

After the score-weight change, Vega health reported:

| Metric                        | Value |
| ----------------------------- | ----: |
| Overall score                 |    77 |
| Risk score                    |    96 |
| Hygiene score                 |    77 |
| Hidden-coupling pairs         |   139 |
| Hidden-coupling score count   |  34.5 |
| Hidden-coupling points        |     4 |
| Hidden-coupling pressure rows |     0 |

The overall score staying at 77 is expected because React large-component hygiene pressure still dominates. The risk score improves because broad-sweep history no longer scores like focused current coupling.

## Judgment

Keep the current score model with this hidden-coupling score-count correction. Do not strengthen hidden-coupling scoring until focused-current rows, not broad-sweep migration rows, dominate the second corpus. Keep React large-component pressure as the main Vega follow-up for future locality/design review rather than changing score thresholds in this slice.

## Verification

Completed so far:

- `npx vitest run tests/queries/health/health-report.test.ts tests/queries/health/health-full.test.ts tests/queries/health/debloat-health.test.ts` passed: 3 files, 9 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js health --json` passed locally with score 100 and `hiddenCouplingScoreCount: 0`.
- `node dist/cli.js similar hiddenCouplingHealthScore --json` returned one low-similarity `structural-overlap` signal against `coChangeCommitScope()`, accepted because both inspect broad/mixed/focused history terms but compute different concepts.
- `node dist/cli.js recent-duplicates --json` returned 0 findings.
- `node dist/cli.js unused-params --json` returned 0 findings.
- `node dist/cli.js wrapper-candidates --json` returned 0 findings.

2026-06-22 note: the later health full-default change in `src/queries/health/health.ts` does not alter hidden-coupling score weighting. Current `health --json` is equivalent to the historical `health --full --json` aggregate run for this purpose.

2026-06-28 note: the later health phase grouping change in `src/queries/health/health.ts` only batches frontend detector phases inside isolated workers; it does not alter hidden-coupling score weighting or the historical second-corpus judgment above.

2026-06-28 note: the later health drift performance change in `src/queries/health/health.ts` skips advisory `pattern-deviation` drift rows for health and baseline paths. It does not alter hidden-coupling score weighting, broad-sweep discounts, or the historical second-corpus judgment above.
- `node dist/cli.js passthrough-candidates --json` returned 0 findings.
- `npm test` passed: 67 files, 336 tests. The run still prints the known noisy `git diff` fixture warning from the existing incomplete-migration fixture.
- `npx prettier --check ...` passed for touched files.
- Final `node dist/cli.js reindex` passed.
- Final `node dist/cli.js diff-gate --json` exited 1 with the same two accepted warning-level findings:
  - `SQ36D93309ABEA`: accepted signal-tier echo because `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` both use symbol leaf helpers but make different product decisions.
  - `SQ30E6CF5F9B38`: accepted support-tier doc-reference because the README citation is a fenced declared-coupling configuration example that still points at the intended files.
