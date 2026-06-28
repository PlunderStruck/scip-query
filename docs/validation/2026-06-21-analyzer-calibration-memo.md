# Analyzer Calibration Memo

Date: 2026-06-21

Raw output root:

```text
/tmp/scip-query-validation/2026-06-21-pilot
```

This memo is the next validation step after `docs/validation/2026-06-21-analyzer-verdict-review.md`. It turns first-pass verdicts into score, gate, and output-schema judgments.

Do not treat this memo as approval to change every threshold immediately. A calibration decision is a recorded judgment about how analyzer evidence should affect score, gate severity, wording, or output shape. Its job is to connect reviewed findings to future code changes without fitting the tool to one repository.

An action tier is the maintainer meaning of an analyzer result. A direct tier points to a local repair the maintainer can usually do now; a signal tier points to real pressure that needs product or architecture judgment; a support tier provides evidence that helps another decision but should not reduce score by itself.

## Evidence Base

Reviewed evidence:

- `docs/validation/2026-06-21-analyzer-verdict-review.md`
- `docs/validation/2026-06-21-analyzer-validation-pilot.md`
- `docs/validation/2026-06-21-frontend-behavior-evidence-classification-result.md`
- `docs/validation/2026-06-21-extract-candidate-evidence-classification-result.md`
- `docs/validation/2026-06-21-stale-abstraction-action-tier-result.md`
- `docs/validation/2026-06-21-graph-risk-family-result.md`
- `docs/validation/2026-06-21-config-declared-coupling-freshness-result.md`
- `docs/validation/2026-06-21-suppression-lifecycle-result.md`
- `docs/validation/2026-06-21-support-analysis-accuracy-result.md`
- `docs/validation/2026-06-21-cross-language-capability-boundaries-result.md`
- `docs/validation/2026-06-21-public-command-surface-coverage-result.md`
- `docs/validation/2026-06-21-analyzer-implementation-parity-result.md`
- `docs/validation/2026-06-21-performance-budget-behavior-result.md`
- `docs/validation/2026-06-21-agent-repair-outcomes-result.md`
- `docs/validation/2026-06-21-locality-analyzer-validation-result.md`
- `docs/validation/2026-06-21-direct-small-analyzer-verdicts-result.md`
- `docs/validation/2026-06-21-direct-remaining-verdicts-result.md`
- `docs/validation/2026-06-21-direct-deletion-family-closure-result.md`
- Stable_Management raw outputs under `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management`
- scip-query raw outputs under `/tmp/scip-query-validation/2026-06-21-pilot/scip-query`

Implementation anchors:

