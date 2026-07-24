# Analyzer Validation Ledger

This ledger records the analyzer evaluation work carried out after the analyzer inventory, validation protocol, and locality design. It is the operating document for keeping analyzer accuracy work traceable end to end.

The companion documents are:

- `docs/analyzer-inventory.md`: names the analyzers and their action tiers.
- `docs/analyzer-validation-protocol.md`: defines the review protocol and per-analyzer TP/FP/FN criteria.
- `docs/locality-analyzer-design.md`: defines the locality and organization analyzer behavior.

## Source Anchors

The ledger is anchored to the current tool surface, not memory.

| Surface                   | Source                                                                                                                                                                                                                                                                                                        | Why it anchors the ledger                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Repo-wide health analysis | `scip-query code health --json` reported `src/queries/health/health.ts:218`, where `health()` runs `runHealthAnalyses()` and `buildHealthReport()` through the health budget that carries full-vs-bounded semantic enrichment.                                                                                | Every repo-wide analyzer validation must eventually reconcile with health output and scoring. |
| Change-time gate analysis | `scip-query code diffGate --json` reported `src/queries/impact/diff-gate.ts:228`, where `diffGate()` runs the default diff-scoped checks: `echo`, `incomplete-migration`, `co-change-partner`, `doc-reference`, `unused-params`, and `new-dead`. The baseline ratchet is explicit because it is repo-wide.    | Every diff-only analyzer needs a separate validation path from repo-wide health.              |
| Public command registry   | `scip-query trace queryCommandOrder --json` reported `src/runtime/commands/query-command-specs.ts:11`, where the public query command order starts. `scip-query code queryCommandDescriptor --json` reported `src/runtime/commands/query-command-specs.ts:104`, where command descriptors are resolved by id. | The ledger must not silently miss a public analyzer command.                                  |
| Diff-gate check list      | `scip-query trace DIFF_GATE_CHECKS --json` reported `src/queries/impact/diff-gate.ts:64`, where the canonical diff-gate check list is exported.                                                                                                                                                               | The ledger must cover every change-time check that can block a diff.                          |

## Core Concepts

A validation ledger is a maintained record of analyzer evaluation work, including the claim being tested, the repositories used, the evidence captured, the verdict, and the next precision action. Its essential role is to keep validation from dissolving into scattered notes by making every analyzer claim traceable to a reviewed outcome.

A ledger item is one independently completable evaluation obligation. It may cover one analyzer, one analyzer family, one repository run, or one score-model decision; its essential characteristic is that it has a clear done signal and can move from ready to complete without needing the whole validation effort to finish.

A run batch is a bounded execution of analyzer commands against one repository and revision. It is the smallest repeatable field-test unit because it records the project, commit, commands, raw output, sample selection, and reviewer verdicts together.

A calibration decision is a documented change to detector confidence, action tier, score weight, threshold, wording, or evidence fields. It is not just a preference; it is a maintainer decision justified by reviewed true positives, false positives, false negatives, suppressions, or repair outcomes.

A repair outcome is the result of acting on an analyzer finding. It matters because an analyzer can be locally accurate while still causing bad repairs, churn, misplaced abstractions, or broader APIs when an agent follows it.

## Status Values

| Status     | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `ready`    | The item has a defined scope, command set, corpus, and done signal.                |
| `running`  | Raw analyzer output or human review is currently being collected.                  |
| `blocked`  | The item cannot be completed until tooling, indexing, or corpus access improves.   |
| `complete` | The item has reviewed evidence, verdicts, and any next precision actions recorded. |
| `deferred` | The item is valid but intentionally lower priority than other ledger work.         |

## Active Ledger

Closeout status: all active ledger rows are complete as of 2026-06-22. Remaining future work is provider- or corpus-gated, not an unfinished validation slice: true co-change issue/PR label ingestion needs a repository metadata provider, and locality score integration needs stronger consumer-coverage plus repair-outcome evidence.

