# Command Accuracy Audit Checklist

Date: 2026-07-10
Status: Active

## Purpose

This checklist tracks whether each public command tells the truth about the
repositories it analyzes. An accuracy audit is a repeatable comparison between
a command's output and independently inspectable source, compiler, index, Git,
or runtime facts. What distinguishes it from a smoke test is that a successful
exit is not evidence of a correct answer.

Audit the underlying analyzer once, then give aliases and workflow wrappers a
separate parity test. Record results independently by language and framework;
an unsupported analysis is `not analyzed`, never a successful zero.

## Evidence Gates

A finding-producing analyzer is complete only when it has:

- [ ] a written truth rule;
- [ ] a pinned, read-only corpus with at least three repositories;
- [ ] uncapped baseline candidate counts;
- [ ] deterministic samples classified from cited source;
- [ ] named false-positive archetypes;
- [ ] at least one known-positive recall case;
- [ ] regression tests for every fixed archetype;
- [ ] a fresh replay after hardening; and
- [ ] a recorded certification state: certified, qualified, experimental,
      unsupported, or insufficient evidence.

The certification thresholds and publication rules live in
[`accuracy-hardening-goal.md`](./accuracy-hardening-goal.md).

## Certification Matrix

Legend: `certified`, `qualified`, `experimental`, `insufficient`, `unsupported`,
`pending`, or `parity`.

| Analyzer or command              | TypeScript   | Rust         | Python      | Audit kind                 | Notes                                                                                                                         |
| -------------------------------- | ------------ | ------------ | ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `dead`                           | certified    | insufficient | pending     | finding certification      | Rust expansion: 3/3 valid from one repository, four supported zeros, and one explicit indexing failure; population still sparse. |
| `unused-imports`                 | certified    | qualified    | pending     | finding certification      | Rust uses a conservative implicit-trait boundary; 107 false positives removed across the renewal corpus.                      |
| `unused-params`                  | insufficient | unsupported  | unsupported | finding certification      | 5/5 valid, but all rows came from one repository.                                                                             |
| `cycles`                         | insufficient | qualified    | pending     | graph-fact certification   | Rust source/index cycles observed across two repositories; compiler-exhaustive completeness is not claimed.                    |
| `duplicate-bodies`               | certified    | qualified    | pending     | measurement certification  | Rust normalized-body equality is factual; consolidation remains contextual.                                                   |
| `complexity`                     | certified    | qualified    | pending     | measurement certification  | Rust source-derived branch counts exclude macro expansion.                                                                    |
| `isolated`                       | insufficient | insufficient | pending     | finding certification      | Rust has supported zeros and fixtures but no natural positive population.                                                     |
| `redundant-reexports`            | certified    | insufficient | pending     | finding certification      | Rust has a positive fixture but no natural positive population in the renewal corpus.                                         |
| `not-implemented`                | insufficient | unsupported  | pending     | finding certification      | Rust `todo!` and `unimplemented!` syntax is not analyzed.                                                                     |
| `decorative-checkers`            | insufficient | unsupported  | pending     | finding certification      | Callable/failure syntax is JavaScript/TypeScript-specific.                                                                    |
| `test-quality`                   | insufficient | unsupported  | pending     | finding certification      | The source scan is restricted to JavaScript/TypeScript extensions.                                                            |
| `recent-duplicates`              | insufficient | qualified    | pending     | history relationship       | Trait-required advice removed; 62 ordinary Vega holdout relationships remain.                                                 |
| `similar`                        | certified    | qualified    | pending     | relationship certification | Rust shared-callee facts are disclosed; refactoring advice remains contextual.                                                |
| `similar-files`                  | certified    | qualified    | pending     | relationship certification | Rust distinctive-dependency overlap is supported.                                                                            |
| `similar-chains`                 | qualified    | qualified    | pending     | bounded relationship       | Rust is also bounded by the 500-generated-chain internal frame.                                                               |
| `similar-signatures`             | certified    | qualified    | pending     | measurement certification  | Rust fields and trait-required members are excluded from callable signature equality.                                         |
| `twin-drift`                     | qualified    | qualified    | pending     | relationship certification | Rust convention methods are excluded; supported-zero and focused-positive evidence remains.                                  |
| `co-change`                      | certified    | qualified    | pending     | history relationship       | Rust Git-history relationships are factual; coupling advice remains contextual.                                               |
| `doc-drift`                      | certified    | qualified    | pending     | history relationship       | Rust citation/change-order facts are supported; priority remains contextual.                                                  |
| `drift`                          | qualified    | insufficient | pending     | subtype relationship       | Rust has no natural subtype population in the renewal corpus.                                                                 |
| `wrapper-candidates`             | certified    | qualified    | pending     | relationship certification | Rust trait implementations are excluded; ordinary single-caller relationships remain.                                        |
| `passthrough-candidates`         | certified    | qualified    | pending     | relationship certification | Rust literal-forwarding relationships are supported; removal remains contextual.                                              |
| `stale-abstractions`             | certified    | qualified    | pending     | relationship certification | Rust low-consumer facts require public/registration review.                                                                   |
| `extract-candidates`             | certified    | qualified    | pending     | measurement certification  | Rust callee-cluster measurements are supported; extraction remains contextual.                                                |
| `locality-candidates`            | certified    | qualified    | pending     | relationship certification | Rust ownership/destination relationships are supported; movement remains contextual.                                         |
| `coupling`                       | certified    | qualified    | pending     | graph-fact certification   | Rust disclosed shared-symbol relationships are supported.                                                                    |
| `bottlenecks`                    | certified    | qualified    | pending     | graph-fact certification   | Rust disclosed centrality facts are supported; utility remains contextual.                                                    |
| `deep-chains`                    | certified    | qualified    | pending     | graph-fact certification   | Rust condensed index paths exclude unavailable macro/generated edges.                                                         |
| `complexity-hotspots`            | certified    | qualified    | pending     | measurement certification  | Rust composite source measurements are supported, not defect verdicts.                                                       |
| `hotspots`                       | certified    | qualified    | pending     | graph-fact certification   | Rust indexed reference counts are supported; module/crate rows remain contextual.                                             |
| `fan-in`                         | certified    | qualified    | pending     | graph-fact certification   | Rust exact indexed-symbol counts do not claim linker-wide reachability.                                                       |
| `fan-out`                        | certified    | qualified    | pending     | graph-fact certification   | Rust indexed external-symbol counts are supported.                                                                            |
| `react-component-duplicates`     | certified    | unsupported  | unsupported | framework relationship     | 48/48 structural relationships valid across three React repositories; extraction remains contextual.                          |
| `react-hook-candidates`          | certified    | unsupported  | unsupported | framework relationship     | 48/48 behavior relationships valid across three React repositories; hook extraction remains contextual.                       |
| `react-large-component-pressure` | certified    | unsupported  | unsupported | framework measurement      | 48/48 pressure rows valid after dominant-axis and route-context hardening.                                                    |
| `vue-component-duplicates`       | certified    | unsupported  | unsupported | framework relationship     | 41/41 structural relationships valid across four Vue repositories; recommendation utility remains contextual.                 |
| `vue-composable-candidates`      | certified    | unsupported  | unsupported | framework relationship     | 48/48 behavior relationships valid across three repositories with findings.                                                   |
| `vue-large-view-pressure`        | certified    | unsupported  | unsupported | framework measurement      | 64/64 pressure rows valid across four Vue repositories.                                                                       |
| `augment-vue`                    | qualified    | unsupported  | unsupported | reference completeness     | 841 exact-oracle component mentions across three repositories; broader local/property identity is withheld and unsupported.   |

