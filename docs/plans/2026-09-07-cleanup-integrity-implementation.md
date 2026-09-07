# Cleanup integrity implementation

Baseline: `afc52f70`. User authorized the next cleanup priorities. Preserve `docs/benchmarks/2026-09-06-launchpoint-backend-validation.md`; do not run agent benchmarks. Work on main, preserve the published API contract, and refresh the VM package/skills when finished because behavior and packaged guidance will change.

## Existing flow and first confirmed issue

Source suppression parsing belongs to `source/primitives/source-text`; production callable selection is shared by `queries/internal/production-callables` and exposed through `ProjectIndex`. The current selector excludes a callable when **any** recognized suppression comment appears before it. `not-implemented` uses that selector without choosing a category, so an unrelated `ignore-extract` annotation can hide a placeholder. Cleanup cascade selection also uses an unqualified suppression test. Duplicate-body and twin checks already have category-specific filters.

This is suppression leakage: an exception for one kind of finding changes the result of another analysis. Fix detector selection before classifying/removing legacy annotations; do not blindly delete all 635 entries. Preserve named, justified exceptions and generic suppression compatibility where explicitly intended. Keep externally consumed API and fixture behavior separate from internal deletion decisions.

## Work list

- [x] Inventory live suppression consumers and every category; reproduce cross-category leakage through actual detectors.
- [x] Make suppression matching specific to the analysis; retain intended aliases and generic behavior deliberately, with regression tests.
- [x] Classify baseline inventory entries; remove obsolete residue and correct misleading inventory descriptions.
- [x] Inspect filesystem/parser/cache/provider failure paths for empty-success mistakes. Reproduce and fix concrete failures; record unsupported/retained cases.
- [x] Check meaningful behavioral tests around edited paths and the relevant cache/publication/identity lifecycles.
- [x] Correct the `reindex --force` instruction mismatch and review neighboring guidance for the same rule.
- [x] Assess the two private forwarding helpers and preserve necessary public/state-owning interfaces.
- [x] Review the eight production co-change pairs against live ownership; no refactor based only on broad-sweep history.
- [x] Build and check API/types/lint; refresh the index and rerun health, changed-source review, impact and relevant detectors.
- [x] Run the complete test suite against the final frozen build; document findings/limits and commit.
- [ ] Replace the dev-agent VM installation with the final build and updated skills, preserving/restarting its existing services and verifying artifact hashes.

## Validation boundaries

Public API baseline is `b74137d6c422ca9c` (66 paths). No scanner thresholds, architecture allowances or suppressions will be widened to conceal results. Report recovered findings as candidates until their consumers and behavior are assessed. Do not build while tests or this checkout's watcher may load `dist`; stop/restart the owned service around builds.

## Confirmed repairs and decisions

- Regression tests reproduced cross-category filtering in production callable selection and AST-backed dead-code exclusions. Named categories now stay within their analyses. `stale` remains a dead-code alias and `wrapper` a passthrough alias; unknown complete names cannot become blanket or partial matches. Bare directives remain explicit blanket opt-outs. Similarity and extraction selection apply their own categories before scan limits.
- Suppression inventory now invalidates on file changes, counts `dead` correctly, and uses exact category names instead of substring guesses. Its documentation describes stored decisions, not measured precision.
- Real temporary-project tests reproduced dropped/mutated Git filenames, stale auxiliary file membership after source invalidation, and silent success for an unavailable source tree. Git enumeration now uses NUL delimiters, membership participates in invalidation, and failed directory enumeration propagates the failure.
- Source reader counterevidence: `getSourceText` already distinguishes missing files from other read errors. Persistent file-evidence products already incorporate the CLI build identity, so new detector logic cannot reuse an earlier build's exclusion results. Cache misses/corruption remain recomputation paths, not findings of an empty repository. No replacement parser or new parallel ownership layer was introduced.
- Initial full suite: **3,298 tests / 371 files passed** against the frozen first build. Added regression cases use the real candidate selector, placeholder detector, AST exclusions, SQLite fixtures, temporary Git repositories and cache invalidation. This is behavior verification; the zero `test-quality` candidates alone were not used as proof of effective testing.
- The corrected indexed scan exposed six additional dead candidates. Exact source/test searches and published API checks found no live consumers for `resolvedCandidateLines`, `scipValueLikeKindNumbers`, `callableCalleeEvidence`, `getTrackedFiles`, `runIsolatedDiffImpactReport`, or `getStrippedLines`. Removed them, their six obsolete annotations, the orphan callee-evidence module/type, its imports, the stripped-lines cache, and the now-unused `referenceChunksByFile` adapter. Retained both externally exposed ProjectIndex methods.
- Removed `calleeEvidenceStrength` and `calleeRowEvidenceStrength`; their callers now use the already imported `staticCallEvidenceStrength` implementation.
- Reviewed all **83 stored suppression records**; all were unmatched against the current whole-source scan. Seventy name obsolete check identifiers (33 echo, 20 co-change-partner, 12 doc-reference, 3 new-dead, 2 twin-partner), and 13 are old exact-ID decisions, including expired records. Removed all 83; per-record reasons/dispositions are in `2026-09-07-suppression-record-review.json`. Git retains original historical evidence. These were not 83 currently suppressed findings.
- The active source annotation families still have current consumers; retain justified local comments rather than remove whole categories. Category isolation makes the retained annotations narrower. Source-annotation inventory/dispositions and final counts follow after the final scan.