| Surface                   | Source command                                            | Result used                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health entrypoint         | `scip-query plan-context health --full --json`            | `health()` is at `src/queries/health/health.ts:194` and returns `buildHealthReport()` output.                                                                                   |
| Health report shape       | `scip-query code buildHealthReport --json`                | `buildHealthReport()` is at `src/queries/health/health-report.ts:119`.                                                                                                          |
| Score formula             | `scip-query code computeHealthScore --json`               | `computeHealthScore()` is at `src/queries/health/health-report.ts:552`.                                                                                                         |
| Diff gate entrypoint      | `scip-query plan-context diffGate --full --json`          | `diffGate()` is at `src/queries/impact/diff-gate.ts:158`.                                                                                                                       |
| Echo check                | `scip-query code runEchoCheck --json`                     | `runEchoCheck()` is at `src/queries/impact/diff-gate.ts:319`.                                                                                                                   |
| Incomplete migration gate | `scip-query code runIncompleteMigrationCheck --json`      | `runIncompleteMigrationCheck()` is at `src/queries/impact/diff-gate.ts:452`.                                                                                                    |
| Doc reference gate        | `scip-query code runDocReferenceCheck --json`             | `runDocReferenceCheck()` is at `src/queries/impact/diff-gate.ts:642` and now skips docs changed anywhere in the same git diff, including Markdown files outside the SCIP index. |
| New dead gate             | `scip-query code runNewDeadCheck --json`                  | `runNewDeadCheck()` is at `src/queries/impact/diff-gate.ts:876`.                                                                                                                |
| Baseline gate             | `scip-query code runBaselineCheck --json`                 | `runBaselineCheck()` is at `src/queries/impact/diff-gate.ts:947`.                                                                                                               |
| Wrapper detector          | `scip-query code wrapperCandidates --json`                | `wrapperCandidates()` is at `src/queries/cleanup/wrapper-candidates.ts:46`; `consumerMapForWrapperCandidates()` is at `src/queries/cleanup/wrapper-candidates.ts:69`.           |
| Similar detector          | `scip-query code similarAll --json`                       | `similarAll()` is at `src/queries/cleanup/similar.ts:192` and now reuses cached weighted magnitudes from the callee fingerprint index during pair scoring.                      |
| Co-change detector        | `scip-query code coChange --json`                         | `coChange()` is at `src/queries/impact/co-change.ts:47`.                                                                                                                        |
| Vue pressure detector     | `scip-query code vueLargeViewPressure --json`             | `vueLargeViewPressure()` is at `src/queries/frontend/vue-large-view-pressure.ts:20`.                                                                                            |
| Dead output builder       | `scip-query code deadSummary --json`                      | `deadSummary()` is at `src/queries/cleanup/dead.ts:189`.                                                                                                                        |
| Stale health summary      | `scip-query code summarizeHealthStaleAbstractions --json` | `summarizeHealthStaleAbstractions()` counts `unused` and `singleUse`, but score still uses total stale count.                                                                   |
| Score formula follow-up   | `scip-query code computeHealthScore --json`               | `computeHealthScore()` still scores `extract` and `stale-abstractions` from raw counts.                                                                                         |

2026-06-22 note: `health()` still anchors the composite health report in `src/queries/health/health.ts`; the later default-policy change makes full mode the default for `health`, so the historical `plan-context health --full` evidence remains valid but is no longer required for the visible health command.

Stable_Management score baseline:

| Metric                | Value |
| --------------------- | ----: |
| Score                 |    95 |
| Risk score            |    95 |
| Hygiene score         |    96 |
| Similar pairs         |   109 |
| Wrapper candidates    |    48 |
| Hidden-coupling pairs |    22 |

Stable_Management score deductions:

| Axis              | Points | Judgment from verdict review                                                               |
| ----------------- | -----: | ------------------------------------------------------------------------------------------ |
| `similar`         |      1 | Directionally useful, but should stay contextual unless domain-specific behavior is shown. |
| `wrappers`        |      3 | Too strong for current evidence; top 10 reviewed rows were accepted design.                |
| `hidden-coupling` |      5 | Strongest contextual signal; 7 of 10 reviewed co-change rows were true positives.          |

## Follow-Up Calibration Updates

The first memo produced implementation work. The completed slices now give enough structured evidence to refine the score model without guessing from raw candidate counts.

### Frontend Behavior Candidates

Judgment: React/Vue behavior candidates should score by action tier or score count, not by raw emitted rows.

Evidence:

- Vega `react-hook-candidates --full --json` returned 87 rows: 45 `signal`, 42 `support`.
- The `support` rows were generic workflow scaffolding or existing shared abstractions; they are useful review context but should not reduce health like domain behavior duplication.
- Stable_Management `vue-composable-candidates --full --json` returned 0 rows, so Vue behavior score changes need a corpus with non-empty composable findings before changing defaults.

Score implication:

- Keep existing discounted React/Vue behavior scoring until a second non-empty corpus validates the tier split.
- Future scoring should use signal rows, not total rows, and should keep support rows out of deductions.

### Extraction Candidates

Judgment: extraction candidates should remain low-weight contextual pressure.

Evidence:

