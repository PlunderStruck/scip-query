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

| Analyzer or command              | TypeScript   | Rust         | Python       | Audit kind                 | Notes                                                                                                                       |
| -------------------------------- | ------------ | ------------ | ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dead`                           | certified    | insufficient | insufficient | finding certification      | Python lacks semantic/checker completeness; traceroot retained 2 source-backed candidates and Flask had 0.                  |
| `unused-imports`                 | certified    | qualified    | qualified    | finding certification      | Python literal `__all__` exports are honored; dynamic import completeness is not claimed.                                   |
| `unused-params`                  | insufficient | unsupported  | unsupported  | finding certification      | 5/5 valid, but all rows came from one repository.                                                                           |
| `cycles`                         | insufficient | qualified    | insufficient | graph-fact certification   | Python source/index path is supported, but the corpus supplied no natural positive or exhaustive oracle.                    |
| `duplicate-bodies`               | certified    | qualified    | insufficient | measurement certification  | Python normalized-body equality is supported but had no natural positive population.                                        |
| `complexity`                     | certified    | qualified    | qualified    | measurement certification  | Python source-derived branch counts are measurements, not runtime-behavior verdicts.                                        |
| `isolated`                       | insufficient | insufficient | insufficient | finding certification      | Python has supported zeros but lacks a natural positive and semantic completeness.                                          |
| `redundant-reexports`            | certified    | insufficient | unsupported  | finding certification      | The barrel/export model does not analyze Python module exports.                                                             |
| `not-implemented`                | insufficient | unsupported  | unsupported  | finding certification      | Placeholder syntax and reachability are JavaScript/TypeScript-specific.                                                     |
| `decorative-checkers`            | insufficient | unsupported  | unsupported  | finding certification      | Callable/failure syntax is JavaScript/TypeScript-specific.                                                                  |
| `test-quality`                   | insufficient | unsupported  | unsupported  | finding certification      | The source scan is restricted to JavaScript/TypeScript extensions.                                                          |
| `recent-duplicates`              | insufficient | qualified    | insufficient | history relationship       | Python completed with no natural relationship population.                                                                   |
| `similar`                        | certified    | qualified    | insufficient | relationship certification | Python completed with no natural shared-callee population.                                                                  |
| `similar-files`                  | certified    | qualified    | insufficient | relationship certification | Python completed with no natural distinctive-overlap population.                                                            |
| `similar-chains`                 | qualified    | qualified    | qualified    | bounded relationship       | Traceroot returned 1,994 relationships within the internal candidate frame.                                                 |
| `similar-signatures`             | certified    | qualified    | qualified    | measurement certification  | 11 traceroot and 2 Flask signature-shape relationships were source-valid.                                                   |
| `twin-drift`                     | qualified    | qualified    | insufficient | relationship certification | Python convention dunders are excluded; the replay then had no natural positive population.                                 |
| `co-change`                      | certified    | qualified    | qualified    | history relationship       | Python pairs are exact Git-history facts; design coupling remains contextual.                                               |
| `doc-drift`                      | certified    | qualified    | qualified    | history relationship       | Python citation/change-order facts are supported; priority remains contextual.                                              |
| `drift`                          | qualified    | insufficient | qualified    | subtype relationship       | Python dependency edges are factual; inferred layer policy remains a signal.                                                |
| `wrapper-candidates`             | certified    | qualified    | qualified    | relationship certification | Python disclosed two single-caller relationships; decorator/runtime boundaries require review.                              |
| `passthrough-candidates`         | certified    | qualified    | insufficient | relationship certification | Python completed with no natural positive population.                                                                       |
| `stale-abstractions`             | certified    | qualified    | insufficient | relationship certification | Two live Pydantic families were fixed; semantic/framework completeness is unavailable.                                      |
| `extract-candidates`             | certified    | qualified    | insufficient | measurement certification  | Python completed with no natural positive population.                                                                       |
| `locality-candidates`            | certified    | qualified    | qualified    | relationship certification | 39 Python ownership/destination relationships were disclosed; movement remains contextual.                                  |
| `coupling`                       | certified    | qualified    | qualified    | graph-fact certification   | 108 Python shared-indexed-symbol relationships were reproduced.                                                             |
| `bottlenecks`                    | certified    | qualified    | qualified    | graph-fact certification   | Three disclosed Python centrality facts are supported; utility remains contextual.                                          |
| `deep-chains`                    | certified    | qualified    | qualified    | graph-fact certification   | 15 condensed Python dependency paths were reproduced.                                                                       |
| `complexity-hotspots`            | certified    | qualified    | qualified    | measurement certification  | 310 Python composite source/index measurements are supported, not defect verdicts.                                          |
| `hotspots`                       | certified    | qualified    | qualified    | graph-fact certification   | 219 Python indexed reference-count rows were reproduced.                                                                    |
| `fan-in`                         | certified    | qualified    | qualified    | graph-fact certification   | 58 exact Python indexed-symbol counts do not claim runtime reachability.                                                    |
| `fan-out`                        | certified    | qualified    | qualified    | graph-fact certification   | 36 Python indexed external-symbol counts were reproduced.                                                                   |
| `react-component-duplicates`     | certified    | unsupported  | unsupported  | framework relationship     | 48/48 structural relationships valid across three React repositories; extraction remains contextual.                        |
| `react-hook-candidates`          | certified    | unsupported  | unsupported  | framework relationship     | 48/48 behavior relationships valid across three React repositories; hook extraction remains contextual.                     |
| `react-large-component-pressure` | certified    | unsupported  | unsupported  | framework measurement      | 48/48 pressure rows valid after dominant-axis and route-context hardening.                                                  |
| `vue-component-duplicates`       | certified    | unsupported  | unsupported  | framework relationship     | 41/41 structural relationships valid across four Vue repositories; recommendation utility remains contextual.               |
| `vue-composable-candidates`      | certified    | unsupported  | unsupported  | framework relationship     | 48/48 behavior relationships valid across three repositories with findings.                                                 |
| `vue-large-view-pressure`        | certified    | unsupported  | unsupported  | framework measurement      | 64/64 pressure rows valid across four Vue repositories.                                                                     |
| `augment-vue`                    | qualified    | unsupported  | unsupported  | reference completeness     | 841 exact-oracle component mentions across three repositories; broader local/property identity is withheld and unsupported. |

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

### Python detector slice

The Python audit pinned an indexer/syntax corpus, a FastAPI/Pydantic/Celery
production corpus, and a small Flask holdout. Checked boxes mean capability and
verdict are explicit; they do not imply semantic completeness.

- [x] Pinned three repositories with distinct evidence roles
- [x] Separated index, source, semantic-provider, framework, and checker capability
- [x] Hardened dunder, model-liveness, and `__all__` false-positive families
- [x] Marked TS/JS-only analyzers unsupported rather than clean
- [x] Replayed the Flask holdout and retained ordinary relationships

Certificate:
[`2026-07-11-python-detector-certification.md`](./validation/2026-07-11-python-detector-certification.md).

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
