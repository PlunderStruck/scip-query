# Contextual Signal Verdict Closure

Date: 2026-06-21

## Goal

Close AVL-003 by consolidating the reviewed verdicts for contextual analyzers into one result. Done means each contextual family named in the ledger has a recorded action-tier judgment, score implication, output-quality implication, and residual precision action where needed.

A contextual signal analyzer reports a real repository pattern whose repair cannot be chosen from the pattern alone. Its essential role is to direct maintainer attention toward likely design pressure while preserving the judgment step around product meaning, ownership, locality, and architecture.

## Current State

- `node dist/cli.js plan-context src/queries/health/health.ts --json` captured the health aggregation surface for this closure. The change surface includes `HEALTH_PHASES`, health summary functions such as `summarizeHealthWrappers()`, `summarizeHealthStaleAbstractions()`, `summarizeHealthDrift()`, and score helpers such as `reactHookHealthScore()` and `vueComposableHealthScore()`.
- `docs/analyzer-inventory.md` already maps the analyzer surface into direct repair, contextual signal, and support analysis tiers.
- `docs/analyzer-validation-protocol.md` already defines true-positive and false-positive standards for similarity, extraction, wrapper, stale abstraction, frontend, co-change, doc drift, architecture drift, and graph-risk families.
- The detailed evidence lives in the dated validation result files for similarity, extraction, wrappers, stale abstractions, frontend behavior, React/Vue pressure, graph risk, direct remaining verdicts, locality validation, and agent repair outcomes.

## Reuse Audit

This is a synthesis slice. It reuses existing validation artifacts and does not add a new detector, helper, schema, or command. The only new documents are this plan and the AVL-003 closure result.

## Design

### 1. Collect Reviewed Family Verdicts

- [x] **Docs**: dated validation results under `docs/validation/`.
- **Source**: `rg --files docs/validation | sort`, plus targeted reads of the family result files.
- **What**: Gather the counts and judgments for similarity/reuse, extraction pressure, indirection, frontend behavior and pressure, history/doc drift, graph risk, and locality.
- **Why**: AVL-003 should close from reviewed evidence, not from the inventory table alone.

### 2. Write The Closure Result

- [x] **File**: `docs/validation/2026-06-21-contextual-signal-closure-result.md`
- **Source**: `node dist/cli.js plan-context src/queries/health/health.ts --json`; existing family result files.
- **What**: Summarize each contextual family, assign the final action-tier judgment, and separate score work from output/schema work.
- **Why**: Maintainers and agents need one place to see which analyzers are review signals and which parts remain direct repair evidence.

### 3. Update The Ledger And Calibration Memo

- [x] **Files**: `docs/analyzer-validation-ledger.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- **Source**: `rg -n "AVL-003|Contextual signal|Implementation Priority|Ledger Judgments" ...`
- **What**: Mark AVL-003 complete and move the next active work to score calibration and output/schema closure.
- **Why**: The validation ledger should reflect the current state rather than an old public-command-surface note.

## Verification

- Run Markdown formatting on changed docs.
- Run the standard repository verification gate after doc updates:
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
  - `node dist/cli.js recent-duplicates --json`
  - `node dist/cli.js unused-params --json`
  - `node dist/cli.js reindex`
  - `node dist/cli.js diff-gate --json`

## Result

Completed in `docs/validation/2026-06-21-contextual-signal-closure-result.md`.
