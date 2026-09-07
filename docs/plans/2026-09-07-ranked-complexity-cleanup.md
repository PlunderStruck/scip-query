# Ranked complexity cleanup

User request: start with the highest current-source complexity findings and work downward. This is a behavior-preserving maintainability pass, not a new command audit. Do not run agent benchmarks or change thresholds/suppressions to clear warnings.

Baseline: current source at a878d9a6, 563 eligible TS/JS files, 12,222 functions, 637 complexity findings; no reported duplicate groups or configured dependency violations. The older maintenance inventory is a separate historical queue.

## Ordered first batch

| Function                       | Before cyclomatic / cognitive | Work                                                                                                                                                                                                                        | Status                         |
| ------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `runProjectSetup`              | 76 / 95                       | Separate configuration, dependency preparation, optional guidance, and dossier publication from sequencing. Preserve option defaults, validation gates, side-effect order, failures, changed-file scope, and final verdict. | Refactored; focused tests pass |
| `renderWatchServiceReport`     | 52 / 59                       | Inspect report branches; group independent sections without changing fields, defaults, or ordering.                                                                                                                         | Refactored; focused tests pass |
| `tryRunQueryServiceFastPath`   | 51 / 71                       | Inspect eligibility, continuation handling, service lifecycle and fallback; isolate responsibilities while retaining every gate.                                                                                            | Refactored; focused tests pass |
| `projectFlow`                  | 45 / 75                       | Inspect flow graph projection and slice invariants; separate concrete output responsibilities, retain uncertainty and coverage.                                                                                             | Refactored; focused tests pass |
| `deriveProducerDiscriminators` | 34 / 73                       | Inspect literal/binding propagation and bounds; simplify traversal with equivalent evidence strength and matching.                                                                                                          | Refactored; focused tests pass |

Read implementations and live consumers before changing each. Run existing focused tests first and add behavior checks where phase separation could silently change outcomes. Update this document after each completed item. Re-scan for the next ranking after this batch; 637 warnings do not mean 637 required extractions.

## Verification

Run focused behavioral tests per item, then build, typecheck, lint/format, public API/consumer checks, skill checks, full suite, current-source review and fresh diff-impact for the completed batch. Preserve the unrelated untracked `docs/benchmarks/2026-09-06-launchpoint-backend-validation.md`.

## Findings and checkpoints

- Setup's live CLI consumer is `handleSetup`, which forwards explicit options and uses the report verdict for exit status. Bounded incoming evidence found this consumer; complete universal invocation coverage is not claimed.
- Setup already has 24 behavioral tests covering installation consent, invalid config, disabled automatic indexing, index settling, health availability, and watcher readiness. Additional checks will cover orchestration/report order and failed dossier publication before extraction.

## First batch implementation

| Function                       | Before cyclomatic / cognitive | After cyclomatic / cognitive |
| ------------------------------ | ----------------------------- | ---------------------------- |
| `runProjectSetup`              | 76 / 95                       | 5 / 2                        |
| `renderWatchServiceReport`     | 52 / 59                       | 8 / 8                        |
| `tryRunQueryServiceFastPath`   | 51 / 71                       | 10 / 9                       |
| `projectFlow`                  | 45 / 75                       | 1 / 0                        |
| `deriveProducerDiscriminators` | 34 / 73                       | 6 / 8                        |

These numbers describe the named coordinators, not eliminated behavior. Necessary decisions now live in private functions responsible for particular phases. No new public API, configurable pipeline, service, or registry was introduced.

- Setup: independent configuration-write outcomes, converter/skills/parser/indexer preparation, readiness reporting, agent guidance and dossier publication. Validation/write sequencing, default consent, settling refresh, watcher prerequisites, error outcomes, repository/user change scopes, unfinished attempts and the final verdict are preserved. New tests pin execution/report order and failed-publication behavior.
- Watch report: identity, recorded reindex activity, per-language details, and TypeScript service statistics are separate renderers. Existing runtime status tests cover persisted state through the real command handler; assertions now include the exact activity window, zero-byte staging fallback and section order.
- Fast path: one dispatcher chooses the service and output policy; shared output handling replaces repeated missing-response, serialization and pagination branches. Method failures retain their after-output exit status, while slice failures retain their before-output status. Eleven new focused tests cover pagination metadata, bounded fallback without partial output, resolution status order, exact serialized bytes, missing service responses, profiling and unsupported options. These mock the service/transport boundary; they do not claim to test the daemon itself.
- Flow: separate callable point membership, projected dependencies, unresolved-read classification and container ordering. Same-unit/parameter edges, candidate counts, definition identity, control predicates, closure inputs and earlier-write requirements remain explicit. Existing real-source slice fixtures and coverage tests pass.
- Discriminators: separate eligible request resolution, body-field collection and propagation to callers. One enqueue function owns first-seen summary deduplication. Production/noncandidate gates, unique callee requirements, literal-only observations, proof spans, depth eight, breadth-first processing and per-summary error recovery are preserved. Existing runtime-boundary extraction/persistence tests pass.