| ID      | Item                                   | Scope                                                                                                                                                                                  | Status     | Next action                                                                                                                         | Done signal                                                                                                                            |
| ------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| AVL-001 | Field evaluation baseline              | Run the protocol on `scip-query`, `Stable_Management`, `Vega_2.0`, and `SynthRunnerRust`.                                                                                              | `complete` | Completed in `docs/validation/2026-06-21-second-repo-confirmation.md`.                                                              | A dated run summary exists for each repo with raw-output locations and sampling notes.                                                 |
| AVL-002 | Direct repair analyzer verdicts        | `cleanup-plan`, `dead`, `new-dead`, `isolated`, `unused-params`, `unused-imports`, `redundant-reexports`, `passthrough-candidates`, `cycles`, broken `doc-drift`, and `doc-reference`. | `complete` | Completed in `docs/validation/2026-06-21-direct-deletion-family-closure-result.md`.                                                 | Each direct analyzer has TP/FP/FN counts, accepted-design examples, and precision actions.                                             |
| AVL-003 | Contextual signal analyzer verdicts    | Similarity, extraction, locality, wrapper, stale abstraction, frontend duplicate, hook/composable, co-change, bottleneck, coupling, drift, and deep-chain families.                    | `complete` | Completed in `docs/validation/2026-06-21-contextual-signal-closure-result.md`.                                                      | Each contextual family has a reviewed precision note and a score-weight recommendation.                                                |
| AVL-004 | Support analysis accuracy              | `affected`, `change-surface`, `plan-context`, navigation commands, graph metrics, and `self-audit`.                                                                                    | `complete` | Completed in `docs/validation/2026-06-21-support-analysis-accuracy-result.md`.                                                      | Support commands have referential-accuracy notes and known unsupported cases.                                                          |
| AVL-005 | Analyzer implementation parity         | Confirm each public analyzer command's documented behavior matches implementation behavior.                                                                                            | `complete` | Completed in `docs/validation/2026-06-21-analyzer-implementation-parity-result.md`.                                                 | The inventory and protocol either match implementation or list required doc/code corrections.                                          |
| AVL-006 | Score calibration                      | Evaluate direct findings, contextual signals, suppressions, validation ratio, and signal backlog pressure.                                                                             | `complete` | Completed in `docs/validation/2026-06-21-score-calibration-finalization-result.md`.                                                 | A calibration memo states score-weight changes, accepted current weights, or blocked evidence gaps.                                    |
| AVL-007 | Output and schema quality              | Verify each analyzer emits enough structured evidence for users and agents to review the claim.                                                                                        | `complete` | Completed in `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`.                                             | Each analyzer family has an output-quality verdict and missing-field list.                                                             |
| AVL-008 | Performance and budget behavior        | Check large-index behavior, `--full`, scan limits, git-history bounds, and graceful degradation.                                                                                       | `complete` | Completed in `docs/validation/2026-06-21-performance-budget-behavior-result.md`.                                                    | Budget behavior is documented with any timeout, cap, or misleading-empty-output issues.                                                |
| AVL-009 | Suppression lifecycle                  | Evaluate whether suppressions are stale, justified, expired, or useful as detector precision feedback.                                                                                 | `complete` | Completed in `docs/validation/2026-06-21-suppression-lifecycle-result.md`.                                                          | Suppression categories have counts, stale examples, and trust-weight recommendations.                                                  |
| AVL-010 | Cross-language capability boundaries   | Establish what works for TypeScript, React, Vue, Rust, and any unsupported language surfaces.                                                                                          | `complete` | Completed in `docs/validation/2026-06-21-cross-language-capability-boundaries-result.md`.                                           | Capability notes distinguish "no findings" from "not supported by current evidence."                                                   |
| AVL-011 | Agent repair outcomes                  | Test whether acting on analyzer findings produces better code rather than churn or misplaced abstraction.                                                                              | `complete` | Completed in `docs/validation/2026-06-21-agent-repair-outcomes-result.md`.                                                          | Each action tier has at least one reviewed repair outcome or an explicit reason it cannot be tested yet.                               |
| AVL-012 | Locality analyzer validation           | Validate the proposed `locality-candidates` report and `scip-locality-review` skill workflow before implementation.                                                                    | `complete` | Completed in `docs/validation/2026-06-21-locality-analyzer-validation-result.md`.                                                   | The locality design has TP/FP/FN-style examples and a go/no-go recommendation for implementation.                                      |
| AVL-013 | Config and declared-coupling freshness | Check whether `.scipquery.json` declared couplings and suppressions still point at current paths.                                                                                      | `complete` | Completed in `docs/validation/2026-06-21-config-declared-coupling-freshness-result.md`.                                             | Stale config paths are fixed, removed, or documented as intentionally retained.                                                        |
| AVL-014 | Public command surface coverage        | Ensure every public analyzer command is present in the inventory, protocol, and ledger.                                                                                                | `complete` | Completed in `docs/validation/2026-06-21-public-command-surface-coverage-result.md`.                                                | A coverage checklist shows no missing analyzer or marks non-analyzer support commands separately.                                      |
| AVL-015 | TypeScript `dead` certification        | Fixed-seed four-repository precision review, causal remediation, holdout replay, and known-positive recall.                                                                            | `complete` | Certified in `docs/validation/2026-07-10-typescript-dead-certification.md`.                                                         | Precision, confidence, corpus, and recall gates pass under the repository-dead truth rule.                                             |
| AVL-016 | Rust `dead` hardening                  | Pinned Codex, SynthRunnerRust, and VegaAssistant review covering Cargo surfaces, traits, macros, reflection, examples, and positive recall.                                            | `complete` | Hardened but insufficiently evidenced in `docs/validation/2026-07-10-rust-dead-certification.md`; expand the corpus before renewal. | Every baseline false positive is removed, applicability is visible, recall fixtures pass, and failed certification gates are explicit. |

