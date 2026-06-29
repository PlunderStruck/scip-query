# Clojure Health Performance Roadmap

Date: 2026-06-28

## Goal

Improve Clojure support so `scip-query health` works like it does for TypeScript-sized real projects: default health remains unbounded, but the unbounded run is still fast enough to use interactively and does not regress other languages.

A health score is scip-query's repository-level report that combines graph facts, source-derived cleanup signals, git-history pressure, and accepted suppressions into an auditable risk and hygiene summary. Its real-world referents are commands such as `health`, `health --json`, setup health dossiers, and health baselines; it is a report over codebase evidence, distinguished by reducing many detector results into scored, reviewable axes without hiding the underlying evidence.

A health phase is one independently runnable part of that report, such as dead code, isolated symbols, cycles, similar functions, extraction candidates, wrappers, stale abstractions, drift, complexity hotspots, git evidence, or suppressions. Its real-world referents are the entries in `HEALTH_PHASES` and the child-process calls launched by `runIsolatedHealthReport()`; it is a unit of analysis, distinguished by being schedulable, skippable, cache-clearable, and convertible back into one composite health report.

Unbounded health is the normal health mode that does not intentionally cap candidate scans or result counts to fit a large-repo budget. Its real-world referents are the visible `health` command and `handleHealth()` passing `full: true`; it is a runtime policy, distinguished by aiming for complete detector evidence rather than a sampled estimate.

A regression is a verified loss in behavior, correctness, runtime, memory, or output quality relative to an existing baseline. Its real-world referents are slower TypeScript health runs, changed TypeScript health output, failing tests, or worse benchmark timings after Clojure work; it is a negative change, distinguished by being measured against a pre-change reference rather than inferred from discomfort.

## Current Evidence

- `runIsolatedHealthReport()` already runs health through phase tasks in child processes.
- `healthPhaseApplicability()` currently delegates to `sourceFrameworkApplicability()`.
- `shouldRunHealthPhase()` already skips React phases when React evidence is absent and Vue phases when Vue evidence is absent.
- `healthPhaseTasks()` already groups related phase sets, including React phases, Vue phases, and similar/extract phases.
- `handleHealth()` currently calls `runIsolatedHealthReport({ full: true })`, so visible health is intentionally unbounded by default.
- Logseq Clojure indexing now works as a managed language. On the updated Logseq branch, `reindex --language clojure` rebuilt in 73.3s.
- On the updated Logseq Clojure index, `cycles --json` returned `[]`.
- Clojure graph commands that worked in validation include `stats`, `status`, `code`, `refs`, `trace`, `outline`, `deps`, `affected`, `cycles`, `hotspots`, `fan-in`, `fan-out`, `coupling`, `deep-chains`, and targeted `complexity`.
- The visible `health --json` command did not complete within about 90 seconds on Logseq and was stopped.
- `isolated --json` also ran longer than about 60 seconds on Logseq and was stopped.
- `complexity-hotspots --json` completed but returned no rows, even with `--min-loc 1`, which suggests a Clojure symbol-shape or kind-mapping mismatch rather than a timeout.
- `kind-counts --json` reports Clojure definitions under odd SCIP kind names such as `EnumMember`, `StaticDataMember`, `Axiom`, `Lemma`, and `Grammar`.
- 2026-06-28 update: the slow Logseq phases were `isolated`, `similar`, `extract-candidates`, `wrapper-candidates`, and `passthrough-candidates`.
- 2026-06-28 update: TypeScript stayed fast because it enters the source-backed callsite path for callee maps; Clojure was falling back to chunk-level mention scans over 25,678 symbols, 3,272 files, and 529,896 mentions.
- 2026-06-28 update: `tree-sitter-clojure@0.4.0` fails to build on Node 22, and `@yogthos/tree-sitter-clojure@0.0.14` targets a newer Tree-sitter JavaScript runtime than scip-query's pinned `tree-sitter@0.21.1`. A full Tree-sitter Clojure grammar should be revisited as a parser-runtime upgrade, not slipped into Clojure support alone.
- 2026-06-28 update: a Clojure source form adapter now supplies callable and callsite facts for `.clj`, `.cljs`, and `.cljc`, giving Clojure the same callee-map fast lane without changing the Tree-sitter runtime for other languages.
- 2026-06-28 update: after the shared chunk-sweep optimization and Clojure source facts, Logseq `health --json` completed in 1.41s wall time with `score: 76`, `cycles: 0`, and `isolatedSymbols: 0`.
- 2026-06-28 update: Clojure kind names now come from `@c4312/scip` instead of a stale hand-coded table; Logseq `kind-counts --json` reports `Function`, `Variable`, `Class`, `Namespace`, `Macro`, and `TypeAlias` instead of incorrect names such as `EnumMember`.
- 2026-06-28 update: Logseq `complexity-hotspots --json --min-loc 1 --limit 5` now returns Clojure callables in 1.30s wall time. The detector uses source-callable evidence for Clojure so large `def`/`defonce` values do not become callable complexity hotspots just because the graph is broad.
- 2026-06-28 update: Logseq `status --json` now reports an existing fresh Clojure graph as analyzable even when `scip-clojure` is not currently runnable for refresh: indexing is `partial`, source facts and detectors are `available`, semantic provider is `unavailable`, and cleanup verification is available through `npx clj-kondo --lint .`.
- 2026-06-28 update: current scip-query TypeScript `health --json` completed in 1.79s wall time with `score: 93`, `cycles: 1`, `complexityHotspotCount: 0`, and `similarPairs: 4`.

## Working Hypothesis

TypeScript health is fast because the shared health pipeline does not blindly do the most expensive possible work for every phase and every repository shape. It uses phase isolation, phase grouping, source/framework applicability, scan-ordering inside detectors, and mature symbol/source facts.

