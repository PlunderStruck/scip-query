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

## 2026-09-07 ranked complexity batch four

Reduced activity reporting, compiler reference traversal, freshness evaluation, snapshot metadata validation and supporting-declaration discovery to cyclomatic 2–8. A nested callback warning also resolved. Added 24 saved-page tampering cases. All 176 distinct focused and 3,112 full-suite tests (350 files) passed, as did build/types/lint/format/API/consumer/skill checks. Fresh index/diff-impact mapped 31 changed symbols to 11 affected files. Current-source coverage: 563 files, 12,340 implemented functions, 634 complexity findings. Two smaller extracted helper warnings remain queued; no thresholds, suppressions or dependency policy changed. Historical inventory: 39 fixed, six assessed-retained, 610 pending. Batch five is recorded in the ranked cleanup plan.

## 2026-09-07 ranked complexity batch five

Reduced connected behavior assembly, shadow status decoding, invocation coverage validation, factory callback resolution and Rust default-reference scanning to cyclomatic 5–9. Preserved limits, error precedence, coverage accounting, deduplication and ambiguity refusal. All 146 focused and 3,112 full-suite tests (350 files) passed; build/types/lint/format/API/consumer/skill checks also passed. Fresh index/diff-impact mapped 36 changed symbols to eight affected files. Current-source coverage: 563 files, 12,367 implemented functions, 632 complexity findings. Three smaller extracted helpers remain queued, with no threshold, suppression or dependency-policy changes. Historical inventory: 44 fixed, six assessed-retained, 605 pending. Batch six is documented in the ranked cleanup plan.

### Batch six completion

All checks passed: 335 focused tests, 3,112 full-suite tests across 350 files, build, source types, changed-file lint, format, public API/consumer and skill links. Initial reindex correctly refused a whole-project compiler fallback because the incremental service was unavailable; explicit --allow-expensive-rebuild completed in 20.3 seconds with cached Rust/Python shards. Fresh indexed diff-impact maps 21 changed symbols in five source files to one affected file. Source scan accounted across 563 files and 12,390 functions, with 628 complexity findings; all files mapped and 47/47 dependency rows declared, no reported cycles or configured violations. Historical inventory: 49 fixed, six assessed-retained, 600 pending. One new helper warning remains queued, and no thresholds or suppression policies changed. Continue with the batch-seven targets in the ranked complexity cleanup plan. VM installation remains the verified behavior-equivalent build.

### Batch seven completion

Final shared loop extraction removed the duplicate scan: similarAll and similarAllCount pair-scan callbacks now measure 1/0 each, delegating iteration to scanCalleePairs (3/3). Their distinct comparison/ranking and count behavior remains separate. All 167 focused tests passed; the full 3,133-test suite across 350 files passed before the final loop-sharing extraction, then the 28 affected similarity/command-accuracy tests passed afterward. Final source types, lint, build, formatting and public API/consumer passed; skill-link checks passed. Fresh index/diff-impact maps 25 changed symbols in five source files to 11 affected files. Final source health is accounted across 563 files and 12,415 functions, reporting 622 complexity findings and no duplication, dependency cycles or configured violations; all files mapped, 47/47 dependency rows declared. Historical inventory: 55 fixed, six assessed-retained, 594 pending. No thresholds or suppression policies changed. Continue batch eight as recorded in the ranked complexity cleanup plan; no VM reinstall is needed.

### Batch eight completion

All checks passed: 154 focused tests, full suite 3,133 tests across 350 files, build, source types, changed-file lint, format, public API/consumer and skill links. Fresh index/diff-impact maps 21 changed symbols in five source files to 14 affected files. Source health accounted across 563 files and 12,434 functions, with 617 complexity findings and no reported duplication, dependency cycles or configured violations; all files mapped and 47/47 dependency rows declared. Historical inventory: 60 fixed, six assessed-retained, 589 pending. No new helper warnings, threshold changes or suppression-policy changes. Continue batch nine in the ranked complexity cleanup plan; the VM does not need reinstalling for these behavior-preserving changes.

### Batch nine completion

All checks passed: 153 focused tests, full suite 3,136 tests across 350 files, build, source types, changed-file lint, format, public API/consumer and skill links. Fresh index/diff-impact maps 17 changed symbols in five source files to seven affected files. Current-source health is accounted across 563 files and 12,463 functions, with 614 complexity findings and no reported duplication, dependency cycles or configured violations; all files mapped, 47/47 dependency rows declared. Historical inventory: 65 fixed, six assessed-retained, 584 pending. Two newly extracted helper warnings remain in the queue. Continue batch ten in the ranked complexity cleanup plan. No thresholds/suppression policy changes or VM reinstall.

### First parallel complexity wave completed

Completed the root batch of fifteen plus three exclusive worker sets of ten: **45 ranked targets**, all at cyclomatic 10 or below and cognitive 14 or below. The full source scan resolves **46 existing findings**, including the additional system-map frontier callback. New helpers remain under the configured warning thresholds. No thresholds, source scope, suppressions or dependency policy were changed.

First parallel complexity wave: 3167 full-suite tests / 353 files passed; build, source types, changed-file ESLint, formatting, public API b74137d6c422ca9c (66 paths), consumer compilation and skill links passed. Accounted source review: 46 resolved findings, no introduced/worsened findings. Fresh source health: 563/563 files, 12,662 functions, 568 complexity findings, no other finding rules. Fresh indexed diff impact: 201 changed symbols across 38 indexed files, 39 affected files. No source-matched test-coverage artifact; no CRAP claim.

All 563 source files remain mapped and all 47 dependency rows declared, with no reported duplicates, dependency cycles or configured violations. The source review retains one uncomparable pre-existing anonymous-callback finding in `publishFreshReindexArtifacts` because its name does not uniquely identify a callback; that untouched body is not claimed resolved. The source scan still reports it. Indexed impact omits eleven changed paths (docs/tests and scripts outside its symbol index); source review accounts for the eligible TS/JS scripts. The historical inventory and current scan remain different populations.

Validation included new parser-backed Rust/Python/TypeScript containment tests, dead-output category/budget/totals tests, journal path/entry/UTF-8-byte-bound tests, and envelope-precedence/object-identity tests. Worker 2 also compared the signature scanner on 30,000 inputs and corridor decisions across 4,480 combinations with the baseline. No agent benchmarks were run. Review corrections preserved overlay type guarantees, original reindex annotation ownership, dispatch fallback for inherited keys and the original semantic-array witness behavior.

The VM stays on the previously verified installation from `931fe6c1`, with linked skills current. This wave changes internal structure while preserving intended behavior, so the user's instruction does not require another reinstall.

