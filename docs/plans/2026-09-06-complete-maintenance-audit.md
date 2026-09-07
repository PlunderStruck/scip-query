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

### Watcher protocol audit — newly confirmed gaps, fixes pending

- Persisted watcher state accepts a string-array generation through regex coercion, negative/fractional semantic counters, unchecked optional automatic activity, and malformed last-refresh detail fields. Validate against real producer contracts and preserve legacy optional-field absence.
- Refresh-trigger vocabulary is duplicated in the domain type, activity decoder, and worker. The worker's live decoder omits `watch-startup` and `watch-demand`, converting both to `unknown`. Trace their budget/accounting consequences and add a worker regression, then use one domain-owned trigger validator in all three consumers. Do not claim the consequences from the spelling mismatch alone.

Watcher regressions: 22 new distinguishing assertions failed before the changes (20 malformed-state cases and the two missing worker triggers); five existing/valid cases passed. After replacing duplicated trigger checks with the domain-owned validator and checking persisted fields through explicit record schemas, all 123 focused watcher/activity/worker tests pass. A positive legacy/current-metadata test confirms optional absence and older positive protocol versions remain accepted, valid skipped-language metadata survives, mismatched process identity is rejected, and frozen input is not mutated. The activity writer charges only `isAutomaticTrigger(record.trigger)` records to `summary.automatic`; the worker's earlier `unknown` conversion therefore excluded its startup/demand runs from that accounting. Full-suite/build/source-review validation remains pending for this batch.

Watcher batch final validation: all 3,042 tests passed across 347 files. Build, typecheck, changed-file ESLint, API surface and skill-link checks pass. Source review has accounted coverage, no blocking findings, and resolves seven original watcher-state complexity findings. Those seven inventory entries are now fixed; other watcher lifecycle and reporting owners remain under review.

Setup reporting follow-up: the existing health-order assertion searches for the retired `Health score: 91` line and accepts `findIndex() === -1` as preceding the setup section. This is a false-positive test, not evidence that the retired line exists. Replace it with assertions that require the current availability/issue lines to exist before comparing their order. Also distinguish unavailable/skipped health from zero findings in rendering and update the old mock to a current typed health report.

### Setup health rendering and test integrity — fixed, final review pending

The two new skipped/failed-health rendering cases failed before the change and pass afterward. Unavailable health now says findings were not evaluated. Rendering the health finding section has one owner, separate from setup orchestration and change-scope output. The setup mock is checked against the current `HealthReport` type and no longer carries retired score/pressure fields. The previous ordering test now first asserts all three current lines exist, compares their order, and explicitly rejects a health-score line. All 24 setup tests pass. An attempted CLI source review overlapped a clean build and failed to load `dist/cli-main.js`; rerun only after the build finishes. This is build/check sequencing, not evidence of a shipped CLI failure.

Setup report checkpoint validation: build, typecheck, changed-file ESLint, API and skill-link checks pass; 24 setup tests pass; final source review is accounted with no blocking findings. The source review was rerun successfully after the build completed. `buildSetupSmokeTests` is assessed-retained: it is an ordered ledger of distinct readiness/operation results with explicit human-visible basis labels. The numerical warning remains visible and is not suppressed. Other setup lifecycle findings remain pending.

### Repository refresh and worker-launch follow-up

A plain `reindex` on the current checkout failed because the incremental TypeScript index service was unavailable; unchanged Rust/Python shards were reused, and the accepted index was preserved. An explicit `reindex --allow-expensive-rebuild` recovery is running. Investigate the service unavailability; do not claim the incremental path was exercised successfully.

`resolveReindexWorkerLaunch` uses `new URL(..., import.meta.url).pathname` for the worker filesystem path. URL pathnames retain percent escapes (and differ from Windows filesystem paths); inspect other live uses and correct worker path conversion through the existing path owner or `fileURLToPath`, with a distinguishing encoded-path case. The Watcher constructor's numeric warning is mostly optional injected dependency/default initialization; assess it separately from lifecycle behavior rather than extracting arbitrary assignment groups.

### Live checkout indexing and encoded worker paths — verified