Clojure should be made to fit that same architecture, not given a lower-quality default. The likely gap is that Clojure currently enters generic detectors with immature symbol kind data and limited source facts, causing some phases to scan too much or fail to find the same cheap pruning signals available for TypeScript.

## Non-Negotiables

- Keep visible `health` unbounded by default.
- Do not make TypeScript, JavaScript, Vue, Rust, Python, or other language health slower.
- Do not hide Clojure health phases silently. If a phase is inapplicable, the reason should be a capability/applicability fact, not a timeout disguised as success.
- Prefer language-specific applicability and data-shape fixes before shared-engine rewrites.
- Any shared optimization must have before/after timings on TypeScript and Clojure.

## Phase 1 - Measure Before Changing

- [x] Run `scip-query health --json` timing on the scip-query TypeScript repo.
- [x] Run `scip-query health --json` timing on Logseq Clojure.
- [x] Run each health phase separately on Logseq with `__health-phase` or public equivalent.
- [x] Identify which phase or grouped phase dominates Logseq runtime.
- [x] Record outputs and timings in a validation note.

## Phase 2 - Explain TypeScript's Fast Path

- [x] Trace `runIsolatedHealthReport()` and document how phases are scheduled.
- [x] Trace `sourceFrameworkApplicability()` and document why React/Vue phases are skipped or run.
- [x] Trace `dead`, `isolated`, `similarAllCount`, `extractCandidates`, `complexityHotspots`, and `drift` on TypeScript fixtures to identify their pruning assumptions.
- [x] Compare those assumptions with the Clojure SCIP rows from Logseq.

## Phase 3 - Fix Clojure Symbol Shape

- [x] Fix scip-query kind interpretation so namespaces, vars, functions, macros, protocols, records, and constants use current SCIP enum names.
- [x] Reindex Logseq and confirm `kind-counts` becomes meaningful.
- [x] Confirm `by-kind function` works for Clojure functions or document the correct kind label.
- [x] Re-run `complexity-hotspots`; investigate remaining empty output if kind mapping is not enough.

## Phase 4 - Add Clojure Applicability

Phase applicability is the rule that decides whether a health phase has enough project evidence to run meaningfully. Its real-world referents are `healthPhaseApplicability()` and `shouldRunHealthPhase()`; it is a scheduling filter, distinguished by using evidence about the current project rather than command-line preference.

- [x] Extend capability reporting beyond frontend frameworks to include language/data-shape facts.
- [x] Add Clojure-specific capability reporting for graph facts, source callsite facts, semantic provider absence, cleanup detectors, and clj-kondo cleanup verification.
- [x] Keep graph-native phases eligible for Clojure: overview, cycles, coupling-style evidence, hotspots/fan-in/fan-out-derived summaries, git evidence, and suppressions.
- [x] Ensure Clojure capability gaps report explicit reasons instead of silently hiding work.

## Phase 5 - Make Slow Clojure Phases Fast Without Bounding Default Health

- [x] Optimize `isolated` for Clojure by pushing filtering into SQL or precomputing symbol eligibility before full source/range work.
- [x] Optimize `dead`/`isolated` shared paths only if TypeScript benchmarks remain flat or improve.
- [x] Optimize `similar`/`extract` for Clojure by using cheap candidate prefilters from call graph or source fingerprints.
- [x] Make `complexity-hotspots` consume Clojure-compatible definition ranges and source-callable symbols.
- [ ] Add per-phase timing instrumentation to make future slow phases obvious.

## Phase 6 - Add Clojure Source Facts Only Where They Pay

Clojure source facts are source-derived evidence extracted from Clojure files when the SCIP graph does not directly encode the needed relationship. Their real-world referents are namespace forms, `:require` clauses, aliases, vars, `defn`, `defmacro`, protocol methods, records, and macro-shaped calls; they are source-backed code facts, distinguished by supplementing graph rows without pretending to be a full compiler.

- [ ] Parse `ns` forms and `:require` aliases for source fallback imports.
- [ ] Reuse or ingest clj-kondo analysis where it provides richer facts than text scanning.
- [x] Add tests with `.clj`, `.cljs`, and `.cljc` fixtures.
  - 2026-06-28 update: added focused `.clj`, `.cljs`, and `.cljc` source-facts fixtures plus Clojure source-backed callsite and complexity fixtures.
- [ ] Keep source facts optional so graph-native commands do not depend on a Clojure parser.

## Phase 7 - Cross-Language Guardrails

- [x] Add a benchmark ledger for TypeScript health before Clojure health changes.
- [x] Add a benchmark ledger for Logseq Clojure health before and after each optimization.
- [x] Run full tests after shared-engine changes.
- [x] Run focused Clojure fixture tests after Clojure-specific changes.
- [x] Run `scip-query reindex && scip-query diff-gate --json` before declaring completion.
  - 2026-06-28 update: reindex passed in 3.2s. `diff-gate --json` had 12 doc-reference warnings in historical analyzer/validation docs; new-dead findings were fixed by removing unused helper exports.

## Acceptance Criteria

- `health --json` on the scip-query TypeScript repo remains within its current runtime band.
- `health --json` on Logseq Clojure completes in a comparable interactive range to TypeScript-scale health runs, ideally under 60 seconds and preferably much lower.
- `cycles`, targeted `complexity`, `complexity-hotspots`, `dead`, `isolated`, and the composite health report all either return useful Clojure evidence or explicitly report that a phase is inapplicable because of a verified capability boundary.
- TypeScript health output does not regress except for intentional improvements covered by tests and validation notes.
- Logseq Clojure health output has a validation note showing phase timings, score output, and any accepted capability gaps.