Target measurements (cyclomatic/cognitive):

- `collectNextAnchorGraphRelationCandidates` → 10/14 (`src/queries/internal/next-anchor-candidates.ts`).
- `buildTypeContainerMap` → 4/4 (`src/source/facts/source-type-containers.ts`).
- `getJsTestExclusions` → 6/5 (`src/analysis/framework-patterns.ts`).
- `decodeProjectInputChangeJournal` → 5/4 (`src/domain/project-input-change-journal.ts`).
- `probeProjectFileBytesForLiterals` → 9/9 (`src/platform/project-files.ts`).
- `programStateTemporalElementsForTopologyNodes` → 9/12 (`src/queries/graph/program-state-temporal-edges.ts`).
- `touchExistingWorktreeLease` → 4/3 (`src/reindex/shared-generation-store.ts`).
- `mayUseQueryServiceFastPath` → 7/1 (`src/runtime/cli.ts`).
- `handleDead.<callback:budgetedDbCommand:1>` → 3/2 (`src/runtime/query-commands/cleanup/handlers.ts`).
- `TsMorphSemanticProvider.addHierarchyMemberReferences` → 5/6 (`src/semantic/typescript/ts-morph-provider.ts`).
- `cleanupPlan` → 7/8 (`src/queries/cleanup/cleanup-plan.ts`).
- `httpExtractor.extract.<callback:visitDescendantsOfType:2>` → 10/8 (`src/analysis/runtime-boundaries/extractors.ts`).
- `downloadVerifiedBinary` → 8/7 (`src/platform/verified-binary-fetch.ts`).
- `reachesSameNameTarget` → 6/5 (`src/queries/cleanup/twin-drift.ts`).
- `finalizeSystemMap` → 10/6 (`src/queries/graph/system-map.ts`).
- `decodeCliJsonEnvelope` → 7/6 (`src/runtime/cli-json-envelope.ts`).
- `catalogExplorationRoutes` → 5/4 (`src/queries/internal/exploration-topology.ts`).
- `selectExplorationTopology` → 10/7 (`src/queries/internal/exploration-topology.ts`).
- `validPersistedRange` → 6/3 (`src/runtime/source-emission-session.ts`).
- `parseProcessFileLockRecord` → 9/7 (`src/platform/process-file-lock.ts`).
- `repositoryContext` → 9/3 (`src/queries/impact/context.ts`).
- `validateWatchConfig` → 2/1 (`src/runtime/config.ts`).
- `parseBenchmarkCommand` → 4/3 (`scripts/benchmark-query-service.ts`).
- `buildRepositoryContextSourcePacket` → 2/1 (`src/queries/impact/context.ts`).
- `parseOverlayManifest` → 3/3 (`src/reindex/typescript-overlay-store.ts`).
- `printJsonEnvelope` → 10/10 (`src/runtime/command-kit/command-execution.ts`).
- `truncateAtImplementationStart` → 5/7 (`src/queries/cleanup/similar-signatures.ts`).
- `reindex` → 9/8 (`src/reindex/index.ts`).
- `inflightClaims` → 5/6 (`src/storage/bounded-mailbox.ts`).
- `orientRecentDuplicate` → 10/6 (`src/queries/cleanup/recent-duplicates.ts`).
- `isClosureEdge.<callback:(edge.semantics ?? []).some:0>` → 1/0 (`src/queries/internal/causal-corridor.ts`).
- `prepareIndexerRun` → 7/6 (`src/reindex/index.ts`).
- `rowIdentity` → 5/1 (`scripts/score-detector-labels.ts`).
- `isTraversableEdge.<callback:(edge.semantics ?? []).some:0>` → 3/2 (`src/queries/internal/causal-corridor.ts`).
- `executeRequest` → 2/1 (`src/runtime/query-service-server.ts`).
- `buildSetupSmokeTests` → 1/0 (`src/runtime/project-setup.ts`).
- `behaviorForNode` → 7/4 (`src/queries/internal/connected-behavior.ts`).
- `focusLinesForNode` → 10/11 (`src/queries/internal/connected-behavior.ts`).
- `factoryCallbackMemberTargets` → 5/5 (`src/symbols/graph/member-call-targets.ts`).
- `classifySimilarityEvidence` → 10/8 (`src/queries/cleanup/similar.ts`).
- `parseReindexActivityRecord` → 9/9 (`src/reindex/reindex-activity.ts`).
- `coChangePairsFromHistory` → 10/12 (`src/analysis/git-history.ts`).
- `resolveMember` → 1/0 (`src/analysis/runtime-boundaries/object-members.ts`).
- `collectFileMatches` → 9/7 (`src/queries/navigation/source-search-batch.ts`).
- `materializeSemanticCalleeCache.<callback:profileSpan:1>` → 1/0 (`src/semantic/symbol-evidence.ts`).

The prepared second parallel wave is next. Artifacts: `/tmp/complexity-wave1-{review,health,impact,metrics}.json`; verification logs use `/tmp/complexity-wave1-*.log`.


### Second parallel complexity wave completed

Completed 45 ranked targets across exclusive file assignments: root 11, worker 1 13, worker 2 10, worker 3 11. Four untouched targets were transferred after workers finished their initial sets, preventing the integration lane from delaying the batch. All 45 targets and every introduced helper measure at or below cyclomatic 10 / cognitive 15. No thresholds, source scope, suppressions or dependency policy were changed.

Second parallel complexity wave: 3196 full-suite tests / 357 files passed; build, source types and contract fixtures, changed-file ESLint, formatting, public API b74137d6c422ca9c (66 paths), public consumer compilation and skill links passed. Accounted source review resolves 46 findings with no introduced/worsened findings. Fresh source health: 563/563 eligible files, 12,809 functions, 522 complexity findings, no other finding rules. Fresh indexed diff impact: 183 changed symbols across 36 changed files; 38 affected files. No source-matched test coverage artifact; no CRAP claim.

All 563 source files remain mapped and all 47 dependency rows declared. The source scan reports no duplication, dependency cycles or configured architecture violations. It still reports 522 complexity findings; the cleanup is continuing. The historical maintenance inventory and current source scan cover different populations.

Validation included eight explicit malformed/quoted-source masking cases; JSON option error precedence and a 20,001-node iterative graph chain; dead-gate callback ordering, mailbox correlation precedence and comparison-script parse-only behavior; and command dependency/readiness output regressions. Each lane received a second, read-only diff review. Review corrections separated bounded file hashing from cache selection, narrowed literal owner helpers to the actual callable type, and reduced source-search dispatch without changing its argument consumption or fallback conditions. No agent benchmarks were run.

