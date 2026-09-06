# Improving ownership and change quality

The broader product direction and next removal audit are now recorded in [the product vision](../PRODUCT_VISION.md): first-use diagnosis, evidence-backed planning, and review of the actual diff. This document retains the earlier plan and its delivered benchmark history; it is not the complete current product specification.

Status: the simplification pass and four-task change benchmark are implemented. The first Sol/medium comparison completed: all 16 editing sessions passed, with longer sessions and higher token use under scip-query. [The pilot report](../benchmarks/2026-09-05-change-pilot.md) records the results and the index-refresh limitation. Fix refresh integration and incomplete coverage reporting before treating this as an efficacy comparison or expanding the analysis surface. Sections 2–5 remain proposed. The removal table below records the earlier proposal; [the migration guide](../api/compatibility/2026-09-05-analysis-surface-retirement.md) describes the delivered removals.

## Product objective

Help an agent place a change in the correct responsibility owner, preserve required behavior and consumers, and remove the obsolete implementation completely.

A module is a unit of code that implements an assigned responsibility through operations other code can use. Ownership is the assignment of control over a rule or resource to the code responsible for enforcing its valid use. For example, a booking module owns confirmation eligibility when clients request confirmation through operations that enforce that rule.

Conceptual clarity means that code names and divisions consistently identify the actual responsibilities implemented. Dependency order is the permitted direction in which modules rely on one another. Architectural quality concerns whether that arrangement supports required behavior and allows relevant changes without unnecessary changes elsewhere. Lines of code, dependency counts, and function size provide evidence for these judgments; none establishes them independently.

## Existing foundation

- `src/queries/impact/context.ts` assembles reference and call relationships, affected consumers, dependencies, system information, similarity candidates, history, and source evidence. The `plan-context` alias has been retired.
- `src/runtime/query-commands/planning.ts:162` already renders a decision-oriented context report. Improve that report before introducing another aggregate command.
- `src/domain/config-types.ts:213` defines named architecture boundaries, permitted dependency directions, coverage requirements, and structural limits.
- `src/queries/graph/architecture.ts:153` evaluates the observed dependency graph against those declarations.
- `src/queries/cleanup/locality-candidates.ts:238` collects consumers and proposes locations using directory relationships. Its results are explicitly signals. A nearest common directory is evidence about location, not proof of responsibility ownership.
- `scripts/exploration-benchmark-core.mjs:6` validates explanation benchmarks built around required facts and forbidden claims. Existing explanation evaluations should remain available while a separate task kind evaluates edits.

## 1. Establish a small change benchmark

A change benchmark is a repeatable evaluation that gives an agent a fixed repository revision and requested change, then checks the resulting implementation against independently specified requirements.

The initial implementation is documented in [`benchmarks/change/README.md`](../../benchmarks/change/README.md). It uses four tasks in a synthetic TypeScript project, followed by a fresh-agent maintenance change for each result. Hidden behavior checks, compiler-resolved structural checks, preserved policy, and independently executed submitted tests determine automated acceptance. The runner records raw events, patches, usage, and timing. The first cohort uses `gpt-5.6-sol` at `medium`, with one matched pair per task. Repeated and held-out repository evaluations remain necessary.

Start with four tasks in one supported TypeScript project:

| Task                                        | Required result                                                                 | Failure that the task must detect                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Change a rule used by multiple entry points | All applicable clients use the intended rule owner and retain required behavior | Agent patches one client or adds a competing implementation                |
| Review two similar implementations          | Consolidate only when the requirements establish one responsibility             | Agent merges independently changing rules because their bodies match       |
| Replace an implementation                   | Consumers use the replacement and retired wiring is removed                     | Old registration, alternate path, or obsolete configuration remains active |
| Correct a dependency direction              | Restore the declared boundary while preserving behavior                         | Agent moves files cosmetically or weakens the policy to obtain a pass      |

Each task includes a follow-up requirement that exercises the intended module boundary. This makes the cost of the resulting design observable through a second change. Include a legitimate wrapper and an intentional duplication among the cases so preserving useful structure can succeed.

Run the same model and reasoning setting with equivalent task instructions in three conditions: native tools; native tools with the investigation discipline; scip-query with the same discipline. Repeat each condition, retain all results, and separate cold indexing from warm query costs. Use isolated disposable worktrees for agent mutations.

