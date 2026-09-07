# Health report presentation repairs

The user authorized fixing three observed problems in the default and indexed health reports. Work on main. Preserve both existing untracked benchmark reports. This plan records scope and completion across context resets.

## Problems and required behavior

1. **Unmatched suppression records precede findings.** The repository's normal health report printed 83 unmatched records before the first finding. Summarize those records in ordinary output, retain an explicit detail path, and preserve visibility of decisions that affect current findings. An unmatched record is not automatically obsolete and must not be deleted by this repair.
2. **The five-group shortlist hides major concerns.** Three default groups were tooling groups, while runtime services and reindexing were absent. Expose independently bounded complexity findings and duplication candidates with exact locations and disclosed ordering. Preserve complete results and useful module drilldowns; avoid inventing an overall design score.
3. **Indexed health retains removed score language.** Remove obsolete composite-score metadata and warnings and express remaining counts in their actual units. Preserve evidence, capability limitations, and per-candidate measurements that still serve a concrete purpose.

## Work and validation

- [x] Trace rendering, shortlist selection, indexed score disclosure and existing test contracts.
- [x] Add focused regression cases proving findings appear before unmatched administrative details, both finding categories remain visible, and score-free indexed output retains coverage disclosures.
- [x] Implement the three repairs and update affected guidance/contracts.
- [x] Run focused tests, required static checks, and the applicable API checks.
- [x] Exercise default and indexed health on this repository; inspect diff review and impact with their stated coverage.
- [x] Record results and assemble the authorized change for delivery on main.

No complexity refactor, ownership reconfiguration, suppression deletion, or detector threshold change is included. Findings from the [self-audit](../benchmarks/2026-09-06-scip-query-self-audit.md) remain the evidence for these presentation repairs.

## Implementation checkpoint

Four regression checks failed against the prior implementation for the expected reasons; ten existing checks passed. Tests exercise the real CLI for bounded category visibility, full-output recovery and unmatched suppression detail. Capability tests protect unsupported-language warnings while rejecting the obsolete score field. Pair-weight tests retain raw counts and the separate existing weighting measurement.

The source renderer now gives each finding category its own limit and leaves detailed module evidence to `system --source` or `--full`. Review/full module ordering is retained. All suppression decisions affecting findings remain explicit; unmatched records are summarized only in bounded output and are never deleted. Score disclosure is removed; pair weights are named as the sum of existing weights rather than an overall grade.

The live indexed run exposed cached action descriptions retaining the old wording. Contrary to the initial assumption, CLI build identity alone did not invalidate this report: it hashes the entry bundle, not every separately emitted implementation chunk. Cache version 14 explicitly rejects the old report format. A regression test failed against version 13 before the bump. The cache fixture was also updated to use actual current report fields instead of the removed grades.

Before the cache adjustment, all 96 focused tests, build, typecheck, formatting, changed-file lint and public API checks passed. The source diff review had no introduced/worsened or blocking findings and no coverage problems. The default live report fit one page and displayed the five largest complexity findings independently of duplication. Final checks after cache invalidation remain pending.

## Final validation

Implementation and validation are complete; this section supersedes the pending checkpoint above.

- All **97 focused tests passed** after the cache repair. The added behavior checks failed against the previous implementation before being fixed.
- Final build, typecheck and public API comparison/consumer compilation passed. Full formatting and skill-link checks passed; all changed source/test files passed lint, including the later cache edits.
- The default repository report fit a single output page. It showed graph expansion, SCIP conversion, request decoding, project setup and connected-behavior slicing as the five largest complexity findings. Duplication retained its independent five-group shortlist. All 83 unmatched suppression records were summarized after findings, with full details recoverable.
- A fresh indexed report contained no obsolete score field, warning or action wording. Actual capability limitations and raw pair counts remained visible. Version 13 reports are rejected rather than replayed with old descriptions.
- The final source diff review was accounted, with no coverage problems and no introduced, worsened or blocking findings. Indexed diff impact mapped nine changed symbols to nine affected files within its coverage; seven paths outside that index were explicitly omitted, so it does not establish exhaustive consumer coverage.
- No detector thresholds, architecture policy, suppression records or underlying complexity hotspots were changed. The full repository test suite was not repeated for these presentation/cache changes.

Run artifacts: `/tmp/scip-health-presentation-final-tests.json`, `/tmp/scip-health-presentation-indexed-final.json`, `/tmp/scip-health-presentation-review-final.json`, `/tmp/scip-health-presentation-impact.json`, plus build/typecheck/format/lint logs under the same prefix. The self-audit is included as supporting documentation; the unrelated LaunchPoint validation report remains outside the commit.
