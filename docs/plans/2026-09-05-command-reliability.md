# Command reliability and retirement

Status: completed repair and command-assessment pass; remaining analytical limits and repository complexity findings are documented in the final report. This supersedes the audit-only scope in [the follow-up sweep](2026-09-05-audit-followup.md). The user explicitly requested fixing retained commands one by one, evaluating further removals, and removing the TLA feature. Preserve earlier work on main; no commit requested.

The initial inventory contains 98 top-level commands. All 98 help invocations parse, which establishes no analytical accuracy. The machine ledger is `benchmarks/full-tool-audit/2026-09-05/followup/command-ledger.json`; each retained command needs a purpose, tested positive/negative cases, coverage limits, and a retention decision. Shared implementation fixes should repair all affected consumers.

## Work order

- [x] Remove TLA implementation, CLI wiring, feature tests, formal-model fixtures, active guidance and generated command references. Preserve dated audit evidence as history and mark the retirement explicitly. Retirement tests: 57 passed; build/typecheck passed. Current inventory and generated references now contain 97 commands.
- [x] Fix nested callable ownership in exact call evidence; verify complexity, call-graph and graph/impact consumers.
- [x] Fix false complete local slices for aggregate aliases and delete mutations; expand unsupported coverage when semantics are not modeled.
- [x] Test health/review identity, evidence invalidation, measured coverage and exit-code cases; fix reproduced defects without converting unavailable evidence to certainty.
- [x] Validate navigation/source commands individually against exact source, ambiguity, current-file inventories, compiler identities and output coverage.
- [x] Validate dependency/impact commands individually with direction, cycles, reference-versus-call, changed/new/deleted symbol and freshness fixtures.
- [x] Assess cleanup/similarity/quality commands individually for distinct useful purpose and justified evidence. Remove redundant or unsupported claims and controls rather than retaining misleading output.
- [x] Validate framework commands within explicit React/Vue coverage and retain only useful supported analyses.
- [x] Validate setup/maintenance/internal transport controls with isolated temporary projects and meaningful failure cases; do not change user installations during probes.
- [x] Refresh docs/API, run affected checks during work, then a full frozen-source suite, review and fresh impact. Publish decisions and remaining limits for every original command.

## Reproduced leads before implementation

- Exact nested-call ownership: `nestedOwner` merely returns a nested function; `complexity` credits it with one established callee and `call-graph` labels the nested function's helper call as an exact outer call. Source occurrence recovery filters by line range without excluding nested callable ownership.
- Aggregate alias slice: `{ ref: state }`, followed by `holder.ref.value = input`, returns `state.value`; the backward slice has only the return occurrence and unqualified complete coverage.
- Delete mutation slice: `state.value = input; delete state.value; return state.value` retains the input and earlier definition as exact flow while omitting deletion and reporting complete coverage.
- Ordinary reference-only call counts, missing-file refusal and actual direct-call controls passed. Array-alias limitations were explicitly disclosed. A duplicate name is disclosed by the CLI's other-match metadata; do not file it as silently exact without further evidence.

The real compiler fixture is at the path saved in `/tmp/scip-followup-root`. Captured packets are `/tmp/scip-followup-cli`; preserve them before cleanup. Current sweep scripts and the initial command inventory live under `benchmarks/full-tool-audit/2026-09-05/followup/`.

## Implementation checkpoint

- AST call records now retain the nearest syntactic callable, including unindexed/anonymous scopes; source-facts payload version 11 invalidates old ownership data. The TypeScript adapter independently had the same line-range bug; its callee map and coverage walk now use syntactic owners. New tests include nested declarations, arrows, callbacks and same-line shadowed names, plus real direct-call controls. Both provider paths pass focused regressions.
- Warm CLI probes exposed persisted pre-fix TypeScript callee rows. Bumped the callee schema from v3 to v4; revalidate the already-warm fixture (do not erase its cache to make this pass).
- Aggregate object/array aliases now disclose incomplete slice coverage. Delete expressions invalidate prior reaching definitions and disclose the unsupported mutation. Scalar-only aggregate and ordinary reassignment/branch tests stay complete. 24 slice tests passed.
- Reproduced an accepted source-review suppression whose only evidence was a different config file. Adjudication now requires hashed evidence for every target file, including multi-site findings. Existing counterevidence invalidation remains. Domain/source-review tests: 37 passed. Extend cross-target tests and guidance before finalization.
- Analysis sweep after ownership/slice/suppression changes: 1,075 tests / 146 files passed (queries, source, language parsers, semantic providers, symbols). This is regression coverage, not a percentage-accuracy claim.
- Initial failing CLI packets preserved in `followup/before/`; later runs are `/tmp/scip-followup-cli-after` and `/tmp/scip-followup-cli-fixed`. The latter still showed cached v3 semantic callee data; it is not a successful validation capture.
- Next: verify v4 warm CLI recovery, finish command retention decisions and per-command semantic/CLI checks, then maintenance/internal controls and final frozen full suite/API/docs/diff-impact. No subagents are running.