- Vega `extract-candidates --full --json` returned 213 rows: all `signal`.
- The new extraction kinds were `workflow-orchestration` 174, `broad-helper-cluster` 14, and `cohesive-helper-cluster` 25.
- `computeHealthScore()` still deducts `extract` from raw `analyses.extractCount`.

Score implication:

- Do not make extraction candidates direct hygiene debt.
- Keep only backlog-pressure weight until a locality analyzer or repair-outcome review can show that specific extraction kinds reliably produce better code.
- Prefer pressure detail by `extractionKind` over a single raw candidate count in future health output.

### Stale Abstractions

Judgment: stale abstractions should score direct unused rows separately from one-consumer ownership signals.

Evidence:

- Vega `stale-abstractions --full --json` returned 108 rows: 1 `direct`, 107 `signal`.
- Stable_Management `stale-abstractions --full --json` returned 63 rows: 3 `direct`, 60 `signal`.
- `summarizeHealthStaleAbstractions()` already computes `unused` and `singleUse`.
- `computeHealthScore()` still deducts `stale-abstractions` from total stale count.

Score implication:

- Use `unused` as direct hygiene debt.
- Use `singleUse` as contextual signal pressure with lower weight.
- Preserve high-confidence one-consumer rows as signal because their repair may be move, inline, keep, or document as public contract.

### Graph-Risk Families

Judgment: bottlenecks, coupling, and deep chains should stay contextual signal evidence; drift should score only direct cleanup or explicit policy rows.

Evidence:

- scip-query `bottlenecks`, `coupling`, and `deep-chains` top rows all emitted `signal` action tiers after the output-schema pass.
- Stable_Management `drift --json` returned 251 rows, all `pattern-deviation` signal rows.
- Vega_2.0 `drift --json` returned 894 rows, all `pattern-deviation` signal rows.
- Stable_Management and Vega health reports both kept `driftedFiles` at 0 and emitted no drift score breakdown after the tier split.
- scip-query `deep-chains --limit 10` no longer returned the previous 37/36/35 strict-suffix ladder.

Score implication:

- Keep bottlenecks, coupling, and deep chains out of direct health score unless combined with stronger evidence such as churn, cycles, or explicit policy.
- Score drift base deductions from direct rows only.
- Keep inferred drift and pattern deviations visible as architecture-review signal, not direct repair debt.

## Score Calibration Judgments

### Wrappers

Judgment: wrapper findings should not currently receive direct hygiene deductions merely because a function has one indexed caller.

Evidence:

- Stable_Management had 48 wrapper candidates and lost 3 hygiene points.
- The top 10 wrapper rows reviewed were all `accepted_design`.
- `wrapperCandidates()` reports small symbols with one caller and orders results by caller fan-in and LOC.
- `consumerMapForWrapperCandidates()` keeps the same evidence domain while skipping source fallback for symbols that indexed/semantic caller evidence already rules out.
- Reviewed rows included DB context boundaries, Express middleware, audit side-effect boundaries, route registry helpers, validation middleware, and a type guard.

Next action:

- Move wrappers from direct score deduction to signal pressure unless the detector can emit boundary-role counterevidence.
- Add evidence fields that distinguish one-caller shape from avoidable indirection: boundary role, framework middleware, type guard, registry mutation, side-effect boundary, public API, and source comment.
- Do not gate wrappers as direct repair until a second corpus shows top-ranked wrapper rows with actual cleanup wins.

### Similarity

Judgment: similarity should remain a low-weight hygiene signal, but remediation must stop implying direct reuse for every high-similarity pair.

Evidence:

- Stable_Management had 109 similar pairs and lost 1 hygiene point.
- In the 10 reviewed similarity rows, 3 were `tp`, 1 was `fp`, and 6 were `needs_judgment`.
- `similarAll()` compares callee fingerprints, filters ubiquitous callees, and applies a parameter-count guard, but it does not yet separate framework scaffolding from domain-specific behavior.
- The false-positive examples shared access, query, or random-token primitives while representing different domain operations.

