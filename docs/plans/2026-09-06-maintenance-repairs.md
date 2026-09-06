# Complexity and architecture repair plan

**Final verification: complete.** All 114 tracked entries are addressed. The final full run passes 2,911 tests; the diff has zero introduced/worsened or blocking findings. Indexed architecture maps all 555 observed production files with zero forbidden edges, cycles, unused allowances, boundary-limit findings or coarse-boundary findings. Current-source review covers 558 eligible TS/JS files with no analysis problems. All retained command checks pass within their fixture contracts. The following checkpoints preserve the work history; this paragraph and the final results section supersede their pending states.

Evidence: [final validation](../../benchmarks/maintenance-repairs/2026-09-06/final-validation.json), [repair ledger](../../benchmarks/maintenance-repairs/2026-09-06/ledger.json), [test results](../../benchmarks/maintenance-repairs/2026-09-06/final-unit-results.json).

Status: active. The user asked whether tests are in place before addressing the outstanding complexity/architecture findings and committing. Proceed with that follow-up on `main`, preserve the existing audit work, and commit only after final validation. No subagents are authorized. This document and the [114-entry ledger](../../benchmarks/maintenance-repairs/2026-09-06/ledger.json) preserve work across compactions.

## Scope and evidence

Address the 67 introduced/worsened function-complexity findings and 47 existing architecture findings reported by the previous audit. The 636 other existing complexity findings were not the stated outstanding follow-up. Newly introduced findings from these repairs also require assessment.

A complexity finding identifies a concrete function whose counted branches or weighted nesting exceed the configured threshold. It is a reason to examine its responsibilities, not a proof that every branch should disappear. An architecture finding identifies source dependencies or files that contradict the repository's declared ownership rules. Here, 44 concern unassigned scripts/configuration; two concern forbidden dependency directions; one concerns a cycle among declared runtime groups.

The baseline is 2,870 passing tests, with 629 affected tests passing after the final shared-code relocation. The preceding audit also exercised all retained CLI commands and saved reproducible compiler fixtures. Each repair still requires inspection of its relevant behavioral tests; missing assertions must be added before changing the behavior they protect.

## System and responsibility map

- Domain/storage validation accepts or rejects architecture configuration and stored suppression decisions. Preserve validation messages, precedence, schema compatibility and invalidation evidence.
- Source/semantic analysis identifies declarations, reads/writes, call targets, branch metrics and local control/data relationships. Preserve language-specific cases, exact versus candidate evidence, nested-function boundaries and unsupported cases.
- Graph/navigation queries resolve identities, select source, walk relationships and count distinct units. Preserve coverage, stable ordering, ambiguity and freshness behavior.
- Health/impact/cleanup queries combine current/base files, metrics, consumers, findings and candidate comparisons. Preserve phase order, provider failures, source-matched coverage and changed-file scope.
- Runtime commands format results and coordinate setup, source sessions and worker requests. Preserve printed output, serialization, cache identity, ownership and cleanup.
- Development tools build, release, benchmark and check the product. Declare their actual owners and one-way dependencies without merging them into production query modules.

## Ordered work

