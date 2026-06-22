# Analyzer Validation Protocol

This document answers the part of the analyzer review that the inventory does not: how to test whether each analyzer is right across real codebases, how to label false positives and false negatives, and how to turn those labels into programmatic precision work.

The companion inventory is `docs/analyzer-inventory.md`. The running work tracker is `docs/analyzer-validation-ledger.md`. The companion placement design is `docs/locality-analyzer-design.md`.

## Core Concepts

A validation corpus is a deliberately chosen set of real repositories, revisions, and stack shapes used to test analyzer claims against maintained code. It is not just a pile of projects; its essential job is to expose each analyzer to the kinds of source layouts, framework idioms, build boundaries, and historical changes that determine whether the analyzer's claim would matter to a maintainer.

An analyzer verdict is a human-reviewed classification of one analyzer output or one known missed case. It ties the tool's structured claim back to source files, references, git history, and product structure so the claim can be counted as true, false, accepted-by-design, or still undecidable.

A true positive is an analyzer claim where the reported code location really does have the maintenance problem the analyzer names, and the next reasonable maintainer action matches the analyzer's suggested direction.

A false positive is an analyzer claim where the reported evidence exists but the inspected code shows that no repair is warranted. The usual cause is that the analyzer noticed a real structural pattern but missed ownership, framework convention, product meaning, or intentional API design.

A false negative is an existing maintenance problem that the analyzer's stated scope should have reported but did not. It matters more than an empty report because it shows a missing detector feature, missing language support, skipped source unit, or threshold that is too narrow.

An accepted design is a reported pattern that is real but intentionally kept. It should not be counted as a bug in the codebase; it is feedback that the analyzer needs either suppression support, a lower score weight, or a better explanation field.

Programmatic precision work is a code change to the analyzer, its evidence model, or its score model that makes future reports closer to maintainer judgment without hard-coding one repository. It is different from tuning a threshold until one known example disappears.

## Validation Corpus

The first corpus should use local repositories that are already available and large enough to stress the current analyzer families.

