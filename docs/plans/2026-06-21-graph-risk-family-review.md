# Graph-Risk Family Review Plan

Date: 2026-06-21

## Goal

Graph-risk analyzers report places where dependency shape may make changes harder: central callables, tightly coupled file pairs, long dependency chains, and structural drift. They are useful because they identify maintenance pressure that is real in the graph, but their essential product meaning is risk for human review, not automatic refactor instructions.

Done means `bottlenecks`, `coupling`, `deep-chains`, and `drift` expose action-tier evidence consistently, `deep-chains` stops spending its top rows on suffix duplicates, drift health scoring separates direct cleanup from contextual layer pressure, and the validation ledger records the field judgment.

## Current State

- `node dist/cli.js plan-context bottlenecks --json` resolved `bottlenecks()` at `src/queries/graph/bottlenecks.ts:28-56`. It scores production callables by `fanIn * fanOut`, filters by minimum fan-in/fan-out, and returns `BottleneckResult` rows with only symbol, short name, fan counts, score, and file.
- `node dist/cli.js code 'src/runtime/query-commands/graph.ts:17-150' --json` showed the CLI prints `bottlenecks` as a table with `score`, `fan-in`, `fan-out`, and `symbol`, so the user sees graph magnitude but not action implication.
- `node dist/cli.js plan-context coupling --json` resolved `coupling()` at `src/queries/graph/coupling.ts:13-62` and `topCoupling()` at `src/queries/graph/coupling.ts:67-110`. The result reports shared symbol counts between files, but not whether that is direct repair evidence or contextual coordination pressure.
- `node dist/cli.js plan-context deep-chains --json` resolved `deepChains()` at `src/queries/graph/deep-chains.ts:23-159`. It condenses cycles with SCCs and returns one longest chain for every starting SCC.
- `node dist/cli.js deep-chains --json --limit 10` on this repo returned ten chains with depths 31-37 where most rows were strict suffixes of the previous row. The graph facts are valid, but the top result set repeats one tail instead of showing distinct risk.
- `node dist/cli.js plan-context drift --json` resolved `drift()` at `src/queries/cleanup/drift.ts:45-65`. `node dist/cli.js code 'src/queries/cleanup/drift.ts:1-120' --json` and `node dist/cli.js code 'src/queries/cleanup/drift.ts:120-240' --json` showed three drift families: unused imports, layer violations, and pattern deviations.
- `node dist/cli.js code 'src/queries/cleanup/drift-policy.ts:1-220' --json` showed `layerPolicyForEdge()` has explicit `src/*` and generic layer rules, while `node dist/cli.js code inferLayerRules --json` showed inferred rules mark rare cross-layer edges as violations.
- `node dist/cli.js code summarizeHealthDrift --json` showed health counts only unused imports and layer violations. `node dist/cli.js code 'src/queries/health/health-report.ts:557-814' --json` showed `computeHealthScore()` currently scores those rows together as raw `drift` findings.
- `node dist/cli.js doc-drift docs/analyzer-validation-protocol.md --json` returned no findings, so the validation standard does not need a pre-plan repair.
- `node dist/cli.js recent-duplicates --json` returned no findings.

## Reuse Audit

- Reuse the existing `direct | signal | support` action-tier vocabulary from `docs/analyzer-inventory.md` and `docs/analyzer-validation-protocol.md`.
- Reuse the local classification-helper pattern already used by `classifyExtractionCandidate()` and `classifyStaleAction()`; `node dist/cli.js similar classifyExtractionCandidate --json --limit 5` and `node dist/cli.js similar classifyStaleAction --json --limit 5` only found broad source-token overlap, not a shared implementation worth extracting.
- Reuse `budgetedTableCommand`, `dbCommand`, `reportCommand`, and `budgetedReportCommand` in `src/runtime/query-commands/graph.ts` and `src/runtime/query-commands/cleanup/handlers.ts`; the command framework already handles JSON envelopes.
- Reuse `tests/fixtures/evidence-fixture.ts` for focused graph fixtures. The test tree is not SCIP-indexed, so test files are verification targets rather than SCIP source anchors.

## Design

### 1. Add graph-risk metadata to graph analyzers

- [x] **File**: `src/queries/graph/bottlenecks.ts:8-73`
- **Source**: `node dist/cli.js plan-context bottlenecks --json`
- **What**: `BottleneckResult` reports graph centrality but not the fact that it is a contextual signal.
- **Change**: Add `actionTier: 'signal'`, `riskKind: 'coordination-hotspot'`, `evidenceReasons`, and `recommendation` to each row.
- **Why**: Bottlenecks are risk hotspots; the analyzer should not imply that central architecture is automatically wrong.

- [x] **File**: `src/queries/graph/coupling.ts:3-110`
- **Source**: `node dist/cli.js plan-context coupling --json`; `node dist/cli.js code topCoupling --json`
- **What**: `CouplingResult` reports shared symbols between two files, but not whether that shared surface is intended.
- **Change**: Add `actionTier: 'signal'`, `couplingKind: 'shared-symbol-coupling'`, `evidenceReasons`, and `recommendation` in both pair and top modes.
- **Why**: Shared symbols are coordination evidence, not a direct instruction to merge or split files.

- [x] **File**: `src/queries/graph/deep-chains.ts:3-159`
- **Source**: `node dist/cli.js plan-context deep-chains --json`
- **What**: `DeepChainResult` reports chain and depth only.
- **Change**: Add `actionTier: 'signal'`, `chainKind: 'transitive-dependency-depth'`, `evidenceReasons`, and `recommendation`.
- **Why**: Long chains describe propagation risk; repair depends on ownership and layer intent.

