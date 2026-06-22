# Echo Tier Refinement Plan

Date: 2026-06-21

## Goal

Tighten `diff-gate` echo action tiers so grouped echo findings remain useful while generic scaffolding matches do not receive direct reuse advice. Done means the Stable_Management `fakePaymentIntentSecret`-style token-helper case is classified as `signal`, while same-name or name-compatible exact helpers such as `hasOwn`, nullable normalizers, date cursor builders, and event publishers can still be `direct`.

## Current State

`node dist/cli.js plan-context echoActionTier` resolves `src/queries/impact/diff-gate.ts:255-261`. `echoActionTier()` currently returns `direct` when any grouped match has `similarityBasis === 'source-tokens'`, `similarity >= 0.98`, and at most 8 shared evidence tokens.

`node dist/cli.js code runEchoCheck -C 10` resolves `src/queries/impact/diff-gate.ts:193-253`. `runEchoCheck()` collects outside-diff matches, computes `actionTier` once per changed symbol at line 229, and passes that tier into the remediation text.

`node dist/cli.js code SimilarSymbolResult -C 8` resolves `src/queries/cleanup/similar.ts:11-28`. Similarity rows carry `symbolA`, `symbolB`, `shortNameA`, `shortNameB`, `similarity`, `similarityBasis`, and `sharedCallees`, where source-token matches reuse `sharedCallees` as their shared token list.

`node dist/cli.js code similarBySourceShape -C 12` resolves `src/queries/cleanup/similar.ts:369-413`. Source-shape similarity computes token intersection over source fingerprints and emits sorted shared tokens as `sharedCallees`.

`node dist/cli.js code leafName -C 4` resolves `src/symbols/symbol-parser.ts:278-288`, which extracts the last SCIP descriptor name. `node dist/cli.js code leafSuffix -C 4` resolves `src/symbols/symbol-parser.ts:292-300`, which extracts the last descriptor suffix when needed.

`node dist/cli.js change-surface src/queries/impact/diff-gate.ts --json` reports `diff-gate.ts` as a medium-risk public query module overall, but `runEchoCheck()`, `echoActionTier()`, `echoMessage()`, `echoWhy()`, and `echoRemediation()` have zero external consumers. This is a local policy change inside the public diff-gate result shape.

`node dist/cli.js outline tests/queries/impact/incomplete-migration.test.ts --json` returned an empty result and `node dist/cli.js files 'incomplete-migration' --json` only reported the production file. The Vitest fixture is not in the SCIP index, so test edits cannot be line-anchored through scip-query; they will be verified by focused Vitest runs.

## Reuse Audit

`node dist/cli.js similar echoActionTier --json` returned no similar rows. There is no existing helper for echo action-tier compatibility.

`node dist/cli.js recent-duplicates --json` returned no findings. Adding small local policy helpers in `diff-gate.ts` does not duplicate a recently introduced helper.

Use existing `leafName()` from `src/symbols/symbol-parser.ts` instead of parsing SCIP symbol strings manually. No new module is needed; this policy is local to `diff-gate` and should stay near `echoActionTier()`.

## Design Phases

### 1.1 — Pass Changed Symbol Identity Into Echo Tiering

- [x] **File**: `src/queries/impact/diff-gate.ts:193-253`
- **Source**: `node dist/cli.js code runEchoCheck -C 10`
- **What**: `runEchoCheck()` computes `const actionTier = echoActionTier(eligibleMatches)` at line 229.
- **Change**: Change the call to pass the changed symbol too: `echoActionTier(changedSymbol, eligibleMatches)`.
- **Why**: The tier decision needs the changed symbol's leaf name to compare against candidate names.

### 1.2 — Require Name Compatibility For Direct Source-Token Echo

- [x] **File**: `src/queries/impact/diff-gate.ts:255-261`
- **Source**: `node dist/cli.js plan-context echoActionTier`; `node dist/cli.js code leafName -C 4`
- **What**: `echoActionTier()` currently treats exact tiny source-token matches as direct without checking whether the functions name the same behavior.
- **Change**: Replace the inline predicate with helper logic:
  - direct candidates must be source-token matches with similarity at least `0.98` and at most 8 shared tokens
  - direct candidates must have compatible leaf names: exact same leaf name, or at least two shared camel/snake/kebab name tokens covering half of the shorter name
  - generic crypto/random token scaffolding should be direct only when the leaf names match exactly
- **Why**: `fakePaymentIntentSecret` and token generators share `bytes`, `crypto`, `hex`, `num`, and `random`, but they implement different product contracts.

### 1.3 — Add Focused Regression For Token-Helper Scaffold Matches

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: `node dist/cli.js outline tests/queries/impact/incomplete-migration.test.ts --json` returned no indexed symbols; use existing Vitest fixture style and verify with `npx vitest`.
- **What**: Current tests assert grouped direct echo for exact helper-like source-token matches, but they do not cover generic token-generation scaffolding.
- **Change**: Add a small git-backed fixture with a changed `fakePaymentIntentSecret()` and established token helpers such as `generateCsrfToken()` / `generateOpaqueToken()`. Assert the echo finding is grouped and has `actionTier: 'signal'`, with review wording rather than direct reuse wording.
- **Why**: This is the Stable_Management false-direct case that drove the slice.

## Stress-Test Findings

1. Understand before touching: source-shape similarity is a lexical fallback, not proof of semantic reuse.
2. Blast radius: the public `DiffGateFinding` shape stays unchanged; only optional `actionTier` classification changes.
3. Intermediate validity: the change only downgrades some direct echo rows to signal; it does not hide findings.
4. Reversibility: the policy is local and can be tuned without migration.
5. Failure design: uncertain matches should become `signal`, preserving evidence while avoiding bad direct repairs.
6. Concurrency: no state or async behavior changes.
7. Boundaries: no new CLI options or schema-breaking fields.
8. Data integrity: no persistence changes.
9. Observability: `why` still includes shared evidence tokens.
10. Human use: remediation becomes less misleading for generic scaffolding.
11. Reuse: use `leafName()` and local policy helpers; do not add a shared abstraction until another detector needs the same policy.

## Execution Order

1. Patch `echoActionTier()` and local helper predicates.
2. Add the token-helper regression.
3. Run focused impact tests.
4. Run `npm run typecheck`, `npm test`, and `npm run build`.
5. Run `node dist/cli.js reindex` and `node dist/cli.js diff-gate --json`.
6. Spot-check Stable_Management diff-gate summary again.

## Ship Order

Ship this as a follow-up precision commit after the first echo grouping slice. It is a two-way door because it only changes action-tier classification and remediation wording.

## Summary

Planned production file:

- `src/queries/impact/diff-gate.ts`

Planned test file:

- `tests/queries/impact/incomplete-migration.test.ts`

Expected result: fewer false-direct echo rows, no loss of grouped echo visibility.

## Implementation Result

Implemented on 2026-06-21. The detailed result is recorded in `docs/validation/2026-06-21-echo-tier-refinement-result.md`.