## Public Command Coverage Checklist

The canonical source is `src/runtime/commands/query-command-specs.ts:11-78`, where `queryCommandOrder` lists the public query command surface.

- Core and navigation support: `stats`, `files`, `methods`, `refs`, `trace`, `deps`, `rdeps`, `system`, `surface`, `imports`, `imported-by`, `outline`, `members`, `by-kind`, `kind-counts`, `hierarchy`, `call-graph`, `code`, `dataflow`, `slice`
- Direct cleanup and deletion analyzers: `dead`, `isolated`, `unused-imports`, `cleanup-plan`, `unused-params`, `passthrough-candidates`, `redundant-reexports`
- Similarity, reuse, extraction, and locality analyzers: `similar`, `similar-files`, `similar-chains`, `similar-signatures`, `recent-duplicates`, `duplicate-bodies`, `twin-drift`, `twin-ab`, `extract-candidates`, `locality-candidates`, `wrapper-candidates`, `stale-abstractions`, `doc-drift`, `drift`, `convergence`
- Frontend analyzers: `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`
- Graph, risk, and complexity analyzers: `architecture`, `hotspots`, `fan-in`, `fan-out`, `coupling`, `cycles`, `bottlenecks`, `deep-chains`, `complexity-hotspots`, `complexity`
- Diff, impact, and planning analyzers: `affected`, `change-surface`, `co-change`, `diff-gate`, `incomplete-migration`, `plan-context`
- Formal model verification: `tla`
- Meta and action commands: `self-audit`, `cleanup-apply`

## Completed Run Batches

The completed effort used this order so early runs created useful evidence for later calibration work.

Current pilot:

- Plan: `docs/plans/2026-06-21-analyzer-validation-pilot.md`
- Summary: `docs/validation/2026-06-21-analyzer-validation-pilot.md`
- Verdict review: `docs/validation/2026-06-21-analyzer-verdict-review.md`
- Calibration memo: `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- Precision implementation plan: `docs/plans/2026-06-21-analyzer-precision-implementation.md`
- Precision implementation result: `docs/validation/2026-06-21-analyzer-precision-implementation-result.md`
- Stable_Management second confirmation: `docs/validation/2026-06-21-stable-management-second-confirmation.md`
- Echo tier refinement result: `docs/validation/2026-06-21-echo-tier-refinement-result.md`
- Wrapper boundary evidence result: `docs/validation/2026-06-21-wrapper-boundary-evidence-result.md`
- Passthrough boundary evidence result: `docs/validation/2026-06-22-passthrough-boundary-evidence-result.md`
- Passthrough public-facade caveats result: `docs/validation/2026-06-22-passthrough-public-facade-caveats-result.md`
- Public surface caveats result: `docs/validation/2026-06-22-public-surface-caveats-result.md`
- Doc cited-claim metadata result: `docs/validation/2026-06-22-doc-cited-claim-metadata-result.md`
- Root-cause grouping result: `docs/validation/2026-06-22-root-cause-grouping-result.md`
- Co-change partner labels result: `docs/validation/2026-06-22-co-change-partner-labels-result.md`
- Incomplete migration containment result: `docs/validation/2026-06-22-incomplete-migration-containment-result.md`
- Co-change recency and broad-sweep context result: `docs/validation/2026-06-22-co-change-recency-sweep-result.md`
- Doc drift historical intent result: `docs/validation/2026-06-22-doc-drift-historical-intent-result.md`
- Framework entry caveats result: `docs/validation/2026-06-22-framework-entry-caveats-result.md`
- Incomplete migration scope hints result: `docs/validation/2026-06-22-incomplete-migration-scope-hints-result.md`
- Doc reference citation parser result: `docs/validation/2026-06-22-doc-reference-citation-parser-result.md`
- Co-change subject context result: `docs/validation/2026-06-22-co-change-subject-context-result.md`
- Second-corpus score-weight confirmation result: `docs/validation/2026-06-22-second-corpus-score-weight-confirmation-result.md`
- Passthrough exported-facade second-corpus result: `docs/validation/2026-06-22-passthrough-exported-facade-second-corpus-result.md`
- Incomplete migration second-corpus scope result: `docs/validation/2026-06-22-incomplete-migration-second-corpus-scope-result.md`
- Doc parser second-corpus validation result: `docs/validation/2026-06-22-doc-parser-second-corpus-validation-result.md`
- Validation ledger closeout result: `docs/validation/2026-06-22-validation-ledger-closeout-result.md`
- Global install cross-verification result: `docs/validation/2026-06-22-global-install-cross-verification-result.md`
- Stable Management locality suggested-home review: `docs/validation/2026-06-22-stable-management-locality-suggested-home-review.md`
- Locality positive suggested-home result: `docs/validation/2026-06-22-locality-positive-suggested-home-result.md`
- Stable_Management wrapper confirmation: `docs/validation/2026-06-21-stable-management-wrapper-boundary-confirmation.md`
- Vue pressure-kind output result: `docs/validation/2026-06-21-vue-pressure-kind-output-result.md`
- Similarity evidence split result: `docs/validation/2026-06-21-similarity-evidence-split-result.md`
- Doc citation-kind output result: `docs/validation/2026-06-21-doc-citation-kind-output-result.md`
- Baseline metadata inheritance result: `docs/validation/2026-06-21-baseline-metadata-inheritance-result.md`
- Second-repo confirmation: `docs/validation/2026-06-21-second-repo-confirmation.md`
- Rust wrapper and React pressure review: `docs/validation/2026-06-21-rust-wrapper-react-pressure-review.md`
- React pressure-kind output result: `docs/validation/2026-06-21-react-pressure-kind-output-result.md`
- Rust wrapper boundary vocabulary result: `docs/validation/2026-06-21-rust-wrapper-boundary-vocabulary-result.md`
- Frontend behavior evidence classification result: `docs/validation/2026-06-21-frontend-behavior-evidence-classification-result.md`
- Extract candidate evidence classification result: `docs/validation/2026-06-21-extract-candidate-evidence-classification-result.md`
- Stale abstraction action-tier result: `docs/validation/2026-06-21-stale-abstraction-action-tier-result.md`
- Health score action-tier counts result: `docs/validation/2026-06-21-health-score-action-tier-counts-result.md`
- Graph-risk family result: `docs/validation/2026-06-21-graph-risk-family-result.md`
- Config declared-coupling freshness result: `docs/validation/2026-06-21-config-declared-coupling-freshness-result.md`
- Suppression lifecycle result: `docs/validation/2026-06-21-suppression-lifecycle-result.md`
- Support analysis accuracy result: `docs/validation/2026-06-21-support-analysis-accuracy-result.md`
- Cross-language capability boundaries result: `docs/validation/2026-06-21-cross-language-capability-boundaries-result.md`
- Public command surface coverage result: `docs/validation/2026-06-21-public-command-surface-coverage-result.md`
- Analyzer implementation parity result: `docs/validation/2026-06-21-analyzer-implementation-parity-result.md`
- Performance and budget behavior result: `docs/validation/2026-06-21-performance-budget-behavior-result.md`
- Agent repair outcomes result: `docs/validation/2026-06-21-agent-repair-outcomes-result.md`
- Locality analyzer validation result: `docs/validation/2026-06-21-locality-analyzer-validation-result.md`
- Direct small analyzer verdicts result: `docs/validation/2026-06-21-direct-small-analyzer-verdicts-result.md`
- Direct remaining verdicts result: `docs/validation/2026-06-21-direct-remaining-verdicts-result.md`
- Direct deletion-family closure result: `docs/validation/2026-06-21-direct-deletion-family-closure-result.md`
- Contextual signal closure result: `docs/validation/2026-06-21-contextual-signal-closure-result.md`
- Score calibration finalization result: `docs/validation/2026-06-21-score-calibration-finalization-result.md`
- Output/schema quality finalization result: `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`
- Raw output root: `/tmp/scip-query-validation/2026-06-21-pilot`

### Batch 1: Corpus Baseline

- Repositories: `scip-query`, `Stable_Management`, `Vega_2.0`, `SynthRunnerRust`.
- Commands:
  - `git rev-parse HEAD`
  - `scip-query reindex`
  - `scip-query health --full --json`
  - `scip-query diff-gate --json`
  - `scip-query capability-matrix`
- Outputs:
  - Raw JSON outside the repo unless intentionally promoted.
  - Plain text output when a command does not expose `--json`.
  - Summary in `docs/validation/YYYY-MM-DD-corpus-baseline.md`.

### Batch 2: Direct Repair Families

- Commands:
  - `scip-query cleanup-plan --json`
  - `scip-query dead --only-dead --json`
  - `scip-query isolated --json`
  - `scip-query unused-params --json`
  - `scip-query redundant-reexports`
  - `scip-query passthrough-candidates --json`
  - `scip-query cycles --json`
  - `scip-query doc-drift --json`
- Review:
  - Top 10 findings, 5 threshold-edge findings, and 5 false-negative probes where possible.
  - Classify as `tp`, `fp`, `accepted_design`, `needs_judgment`, or `fn`.

### Batch 3: Contextual Signal Families

- Commands:
  - `scip-query similar --json`
  - `scip-query similar-files --json`
  - `scip-query similar-chains --json`
  - `scip-query similar-signatures --json`
  - `scip-query recent-duplicates --json`
  - `scip-query extract-candidates --json`
  - `scip-query wrapper-candidates --json`
  - `scip-query stale-abstractions --json`
  - `scip-query co-change --json`
  - `scip-query bottlenecks --json`
  - `scip-query coupling --json`
  - `scip-query deep-chains --json`
  - `scip-query drift --json`
- Review:
  - Separate "true signal" from "direct repair."
  - Record what product or architecture judgment was needed.

### Batch 4: Frontend-Specific Families

- React corpus: `Vega_2.0`.
- Vue corpus: `Stable_Management`.
- Commands:
  - `scip-query react-component-duplicates --full --json`
  - `scip-query react-hook-candidates --full --json`
  - `scip-query react-large-component-pressure --full --json`
  - `scip-query vue-component-duplicates --full --json`
  - `scip-query vue-composable-candidates --full --json`
  - `scip-query vue-large-view-pressure --full --json`
- Review:
  - Validate whether findings imply component extraction, hook/composable extraction, locality repair, or only investigation.

### Batch 5: Evidence Providers and Agent Outcomes

- Commands:
  - `scip-query plan-context <target> --full --json`
  - `scip-query change-surface <file> --json`
  - `scip-query affected <symbol> --json`
  - `scip-query refs <symbol> --json`
  - `scip-query imports <file> --json`
  - `scip-query rdeps <file>`
  - `scip-query self-audit --samples 100 --json`
- Review:
  - Confirm reference accuracy.
  - Pick a small number of analyzer findings and record whether an agent could repair them cleanly.

## Verdict Record Template

```json
{
  "ledgerId": "AVL-002",
  "repo": "scip-query",
  "revision": "COMMIT",
  "command": "dead --only-dead --json",
  "findingId": "stable id or pasted summary",
  "location": "src/path/file.ts:10",
  "verdict": "tp | fp | accepted_design | needs_judgment | fn",
  "actionTier": "direct | signal | support",
  "evidence": ["facts that support the verdict"],
  "counterevidence": ["facts that weaken the analyzer claim"],
  "repairOutcome": "not_attempted | improved | churn | bad_abstraction | blocked",
  "precisionAction": "none | parser | root_detection | threshold | score_weight | output_schema | docs | tests",
  "notes": "short reviewer note"
}
```

## Update Rules

When a run batch completes:

1. Update the relevant `AVL-*` rows from `ready` or `running` to `complete`, `blocked`, or `deferred`.
2. Add a dated summary under `docs/validation/` when the result is worth retaining.
3. Keep raw JSON out of the repo unless it is small and useful as a fixture.
4. Turn precision actions into implementation issues or a concrete implementation plan.
5. If a finding changes an action tier or score-weight recommendation, update `docs/analyzer-inventory.md` and `docs/analyzer-validation-protocol.md`.

## Initial End-to-End Slice

The first concrete run was intentionally narrow:

1. Run Batch 1 on `scip-query` and `Stable_Management`.
2. Run Batch 2 only for `dead`, `unused-params`, `passthrough-candidates`, and `doc-drift`.
3. Run Batch 3 only for `similar`, `wrapper-candidates`, and `co-change`.
4. Run Batch 4 only for Vue on `Stable_Management`.
5. Record at least 30 reviewed verdicts.
6. Produce one calibration memo that says whether the current direct/signal/support split still holds.

That slice tested the ledger, the protocol, the review burden, and the score model before the later completion passes covered the remaining analyzer families.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the ledger's command-surface and diff-gate citations. `queryCommandOrder` remains the canonical public query order, and `orderedQueryCommandDescriptors` is now derived from that list for CLI registration. `diffGate()` still runs the same check families recorded in the ledger; finding construction now goes through a local recorder that derives the suppression hint consistently.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked the `diff-gate.ts` citation again after doc-reference and baseline policy helpers moved into private query modules. The ledger remains accurate because `diffGate()` and `DIFF_GATE_CHECKS` still live in `src/queries/impact/diff-gate.ts`; the baseline policy body remains behind the same entry point, but the repo-wide baseline ratchet is explicit rather than part of default diff-gate execution.

## 2026-06-28 Diff-Gate Echo Follow-Up

The `diffGate()` citation remains accurate: default diff-gate execution still
runs echo, incomplete migration, co-change partner, doc-reference,
unused-params, and new-dead checks through `src/queries/impact/diff-gate.ts`.
The performance follow-up only skips non-callable changed symbols before echo
similarity scoring; baseline ratchet behavior and check configuration remain
unchanged.

## 2026-06-28 Health Drift Performance Follow-Up

The `src/queries/health/health.ts` reference remains accurate after the health
drift optimization. Health and the baseline ratchet now ask `drift()` to skip
advisory `pattern-deviation` rows they already exclude from visible output and
stable finding identities; the repo-wide health score contract is unchanged.

## 2026-06-28 Diff-Gate Co-Change Follow-Up

The `diffGate()` citation remains accurate. Default diff-gate still runs the
same check family; the co-change partner check now uses the raw git changed
paths when deciding whether a historical partner is already present in the
diff.

## 2026-06-28 Focused Co-Change History Follow-Up

The `diffGate()` citation remains accurate after the focused co-change history
optimization. Default diff-gate still runs the same check family; the
co-change partner check now reads only changed-file commits from the same
bounded git-history window instead of parsing the whole name-only history
payload.

## 2026-06-30 Git Evidence Product Follow-Up

The `diffGate()` and health citations remain accurate after the Git evidence
product migration. Default diff-gate still runs the same check family, and
health still reports the same Git evidence summary; both paths now read Git
history through `gitEvidenceProduct()`.

2026-07-01 round-2 remediation note: the `src/queries/health/health.ts`
configuration example remains current after the health command added
validation-basis disclosure and parser-unavailable reporting. The validation
ledger's health examples still cite the command surface that computes and
renders those analyzer signals.

## 2026-07-01 Remediation Plan 3 Follow-Up

The `diffGate()` and health citations remain accurate after remediation plan 3
(detection primitives). Default diff-gate now also runs `twin-partner`
(advisory) and `coverage-contract`; `src/runtime/commands/query-command-specs.ts`
still owns the public query order. Health gained a `coverage-contracts` phase
and a `detectorPrecision` field (per-check finding-outcome stats from the new
finding-outcome ledger) — both paths still compute and render through the same
command surfaces cited above.

## 2026-07-08 Rust Semantic Parity Follow-Up

The `src/queries/health/health.ts` citation remains accurate after the Rust
semantic parity slice. Health still owns the composite phase inventory and
score assembly; the health budget now also carries whether a run should enrich
detectors with semantic facts. Full/default health keeps semantic enrichment
enabled, while bounded large-index health records the explicit semantic-off
budget choice.

## 2026-07-02 Doc-Reference Hub-Cascade Follow-Up

The `diffGate()` and `DIFF_GATE_CHECKS` citations were refreshed (line anchors
`diff-gate.ts:205` -> `:228` and `:62` -> `:64`) after followup #8 added
hub-file cascade damping to the doc-reference check: when more than 3 docs
cite the same changed hub file in one gate run, their findings collapse into
one clustered finding carrying `citationCount`, up to 3 `citationExemplars`,
and an explicit `suppressedCount`. Default diff-gate still runs the same
check family through the same entry point; per-doc findings under the
threshold are unchanged.

## 2026-07-10 TypeScript Dead-Code Certification Follow-Up

The direct-repair `dead` row now has a detector-language certificate rather
than relying on the earlier mixed-family calibration. The pinned four-repo
baseline produced 25 valid and 53 invalid TypeScript findings. Shared fixes
made test references count as repository usage, propagated declared package
surfaces through re-exports, recognized framework entry files, and excluded
interface, constructor, React lifecycle, and implemented-protocol contracts.

The final fixed-seed review contained 43 valid findings and zero invalid
findings across Vega_2.0, openwork, Stable_Management, and traceroot. Observed
precision was 100%, the 95% Wilson lower bound was 91.8%, and three positive
fixtures continued to detect ordinary unreferenced definitions. The retained
claim is narrowly scoped: TypeScript `dead-code` rows are certified
repository-dead candidates, while `file-internal`, other detector families,
Rust, Python, and the aggregate health score retain independent status. The
full evidence is in
`docs/validation/2026-07-10-typescript-dead-certification.md`.

## 2026-07-23 Architecture Coherence Follow-Up

`src/runtime/commands/query-command-specs.ts` remains the canonical public
query order after adding `architecture` to the graph family. (The file moved to
`src/runtime/query-commands/` in the 2026-07-24 boundary-resolution pass; the
public query order itself is unchanged.) The enforcement
follow-up replaced drift's repository-specific policy with project-owned
configuration and added stable boundary-pair identities to the shared health
baseline. The default diff gate now blocks only new configured forbidden edges
or explicitly forbidden cycles; accepted existing identities remain ratcheted.
Reciprocal pairs, unmapped files, undeclared edges, and undeclared cycles remain
contextual signals until external calibration.

## 2026-07-24 Boundary Resolution and Coarse-Boundary Detection

`architecture` gained a second enforceable rule, `requireResolvedBoundaries`,
and a corresponding finding class `architecture:coarse-boundary:<boundary>`
carried through the same health-baseline ratchet as forbidden edges and cycles.

The rule exists because `requireAcyclic` had a structural blind spot rather than
a precision problem. `analyzeArchitectureGraph` discards every dependency whose
endpoints share a boundary before running SCC, so a boundary coarse enough to
contain both sides of a cycle passes while asserting nothing about the code it
holds. This repository was the demonstrating case: 14 declared boundaries with
`requireAcyclic: true` reported zero cycles while six of them — holding 295 of
348 files — each contained an internal cycle.

**Validation.** The detector was run against the pre-change tree in an isolated
worktree, using the original 14-boundary configuration. `requireAcyclic`
reported 0 cycles; `detectCoarseBoundaries` reported exactly the 6 boundaries
identified by manual analysis (`queries`, `runtime`, `semantic`, `source`,
`reindex`, `symbols`), and its `narrowestEdges` named the precise imports the
repair pass then removed. On the repaired tree it reports 0. Both directions are
covered, so the result is not an artifact of a permanently-firing check.

**Precision decision.** Module-hierarchy suppression is content-aware, not
path-based. `classifyFile` decides "barrel" from the filename, which labels
every `index.ts` bookkeeping — including `src/language-parsers/index.ts`, a
130-line cache module that was the *target* of the narrowest real back edge in
the repository. A path-based rule therefore produced a false negative on the
single most important finding. A barrel is now excluded only when the index
records no definitions of its own inside it.

Directory nesting alone is deliberately not a suppression signal. An earlier
draft suppressed any component whose sub-units shared an ancestor directory,
which silently hid the `queries` and `semantic` findings — a boundary's root
files depending on one of its own sub-directories is the most common real
intra-boundary cycle, not module bookkeeping.

**Known limits, not yet calibrated.** Sub-units are one directory level, so a
layer inversion *inside* a single directory is invisible; the `src/source`
primitives/facts/products tangle had to be derived by hand and was fixed by
splitting the directory. Test files are not SCIP-indexed and are therefore
outside boundary enforcement entirely. `requireCompletePolicy` checks that a
dependency row exists, not that it is minimal, so an allowance can outlive the
edge that justified it.

## 2026-07-24 Boundary Enforcement Gap Closure

Five rules were added to `architecture` after auditing what boundary
enforcement still could not see. Each is opt-in and defaults to off, so
upgrading tightens no existing project's gate.

| Rule | Closes | Finding identity |
| --- | --- | --- |
| `requireMinimalPolicy` | A declared allowance outliving the edge that justified it. `requireCompletePolicy` checks a row *exists*, never that it is *minimal*, so policy widens silently. | `architecture:stale-allowance:<from>:<to>` |
| `maxBoundaryFanOut` / `maxBoundaryFiles` | A boundary growing until it is coupled to most of the system. Coarseness was previously caught only when it *hid a cycle*, never when it merely got large. | `architecture:boundary-limit:<kind>:<boundary>` |
| `testPaths` | Test files are excluded from the compiler project and therefore from the index, leaving them outside every boundary rule. | `architecture:test-boundary:<test>:<boundary>` |
| `subUnits: 'file'` | A layer inversion *inside* one directory, invisible when sub-units are directories. | (reuses `coarse-boundary`) |
| `fragileEdges` (report-only) | No signal distinguishing a load-bearing dependency from one resting on a single import. 60 of 251 edges here are single-import. | none — advisory |

**Test-boundary calibration.** The first rule shape — "a test may import only what
its subject's boundary may import" — produced 91 findings, nearly all
legitimate: a test for `analysis/git-history` drives it *through*
`queries/cleanup/co-change`, which is composition, not coupling. The shipped
rule allows the subject's **transitive** reach plus any boundary that reaches
the subject (a consumer is the natural driver). That yields 0 findings here,
and a planted violation (`source-vue` test importing `reindex-vue`, which is
unrelated in both directions) is caught. Subject resolution requires the
mirrored path to be a **real file**: boundary globs match paths that do not
exist, so trusting them attributed cross-cutting tests to whichever directory
they sat in and produced 4 false positives.

**One audited gap was not real.** "Dynamic `import()` counts as a static edge"
was measured with `scip-query deps`, which builds its graph with
`scipEdges: 'all-references'`. `architecture` builds with
`scipEdges: 'imports-only'`, which never includes dynamic import edges — zero
boundary edges in this repository are backed by the file whose only
`query-commands` reference is an `await import()`. The dynamic-import detector
written against that premise was removed rather than shipped, since it guarded
a case the code path cannot produce and cost a source scan per file. Recorded
here because the two graph configurations are easy to conflate when reasoning
about architecture from `deps` output.

## 2026-07-24 Review Remediation (boundary resolution)

Seven review findings against the boundary work were resolved. Recorded because
three changed a decision rather than a line.

**The `source` / `language-parsers` split was reverted.** The target
architecture forbids re-splitting them "merely to force a layer direction," and
that is exactly what the split did once the underlying cycle was repaired. The
merged `source` boundary is now internally acyclic and is verified as such by
`requireResolvedBoundaries`, so the enforcement goal is met without
contradicting the normative decision. This is the better outcome: the rule and
the enforcement now agree instead of competing. `docs/architecture/scip-query-target-architecture.md`
records the 14-boundary configuration as superseded, with current counts.

**`subUnits` was unvalidated — the highest-risk defect.** Detection treats every
value other than `'file'` as directory granularity, so `subUnits: "files"`
passed validation and silently disabled the same-directory enforcement the
option exists to turn on. A config option whose typo mode is "quietly do
nothing" is worse than no option. Now validated as a closed set, with a
regression test, alongside tests for the growth limits and `testPaths`.

**The coarse-boundary identity encoded its members.** The identity is the
persistent baseline comparison key, so including the current SCC membership
meant adding one file to a tangle read as the old finding being fixed plus a
new one appearing — ratchet churn on a problem that never went away. Now keyed
by boundary alone.

**Plan step B1.6 was completed rather than abandoned.** The plan called for
moving the baseline checks into `queries/internal`; the literal move is
impossible, because `checkHealthBaseline` runs every health detector and would
create `internal -> cleanup` against the existing `cleanup -> internal`. The
shared parts — file format, path resolution, identity normalization, and the
new-versus-fixed comparison — moved to `queries/internal/baseline-file.ts`, and
`checkArchitectureBaseline` moved to `queries/graph/architecture-baseline.ts`
beside the report it reads. `checkHealthBaseline` stays in health because
collecting findings is intrinsically a detector-layer concern. The relocation
immediately produced the `requireMinimalPolicy` rule's first real finding: a
`queries-health -> symbols-core` allowance left stale by the moved import.

**Two smaller corrections.** `detectCoarseBoundaries` defaulted its classifier
to `() => false`, so a direct caller reported barrel and entry bookkeeping; it
now defaults to the path-based `classifyFile` test, with `architecture(db)`
still overriding it with the content-aware version. And the report described a
single-import edge as "incidental rather than load-bearing" — the graph
establishes edge breadth, not importance, so it now reports the measurement and
says explicitly that breadth alone settles nothing.
