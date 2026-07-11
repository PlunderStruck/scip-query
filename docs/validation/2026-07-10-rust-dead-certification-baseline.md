# Rust `dead` certification baseline

Date: 2026-07-10
Status: Complete baseline; detector verdict experimental
Roadmap: [`Accuracy Hardening and Health Certification`](../accuracy-hardening-goal.md)
Plan: [`Rust dead-code certification`](../plans/2026-07-10-rust-dead-certification.md)
Verdicts: [`2026-07-10-rust-dead-calibration-verdicts.json`](./2026-07-10-rust-dead-calibration-verdicts.json)

## Result

The current Rust `dead` output does not meet the 90% public-signal or 95% actionable-finding thresholds under the repository-dead truth rule.

| Measure                        |           Result |
| ------------------------------ | ---------------: |
| Deterministic sampled rows     |               52 |
| Valid dead-code findings       |                1 |
| Invalid dead-code findings     |               51 |
| Observed precision             |             1.9% |
| 95% Wilson confidence interval |       0.3%–10.1% |
| Repositories represented       |                3 |
| Known-positive recall cases    |                0 |
| Certification                  | **Experimental** |

The sample contains 52 rather than 75 rows because SynthRunnerRust emitted only two `dead-code` rows at its pinned commit. The harness retained both instead of substituting findings from another repository.

## Truth rule

A valid Rust repository-dead finding has no source, test, trait-contract, macro or derive, ABI or registration, Cargo-target, configured-feature, public-library, generated, or reflective consumer. Certified deletion additionally requires an applicable checker.

A Cargo library surface is the set of public Rust items a library target makes callable by dependent crates. Its essential difference from ordinary in-repository code is that its consumers may exist outside the checkout being indexed. Therefore a missing local caller cannot prove a public library item dead.

## Method

The calibration harness created isolated detached worktrees, forced Rust-only indexes, recorded Rust capability evidence, ran uncapped `dead --full --json`, and sampled up to 25 findings per repository with seed `rust-dead-v1`. Every row was reviewed against its pinned source, exact-name references, Cargo manifests and targets, module visibility, traits, attributes, and tests.

| Repository      | Commit                                     | Full candidates | Sample | Valid | Invalid |
| --------------- | ------------------------------------------ | --------------: | -----: | ----: | ------: |
| openai/codex    | `de80fa6e3194d68b71b0f09be475179922e0f5b8` |              54 |     25 |     0 |      25 |
| SynthRunnerRust | `658a52d355e8733d6ce759e77b84735a47ef3048` |               2 |      2 |     0 |       2 |
| VegaAssistant   | `19c0d70d7d21d1a477a1eba6c911b09944b50991` |             129 |     25 |     1 |      24 |

All three repositories reported available Rust SCIP indexing, source facts, rust-analyzer semantics, and `cargo check` cleanup verification.

## Noise archetypes

| Archetype                      | Count | Evidence                                                                                   | Required correction                                                                                      |
| ------------------------------ | ----: | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Declared Cargo library surface |    48 | Public items were reachable through Cargo library targets and public modules or re-exports | Root public library definitions while retaining private and binary-only unused definitions as candidates |
| Trait dispatch contract        |     2 | Trait declaration methods are consumed through implementations and trait-object dispatch   | Move known implicit reachability out of the direct deletion tier                                         |
| Serde module reflection        |     1 | `#[serde(with = "nonce_b64")]` generates calls to the module functions                     | Move known implicit reachability out of the direct deletion tier                                         |

The one accepted row, VegaAssistant's private `CAP_INTERNET` constant, had no consumer or external surface. It proves that ordinary private definitions can remain useful findings after public-surface hardening.

## Decision

Do not publish current Rust `dead` counts as defects, deletion opportunities, or leaderboard penalties. First derive Cargo library roots, separate implicit-use signals from direct deletion findings, add private-library and binary-only positive fixtures, and replay the pinned corpus.
