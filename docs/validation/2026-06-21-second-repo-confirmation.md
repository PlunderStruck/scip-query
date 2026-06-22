# Second-Repo Confirmation

Date: 2026-06-21

Raw output root:

```text
/tmp/scip-query-validation/2026-06-21-pilot
```

## Scope

This confirmation expands the analyzer validation pilot from `scip-query` and `Stable_Management` to:

- `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- `/Users/aydansalois/Documents/GitHub/SynthRunnerRust`

The goal is to check whether the calibrated output fields and action tiers still behave on a React-heavy TypeScript/Python repo and a Rust capability-boundary repo.

## Repository Status

| Repository | Revision | Working tree | Note |
| --- | --- | --- | --- |
| `Vega_2.0` | `6288855333faf33ba395fa804eb9b03c0a04989e` | clean | Diff-gate is a clean-repo smoke. |
| `SynthRunnerRust` | `658a52d355e8733d6ce759e77b84735a47ef3048` | dirty | Pre-existing edits in `src/app.rs` and `src/world_visuals.rs`; diff-gate validates current-diff behavior. |

## Commands

Both repos:

- `reindex`
- `health --full --json`
- `diff-gate --json`
- `capability-matrix`
- `dead --only-dead --json`
- `unused-params --json`
- `similar --full --json`
- `wrapper-candidates --json`

Vega-only React smokes:

- `react-component-duplicates --full --json`
- `react-hook-candidates --full --json`
- `react-large-component-pressure --full --json`

## Vega_2.0

Raw output directory:

```text
/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/confirmation
```

Command status:

- All commands exited 0.
- `diff-gate --json`: 0 findings.
- `health --full --json`: score 77, risk 89, hygiene 77.

Analyzer counts:

| Analyzer | Count |
| --- | ---: |
| `dead --only-dead` dead findings | 0 |
| `unused-params` | 0 |
| `similar --full` | 42 |
| `wrapper-candidates` default cap | 30 |
| `react-component-duplicates --full` | 3 |
| `react-hook-candidates --full` | 87 |
| `react-large-component-pressure --full` | 248 |

Calibrated output checks:

- `dead --only-dead` exposes clear counts: `deadCode: 0`, `fileInternal: 980`, `shown.deadCode: 0`.
- Similarity split: 22 `access-query-scaffolding`, 12 `mixed`, 6 `framework-scaffolding`, 2 `domain-behavior`.
- Similarity tiers: 40 `signal`, 2 `direct`.
- Wrapper tiers: 30 `signal`; sampled rows carry API/controller/scope boundary evidence.
- React pressure/hook/component commands produced nonzero React-specific evidence, matching the health score breakdown.

Judgment:

- Confirmed for TypeScript/React. The calibrated wrapper and similarity fields behave as intended: API/controller wrappers soften to `signal`, and only concrete domain-behavior similarity becomes `direct`.
- The React large-component pressure queue remains substantial and should be reviewed as a frontend/locality family, not treated as newly implemented score changes.

## SynthRunnerRust

Raw output directory:

```text
/tmp/scip-query-validation/2026-06-21-pilot/SynthRunnerRust/confirmation
```

Command status:

- `diff-gate --json` exited 1 with findings on the pre-existing local edits.
- All other commands exited 0.
- `health --full --json`: score 81, risk 81, hygiene 94.

Capability boundary:

- Rust SCIP indexing: available.
- Rust source fallback: available.
- Rust semantic provider: unavailable; graph/source evidence is used.
- Rust cleanup verification: available via `cargo check --quiet --manifest-path Cargo.toml`.

Analyzer counts:

| Analyzer | Count |
| --- | ---: |
| `dead --only-dead` shown dead findings | 2 |
| `unused-params` | 0 |
| `similar --full` | 3 |
| `wrapper-candidates` default cap | 30 |
| `diff-gate` current-diff findings | 6 |

Diff-gate current-diff findings:

| Check | Count | Calibrated behavior |
| --- | ---: | --- |
| `doc-reference` | 5 | 2 `guide-reference` / `signal`; 3 `configuration-example` / `support`. |
| `new-dead` | 1 | Runtime test symbol in `src/app.rs`; type-contract filter did not hide it. |

Similarity split:

- 3 `framework-scaffolding`
- 3 `signal`
- 0 `direct`

Wrapper split:

- 8 `signal`
- 22 `direct`

Judgment:

- Confirmed for capability boundaries: the matrix clearly states Rust has graph/source cleanup evidence and no TypeScript semantic provider.
- Confirmed for doc citation-kind output on non-TypeScript docs: AGENTS/CLAUDE citations classify as guide references, and parity docs classify as configuration examples.
- Similarity split is conservative on Rust: all rows are framework scaffolding signals.
- Wrapper boundary evidence needs a Rust-specific follow-up review. Most default wrapper rows are `direct` because they lack API/controller/scope evidence, but Rust gameplay helper names may still represent legitimate local action boundaries rather than needless wrappers.

## Overall Judgment

The first implementation-priority queue is confirmed across the four pilot repos:

- Dead output counts prevent false dead-code verdict counts.
- `new-dead` still flags runtime Rust symbols while avoiding TypeScript compile-time contract aliases.
- Echo/scaffolding and similarity/scaffolding splits reduce over-direct findings.
- Wrapper boundary evidence works well for TypeScript API surfaces, but Rust wrapper rows need domain review.
- Vue pressure-kind output remains confirmed on Stable_Management; React pressure evidence is present in Vega for the next frontend/locality pass.
- Doc citation-kind output works on both README config examples and Rust guide/config docs.
- Baseline metadata inheritance is implemented and regression-tested; no new baseline findings were produced in the clean Vega/scip-query smokes.

## Next Action

Review Rust wrapper candidates and Vega React pressure rows as the next calibration slice. The question is whether Rust gameplay helpers need additional boundary evidence terms, and whether React pressure output should receive the same recommendation-kind treatment that Vue now has.
