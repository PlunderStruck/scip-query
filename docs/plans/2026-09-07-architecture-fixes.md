# Architecture fixes

Status: complete. Baseline: `a21c01de`. Scope: all five findings in [the architecture audit](2026-09-07-architecture-audit.md). No agent benchmarks or deployment are required.

## Existing flow

The audit records the exact implementations and consumers. Source queries retain per-database evidence through storage cache factories; composite analyses request file or whole-project clearing through one registry. Local flow currently uses a range key where the factory assumes a file key. Reindex fingerprints inputs, chooses affected work, materializes compiler and SQLite results, validates current inputs, and publishes one immutable generation. Generic and TypeScript planners currently repeat widening rules. The CLI selects a lightweight fast parser or the canonical descriptor dispatcher; both reach existing query owners. Runtime services combine installation, query delivery, evidence output, and background refresh under one policy row.

## Comparable features and conventions

Source-aware caches already own normalized file identities and compare source content. The generic cache supplies bounded least-recently-used storage, registry membership, and per-database isolation. Keep these mechanisms. `PUBLIC_QUERY_ENTRIES` demonstrates deriving representations from one lightweight definition, while command descriptors own defaults and parser behavior. Preserve fast startup and server/client separation. Architecture already supports exact file membership and explicit closed dependency rows; no new rule engine is needed. The recent stateful indexer fixtures compare real incremental results with clean compiler results and exercise publication failures.

## Reuse and ownership decisions

1. Cache storage will distinguish file keys from arbitrary keys. Add a file-keyed factory using the existing bounded storage, normalize paths there, and migrate actual path-keyed consumers. Arbitrary-key caches conservatively clear all entries for a file notification rather than cast a path into an unrelated key. Local-flow ranges retain their existing global entry bound; clearing unrelated ranges is an explicit conservative tradeoff, not unbounded nested maps or caller-owned key parsing.
2. The affected-set module will own shared safety reasons. TypeScript will refine explicitly supported cases and add its compiler/workspace constraints, with graph acquisition and emission using the same decision. Remove obsolete partial-addition handling. Preserve deletion closure, semantic edit filtering, and publication behavior.
3. One lightweight metadata owner will supply fast command eligibility and shared defaults/option policy. Both dispatch routes consume it without importing query implementations into the startup path. Remove stale routing entries and verify accepted fast forms against canonical parsing.
4. Partition runtime policy by observed responsibilities and justified directions. Resolve genuine cycles by correcting ownership; do not widen rows or thresholds to hide them. Add negative dependency-policy checks for prohibited directions and verify current source coverage.
5. Replace the current architecture guide with present ownership/directions. Preserve historical decisions in a dated archive and link them as history.

## Work and validation

- [x] A1: Permanent real local-flow regression; file/opaque cache contract; sibling migration and cache tests. Three real regressions failed before the fix and all pass now. Sixteen path-owned caches migrated; 10 focused tests pass. Source-aware caches also normalize separators. Arbitrary-key file invalidation now clears conservatively without an unsafe cast.
- [x] A2: Shared incremental safety decision; old path removal; decision tests and real compiler histories pass, including the unchanged-document replacement regression.
- [x] A3: Shared defaults/integer policy; startup allowlist removed; 35 canonical/fast contract tests plus existing output and fallback tests pass.
- [x] A4: Nine runtime responsibilities, property-verification ownership, negative policy tests, and complete clean indexed/source reports. Import coverage defects and index-only compatibility cases are repaired and tested.
- [x] A5: Current guide, byte-preserved historical archive, and all current link/owner checks pass.
- [x] Final build, type checks, lint, API contract, 3,416 tests across 392 files, current-source review, and fresh diff impact.
- [x] Reconciled findings, recorded outcomes and coverage limits, verified the guide/archive, and reviewed the final diff.

Production fixes are authorized. Keep all changes on `main` and preserve unrelated untracked benchmark documentation. Do not change complexity thresholds, add suppressions to clear reports, or merge distinct protocols merely to reduce file counts.

## Implementation discoveries and decisions

