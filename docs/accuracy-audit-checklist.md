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
| `dead`                           | certified    | insufficient | pending     | finding certification      | Rust was hardened; more representative findings are required.                                                                 |
| `unused-imports`                 | certified    | pending      | pending     | finding certification      | 59/59 valid across three repositories after binding-evidence hardening.                                                       |
| `unused-params`                  | insufficient | unsupported  | unsupported | finding certification      | 5/5 valid, but all rows came from one repository.                                                                             |
| `cycles`                         | insufficient | pending      | pending     | graph-fact certification   | 3/3 source-verifiable import cycles, but one repository.                                                                      |
| `duplicate-bodies`               | certified    | pending      | pending     | measurement certification  | 40/40 normalized-body facts valid across four repositories.                                                                   |
| `complexity`                     | certified    | pending      | pending     | measurement certification  | 40/40 uncapped-frame measurements valid across four repositories.                                                             |
| `isolated`                       | insufficient | pending      | pending     | finding certification      | 3/3 valid across two repositories after contract hardening.                                                                   |
| `redundant-reexports`            | certified    | pending      | pending     | finding certification      | 40/40 binding/module facts valid; public surfaces remain signals.                                                             |
| `not-implemented`                | insufficient | pending      | pending     | finding certification      | Supported zero plus positive fixtures; no population precision frame.                                                         |
| `decorative-checkers`            | insufficient | pending      | pending     | finding certification      | Baseline wall removed; supported zero plus positive fixtures.                                                                 |
| `test-quality`                   | insufficient | pending      | pending     | finding certification      | 14/14 mock-echo facts valid across two repositories; other subtypes need population evidence.                                 |
| `recent-duplicates`              | insufficient | pending      | pending     | history relationship       | 8/8 valid across three repositories; more findings are required.                                                              |
| `similar`                        | certified    | pending      | pending     | relationship certification | 36/36 shared-evidence relationships valid across four repositories.                                                           |
| `similar-files`                  | certified    | pending      | pending     | relationship certification | 40/40 distinctive-dependency relationships valid across four repositories.                                                    |
| `similar-chains`                 | qualified    | pending      | pending     | bounded relationship       | 40/40 valid inside the 500-generated-chain candidate frame; sampled advice was non-actionable.                                |
| `similar-signatures`             | certified    | pending      | pending     | measurement certification  | 40/40 normalized-signature relationships valid across four repositories.                                                      |
| `twin-drift`                     | qualified    | pending      | pending     | relationship certification | 37/40 valid; generic-operation homonyms remain.                                                                               |
| `co-change`                      | certified    | pending      | pending     | history relationship       | 40/40 accepted Git-history relationships valid across four repositories.                                                      |
| `doc-drift`                      | certified    | pending      | pending     | history relationship       | 40/40 citation/co-change/change-order relationships valid across four repositories.                                           |
| `drift`                          | qualified    | pending      | pending     | subtype relationship       | 40/40 relationships valid; subtype breadth incomplete and sampled advice non-actionable.                                      |
| `wrapper-candidates`             | qualified    | pending      | pending     | relationship certification | 30/30 single-caller/fan-in facts valid; confidence floor remains 88.6%.                                                       |
| `passthrough-candidates`         | insufficient | pending      | pending     | relationship certification | 21/21 literal-forwarding facts valid; more findings are required.                                                             |
| `stale-abstractions`             | certified    | pending      | pending     | relationship certification | 40/40 low-consumer facts valid after ambient-declaration hardening.                                                           |
| `extract-candidates`             | certified    | pending      | pending     | measurement certification  | 43/43 callee-cluster measurements valid; extraction remains contextual.                                                       |
| `locality-candidates`            | certified    | pending      | pending     | relationship certification | 48/48 ownership/destination relationships valid; movement remains contextual.                                                 |
| `coupling`                       | certified    | pending      | pending     | graph-fact certification   | 48/48 exact shared-symbol relationships valid across four repositories.                                                       |
| `bottlenecks`                    | qualified    | pending      | pending     | graph-fact certification   | 33/33 centrality facts valid; confidence floor is 89.6%.                                                                      |
| `deep-chains`                    | certified    | pending      | pending     | graph-fact certification   | 48/48 condensed-component paths valid after cycle-depth hardening.                                                            |
| `complexity-hotspots`            | certified    | pending      | pending     | measurement certification  | 48/48 composite measurements valid across magnitude bands.                                                                    |
| `hotspots`                       | certified    | pending      | pending     | graph-fact certification   | 48/48 cross-file reference counts valid.                                                                                      |
| `fan-in`                         | certified    | pending      | pending     | graph-fact certification   | 48/48 exact-symbol counts valid after identity hardening.                                                                     |
| `fan-out`                        | certified    | pending      | pending     | graph-fact certification   | 48/48 external-symbol counts valid.                                                                                           |
| `react-component-duplicates`     | certified    | unsupported  | unsupported | framework relationship     | 48/48 structural relationships valid across three React repositories; extraction remains contextual.                          |
| `react-hook-candidates`          | certified    | unsupported  | unsupported | framework relationship     | 48/48 behavior relationships valid across three React repositories; hook extraction remains contextual.                       |
| `react-large-component-pressure` | certified    | unsupported  | unsupported | framework measurement      | 48/48 pressure rows valid after dominant-axis and route-context hardening.                                                    |
| `vue-component-duplicates`       | certified    | unsupported  | unsupported | framework relationship     | 41/41 structural relationships valid across four Vue repositories; recommendation utility remains contextual.                 |
| `vue-composable-candidates`      | certified    | unsupported  | unsupported | framework relationship     | 48/48 behavior relationships valid across three repositories with findings.                                                   |
| `vue-large-view-pressure`        | certified    | unsupported  | unsupported | framework measurement      | 64/64 pressure rows valid across four Vue repositories.                                                                       |
| `augment-vue`                    | insufficient | unsupported  | unsupported | reference completeness     | Operationally hardened on two dependency-ready repositories; resolved-site completeness needs a third source-reviewed cohort. |

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

- [x] `wrapper-candidates` — qualified relationship
- [x] `passthrough-candidates` — insufficient population evidence
- [x] `stale-abstractions` — certified relationship
- [x] `extract-candidates` — certified measurement; extraction remains contextual
- [x] `locality-candidates` — certified relationship; movement remains contextual
- [x] `drift` — qualified; subtype breadth incomplete
- [x] `co-change` — certified relationship
- [x] `doc-drift` — certified relationship
- [x] `coupling` — certified graph fact
- [x] `bottlenecks` — qualified graph fact; 89.6% confidence floor
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
- [x] `augment-vue` reference-completeness audit — operationally hardened;
      insufficient real-repository completeness evidence

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