2026-06-28 follow-up: the current `similarAll()` implementation keeps the same
contextual similarity contract, but `buildCalleeFingerprintIndex()` now computes
per-fingerprint weighted magnitudes once so pair scoring does not recompute the
same vector lengths for every candidate pair. The calibration judgment remains
about evidence weight, not runtime.

2026-06-28 focus-pruning follow-up: `similarAll()` now has an internal
focus-file option used by `recent-duplicates --full` to avoid comparing pairs
where neither file is recent. The calibration examples above remain about the
standalone similarity evidence contract; that public command still runs without
focus pruning.

Next action:

- Keep a small score effect for similarity backlog pressure.
- Split evidence into framework scaffolding, access/query scaffolding, and domain-specific behavior.
- Only use direct reuse language when the shared evidence includes exact tiny helpers, create/update pairs with shared validation, upload/set pairs with shared cleanup, or other domain-specific side-effect sequences.
- Group repeated pairwise rows into one root cause before scoring or gating.

### Hidden Coupling

Judgment: hidden coupling can keep risk-score weight, but the output should distinguish high-confidence coupling classes, broad-sweep history, and stale history.

Evidence:

- Stable_Management had 22 hidden-coupling pairs and lost 5 risk points.
- In the 10 reviewed co-change rows, 7 were `tp` and 3 were `needs_judgment`.
- `coChange()` already filters tests, same-stem siblings, noise files, deleted files, and structurally linked pairs.
- True positives were strongest for doc/code, schema/script, and model/view relationships.

Next action:

- Keep `hidden-coupling` as risk pressure.
- Promote doc/code, schema/script, and model/view pairs as high-confidence support findings when the history is not stale or broad-sweep dominated.
- Declared-coupling suggestions, partner classes, broad-sweep context, and recency context are now emitted.
- Keep hidden-coupling deductions score-weighted by commit scope and recency. Local commit-subject context is now available; true issue/PR labels still require an external metadata provider.

### Vue Large-View Pressure

Judgment: Vue large-view pressure is valid as locality signal, but score integration needs pressure-kind separation.

Evidence:

- Default Stable_Management `vue-large-view-pressure --full --json` returned 0.
- `vue-large-view-pressure --full --min-total-lines 300 --json` returned 59 rows.
- The top 8 threshold-probe rows produced 7 `tp` and 1 `accepted_design`.
- `vueLargeViewPressure()` defaults to `minTotalLines = 800`, `minTemplateLines = 300`, `minScriptLines = 300`, and `minStyleLines = 500`.
- Reviewed rows included style-heavy files, script-heavy files, external-script files, and a landing page.

Next action:

- Keep the default score threshold conservative until second-repo confirmation.
- Add a review-mode threshold or preset that can surface the useful 300-line pressure rows without changing score behavior.
- Split output recommendations by dominant pressure: template, script, style, external script, and route/page.
- Route style-heavy files to UI/style decomposition review, not composable extraction.

### Dead Output Contract

Judgment: `dead --only-dead --json` needs output-schema cleanup before downstream consumers use it for automated verdict counts.

Evidence:

- In scip-query, `deadCodeCount` was 0 and `shown.deadCode` was empty, but `symbols.length` was 665.
- In Stable_Management, `deadCodeCount` was 0 and `shown.deadCode` was empty, but `symbols.length` was 1211.
- `deadSummary()` always returns `symbols`, `totalCount`, `deadCodeCount`, `fileInternalCount`, and `totalLoc`.
- In `--only-dead` mode, consumers can mistake file-internal inventory for dead-code findings.

Next action:

- Add a top-level `counts` object with explicit `dead`, `fileInternal`, `shownDead`, and `shownFileInternal` fields.
- Rename or split `symbols` so `dead --only-dead` does not look like a list of dead-code findings when it is mostly file-internal inventory.
- Treat this as the lowest-risk first implementation because it is output clarity, not detector logic.

