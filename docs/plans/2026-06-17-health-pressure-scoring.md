# Health Pressure Scoring
**Date:** 2026-06-17

## Goal

Make the health score more indicative of how bad a codebase is when uncapped detector counts reveal categories far beyond their normal scoring caps. Done means `health --full` can lower risk or hygiene further through auditable pressure deductions, while the report still shows the old capped deductions and the new pressure ratios separately.

## Current State

- `src/queries/health-report.ts:91-129` builds `HealthReport`, computes the score breakdown through `computeHealthScore`, then derives `riskScore`, `hygieneScore`, and headline `score` from those deduction lines. Source: `scip-query plan-context buildHealthReport`.
- `src/queries/health-report.ts:396-445` computes capped deductions: similar tops out at 10 points, hidden coupling at 5, wrappers at 3, passthroughs at 3, and complexity at 5. Source: `scip-query plan-context computeHealthScore`.
- `src/runtime/cli-support.ts:103-162` renders the score, findings, actions, axes, and score breakdown. Source: `scip-query code 'src/runtime/cli-support.ts:100-170'`.
- `src/queries/health-report.ts:59-89` defines the public report envelope consumed by the CLI and JSON callers. Source: `scip-query code 'src/queries/health-report.ts:1-89'`.

## Reuse Audit

- Reuse `ScoreDeduction` and `scoreFromDeductions` for the actual score adjustment so the headline stays an auditable sum of deduction lines. Source: `scip-query code 'src/queries/health-report.ts:390-445'`.
- Reuse `round2` for pressure ratios instead of adding a formatting helper. Source: `scip-query code 'src/queries/health-report.ts:174-229'`.
- Add one small local pressure helper inside `health-report.ts`; no existing symbol computes "extra penalty after a category threshold is exceeded." Source: `scip-query similar computeHealthScore`; `scip-query similar-signatures --min-loc 5`.

## Design

### 1.1 - Add pressure data to the report envelope

- [x] **File**: `src/queries/health-report.ts:16-89`
- **Source**: `scip-query code 'src/queries/health-report.ts:1-89'`.
- **What**: `HealthReport` exposes scores, findings, axes, validation, actions, and warnings.
- **Change**: Add a `HealthPressure` interface with category, kind, count, threshold, ratio, and extra penalty; add `pressure: HealthPressure[]` to `HealthReport`.
- **Why**: The score should not hide why it dropped after full health sees uncapped counts.

### 1.2 - Compute pressure deductions after capped base deductions

- [x] **File**: `src/queries/health-report.ts:396-445`
- **Source**: `scip-query plan-context computeHealthScore`.
- **What**: The current formula caps each category's points and returns only `breakdown`.
- **Change**: Return `{ breakdown, pressure }`; add pressure deductions after base deductions using `ceil(log2(count / threshold) * weight)`, capped per category.
- **Why**: Pressure grows when findings are meaningfully beyond the threshold, but logarithmic growth avoids chaotic score swings.

### 1.3 - Render pressure visibly in the CLI

- [x] **File**: `src/runtime/cli-support.ts:103-190`
- **Source**: `scip-query code 'src/runtime/cli-support.ts:100-170'`; `scip-query code 'src/runtime/cli-support.ts:164-230'`.
- **What**: CLI currently renders axes and score breakdown, but not category saturation/pressure.
- **Change**: Add a `Maintenance Pressure` section before the score breakdown, showing count, threshold, ratio, and extra penalty.
- **Why**: A score change without a ratio is opaque; the user needs to see which categories are far past normal.

### 1.4 - Pin behavior with the full-health regression fixture

- [x] **File**: `tests/health-full.test.ts`
- **Source**: `scip-query outline tests/health-full.test.ts` returned no symbols because tests are not indexed; the file is a local regression fixture created for the previous deep-health change.
- **What**: The fixture proves full health removes the result cap for similar pairs.
- **Change**: Assert that full health records a similar-function pressure entry while regular health does not.
- **Why**: This pins the new scoring behavior to the exact bug class that motivated it.

## Stress Test

- The change is reversible: pressure deductions are additive lines in `scoreBreakdown`, not a replacement for the existing formula.
- The public JSON envelope changes by adding a field, which is backward-compatible for consumers that ignore unknown fields.
- Tiny repositories should not get wildly punished for a handful of findings, so pressure thresholds use floors for count-based categories.
- Full-health findings should matter more, but the action list remains the remediation guide; this scoring change does not imply automatic deletion or consolidation.

## Verification

- Run `npm run typecheck`.
- Run `npx vitest run tests/health-full.test.ts tests/debloat-health.test.ts`.
- Run `npm test`.
- Run `scip-query reindex && scip-query diff-gate`; accept unrelated existing findings only with explicit reasons.
- Build the CLI and compare `health --json` vs `health --full --json` on `VegaAssistant`.