| Repository                                              | Stack shape                                                          | Source evidence seen locally         | Analyzer coverage                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/Users/aydansalois/Documents/GitHub/scip-query`        | TypeScript CLI and analysis library                                  | 290 `.ts`, 103 `.md`                 | Core graph, cleanup, health, docs, diff gate, score behavior                             |
| `/Users/aydansalois/Documents/GitHub/Stable_Management` | npm workspaces with Vue frontend, TypeScript backend, shared package | 1,168 `.ts`, 409 `.vue`, 380 `.md`   | Vue analyzers, co-change, cross-workspace coupling, docs, large-index budget             |
| `/Users/aydansalois/Documents/GitHub/Vega_2.0`          | TypeScript monorepo with React web app, API app, shared packages     | 1,567 `.ts`, 672 `.tsx`, 1,163 `.md` | React analyzers, monorepo locality, diff gate, shared-package coupling                   |
| `/Users/aydansalois/Documents/GitHub/SynthRunnerRust`   | Rust project                                                         | 27 `.rs`, 36 `.md`                   | SCIP graph smoke coverage, non-TypeScript command behavior, docs and git-history signals |

The current best field-test evidence is Stable_Management. A previous run found 1,167 indexed files, 93k symbols, 491 commits analyzed, useful co-change clusters, a bounded `health` score of 91, and 155 baseline findings. It also reported an honest negative: candidate-style findings did not currently predict fix commits well, with validation ratios of 0.6x on Stable_Management and 0.36x on scip-query.

That negative is part of the protocol. It means candidate analyzers can be useful without being predictive enough to deserve the same score weight as direct repair analyzers.

## Run Protocol

For each repository, record the exact revision first.

```sh
git -C /path/to/repo rev-parse HEAD
```

Then index and capture the broad report.

```sh
cd /path/to/repo
scip-query reindex
scip-query health --full --json > /tmp/scip-query-validation/REPO/health.json
scip-query diff-gate --json > /tmp/scip-query-validation/REPO/diff-gate.json
```

For each analyzer under review, capture three samples when possible.

| Sample               | What to inspect                                        | Why it exists                                                   |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Top findings         | 10 highest-ranked findings                             | Tests whether ranking puts obvious work first                   |
| Threshold edge       | 5 findings near the default threshold or last page     | Tests whether cutoffs are calibrated                            |
| Expected-miss probes | 5 known cases from code search, history, or user notes | Tests false negatives instead of only checking emitted findings |

Every sampled finding should be reviewed with the same evidence bundle:

```sh
scip-query plan-context <symbol-or-file> --full --json
scip-query refs <symbol> --json
scip-query code <symbol> --json
git log --oneline -- <file>
```

For file-level or history-level analyzers, substitute the file tools:

```sh
scip-query change-surface <file> --full --json
scip-query imports <file> --json
scip-query deps <file> --json
scip-query rdeps <file> --json
scip-query co-change <file> --full --json
```

The validation record should be small enough to write for every sampled result.

```json
{
  "repo": "Stable_Management",
  "revision": "COMMIT",
  "command": "vue-composable-candidates",
  "findingId": "stable identifier or pasted summary",
  "location": "frontend/src/views/Example.vue",
  "verdict": "tp | fp | accepted_design | needs_judgment | fn",
  "actionTier": "direct | signal | support",
  "evidence": ["source/reference/history facts that make the verdict reproducible"],
  "counterevidence": ["facts that weaken the analyzer claim"],
  "precisionWork": "threshold, parser, evidence field, skip rule, score weight, wording, or none"
}
```

Do not accept a precision change unless it survives at least one second repository or one focused fixture. That is the guard against fitting the analyzer to whichever repo annoyed us today.

## Analyzer Matrix

| Analyzer or family                                                                | True-positive standard                                                                                                                                                                                                                                                   | Likely false positives                                                                                                                                                                                                                   | False-negative probes                                                                                   | Programmatic precision work                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanup-plan`                                                                    | The batch deletes graph-unreferenced production code and `--verify` keeps the checker green.                                                                                                                                                                             | Entry points, reflection, generated exports, CLI/plugin surfaces, unrecognized framework-discovered files.                                                                                                                               | Search for manually deleted dead code in recent history and compare with prior report.                  | Better root-surface detection, package export reading, framework-discovered route/page exports, and verification summaries are implemented; generated/reflection root coverage remains a future caveat.                                                                                        |
| `dead`, `new-dead`, `isolated`                                                    | The symbol has no real production consumers and is not an entry surface.                                                                                                                                                                                                 | File-private helpers, test-only helpers, exported APIs consumed outside the index, generated or reflection entry points.                                                                                                                 | Known orphan functions found by `rg`, deleted symbols in git history, test fixtures with dynamic usage. | Separate "dead" from "file-internal", package/export metadata, and framework-discovered route/page roots are implemented; generated/reflection roots and external consumer evidence remain future caveats.                                                                                     |
| `unused-params`                                                                   | A trailing simple parameter is unused in all relevant implementations and can be removed without API breakage.                                                                                                                                                           | Interface conformance, callback arity, overload compatibility, framework signatures, future public API shape.                                                                                                                            | Search for underscore-less trailing params in changed files and compare with command output.            | Type-aware override/interface checks, callback convention allowlists, public API guards.                                                                                                                                                                                                       |
| `unused-imports`, `drift` unused-import findings                                  | The imported binding is never referenced in the file's executable or type surface.                                                                                                                                                                                       | Type-only imports hidden by parser limits, macro usage, framework compiler usage, generated symbols.                                                                                                                                     | Compare against TypeScript/ESLint unused import diagnostics where available.                            | Compiler-oracle comparison, macro/framework allowlists, unused-import evidence in output.                                                                                                                                                                                                      |
| `redundant-reexports`                                                             | A private barrel re-export has zero barrel consumers, zero direct consumers, and emits `actionTier: "direct"`.                                                                                                                                                           | Public package API, external consumers outside the repo, documentation examples, generated SDK boundaries.                                                                                                                               | Inspect barrels with no internal imports and compare against package exports/docs.                      | Package `exports`, directory index entrypoints, nested package manifests, action tier, surface evidence, and recommendations are now emitted; generated-surface caveats remain future precision work.                                                                                          |
| `passthrough-candidates`                                                          | The function only forwards arguments to one callee, adds no stable name, policy, boundary, public-facade role, or adaptation, and the emitted `actionTier` is `direct`.                                                                                                  | Domain vocabulary wrappers, API adapters, test seams, telemetry/auth wrappers, public facade names, package-public exports, service/provider boundaries, capability modules, access-policy forwarding.                                   | Search for tiny wrappers around known callees that command misses.                                      | Action tier, runtime-boundary evidence, separate public-facade evidence, recommendation, and health score discount are now emitted; clean Vega second-corpus confirmation kept signal/direct counts stable.                                                                                    |
| `wrapper-candidates`                                                              | A small one-consumer wrapper adds no useful concept and can be inlined.                                                                                                                                                                                                  | Boundary naming, dependency inversion, future API shape, test isolation, schema/contract modules.                                                                                                                                        | Inspect one-consumer helpers in high-churn files.                                                       | Consumer-kind evidence, caller fan-in smoothing, naming/domain hints, suppression-informed weight reduction.                                                                                                                                                                                   |
| `stale-abstractions`                                                              | A type/class/helper has zero consumers or one accidental consumer and no boundary role, and the emitted staleness kind/action tier correctly separates unused cleanup from one-consumer ownership review.                                                                | Contract types, generated schema types, nominal domain names, low-consumer but intentionally public API.                                                                                                                                 | Search for old low-consumer files, compare with command and suppressions.                               | Action tier, staleness kind, and recommendation are now emitted; one-consumer rows stay contextual/support in score calibration unless stronger public-surface evidence changes the claim.                                                                                                     |
| `similar`, `similar-files`, `similar-chains`, `similar-signatures`, `convergence` | Two units share enough behavior or dependency shape that unification would reduce real duplication.                                                                                                                                                                      | Coincidental same framework plumbing, shared type shape but different concepts, generated code, parallel product flows, or cross-language structural overlap without recognized semantic tokens.                                         | Manually inspect known copy-paste pairs, recent duplicated commits, and repeated command handlers.      | Domain-token reporting, framework-token downweighting, neutral `structural-overlap` evidence, changed-code directionality, grouped evidence rather than scalar similarity alone.                                                                                                               |
| `recent-duplicates`, diff-gate `echo`                                             | New or recently changed code re-implements older code with the same behavior.                                                                                                                                                                                            | Boilerplate repeated by framework convention, tests, intentionally forked product variants.                                                                                                                                              | Scan recent commits for "copy", "duplicate", "refactor", or similar edits not reported.                 | Root-cause groups now separate review items from pairwise evidence; age windows, test/generated filters, behavior-token evidence, and established-owner links remain future precision candidates.                                                                                              |
| `extract-candidates`                                                              | A large callable contains a cohesive callee cluster, and the emitted extraction kind/recommendation correctly frames it as workflow orchestration, a broad helper cluster, or a cohesive helper cluster.                                                                 | Incidental call clustering, readable local sequence, algorithm steps that should stay together, or helper groups without a stable concept name.                                                                                          | Inspect large functions with obvious sections and compare with report.                                  | Extraction kind, action tier, reasons, and recommendation are now emitted; locality and score calibration are recorded, while placement decisions remain report-only through the locality workflow.                                                                                            |
| `incomplete-migration`                                                            | A new helper is used at some matching sites while other equivalent sites still contain the old inline pattern, and the old site passes both helper-containment and site-coverage checks.                                                                                 | Intentional partial rollout, tests documenting old behavior, helper only valid for one subtype, or broad orchestration sites where the helper pattern is only a small fragment.                                                          | Search diffs with new helpers and repeated old call clusters.                                           | Two-sided containment, helper shape, site coverage, broad-site regression coverage, migration-scope hints, and second-corpus same-scope validation are now recorded.                                                                                                                           |
| `react-component-duplicates`, `vue-component-duplicates`                          | Two components repeat substantial render structure where a component extraction would preserve product meaning.                                                                                                                                                          | Design-system repetition, route-specific layouts, data-table boilerplate, static labels inflating similarity.                                                                                                                            | Inspect similar screenshots/templates not reported, especially after large component splits.            | Framework-token downweighting, static text handling, shared component/import evidence, route/domain context.                                                                                                                                                                                   |
| `react-hook-candidates`, `vue-composable-candidates`                              | Components repeat state, effects, lifecycle, request, or handler behavior that can live in a hook/composable, and the row's evidence class points to domain or mixed behavior rather than only generic workflow.                                                         | Generic useState/useEffect/useQuery plumbing, unrelated screens using the same framework primitives, or existing shared abstractions that already own the workflow.                                                                      | Search for repeated custom hook/composable calls and copied handler names.                              | Evidence class and action tier are now emitted; field validation and score calibration are recorded, and new non-empty corpora can extend calibration later.                                                                                                                                   |
| `react-large-component-pressure`, `vue-large-view-pressure`                       | A component/view is large enough that unrelated reasons to change are forced through one file.                                                                                                                                                                           | Generated views, story/demo files, intentionally monolithic route shells, style-heavy one-off pages.                                                                                                                                     | Search largest React/Vue files and compare with command output.                                         | Pressure-kind/context recommendations are validated; future locality recommendations remain report-only until consumer coverage improves.                                                                                                                                                      |
| `complexity`, `complexity-hotspots`                                               | A symbol or file has enough branching, LOC, fan-in, or fan-out that local reasoning and change risk are objectively high.                                                                                                                                                | Central orchestration code, parsers, reducers, generated code, tables expressed as code.                                                                                                                                                 | Compare against high-branch files from code search and known bug-fix hotspots.                          | Keep cyclomatic and graph-pressure scores separate, report branch evidence, combine with churn/fix density.                                                                                                                                                                                    |
| `cycles`                                                                          | A real dependency cycle crosses source files in a way that makes layering or change order harder.                                                                                                                                                                        | Barrel cycles, test cycles, module-hierarchy cycles, framework registration loops.                                                                                                                                                       | Compare file dependency SCCs with `deps`/`rdeps`, seed fixture cycles.                                  | Keep existing cycle-kind split, score only real cycles, improve barrel/test classification.                                                                                                                                                                                                    |
| `co-change`, diff-gate `co-change-partner`                                        | Files repeatedly change together without a dependency edge, showing hidden coordination work; partner class, commit scope, recency, and commit-subject context now distinguish focused current pairs from broad, stale, unlabeled, fix-labeled, or docs-labeled history. | Same feature touched by broad commits, stale coupling that history no longer predicts, local commit subjects that do not reflect true tracker labels, or a partner class that is real but does not imply this diff needs the other side. | Inspect known schema/client, env/config, doc/code pairs and changed partner misses.                     | Partner-class evidence, declared-coupling suggestions, broad-sweep context, recency context, local subject labels, issue refs, external-label-unavailable status, and health score weighting are now emitted; continue only with future metadata-provider validation for true issue/PR labels. |
| `doc-drift`, diff-gate `doc-reference`                                            | A doc cites code that moved, broke, or kept changing after the doc claim stopped changing, and the cited claim or doc intent indicates whether this is current guidance, support evidence, or a broken reference.                                                        | Exploratory docs, historical notes, configuration examples, docs intentionally describing old behavior.                                                                                                                                  | Search docs with path references and compare broken/stale outputs.                                      | Cited-claim metadata, citation-kind output, co-change-only historical-note intent, Markdown-local citation parsing, and second-corpus parser validation are now recorded.                                                                                                                      |
| `drift` layer and pattern findings                                                | Imports violate an explicit or strongly inferred local architecture rule, and the row's action tier correctly separates explicit policy from inferred signal.                                                                                                            | Inferred rules from too few siblings, migration states, intentionally exceptional bridge files.                                                                                                                                          | Inspect known layer boundaries and sibling directories with unique imports.                             | Action tier, policy basis, evidence reasons, and recommendation are now emitted; inferred drift stays low-score/support unless stronger sibling support is available.                                                                                                                          |
| `hotspots`, `fan-in`, `fan-out`, `coupling`, `bottlenecks`, `deep-chains`         | The graph facts correctly identify centrality, dependency breadth, shared symbols, hubs, or long chains, while output frames them as contextual signal or support rather than direct repair.                                                                             | These are not smells by themselves; false positives are mostly product mistakes when score treats them as repair demands.                                                                                                                | Compare with raw SCIP graph and known central modules.                                                  | Bottlenecks, coupling, and deep chains now emit action-tier metadata; deep chains de-duplicate strict suffix rows. Keep graph risk contextual except when combined with churn, cycles, or direct findings.                                                                                     |
| `affected`, `change-surface`, `plan-context`                                      | The tool names real consumers, blast radius, references, calls, history, and risks for a target.                                                                                                                                                                         | Missing index data, generated code, dynamic imports, language unsupported by current index.                                                                                                                                              | Pick symbols with known callers and compare against `rg` plus compiler refs when available.             | Index capability reporting, language-specific fallbacks, clearer "missing evidence" sections.                                                                                                                                                                                                  |
| `self-audit`                                                                      | Cheap evidence paths match the TypeScript compiler oracle on sampled symbols.                                                                                                                                                                                            | Sampling bias, non-TypeScript code, compiler config mismatch.                                                                                                                                                                            | Repeat with scopes from different packages and compare disagreement classes.                            | Stratified sampling by package/file kind, persistent disagreement fixtures.                                                                                                                                                                                                                    |
| `health`, `health-phase`, `diff-gate` composite reports                           | The composite report explains its deductions and gates new direct findings without hiding signal pressure.                                                                                                                                                               | Treating contextual signal as direct debt, score staying perfect while signal backlog grows, baseline churn from history-derived findings.                                                                                               | Compare scalar changes against reviewed finding labels and suppression counts.                          | Action-tier identities, direct/signal score separation, suppression trust adjustments, and hidden-coupling score-count correction are recorded.                                                                                                                                                |