The explicit full recovery succeeded in 13.7s and status reported a fresh index. Status also showed the watcher was stopped, explaining the earlier unavailable incremental service. Started the daemon, made the real worker-path fix in `src/runtime/watch.ts`, and observed an automatic `watch-source` refresh publish a new generation in 5.2s. The durable activity record reports TypeScript `strategy: incremental` (1,052,009 produced bytes), with Rust/Python `strategy: reused`; a later status report was fresh. A no-op manual reindex reused all languages/SQLite in 0.2s. The temporary daemon was stopped before rebuilding. These are actual local-checkout results, not VM/LaunchPoint results or a general performance benchmark.

The worker-path regression failed with `%20`, `%23`, and `%25` escapes in the filesystem path, then passed using `fileURLToPath`. All 48 watcher tests pass; typecheck and changed-file ESLint pass; current source review is accounted with no blocking findings. No other current `src` `.pathname` use was found by the bounded literal search.

### External publication reconciliation — new lifecycle finding

`reconcileExternalPublication` stores a generation as observed before freshness can be established. If that read throws or returns unknown/missing, later polls skip the same generation forever, even after the read recovers and the published index is fresh. Add distinguishing transient-recovery tests while the watcher is budget-paused; only cache an observation after a definitive fresh/stale result. Preserve caching of known-stale publications to avoid repeatedly scanning unchanged source during the pause. Reconsidering a known-stale generation after a later source change is a separate open scenario, not covered by this fix.

Publication reconciliation follow-up: all three transient cases (throw/unknown/missing) failed before the retry fix. A fourth regression confirmed that a later source event could not recheck a previously stale generation. The watcher now caches definitive observations against both generation identity and whether a new input event has invalidated the observation. Pending work can be satisfied by another producer's publication or by source returning to indexed bytes; the user message states that the published index matches current source without guessing publication origin. All 52 watcher tests pass, including preservation of cached known-stale observations between input events. The earlier open same-generation/source-change scenario is now covered; build/review/full-suite validation remains pending.

The scanner snapshot at commit 887bd7c2 reports accounted source coverage, 638 complexity candidates, and no duplication, architecture, or dependency-cycle findings. This is not a spotless verdict: most complexity candidates still require individual assessment, and command/architecture/real-repository usefulness audits remain open.

### Git polling recovery — next candidate to reproduce

`pollGitState` replaces its last accepted Git snapshot with `null` when a read fails. The next successful read then looks like initialization and can discard a HEAD/index transition that happened during the failure. Existing tests cover a failed changed-path query after a detected transition, but not loss of the snapshot itself. Add a null-read/recovery transition test with the filesystem subscription isolated before editing; preserve the last accepted baseline on a transient read failure if reproduced.

Publication-cache final verification: all 3,049 tests passed across 347 files; typecheck, build, changed-file ESLint, API and skill-link checks passed; source review accounted with no blocking findings. The old reconcileExternalPublication finding is fixed through the new published-index reconciliation/observation owners. The scanner comparison also confirms focusedConnectorSlice's original parent warning was resolved by the completed binding/control work; its inventory entry is now fixed.

Cleanup ownership follow-up: execution evidence identifies ensureWatchService and stopWatchService as cleanup callers. Their complete current bodies have no surrounding controller lock. `cleanupWatchServiceFiles` unconditionally removes state/activity before examining the lock owner, so a replacement service publishing between stop and cleanup is a concrete race to reproduce. Do not settle for a read-then-unlink owner check alone; cleanup needs exclusion shared with the actual watcher writer or an equivalent ownership-safe operation.

### Watcher Git recovery and cleanup ownership — in verification

- Confirmed Git polling discarded its accepted snapshot after a transient Git read failure. A regression fails on the original implementation (zero refresh requests), then passes when failed reads preserve the comparison baseline. The fixture fails the Git index-path read, distinguishing a failed observation from a valid unborn HEAD.
- Confirmed cleanup removed state/activity before checking who owned them. Two regressions publish a replacement after the old owner was selected, with both a different PID and a reused PID; both fail on the original implementation because replacement state disappears.
- Startup lock acquisition and cleanup now share a short-lived process-file transition lock. Cleanup verifies current lock and state ownership, including process birth identity, while holding that lock. Replacement/malformed records are preserved. Legacy records missing identity are removable only after the PID has exited. The guard releases in a finally block, including failed startup identity reads.
- Added direct checks that both ownership operations hold the same guard and release it afterward. Existing forced-stop, PID-reuse, legacy upgrade, and process-lock tests remain part of validation. This coordination applies to this implementation; an older binary that does not participate in the transition protocol cannot provide the same concurrency guarantee.
- Remaining work: finish build/review/full-suite verification for this batch; continue the pending scanner and command inventory. This is not a spotless-codebase claim.

