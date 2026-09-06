# scip-query: exploration, planning, and code maintenance

Status: product vision and removal audit, recorded on 2026-09-05. The workflows and acceptance requirements below are the implementation target, not a claim that the current product already meets them. The earlier simplification and Sol/medium pilot are completed work; this document supersedes their narrower product scope.

## Purpose

Give coding agents reliable evidence about existing code and their changes, so they can choose appropriate owners, reuse suitable implementations, preserve behavior, and remove unnecessary complexity.

A module is a unit of code that implements an assigned responsibility through operations other code can use. Responsibility ownership is the assignment of control over a rule or resource to the code that enforces its valid use. For example, a reservation operation owns cancellation when all channels go through its eligibility checks and recorded writes.

A code pattern is a recurring arrangement of responsibilities and interactions, such as entry points delegating policy and persistence to the same operation. Repeated syntax is evidence of similarity; it does not establish that two implementations express the same policy or should share an owner. A code smell is an observable arrangement suggesting a maintenance problem and requiring contextual review. A finding is a recorded observation identifying the exact code, the evidence, the applicable requirement or concern, and the limits of the conclusion.

The product must work in two situations: first adoption in an unfamiliar repository, including a large repository; and continued use through exploration, a written plan, implementation, and review of the resulting diff. A diff is the set of source changes relative to an explicitly identified Git revision or snapshot.

## First adoption: useful findings without prior setup work

After preparing the supported source analysis, the tool must provide a short, useful set of findings without requiring a historical baseline, owner annotations, suppression records, or prior scip-query use. Initial indexing time and analysis coverage must be visible. Missing history or configuration must disable only the findings that depend on them.

The initial report should identify exact sites and explain concerns such as:

- Duplicated implementations, with both bodies and their material differences available.
- Complex functions, showing the decisions or nesting that contribute to the measurement.
- Circular imports, with the actual import path that closes the cycle and whether the edges are type-only or runtime imports where supported.
- Possible mixed responsibilities, supported by separately used operations, distinct consumers, dependencies, or state effects. File length or a folder name alone cannot establish this.
- Possible competing owners, supported by multiple live implementations or write paths controlling the same declared rule or resource. An absent owner declaration is missing context, not proof of defective architecture.
- Dependency violations where rules are declared. Without declarations, show the observed relationships and possible concerns; do not invent an intended layer order.

The first screen must contain actionable examples, not only category totals followed by a list of commands. Group findings about the same underlying code so one duplicated implementation does not appear as several independent problems. Large scans may be bounded, but must identify what was scanned, what was omitted, and how to recover the rest. Missing output is never a clean bill of health.

## Established use: explore, plan, implement, review

### Explore and write the plan

The agent should establish the requested behavior, applicable existing implementations and patterns, the intended owner, affected consumers, dependency constraints, and relevant tests. The tool should expose competing implementations and exceptions rather than choosing an authority by naming, apparent recency, or result order.

The written plan records the intended change, exact affected code, opportunities for reuse, behavior and state effects to preserve, planned removals, required validation, and unresolved assumptions. This is an agent-authored decision backed by evidence, not a plan inferred automatically from similarity scores. Keep plans in the repository's existing planning convention; do not introduce a second persistent planning database.

### Implement and review the actual diff

After implementation, the skill must direct the agent to review the current diff before reporting completion or committing. Review must include newly created functions, new untracked source files, and new functions added to old files, as well as modified and deleted code. It must identify the comparison revision, current source state, index freshness, and unsupported analysis.

The review should report:

1. The changed and newly created code units, including changes the index could not attribute.
2. Affected callers, consumers, and relevant dependency changes.
3. Per-function complexity before and after the change, or an explicit reason a comparison is unavailable. Splits, merges, deletions, and ambiguous matches must not be forced into misleading numeric deltas.
4. New or increased duplication against existing repository code, including another function in the same file. An unrelated duplicate elsewhere must not crowd the changed code out of a bounded search.
5. Changes in declared architecture violations and observed cycles, with actual edges.
6. Applicable drift, obsolete wiring, unused-code, and test-quality findings, each with evidence and stated coverage.
7. What improved, what worsened, what was already present, what was intentionally accepted, and what remains unknown.

The agent then addresses supported problems, checks preserved behavior, and reruns review for the affected change. A lower metric alone does not establish improvement: moving complexity into poorly named helpers, weakening tests, or merging independent policies must not count as success.

### Complexity and coverage