Freeze requirements and checks before optimizing the tool. Requirements specify behavior and justified responsibility constraints, not one preferred filename or exact patch. Hold back an additional repository or task set from detector tuning. The first small cohort provides a development baseline, not evidence of general effectiveness.

Assess results separately:

- Required behavior, including failure paths, remains correct under applicable tests.
- Intended responsibility and dependency constraints hold, with concrete code evidence.
- Retired consumers and wiring are accounted for; unsupported external or dynamic consumers remain explicit.
- The follow-up change can be implemented without duplicating the rule or modifying unrelated responsibilities.
- Reviewers, unaware of the tool condition, identify unnecessary abstractions or unjustified consolidation and record their reasons.
- Time, token use, changed public operations, touched modules, and code added/removed remain separate measurements.

Do not calculate a universal architecture score. Do not promote an efficiency gain that loses required behavior. Extend the runner and artifact comparison around a mutation task kind; keep literal answer matching confined to explanation diagnostics.

## 2. Improve the existing context report

Use `context <symbol-or-path>` as the ordinary starting point for a scoped change. Refine its existing report to answer:

1. What exact code was selected, and which declared module contains it?
2. What responsibility is declared for that module, if any?
3. Which external callers and consumers use its operations?
4. Which relevant state operations and runtime handoffs are established by supported providers?
5. Which dependencies and declared constraints apply to the selected change?
6. What remains unknown, ambiguous, or omitted, and which exact evidence can resolve it?

Keep compiler/source observations, repository declarations, and agent proposals distinguishable. For example, “all observed consumers are under billing” is an observation; “billing should own this rule” is a proposal requiring the rule's meaning and constraints. A declaration records intended responsibility but does not prove actual enforcement.

Without configuration, return the observed structure and identify responsibility as undeclared. A directory grouping must not silently become an inferred architectural boundary. Preserve multiple plausible live implementations when available evidence cannot select one. Unsupported state or runtime analysis must not turn into a claim that no writer or consumer exists.

Reuse existing producers and project only the relationships needed for these fields. Avoid calling every analyzer for every context request. Defer broad similarity scans and large source bodies unless the requested decision needs them. Compact repeated calibration text while keeping freshness, material uncertainty, complete selected source units, and recoverable omissions visible. Mandatory transport continuations must never be silently discarded.

Acceptance: the initial report exposes the material owner, consumers, and applicable rules for the four benchmark tasks without a separate discovery sequence. Detailed evidence remains retrievable. Correctness, interaction count, output size, and latency are compared with the current context command.

## 3. Add minimal declarations of responsibility where needed

Build on existing architecture configuration after the first benchmark identifies missing intent that changes an agent's decision. Reuse existing repository documentation where it already declares that intent.

The smallest useful addition can describe a module's responsibility, identify its controlled operations with exact selectors, and link to requirements or tests for rules those operations must preserve. Such a rule is a condition that every permitted operation must maintain, for example preventing a second settlement of the same payment.

Validate referenced identities and report their freshness. Use supported reference and dependency evidence to identify clients that reach internal operations outside the declared access points. Keep type use, executable calls, and imports distinct. General proof that every possible state mutation obeys a business rule remains outside the supported analysis; applicable tests and source review are still required.

Declarations are optional for exploration. Agent-generated declarations remain proposals until deliberately adopted as repository policy. Do not infer allowed dependencies by copying every existing dependency: that would accept the structure being reviewed. Do not add a general ontology or a second architecture configuration system.

Acceptance: a fixture that bypasses a declared operation produces an attributable finding; a permitted client remains clean; stale selectors, absent declarations, and unsupported dynamic access produce explicit limitations.

## 4. Review changes against their stated responsibility

Connect the improved context result to the existing `diff-impact` and architecture checks. A review should explain what changed in consumers, permitted dependency directions, exposed operations, and relevant state access. When the task explicitly retires a symbol or path, account for its remaining registrations, consumers, and configuration through supported evidence and targeted source reads.

Report which obligations were checked, which checks passed, and which remain unresolved. Do not infer preserved behavior solely from unchanged dependency counts or compiler acceptance. Keep native tests appropriate to the requested behavior in the verification loop.

