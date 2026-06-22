# Rust Wrapper Boundary Vocabulary Result

Date: 2026-06-21

## Scope

This slice implements the Rust/general-domain wrapper calibration action: wrapper findings should remain visible, but small domain helpers in non-HTTP code should not be scored like direct inline debt merely because they have one production caller.

Implemented changes:

- `wrapperBoundaryEvidence()` now recognizes more general-domain boundary terms for settings/application, gameplay actions, input/audio effects, predicates, collision checks, calculations, diagnostics, lifecycle/reset/state, animation, scroll/position, and sequence/segment helpers.
- `should` now counts as a predicate prefix for type-guard-shaped helpers when paired with a boundary object term.
- `boundaryTokens()` now splits acronym-to-word transitions, so names like `PlayerXHistory` expose the `history` token.
- Detection thresholds and result visibility are unchanged: findings still appear; only `actionTier` and `boundaryEvidence` change.

## Regression Coverage

Updated `tests/symbols/file-wide-caller-fallback.test.ts`:

- The existing source-caller fallback fixture still detects `StatusBadgeRelay.normalizeBadgeStatus()`.
- A new `JumpActionRelay.tryStartJump()` fixture remains detected as a wrapper candidate.
- The action helper is classified as `signal` with fallible-action and gameplay-action boundary evidence.

## SynthRunnerRust Smoke

Repository: `/Users/aydansalois/Documents/GitHub/SynthRunnerRust`
Revision: `658a52d355e8733d6ce759e77b84735a47ef3048`

Raw outputs:

- `/tmp/scip-query-validation/2026-06-21-pilot/SynthRunnerRust/rust-wrapper-boundary-vocabulary/wrapper-candidates-json.out`
- `/tmp/scip-query-validation/2026-06-21-pilot/SynthRunnerRust/rust-wrapper-boundary-vocabulary/wrapper-candidates-limit80-json.out`
- `/tmp/scip-query-validation/2026-06-21-pilot/SynthRunnerRust/rust-wrapper-boundary-vocabulary/health-json.out`

Commands:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js wrapper-candidates --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js wrapper-candidates --json --limit 80
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js health --json
```

Result:

- Default `wrapper-candidates`: 30 rows, all `signal`.
- Wide `wrapper-candidates --limit 80`: 45 rows, all `signal`.
- `health --json`: `wrappers` 45, `wrapperScoreCount` 11.25.
- Previous default confirmation was 30 rows: 8 `signal`, 22 `direct`.

Reviewed examples that moved from `direct` to `signal`:

| Symbol | Boundary evidence sample |
| --- | --- |
| `player:try_start_jump()` | fallible action, gameplay action |
| `camera:apply_window_quality_settings()` | settings/application |
| `physics:projectile_obstacle_overlap()` | gameplay entity, collision predicate |
| `spawning:predict_spawn_x()` | gameplay lifecycle, prediction |
| `input:should_collect_keyboard_input()` | type-guard boundary shape, input boundary |
| `audio:toggle_mute_via_keyboard()` | audio side-effect, input boundary |
| `effects:react_to_quality_change()` | side-effect boundary, settings/application |
| `player:should_fire_projectile()` | type-guard boundary shape, gameplay action |
| `scoring:spawn_rate_for_score()` | gameplay lifecycle, calculation |
| `diagnostics:record_fixed_steps()` | diagnostics |
| `world:impl:PlayerXHistory:push()` | state history |
| `run_rng:impl:RunRng:reseed_from_next_seed()` | state lifecycle |
| `effects:reset_effect_pools()` | side-effect boundary, state lifecycle, state pool |

## Verification

Commands run successfully:

- `npx vitest run tests/symbols/file-wide-caller-fallback.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js wrapper-candidates --json --max-loc 80 --limit 80`
- SynthRunnerRust `wrapper-candidates --json`
- SynthRunnerRust `wrapper-candidates --json --limit 80`
- SynthRunnerRust `health --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with the same two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

`npm test` still prints a noisy `git diff` usage warning from an existing test path, but Vitest reports all 313 tests passed.

## Judgment

Confirmed. The Rust wrapper calibration now keeps the findings visible while discounting the reviewed domain helpers to signal. On SynthRunnerRust, the wrapper family now behaves like a contextual review surface rather than a direct cleanup mandate, which matches the manual verdicts from the second-repo confirmation.

## Next Action

Continue the next output-quality slice: classify React hook candidate evidence so generic hook scaffolding is separated from domain-specific behavior.