The source review retains one uncomparable pre-existing finding in `registerCommandDescriptors.<callback:descriptors.map:0>` due to duplicate anonymous callback names; its body is untouched and not claimed resolved. The CLI preAction hook also has a non-unique anonymous name, so its 8/6 target measurement is tied to the exact diff location (baseline line 80, current line 139), not inferred from a name-only pair. All omissions and indexed impact scope remain disclosed in the saved packets.

The VM remains on the previously verified build from `931fe6c1`, with linked skills current. These refactors preserve intended behavior, so no reinstall was performed.

Target measurements (cyclomatic/cognitive):

- `parseSharedGenerationManifest` → 8/9 (`src/reindex/shared-generation-store.ts`).
- `handleSliceCohesion.<callback:budgetedDbCommand:1>` → 10/10 (`src/runtime/query-commands/cleanup/handlers.ts`).
- `sourceRangeNextAnchorPacket` → 6/3 (`src/queries/internal/next-anchor-candidates.ts`).
- `systemMapLiteralMatches` → 2/1 (`src/queries/graph/system-map.ts`).
- `validateIndexerAndSemanticConfig` → 6/4 (`src/runtime/config.ts`).
- `parseTypeScriptSemanticEnvelope` → 9/8 (`src/semantic/typescript/session-protocol.ts`).
- `extractPublicExports` → 5/7 (`scripts/api-surface-contract.mjs`).
- `summarizeClosures` → 5/7 (`src/queries/quality/slice-cohesion.ts`).
- `parseSourceSearchInvocation` → 7/11 (`src/runtime/query-service-fastpath.ts`).
- `tokenizeTsSafe` → 7/9 (`src/source/primitives/source-stripper.ts`).
- `validateSupportedMetadata` → 7/6 (`src/domain/reindex-metadata.ts`).
- `fingerprintProjectFile` → 5/5 (`src/platform/project-files.ts`).
- `executeSystemMap` → 8/3 (`src/queries/graph/system-map.ts`).
- `systemMapTopologyOwnerNodes` → 7/8 (`src/queries/graph/system-map.ts`).
- `buildHealthValidation` → 5/3 (`src/queries/health/health-report.ts`).
- `captureOutputSnapshotPage` → 5/4 (`src/runtime/output-pagination.ts`).
- `parseCachedDefinition` → 6/5 (`src/symbols/definition-catalog.ts`).
- `programDataElementsForSystemMapRelations` → 3/2 (`src/queries/graph/program-data-edges.ts`).
- `isTypeScriptIndexRequest` → 7/6 (`src/reindex/typescript-index-protocol.ts`).
- `targetedCallerRowsMapForSymbols` → 5/3 (`src/symbols/graph/call-graph-evidence.ts`).
- `productionCallableDefinitions` → 6/8 (`src/queries/internal/production-callables.ts`).
- `sweepRepositoryCacheDirectory` → 10/6 (`src/runtime/repository-cache-lifecycle.ts`).
- `handleCheckDeps` → 5/5 (`src/runtime/commands/command-handlers.ts`).
- `findCallerFiles` → 9/11 (`src/symbols/identifier-attribution.ts`).
- `isObservationReceiptV1` → 7/2 (`src/domain/observation-receipt.ts`).
- `parseLedger` → 10/7 (`src/runtime/source-emission-session.ts`).
- `maintainBoundedMailboxUnlocked` → 1/0 (`src/storage/bounded-mailbox.ts`).
- `deadCandidateDecision` → 6/1 (`src/queries/internal/dead-candidate-gate.ts`).
- `<callback:program.hook:1>` → 8/6 (`src/runtime/cli-main.ts`).
- `materializeBoundedLinks` → 5/10 (`src/analysis/runtime-boundaries/graph.ts`).
- `boundarySourceHashes` → 6/6 (`src/analysis/runtime-boundaries/graph.ts`).
- `decodeCurrentCorrelation` → 6/4 (`src/semantic/rust/durable-session-protocol.ts`).
- `decodeDurableRustMailboxResponse` → 6/6 (`src/semantic/rust/durable-session-protocol.ts`).
- `parseArgs` → 5/5 (`scripts/typescript-semantic-provider-comparison.mjs`).
- `buildProjectChangeManifest` → 5/4 (`src/domain/project-input.ts`).
- `recordClojureMembers` → 7/4 (`src/source/facts/clojure-facts.ts`).
- `benchmarkArguments` → 5/4 (`scripts/benchmark-query-service.ts`).
- `planTypeScriptIncrementalUpdate` → 10/8 (`src/reindex/typescript-incremental-index.ts`).
- `TsMorphSemanticProvider.referencesForDefinitionsBySymbolScan.<callback:profileSpan:1>` → 6/6 (`src/semantic/typescript/ts-morph-provider.ts`).
- `TsMorphSemanticProvider.semanticCalleeForCallNode` → 8/8 (`src/semantic/typescript/ts-morph-provider.ts`).
- `validateJsonOutputOptions` → 6/5 (`src/runtime/commands/command-registry.ts`).
- `behaviorReceipt` → 10/7 (`src/source/facts/behavior-skeleton.ts`).
- `TsMorphSemanticProvider.calleeCoverageForDefinitions.visit` → 6/6 (`src/semantic/typescript/ts-morph-provider.ts`).
- `stronglyConnectedComponents` → 4/5 (`src/analysis/strongly-connected-components.ts`).
- `flattenRustUseTree` → 10/9 (`src/language-parsers/languages/rust.ts`).

Next: prepared third wave of 45 ranked targets. Artifacts: `/tmp/complexity-wave2-{review,health,impact,metrics}.json`; verification logs use `/tmp/complexity-wave2-*.log`.


### Third parallel complexity wave completed

Completed 45 ranked targets across exclusive file assignments: root nine, each of three Astra-medium workers twelve. All selected targets and introduced helpers are at or below cyclomatic 10 / cognitive 15. No thresholds, source scope, suppressions or dependency policy changed.

Third parallel complexity wave: 3199 full-suite tests / 358 files passed; build, source types and contract fixtures, changed-file ESLint, formatting, public API b74137d6c422ca9c (66 paths), public consumer compilation and skill links passed. Accounted source review resolves 45 findings with no introduced/worsened findings. Fresh source health: 563/563 eligible files, 12,938 functions, 477 complexity findings, no other finding rules. Fresh indexed diff impact: 154 changed symbols across 30 changed files; 20 affected files. No source-matched test coverage artifact; no CRAP claim.

