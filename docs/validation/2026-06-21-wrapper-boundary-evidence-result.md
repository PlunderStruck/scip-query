# Wrapper Boundary Evidence Result

Date: 2026-06-21

## Scope

This slice implements the wrapper calibration action from `docs/validation/2026-06-21-analyzer-verdict-review.md`: wrapper findings should remain visible, but single-caller helpers that look like adapters, presenters, guards, validators, context/policy helpers, registries, side-effect boundaries, or explicit intentional wrappers should not be scored like direct inline debt.

Implemented changes:

- `WrapperCandidate` now includes `actionTier: 'direct' | 'signal'`.
- `WrapperCandidate` now includes `boundaryEvidence: string[]`.
- `wrapper-candidates` text output prints the tier and boundary evidence.
- Health analysis now uses `wrappers.scoreCount`, counting direct wrappers at full weight and boundary-signal wrappers at fractional weight.
- Health JSON/text now exposes `wrapperScoreCount` alongside the raw `wrappers` count.
- The public query index exports `WrapperActionTier`.

## Regression Coverage

Updated `tests/symbols/file-wide-caller-fallback.test.ts`:

- `StatusBadgeRelay:normalizeBadgeStatus()` remains detected through source caller fallback.
- The candidate is classified as `signal`.
- Boundary evidence includes relay, normalization, and presenter terms.

## Local Smoke Results

Raw outputs:

- `/tmp/scip-wrapper-candidates-after-reindex.json`
- `/tmp/scip-health-after-wrapper-evidence.json`
- `/tmp/scip-diff-gate-wrapper-refined.json`

`node dist/cli.js wrapper-candidates --json --max-loc 80 --limit 80` after reindex:

- Total wrapper candidates: 14
- Direct: 13
- Signal: 1
- Signal example: `src:runtime:cli-support:commandAnalysisBudget()`
- Evidence: command-boundary terms on the wrapper name, caller name, and caller path.

`node dist/cli.js health --json`:

- Default wrapper findings: 0
- `wrapperScoreCount`: 0
- This confirms the additive output field exists; the current default health profile has no wrapper findings after prior wrapper-health cleanup.

## Verification

Commands run successfully:

- `npx vitest run tests/symbols/file-wide-caller-fallback.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js wrapper-candidates --json --max-loc 80 --limit 80`
- `node dist/cli.js health --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

## Stable_Management Confirmation

See `docs/validation/2026-06-21-stable-management-wrapper-boundary-confirmation.md`.

Final result after one vocabulary refinement:

- Total wrapper candidates: 48
- Signal: 37
- Direct: 11
- Health `wrapperScoreCount`: 20.25

The second repo confirmed the verdict-review accepted-design examples moved to `signal`: request-context transaction helpers, route registry helpers, middleware, audit logging, validation middleware, and response type guards.

## Judgment

Confirmed for `scip-query` and `Stable_Management`. Wrapper findings now carry enough structured evidence for reviewers and agents to distinguish direct cleanup candidates from boundary-shaped review signals, and the health score can discount those signals without hiding them.

## Next Action

Continue the next calibration implementation item: Vue pressure-kind output.