| Stage | Concrete units | Proposed action and constraints | Validation |
| --- | --- | --- | --- |
| 1. Test contracts | Every function/site in the ledger and its producer tests | Record exact existing witnesses; add missing behavioral assertions before each affected refactor. | Focused tests, including negative cases. |
| 2. Runtime dependency repair | `query-service-server.ts`, `query-commands/symbol-resolution.ts`, `queries/navigation/code-result-json.ts`, query exports | Put reusable result assembly beside navigation results. Service requests must not import CLI presentation. Use the existing query facade for graph producers. | Query-service, symbol resolution, CLI and serialized response tests. |
| 3. Validation and parsing | Architecture configuration, suppression decoding/adjudication, SCIP symbol/range decoding, TS source/flow walkers | Separate actual validation subjects and syntax cases; remove repeated traversal/guard machinery while retaining essential grammar and policy distinctions. | Config, suppression, parser, metrics, flow and call-binding tests. |
| 4. Query composition | Listed graph/navigation/quality/health/cleanup/impact functions | Separate source acquisition, identity/evidence decisions, traversal and result assembly where these are independent responsibilities. Preserve distinct candidate policies. | Exact identity, numerical, graph, scanner, diff and cleanup regression fixtures. |
| 5. Runtime presentation/lifecycle | Listed renderers, source pagination, skill installation, health workers | Keep section formatting independent of query policy; preserve full output and file/process ownership. | Rendering, session, worker, setup and isolated CLI cases. |
| 6. Tool ownership | 44 unassigned development scripts/configuration files; listed benchmark functions | Group by actual build/release/evaluation responsibilities and declare observed dependencies. Retain complete coverage, cycle checks and existing production constraints. | Source architecture review, script tests, docs/build/API checks. |
| 7. Final verification and commit | Full accumulated user-authorized changes | Regenerate affected derived surfaces. Assess every original finding and any newly introduced finding. Review staged contents, exclude local agent settings/caches, then commit. | Full suite, typecheck, lint/build/API, actual CLI fixtures, architecture, review and qualified diff impact. |

Stages 3–5 share source files, so each file's listed findings are repaired together. Stage 2 enables a clean runtime group graph before classifying tooling dependencies. The final tooling declarations use the completed dependency layout. Each original finding retains its exact identity in the ledger even if its function moves or is replaced.

## Competing approaches and decision rules

1. Local simplification removes redundant loops, guards and duplicated checks where the existing function already has one responsibility.
2. Named operations separate genuinely independent validation subjects, syntax cases, output sections or lifecycle phases. Prefer this when it removes knowledge a caller otherwise has to reconstruct.
3. Tables or dispatch replace repeated case selection when the variants share one operation. Do not force distinct language grammars or state transitions into a generic framework.

For each consolidation, inspect the strongest differing case and preserve it if its behavior is essential. Do not split functions just to distribute a score, silently raise thresholds, or waive findings to obtain a clean check. A justified retained algorithm needs concrete evidence and an explicit disposition, not an unexamined exemption.

## Progress and remaining work

- [x] Saved all 114 original findings and the prior validation baseline.
- [x] Identified architecture composition: 44 missing owners, two forbidden directions, one runtime group cycle.
- [x] Complete per-area test mapping and repair stages 2–6.
- [ ] Run final verification and assess newly introduced findings.
- [ ] Review and commit the authorized changes; report commit hash and remaining limitations.

Repairs are in progress; the previous command-audit results remain valid within their recorded limits.


## Stage 2 implementation

The existing navigation result module already owns symbol-resolution JSON. Moved the small payload composition helper there and preserved the CLI helper's import surface by re-export. Persistent query requests now import that navigation result module directly. Added `queries/service-queries.ts` within the existing facade boundary to expose only its two graph producers; loading the general query barrel would also load unrelated cleanup modules. This is a constrained import surface, with no new query logic or public package path. No architecture permission was widened.

Existing symbol-resolution metadata, reference-binding, query-service request/state and graph/slice tests protect the unchanged behavior. This ownership-only change does not require implementation-mirroring tests; run those existing suites and the source architecture review before moving on.

## Validation/parsing checkpoint

Resolved the runtime cycle and two forbidden directions; the 44 unassigned tooling files still require ownership declarations. Nine original complexity sites are repaired: architecture validation, suppression decoding/adjudication, SCIP descriptor/range decoding, path/call classification, and the two function-metric visitors. The function-metric scope reports no complexity findings after refactoring.

Added regression tests before fixing invalid Windows architecture paths, malformed legacy suppression targets/decisions, and renamed-body fingerprints that erased shorthand destructuring property identities. Also protected expiry/invalidation precedence, Unicode coordinates, incomplete SCIP grammar, and exact ordered complexity contributions. Focused groups pass: runtime 119, configuration 72, suppression 76, classifiers 65, symbol parsing 37, and metrics/quality/source review 49. Some groups overlap and must not be summed as unique tests. The descriptor parser additionally matches its previous implementation across 5,000 generated inputs. Typecheck passed before the last metric refactor; full final validation is still pending.