All 563 source files remain mapped and all 47 dependency rows declared. Fresh health reports no duplication, dependency cycles or configured architecture violations. The 477 remaining complexity findings are the next work queue; the historical maintenance inventory remains a different population.

Validation included 244 focused tests in worker 1, 216 in worker 2 (including cold/warm semantic fragment caching and leaf-edit invalidation), 113 in worker 3 (including three new script regressions), and 208 in root; these counts overlap. Every lane received a second read-only diff review. Tests/lint/review caught and corrected a temporary API return newline error, a missed candidate-state reference and a semantic cache counter property typo. Newly introduced spread argument limits were removed from graph/residue collection. No agent benchmarks or release actions ran.

The semantic cache-scan callback has the same anonymous name as two sibling callbacks; its 2/1 measurement is tied to the exact diff location (baseline 466/current 551) and span label, not a name-only pairing. The enclosing materializeSemanticReferenceBatch remains at its existing 16/20 and is still on the cleanup queue. The source review reports no uncomparable findings; some anonymous function records remain uncomparable. Indexed impact omits thirteen paths absent/excluded from its symbol index; the current-source scan accounts for eligible scripts.

The VM remains on its previously verified installation from `931fe6c1`. The skill capture helper was refactored with preserved behavior and permissions, so the user's instructions do not require another reinstall.

Target measurements (cyclomatic/cognitive):

- `reportUnknownConfigKeys` → 2/1 (`src/runtime/config.ts`).
- `buildHealthActions` → 1/0 (`src/queries/health/health-report.ts`).
- `compareApiSurfaces` → 6/1 (`scripts/api-surface-contract.mjs`).
- `createDeclarationResolver.resolveExport` → 7/6 (`scripts/api-surface-contract.mjs`).
- `clusterOutputs` → 4/4 (`src/queries/quality/slice-cohesion.ts`).
- `parseManifest` → 3/3 (`src/reindex/typescript-fragment-store.ts`).
- `readQueryServiceServerState` → 10/7 (`src/runtime/query-service.ts`).
- `parseSqliteGenerationReaderLease` → 8/6 (`src/storage/sqlite-generation.ts`).
- `renderTimeStateWrites.visit` → 7/6 (`src/queries/quality/slice-cohesion.ts`).
- `expandRuntimeBoundaryFrontier` → 4/3 (`src/queries/graph/system-map.ts`).
- `systemMapTopologyRelationEndpoint` → 9/8 (`src/queries/graph/system-map.ts`).
- `compareNeutralNextAnchors` → 2/1 (`src/queries/internal/next-anchor-candidates.ts`).
- `buildInspection` → 1/0 (`src/queries/navigation/source-inspection.ts`).
- `detectCoarseBoundaries` → 5/7 (`src/queries/graph/architecture.ts`).
- `parseSkillCommands` → 7/6 (`scripts/render-command-reference.ts`).
- `sourceBindingOwnerAtLine` → 7/6 (`src/queries/graph/system-map.ts`).
- `collectRemovedReferences` → 4/3 (`src/queries/impact/newly-unreferenced-residue.ts`).
- `newlyUnreferencedResidue` → 8/5 (`src/queries/impact/newly-unreferenced-residue.ts`).
- `createExplorationTopology` → 9/4 (`src/queries/internal/exploration-topology.ts`).
- `inferKindNumber` → 10/7 (`src/queries/navigation/by-kind.ts`).
- `codeBatchText` → 1/0 (`src/runtime/query-commands/direct-navigation.ts`).
- `parseFastPathInvocation` → 2/0 (`src/runtime/query-service-fastpath.ts`).
- `queryNavigationFastPath` → 4/3 (`src/runtime/query-service-fastpath.ts`).
- `decodeDurableRustMailboxRequest` → 4/3 (`src/semantic/rust/durable-session-protocol.ts`).
- `isIndexedDefinition` → 4/1 (`src/semantic/rust/durable-session-protocol.ts`).
- `readDurableRustSessionServerState` → 8/7 (`src/semantic/rust/durable-session.ts`).
- `runRustAnalyzerReferenceBatch` → 6/3 (`src/semantic/rust/lsp-batch-worker.ts`).
- `RustAnalyzerLspClient.handleData` → 7/8 (`src/semantic/rust/lsp-client.ts`).
- `decodeSemanticAvailability` → 9/8 (`src/semantic/types.ts`).
- `ensureEvidenceCommandFreshness` → 9/10 (`src/runtime/evidence-command-freshness.ts`).
- `parseCodeInvocation` → 6/8 (`src/runtime/query-service-fastpath.ts`).
- `claimBoundedMailboxRequestsUnlocked` → 7/10 (`src/storage/bounded-mailbox.ts`).
- `loadGrammar` → 5/4 (`src/source/ast/ast-runtime.ts`).
- `isStructuralEntryPath` → 10/9 (`src/source/primitives/file-kind.ts`).
- `scoreLabels` → 3/2 (`scripts/score-detector-labels.ts`).
- `parseScalaImportsAst` → 7/14 (`src/language-parsers/languages/jvm.ts`).
- `runLeafCorpus` → 9/10 (`scripts/affected-set-shadow-contract.mjs`).
- `parseCodexJsonl` → 5/3 (`scripts/codex-exploration-trial-core.mjs`).
- `summarizeParsedJson` → 6/3 (`scripts/semantic-command-calibration.mjs`).
- `main` → 5/4 (`skills/scip-explore/scripts/capture-evidence.mjs`).
- `summarizeLanguageActivity` → 2/1 (`src/reindex/reindex-activity.ts`).
- `collectLocalSqliteGenerations` → 6/6 (`src/reindex/sqlite-generation-store.ts`).
- `readLease` → 5/3 (`src/runtime/repository-cache-lifecycle.ts`).
- `collectSuppressionExclusions.walk` → 4/3 (`src/analysis/framework-patterns.ts`).
- `materializeSemanticReferenceBatch.<callback:profileSpan:1>` → 2/1 (`src/semantic/shared-primitives.ts`).

Next: prepared fourth wave of 45 ranked targets. Artifacts: `/tmp/complexity-wave3-{review,health,impact,metrics}.json`; verification logs use `/tmp/complexity-wave3-*.log`.


### Fourth parallel complexity wave completed

Completed 45 ranked targets across exclusive file assignments: root nine, each of three Astra-medium workers twelve. All selected targets and introduced helpers are at or below cyclomatic 10 / cognitive 15. No thresholds, source scope, suppressions or dependency policy changed.