- A2 now computes one TypeScript change decision for graph preparation and emission, using shared affected-set widening rules with an explicit deletion-closure refinement. Removed partial-addition handling. Existing 54 planning tests pass. A strengthened large-delta case found another real defect: forcing `mode: full-project` could retain a partial affected-file list. The shared full-project constructor now includes unchanged documents. This regression fails on the baseline and passes on the fix; `/tmp/scip-query-a2-before.log` records it. Real history checks remain for final validation.
- A3 uses a simpler design than another metadata registry: remove the startup allowlist entirely. Startup checks output shape; the existing parser map alone decides command eligibility. Unsupported compact forms fall through after loading that adapter. Shared CLI defaults and exact integer grammar live in one lightweight policy module. Canonical descriptors still own complete option grammar; the fast parser intentionally accepts a subset, checked against actual descriptor registration.
- A3 verification: 35 new canonical-versus-fast parsing cases pass across all 21 current fast commands; 102 existing parser/output checks also pass. The initial new table-driven tests incorrectly unpacked arrays into separate arguments; corrected the fixture, with no product change made to accommodate it.

## Runtime directions selected for A4

The complete source import table for the old service boundary is recorded at `/tmp/scip-query-runtime-boundary-audit.json`. All 48 previous members and the new invocation-policy file have an explicit proposed owner. Internal dependency directions form the following responsibilities:

| Owner | Responsibility and permitted runtime knowledge |
| --- | --- |
| `runtime-contracts` | Command roles, envelope shapes, cursor encoding, invocation defaults, generated command metadata; depends only on domain contracts |
| `runtime-output` | Formatting, source emission and pagination; may use runtime contracts |
| `runtime-project` | Configuration, revisioned updates, project context and index freshness; no dependency on installation, command handlers, or servers |
| `runtime-analysis` | Query preparation, capability reporting, budgets, evidence receipts and analysis caches; may use project context and output |
| `runtime-watch-control` | Background-service identity, startup/control and pruning; no dependency on query execution or installation |
| `runtime-index-maintenance` | Index refresh/freshness coordination and repository cache collection; may use analysis, project context and watch control |
| `runtime-background` | Watch loop and compiler-worker execution; may use index maintenance, project context and watch control |
| `runtime-query-service` | Query transport, server execution and the fast CLI adapter; may use analysis, contracts, output, project context and watch control |
| `runtime-installation` | Skill/tool installation, onboarding and removal; may compose analysis/readiness, contracts, project context and watch control |

All groups retain only the existing lower-layer dependencies required by their observed operations. Command entrypoints remain composition owners. Query execution must not import installation, and project/configuration or pure contracts must not import delivery workflows. File subunits will expose internal cycles in these flat groups. This changes enforcement without creating a second service layer or moving implementations just to match folder names.

## Combined validation in progress

- Type checks, complete lint (including build, public API contract and skill links), and final diff whitespace checks pass. Public TypeScript API remains `b74137d6c422ca9c` across 66 paths.
- Six repository-policy tests reject query-to-installation, configuration-to-server and contracts-to-configuration imports, allow intended composition, and expose same-directory cycles in runtime-project and reindex.
- Moved the real generation/cursor crossing into an integration test; shared SQLite fixtures preserve all publication checks and clean temporary roots. All 65 affected-set, publication and integration tests pass.
- Current-source review covers 569/569 eligible TS/JS files and 13,570 functions with zero findings, zero missing/ambiguous imports, and all 55 policy rows declared. One computed benchmark import remains explicitly unresolved; CRAP is unavailable without source-matched coverage.
- Living guide replaced and previous guide archived with an explicit snapshot marker. All guide links and explicit boundary names match current files/configuration.
- Full suite running against the rebuilt bundle. Initial reindex correctly refused an unavailable incremental service and retained the accepted index. Started the checkout watch service explicitly and retried; fresh indexed verification remains pending.

### A4 verification discoveries

The first combined suite passed 3,409 tests across 391 files. Fresh indexing exposed two additional gaps: literal dynamic imports are absent from the indexed architecture graph, producing two false unused-allowance findings, and automatic workspace indexing now includes 18 property-test files without a policy owner. Keep real allowances. Reuse the existing compiler-backed maintenance import extractor to supplement indexed TS/JS dependencies, sharing source binding/parsing with complexity analysis rather than writing another syntax detector. Give the property-verification harness an explicit test responsibility and justified observed dependencies. Re-run architecture, affected tests and combined checks after these repairs.

