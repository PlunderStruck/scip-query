# Analyzer Inventory and Action-Tier Review

An analyzer in this project is a query or command-backed program that examines repository evidence such as the SCIP graph, source text, AST profiles, git history, docs, or a diff, and returns a structured answer about code health, change risk, reuse, or navigation.

A finding is an analyzer result that names a concrete codebase location, relationship, or diff condition as worth attention. Its defining role is to turn raw evidence into a maintainer-facing claim.

The useful product split is not the same as evidence quality. Evidence quality says how the claim was obtained: graph fact, semantic provider, source heuristic, change graph, or baseline. Action tier says how strongly the claim justifies a repair without broader product or architecture judgment.

Companion docs:

- `docs/analyzer-validation-protocol.md` defines how to validate true positives, false positives, and false negatives across real repositories.
- `docs/analyzer-validation-ledger.md` tracks the remaining validation work, run batches, and completion state.
- `docs/locality-analyzer-design.md` designs the missing code-organization analyzer for extraction placement and shared-folder locality.

The action tiers are:

- Direct repair evidence identifies code or docs that usually need a local action: delete, wire up, finish migration, remove unused surface, break a cycle, or split excessive complexity. Review is still required, but the default next step is action.
- Contextual signal evidence identifies a pattern that may hide a better design, but the right action depends on ownership, product semantics, locality, naming, or architecture. The default next step is investigation.
- Support analysis provides facts used by people, agents, or other analyzers, but does not itself assert a smell.

## Current Surfaces

The published query surface and private query-helper manifest live in `src/queries/public-query-entries.ts`. The CLI command order and families live in `src/runtime/commands/query-command-specs.ts`. The composite health score runs the phases listed in `HEALTH_PHASES` in `src/queries/health/health.ts`; that health path also carries the full-vs-bounded semantic enrichment budget used by semantic-capable detectors. The diff gate runs the default diff-scoped checks listed in `DIFF_GATE_CHECKS` in `src/queries/impact/diff-gate.ts`; the baseline policy helper remains private to the query tree and runs only for the explicit full health-baseline ratchet. The `tla` command is also ordered in that command registry as an on-demand formal-model verifier, not as a health-scored analyzer.

An earlier `health --json` run on this repository reported:

- score 100, riskScore 100, hygieneScore 100
- zero active findings across all health phases
- 174 suppression comments: 72 extract, 62 wrapper, 17 stale, 15 similar, 8 passthrough

That suppression shape was evidence that broad candidate analyzers had historically produced enough accepted or false-positive results to need explicit maintainer judgment. The suppression lifecycle review confirmed the source comments were recent and reasoned, while structured file-scoped suppressions now warn when their file path goes stale.

The declared-coupling config has been refreshed after the inventory surfaced old pre-folder-move paths. `config-validate` now warns when a declared-coupling entry names a file that no longer exists, so known maintenance units stay connected to the current file graph instead of silently becoming stale metadata.

## Health-Scored Analyzers

