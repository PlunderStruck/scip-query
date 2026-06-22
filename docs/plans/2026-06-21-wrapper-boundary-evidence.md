# Wrapper Boundary Evidence Plan

Date: 2026-06-21

## Purpose

An intentional boundary wrapper is a small callable in this codebase whose real units are helpers such as adapters, guards, validators, presenters, context setters, or public facades; it is a wrapper-like function whose essential role is to name or protect a handoff between policies, modules, APIs, or side effects, not merely to add an avoidable call layer.

The wrapper detector currently reports one-caller production callables as direct hygiene candidates. The validation pass found that several top findings were accepted designs because they preserve request-context, middleware, audit, or validation boundaries. This slice keeps those findings visible, but gives reviewers and health scoring enough evidence to distinguish direct inline candidates from boundary-shaped review signals.

## Code Anchors

- `node dist/cli.js plan-context wrapperCandidates` resolves `wrapperCandidates()` at `src/queries/cleanup/wrapper-candidates.ts:40-61`, `WrapperCandidate` at `src/queries/cleanup/wrapper-candidates.ts:13-23`, and `wrapperCandidateForSymbol()` at `src/queries/cleanup/wrapper-candidates.ts:66-111`.
- `node dist/cli.js code wrapperCandidateForSymbol -C 12` shows the current detector gate: exactly one external caller file, enclosing caller lookup, Rust test-module exclusion, caller fan-in threshold, and a flat result projection.
- `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:140-180'` shows the `wrapper-candidates` CLI renderer currently prints only location, wrapper name, caller, and fan-in.
- `node dist/cli.js code summarizeHealthWrappers -C 12` shows health summarization delegates to `summarizeHealthLocQuery()` and therefore counts every wrapper finding at full weight.
- `sed -n '180,250p' tests/symbols/file-wide-caller-fallback.test.ts` shows the existing source-fallback regression fixture for `StatusBadgeRelay:normalizeBadgeStatus()` called by `AnalysisStatusPresenter:renderStatusBadge()`.

## Steps

1. Add boundary evidence fields to `WrapperCandidate`.
   - Add `actionTier: 'direct' | 'signal'`.
   - Add `boundaryEvidence: string[]`.
   - Keep all existing fields stable for current JSON consumers.

2. Classify boundary-shaped wrappers locally in `wrapper-candidates.ts`.
   - Use wrapper symbol, wrapper file, caller symbol, and caller file as the evidence surface.
   - Record evidence for names and paths that indicate adapters, facades, presenters, middleware, guards, validators, resolvers, context/policy helpers, registry mutations, audit/log/transaction side effects, and explicit `scip-query: ignore-wrapper` comments.
   - Keep the detector permissive: do not suppress these results, only mark them as `signal` when boundary evidence is present.

3. Render the evidence.
   - In text output, append the action tier and boundary evidence line only when evidence exists.
   - JSON receives the new fields automatically through the result shape.

4. Reduce health score pressure for boundary-shaped wrapper results.
   - Use `CountLocSummary.scoreCount` for wrappers, keeping raw `count` unchanged.
   - Count direct wrappers at `1`.
   - Count signal wrappers at a fractional weight so the report still reflects persistent wrapper pressure without treating accepted boundary helpers as direct cleanup debt.
   - Expose a wrapper score count in health JSON/text consistently with React hook and Vue composable score-aware counts.

5. Add focused regression coverage.
   - Extend the existing file-wide caller fallback test to prove `StatusBadgeRelay:normalizeBadgeStatus()` remains detected and is marked `signal` with presenter/relay/normalize evidence.
   - Add health-score unit coverage if an existing test seam exists; otherwise rely on `npm test`, `npm run typecheck`, and JSON smoke output because health scoring composes over indexed fixture data.

## Verification

- `npx vitest run tests/symbols/file-wide-caller-fallback.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js wrapper-candidates --json`
- `node dist/cli.js health --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- The classification is intentionally evidence-only and additive. A wrong boundary guess changes tier and score weight, not whether the wrapper is reported.
- The health score change is bounded by existing `scoreCount` behavior; raw finding counts and baseline identities remain stable.

## Result

Completed. See `docs/validation/2026-06-21-wrapper-boundary-evidence-result.md`.
