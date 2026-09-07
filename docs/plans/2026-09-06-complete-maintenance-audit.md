# Complete maintenance and accuracy audit

User request: work through the remaining codebase issues until all are taken care of. This is an ongoing implementation task, not a recommendation-only review.

Baseline: `7ced461d`. Current-source scan accounts for all 561 eligible TS/JS files, 12,182 functions, 649 complexity findings and six duplication candidates. The accompanying `2026-09-06-maintenance-inventory.json` records every initial finding. Each must end fixed, retained with concrete behavioral justification, or unresolved with the missing evidence recorded. A warning disappearing is not itself proof of a fix.

## Working rules

- Use scip-query to locate relationships and read exact source; preserve externally visible decisions, evidence strength/coverage, errors, ordering, state identity, cancellation and cleanup.
- Do not lower thresholds, add suppressions, relax architecture rules, or mechanically extract callbacks to make metrics disappear.
- Refactor only around real responsibilities and repeated knowledge. Remove unnecessary implementations and update all live consumers.
- Keep unrelated `docs/benchmarks/2026-09-06-launchpoint-backend-validation.md` untracked and untouched.
- Work directly on main. Commit/push validated batches under the existing authorization. Never rebuild dist while CLI integration tests are running.

## Ordered work

1. Graph correctness and structure: `focusedConnectorSlice`, `expandSourceConstructCallFrontier`, `expandSystemMapSymbolFrontier`. Establish edge eligibility, seed treatment, path ordering, disconnected participants, scope/depth bounds, evidence labels, omitted evidence and existing tests before refactoring.
2. Assess all six duplicate groups; consolidate shared decisions only where the contracts agree.
3. Setup and watcher lifecycle: `runProjectSetup`, `validReindexActivitySummary`, and `renderWatchServiceReport`. Preserve resource ownership, readiness, recovery and printed actionable facts.
4. Work through the remaining inventory by responsibility/module, recording every assessment and meaningful verification. Review modules without findings and cross-module ownership as well as numerical hotspots.
5. Refresh index and audit command/skill contracts. Test real data-flow/slice behavior, coverage/recovery, first-use scanning, incremental updates, diff review, configured architecture, and false-positive/false-negative cases. Remove unsupported promises or redundant mechanisms when justified.
6. Evaluate on a real second repository (LaunchPoint backend, using the established dev-agent access), and assess agent usefulness with the previously requested cheaper-model configuration when the tool and fixtures are ready.
7. Run appropriate focused checks per batch, final complete tests/build/typecheck/lint/API/consumer/skill checks, current-source review, qualified impact analysis and structural rules. Record limitations honestly; do not equate passing tests or configured rules with complete conceptual correctness.

## Current work

Graph batch started. No implementation changes yet beyond this durable inventory/plan. The first four selected refactors and their 3,000 passing tests are documented separately in `2026-09-06-core-maintainability-refactors.md`.

### Graph batch findings and progress

- Confirmed accuracy defect: reverse member traversal promoted ambiguous service implementations to derived evidence at depth one; expanding farther replaced that label with candidate evidence. A real two-provider fixture failed (`derived` versus expected `candidate`) before the fix and passes afterward. Both traversal directions now use the same `memberCallEvidence` owner; tests cover depths one and two.
- Source and symbol frontier coordination has been separated from local/member caller discovery, reference attribution, bounded caller selection and structural callee validation. Existing graph suite (59 tests at that point) passes. Shared reference facts now avoid duplicate caller classification and symbol resolution.
- Confirmed source-selection risk: connected behavior used line regexes to identify declarations and uses. Replacing this with compiler binding identities in `maintenance-bindings.ts`, including typed/multiline/destructured declarations, shadowing, shorthand values, and string/comment/property-name counterexamples. Unit tests pass; live connector regression and full graph checks are in progress. Unsupported languages or parse errors retain complete source/outline rather than a guessed binding slice.
- Original inventory remains pending until this batch's final source review and regression checks pass. No full-audit completion is claimed.

- A third graph defect was reproduced while reviewing ownership: an indexed parent calling a nested source-only service implementation was excluded because the parent definition's range overlapped the child. The fixture established the target through the live imported-service resolver and failed on the missing parent → child call. Self-call exclusion now compares the actual source callable's identity, preserving the parent call while excluding the child's own recursion. This also simplified the ownership helper naturally.

### Reliability follow-ups outside the numerical inventory