Fourth parallel complexity wave: 3217 full-suite tests / 358 files passed; build, source types and contract fixtures, changed-file ESLint, formatting, public API b74137d6c422ca9c (66 paths), public consumer compilation and skill links passed. Accounted source review resolves 47 findings with no introduced/worsened findings. Fresh source health: 563/563 eligible files, 13,055 functions, 430 complexity findings, no other finding rules. Fresh indexed diff impact: 149 changed symbols across 37 changed files; 34 affected files. No source-matched test coverage artifact; no CRAP claim.

All 563 source files remain mapped and all 47 dependency rows declared. Fresh health reports no duplication, dependency cycles or configured architecture violations. The 430 remaining complexity findings are the next work queue; the historical maintenance inventory remains a different population.

Validation included 216 focused tests in worker 1 plus 10 rerun after type corrections, 186 in worker 2 (including shared-worktree integration and 10,000 deterministic old/new JSON-comment cases), 194 in worker 3 plus 89 rerun after final splits, and 330 in root plus 101 rerun after final splits; these counts overlap. Eighteen new root tests cover deferred phase payloads, metadata, mutation isolation and invalid-phase behavior. Every lane received a second read-only diff review. A temporary snapshot-liveness return-newline mistake and a co-change helper type narrowed beyond the actual data were corrected before the full suite. No external agent benchmarks or release actions ran.

The HTTP process-call-sites callback shares its anonymous name with a seed callback. Its 2/1 measurement is tied to the exact diff (baseline 166/current 178) and span label. A pre-existing, untouched publishFreshReindexArtifacts callback remains 12/16 and is reported uncomparable because of ambiguous callback identity; this is not counted as resolved. Source review also resolves the nested carrier traversal and body-declaration callback, yielding 47 resolved findings for 45 selected targets. Indexed impact omits seven paths absent/excluded from its symbol index; the current-source scan accounts for eligible scripts.

The VM remains on its previously verified installation from `931fe6c1`; these behavior-preserving refactors do not require another reinstall under the user's instruction.

Target measurements (cyclomatic/cognitive):

- `sanitizeTerminalText` → 9/11 (`src/platform/terminal-output.ts`).
- `deferredHealthPhaseResult` → 4/3 (`src/runtime/cli-support.ts`).
- `validateProjectHeaderConfig` → 6/5 (`src/runtime/config.ts`).
- `isOutputSnapshotReservation` → 5/3 (`src/runtime/output-pagination.ts`).
- `pruneAbandonedOutputSnapshots` → 6/8 (`src/runtime/output-pagination.ts`).
- `isEntryPointResult.<callback:value.every:0>` → 6/3 (`src/runtime/query-service.ts`).
- `validPersistedEvidenceItem` → 5/3 (`src/runtime/source-emission-session.ts`).
- `validPublication` → 7/5 (`src/storage/sqlite-generation.ts`).
- `isSuppressionDecision` → 6/3 (`src/domain/suppression-adjudication.ts`).
- `coChange` → 10/9 (`src/queries/cleanup/co-change.ts`).
- `docsCitingFiles.<callback:profileSpan:1>` → 4/3 (`src/queries/cleanup/doc-drift.ts`).
- `computeFileLeafUsageFromAst` → 8/13 (`src/queries/internal/consumer-evidence.ts`).
- `countBranchesFromRegex` → 5/4 (`src/queries/quality/complexity.ts`).
- `containerAccesses` → 3/3 (`src/queries/quality/slice-cohesion.ts`).
- `handleDocDrift.<callback:dbCommand:0>` → 7/6 (`src/runtime/query-commands/cleanup/handlers.ts`).
- `sourceInspectionSections` → 3/0 (`src/runtime/query-commands/navigation.ts`).
- `collectBehaviorCandidates` → 5/4 (`src/source/facts/behavior-skeleton.ts`).
- `indexServiceReceivers.<callback:walk:1>` → 2/1 (`src/symbols/graph/member-call-targets.ts`).
- `pickAstCallCandidate` → 2/1 (`src/symbols/leaf-symbol-index.ts`).
- `testQuality` → 5/4 (`src/queries/cleanup/test-quality.ts`).
- `modelBody` → 10/12 (`src/queries/quality/slice-cohesion.ts`).
- `prepareSharedGenerationCache` → 9/7 (`src/reindex/index.ts`).
- `deriveProjectDependencies` → 5/5 (`src/reindex/project-shards.ts`).
- `stripJsonComments` → 9/14 (`src/reindex/project-shards.ts`).
- `runtimeBoundaryAugmentationStage.run` → 9/7 (`src/reindex/runtime-boundaries.ts`).
- `findSharedBaselineGeneration` → 8/8 (`src/reindex/shared-generation-store.ts`).
- `hydrateSharedGeneration` → 10/8 (`src/reindex/shared-generation-store.ts`).
- `inspectLocalSqliteGenerationRetention` → 7/7 (`src/reindex/sqlite-generation-store.ts`).
- `commitTypeScriptOverlay` → 7/4 (`src/reindex/typescript-overlay-store.ts`).
- `buildSweepInventory` → 1/0 (`src/runtime/repository-cache-lifecycle.ts`).
- `Watcher.constructor` → 10/1 (`src/runtime/watch.ts`).
- `resolveReindexWorkerLaunch` → 7/4 (`src/runtime/watch.ts`).
- `buildFreshReindexShardDiagnostics` → 6/9 (`src/reindex/index.ts`).
- `runNpmRelease` → 3/1 (`scripts/npm-release.ts`).
- `deriveConsumerDiscriminators` → 10/15 (`src/analysis/runtime-boundaries/carrier-discriminators.ts`).
- `deriveParameterRoles.<callback:walk:1>` → 2/1 (`src/analysis/runtime-boundaries/http-summaries.ts`).
- `formatUninstallReport` → 8/6 (`src/runtime/uninstall.ts`).
- `isResponseForKind` → 9/8 (`src/semantic/rust/durable-session-protocol.ts`).
- `collectExtensions` → 5/6 (`src/reindex/detect.ts`).
- `parseCargoJsonDiagnostics` → 9/13 (`src/runtime/cleanup-verify.ts`).
- `legacyDispositionForReason` → 3/2 (`src/analysis/framework-patterns.ts`).
- `loadFileAddRecords` → 7/9 (`src/analysis/git-history.ts`).
- `incompleteMigration` → 9/7 (`src/queries/impact/incomplete-migration.ts`).
- `sameFileCallClosureForRange` → 5/3 (`src/queries/navigation/code.ts`).
- `propagateCompilerResolvedHttpSummaries.<callback:recordSpan:1>` → 2/1 (`src/analysis/runtime-boundaries/http-summaries.ts`).