## Coordination review

All eight production co-change pairs had zero focused shared commits; broad edits alone cannot establish a design defect. Source review identified these existing responsibilities:

| Pair | Current relationship / decision |
| --- | --- |
| CLI / query-service client | CLI selects the fast path and falls back to full command dispatch; the fast-path module calls the shared query-service client. Keep the entrypoint/client separation. |
| Fast path / query-service server | Both use the client's named request protocol; server owns mailbox execution. Retain this request/handler contract. |
| CLI / query-service server | Process ingress and background execution are distinct owners. The server acquires its session lock, owns its database and mailbox wake, and closes them after the execution loop. No refactor from co-change counts. |
| Query command specs / cleanup handlers | Specs aggregate family descriptors; handlers convert options and call query implementations. Retain the existing descriptor/handler split. |
| Health query / CLI support | Health composes detector results; CLI support owns process budgets, prewarming, isolated execution and rendering. The unused diff-impact forwarding adapter was removed separately. |
| Query exports / query command specs | Library export surface and CLI descriptor assembly have separate consumers. Public API/CLI contract tests check their consistency. |
| Public query entries / command specs | The published query list drives bundle/package contracts; command ordering belongs to CLI registration. No second implementation of query behavior. |
| Exploration manual / generated catalog | The catalog is generated by the command-reference script. Preserve source/generated ownership. |

A module-anchor evidence projection returned no connecting dependency edges and disclosed unsupported frontiers; it did not support an absence claim. The ownership decisions above use exact source imports, dispatch and server lifecycle reads instead. This review does not claim every resource acquisition failure in the repository has been fault-injected.

## Suppression accounting

The baseline 635 inventory entries comprised **554 source annotations plus 81 unexpired stored records**. Two additional expired stored records were outside that count. Removed all 83 stored records and six annotations attached to deleted code. The final indexed inventory is **548 annotations**, with no uncategorized directives or stored records: stale 107, wrapper 112, passthrough 24, extract 224, similar 46, twin 35. Of these, 546 are under production `src/` and two are archived benchmark-source annotations.

`2026-09-07-source-suppression-review.json` records every retained annotation location and its live category consumer; existing reasons remain beside their declarations. Retention preserves prior design decisions; it does not assert that each comment currently suppresses a finding or independently prove each prior decision correct. No category was removed wholesale: all retained categories have consumers, and the isolation repair prevents their reasons from hiding unrelated problems.

## Final scanner evidence

- Current-source health and review: **567/567 eligible TS/JS files**, **13,542 functions**, zero findings and zero scan problems. CRAP is unavailable without source-matched coverage; this run does not claim it was measured. A dynamic benchmark import and two managed-output imports remain explicitly disclosed.
- Architecture: no forbidden dependencies, cycles, stale allowances, boundary-limit violations, test-boundary violations or coarse-boundary findings. No policy allowances were changed.
- Indexed health: dead candidates **8 → 2** after removing the six recovered unused functions; the remaining two are the intentionally retained published ProjectIndex methods. Passthrough candidates **5 → 3** after the private forwarding cleanup.
- Similarity candidates **13 → 19** after suppression isolation. Reviewed all 19: retain distinct bounded-read/hash operations, detector policies, dead/drift evidence consumers, and batch/session lifetimes. The per-pair rationale is in `2026-09-07-recovered-similarity-review.json`; shared mechanisms already own their common work. Existing exact-body/twin candidates retain the earlier reviewed domain distinctions. No new suppressions were added to hide them.
- Diff impact: 16 indexed changed files, 23 changed symbols, 9 affected consumer files. It explicitly excludes 93 changed paths absent from the current index, including deleted code/suppression records and unindexed tests/docs; source review and build/tests cover those changes.
- Public TypeScript API remains **b74137d6c422ca9c / 66 paths**; build, typecheck, consumer typecheck, ESLint, formatting and skill-link checks pass.

Final frozen-build test run: **3,304 tests / 371 files passed** (218.33 seconds). No agent benchmarks were run. VM rollout remains the final operational step.