Evidence artifacts currently reside in `/tmp/scip-maintenance-*`, `/tmp/scip-*-after-tests.json`, and `/tmp/scip-symbol-differential.json`. Persist final evidence summaries in the benchmark directory before committing. Next: local-flow syntax handling, quality composition, remaining query/runtime functions, tooling ownership, final full checks. No threshold or architecture permission was loosened.

## Flow/query/tooling checkpoint

Current source architecture: 558/558 supported files assigned, zero active findings. All original 47 architecture findings are resolved. Added eight tooling owners with only observed source dependencies; no existing production allowances or size thresholds changed. The index-backed architecture command still sees old compiler documents and ten Python audit scripts; refresh its index and finish audit-script ownership before final claims. Its stale allowances must not be removed merely because the index is old.

Refactored local CFG statement builders and consolidated definition recording, protecting loop entry/exit behavior with four new tests. Separated metric fallback order; output slicing and cluster stabilization; graph provider projection and materialization; dependence-slice criteria/adjacency/traversal; possible-impact level acquisition and exact owner resolution; scanner function identity/status comparison; suppression scope decisions; and module ownership/dependency/finding grouping. Focused groups: flow/slice 45 pass, flow/quality 52 pass, graph/impact 189 pass, health/CLI/metrics 74 pass. Typecheck passed after these changes. Navigation outline/import/path repairs are now being checked.

The latest review (`/tmp/scip-maintenance-third-review.json`) had 48 introduced/worsened complexity warnings, including four new helper warnings that still require assessment. Original warning identities are tracked separately from remaining existing complexity; a reduced original function may still exceed a heuristic threshold while no longer worsening this diff. Do not equate that with a warning-free file. New findings: `graphProjectionOptions`, `parseSliceRequest`, `traverseDependenceSlice`, and `buildJumpStatement`. No finding has been waived. Final formatting/build/API/full suite and commit remain pending.

## Navigation/rendering/source checkpoint

The fourth source review (`/tmp/scip-maintenance-fourth-review.json`) reports 23 introduced/worsened complexity findings and no active architecture findings. Original ledger: 92 fixed, 20 pending, 2 in progress at this checkpoint. New helper warnings from the previous checkpoint are gone except `graphProjectionOptions`; its validation/default responsibilities still need assessment. Several of the 23 remaining sites have subsequently been edited and await the next review.

Navigation ownership, export spelling and exact path resolution pass 161 focused tests. Split health and architecture output by report sections; 44 renderer/query tests pass, and 16 differential health/review renderings match byte for byte across modes, bounds and configured/unconfigured architecture. Snapshots/configuration/coverage pass 47 tests. New coverage tests failed before rejecting array-shaped statement maps/count maps, and pass after the fix. Runtime installation preserves external links and directories; reference paging still constructs rows lazily. Compiler token binding continues to preempt source-name guesses. The symbol/navigation/local-flow/reference group passes 284 tests. Typecheck passed through checkpoint 10; checkpoint 11 and the latest source/impact group are running.

Latest edits: maintenance binding/import ownership and historical callable classification. Remaining work includes cleanup comparisons/co-change, test-quality grammar, two code readers, architecture finding identity rendering, source-report orchestration, evaluation scripts, final new-warning assessment, audit-script ownership/index freshness, formatting/lint/build/API/full suite/CLI checks and commit. Health cache/protocol version invalidation must account for the stricter suppression/coverage validation and corrected renamed-body hash.

## Pre-final validation checkpoint

All 114 original entries have been addressed. The seventh review reports zero introduced/worsened findings, zero blocking findings, accounted source coverage and no active architecture findings. No thresholds were raised, findings suppressed or existing production dependency directions widened. Non-regressing existing complexity remains visible and is outside this scoped repair. Added an explicit command-audit-tools owner for the Python audit scripts observed by the indexed architecture command, and removed five retired paths from declared coupling metadata.