Next: prepared fifth wave of 45 ranked targets. Artifacts: `/tmp/complexity-wave4-{review,health,impact,metrics}.json`; verification logs use `/tmp/complexity-wave4-*.log`.


### Fifth parallel complexity wave completed

Completed 45 ranked targets across exclusive file assignments: root nine, each of three Astra-medium workers twelve. All selected targets and introduced helpers are at or below cyclomatic 10 / cognitive 15. No thresholds, source scope, suppressions or dependency policy changed.

Fifth parallel complexity wave: 3227 full-suite tests / 360 files passed; build, source types and contract fixtures, changed-file ESLint, formatting, public API b74137d6c422ca9c (66 paths), public consumer compilation and skill links passed. Accounted source review resolves 45 findings with no introduced/worsened findings. Fresh source health: 563/563 eligible files, 13,146 functions, 385 complexity findings, no other finding rules. Fresh indexed diff impact: 122 changed symbols across 34 changed files; 30 affected files. No source-matched test coverage artifact; no CRAP claim.

All 563 source files remain mapped and all 47 dependency rows declared. Fresh health reports no duplication, dependency cycles or configured architecture violations. The 385 remaining complexity findings are the next work queue; the historical maintenance inventory remains a different population.

Focused validation passed 219 tests in worker 1 plus 144 affected tests rerun after final splits; 187 in worker 2 plus 28 rerun; 156 in worker 3 including the final 48 search/source-evidence tests; and 220 distinct tests in root. These counts overlap. New isolated script fixtures exercise calibration argument consumption, early exits, numeric-error precedence, summary parsing and report output without launching benchmark entrypoints. Every lane received a second read-only diff review. A temporary return-newline mistake in worker 3 was corrected before final checks. Seven search CLI failures during shared editing did not recur in a focused rerun or the frozen full suite; their initial cause was not established. Worker logs for those two runs were retained as tool output, not filesystem artifacts.

The anonymous source-inspection search row callback was replaced by the named sourceInspectionSearchRow at7/4; the target mapping is established by the exact diff, not automated name identity. The untouched publishFreshReindexArtifacts callback remains12/16 and is reported uncomparable. Indexed impact omits eleven paths absent/excluded from its symbol index; current-source health accounts for eligible scripts.

The VM remains on its previously verified installation from `931fe6c1`; these behavior-preserving refactors do not require another reinstall under the user's instruction.

Target measurements (cyclomatic/cognitive):

- `isValidLanguageActivity` → 4/3 (`src/reindex/reindex-activity.ts`).
- `isClaimCoverage` → 4/3 (`src/domain/claim-qualification.ts`).
- `decodeProjectConfig` → 5/7 (`src/domain/project-config.ts`).
- `isSuppressionCounterevidence` → 5/3 (`src/domain/suppression-adjudication.ts`).
- `validateDeclaredCouplings` → 5/3 (`src/runtime/config.ts`).
- `parseEntryPointsInvocation` → 9/14 (`src/runtime/query-service-fastpath.ts`).
- `isSourceSearchResult` → 8/4 (`src/runtime/query-service.ts`).
- `parseGitWorktreeList` → 8/14 (`src/platform/git-worktree.ts`).
- `parseArgs` → 7/9 (`scripts/semantic-command-calibration.mjs`).
- `buildTryStatement` → 10/6 (`src/semantic/typescript/local-flow.ts`).
- `collectNodeAccesses.visit` → 10/10 (`src/semantic/typescript/local-flow.ts`).
- `buildClojureSourceFacts` → 6/9 (`src/source/facts/clojure-facts.ts`).
- `callTargetForNode` → 8/6 (`src/source/facts/source-calls.ts`).
- `reactCandidateForNode` → 6/6 (`src/source/react-profile.ts`).
- `importedMemberCallTargets` → 9/11 (`src/symbols/graph/member-call-targets.ts`).
- `resolveMember` → 7/12 (`src/symbols/graph/static-value-flow.ts`).
- `sourceMayContainCandidateName` → 5/4 (`src/source/primitives/source-identifier-prefilter.ts`).
- `addRustAttrCallers` → 7/11 (`src/symbols/references/reference-callers.ts`).
- `classifyCycle` → 6/6 (`src/queries/graph/cycles.ts`).
- `nativeConsumerClassifyEntry` → 4/4 (`src/queries/internal/consumer-evidence.ts`).
- `shortestDirectedAnchorPath` → 2/1 (`src/queries/internal/exploration-topology.ts`).
- `publishSharedGenerationOwned` → 8/6 (`src/reindex/shared-generation-store.ts`).
- `materializeGeneration` → 9/8 (`src/reindex/sqlite-generation-store.ts`).
- `getPublishedIndexFreshness` → 7/7 (`src/runtime/index-freshness.ts`).
- `getProjectCapabilities` → 9/9 (`src/runtime/project-readiness.ts`).
- `ensureWatchService` → 7/5 (`src/runtime/watch-service.ts`).
- `classifyLanguageShardReuse` → 4/3 (`src/reindex/index.ts`).
- `runPreparedIndexer` → 10/11 (`src/reindex/indexer-runner.ts`).
- `managedGenerationMatchesFingerprint` → 8/6 (`src/reindex/shared-generation-store.ts`).
- `prepareSharedGenerationForProject` → 10/9 (`src/reindex/shared-generation-store.ts`).
- `publishFreshLocalGenerationForProject` → 10/8 (`src/reindex/shared-generation-store.ts`).
- `languageCapability` → 10/11 (`src/runtime/project-readiness.ts`).
- `sanitizeScipBuffer` → 6/7 (`src/reindex/sanitize.ts`).
- `compareReferencedDeclarations` → 6/9 (`scripts/api-surface-contract.mjs`).
- `typeScriptProjectSelectionIsTreeOwned` → 6/7 (`src/platform/typescript-projects.ts`).
- `handleLocalityCandidates.<callback:budgetedDbCommand:1>` → 5/4 (`src/runtime/query-commands/cleanup/handlers.ts`).
- `renderRelationshipPacket` → 4/3 (`scripts/accuracy-calibration.mjs`).
- `runResampleMode` → 6/5 (`scripts/accuracy-calibration.mjs`).
- `runSummarizeMode` → 8/4 (`scripts/accuracy-calibration.mjs`).
- `projectCommandResult` → 9/7 (`skills/scip-explore/scripts/capture-evidence.mjs`).
- `capabilityDescriptorHandler` → 6/11 (`src/analysis/runtime-boundaries/extractors.ts`).
- `terminateOwnedProcessTree` → 10/9 (`src/platform/process-tree.ts`).
- `patternDeviationDrift` → 3/3 (`src/queries/cleanup/drift.ts`).
- `qualifiedEvidence` → 8/6 (`src/queries/navigation/evidence.ts`).
- `sourceInspectionSections.searchRows.<callback:result.searches.map:0>` → 7/4 (`src/runtime/query-commands/navigation.ts`).