### TypeScript factual detector slice

These boxes mean the detector was run uncapped on the pinned corpus, reviewed,
hardened where evidence proved a defect, replayed, and assigned an honest
state. A checked box does not upgrade an `insufficient` state to `certified`.

- [x] `unused-imports` — certified
- [x] `unused-params` — insufficient population evidence
- [x] `cycles` — insufficient population evidence
- [x] `duplicate-bodies` — certified
- [x] `complexity` — certified
- [x] `isolated` — insufficient population evidence
- [x] `redundant-reexports` — certified
- [x] `not-implemented` — supported zero; insufficient population evidence
- [x] `decorative-checkers` — supported zero; insufficient population evidence
- [x] `test-quality` — insufficient subtype and repository breadth

### Rust detector slice

The Rust renewal used three pinned repositories for the broad detector replay
and retains the prior six-repository `dead` expansion. Checked boxes mean the
row has an explicit applicability boundary and verdict, not that it is
publication-certified.

- [x] Factual detectors — qualified, insufficient, or unsupported as recorded
- [x] Similarity/history detectors — trait and convention false positives hardened
- [x] Architecture detectors — relationship facts separated from removal advice
- [x] Graph-risk detectors — indexed facts qualified against macro/whole-program limits
- [x] Rust applicability — trait, impl, derive, macro, generated, surface,
      target, feature, test, binary, and ABI boundaries recorded
- [x] Untouched holdout — Vega retained 62 ordinary recent-duplicate relationships

Certificate:
[`2026-07-11-rust-detector-certification.md`](./validation/2026-07-11-rust-detector-certification.md).

## Similarity and Duplication

TypeScript general similarity certification is complete. Execution plan and
certificate:
[`2026-07-10-typescript-similarity-detector-certification.md`](./plans/2026-07-10-typescript-similarity-detector-certification.md).
[`2026-07-10-typescript-similarity-detectors.md`](./validation/2026-07-10-typescript-similarity-detectors.md).

- [x] `recent-duplicates` — insufficient population evidence
- [x] `similar` — certified relationship
- [x] `similar-files` — certified relationship
- [x] `similar-chains` — qualified within a bounded candidate frame
- [x] `similar-signatures` — certified relationship
- [x] `twin-drift` — qualified; 37/40 valid
- [x] `react-component-duplicates` — certified relationship
- [x] `vue-component-duplicates` — certified relationship
- [x] `convergence` alias parity with `similar --plan`
- [x] `twin-ab` — certified generated-scaffold correctness for importable named
      TypeScript callables; private-callable support is outside the current
      contract