### 2. De-duplicate deep-chain suffix rows

- [x] **File**: `src/queries/graph/deep-chains.ts:144-159`
- **Source**: `node dist/cli.js deep-chains --json --limit 10`
- **What**: Top rows can be strict suffixes of earlier longer rows.
- **Change**: Sort by descending depth, drop any chain that is a strict suffix of a retained longer chain, then apply the limit.
- **Why**: Validation samples should show distinct dependency-chain risks instead of repeating one tail.

### 3. Split drift action tiers and policy basis

- [x] **File**: `src/queries/cleanup/drift.ts:9-191`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/drift.ts:1-120' --json`; `node dist/cli.js code 'src/queries/cleanup/drift.ts:120-240' --json`; `node dist/cli.js code 'src/queries/cleanup/drift-policy.ts:1-220' --json`; `node dist/cli.js code inferLayerRules --json`
- **What**: `DriftResult.kind` distinguishes unused imports, layer violations, and pattern deviations, but it does not expose action tier or whether a layer violation came from explicit policy or inferred rarity.
- **Change**: Add `actionTier`, `policyBasis` for layer violations, `evidenceReasons`, and `recommendation`. Mark unused imports as `direct`; explicit layer violations as `direct`; inferred layer violations and pattern deviations as `signal`.
- **Why**: Unused imports are usually local cleanup, while inferred architecture drift needs maintainer judgment.

### 4. Align health scoring with drift tiers

- [x] **File**: `src/queries/health/health-types.ts:40-46`
- **Source**: `node dist/cli.js code 'src/queries/health/health-types.ts:1-120' --json`
- **What**: `DriftSummary` carries `count`, `unusedImports`, and `layerViolations`.
- **Change**: Add direct and signal counts for health scoring.
- **Why**: The score should use direct drift rows for base deductions and contextual drift rows for pressure.

- [x] **File**: `src/queries/health/health.ts:547-556`
- **Source**: `node dist/cli.js code summarizeHealthDrift --json`
- **What**: Health summarizes drift as unused imports plus layer violations.
- **Change**: Count health-visible drift rows by action tier, while still excluding pattern deviations from baseline health scoring.
- **Why**: The previous behavior keeps the pattern-deviation exclusion but stops treating inferred layer signals as direct cleanup debt.

- [x] **File**: `src/queries/health/health-report.ts:557-814`
- **Source**: `node dist/cli.js code 'src/queries/health/health-report.ts:557-814' --json`
- **What**: `computeHealthScore()` scores raw drift count and pressure from the same count.
- **Change**: Score direct drift count in the base `drift` deduction and signal drift count in `drift-pressure`. Update the action wording to mention direct cleanup versus boundary review.
- **Why**: This matches the action-tier score model already applied to extraction and stale abstractions.

### 5. Make CLI text output reviewable

- [x] **File**: `src/runtime/query-commands/graph.ts:17-150`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/graph.ts:17-150' --json`
- **What**: Graph command text output shows graph magnitude but not action meaning.
- **Change**: Include tier/risk kind in table or report output and print recommendations/evidence where the report format has room.
- **Why**: Text output should carry the same validation semantics as JSON.

- [x] **File**: `src/runtime/query-commands/cleanup/handlers.ts:561-589`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:520-590' --json`
- **What**: Drift output prints `[UNUSED]`, `[LAYER]`, or `[UNIQUE]` with description/detail.
- **Change**: Include `actionTier`, recommendation, and policy basis when present.
- **Why**: Drift is mixed direct/signal evidence, so the rendered row needs to say which is which.

### 6. Add focused tests and corpus validation

- [x] **File**: `tests/queries/graph/graph-risk-output.test.ts`
- **Source**: test tree is not SCIP-indexed; fixture patterns verified from `tests/fixtures/evidence-fixture.ts` and existing query tests.
- **What**: There is no dedicated graph-risk test file.
- **Change**: Add fixture coverage for bottleneck metadata, coupling metadata, deep-chain suffix de-duplication, and drift action-tier classification.
- **Why**: The new output contract should be pinned by small, reviewable fixtures.

- [x] **File**: `docs/validation/2026-06-21-graph-risk-family-result.md`
- **Source**: ledger and protocol docs plus command outputs from this slice.
- **What**: The ledger currently points to graph-risk families as next.
- **Change**: Record local and corpus raw-output paths, counts, verdict judgment, and score implications.
- **Why**: Validation decisions should survive the implementation turn.

## Verification

- `npx vitest run tests/queries/graph/graph-risk-output.test.ts tests/queries/cleanup/drift-accuracy.test.ts tests/queries/navigation/command-accuracy.test.ts`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js bottlenecks --json --limit 10`
- `node dist/cli.js coupling --json --limit 10`
- `node dist/cli.js deep-chains --json --limit 10`
- `node dist/cli.js drift --json`
- Corpus smokes for `Stable_Management` and `Vega_2.0` for the same four commands, with raw output under `/tmp/scip-query-validation/2026-06-21-pilot`
- `npm test`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

The main behavior change is `deep-chains` returning fewer redundant rows. That should improve review quality without hiding distinct chains because only strict suffixes of retained longer chains are removed. Drift score changes can raise scores in repositories where layer violations were inferred rather than explicit; that is intended because inferred rules are contextual pressure.

## Result

Completed in `docs/validation/2026-06-21-graph-risk-family-result.md`.
