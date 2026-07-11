# Rust `dead` population expansion

Date: 2026-07-11

Verdict: **insufficient population evidence; hardened detector remains
supported**.

## Truth rule

A Rust `dead-code` row is a conservative repository deletion candidate. No
source, test, trait-contract, macro or derive, ABI or registration,
Cargo-target, configured-feature, public-library, generated, or reflective
consumer may be known. A checker-backed deletion still requires `cargo check`.

## Pinned replay

The deterministic `rust-dead-expansion-v2` run used uncapped `dead --full`
against six pinned repositories:

| Repository | Commit | Candidate frame | Capability outcome |
| --- | --- | ---: | --- |
| codex | `de80fa6e3194d68b71b0f09be475179922e0f5b8` | 0 | indexing, source, semantics, and checker available |
| SynthRunnerRust | `658a52d355e8733d6ce759e77b84735a47ef3048` | 0 | available |
| VegaAssistant | `fa39d2d2e0b0f2332398c6f23472a25699741e23` | 3 | available; all reviewed |
| agentic_cad | `cc206b1877d70d0b64eca4046e3aab23bb5bbca3` | 0 | available |
| gpt-5.3-minecraft | `3b43aac8f085a73aba3b6dde71b1f5ee4d7f1eae` | unknown | Rust indexing failed |
| scip-query | `32df2397f775788d32c0cfc9cb7d3e9378fdac93` | 0 | available |

The indexing failure is explicit and contributes neither a clean result nor a
precision row. All five successful repositories had a runnable Rust indexer,
source fallback, rust-analyzer semantics, and a discovered `cargo check`
command. The ignored raw packet is
`reports/accuracy/2026-07-11T17-55-27-614Z-rust-dead-calibration.json`; the
committed review input is
[`2026-07-11-rust-dead-expansion-verdicts.json`](./2026-07-11-rust-dead-expansion-verdicts.json).

## Review

The three surviving rows were `CAP_INTERNET`, `find_first_of`, and
`Panel::panel_testid` in VegaAssistant's UAT example target. Exact-name search
at the pinned commit found only each declaration. Source and Cargo review found
no trait, derive, macro, target, feature, ABI, registration, generated, or
external-library path that would consume them. All three are valid under the
written rule, and the existing controlled private-library, binary-target, and
implicit-use fixtures remain known-positive/negative recall evidence.

Observed precision is 3/3, but findings come from one repository and the 95%
Wilson lower bound is only 43.9%. Four supported zeros and one failed index do
not increase that confidence. The verdict therefore remains insufficient and
is terminal for this named corpus. Rust `dead` must not contribute published
defect counts or leaderboard penalties until a future named corpus contributes
substantially more post-hardening findings.