For each analyzer, verify the measured similarity independently from whether
consolidation would improve the code.

## Architecture and Refactoring Signals

- [x] `wrapper-candidates` — certified production single-caller relationship
- [x] `passthrough-candidates` — certified literal-forwarding relationship
- [x] `stale-abstractions` — certified relationship
- [x] `extract-candidates` — certified measurement; extraction remains contextual
- [x] `locality-candidates` — certified relationship; movement remains contextual
- [x] `drift` — qualified; subtype breadth incomplete
- [x] `co-change` — certified relationship
- [x] `doc-drift` — certified relationship
- [x] `coupling` — certified graph fact
- [x] `bottlenecks` — certified disclosed graph fact; utility remains contextual
- [x] `deep-chains` — certified condensed-component path
- [x] `complexity-hotspots` — certified measurement
- [x] `hotspots` — certified graph fact
- [x] `fan-in` — certified exact-symbol graph fact
- [x] `fan-out` — certified graph fact

These audits must label the measured relationship separately from the proposed
action. A real relationship can still be an unhelpful recommendation.

## React and Vue Signals

- [x] `react-component-duplicates` — 48/48, certified relationship
- [x] `react-hook-candidates` — 48/48, certified relationship
- [x] `react-large-component-pressure` — 48/48, certified measurement
- [x] `vue-component-duplicates` — 41/41, certified relationship
- [x] `vue-composable-candidates` — 48/48, certified relationship
- [x] `vue-large-view-pressure` — 64/64, certified measurement
- [x] `augment-vue` — qualified exact cross-file component identity across
      three repositories; broader local/property identity unsupported

Use framework-specific repositories and record framework applicability rather
than treating absent framework evidence as a clean result.

Framework certificate:
[`2026-07-11-react-vue-detectors.md`](./validation/2026-07-11-react-vue-detectors.md).
The six detector measurements are certified; their sampled refactoring advice
was not independently actionable without local design context.

## Diff, Cleanup, and Health Workflows

- [ ] `incomplete-migration`
- [ ] `cleanup-plan`
- [ ] `cleanup-apply`
- [ ] `diff-gate`
  - [ ] `echo`
  - [ ] `incomplete-migration`
  - [ ] `co-change-partner`
  - [ ] `twin-partner`
  - [ ] `coverage-contract`
  - [ ] `doc-reference`
  - [ ] `unused-params`
  - [ ] `new-dead`
  - [ ] `baseline`
- [ ] `health`
- [ ] `self-audit`
- [ ] `effectiveness`
- [ ] `affected`
- [ ] `change-surface`
- [ ] `diff-impact`
- [ ] `plan-context`

Composite commands reuse certified detector rows, then receive an aggregation,
scope, suppression, and status-propagation audit. They do not inherit trust
merely because one input detector is certified.

## Navigation and Graph Answers

- [ ] `files`
- [ ] `methods`
- [ ] `refs`
- [ ] `trace`
- [ ] `deps`
- [ ] `rdeps`
- [ ] `system`
- [ ] `surface`
- [ ] `imports`
- [ ] `imported-by`
- [ ] `outline`
- [ ] `members`
- [ ] `by-kind`
- [ ] `kind-counts`
- [ ] `hierarchy`
- [ ] `code`
- [ ] `dataflow`
- [ ] `slice`
- [ ] `call-graph`
- [ ] `stats`

These commands need exact-answer comparisons against compiler, source, or
hand-established graph oracles, including aliases, overloads, re-exports,
traits, implementations, inheritance, generated files, and cross-language
boundaries.

## Indexing and Operations

- [ ] `reindex`
- [ ] `augment-sources`
- [ ] `watch`
- [ ] `status`
- [ ] `work-audit`
- [ ] `bench`
- [ ] `capabilities`
- [ ] `capability-matrix` alias parity
- [ ] `doctor`
- [ ] `check-deps`
- [ ] `config-validate`
- [ ] `suppress`
- [ ] `init`
- [ ] `setup`
- [ ] `setup-agent`
- [ ] `setup-hooks`
- [ ] `setup-ci`
- [ ] `uninstall`
- [ ] `install-skills`
- [ ] `tla`

Operational audits exercise cold and incremental indexes, additions, edits,
deletions, renames, branch switches, stale caches, interrupted publication,
concurrent invocations, daemon sleep/wake, idempotent setup, and clean removal.

## Campaign Order

1. Finish the TypeScript factual detector matrix above.
2. Certify TypeScript similarity and history-derived analyzers.
3. Certify TypeScript architectural and framework signals.
4. Repeat supported detector campaigns for Rust.
5. Build and certify Python semantic and framework coverage.
6. Audit composite workflows and public evidence views.
7. Complete navigation and operational reliability matrices.
