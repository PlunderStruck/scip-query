# Rust detector certification

Date: 2026-07-11

Verdict: **Rust coverage is qualified, explicitly insufficient, or unsupported;
no detector in this renewal is promoted beyond its evidence.**

## What this certificate means

A Rust detector is a command that interprets Rust source and its SCIP index to
report a code fact or investigation signal. Its defining constraint is that
Rust traits, implementations, derives, macros, Cargo targets, features, public
library surfaces, ABI entry points, tests, and generated code can create real
uses that are not visible as an ordinary direct call. This certificate therefore
separates a measured relationship from advice and treats an unavailable
language path as `unsupported`, never as a clean zero.

`qualified` means the reviewed facts and controlled recall cases support the
stated, narrower contract, but the real-corpus population or independent oracle
does not satisfy the publication threshold. `insufficient` means a path exists
but the observed population cannot justify a precision claim. `unsupported`
means the implementation does not analyze Rust for that command.

## Pinned corpus and capability

The replay used read-only worktrees and checkout-local caches:

| Repository | Commit | Index/source capability | Independent checker |
| --- | --- | --- | --- |
| SynthRunnerRust | `658a52d355e8733d6ce759e77b84735a47ef3048` | available | `cargo check` available |
| VegaAssistant | `fa39d2d2e0b0f2332398c6f23472a25699741e23` | available | unavailable: required Tauri sidecar `binaries/extension_host-aarch64-apple-darwin` is absent |
| agentic_cad | `cc206b1877d70d0b64eca4046e3aab23bb5bbca3` | available | `cargo check` available |

The prior six-repository `dead` expansion remains part of the evidence and is
recorded in
[`2026-07-11-rust-dead-expansion.md`](./2026-07-11-rust-dead-expansion.md).
Vega's checker failure contributes no clean result.

Every population command used `--full`. `similar-chains --full` still has an
internal 500-generated-chain candidate frame, so its result is qualified as
bounded rather than uncapped. Counts below are detector outputs, not claims
that every row is actionable.

## Replay inventory

| Analyzer | Synth | agentic_cad | Vega | Verdict | Contract and boundary |
| --- | ---: | ---: | ---: | --- | --- |
| `dead` | 0 | 0 | 3 | insufficient | 3/3 reviewed valid, all from Vega; sparse population |
| `unused-imports` | 0 | 0 | 0 | qualified | high-precision binding evidence; implicit-trait imports are conservatively withheld |
| `unused-params` | — | — | — | unsupported | implementation has no Rust parameter analyzer |
| `cycles` | 1 | 9 | 0 | qualified | source/index dependency cycles; no compiler-exhaustive oracle |
| `duplicate-bodies` | 3 | 0 | 169 | qualified | normalized-body equality is factual; consolidation is contextual |
| `complexity` | fixture-backed | fixture-backed | fixture-backed | qualified | per-symbol source-derived branch measurement; macro expansion is outside the frame |
| `isolated` | 0 | 0 | 0 | insufficient | supported zero plus fixtures; no natural positive population |
| `redundant-reexports` | 0 | 0 | 0 | insufficient | Rust positive fixture exists; no natural positive population |
| `not-implemented` | — | — | — | unsupported | recognizes JavaScript/TypeScript placeholder syntax, not `todo!`/`unimplemented!` |
| `decorative-checkers` | — | — | — | unsupported | callable/failure syntax is JavaScript/TypeScript-specific |
| `test-quality` | — | — | — | unsupported | source scan is restricted to JavaScript/TypeScript extensions |
| `recent-duplicates` | 2 | 0 | 62 | qualified | valid Git-age and shared-callee facts after trait-required implementations are excluded |
| `similar` | 13 | 17 | not replayed | qualified | disclosed shared-callee relationship; refactoring advice is contextual |
| `similar-files` | 1 | 1 | not replayed | qualified | disclosed distinctive dependency overlap |
| `similar-chains` | 17,716 | not replayed | not replayed | qualified | bounded 500-generated-chain frame; not an actionability claim |
| `similar-signatures` | 7 | 0 | runtime-limited | qualified | callable signature equality; fields and trait-required implementations excluded |
| `twin-drift` | 0 | 0 | not replayed | qualified | convention methods excluded; supported zero plus focused positives |
| `co-change` | 0 | 1 | 218 | qualified | accepted pairs are Git-history facts; design coupling is contextual |
| `doc-drift` | 9 | 0 | 508 | qualified | citations/change order are factual; staleness priority is contextual |
| `drift` | 0 | 0 | 0 | insufficient | supported zero; no natural Rust subtype population |
| `wrapper-candidates` | 0 | 2 | not replayed | qualified | ordinary single-caller relationship; trait-contract implementations excluded |
| `passthrough-candidates` | 8 | 3 | 172 | qualified | literal forwarding relationship; removal utility is contextual |
| `stale-abstractions` | 0 | 1 | 31 | qualified | low-consumer fact; public/registration applicability still needs review |
| `extract-candidates` | 55 | 21 | not replayed | qualified | callee-cluster measurement; extraction is contextual |
| `locality-candidates` | 23 | 15 | 715 | qualified | ownership/destination relationship; movement is contextual |
| `coupling` | 118 | 71 | 5,930 | qualified | disclosed shared-symbol relationship |
| `bottlenecks` | 32 | 5 | 927 | qualified | disclosed centrality measurement; definition files may also be consumer files |
| `deep-chains` | 3 | 0 | 107 | qualified | condensed index paths; generated/macro-expanded edges are outside the frame |
| `complexity-hotspots` | 176 | 89 | 8,172 | qualified | composite source measurement, not a defect verdict |
| `hotspots` | 514 | 259 | 14,544 | qualified | index reference counts; module/crate rows remain contextual |
| `fan-in` | 205 | 165 | 6,608 | qualified | exact indexed-symbol counts, not whole-program/linker reachability |
| `fan-out` | 19 | 13 | 636 | qualified | indexed external-symbol counts |