Next: the user requested larger parallel batches, so the sixth wave has90 ranked targets with exclusive file ownership (root15; each worker25). Artifacts: `/tmp/complexity-wave5-{review,health,impact,metrics}.json`; verification logs use `/tmp/complexity-wave5-*.log`.


### Sixth parallel complexity wave completed

Completed 90 ranked targets across 68 exclusive source-file assignments: root fifteen, each of three Astra-medium workers twenty-five. All selected targets and introduced helpers meet cyclomatic 10 / cognitive 15. No thresholds, source scope, suppressions or dependency policy changed.

Sixth parallel complexity wave: 3240 full-suite tests / 363 files passed; build, source types and contract fixtures, changed-file ESLint, formatting, public API b74137d6c422ca9c (66 paths), public consumer compilation and skill links passed. Accounted source review resolves 90 findings with no introduced/worsened findings. Fresh source health: 563/563 eligible files, 13,283 functions, 295 complexity findings, no other finding rules. Fresh indexed diff impact: 215 changed symbols across 59 changed files; 53 affected files. No source-matched test coverage artifact; no CRAP claim.

Focused validation passed 311 distinct tests in root, 221 in worker 1 plus 134 affected tests rerun, 350 in worker 2 plus 133 affected tests rerun, and 426 in worker 3. Counts overlap across lanes and with the full suite. Thirteen new regression tests cover script parsing, worker configuration, AST visitation and reindex publication reporters. The script fixtures do not execute benchmark entrypoints or launch external agent trials.

Every lane received a second read-only diff review. That review caught two extracted reindex reporters changing a callback receiver. Both now invoke the callback through the original run object; two regressions verify receiver/message ordering and avoid accessing the callback for suppressed reports. The API check also caught a new private Watcher member changing the emitted exported class declaration. The path checks were moved to standalone helpers with the original instance access order. The first full run passed all test assertions but exited unsuccessfully with one Vitest RPC onTaskUpdate timeout; it is not counted as successful validation. The corrected frozen tree passed the final combined checks.

The two checkStructure.visit functions are distinct: the refactored source-file visitor is paired through its exact diff (baseline line 228 to current line 247, 7/6); the unchanged callable visitor remains 5/5. Three preexisting callback finding records remain uncomparable: two file-dependency graph callbacks and one reindex publication callback. They are not counted as resolved.

Fresh health reports no duplication, dependency cycles or configured architecture violations. The 295 remaining complexity findings form the next source queue; the historical maintenance inventory describes a different population. The VM remains on its previously verified installation from `931fe6c1`; these behavior-preserving refactors do not require another reinstall under the user instruction.

Target measurements (cyclomatic/cognitive):