| Analyzer                         | Evidence examined                                                                                                                                                                                                   |                 Current health role | Recommended action tier                                                                              | Evaluation                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------: | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dead`                           | Production definitions, SCIP/source/caller references, package roots, framework-discovered route/page roots, and entry exclusions                                                                                   |                Risk, graph findings | Direct repair for `dead-code`; contextual for `file-internal`                                        | Strong when `kind === dead-code`: zero references and excluded external-live surfaces make deletion likely. `file-internal` is not direct deletion evidence; it may be private helper ownership.                                                                                                                |
| `cleanup-plan`                   | `dead --only-dead` seed plus conservative cascade references                                                                                                                                                        | Standalone, not direct health phase | Direct repair                                                                                        | Strongest deletion analyzer. It computes ordered batches and can be compiler-verified from the command layer.                                                                                                                                                                                                   |
| `isolated`                       | Production callables with no callers and no non-self callees                                                                                                                                                        |                Risk, graph findings | Direct repair                                                                                        | Strong dead-leaf signal. It is stricter than `dead` and usually means remove or wire up.                                                                                                                                                                                                                        |
| `cycles`                         | File dependency graph, with module-hierarchy/test/barrel/entry cycle classification                                                                                                                                 |                                Risk | Direct repair for `real`; support/noise for `module-hierarchy`                                       | Good split already exists. Real cycles normally need architectural repair. Module-hierarchy cycles should not score.                                                                                                                                                                                            |
| `similar` / `similarAll`         | Callable callee fingerprints, IDF weighting, source-token fallback                                                                                                                                                  |                             Hygiene | Contextual signal                                                                                    | Similarity is a reuse lead, not proof of duplicate semantics. Needs naming, behavior, signatures, and product intent before action. Shared evidence is now labeled as domain, access/query, framework/generic, mixed, or neutral structural overlap.                                                            |
| `recent-duplicates`              | `similarAll`, React/Vue duplicate analyzers, git file-age orientation                                                                                                                                               |                  Standalone cleanup | Direct repair for `echo`; contextual for `twin`                                                      | Directionality makes this much stronger than plain similarity. A recent echo usually should reuse/delete. Twins still need choice of owner.                                                                                                                                                                     |
| `react-component-duplicates`     | JSX structure tokens from React profiles                                                                                                                                                                            |                             Hygiene | Contextual signal                                                                                    | Good UI reuse lead. Needs product semantics and design-system judgment before extracting.                                                                                                                                                                                                                       |
| `react-hook-candidates`          | Shared React hook/state/effect/request/handler tokens, evidence class, action tier, and recommendation                                                                                                              | Hygiene, with `scoreCount` discount | Contextual signal for domain or mixed behavior; support for generic workflow/shared abstraction rows | Better than raw similarity because behavior tokens are named. The output now separates generic UI workflow and existing shared abstractions from domain behavior, but extraction still needs product judgment.                                                                                                  |
| `react-large-component-pressure` | Component LOC, file LOC, JSX token count, behavior token count, pressure kind, context, recommendation kind                                                                                                         |                             Hygiene | Direct repair pressure with review direction                                                         | Large component pressure usually implies splitting. It now distinguishes JSX, behavior, file, and route/page pressure, but still does not choose the destination directory for extracted code.                                                                                                                  |
| `vue-component-duplicates`       | Vue template structure tokens                                                                                                                                                                                       |                             Hygiene | Contextual signal                                                                                    | Same reuse caveat as React component duplicates.                                                                                                                                                                                                                                                                |
| `vue-composable-candidates`      | Vue composable/store/reactivity/lifecycle/request/function/template tokens, evidence class, action tier, and recommendation                                                                                         | Hygiene, with `scoreCount` discount | Contextual signal for domain or mixed behavior; support for generic workflow/shared abstraction rows | Good extraction lead when domain behavior is present. Generic workflow scaffolding remains visible as support, and extraction still needs domain and locality judgment.                                                                                                                                         |
| `vue-large-view-pressure`        | SFC total/template/script/style/external-script line counts, pressure kind, context, recommendation kind                                                                                                            |                             Hygiene | Direct repair pressure with review direction                                                         | Usually implies splitting a large view. It now distinguishes template, script, style, external-script, and route/page pressure, but still needs companion directory-locality guidance.                                                                                                                          |
| `extract-candidates`             | Large callable callee clusters, co-occurrence isolation, extraction kind, action tier, and recommendation                                                                                                           |                             Hygiene | Contextual signal                                                                                    | It finds possible extraction seams, not proof of a new abstraction. The output now distinguishes workflow orchestration from broad/cohesive helper clusters and keeps every row as signal.                                                                                                                      |
| `wrapper-candidates`             | Small production callables with one real external caller, caller fan-in, and boundary-token evidence                                                                                                                |                             Hygiene | Contextual signal, sometimes direct                                                                  | Single-caller wrappers can be needless indirection, but may also be names, domain/lifecycle boundaries, test seams, or API shaping. Boundary evidence discounts those without hiding them.                                                                                                                      |
| `passthrough-candidates`         | Small production callables with exactly one callee, literal pass-through body, runtime-boundary evidence, public-facade evidence, action tier, recommendation, and score count                                      | Hygiene, with `scoreCount` discount | Direct when no boundary or public-facade evidence is present; contextual signal when either exists   | Body-shape gate is real. Boundary evidence distinguishes adapter, provider, public, capability, transport, lifecycle, access-policy, and facade-shaped forwarders; public-facade evidence separately identifies package-public or rooted exported passthroughs.                                                 |
| `stale-abstractions`             | Type-like definitions, real consumers, barrel consumers, transitive reachability, definer usage, confidence, staleness kind, action tier, and recommendation                                                        |                             Hygiene | Direct for unused abstractions; contextual signal for one-consumer ownership rows                    | `0 consumers` is direct repair. `1 consumer` is contextual, including high-confidence misplaced types, because the repair may be move, inline, keep, or document as public contract.                                                                                                                            |
| `drift`                          | File dep graph, symbol ref graph, semantic/source import usage, explicit or inferred layer policy, sibling patterns, action tier, policy basis, recommendation                                                      |                             Hygiene | Split by kind                                                                                        | `unused-import` is direct repair. Explicit `layer-violation` is direct; inferred layer policy and `pattern-deviation` rows are contextual signal. Pattern deviations remain excluded from health scoring.                                                                                                       |
| `complexity-hotspots`            | Production callable LOC, fan-in, fan-out, callee count                                                                                                                                                              |                                Risk | Direct repair pressure                                                                               | Complexity pressure usually means refactor, but the current score is structural, not cyclomatic. It should be separate from branch-count complexity.                                                                                                                                                            |
| `co-change` / hidden coupling    | Git co-change pairs, dependency edges, declared couplings, file noise filters, partner-class labels, declared-coupling suggestions, commit scope, recency context, commit-subject context, and score-weighted count |  Risk, weighted by history strength | Contextual signal                                                                                    | Strong evidence that coordination may be missing, but not proof that extraction or unification is correct. Partner classes, history context, subject context, and score weighting now separate contract-like focused current pairs from broad, stale, or unlabeled history before suggesting declared coupling. |
| Suppression inventory            | `scip-query: ignore-*` comments in source, plus structured `.scipquery.json` suppressions                                                                                                                           |               Evidence quality axis | Meta signal                                                                                          | Useful precision feedback. High suppressions should reduce trust or weight for that detector family. Structured file-scoped suppressions now validate path freshness.                                                                                                                                           |

## Diff-Gate Checks

| Check                  | Evidence examined                                                                                                                                                                         | Recommended action tier    | Evaluation                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo`                 | Changed symbols compared to established `similar` matches outside the diff                                                                                                                | Direct repair leaning      | More actionable than repo-wide `similar` because it is scoped to new or changed code. Still verify semantics before reuse.                                                                                                                                                                                    |
| `incomplete-migration` | New helpers in the diff, existing references, leftover established sites with helper-callee containment, site coverage, helper-shape evidence, and migration-scope hints                  | Direct repair              | Strong. It models the exact failure mode of half-finished extraction and gives concrete leftover sites, while rejecting broad old sites where the helper pattern is only a small fragment and labeling possible subtype/variant leftovers for review.                                                         |
| `co-change-partner`    | Historical partner changed without the other side in current diff, with co-change partner class, commit scope, recency, commit-subject context, and optional declared-coupling suggestion | Contextual signal          | Good sync warning, but sometimes the coupling no longer holds or should be intentionally broken. Partner classes, history context, and subject context make doc/code, config/code, schema/script, model/view, test/code, broad-sweep, stale, docs-labeled, fix-labeled, and issue-ref cases easier to review. |
| `doc-reference`        | Living docs citing changed files, excluding import-only source changes, with citation kind and Markdown-local cited-claim context                                                         | Split by citation evidence | Behavioral/current doc claims are direct doc-review evidence. Configuration examples and intentional records are support-tier checks unless the cited target changed meaning.                                                                                                                                 |
| `unused-params`        | Trailing unused params in changed files                                                                                                                                                   | Direct repair              | Conservative enough to be a high-confidence local fix.                                                                                                                                                                                                                                                        |
| `new-dead`             | Changed production symbols with zero consumers, excluding entry/root/test/framework-discovered cases                                                                                      | Direct repair              | Either wire it up, remove it, or mark it as an externally live root before it lands.                                                                                                                                                                                                                          |
| `baseline`             | New health finding identity versus committed baseline, when the caller explicitly asks diff-gate to run the full baseline ratchet                                                         | Direct gate                | It does not explain the smell itself, but correctly blocks regression until fixed or accepted. It is opt-in for diff-gate because the baseline comparison is repo-wide rather than diff-sized.                                                                                                                |