#### Verification checkpoint

- Full suite: 3,054 tests / 347 files passed for cleanup and failed-read recovery. After the final scheduling consolidation, 85 watcher/controller tests pass (54 watcher +31 controller), including a new combined HEAD/index transition case. Earlier focused run also passed 22 generic process-lock tests. Typecheck, lint, build and consumer compilation pass.
- Final source review: accounted, no blocking findings. pollGitState is reduced from 18/16 to 13/13 cyclomatic/cognitive while preserving the recovered baseline. Marked assessed-retained with its remaining warning visible.
- API verification caught private Watcher declaration changes from the publication-cache batch. Compared constructor and all non-private members with the TypeScript AST: identical. Recorded a compatible correction in docs/api/changes/b74137d6c422ca9c.json rather than silently accepting a failing check.
- Scope still open: 634 original scanner records pending, plus broader command/skill and external-repository validation. Watcher daemon lifecycle is the next inspection; do not infer complete cleanup coverage from controller tests alone.

### Newly confirmed: daemon finalization after mailbox worker termination failure

- WorkerRequestLane.terminateWorker catches termination failure, reports onFatal, and resolves false. close() resolves void even for that failure. The daemon waits for closeLanes, then finalizes stopped and removes state/activity/releases its lifetime lock solely from watcher.stop(), before it checks mailboxFatalError.
- Required correction: retain ownership and publish degraded shutdown when mailbox workers cannot be confirmed stopped; preserve execution and shutdown errors. Add a lifecycle-level regression exercising the actual lane termination contract, not only an isolated callback expectation. Do not mark runWatchServiceLifecycle assessed until this is fixed and verified.

#### Daemon finalization correction

- Added a lifecycle-level test using the actual WorkerRequestLane. Before the fix, failed worker termination produced ownership-released; afterward it produces degraded, preserves the fatal reason, and retains any simultaneous startup error in the aggregate. Successful termination still rejects the outstanding request before releasing ownership.
- The lifecycle now combines the watcher stop result with terminal mailbox observations before choosing its finalization operation. Its complexity is 12/12; the remaining warning is assessed-retained, not suppressed. The lifecycle function is exported only from its internal module for direct orchestration testing; public API verification remains required.
- 24 focused tests, TypeScript check, lint, and accounted source review pass. Build/full-suite verification pending at this checkpoint. Next: verify this batch, then exercise the current version in the authorized dev-agent / LaunchPoint environment and continue the remaining inventory.

#### Validated daemon checkpoint and VM rollout preparation

- Full suite: 3,058 tests /347 files pass. Build, public API (b74137d6c422ca9c), public consumer compilation, skill links, lint and typecheck pass. No blocking source-review findings; diff-impact artifact /tmp/watch-lifecycle-impact.json retains its stated index coverage limits.
- VM account: launchpoint-agent through ssh dev-agent. Existing global prefix /home/launchpoint-agent/.local; binary .local/bin/scip-query. Noninteractive SSH does not include this prefix in PATH, so rollout uses its absolute executable path. Interactive profile resolves the existing installation correctly.
- Current package: /tmp/scip-query-maintenance-20260906.tgz on VM (local npm pack shasum 65d379fd68b0b69919f86ed726ab88433c0137c6). Old installed package saved via npm pack on VM; its filename is recorded in /tmp/scip-before-upgrade-package.json, under /tmp. Preserve that rollback artifact until verification completes.
- Four previous watcher roots recorded on VM in /tmp/scip-upgrade-watcher-roots.json. All confirmed idle with no pending or claimed refresh requests. Rollout must stop and then restart all four around replacement. Main LaunchPoint index was fresh before rollout; state /tmp/scip-maintenance-launchpoint-status-before.json. Do not leave these services stopped across compaction.

#### VM replacement completed