Cyclomatic complexity is a measure of branching within a function; counted decision points determine the result under a stated language rule set. Cognitive complexity is a rule-based estimate of difficulty following execution, including additional cost for nested decisions. These measurements describe different properties and must not be silently substituted for one another. The current branch-based estimate remains labeled as an estimate until its supported syntax is independently validated.

Test coverage records which parts of the implementation were exercised by a particular test run. The Change Risk Anti-Patterns (CRAP) index combines cyclomatic complexity with that coverage. CRAP requires coverage matched to the exact source revision, with the coverage kind and provider disclosed. Missing, stale, or unmappable coverage means CRAP is unavailable; it is neither zero coverage nor a good score. Coverage does not establish the quality of test assertions.

Metric definitions: [Sonar's Cognitive Complexity specification](https://www.sonarsource.com/docs/CognitiveComplexity.pdf), [PHPUnit's CRAP and coverage definitions](https://docs.phpunit.de/en/12.5/code-coverage.html#software-metrics-for-code-coverage).

## One evidence model, a small workflow surface

Retain shared analysis providers and use a common finding record for first-use scans and change review. Each record needs a stable rule identity, exact source subjects, supporting observations, the concern or violated declaration, evidence strength, coverage and freshness, and a concrete inspection or validation step. A change review additionally identifies whether the finding is introduced, worsened, unchanged, resolved, or not comparable to the base. Accepted exceptions retain a reason and the code identity they apply to.

Use existing `health` for repository maintenance, existing `context` plus exact exploration controls for planning, and one `review` surface for the diff. It assembles shared providers rather than grow a parallel detector engine. `diff-impact` already supplies changed-symbol and consumer evidence; it is a component of review, not the entire review.

Keep `search`, `outline`, `evidence`, `inspect`, and `code` for exact investigation. Keep architecture declarations and their checks. Decide specialist command retention from a concrete unique need and a replacement path, not from a command-count target. Do not require agents to memorize a separate command for every smell.

## Removal and consolidation audit

The recommendations below precede implementation. A producer is the code that computes an observation; its public command and report are presentation surfaces. Consolidating a surface does not justify deleting a producer still used by another supported workflow.

| Existing mechanism                                                                         | Recommendation                                                         | Evidence and replacement requirement                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File-age-based Echo orientation in `recent-duplicates`                                     | Replace as the pre-commit duplication mechanism                        | `recentDuplicateFocusFiles` and `orientRecentDuplicate` classify recency from file-add history. A new function in an old file can be excluded. Use base/current function changes for review; keep historical recency only if it answers a separately justified question. |
| Cross-file-only callable comparison in Echo                                                | Remove this restriction from diff duplication analysis                 | `callableDuplicateCandidates` sets `crossFileOnly: true`; a copied function in the same file must be detectable. Preserve intentional policy differences and report candidates rather than automatic deletion instructions.                                              |
| General similarity results presented as instructions to delete the newer code              | Remove the unsupported conclusion                                      | Shared callees or tokens do not establish equivalent behavior or ownership. Show both implementations and the verification needed before reuse or consolidation.                                                                                                         |
| Category-only health actions with effort/impact and recoverable-line estimates             | Replace as the main first-use report                                   | `HealthAction` carries aggregate descriptions and estimates without exact source subjects. Lead with evidence-backed findings; keep useful totals secondary. Do not infer effort or quality from potential line deletion.                                                |
| Separate per-detector command discovery during every review                                | Consolidate into the scan/review workflow                              | The query command registry exposes many specialist surfaces. Preserve proven producers and detailed recovery paths while removing redundant public registrations only after their replacement is tested.                                                                 |
| Generated commands and repeated exploration instructions across installed skills           | Compress; integrate the planning and review obligation                 | The primary skill duplicates command templates in its generated manual and relies on a second skill for investigation. Keep one concise normal workflow; retain specialist explanation material as references where useful.                                              |
| Watcher startup as the only ordinary freshness procedure                                   | Replace with an explicit freshness contract                            | The pilot ran with background services disabled. Review must either analyze the current source or report exactly why it cannot; the skill must support the configured service mode without repeated failed startup attempts.                                             |
| Broad source expansion during an exact range read                                          | Candidate for explicit opt-in rather than default                      | A requested `recentDuplicates` range automatically included its same-file helper closure. `inspect` already serves connected behavior; exact `code` reads should have a predictable scope. Audit compatibility and evidence completeness before changing it.             |
| `twin-ab` generated test scaffolding                                                       | Candidate for retirement from the core product                         | CLI help describes a ready-to-fill Vitest scaffold, not executed behavioral evidence. Keep validation in the project's real test framework; inspect consumers before deletion.                                                                                           |
| `self-audit`                                                                               | Keep as developer calibration, outside the normal user workflow        | Its purpose is checking the tool's own evidence paths against stronger analysis. Reliable detectors need this validation; it is not a repository cleanup finding.                                                                                                        |
| `cleanup-plan --verify/--patch`                                                            | Audit separately; do not treat compiler success as cleanup correctness | It proposes deletion batches and runs a compiler in an isolated snapshot. That can support a deletion review but cannot establish preserved runtime behavior. Preserve useful dependency ordering while avoiding a competing general planning workflow.                  |
| Optional formal-model tooling                                                              | Outside the default workflow; no wholesale deletion established yet    | The vision prioritizes first-use findings and everyday change review. Separate useful verification from its default installation and discoverability; inspect dependencies and actual users before proposing a removal.                                                  |
| Complexity, duplication, drift, dependency, consumer, source, and supported flow providers | Retain and validate                                                    | These directly serve the stated product. Removing misleading packaging is not a reason to remove accurate underlying observations.                                                                                                                                       |

Implementation anchors: [recent duplicate selection](../src/queries/cleanup/recent-duplicates.ts#L137), [callable comparison](../src/queries/cleanup/recent-duplicates.ts#L248), [file-age orientation](../src/queries/cleanup/recent-duplicates.ts#L410), [health result model](../src/queries/health/health-report.ts#L11), [command registry](../src/runtime/commands/query-command-specs.ts#L11), [primary skill](../skills/scip-query/SKILL.md), [pilot findings](benchmarks/2026-09-05-change-pilot.md).

## Implementation order and completion tests

1. Finish the removal audit and settle the small normal workflow. For each removal, identify its consumers, retained producer, replacement, contract tests, and migration note. Preserve the existing working-tree changes and earlier pilot artifacts.
2. Repair freshness and missing-selector completeness before using semantic results for review. Test initial use, watcher-disabled operation, newly added source, edits between queries, and incomplete providers. Never label a result complete when a requested subject is unresolved.
3. Establish the common finding record and concrete first-use report using validated existing detectors. Exercise a repository with no scip-query configuration or history, and a larger repository where bounded scans and duplicate grouping matter. Show actual cycle paths and duplicate sites; keep ownership concerns calibrated.
4. Implement review of the actual diff by reusing impact analysis and the same finding providers. Test tracked, staged, unstaged, untracked, added, removed, and renamed code. Read the requested base correctly and disclose failures. A staged-only review, if supported, must analyze staged bytes rather than unrelated working-tree edits.
5. Add validated per-function cognitive and cyclomatic measurements and a coverage adapter for CRAP. Start with explicit TypeScript/JavaScript support and disclose unsupported syntax/languages. Test nested functions, decision syntax, changed signatures, function splits, stale coverage, and source mappings. Extend language support only with verified implementations.
6. Repair Echo through diff-based comparison. Required cases include copying into an old file, copying within one file, renaming identifiers, reusing common library calls without duplicating a responsibility, and deliberately equal but independently changing policies. Compare changed code against established code outside the changed-file set.
7. Connect setup and the installed skill to exploration, an evidence-backed written plan, implementation, diff review, and behavior checks. Test generated instructions and execute the loop in disposable checkouts. Do not add a hidden committing or automatic refactoring step.
8. Evaluate the whole workflow using the approved cheaper model, initially `gpt-5.6-sol` at `medium`. Preserve raw outcomes and failures. Expand beyond the tiny development fixture, then repeat matched runs after requirements are frozen.

Completion requires a demonstrated first-use report, an executed planning/edit/review loop, meaningful detector and integration tests, documented omissions, compatible generated command/API records or explicit migrations, and a review of the resulting tool diff. A written vision or passing implementation tests alone is not completion of this product work.

## Evaluate the actual purpose

Measure three things separately: whether the tool identifies real problems without excessive false alarms; whether it helps an agent find existing implementations and make appropriate plans; and whether its review helps the agent repair defects in its own change while preserving behavior.

Use both known defects and legitimate exceptions. Tasks must include problems that the agent is not explicitly told to look for, and checks independent of the detector's own score. Record correct findings, missed defects, false alarms, unnecessary edits, preserved behavior, maintenance effort on a later change, time, and token use. An import cycle detected correctly and a suggested module split justified poorly are different outcomes.

The [first Sol/medium pilot](benchmarks/2026-09-05-change-pilot.md) remains a small development baseline. Its directed tasks and index-refresh limitation do not establish the value of first-use diagnosis, planning, or continuous diff review. Do not replace it silently, tune against a held-out evaluation set, or use a lower complexity score as the sole success criterion.

## Implementation checkpoint: 2026-09-05

The ordinary workflow now has a shared current-source TS/JS health scan and Git-based review, documented in [REVIEW.md](REVIEW.md). Review includes changed/new/deleted functions, explicit metric contributions, same-file and repository-wide body duplication candidates, relative import cycles, declared architecture edges, removed-file import residue, and measured coverage/CRAP with source-hash validation. It does not depend on watcher freshness. Source and supplied test-coverage omissions are visible and fail the optional completeness gate.

Removed in this implementation: `twin-ab` and its public scaffold API; automatic local-call expansion from ordinary range reads; literal-erasing comparison in the older duplicate-body detector. The default health report now presents exact finding sites; the older specialist report is available through `health --indexed`. Main skill and setup guidance connect exploration, a written plan, implementation, diff review, simplification and behavioral checks. Missing graph roots and partial multi-selector source reads no longer report full resolution.

Still evidence-dependent: conceptual ownership, business-rule equivalence, module cohesion and the best abstraction cannot be inferred from size or token similarity. Existing context/evidence and indexed drift/framework/cleanup producers remain useful specialists. This checkpoint does not certify every language/provider or claim measured agent effectiveness. A Sol medium audit on a real repository snapshot found three reproducible defects in the first implementation; all three now have fixes and regression tests. See the [audit report](benchmarks/2026-09-05-maintenance-sol-audit.md).

Reviewing the implementation also exposed a comparison defect: an increase in one complexity measure could be hidden by an unchanged maximum ranking score. Review now compares both measures independently, with an executable regression for increased cyclomatic complexity and unchanged cognitive complexity. The report renderer separates changed-function records from finding details; the comparison logic makes its precedence explicit. These changes improve the implementation without requiring every parser branch or validation check to disappear below a threshold.

The repository policy gives the isolated change-benchmark fixture its own boundary with no production dependencies. Range-read tests belong to the navigation test suite. The existing source owner continues to own source snapshots, parsing, fingerprints and coverage measurements; its file budget increases from 61 to 65 for the four shared implementations. This is an explicit budget revision for added responsibility, not evidence that file count measures conceptual quality. All dependency-direction and ownership-coverage rules remain enforced.

The implementation's own review remains above the strict complexity gate: examples include `dependenceSlice` (41 cyclomatic / 48 cognitive), the metric syntax visitor (24 / 29), and `functionCoverage` (19 / 18). Their branches include criterion validation, bounded traversal, syntax-specific counting, source-hash validation and nested-function exclusions. These are retained review findings, not waived checks or a claim that the implementations are optimal. Further simplification must preserve those distinctions and the regression cases. No whole-repository coverage receipt was supplied for this review, so it makes no whole-repository CRAP claim.

Final verification on 2026-09-05: all 2,871 tests in 334 files passed in the serial full suite. `npm run lint` passed formatting, ESLint, the build, public API compatibility, consumer type checking and skill-link checks; `npm run typecheck` and `git diff --check` passed separately. After reindexing, architecture mapped all 541 indexed files across 37 declared boundaries, with no unmapped or ambiguous owners, forbidden dependencies, cycles, size-limit violations, test-boundary violations or stale allowances. The current-source review accounted for 563 eligible files and 12,326 functions with no source-coverage problems. Indexed `diff-impact` also ran, but its coverage did not establish an exhaustive consumer set. The Sol audit and the tests support these bounded claims; they do not establish general improvement in agent outcomes.


## First-use reliability follow-up

The active follow-up is recorded in [the scanner checklist](plans/2026-09-05-first-use-scanner-reliability.md). Compiler snapshot resolution, configuration-only diff evidence, source-role exclusions, dependency-role separation, bounded planning subjects and a conservative lexical-binding responsibility candidate are implemented. The follow-up is verified in the [first-use validation report](benchmarks/2026-09-05-first-use-validation.md); the earlier checkpoint above describes the preceding implementation. Current user-facing behavior and precise limitations are documented in [REVIEW.md](REVIEW.md).


The first-use follow-up passes the 2,900-test full suite, final focused checks, lint/type/API checks and the refreshed architecture policy. Its source scan resolves LaunchPoint's aliases across all 5,306 eligible files with zero unresolved internal imports in that snapshot. It presents shared dependency components and a bounded selection of module subjects with exact evidence. Conceptual ownership and runtime resource identity remain evidence-dependent; no responsibility candidate qualified in LaunchPoint, and no general agent-effectiveness improvement is claimed. See the validation report for retained metrics, source/index coverage differences and the cheaper-model audit.