- `isResultKeysetCursorPayload` → 7/3 (`src/runtime/result-pagination.ts`).
- `sourceChunks` → 10/8 (`src/runtime/source-emission-session.ts`).
- `isRustReferenceWorkerRequest` → 7/3 (`src/semantic/rust/durable-session-protocol.ts`).
- `parseArgs` → 4/4 (`scripts/incremental-freshness-contract.mjs`).
- `parseHealthSemanticPrewarmMarker` → 10/9 (`src/runtime/cli-support.ts`).
- `isLegacyOutputCursorPayload` → 8/3 (`src/runtime/output-pagination.ts`).
- `isOutputSnapshotPage` → 5/3 (`src/runtime/output-pagination.ts`).
- `parseOutlineInvocation` → 9/14 (`src/runtime/query-service-fastpath.ts`).
- `isOutlineResult` → 10/9 (`src/runtime/query-service.ts`).
- `isSymbolResolutionResult` → 5/3 (`src/runtime/query-service.ts`).
- `parseQueryServiceResponse` → 9/8 (`src/runtime/query-service.ts`).
- `assertWatcherArtifactsBelongToRoot` → 9/8 (`src/runtime/watch-service-prune.ts`).
- `completeBoundedMailboxClaim` → 5/3 (`src/storage/bounded-mailbox.ts`).
- `parseTypeScriptWorkerConfig` → 8/6 (`src/reindex/worker.ts`).
- `parseRuffJsonDiagnostics` → 4/4 (`src/runtime/cleanup-verify.ts`).
- `flattenRustUseTreePositions` → 10/1 (`src/semantic/rust/import-usage.ts`).
- `buildBehaviorOutline.emitNode` → 10/9 (`src/source/facts/behavior-skeleton.ts`).
- `addSwitchControlFacts` → 10/4 (`src/source/facts/behavior-skeleton.ts`).
- `behaviorSkeleton` → 9/8 (`src/source/facts/behavior-skeleton.ts`).
- `namedCallableNode` → 6/4 (`src/source/facts/source-callables.ts`).
- `directForwardedCall` → 8/6 (`src/source/facts/source-callables.ts`).
- `fileDependencyPaths` → 3/3 (`src/symbols/graph/file-dep-graph.ts`).
- `isFileDependencyGraphPayload` → 3/2 (`src/symbols/graph/file-dep-graph.ts`).
- `addAstCallsiteCallers` → 7/11 (`src/symbols/references/reference-callers.ts`).
- `recordJsxElement` → 2/1 (`src/source/react-profile.ts`).
- `scanSourceReferences` → 8/10 (`src/symbols/references/source-reference-scan.ts`).
- `addAdjacentJunctions` → 3/3 (`src/queries/internal/exploration-topology.ts`).
- `enrichResultCallbackControlSemantics` → 4/4 (`src/queries/internal/next-anchor-candidates.ts`).
- `sliceCohesionForDefinition` → 10/6 (`src/queries/quality/slice-cohesion.ts`).
- `projectFlowDependencies` → 3/3 (`src/queries/quality/slice-cohesion.ts`).
- `addCrossCallableCandidates` → 8/9 (`src/semantic/typescript/local-flow.ts`).
- `isUseNode` → 7/6 (`src/semantic/typescript/local-flow.ts`).
- `addReachingDefinitionEdges` → 4/4 (`src/semantic/typescript/local-flow.ts`).
- `computePostdominators` → 5/7 (`src/semantic/typescript/local-flow.ts`).
- `mutationFact` → 7/6 (`src/source/facts/state-temporal-analysis.ts`).
- `buildBehaviorTokens` → 9/8 (`src/source/vue/vue-profile.ts`).
- `resolveCallableTargetDefinitions` → 9/7 (`src/symbols/graph/member-call-targets.ts`).
- `serviceDeclarationFilesForImplementation` → 5/4 (`src/symbols/graph/member-call-targets.ts`).
- `discoverAffectedConsumerReuse` → 3/2 (`src/queries/impact/context.ts`).
- `isSelectedCorridorEvidence.<callback:(edge.semantics ?? []).some:0>` → 10/9 (`src/queries/internal/causal-corridor.ts`).
- `uninstallSkills` → 6/5 (`src/runtime/setup.ts`).
- `validateSourceGeneration` → 10/10 (`src/reindex/shared-generation-store.ts`).
- `decodeDocumentResponse.fragments.<callback:response.fragments.map:0>` → 10/3 (`src/reindex/typescript-index-requester.ts`).
- `TypeScriptIndexServiceHost.constructor` → 9/1 (`src/reindex/typescript-index-service.ts`).
- `remediateIndexers` → 7/7 (`src/runtime/project-setup.ts`).
- `Watcher.handleFileChange` → 10/9 (`src/runtime/watch.ts`).
- `TypeScriptSemanticServiceHost.status` → 10/12 (`src/semantic/typescript/session-service.ts`).
- `collectAffectedSetShadowRecord` → 10/8 (`src/reindex/affected-shadow.ts`).
- `collectIndexerOutputs` → 6/10 (`src/reindex/index.ts`).
- `publishFreshReindexArtifacts` → 10/9 (`src/reindex/index.ts`).
- `readSharedGeneration` → 10/9 (`src/reindex/shared-generation-store.ts`).
- `ensureImmutableSqliteGeneration` → 10/8 (`src/reindex/sqlite-generation-store.ts`).
- `partitionTypeScriptCompilerInputsIntoShards` → 8/8 (`src/reindex/typescript-compiler-shards.ts`).
- `awaitVueReferenceWorkers` → 10/6 (`src/reindex/vue/augment-vue-workers.ts`).
- `readWorkerResult` → 10/8 (`src/reindex/vue/augment-vue-workers.ts`).
- `processDurableRustSessionRequests` → 10/10 (`src/semantic/rust/durable-session-server.ts`).
- `createRustSemanticProvider` → 8/0 (`src/semantic/rust/provider.ts`).
- `loadScipOccurrenceCalleeIndex` → 9/7 (`src/semantic/rust/scip-occurrence-callees.ts`).
- `loadScipOccurrenceReferenceIndex` → 9/8 (`src/semantic/rust/scip-occurrence-references.ts`).
- `materializeSemanticReferenceBatch` → 9/8 (`src/semantic/shared-primitives.ts`).
- `buildSemanticCalleeMap.<callback:profileSpan:1>` → 7/12 (`src/semantic/shared-primitives.ts`).
- `TsMorphSemanticProvider.definitionFromCompilerSymbol` → 10/12 (`src/semantic/typescript/ts-morph-provider.ts`).
- `TsMorphSemanticProvider.importUsageForSourceFile` → 9/12 (`src/semantic/typescript/ts-morph-provider.ts`).
- `TsMorphSemanticProvider.referencesForDefinitions` → 9/11 (`src/semantic/typescript/ts-morph-provider.ts`).
- `isFingerprintStatRecord` → 9/5 (`src/platform/fingerprint-stat-cache.ts`).
- `nodeChildProcessBindings` → 3/2 (`src/analysis/runtime-boundaries/extractors.ts`).
- `buildRelationGroups` → 4/3 (`src/analysis/runtime-boundaries/graph.ts`).
- `propagateCompilerResolvedWrappers` → 6/10 (`src/analysis/runtime-boundaries/wrapper-propagation.ts`).
- `parsePhpImportsAst` → 4/3 (`src/language-parsers/languages/php.ts`).
- `deadSummary` → 8/13 (`src/queries/cleanup/dead.ts`).
- `parseDeadCalibrationOptions` → 10/10 (`scripts/accuracy-calibration-core.mjs`).
- `renderDeadPacket` → 4/3 (`scripts/accuracy-calibration.mjs`).
- `normalizeNamedBindings` → 9/7 (`scripts/api-surface-contract.mjs`).
- `profileScoreboard` → 9/12 (`scripts/profile-scoreboard.mjs`).
- `inspectPortableExecutable` → 3/2 (`scripts/scip-windows-provenance.mjs`).
- `runWindowsSidecarRelease` → 10/5 (`scripts/scip-windows-release.ts`).
- `priorSourceCoverage` → 5/5 (`skills/scip-explore/scripts/capture-evidence.mjs`).
- `collectRustAstExclusions` → 5/4 (`src/analysis/framework-patterns.ts`).
- `normalizeExclusionEntry` → 8/7 (`src/analysis/framework-patterns.ts`).
- `capabilityRegistryExtractor.extract.<callback:visitDescendantsOfType:2>` → 2/1 (`src/analysis/runtime-boundaries/extractors.ts`).
- `effectHttpApiExtractor.extract.<callback:visitDescendantsOfType:2>` → 4/3 (`src/analysis/runtime-boundaries/extractors.ts`).
- `extractImplementationBody` → 5/6 (`src/queries/cleanup/duplicate-bodies.ts`).
- `analyzeArchitectureGraph` → 8/5 (`src/queries/graph/architecture.ts`).
- `dependencyDepth` → 5/6 (`src/queries/graph/deep-chains.ts`).
- `graphEvidence` → 9/9 (`src/queries/graph/graph-evidence.ts`).
- `causalCorridorFocusLocations` → 3/2 (`src/queries/graph/system-map.ts`).
- `inspectSource` → 10/9 (`src/queries/navigation/source-inspection.ts`).
- `renderSqliteGeneration` → 8/6 (`src/runtime/commands/command-handlers.ts`).
- `renderWatchReindexActivity` → 5/2 (`src/runtime/commands/command-handlers.ts`).
- `checkStructure.visit` → 7/6 (`scripts/change-benchmark-core.mjs`).

Next: wave seven contains the next 90 ranked targets plus all 87 other findings in the same exclusively assigned files (177 total); the remaining118 findings are in86 other files. Artifacts: `/tmp/complexity-wave6-{review,health,impact,metrics}.json`; verification logs use `/tmp/complexity-wave6-*.log`.