## Diff-Gate Calibration Judgments

| Check                  | First-pass judgment                               | Required change before stronger gating                                                                                                                                                          |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo`                 | Useful but over-direct                            | Group exact duplicates; soften remediation unless domain-specific reuse evidence exists.                                                                                                        |
| `incomplete-migration` | Useful after containment refinement               | Two-sided helper/site containment, site coverage, helper-shape evidence, and migration-scope hints now guard broad old sites and distinguish possible subtype/variant leftovers.                |
| `co-change-partner`    | Good support signal                               | Partner-class labels, declared-coupling suggestions, commit scope, recency context, and commit-subject context now separate focused current pairs from broad, stale, or weakly labeled history. |
| `doc-reference`        | Useful review prompt, not blanket blocker         | Citation-kind, Markdown-local cited-claim evidence, and action tiers now split behavioral claims from configuration examples.                                                                   |
| `new-dead`             | Good for runtime symbols, weak for type contracts | Filter type-only compile-time assertions and contract aliases.                                                                                                                                  |
| `baseline`             | Useful ratchet but too opaque                     | Inherit underlying analyzer family, action tier, and grouped root-cause metadata.                                                                                                               |

Gate severity judgment:

- Keep current warning severity for `echo`, `incomplete-migration`, `co-change-partner`, `doc-reference`, `unused-params`, and `new-dead`.
- Keep `baseline` as error only when the underlying finding metadata is clear enough to tell whether it is direct debt or contextual pressure.
- Do not make wrapper, similarity, or Vue pressure rows block diffs directly without action-tier metadata.

## Implementation Priority

1. **Completed: Dead output schema** clarified counts and `symbols` semantics.
2. **Completed: New-dead type-contract filter** avoids warning on `_Assert*` compile-time contract aliases.
3. **Completed: Echo grouping and remediation wording** groups repeated tiny helper hits and softens shared-scaffolding remediation.
4. **Completed: Wrapper boundary evidence** adds boundary-role fields and discounts accepted boundary helpers.
5. **Completed: Similarity evidence split** classifies shared evidence so domain behavior differs from framework/access scaffolding.
6. **Completed: Vue and React pressure-kind output** exposes pressure kinds and review recommendations.
7. **Completed: Doc citation-kind output** distinguishes configuration examples from stronger doc-update signals.
8. **Completed: Baseline metadata inheritance** makes baseline findings carry underlying analyzer identity and action tier.
9. **Completed: Frontend behavior evidence class** separates React/Vue generic workflow support from domain behavior signals.
10. **Completed: Extraction candidate classification** keeps extraction rows as signal and reports extraction kind/recommendation.
11. **Completed: Stale abstraction action tier** separates unused direct cleanup from one-consumer signal rows.
12. **Completed: Score-count implementation** updates health scoring to use direct unused stale counts and keeps extraction as signal pressure.
13. **Completed: Graph-risk families** reviewed bottlenecks, coupling, deep chains, and drift with the same direct/signal/support split.
14. **Completed: Config and declared-coupling freshness** repairs stale `.scipquery.json` paths and validates future declared-coupling file existence.
15. **Completed: Suppression lifecycle review** inventories source ignore comments, validates structured suppression file freshness, and keeps suppression counts as detector-trust feedback.
16. **Completed: Support analysis accuracy** compares navigation, planning, graph metric, status, and self-audit support output against source facts for a TypeScript target.
17. **Completed: Cross-language capability boundaries** runs smoke validation on `SynthRunnerRust`, confirms Rust graph/source/checker support, marks TypeScript semantic self-audit unavailable, keeps React/Vue empty outputs stack-specific, and adds neutral `structural-overlap` similarity evidence.
18. **Completed: Public command surface coverage** compares public command registration against the inventory, protocol, and ledger so no analyzer is omitted from validation.
19. **Completed: Analyzer implementation parity** walks descriptors, handlers, query entrypoints, and health summaries, and fixes the missing public `unused-imports` query subpath.
20. **Completed: Performance and budget behavior** validates large-index defaults, `--full`, scan limits, and graceful degradation across the corpus.
21. **Completed: Agent repair outcomes** verifies one checker-backed direct deletion repair and records signal/support non-repair outcomes.
22. **Completed: Locality analyzer validation** recommends a signal-only report or skill-first implementation with explicit consumer-coverage caveats.
23. **Completed: Direct small analyzer verdicts** validates `unused-imports`, records clean-corpus `unused-params`, and fixes `redundant-reexports` executable-entrypoint false positives.
24. **Completed: Remaining direct repair verdicts** keeps real cycles and broken doc references direct, and required passthrough boundary evidence before treating passthrough rows as direct cleanup.
25. **Completed: Deletion-family verdict closure** closes AVL-002 with direct analyzer verdicts, accepted-design cases, and residual precision actions.
26. **Completed: Contextual signal verdict closure** closes AVL-003 by summarizing already-reviewed contextual families and remaining score/output actions.
27. **Completed: Score calibration finalization** closes AVL-006 by turning the action-tier verdicts into final scoring rules.
28. **Completed: Output/schema quality finalization** closes AVL-007 by consolidating output contracts and missing-field lists.
29. **Completed: Passthrough boundary evidence** adds passthrough action tier, boundary evidence, recommendation text, and signal-row score discount.
30. **Completed: Public surface caveats** adds redundant-reexport action tier, package-surface evidence, nested package manifest support, and dead-code package-export regression coverage.
31. **Completed: Doc cited-claim metadata** adds cited claims to `doc-reference`, citation contexts to path-reference `doc-drift` subjects, and compact cited-claim text output.
32. **Completed: Root-cause grouping** adds `rootCauseGroups` to `recent-duplicates` and diff-gate output so repeated pairwise/baseline rows do not overstate independent debt.
33. **Completed: Co-change partner labels** adds partner-class metadata and declared-coupling suggestions for repeated high-confidence co-change pairs.
34. **Completed: Incomplete migration containment** adds two-sided containment, site coverage, helper-shape metadata, and a broad-site regression fixture.
35. **Completed: Co-change recency and broad-sweep context** adds pair history context to `co-change`, diff-gate, CLI text, and health summaries.
36. **Completed: Doc-drift historical intent** adds action tier and doc intent to co-change-only doc-drift subjects so historical notes stay support-tier.
37. **Completed: Framework entry caveats** treats framework-discovered route/page exports as rooted symbols while keeping ordinary same-file helpers reviewable by direct cleanup analyzers.
38. **Completed: Incomplete migration scope hints** adds same-scope, possible-subtype, and unknown labels to leftover sites while keeping possible subtype rows visible for review.
39. **Completed: Doc-reference citation parser** extracts Markdown-local cited claims so nearby unrelated config/guide prose no longer changes the citation kind.
40. **Completed: Passthrough public-facade caveats** keeps package-public exported passthroughs visible as signal rows with public-API recommendations while private passthrough helpers remain direct when no boundary evidence exists.
41. **Completed: Co-change subject context** adds local commit-subject labels, issue refs, sampled subjects, and explicit external-label-unavailable status to co-change, diff-gate, health, plan-context, and CLI output.
42. **Completed: Second-corpus score-weight confirmation** validates clean Vega score output and adds hidden-coupling score weighting so broad-sweep/stale history is discounted before health scoring.
43. **Completed: Passthrough exported-facade second-corpus confirmation** keeps clean Vega passthrough signal/direct counts stable and splits `publicFacadeEvidence` from runtime-boundary evidence in JSON and text output.
44. **Completed: Incomplete-migration second-corpus scope confirmation** validates the same-scope hint on a cross-file Vega assistant-tool probe and confirms same-file leftovers are intentionally skipped as active edit-set files.
45. **Completed: Doc parser second-corpus validation** confirms Markdown-local citation extraction across Vega list, table, single-line, paragraph, and fenced-code contexts, including diff-gate doc-reference findings.

## Second-Repo Confirmation Plan

Before changing score weights permanently:

1. Run the same reviewed samples against `Vega_2.0` for React/component/action-tier confirmation.
2. Run `SynthRunnerRust` as a capability-boundary smoke test so TypeScript-specific precision changes do not imply unsupported Rust behavior.
3. Confirm wrapper top results on at least one more repo; if accepted-design dominates again, remove direct wrapper deduction from health.
4. Confirm Vue pressure findings on Stable_Management with the pressure-kind output before adding any score threshold change.

## Ledger Judgments

- AVL-006 is complete: final score calibration is recorded with accepted weights, conservative decisions, and blocked evidence gaps.
- AVL-007 is complete: output/schema quality is recorded with implemented contracts and missing-field lists for every analyzer family.
- AVL-002 is complete: direct repair analyzers now have reviewed verdict coverage, with passthrough split into direct rows and boundary-shaped signal rows.
- AVL-003 is complete: contextual verdicts now have one closure memo tying the family decisions together.
- AVL-012 is complete: locality is approved only as signal output, with no automatic moves or health scoring until consumer coverage and repair outcomes improve.

## Decision Summary

Approved for next implementation plan:

- Continue the remaining output/schema follow-ups, with passthrough boundary evidence, package/export caveats, passthrough public-facade caveats, passthrough exported-facade second-corpus confirmation, doc cited-claim metadata, root-cause grouping, co-change partner labels, incomplete-migration containment, incomplete-migration second-corpus scope confirmation, co-change recency context, co-change subject context, second-corpus score-weight confirmation, doc-drift historical intent, framework-discovered entrypoint caveats, incomplete-migration scope hints, doc-reference citation parser improvement, and doc parser second-corpus validation now closed. The next candidate is locality report-only validation when exact consumer coverage or repair outcomes improve.

Not approved yet:

- Lowering Vue health-score thresholds globally.
- Treating wrapper or extraction candidates as direct hygiene debt.
- Treating all high-similarity pairs as direct reuse opportunities.
- Making support-tier doc-reference findings hard blockers when cited-claim evidence shows a configuration example or intentional record rather than a current behavioral claim.
- Scoring one-consumer stale abstractions like unused direct cleanup.

The implementation plan for the first three approved items is `docs/plans/2026-06-21-analyzer-precision-implementation.md`.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the diff-gate source references in this memo. `diffGate()` still owns the same check lifecycle; the new `recordFinding()` helper only centralizes suppression-hint construction for those checks and does not change the analyzer-calibration conclusions here.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked the diff-gate source references after doc-reference and baseline policy helpers moved into private query modules. The memo remains accurate as a calibration record: `diffGate()` still owns the check lifecycle, and the moved helpers do not change the direct/signal/support conclusions recorded here.

## 2026-06-27 Citation Refresh

The persistent-refresh coordination slice rechecked the `diffGate()` citation. The diff-gate entrypoint still owns the same check lifecycle and still delegates to the same check-family helpers before root-cause grouping. The current reindex/watch/config changes do not alter the analyzer-calibration conclusions in this memo.

## 2026-06-28 Diff-Gate Echo Follow-Up

The calibration references to `similar.ts` and `diff-gate.ts` remain accurate.
This follow-up only adds a non-function early return to `similar()` callee
lookup and a callable-symbol prefilter before diff-gate echo calls similarity;
the listed diff-gate checks and analyzer calibration surfaces are unchanged.

## 2026-06-28 Source-Fallback Scan-Limit Follow-Up

The `similar.ts` calibration reference remains accurate after the bounded
source-fallback change. The new behavior only makes targeted similarity pass
its existing scan-limit budget into lexical source-shape fallback for bounded
callers; analyzer categories, score calibration, and unbounded `similar --full`
behavior are unchanged.