- Warm-cache v4 CLI verification passed without erasing the fixture cache: nestedOwner has zero established callees; only explicitly candidate chunk neighbors remain.
- Fixed existing directory selectors returning empty `system`/`surface` results. Exact directories now select indexed descendants; exact missing file intent remains authoritative.
- Fixed `locality-candidates sum` resolving `src/consumer.ts` through a filename substring. Symbol resolution now wins unless a file is an exact/suffix match.
- Fixed `hierarchy` manufacturing shortened identities: fallback ancestry now returns real indexed symbols only.
- Fixed `members` dropping indexed class fields without enclosing declaration ranges. Definition occurrences recover their identifier locations; members are sorted after range recovery. Shared lookup uses the same occurrence evidence.
- Navigation/member focused regressions passed (31 tests / 6 files); rebuilt CLI confirms directory membership, external consumers, exact ancestry, field line and locality target.
- All 82 retained read commands have valid isolated compiler-fixture invocations. The initial session/check-deps JSON and slice ambiguity errors were harness mistakes, corrected explicitly. Empty detector outputs are smoke evidence, not positive recall evidence.
- Full suite, lint/API and typecheck are running. Lint caught an obsolete line-based ownership helper, now removed. Final artifact assertions, per-command decisions and final index/impact review remain.


## Final verification checkpoint

- Full suite: 2,840/2,840 tests passed in 333 files after removing the obsolete TLA recorder expectation from the artifact-budget contract. Lint, public API check, typecheck and Git whitespace checks passed before the final helper cleanup.
- Final compiler-fixture run: 82 read commands passed; 44 explicit semantic assertions passed. Captures are now committed-worktree artifacts under `followup/final/`.
- `COMMAND_DECISIONS.md` and the JSON ledger cover every original command: retire TLA, retain 93 ordinary/transport controls and 4 internal controls. Optional high-false-positive heuristics remain candidates, never deletion authority. No global accuracy rate is claimed.
- Real root reindex completed in 15.6s across TypeScript/Python plus reused Rust. Architecture: no forbidden edges/cycles; 10 Python audit scripts are unmapped, explicitly reported.
- First post-reindex impact disclosed cold semantic fragments while the service was stopped. Started the checkout-local watch service and reran: both semantic and source tiers complete; 368 changed symbols, 24 affected consumer files. This includes earlier uncommitted work, not only this turn.
- Self-review disclosed branching-heavy newly added helpers. Separated callable binding recovery from owner matching, aggregate alias children from reporting, and raw occurrence decoding from cache aggregation. Focused semantic/navigation tests after cleanup: 52 passed. Final build/lint/typecheck, CLI replay and source-review follow-up are running/pending.
- Added a multi-site suppression test: missing second-target evidence escalates; adding it accepts; changing that second target invalidates. Await focused result.
- Remaining before final response: finalize tests/artifacts with the final source hashes; update the review assessment and remaining limits; stop only the audit-started watch service after final impact if appropriate. No commit requested.


## Completion

Final frozen-source validation: **2,841 tests / 333 files passed**, zero failures/skips. Lint/build/API/typecheck and whitespace checks pass. Final CLI replay again passed all 82 read commands and all 44 semantic assertions. A separate no-index/no-cache first-use scan passed seven checks and found the seeded cycle across all 13 files / 28 functions. Multi-site suppression and all simplified helper paths are included in the final suite.

Final impact: 376 changed symbols / 24 affected consumer files, both tiers complete. The index reports fresh. Stopped the audit-started watcher after warming and verification. No user-global installations changed; no commit made. TLA is the only additional command retired this pass. All 98 original commands have explicit decisions/evidence; 97 remain (including four internal controls).

Read [the final repair report](../benchmarks/2026-09-05-command-reliability.md) and its linked per-command ledger for the assessed 42 remaining complexity warnings, unsupported analysis cases, and missing agent-outcome/production accuracy validation. Those are recorded limitations/follow-up work, not silently marked as fixed. The checkboxes above refer to finishing this assessment and reproduced-defect repair pass.