- A4 import regression: three real source/database fixtures failed before the repair for aliased literal dynamic import, CommonJS require, and import-type expressions. All now pass. Added shadowed-require and nonliteral-import controls; unresolved targets withhold unused-allowance claims for their owner and remain printed coverage limitations. Architecture supplements an owned copy of the cached graph, preserving navigation consumers. Source parsing/local binding is shared with complexity analysis; no new import-syntax detector was added.
- `property-verification` now owns the automatically indexed generated-test harness. Its twelve permitted targets are the actual APIs under invariant checks (analysis, domain, filesystem, platform, health queries, reindex, background/output/query/watch runtime, source and storage); production rows gain no dependency on test code. Total policy rows: 56.

- The source boundary ceiling remains 67. Consolidated the small parsing and indexed-import helpers into their existing source-analysis/import owners, keeping one local-binding constructor and one compiler-backed import detector without growing the source module inventory. Final verification follows this consolidation.

- The second full suite exposed nine source-availability compatibility failures in three existing index-only health/drift suites. The import supplement now retains indexed evidence when current source/configuration/syntax is unavailable, discloses the affected files, and withholds unsupported unused-allowance claims. All twenty tests in those three suites plus the new import suite pass after the correction. The full suite is being rerun against the final rebuilt code.

## Final structural evidence

The rebuilt final source review reports 569/569 eligible TS/JS files and 13,581 functions, accounted coverage, zero findings and zero blocking findings. The refreshed indexed architecture graph maps 582/582 files under 56 closed policy rows, with zero unmapped/ambiguous ownership, forbidden production/test edges, mirrored-test violations, boundary/internal cycles, stale allowances or size/fan-out violations. All original thresholds remain intact. The source boundary remains 67 files.

Fresh diff impact attributes 52 changed symbols in 24 indexed changed files and reports 55 affected consumer files. Its 15 omitted paths are explicitly listed test/document/configuration paths, including the unrelated untracked benchmark document; current-source review and tests cover the relevant changed source. The target guide links and named owners are valid, and its archived predecessor retains the original bytes exactly after the snapshot notice.

Limits: the source inventory covers eligible TS/JS, while the indexed inventory includes other supported languages and selected tests. The indexed import supplement cannot resolve published-package API fixture imports within its captured source universe (the separate published API compilation passes) and excludes shared test helpers outside the indexed file set; these are explicit coverage gaps, and these do not establish unused allowances. The source scan retains its one unresolved computed benchmark import and unavailable source-matched CRAP coverage. Architecture now reads/binds indexed TS/JS sources to close the observed import gaps; it does not load a whole project compiler graph or claim a measured performance improvement. Local-flow file clearing conservatively clears all range entries for that database. The audit remains structural coverage plus selected behavioral verification, not proof of every possible program state or provider behavior.

The temporary checkout watch service used for refresh was stopped after the final graph reports. No VM deployment or agent benchmark was performed.

## Final validation

All five audit findings are implemented. The final unchanged code passed **3,416 tests in 392 files** (`npm test`, 252.85 seconds). This includes all 19 indexing property/history/interruption tests, as well as the cache, CLI parsing, architecture, health and drift consumers. The final build, lint, type checks, API surface and public consumer compilation passed. Public API identity remains `b74137d6c422ca9c` across 66 paths. `git diff --check` passes.

[Machine-readable result summary](2026-09-07-architecture-fix-results.json) records the final counts and limitations. Full local artifacts are `/tmp/scip-query-architecture-tests.log`, `/tmp/scip-query-architecture-lint.log`, `/tmp/scip-query-architecture-typecheck.log`, `/tmp/scip-query-architecture-final-review.json`, `/tmp/scip-query-architecture-final-indexed.json`, and `/tmp/scip-query-architecture-final-impact.json`.

No audit findings remain open. No thresholds were increased and no finding suppressions were added. Changes remain in the working tree on `main`; no commit, push, VM deployment or agent benchmark was part of this repair run. The unrelated untracked LaunchPoint benchmark document was preserved.