## Retained findings on extracted functions

The source review reports 11 new threshold findings on extracted helpers. They are reviewed and retained here, without suppression or threshold changes. The raw whole-repository count rises from 637 to 643 because five large findings were replaced by eleven smaller findings. This is not a claim that total warnings fell.

| Helpers                                                                                                                | Reason to retain the remaining branches                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryNavigationFastPath` (20 / 3)                                                                                     | An exhaustive command dispatcher with distinct typed service arguments. Splitting it by arbitrary command counts would scatter dispatch ownership.                         |
| `projectFlowDependencies` (13 / 21)                                                                                    | A single edge projection rule distinguishes invalid endpoints, parameter origins, same-unit edges, candidate strength and data/control dependence. Those cases must agree. |
| `renderWatchServiceIdentity` (14 / 14), `renderWatchReindexActivity` (14 / 6), `renderWatchTypeScriptStatus` (12 / 20) | Each formats a coherent report section. Most branches preserve optional protocol fields, old-record fallbacks or explicit incomplete evidence.                             |
| `resolveProducerDiscriminatorSeed` (13 / 10)                                                                           | Straight-line validity gates establish one eligible request before deriving a value.                                                                                       |
| `prepareSetupRefreshConfig` (12 / 15), `prepareSetupAstParsers` (11 / 17)                                              | Each pairs one optional operation with its consent/validation gates and truthful outcome report.                                                                           |
| `collectProducerDiscriminatorFields` (9 / 16)                                                                          | Traverses body arguments and fields, separating forwarded parameters from concrete literals.                                                                               |
| `addContainerOrdering` (10 / 16), `classifyFlowBindings` (10 / 16)                                                     | Related local dependency and binding cases remain together after point indexing and name classification were separated.                                                    |

Focused verification: 221 tests across seven files pass. Typecheck and changed-file ESLint pass. Build succeeds; public TypeScript API remains b74137d6c422ca9c across 66 paths; public consumer compilation and skill links pass. Full-suite and fresh-index verification have completed; see the final checkpoint below. No agent benchmarks ran.

## Next ranked candidates

Fresh source scan after this batch: `buildObservationReceipt` (44 / 43), `seedSystemMapAnchors` (37 / 64), `collectOutputs` (32 / 64), `handleWatch` (39 / 64), `modelBody.visit` (38 / 63). These are the next queue, not reviewed or fixed by this batch. Coverage remains 563/563 eligible files, 47/47 dependency rows, with no missing/ambiguous internal imports or reported duplication/cycle/policy violations.

## Final checkpoint

The full suite passes: **3,075 tests in 348 files**. Build, typecheck, full formatting check, changed-file ESLint, API contract, public consumer compilation and skill links pass. The 20.9-second explicit refresh indexed all selected languages without skips; status confirms current-source freshness. Indexed architecture maps 559/559 indexed files and reports no forbidden edges, cycles, boundary-limit or test-boundary violations; all 47 dependency rows are declared. This indexed scope differs from the 563-file current-source scan.

Fresh diff-impact identifies 43 changed symbols in five implementation files. It excludes changed tests/docs from full symbol analysis and leaves the new type import unattributed; it does not establish universal callsite coverage. The CLI entrypoint is an observed downstream consumer. Source review is accounted and retains the 11 documented helper threshold findings; they are not silently waived by a clean test run.

The five corresponding historical inventory entries are now marked fixed with this plan as their assessment record; the old baseline measurements remain unchanged. The historical queue and current 643-warning source report have different purposes. The next ranked candidates above remain outstanding. The unrelated untracked LaunchPoint benchmark document is untouched.

## Continuing instruction and batch two

The user now requests continuing down the ranked list, five at a time, until none remain. Continue after each batch; do not treat the first or second batch as completion. Re-rank current source, track newly extracted helpers as well as old findings, preserve behavior, and do not weaken thresholds/policy or add suppressions to hide work. No agent benchmarks.

Batch two baseline 931fe6c1: buildObservationReceipt 44/43; seedSystemMapAnchors 37/64; collectOutputs 32/64; handleWatch 39/64; modelBody.visit 38/63. All five are in progress. Preserve receipt source/proof correspondence and optional fields; literal/symbol anchor limits and identities; slice output/guard/state distinctions; watcher validation/start-stop/foreground branches and signal cleanup; syntax unit ordering/nesting/source bounds.

## VM refresh during batch two

User requested installing the latest validated repository build under the dev-agent SSH profile, then continuing complexity reduction without reinstalling behavior-preserving changes. Installed the already-built and fully tested 931fe6c1 package (0.25.0) under `/home/launchpoint-agent/.local`; the in-progress batch-two source refactors are not in this build. All 452 packaged files match local SHA-256 values. Six skills in each existing Codex and Claude root resolve to the installed package and match its contents; all 12 links are current. This profile has no shared `.agents/skills` root. Login shell resolves one scip-query executable, and npm lists one global package. A non-login SSH command still needs the absolute path because `.local/bin` is added by login initialization.

Five live watchers were stopped before replacement and restored: main LaunchPoint backend, three existing t3 worktrees, and launchpoint-next-read-latency. Remote verification/journal: `/tmp/scip-query-931fe6c1-verification.json`, `/tmp/scip-query-931fe6c1-watchers.json`; rollback package `/tmp/scip-query-maintenance-final-20260906.tgz`. Package: `/tmp/scip-query-931fe6c1.tgz`, SHA-256 b052fb22140a6f7cf62a2820aa315e917152b873c0bc77e2e8bff59ae976da59. Resume batch two after status verification. Do not reinstall for behavior-preserving refactors.

### Batch two implementation checkpoint

All five implementations refactored; 200 focused tests across six files pass, including four new receipt source/proof fallback cases. Typecheck and changed-file lint pass. Build/full-suite/API/index checks pending. VM status after installation is fresh, watcher running/idle without a last error.

| Function                | Before CC/cognitive | After CC/cognitive | Preserved responsibility                                                                                                                                                                                                         |
| ----------------------- | ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| buildObservationReceipt | 44/43               | 9/4                | Identity facts, declared versus inferred source selection, source/proof correspondence, optional diagnostics, snapshot date and process fallback. Sources and proofs now share one eligibility decision.                         |
| seedSystemMapAnchors    | 37/64               | 5/6                | Literal matching, bounded active seeds, compiler/source ownership, counts/recovery and symbol ambiguity. Distinct literal/symbol paths are explicit.                                                                             |
| collectOutputs          | 32/64               | 6/8                | Returned fields versus whole return values, throws, local and aliased external writes, closure-local work, hook calls and source-point ranges. Shared mutation record construction removes duplication.                          |
| handleWatch             | 39/64               | 8/10               | Validation precedence before project reads, prune before context, status/stop before disabled-start gate, process-local timing overrides and foreground error handling. One timing definition owns names, fields and zero rules. |
| modelBody.visit         | 38/63               | 5/5                | Variable/assignment/call alias rules, nested parameter and named declarations, state setters, closure nodes, callee spans and recursive traversal.                                                                               |

Four new smaller warnings remain explicitly in the reduction queue: statementOutputSeed 13/12, modelBody.recordDeclaration 12/15, materializeLiteralAnchorMatch 11/8, callOutputSeed 11/13. They are not suppressed or declared absent. Source scan remains accounted (563 files), 642 total warnings, no reported dependency violations/cycles or duplicate groups.

Batch three, in rank order: runLanguageIndexersForFreshReindex 42/41 (src/reindex/index.ts:1059), runWithCliOutputPaginationInSession 42/43 (src/runtime/output-pagination.ts:365), scoreSymbolCandidate 41/39 (src/symbols/symbol-lookup.ts:337), handleCleanupPlan callback 33/60 (src/runtime/query-commands/cleanup/handlers.ts:706), buildChunkCalleeMap 25/59 (src/symbols/graph/call-graph-evidence.ts:576). Not yet inspected or changed. Continue after batch-two verification and commit.

### Batch two completion

All verification is complete: 200 focused tests and the full 3,079-test suite (348 files) passed. Build, type checks, changed-file lint, formatting, public API contract and consumer, and skill links passed. After reindexing, diff-impact mapped 27 changed symbols in four source files to eight affected files; documentation and tests are outside this index. Configured architecture checks passed (559 indexed files, 47 declared dependency rows). Current-source review covers 563 files and reports 642 complexity findings. The four new helper warnings remain in the ranked queue; no thresholds or suppressions changed. Five original inventory findings marked fixed. Continue with the five batch-three targets above.