- Installed the validated 9ce8a0de runtime package into the existing /home/launchpoint-agent/.local global prefix. Compared all 452 tarball files against installed bytes: zero differences. Executable still resolves to the single existing global package path; verification on VM: /tmp/scip-maintenance-upgrade-verification.json.
- All four previously running watchers were stopped and successfully restarted: main PID875597, worktree c260706c PID875645, bcff7c10 PID875699, 1c0ac393 PID875777. No stopped service remains from this rollout. Restart records: /tmp/scip-maintenance-watcher-restarts.json.
- LaunchPoint source health and full module inventory are running with the replacement binary. Outputs /tmp/scip-maintenance-launchpoint-health.json and /tmp/scip-maintenance-launchpoint-modules.json on VM. Post-install status /tmp/scip-maintenance-launchpoint-status-after.json pending. Preserve unrelated docs/benchmarks/2026-09-06-launchpoint-backend-validation.md.

#### LaunchPoint validation complete for this runtime batch

Full results and limitations: docs/benchmarks/2026-09-06-maintenance-vm-revalidation.md. Accounted TS/JS scan: 5,652 files, 58,723 functions; one static import cycle, 77 duplicate candidates, 2,275 complexity candidates. All four cycle imports and two complete duplicate function bodies checked against current source. Full module inventory contains 1,386 groups, including 915 without findings. Existing architecture policy covers only 28 files; no whole-repository architectural quality claim is supported. Main index remains fresh and watcher idle after global replacement. Application source was not changed.

Still open: 633 original maintenance records remain pending; current command/skill contract coverage and a controlled cheaper-model usefulness trial are not complete. A live VM observation also showed activity-window timestamps older than the latest heartbeat; inspect whether rendering clearly qualifies the observation time before treating this as a reporting bug.

### Cached activity-window label

VM observation confirmed the daemon retains its activity summary between reindex/suppression events. A fresh heartbeat does not refresh that summary. Human watch output previously called it Reindex activity (24h), omitting the summary window and implying a current rolling period. The label now prints Recorded reindex activity with the actual start/end timestamps. This is a display correction, not a change to refresh-budget accounting. Typecheck/lint and a built CLI smoke check remain required. Do not rebuild while the model trial is using the frozen dist runtime.

### Cheaper-model trial in progress

Existing runner: scripts/codex-change-trial.mjs, task shared-rule, treatment first, gpt-5.6-sol medium, 300-second per-phase deadline, /tmp/scip-maintenance-sol-treatment-20260906. Two phases: initial ownership repair and follow-up rule change. The fixture is a detached temporary worktree, not a security boundary. No efficacy conclusion until behavior/ownership results and a matched control are available. Do not change benchmark/evaluator inputs or rebuild dist during the trial.

#### Sol treatment completed; matched control running

Treatment shared-rule passed every independent obligation in both phases. Initial 164,797ms, follow-up139,312ms; 25 classified scip-query calls total. Usage: initial479,778 input /430,464 cached /6,217 output; follow-up493,831 input /421,760 cached /4,804 output. This is substantial overhead for a tiny fixture. Raw events show additional mixed shell calls loading host-installed scip skills and CLI help; command classification undercounts embedded commands, so 25 is not an exhaustive invocation count. The initial source patch routes the job through the existing owner and changes the existing policy, with executable channel tests. A matched control (same Sol medium, shared-rule, build, and timeout) is running at /tmp/scip-maintenance-sol-control-20260906. Do not rebuild dist until it finishes; record host-skill exposure and single-pair limitations when interpreting efficacy.

#### Paired Sol trial completed

Both control and treatment pass 17/17 obligations in each phase. Control188,661ms versus treatment304,109ms; cumulative input438,615 versus973,609 (uncached63,575 versus121,385). Matching fixture/evaluator/runtime identities verified; both sandboxes cleaned. There is no measured correctness gain in this pair. Preserve this negative efficiency result rather than changing the benchmark to favor the tool. Report and machine summary: docs/benchmarks/2026-09-06-maintenance-sol-shared-rule.md and .json. Remaining three fixture tasks and repetitions are not complete. Dist can now be rebuilt for the activity-window label correction.

#### Final activity-label verification

Build, TypeScript, lint, public API, consumer compilation and accounted source review pass for the one-line label correction. Full suite remains the 3,058-test run from the immediately preceding lifecycle batch; no claim of another full run after a display-only edit. Installed the final tarball on dev-agent and verified all452 packaged files again; all four watchers restarted successfully. Main PID885079; worktree PIDs885127,885181,885276. Built watch --status succeeds; full output is saved in /tmp/scip-maintenance-final-rollout.json and the recorded window label is checked separately. Previous9ce8a0de package remains available for rollback. Other pending maintenance findings remain open.