## Standalone Cleanup and Similarity Analyzers

| Analyzer              | Evidence examined                                                                                                                              | Recommended action tier                                       | Evaluation                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unused-params`       | TS/JS AST facts plus identifier usage lines                                                                                                    | Direct repair                                                 | Intentionally conservative: trailing only, simple params only, underscore-intent skipped, external roots skipped. Should be in the direct tier despite heuristic metadata.                    |
| `unused-imports`      | Source/AST import facts plus local binding usage                                                                                               | Direct repair                                                 | A narrower direct cleanup analyzer. It should stay direct when the imported binding is unused in executable and type surfaces, with framework/compiler caveats handled in `drift` validation. |
| `redundant-reexports` | Barrel exports, JS/TS re-export statements, SCIP/source fallback consumers, direct importers, package-surface evidence                         | Direct for private barrels; signal for package-public barrels | Strong when the candidate barrel is private and both barrel and direct consumers are zero. Package-public barrels stay visible as signal because external consumers may import through them.  |
| `similar-files`       | File dependency-profile Jaccard with infrastructure and distinctive-dep gates                                                                  | Contextual signal                                             | Good for copy-paste family discovery, not direct extraction proof.                                                                                                                            |
| `similar-chains`      | Dependency chain generation, infrastructure filtering, edit distance                                                                           | Contextual signal                                             | Finds duplicated pipelines, but pipeline ownership and abstraction shape require design judgment.                                                                                             |
| `similar-signatures`  | Semantic/documented/source normalized function signatures                                                                                      | Contextual signal                                             | Same type shape is only a weak lead. Useful for search, not scoring unless combined with behavior evidence.                                                                                   |
| `convergence`         | Two symbols' shared and unique callees                                                                                                         | Support/contextual signal                                     | It explains a possible consolidation strategy; it should not score by itself.                                                                                                                 |
| `locality-candidates` | Candidate symbol/file path, directory ancestry, consumer files, consumer coverage, nearest common owner, boundary markers, and counterevidence | Contextual signal                                             | Guides placement and ownership review for extracted or shared code. It is deliberately report-only and should not force moves or affect health score without repair-outcome evidence.         |
| `doc-drift`           | Living docs, path citations, cited-claim contexts, doc-code co-change, doc intent, action tier, code churn after doc update, broken references | Split by evidence                                             | Broken references are direct repair. Path-cited stale subjects now expose citation context. Co-change-only staleness is signal for current guidance and support for historical notes.         |

## Graph, Risk, and Planning Analyzers

| Analyzer             | Evidence examined                                                                                                                  | Recommended role          | Evaluation                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `affected`           | Transitive symbol impact from a changed symbol                                                                                     | Support analysis          | Blast-radius map, not smell.                                                                                                                                        |
| `change-surface`     | Definitions in a file plus external consumer counts                                                                                | Support/risk analysis     | Pre-change risk briefing. Useful for planning and score context, not a repair.                                                                                      |
| `plan-context`       | Trace, references, call graph, dataflow, deps/rdeps, surface, affected, change-surface, complexity, history                        | Support analysis          | Composite planning bundle. It should not contribute smell score directly.                                                                                           |
| `bottlenecks`        | Callable fan-in times fan-out, risk kind, action tier, evidence reasons, recommendation                                            | Contextual signal         | Good risk hotspot, not automatic refactor. Output now states `signal` and frames central code as coordination risk rather than repair proof.                        |
| `hotspots`           | Most referenced symbols                                                                                                            | Support/contextual signal | Identifies choke points. Not a smell alone.                                                                                                                         |
| `fan-in` / `fan-out` | Reference counts into symbols or out of files                                                                                      | Support analysis          | Raw graph metrics.                                                                                                                                                  |
| `coupling`           | Shared symbols between two files or top coupled pairs, coupling kind, action tier, evidence reasons, recommendation                | Contextual signal         | May reveal boundary problems, but shared symbols can be intended. Output now makes the coordination-pressure interpretation explicit.                               |
| `deep-chains`        | Longest dependency chains after SCC condensation, suffix de-duplication, chain kind, action tier, evidence reasons, recommendation | Contextual signal         | Long chains imply propagation risk, but action depends on layers and ownership. Strict suffix duplicates are now removed from top results.                          |
| `complexity`         | Branch count, cyclomatic estimate, callee count, fan-in, fan-out for one symbol                                                    | Direct repair pressure    | This is closer to the user-specified "cyclomatic complexity" analyzer than `complexity-hotspots`. Should score strongly when branches/cyclomatic exceed thresholds. |
| `self-audit`         | Cheap evidence paths checked against TypeScript compiler oracle                                                                    | Meta analysis             | Measures analyzer accuracy. Should guide trust/weight, not code health directly.                                                                                    |

## Navigation and Evidence Providers

These commands analyze the index, but they are not finding detectors and should not affect health score directly: `stats`, `files`, `methods`, `refs`, `trace`, `deps`, `rdeps`, `system`, `surface`, `imports`, `imported-by`, `outline`, `members`, `by-kind`, `kind-counts`, `hierarchy`, `call-graph`, `code`, `dataflow`, and `slice`.

They are essential because other analyzers and agents use them to ground claims. Their defining characteristic is retrieval or explanation, not smell detection.

`tla` is a formal-model verification command: it checks a TLA+ module, an explicit model-to-TypeScript mapping contract, and compiler-indexed code evidence in one on-demand run. Its defining role is to make model/code discrepancies reviewable before a user or agent treats the TLA+ model as an accurate description of the implementation.

The support-analysis accuracy review confirmed that `refs`, `affected`, `change-surface`, `plan-context`, `imports`, `deps`, `rdeps`, `fan-in`, `fan-out`, `hotspots`, `status`, and `self-audit` return useful source-grounded evidence for a TypeScript target. It also fixed diagnostic parity so `status` and `doctor` use the same root-aware config validation as `config-validate`.

The cross-language boundary review confirmed that Rust projects have graph-backed indexing, source fallback, cleanup detector output, git/diff support, and compiler cleanup verification when `rust-analyzer` and `cargo check` are available. It also confirmed that TypeScript semantic self-audit is explicitly unavailable on Rust and that React/Vue analyzers return stack-specific empty results rather than Rust findings.

`cleanup-apply` is not an analyzer. It is an action command that applies a `cleanup-plan` batch, so it should be validated through the `cleanup-plan --verify` path and normal project checks.

## Overlap and Duplication Review

The codebase already avoids some duplicate analysis by sharing kernels:

- `runCandidateAnalysis` gives candidate-style analyzers one lifecycle for scan limits, preparation, evaluation, ordering, and result caps.
- `rankedPairwiseProfileResults` gives React, Vue, file-profile, and pairwise similarity analyzers a shared pair-ranking shape.
- `HEALTH_DETECTOR_PROFILES` keeps health and baseline detector options aligned.

The remaining conceptual overlap is mostly healthy, but needs product labels:

| Overlap family             | Members                                                                                                                              | Same analysis or distinct?                                                                                      | Recommendation                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deletability               | `dead`, `isolated`, `cleanup-plan`, `redundant-reexports`, `new-dead`                                                                | Distinct evidence scopes over the same core question: can this be removed or must it be wired?                  | Model as one "deletability" action family with subtypes and confidence.                                                                                 |
| Similarity and reuse       | `similar`, `similar-files`, `similar-chains`, `similar-signatures`, `convergence`, React/Vue duplicates, `recent-duplicates`, `echo` | Distinct evidence bases. The risk is UX confusion, not implementation duplication.                              | Keep separate, but expose basis, action tier, and root-cause groups where pairwise rows repeat.                                                         |
| Extraction pressure        | `extract-candidates`, React/Vue behavior candidates, large component/view pressure, `incomplete-migration`                           | Different stages: discover seam, detect duplicated behavior, detect excessive size, catch unfinished migration. | Score unfinished migrations higher than discovery leads.                                                                                                |
| Indirection                | `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`                                                                 | Related but not the same: single caller, literal forwarding, low-consumer types.                                | Passthrough and wrapper rows now split by boundary evidence; stale should split by confidence.                                                          |
| Architecture/history drift | `drift`, `doc-drift`, `co-change`, `co-change-partner`, `doc-reference`                                                              | Same broad problem of things moving out of sync, but sources differ.                                            | Co-change should remain signal; doc-reference is direct only for behavioral cited claims and support for configuration examples or intentional records. |
| Graph risk                 | `fan-in`, `fan-out`, `hotspots`, `bottlenecks`, `coupling`, `deep-chains`, `change-surface`, `affected`                              | Mostly layered views of graph pressure.                                                                         | Treat as support/context, except `cycles` and high cyclomatic complexity.                                                                               |

## Score Model Implications

The current report has `riskScore`, `hygieneScore`, evidence labels, `scoreCount`, pressure penalties, validation lift, and suppression inventory. That is close, but it does not encode action implication directly.

Recommended model:

1. Add an action tier to each finding category: `direct`, `signal`, or `support`.
2. Keep evidence quality separate: `graph-fact`, `semantic`, `heuristic`, `change-graph`, `baseline`.
3. Score direct findings with heavier base penalties because they usually imply a local repair.
4. Score signal findings with lighter base penalties and stronger pressure penalties when signals accumulate.
5. Add a "signal backlog pressure" multiplier when direct findings are near zero but contextual signals remain high. This captures the user's point: a repo with no obvious smells but many unresolved architectural signals is not actually clean.
6. Let suppression history and `self-audit` validation adjust detector trust. A detector with many suppressions or low validation lift should score less until recalibrated.

Suggested initial tier map:

- Direct: `cleanup-plan`, `dead-code`, `isolated`, `real cycles`, `unused-params`, `new-dead`, `incomplete-migration`, behavioral/current `doc-reference` claims, broken `doc-drift` references, `redundant-reexports` with zero consumers, direct passthrough rows with no boundary or public-facade role, `unused-import` drift, high branch/cyclomatic `complexity`, large React/Vue pressure.
- Signal: `co-change`, `co-change-partner`, ordinary `similar`, `similar-files`, `similar-chains`, `similar-signatures`, `convergence`, `extract-candidates`, `locality-candidates`, `wrapper-candidates`, `passthrough-candidates` with boundary or public-facade roles, single-consumer `stale-abstractions`, React/Vue duplicate or behavior candidates, bottlenecks, hotspots, coupling, deep chains, inferred layer or pattern drift, doc staleness from churn.
- Support: navigation commands, `affected`, `change-surface`, `plan-context`, `stats`, `self-audit`, suppression inventory, baseline comparison mechanics, configuration-example and intentional-record `doc-reference` rows.

## Directory Locality Analyzer

`locality-candidates` now evaluates extraction locality after a large component/view or helper extraction. The referents are directories, feature folders, local shared folders, global shared folders, import distances, consumer sets, and abstraction ownership. The analyzer classifies where an extracted unit may belong by comparing actual consumers and directory boundaries.

Command shape:

- `scip-query locality-candidates [symbol-or-file]`
- Inputs: extracted or candidate symbol/file, consumer files, nearest common ancestor, feature/domain folders, existing shared folders, import path depth, package/workspace boundaries, and whether consumers cross feature boundaries.
- Outputs: recommended locality level such as same file, sibling folder, feature-local shared folder, app-level shared folder, package-level shared module, or no extraction.
- Action tier: contextual signal. It guides placement; it should not force moves without architecture judgment.

This should pair with `react-large-component-pressure`, `vue-large-view-pressure`, `extract-candidates`, and `incomplete-migration` so agents do not reduce size scores by dumping extracted pieces into flat local directories.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the command and diff-gate guide references above. `src/runtime/commands/query-command-specs.ts` still owns the public query order, now also exporting `orderedQueryCommandDescriptors` so CLI registration can derive from that order. `src/queries/impact/diff-gate.ts` still owns `DIFF_GATE_CHECKS`; the slice only centralized finding emission through a local recorder and did not change the listed check family.

## 2026-06-28 Diff-Gate Echo Follow-Up

The diff-gate implementation still owns `DIFF_GATE_CHECKS` and the default
diff-scoped check family in `src/queries/impact/diff-gate.ts`. The
hyper-optimization follow-up only adds a callable-symbol prefilter before the
echo check invokes similarity, so the command surface and check inventory
described above are unchanged.

## 2026-06-28 Health Drift Performance Follow-Up

The `src/queries/health/health.ts` citation remains accurate. The
hyper-optimization follow-up only skips advisory drift `pattern-deviation` rows
for health and baseline paths that already hide those rows; health scoring,
phase inventory, and public `drift` output are unchanged.

## 2026-06-28 Diff-Gate Co-Change Follow-Up

The `src/queries/impact/diff-gate.ts` citation remains accurate. Diff-gate
still owns `DIFF_GATE_CHECKS`; the co-change partner check now compares against
the raw git changed-path set so changed docs and config files count as present
even when they are not indexed code files.

## 2026-06-28 Focused Co-Change History Follow-Up

The `src/queries/impact/diff-gate.ts` citation remains accurate after the
focused co-change history optimization. Diff-gate still owns the check list and
co-change partner gate; the latest change only narrows the git-history read for
that gate to commits in the bounded analysis window that touched changed files.

## 2026-06-30 Git Evidence Product Follow-Up

The `src/queries/health/health.ts` and `src/queries/impact/diff-gate.ts`
citations remain accurate after the Git evidence product migration. Health
still owns the composite phase inventory, and diff-gate still owns
`DIFF_GATE_CHECKS`; both now obtain Git history facts through
`gitEvidenceProduct()` instead of direct helper reads.

## 2026-06-30 Health Cleanup Follow-Up

The `src/queries/public-query-entries.ts` reference remains the public query
manifest reference. Private query-helper coverage is now asserted as a
CLI-contract test fixture in `tests/runtime/cli-contract.test.ts`, so the
production manifest only exports the public entries and source paths used by
packaging.

2026-07-01 round-2 remediation note: the `src/queries/health/health.ts`
guide reference remains current after the health output gained explicit
validation-basis and source-facts disclosure fields. The analyzer inventory
still points readers at the health command implementation that owns score
phases, suppressions, and validation reporting.

## 2026-07-01 Remediation Plan 3 Follow-Up

The `src/queries/impact/diff-gate.ts` and `src/queries/health/health.ts`
citations remain accurate after remediation plan 3 (detection primitives).
`DIFF_GATE_CHECKS` gained `twin-partner` (advisory — a same-(near-)name twin
left behind by a one-sided edit) and `coverage-contract` (enumeration-rot:
a configured `coverageContracts` key set drifted from its ground-truth
source). `HEALTH_PHASES` gained `coverage-contracts`. Both files still own
their respective canonical lists; only the list contents grew.

## 2026-07-02 Queued Enhancements Follow-Up

The `src/queries/health/health.ts`, `src/queries/public-query-entries.ts`,
and `src/runtime/commands/query-command-specs.ts` citations remain accurate
after the queued-enhancements batch (Q1/Q4). `HEALTH_PHASES` gained
`twin-drift` (divergent/identical same-name twin groups as a hygiene
dimension), and the public command surface gained `twin-ab` (behavioral A/B
scaffold generator for scip-integrity-audit drill 5) in `queryCommandOrder`
and `PUBLIC_QUERY_ENTRIES`. All three files still own their respective
canonical lists; only the list contents grew.

## 2026-07-03 Integrity Detectors

The public command surface gained three integrity detectors (calibrated
against Vega_2.0 and Stable_Management before wiring — see
`docs/validation/2026-07-03-integrity-detector-calibration.md`):
`not-implemented` (placeholder stubs reachable from production entry
surfaces; mechanizes scip-integrity-audit drill 3's fallback autopsy),
`decorative-checkers` (checker-named callables with no reachable failure
exit; mechanizes drill 1), and `test-quality` (assertion-free tests,
aged skips, mock-echo). All three are standalone commands only — none are
wired into `HEALTH_PHASES` or `DIFF_GATE_CHECKS` per the calibration's
wiring decisions (test-quality's health eligibility is ledgered as a
followup). Registration files (`queryCommandOrder`,
`PUBLIC_QUERY_ENTRIES`, `query-command-specs.ts`) still own their
canonical lists; only the list contents grew.

## 2026-07-08 Rust Semantic Parity Follow-Up

The `src/queries/health/health.ts` citation remains accurate after the Rust
semantic parity slice. Health still owns the composite phase inventory and
score model, and it now threads semantic enrichment through the health budget:
full/default health enables semantic facts, while bounded large-index health
can explicitly disable them.