- Earlier work established that `cliBuildIdentity()` hashes only the entry bundle. A change confined to an emitted dependency chunk can therefore reuse a previous identity. Investigate every cache/service consumer and implement an identity covering the installed runtime before relying on cross-version warm-cache validation. The previous scoped health-cache version bump did not solve this general mechanism.
- Examine why ten unchanged callback findings were marked uncomparable in the earlier full source review; establish whether this is a justified matching limit or an identity/matching defect.
- Verify connector coverage accounting (`copiedStatements` versus each rendered line's `copied` flag) and whether adding newly selected control bodies also closes dependencies of those newly included statements. These are open hypotheses, not confirmed defects.

### Graph batch validation checkpoint

All 3,008 tests across 344 files pass on the completed build, including the independent regression cases described above. Build, typecheck, changed-file ESLint, formatting, API (`88ac6629033f84f6`, 66 paths), public-consumer compilation and skill links pass. Source review is accounted with zero blocking findings. Three initial numerical findings resolve; the original connector function's residual finding remains tracked. Index impact is qualified by absent/excluded paths and is not claimed as full semantic-consumer coverage.

Next active work: correct build identity for persistent evidence/health caches, then finish duplicate-group assessment and the remaining inventory. The complete audit remains ongoing.

### Package runtime cache identity — fixed

Persistent evidence and health caches now identify this package's runtime tree and package metadata, rather than `process.argv[1]`. Fixed-name implementation bundles and nested JavaScript chunks participate in the digest. Source execution hashes `src`; installed execution hashes `dist`. Relative paths make relocation irrelevant. The digest is memoized per process; a failed read uses a process-private identity rather than the shared `source` fallback. This does not promise a coherent snapshot during an in-place installation replacement or fingerprint external dependency installations.

Validation: five new real-filesystem identity tests plus existing evidence-cache and health-cache tests passed (34 tests total). Typecheck, changed-file ESLint, build, and diff whitespace checks passed. Source review reports accounted coverage and no blocking findings. This is a bounded cache fix, not completion of the maintenance inventory.

### Duplicate implementation consolidation — validation in progress

All six original groups have been inspected and consolidated: timing summaries share one statistics owner; release package metadata shares one decoder; React and Vue calibration pairs share their respective endpoint mapping; named frontend pairs share their ranking policy; context and change-surface share symbol-risk row formatting. The timing owner also corrects even-sample medians in the cold-index and query-service reporters. No detector selection, similarity thresholds, ranking precedence, or risk messages are intentionally changed.

The first source review caught three issues in this batch: a type import bypassing the query facade, the new benchmark statistics file missing from the explicit performance-tooling inventory, and extra branching in calibration dispatch. These must be corrected and rechecked before this batch is committed.

### Additional setup finding from live owner inspection

`runProjectSetup` can write a new collaboration-domain identity through `ensureProjectCollaborationDomain`, but its `changeScopes.repository` only includes language configuration, automatic-refresh configuration, and agent guidance. When collaboration identity is the only config edit, the report omits a real repository mutation. Add a distinguishing regression before correcting the change report. This is separate from the pending complexity refactor of setup sequencing.

Duplicate batch verification completed: 3,015 tests passed across 346 files. After the final facade/ownership/dispatch corrections, 100 relevant tests passed across 10 files. The final source review has accounted coverage, resolves all six original duplication findings, and reports no blocking findings. The benchmark helper is explicitly owned by performance-tooling; no boundary allowance or numerical limit was relaxed. API and skill-link checks passed. Remaining complexity findings and the additional accuracy/setup issues remain open.

### Connected source completeness and setup mutation reporting — reproduced and fixed, final checks pending

Three distinguishing regressions failed before the edits: a later selected control body used a local payload whose declaration was absent; a compressed multiline predicate was incorrectly included in `copiedStatements`; and collaboration-only setup configuration changes were omitted from repository change scope. Connector selection now reaches a fixed point across binding references and selected control bodies together. Copied coverage counts only lines marked copied. Setup reports and deduplicates collaboration, language, refresh, and guidance paths. All 85 graph and setup tests pass after the changes. This remains lexical source selection, not a claim of complete runtime dataflow or reaching definitions.

Final source-completeness review: accounted coverage, no blocking findings. All 85 graph/setup tests passed; after deduplicating setup config paths through the common change collection, all 22 setup tests passed again. The existing setup complexity finding is still pending review, not resolved by the reporting fix. The older setup test health mock still carries retired score fields; audit its current report contract when reviewing optional health setup, rather than assuming mocked success proves current output accuracy.
