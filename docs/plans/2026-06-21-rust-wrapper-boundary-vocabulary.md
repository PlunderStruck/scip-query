# Rust Wrapper Boundary Vocabulary Plan

Date: 2026-06-21

## Purpose

A wrapper boundary vocabulary is the set of terms that make a single-caller helper look like an intentional boundary rather than needless indirection. Its real-world referents are function, file, and caller names such as `try_start_jump`, `apply_window_quality_settings`, `spawn_rate_for_score`, and `record_fixed_steps`; its essential role is to keep wrapper findings visible while preventing domain helpers from being scored like direct inline debt.

A general-domain helper is a small named function whose value is not reuse count but concentrated meaning: a predicate, calculation, state lifecycle operation, diagnostics hook, settings application, or gameplay action. Its real-world referents are small helpers in Rust/game code and other non-HTTP applications; its essential distinction from a useless wrapper is that the name preserves a domain decision that the caller should not absorb casually.

## Code Anchors

- `node dist/cli.js plan-context wrapperCandidates` resolves `wrapperCandidates()` at `src/queries/cleanup/wrapper-candidates.ts:45-66`, `WrapperCandidate` at `src/queries/cleanup/wrapper-candidates.ts:16-28`, and downstream health/baseline consumers.
- `src/queries/cleanup/wrapper-candidates.ts` already classifies wrapper findings through `wrapperBoundaryEvidence()`, `collectBoundaryTokenEvidence()`, `BOUNDARY_TOKEN_LABELS`, and type-guard token sets.
- `tests/symbols/file-wide-caller-fallback.test.ts` already asserts wrapper candidates remain detected while boundary-shaped wrappers move to `signal`.
- `docs/validation/2026-06-21-rust-wrapper-react-pressure-review.md` records the SynthRunnerRust examples that need calibration.

## Steps

1. Extend boundary vocabulary.
   - Add settings/application terms.
   - Add gameplay/action/input/audio/effects terms.
   - Add predicate, collision, calculation, diagnostics, lifecycle, reset, and state-history terms.
   - Add `should` as a predicate prefix so `should_*` helpers can be treated like review signals when the object term is boundary-shaped.

2. Keep wrapper findings visible.
   - Leave `WrapperActionTier` as `direct | signal`.
   - Leave candidate detection thresholds unchanged.
   - Only change `actionTier` through added `boundaryEvidence`.

3. Add regression coverage.
   - Extend the caller-fallback fixture with a single-caller action helper.
   - Assert it remains a wrapper candidate.
   - Assert it is classified as `signal` with action/gameplay boundary evidence.

4. Rerun SynthRunnerRust.
   - Compare wrapper direct/signal counts before and after the vocabulary extension.
   - Record whether the reviewed false-positive examples moved from direct to signal.

## Verification

- `npx vitest run tests/symbols/file-wide-caller-fallback.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js wrapper-candidates --json --max-loc 80 --limit 80`
- SynthRunnerRust `wrapper-candidates --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- Boundary vocabulary can over-discount genuinely pointless wrappers when words are too broad. The change should prefer terms that identify a boundary role, a domain action, or a lifecycle decision rather than generic verbs like `get`, `set`, or `make`.

## Result

Completed. See `docs/validation/2026-06-21-rust-wrapper-boundary-vocabulary-result.md`.