### Legacy watcher ownership decoder — next confirmed gap

The legacy watcher decoder uses Number.isInteger for PIDs, accepting integers outside JavaScript's exact range, and permits a protocol-bearing malformed modern record to fall back to legacy ownership when it also has legacy fields. The generic process-lock reader trusts the supplied legacy decoder; no downstream validation repairs this. Add regressions through public readWatchProcessLock for unsafe numeric PIDs and malformed protocol-bearing records, then require safe PID integers and an unmarked legacy record. Preserve supported version-one legacy locks and current modern watch records.

#### Legacy ownership corrections verified

- Reject protocol-marked malformed records rather than interpreting them as the unmarked version-one legacy format.
- Reuse decodeLegacyPidLock for the positive safe-integer PID contract; remove this decoder's differing numeric checks. Preserve matching birth identity, path and timestamp validation.
- Four new regression cases fail before correction and pass afterward. All61 controller, orphan-pruning and generic process-lock tests pass; TypeScript and lint pass. Source review is accounted with no blocking findings. parseLegacyWatchMetadata now measures12/8; its remaining warning is assessed-retained with the reason recorded. The explicit lifecycle decision table was also reviewed and retained. 631 original records remain pending.
- User steering: no further agent benchmarks. Focus on fixes and regression checks. The completed prior trial remains a historical artifact; do not launch additional model evaluations.
- Build/API/diff-impact checks are the remaining pre-commit checks for this batch. This does not claim the broader maintenance audit is complete.

#### Legacy decoder batch ready to commit

Build, public API contract, public consumer compilation, skill links, typecheck, lint, formatting and diff checks pass. The four distinguishing regressions and all61 focused tests pass. Refreshed the local index successfully (12.8s), confirmed fresh status, and reran diff-impact; it identifies the changed legacy decoder. The report still explicitly excludes four non-indexed paths and leaves the import-line edit unattributed; no complete-consumer or absence claim is made from that packet. No additional agent benchmark was run after the user requested focus on fixes.

### 2026-09-07: highest-ranked complexity batch

Completed the first five current-source hotspots, with behavior preservation, retained helper findings and the next ranked queue recorded in [the ranked cleanup plan](2026-09-07-ranked-complexity-cleanup.md). Full suite: 3,075 tests / 348 files. Five historical inventory entries moved from pending to fixed. This does not close the broader audit or classify every remaining warning as a defect. The current raw warning count is 643 because five large functions were decomposed into smaller phases that include eleven retained threshold findings. No thresholds, architecture policy or suppression rules were weakened. No agent benchmarks ran.

## 2026-09-07 ranked complexity batch two

Reduced buildObservationReceipt, seedSystemMapAnchors, collectOutputs, handleWatch, and modelBody.visit to cyclomatic 5–9 while preserving behavior. Added four receipt fallback cases. Validation: 200 focused tests; 3,079 full-suite tests across 348 files; build, types, lint, format, public API/consumer, skill links; refreshed index, diff-impact, and configured architecture checks all passed. Current-source coverage: 563 files, 12,281 implemented functions, 642 complexity findings (four smaller extracted helpers remain in the queue). Historical inventory is now 28 fixed, six assessed-retained, and 621 pending; these historical counts differ from the current scan. See the ranked cleanup plan for the next five. VM installation was independently verified from validated commit 931fe6c1; behavior-preserving cleanup does not require reinstalling it.

## 2026-09-07 ranked complexity batch three

Reduced indexing orchestration, output pagination, symbol scoring, cleanup-plan reporting, and chunk call-map construction to cyclomatic 5–10. Preserved operational policies and failure/cleanup ordering. Added eight cleanup-output cases and an additive-score contract covering eight lookup forms. All 166 focused and 3,088 full-suite tests (350 files) passed, as did build/types/lint/format/API/consumer/skill checks. Refreshed index and diff-impact; current-source coverage 563 files, 12,315 implemented functions, 638 complexity findings. One extracted pagination-emission helper remains above threshold and stays queued. No threshold, suppression, or architecture policy edits. Historical inventory: 33 fixed, six assessed-retained, 616 pending. Continue the next five recorded in the ranked cleanup plan.