The first TypeScript support-analysis review found accurate source-grounded output for `validateProjectConfig()` and fixed `status`/`doctor` config diagnostic parity. The Rust cross-language review confirmed that graph/source/checker-backed analyzers work on Rust, while TypeScript semantic self-audit is explicitly unavailable and frontend analyzers correctly return stack-specific empty results.

`cleanup-apply` is not an analyzer. It is an action command that should be validated through the `cleanup-plan --verify` path and normal project checks.

Navigation commands such as `stats`, `files`, `methods`, `refs`, `trace`, `deps`, `rdeps`, `system`, `surface`, `imports`, `imported-by`, `outline`, `members`, `by-kind`, `kind-counts`, `hierarchy`, `call-graph`, `code`, `dataflow`, and `slice` should be tested as evidence providers. Their success standard is referential accuracy, not whether they find a smell.

## False-Negative Search

False negatives need active hunting because normal analyzer output cannot show what it missed.

Use these probes on each corpus:

1. Search for large units:

   ```sh
   rg --files | rg '\.(ts|tsx|vue|rs)$' | xargs wc -l | sort -nr | head -30
   ```

2. Search for repeated names and local copy-paste clues:

   ```sh
   rg -n "TODO|copy|duplicate|refactor|extract|cleanup|unused|dead|stale"
   ```