`react-*`, `vue-*`, and `augment-vue` are unsupported for Rust by design. They
are framework analyzers whose real referents are React or Vue source units, not
general code analyzers.

## Defects found and corrected

The renewal found five Rust-specific false-positive families and corrected
each at the shared semantic boundary rather than excluding a library:

1. Convention methods such as `Default::default` and `From::from` were paired
   as twins. Rust trait/convention identities are now excluded from twin advice.
2. Trait-required implementations were presented as removable wrappers. Trait
   implementation members are now excluded from wrapper advice.
3. Trait imports used only through method resolution were reported unused, and
   grouped `use foo::{self, Bar}` bound the literal word `self`. Upper-camel and
   underscore Rust imports are conservatively withheld when implicit method
   use cannot be disproved, and grouped self-imports bind the module name.
4. Rust fields and trait-required members entered `similar-signatures` because
   raw SCIP term shapes were treated as callable. The detector now requires a
   function-like SCIP kind and excludes Rust trait implementations.
5. Bevy `Plugin::build` implementations received directional “pick one owner”
   advice from `recent-duplicates`. Trait-required pairs are now removed only
   from that advice surface; the general `similar` relationship remains.

Focused regressions cover every correction. On the untouched Vega holdout,
`recent-duplicates` still returns 62 ordinary relationships after the trait
filter. SynthRunnerRust still returns its two mesh-helper relationships, while
agentic_cad's three framework-contract rows fall to zero. That discriminating
probe shows the filter removes the invalid archetype without silencing Rust
similarity generally.

## Applicability record

- Trait and implementation contracts: excluded from removal/consolidation
  advice where the trait causes the repeated shape; inherent implementations
  remain eligible.
- Derive and macro use: protected by conservative dead/import rules where
  detectable; expansion-complete recall is not claimed.
- Generated code: excluded through the shared generated/source-file policy;
  generated consumers outside the index remain unavailable.
- Public API, ABI, binary, test, feature, and target use: `dead` applies its
  conservative surface/target gates and still requires `cargo check` before
  deletion. Other relationship analyzers report facts but do not certify
  removal.
- Framework-specific command families: unsupported, not successful zeros.

## Publication decision

Rust detector output is suitable for private shadow evaluation when each row
retains its evidence and verdict. It is not ready to be aggregated into a
public defect score: the renewal has not produced a statistically certifiable
Rust population, and several measurements deliberately omit macro-expanded or
whole-program facts. The safe public distinction is “observed indexed
relationship” versus “confirmed actionable finding.”

Machine-readable verdicts:
[`2026-07-11-rust-detector-certification-verdicts.json`](./2026-07-11-rust-detector-certification-verdicts.json).
