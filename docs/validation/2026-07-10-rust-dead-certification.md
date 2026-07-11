# Rust `dead` hardening result

Date: 2026-07-10
Status: **insufficient evidence for certification; hardened output is not public-actionable yet**

## Evaluated claim

A Rust `dead-code` row is a conservative repository deletion candidate: no source, test, trait-contract, macro or derive, ABI or registration, Cargo-target, configured-feature, public-library, generated, or reflective consumer is known. Checker verification is still required before deletion.

An implicit-usage row is an investigation signal whose runtime consumer is supplied by traits, macros, attributes, ABI linkage, generated code, or reflection. Its defining difference from direct dead code is that the analyzer has affirmative evidence that ordinary static references are incomplete. It is therefore excluded from health dead counts and cleanup plans.

## Result

| Measure                        |     Baseline |       Hardened replay |
| ------------------------------ | -----------: | --------------------: |
| Reviewed fixed-seed findings   |           52 |                     3 |
| Valid findings                 |            1 |                     3 |
| Invalid findings               |           51 |                     0 |
| Observed precision             |         1.9% |                100.0% |
| 95% Wilson lower bound         |         0.3% |                 43.8% |
| Repositories with findings     |            3 |                     1 |
| Known-positive recall fixtures |            0 |                     3 |
| Classification                 | experimental | insufficient evidence |

The detector was replayed against all three pinned repositories. Codex and SynthRunnerRust produced supported zeroes after public Cargo APIs were removed from deletion advice; VegaAssistant produced three findings, all valid. The evidence is too sparse to meet the required 90% Wilson lower bound or three-repository finding sample, so this result does not award certified or qualified status.

## Pinned corpus

| Repository      | Commit                                     | Baseline candidates | Hardened candidates |
| --------------- | ------------------------------------------ | ------------------: | ------------------: |
| openai/codex    | `de80fa6e3194d68b71b0f09be475179922e0f5b8` |                  54 |                   0 |
| SynthRunnerRust | `658a52d355e8733d6ce759e77b84735a47ef3048` |                   2 |                   0 |
| VegaAssistant   | `19c0d70d7d21d1a477a1eba6c911b09944b50991` |                 129 |                   3 |

All repositories reported available Rust SCIP indexing, source facts, rust-analyzer semantics, and `cargo check` cleanup verification. Their live worktrees were not modified.

## Hardening performed

- Cargo manifests now establish library targets. Public definitions in library-owned Rust source are treated as externally live because downstream callers can exist outside the indexed checkout.
- Binary-only targets remain eligible: `pub` changes Rust visibility inside a binary but does not create a downstream library API.
- Private library definitions remain eligible, protecting useful recall.
- Known trait, macro, attribute, ABI, generated, and reflective reachability is emitted as `implicit-usage`, not direct `dead-code`.
- Structured output reports entry-surface exclusions, external-root exclusions, and implicit-usage signals under `applicability` so future leaderboard coverage cannot silently improve through omitted code.
- Three focused positives prove detection of two private library functions and one public binary-only function.

The Cargo rule is intentionally conservative: a `pub` declaration anywhere in library-owned source is rooted even when a private module might prevent downstream access. This can reduce recall, but it prevents an unsupported deletion accusation. A future module/re-export reachability model may recover those candidates after it is calibrated separately.

## Remaining evidence gap

Certification requires a larger post-hardening finding frame. Add Rust repositories or historical pinned commits selected for private application code, binary targets, examples, feature-gated modules, and macro-heavy behavior until at least three repositories contribute reviewed findings and the Wilson lower bound can reach 90%. Controlled mutation fixtures remain recall evidence; they must not be counted as representative precision rows.

## Reproduction

```bash
npm run build
node scripts/accuracy-calibration.mjs health-dead --language rust --sample-size 10000
node scripts/accuracy-calibration.mjs summarize <packet.json> docs/validation/2026-07-10-rust-dead-certification-verdicts.json
```

Generated packets remain ignored under `reports/accuracy/`. The durable baseline and hardened verdict overlays are committed beside this report.