3. Search history for repairs that should have been predicted:

   ```sh
   git log --oneline --grep='fix\\|bug\\|cleanup\\|refactor\\|remove\\|dead'
   ```

4. Inspect suppressions as precision labels:

   ```sh
   rg -n "scip-query: ignore-" src tests docs
   ```

5. For frontend repos, inspect large component split candidates by directory:

   ```sh
   rg --files | rg '\.(tsx|vue)$' | xargs wc -l | sort -nr | head -50
   ```

The expected result of this phase is not "all analyzers are accurate." The expected result is a ranked list of detector improvements with evidence: parser gaps first, public-surface mistakes second, framework convention mistakes third, score-weight mistakes fourth.

## Score Implications

The score model should encode reviewed action implication.

Direct findings are code or docs locations where the analyzer normally identifies a local repair. They should carry heavier deductions and should be eligible for diff-gate blocking.

Contextual signals are real patterns whose repair depends on product or architecture judgment. They should accumulate as backlog pressure, but a single signal should not be scored like dead code.

Support analyses are evidence maps. They should inform planning and other detectors, not reduce health by themselves.

Suppression counts and `self-audit` disagreement rates should modify analyzer trust. A detector with many accepted suppressions or poor compiler-oracle disagreement should still report, but its score weight should be lower until the false-positive cause is understood. Structured suppressions must keep a reason, an identity, a live expiration when temporary, and any file scope must still point at a current file.

## Residual Future Work

No active validation ledger slice remains. Future production steps should stay small and falsifiable:

1. Keep true co-change issue/PR labels blocked until a repository metadata provider is available; local commit-subject context is implemented.
2. Keep locality report-only until exact consumer coverage and repair outcomes justify score integration.
3. Keep `docs/analyzer-validation-ledger.md` current as each analyzer family receives a new implementation or corpus-confirmation result.