Refactored the remaining cleanup comparators, assertion/test grammar, source fingerprint caching, code ambiguity/range readers, architecture identities, source comparison phases and evaluation tools. A benchmark regression caused by a moved result collector was caught by tests and corrected; the later 147-test group passes. Other final focused groups: source/impact 193, cleanup/impact 252, query boundaries 194. Some groups overlap. A final new test exposed co-change returning one finding for `limit: 0`; fixed it while preserving history availability (focused rerun in progress).

Protocol version is now 26 and health report cache version 12 to discard older result semantics. `npm run api:update` is building the current CLI and API report; do not invoke dist CLI until it finishes. Next run the full suite, full lint/typecheck, refreshed index architecture, retained-command fixtures and qualified diff impact. Persist final summaries, review staged contents and commit on main. No commit has occurred.

## Final gate repairs

The full run verified 2,909 tests and caught one missing private-module classification for the new service query facade. Added that classification; the CLI contract suite then passed all 43 tests. The next complete run must include this correction.

A forced compiler rebuild succeeded for TypeScript, Rust and Python with no skipped languages. The indexed architecture graph mapped all 555 observed production documents and had no forbidden edges or cycles, but reported 17 unused allowances. Compared those reports with the current-source import analysis: 15 have real imports in tooling files absent from the compiler index; the other two (`queries-health -> queries-quality`, `queries-quality -> symbols-references`) were obsolete and removed. Added a failing regression before correcting unused-allowance classification for boundaries with no observed source files. The indexed command now states its coverage limit explicitly. This is a coverage correction, not a waiver or wider dependency permission. The combined architecture, hook, source-review and CLI contract group passes 114 tests.

All retained CLI fixture checks passed on the earlier final build: 71 expected read-command outcomes, 42 factual assertions, controls 48, transport 58, Vue 7, frontend 34, architecture 8, and 11 removed-command rejections. The final architecture correction requires a rebuild and another architecture/CLI check. Protocol/cache versions are now 27/13. Final lint/build/typecheck and the complete suite are pending.

## Final results

The final full suite passes 2,911 tests with no failures or pending tests. Build, formatting, ESLint, all type checks, public API compatibility, the external API-consumer fixture and skill links pass. Rebuilt CLI verification passes 71 expected read-command outcomes (70 successful results and one correct non-entry rejection), 42 independent factual assertions, and the separate control/transport/Vue/frontend/architecture/retirement checks. See the durable validation artifacts for individual assertions and build timing.

A fresh compiler index includes TypeScript, Rust and Python without skipped languages. The indexed architecture result now has no enforced findings within its stated coverage. Fifteen tooling allowances were confirmed against actual source imports, and two obsolete production allowances were removed. A regression test first reproduced the false unused-allowance report for a boundary with no observed source files, then passed after the coverage correction. The source review still reports zero introduced/worsened findings and zero blockers. The 114-entry follow-up raised no complexity threshold, added no suppression and widened no existing production dependency permission.

The initial full run caught the missing private query-facade classification; that fixture is fixed and the final full run supersedes the failure. Protocol version 27 and health report cache version 13 discard older result semantics.

Remaining limits are explicit: 642 non-regressing complexity findings, 10 complexity findings with non-unique identities that cannot be compared across the diff, and 7 existing duplication candidates remain. Indexed architecture does not cover unindexed tooling files; the separate source scan covers them. Complete semantic impact remains unavailable with cold TypeScript fragments and the watcher disabled, while source-fallback consumers are reported within their own contract. No matching coverage artifact was supplied, so repository CRAP values remain unknown. These checks establish the tested contracts, not universal language accuracy or measured improvements in agent outcomes.

All relevant source, tests, skills, documentation, retirement deletions and audit evidence are prepared for the authorized commit on main. No local agent settings or caches are included. Raw benchmark patches and terminal captures preserve original whitespace; source/configuration/documentation/test whitespace checks pass.

The accumulated commit also includes policy changes from the earlier scanner work: the source boundary file cap changed from 61 to 67 alongside six source-analysis modules, and `queries-health -> source` plus `reindex-augmentation -> domain` were added for their new shared producers. These predate this follow-up. The no-widening claim above applies to the 114-entry repair scope; the earlier policy edits are included in the commit and remain explicit review decisions, not proof of architectural quality.
