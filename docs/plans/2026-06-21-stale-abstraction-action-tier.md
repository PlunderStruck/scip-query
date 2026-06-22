# Stale Abstraction Action-Tier Plan

Date: 2026-06-21

## Goal

A stale abstraction is a type-like definition whose observed consumer set is too small for its current ownership boundary. Its referents are unused types, one-consumer interfaces, one-consumer type aliases, and low-consumer classes; the essential distinction is whether the row shows direct removal work or only a design question about ownership.

Done means `stale-abstractions` keeps the current detection and confidence behavior, while each row also exposes an action tier, staleness kind, and recommendation that separate zero-consumer cleanup from one-consumer design review.

## Current State

- `node dist/cli.js plan-context staleAbstractions --json` resolved `staleAbstractions()` at `src/queries/cleanup/stale-abstractions.ts:83-139`. It selects type candidates, builds consumer evidence, skips transitively reachable/public-barrel cases, filters low-confidence rows by default, scores confidence, and orders results.
- `node dist/cli.js code StaleAbstraction --json` resolved `StaleAbstraction` at `src/queries/cleanup/stale-abstractions.ts:15-47`. The current result exposes consumer count, barrel consumers, syntactic kind, definer usage, confidence, and reason.
- `node dist/cli.js code scoreStaleCandidate --json` resolved `scoreStaleCandidate()` at `src/queries/cleanup/stale-abstractions.ts:228-254`. This is where row evidence is assembled after consumer filtering.
- `node dist/cli.js code scoreConfidence --json` resolved `scoreConfidence()` at `src/queries/cleanup/stale-abstractions.ts:515-542`. Zero consumers become high confidence; one-consumer classes become low confidence; one-consumer non-class definitions become high if the defining file never uses them, otherwise medium.
- `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:185-215' --json` resolved text rendering. The CLI prints confidence and reason, but not action tier or recommendation.

Field runs before implementation:

- Vega `stale-abstractions --full --json`: 108 rows, with 1 zero-consumer row and 107 one-consumer rows.
- Stable_Management `stale-abstractions --full --json`: 63 rows, with 3 zero-consumer rows and 60 one-consumer rows.

## Reuse Audit

- Existing `scoreConfidence()` already owns the stale-evidence split, so the new classification should reuse its inputs rather than re-querying consumers.
- Existing CLI list rendering in `handleStaleAbstractions` is the right rendering point; no command descriptor change is needed.
- Existing stale-abstraction accuracy tests already cover the important evidence shapes, so this slice should extend those tests.

## Design

### 1. Extend StaleAbstraction Additively

- [ ] **File**: `src/queries/cleanup/stale-abstractions.ts:15-47`
- **Source**: `node dist/cli.js code StaleAbstraction --json`
- **What**: Rows expose confidence and reason, but not action implication.
- **Change**: Add `stalenessKind`, `actionTier`, and `recommendation`.
- **Why**: Output should encode the direct-vs-signal distinction without changing detection.

### 2. Classify Row Action

- [ ] **File**: `src/queries/cleanup/stale-abstractions.ts:228-254`
- **Source**: `node dist/cli.js code scoreStaleCandidate --json`
- **What**: `scoreStaleCandidate()` has kind, consumer count, barrel count, definer usage, confidence, and reason.
- **Change**: Derive:
  - `unused-abstraction` + `direct` when `consumers === 0`.
  - `misplaced-single-consumer-type` + `signal` when one non-class consumer and the defining file does not use the type.
  - `single-consumer-abstraction` + `signal` for ordinary one-consumer rows.
  - `one-to-one-class-encapsulation` + `signal` for one-consumer classes.
- **Why**: Zero-consumer rows normally imply local cleanup; one-consumer rows require ownership and product judgment.

### 3. Preserve Health and Baseline Behavior

- [ ] **File**: `src/queries/health/health.ts`
- **Source**: `node dist/cli.js plan-context staleAbstractions --json`
- **What**: Health summaries consume stale rows by count/confidence.
- **Change**: No health scoring change in this slice.
- **Why**: Score weights should wait for the calibration memo after field validation.

### 4. Render Recommendation

- [ ] **File**: `src/runtime/query-commands/cleanup/handlers.ts:190-214`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:185-215' --json`
- **What**: CLI text shows confidence and reason.
- **Change**: Add action tier, staleness kind, and recommendation to the formatted row.
- **Why**: Text output should not make single-consumer abstractions look like direct deletion work.

### 5. Extend Accuracy Tests

- [ ] **File**: `tests/queries/cleanup/stale-abstractions-accuracy.test.ts`
- **Source**: `rg -n "staleAbstractions" tests/queries/cleanup/stale-abstractions-accuracy.test.ts`
- **What**: Existing fixtures cover mixed consumers, low-confidence class, misplaced type, and self-use.
- **Change**: Assert action tier, staleness kind, and recommendation for those rows.
- **Why**: The test suite already names the important evidence shapes.

## Verification

- `npx vitest run tests/queries/cleanup/stale-abstractions-accuracy.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js stale-abstractions --json --limit 5`
- Vega `stale-abstractions --full --json`
- Stable_Management `stale-abstractions --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

The main risk is overstating one-consumer rows. Keep those as `signal` even when confidence is high, because the repair may be move, inline, keep, or document as public contract.

## Result

Completed in `docs/validation/2026-06-21-stale-abstraction-action-tier-result.md`.