Acceptance: each benchmark's deliberately incomplete patch fails the relevant check or review obligation, while a valid implementation passes without weakening policy. Dynamic or external coverage gaps cannot be reported as successful retirement.

## 5. Make detector usefulness depend on change outcomes

Use existing health and locality findings to supply inspection evidence. For a consolidation or extraction proposal, require an account of the responsibility, consumers, state/effect relationships, preserved differences, and resulting operations other code must use. The agent supplies the semantic judgment and its source evidence; the deterministic analyzer supplies only supported observations.

Demote the aggregate health number in ordinary agent output. Preserve existing machine fields until the public API migration policy permits changes. Show findings and coverage without presenting a score increase as proof of a better design.

Retain intentional duplication, useful forwarding boundaries, and coherent orchestration as negative examples. New detector rules must improve held-out decisions, with regressions disclosed separately from gains on the tuning repository.

## Removal and consolidation work

Prioritize subtraction alongside the first context improvement:

| Candidate                                                  | Proposed action                                                                                                                                              | Preserve or verify                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate health, risk, and hygiene scores                 | Remove headline grades first; retire scoring-only weights and public score fields through the API migration process                                          | Keep individual findings, measured counts, coverage, suppressions, and useful pressure measurements. `computeHealthScore` currently returns both deductions and pressure, so deleting the entire function would also remove other output.                           |
| Deprecated command names                                   | Retire `deep-chains`, `convergence`, and the deprecated `anchors`, `system-map`, and `evidence-source` paths through a documented compatibility release      | Verify remaining callers, package exports, skills, generated documentation, and tests. Preserve distinct underlying analyses used by current commands.                                                                                                              |
| Misleading legacy `dataflow` and `slice` names             | End their deprecation rather than preserving them indefinitely                                                                                               | Their old behavior is reference/call navigation. Do not pretend that migration to actual value-flow or dependence analysis is behaviorally equivalent; document the reference-navigation alternatives separately.                                                   |
| Retired outcome-journal types and `plan-context` API alias | Complete the advertised compatibility period, then remove obsolete exports and their exclusive fixtures/documentation                                        | `src/queries/compatibility/outcome-events.ts` explicitly retains the types for stored-record readers for one minor release. Check release history and external API commitments before deletion; repository references cannot prove there are no external consumers. |
| Broad skill installation and repeated command manuals      | Make specialist planning, root-cause, integrity, calibration, and compression guidance opt-in; keep a small shared command reference and investigation guide | `src/runtime/setup.ts` currently iterates the installable skill list across agent roots. Preserve user-owned skills and explicit specialist workflows. Test that simplifying defaults preserves answer and edit quality.                                            |
| Generic wrapper and low-consumer-count judgments           | Remove automatic debt implications from ordinary summaries; expose the observed shape and consumer count when relevant to a selected change                  | Retain concrete forwarding/consumer facts. One consumer does not prove an unnecessary abstraction; a controlled access point can deliberately forward a call.                                                                                                       |

Formal modeling is a lower-confidence separation candidate: the `tla` workflow constructs and checks explicit models of permitted state transitions. Consider an optional package only after mapping its dependencies and finding that package separation reduces core maintenance. It can remain useful for stateful systems; it is not a demonstrated safe deletion merely because it is specialized.

The earlier August simplification already removed autonomous goals, completion management, operation journaling, and blocking diff gates. Do not budget a second removal of systems that are already retired, and do not recreate them as part of the responsibility work.

These are product and implementation recommendations, not completed deletions. Any actual removal must eliminate its exclusive wiring, tests, schemas, and documentation together, preserve shared behavior, and pass the appropriate API and consumer checks.

## Delivery order

1. Commit the frozen four-task baseline and mutation evaluation support.
2. Implement and measure one narrow context improvement for the first task.
3. Add the smallest responsibility declaration required by an observed ambiguity, with one bypass check.
4. Connect the resulting evidence to change review and retirement verification.
5. Expand to held-out tasks and adjust detector presentation based on resulting edits.

Keep these as separately reviewable changes on `main`. Run meaningful focused tests, the project's required checks for code/API changes, architecture verification, and `diff-impact` for nontrivial source edits. No broad rewrite, additional graph family, or expanded detector catalog is a prerequisite.

The first release decision is whether agents make and verify the selected rule change more reliably, with the mechanism and costs visible. General architectural claims require broader repeated evidence.
