# Rust Wrapper And React Pressure Review

Date: 2026-06-21

Raw output inputs:

- `/tmp/scip-query-validation/2026-06-21-pilot/SynthRunnerRust/confirmation/wrapper-candidates-json.out`
- `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/confirmation/react-large-component-pressure-full-json.out`
- `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/confirmation/react-hook-candidates-full-json.out`

## Scope

This review follows `docs/validation/2026-06-21-second-repo-confirmation.md`. It checks the two open calibration questions from that run:

1. Are Rust wrapper candidates really direct wrapper debt?
2. Do Vega React pressure rows need the same recommendation-kind treatment that Vue pressure now has?

## Rust Wrapper Candidates

Sampled the default 30 `wrapper-candidates` rows from SynthRunnerRust:

- 8 `signal`
- 22 `direct`

Examples:

| Symbol | Current tier | Boundary evidence | Judgment |
| --- | --- | --- | --- |
| `audio:route_haptics_to_audio_cues()` | `signal` | route boundary term | Good signal classification. |
| `camera:impl:CameraFollowState:Default:default()` | `signal` | caller registry term | Good boundary classification. |
| `player:try_start_jump()` | `direct` | none | Accepted local action helper; should not be scored as direct debt by default. |
| `camera:apply_window_quality_settings()` | `direct` | none | Accepted settings/application boundary helper. |
| `physics:projectile_obstacle_overlap()` | `direct` | none | Domain predicate/helper, likely legitimate locality. |
| `scoring:spawn_rate_for_score()` | `direct` | none | Domain calculation helper, not a useless forwarding layer. |
| `diagnostics:record_fixed_steps()` | `direct` | none | Telemetry/update helper; likely legitimate. |
| `run_rng:impl:RunRng:reseed_from_next_seed()` | `direct` | none | State/reset helper; likely legitimate. |

Judgment:

- The current TypeScript/API boundary vocabulary transfers only partly to Rust.
- The Rust direct rows are not obviously bad wrappers. Most are small named domain helpers that keep `app.rs` orchestration readable.
- Score calibration should avoid treating these as direct hygiene debt until wrapper evidence recognizes gameplay, settings, diagnostics, reset, predicate, and calculation boundaries.

Precision action:

- Add Rust/general-domain boundary evidence terms to `wrapperBoundaryEvidence()`.
- Consider lowering direct wrapper score weight further when a project has only graph/source evidence and the wrapper is a small domain helper.

## Vega React Pressure

Top 20 `react-large-component-pressure --full --json` rows are dominated by JSX structure:

| File | Component | Dominant pressure | Judgment |
| --- | --- | --- | --- |
| `TermsOfService.tsx` | `TermsOfService` | `jsx-structure` | Likely static/legal content; direct extraction is not always valuable. |
| `BetaApplicationPage.tsx` | `BetaApplicationPage` | `jsx-structure` | Page composition pressure; review for section extraction. |
| `IntegrationCard.tsx` | `IntegrationCard` | `file` | File/component size pressure; likely UI decomposition review. |
| `ProjectAgentSettings.tsx` | `ProjectAgentSettings` | `file` | Large settings UI; review for panel/local state extraction. |
| `CreateProjectModal.tsx` | `CreateProjectModal` | `file` | Modal workflow pressure; review behavior and JSX separately. |
| `FloatingChatHeader.tsx` | `FloatingChatHeader` | `jsx-structure` | JSX-only pressure; likely presentational decomposition. |
| `CustomEndpointManager.tsx` | `EndpointModal` | `file` | Very large file, but component pressure needs recommendation detail. |

React hook candidates also show many shared generic hook patterns:

- `useEffect`, `useReducer`, `useMemo`, `handleSubmit`, `handleDelete`, and `isSaving` dominate the top samples.
- Some rows are plausible extraction candidates, but many are generic workflow scaffolding and need softer wording or evidence classes before direct repair.

Judgment:

- React pressure is real in Vega, but output is less actionable than Vue pressure-kind output.
- The React large-component detector already has `dominantPressure` and `reasons`, but lacks `contextKind`, `pressureKinds`, `recommendationKind`, and `recommendation`.
- The next implementation slice should mirror the Vue pressure-kind output for React.
- Hook candidate classification should be a later slice: split generic hook scaffolding from domain-specific behavior before changing score weight.

## Follow-Up Result

React pressure-kind output is complete in `docs/validation/2026-06-21-react-pressure-kind-output-result.md`.

## Next Action

Implement Rust/general-domain wrapper boundary vocabulary:

- Add boundary evidence for gameplay/action helpers, settings/application helpers, predicates, calculations, diagnostics, and reset/state helpers.
- Rerun SynthRunnerRust `wrapper-candidates --json`.
- Update AVL-003 and AVL-006 with the tier and score-weight judgment.
