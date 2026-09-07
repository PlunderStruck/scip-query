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

### Batch three implementation checkpoint

Separated language reuse classification, accepted incremental-generation facts, expensive-rebuild gating, project shard planning, measurements, and cached output materialization. The coordinator preserves forced rebuild policy, refusal before compiler execution, and caching before destructive shard collection. Split pagination into validation, output mode selection, immutable snapshot reads, stdout capture/restoration, and emission. Factored additive symbol ranking by match kind without changing weights. Split cleanup-plan policy from plan, patch, verification, and warning rendering. Split chunk call evidence loading from the document range sweep and source-confirmed matching; retained SQL batching and symbol/chunk deduplication.

| Target                              | Before cyclomatic/cognitive | After |
| ----------------------------------- | --------------------------- | ----- |
| runLanguageIndexersForFreshReindex  | 42/41                       | 8/6   |
| runWithCliOutputPaginationInSession | 42/43                       | 8/3   |
| scoreSymbolCandidate                | 41/39                       | 6/4   |
| handleCleanupPlan callback          | 33/60                       | 10/10 |
| buildChunkCalleeMap                 | 25/59                       | 5/4   |

Validation so far: 157 pre-change tests passed; 166 focused tests across 12 files passed after the edits (eight new cleanup-output cases plus one score contract covering eight lookup patterns). Source type checking passed. Current-source review is accounted across 563 files and 12,315 implemented functions. One extracted helper remains above threshold: emitCapturedOutputPage 12/12. No thresholds or suppressions changed. Build/full suite/API/index verification is in progress; do not mark this batch complete before those checks finish. VM installation remains the independently verified 931fe6c1 build as requested for behavior-preserving refactors.

Batch-four queue from the complete current-source scan (638 findings): readReindexActivitySummary 39/55 (src/reindex/reindex-activity.ts:165), TsMorphSemanticProvider.addReferencesFromSourceFileScan.visit 23/58 (src/semantic/typescript/ts-morph-provider.ts:432), getIndexFreshness 37/31 (src/runtime/index-freshness.ts:46), isOutputSnapshotMetadata 37/3 (src/runtime/output-pagination.ts:1194), and withCompilerReferencedSupportingDeclarations 36/55 (src/queries/internal/connected-behavior.ts:546). Preserve partial telemetry confidence and counters; compiler symbol-cache and hierarchy-reference attribution; managed fingerprint reuse guards and generation/document checks; complete snapshot schema and hash validation; bounded causal traversal, stable deduplication/order, and source omission accounting. Exact source has been inspected for these targets. Start edits only after batch-three full-suite verification and commit.

### Batch three completion

All checks passed: 166 focused tests; full suite 3,088 tests across 350 files; build, source types, changed-file lint, format, public API and consumer, and skill links. Fresh indexed diff-impact maps 40 changed symbols in five source files to three affected files (documentation/tests excluded from the index). Current-source scan is accounted across 563 files, 12,315 implemented functions, with 638 complexity findings; all 563 files mapped, 47/47 dependency rows declared, no reported cycles or configured violations. Historical inventory now 33 fixed, six assessed-retained, 616 pending. The extracted emitCapturedOutputPage warning remains queued. Proceed with batch four above.

### Batch four implementation checkpoint

Separated activity file reading, validated-window selection, aggregate counters, language attribution, and automatic-run accounting. Its private summary type now guarantees every initialized counter, removing repeated defensive defaults while preserving optional fields in external records. Separated compiler identifier eligibility and cached target lookup from reference insertion and traversal, sharing location insertion for direct and hierarchy references. Separated metadata reading from freshness interpretation, managed snapshot reuse, and accepted generation/document checks. Split saved-page validation into invocation identity, content/page-table integrity, and timestamp checks. Split direct/nested supporting-declaration discovery from eligibility and materialization, sharing the owner-range/type exclusion.

| Target                                       | Before cyclomatic/cognitive | After |
| -------------------------------------------- | --------------------------- | ----- |
| readReindexActivitySummary                   | 39/55                       | 8/8   |
| addReferencesFromSourceFileScan.visit        | 23/58                       | 2/1   |
| getIndexFreshness                            | 37/31                       | 7/7   |
| isOutputSnapshotMetadata                     | 37/3                        | 6/3   |
| withCompilerReferencedSupportingDeclarations | 36/55                       | 7/8   |

Source types and lint pass. Focused verification: 152 tests across eight files passed, then all 54 pagination tests passed after adding 24 metadata tampering cases (176 distinct focused tests total). The new cases cover invocation identity, bounded strings, page size/count structure, content totals, timestamp bounds and page-table gaps; rejected continuations never execute the original action. Current-source review is accounted across 563 files and 12,340 functions. Two new helper warnings stay queued: nestedSupportingDeclarations 10/18, and addReferencesFromSourceFileScan.addIdentifierReferences 11/10. A mechanical extraction error in the freshness return was caught by type checks and existing tests and corrected before this checkpoint. Full suite/build/API/index validation is still in progress. Do not mark batch four complete until these finish. No VM reinstall is needed for these behavior-preserving edits.

The fresh batch-four scan reports 634 findings: six prior warnings resolved (the five named targets plus the direct-declaration callback) and two smaller helper warnings introduced. Batch-five queue: connectedBehaviorPacket 36/44 (src/queries/internal/connected-behavior.ts:154), readAffectedSetShadowStatus 36/26 (src/reindex/affected-shadow.ts:501), validateInvocationCoverage 36/52 (src/runtime/command-kit/command-execution.ts:539), factoryReturnedMemberCallbackImplementations 36/38 (src/symbols/graph/member-call-targets.ts:709), rustDefaultImplReferencesForDefinition 21/52 (src/semantic/rust/default-impl-references.ts:36). All five bodies have been read. Preserve packet anchor/connector selection and over-budget required nodes, matched/unmatched focus and omission coverage; telemetry schema/consistency and missing/malformed/version distinctions; coverage validation order and exact errors; factory ambiguity refusal, option-member traversal cap of 32 and callback deduplication; Rust default-reference ambiguity refusal, struct-literal brace scope and source cache. Existing focused tests include system-map, affected-shadow, cli-contract, member-call-targets and rust-default-impl-references. Do not edit these until batch four is validated and committed.

### Batch four completion

All verification passed: 176 distinct focused tests, 3,112 full-suite tests across 350 files, build, source types, changed-file lint, format, API/consumer, and skill links. Fresh index and diff-impact map 31 changed symbols in five source files to 11 affected files; documentation and tests are outside the index. Source scan accounted across 563 files and 12,340 functions, with 634 complexity findings. Six historical findings marked fixed, including the nested direct-declaration callback; two newly extracted helper warnings remain queued. Historical inventory: 39 fixed, six assessed-retained, 610 pending. Continue batch five above.

### Batch five implementation checkpoint

Separated behavior node selection, expansion, steps, transitions, paths and final status; eliminated a redundant connected-status test without changing results. Split shadow telemetry reading from decoding and consistency validation. Split invocation coverage validation by complete, known-incomplete and unknown totals, with separate continuation/resolution validation and unchanged error precedence. Separated factory discovery, parameter identification, bounded option-member traversal and callback target resolution. Split Rust default references into per-chunk accounting, explicit owner calls, struct update/literal scope and unattributed trait-call refusal. Preserved the existing source matching model; this is not a parser migration. Rust reference collection uses iteration so large result sets cannot exceed JavaScript call-argument limits.

| Target                                       | Before cyclomatic/cognitive | After |
| -------------------------------------------- | --------------------------- | ----- |
| connectedBehaviorPacket                      | 36/44                       | 5/2   |
| readAffectedSetShadowStatus                  | 36/26                       | 5/8   |
| validateInvocationCoverage                   | 36/52                       | 9/8   |
| rustDefaultImplReferencesForDefinition       | 21/52                       | 7/9   |
| factoryReturnedMemberCallbackImplementations | 36/38                       | 7/6   |

All 146 focused tests across five files pass. Source types and changed-file lint pass. Current-source review is accounted across 563 files and 12,367 functions. Three smaller helpers remain queued: reachedFactoryOptionMembers 12/16, expansiveBehaviorNodeIds 11/11, factoryOptionCallbackTargets 11/10. Source diff reviewed for policy, ordering and null/empty-result preservation. Build/full suite/API/index verification is next; batch five is not yet complete. No thresholds, suppressions or architecture rules changed, and no VM reinstall is needed.

Batch-six queue from the complete 632-finding scan: semanticReferenceMap profileSpan callback 26/52 (src/semantic/shared-primitives.ts:631), collectNextAnchorCallsiteCandidates 34/47 (src/queries/internal/next-anchor-candidates.ts:439), normalizeRequest 34/22 (src/queries/navigation/source-inspection.ts:494), isObservationReceiptV2 33/18 (src/domain/observation-receipt.ts:577), validateSuppressions 33/48 (src/runtime/config.ts:504). Bodies inspected. Preserve semantic fast-path precedence and optional callee prefetch/provider batching/profile counters; the three ordered candidate-evidence passes and their callsite-key reservation points, exact versus ambiguous counts and first-three alternative display; selector validation/error order and full/bounded inspection rules; receipt source/proof uniqueness, identity agreement and optional field validation; suppression diagnostic ordering, expiry and evidence checks without weakening any policy. Begin after batch-five verification and commit.

### Batch five completion

All checks passed: 146 focused tests, 3,112 full-suite tests across 350 files, build, source types, changed-file lint, format, API/consumer and skill links. Fresh index/diff-impact maps 36 changed symbols in five source files to eight affected files. Source scan accounted across 563 files and 12,367 functions; 632 complexity findings remain, with three extracted helper warnings explicitly queued. No configuration policy or suppression changes. Historical inventory now 44 fixed, six assessed-retained, 605 pending. Continue with batch six above; VM installation remains the verified build because these refactors preserve behavior.

### Batch six implementation checkpoint

Separated semantic provider grouping, Rust fast-path recording, combined reference/callee requests and result accounting. Preserved lazy provider lookup, default-before-SCIP precedence, prefetch before fast paths, absent-versus-empty map entries and profile counters. Separated the three ordered next-anchor candidate passes and shared graph-call selection and construction; preserved the different callsite-key reservation points, ambiguity counts and first-three alternative display. Split inspection normalization into ordered validation, bounds and evidence defaults. Split receipt validation into sources, proofs, identity facts, index and diagnostics without changing optionality or source/proof agreement. Split suppression validation by identity, file, expiry and decision, preserving diagnostic ordering and policy.

| Target | Before cyclomatic/cognitive | After |
| --- | --- | --- |
| semanticReferenceMap profile callback | 26/52 | 4/4 |
| collectNextAnchorCallsiteCandidates | 34/47 | 7/4 |
| normalizeRequest | 34/22 | 7/3 |
| isObservationReceiptV2 | 33/18 | 8/6 |
| validateSuppressions | 33/48 | 7/7 |

Focused verification: 335 distinct tests across 13 files pass (104 candidate/graph/inspection tests, 96 receipt/envelope tests, 100 configuration/suppression tests and 35 semantic-provider/cache tests). Source types and changed-file lint pass. Diff inspected for validation precedence, provider ordering and evidence attribution. One smaller helper remains queued: semanticReferenceMap.groupReferenceDefinitions 9/16. Build/full suite/API/index verification is pending. No thresholds, suppression policies or VM installation changes.

Batch-seven queue from the prior full scan (remaining ranks unchanged by batch-six review): similarAll pair-scan callback 21/49 (src/queries/cleanup/similar.ts:389), groupTwins compare-clusters callback 20/48 (src/queries/cleanup/twin-drift.ts:180), decodeCliOutputPageEnvelope 32/20 (src/runtime/output-pagination.ts:198), assignmentTargets 26/48 (src/semantic/typescript/local-flow.ts:1101), factoryReturnedMemberImplementations 30/48 (src/symbols/graph/member-call-targets.ts:640). Bodies inspected. Preserve pair visitation/order, focus filtering, signature and similarity gates, profile accounting and stable result ranking; twin delegation/stub exclusions, participating members, closest nonidentical pair and classification; exact envelope validation messages/order, counts and continuation requirements; destructuring defaults/use ordering, partial element writes and unresolved-target invalidation; unique factory resolution, returned property forms, source ranges and stable deduplication. Share candidate collection with similarAllCount where it removes the same duplicate scan. No edits until batch-six full verification and commit.

### Batch six completion

All checks passed: 335 focused tests, 3,112 full-suite tests across 350 files, build, source types, changed-file lint, format, public API/consumer and skill links. Initial reindex correctly refused a whole-project compiler fallback because the incremental service was unavailable; explicit --allow-expensive-rebuild completed in 20.3 seconds with cached Rust/Python shards. Fresh indexed diff-impact maps 21 changed symbols in five source files to one affected file. Source scan accounted across 563 files and 12,390 functions, with 628 complexity findings; all files mapped and 47/47 dependency rows declared, no reported cycles or configured violations. Historical inventory: 49 fixed, six assessed-retained, 600 pending. One new helper warning remains queued, and no thresholds or suppression policies changed. Continue with batch seven above. VM installation remains the verified behavior-equivalent build.

### Batch seven implementation checkpoint

Separated stable candidate enumeration from pair comparison/ranking; similarAll and similarAllCount now share the same later-callee candidate selection. Preserved focus filtering, profile counters, signature checks and tie ordering. Separated twin layer removal, pair eligibility, pair comparison and cluster materialization, preserving same-file/delegation/stub exclusions and participation. Split output envelope validation by common fields, counts and continuation consistency without changing error precedence. Split assignment target parsing into transparent wrappers, element writes, object properties and array targets; preserved use collection before unresolved-target refusal. Shared unique factory lookup with callback resolution and factored returned-property callable sites, preserving stable deduplication; collection remains iterative to avoid argument-count limits.

| Target | Before cyclomatic/cognitive | After |
| --- | --- | --- |
| similarAll pair-scan callback | 21/49 | 5/8 |
| groupTwins compare-clusters callback | 20/48 | 3/3 |
| decodeCliOutputPageEnvelope | 32/20 | 7/5 |
| assignmentTargets | 26/48 | 8/8 |
| factoryReturnedMemberImplementations | 30/48 | 10/13 |
| similarAllCount pair-scan callback (shared scan) | 20/46 | 5/8 |

167 focused tests across six files pass, including 21 new cases: eight malformed common envelope fields, five unsafe count fields, four inconsistent arithmetic cases, one final continuation page with an earlier omitted prefix, and three nested/destructured assignment cases with defaults. Source types, lint and diff review pass. No introduced finding in current-source diff review. The similarAll callback has duplicate anonymous identities in the existing source model, so automatic diff identity is uncomparable; the exact pair-scan before/after bodies establish the reported measurement. Full suite/build/API/index checks are pending. No VM reinstall is required for these behavior-preserving changes.

Batch-seven verification found one exact-token duplication after extraction: the similarAll and similarAllCount scan callbacks now share the same 93-token body. The complete source scan caught this despite diff identity ambiguity. Unify the remaining enumeration loop and retain per-set profile accounting before pair evaluation; rerun affected validation and refresh the complete scan before committing. Initial full scan: 622 complexity findings plus this one duplication across 563 files and 12,412 functions.

Batch-eight queue from that full scan: collectRuntimeBoundaryGraph 31/25 (src/analysis/runtime-boundaries/graph.ts:152), supportedLanguageFromPath 31/1 (src/queries/navigation/code.ts:721), tryMaterializeTypeScriptIncrementalIndex 31/38 (src/reindex/typescript-incremental-index.ts:466), docDrift 28/45 (src/queries/cleanup/doc-drift.ts:150), parseTypeScriptIndexEnvelope 30/13 (src/reindex/typescript-index-protocol.ts:100). Exact bodies read. Preserve runtime extraction/reuse predicates, phase timing and extractor coverage, direct/HTTP/carrier derivation order; canonical extension vocabulary including C headers and unknown extensions; index eligibility and dependency-graph capture/reuse, 128-document batch boundaries, first-batch modifications/deletions, tombstones, overlay identity/order, resource closure and memory-pressure rethrow; document archival/detail/snapshot eligibility, reference/co-change merging, last-change estimates, stable ranking and broken-reference weight; protocol v2/v4/v5 normalization, legacy bypass scope, common fields and operation identity computed from raw requests. Do not edit before batch seven is fully validated and committed.

### Batch seven completion

Final shared loop extraction removed the duplicate scan: similarAll and similarAllCount pair-scan callbacks now measure 1/0 each, delegating iteration to scanCalleePairs (3/3). Their distinct comparison/ranking and count behavior remains separate. All 167 focused tests passed; the full 3,133-test suite across 350 files passed before the final loop-sharing extraction, then the 28 affected similarity/command-accuracy tests passed afterward. Final source types, lint, build, formatting and public API/consumer passed; skill-link checks passed. Fresh index/diff-impact maps 25 changed symbols in five source files to 11 affected files. Final source health is accounted across 563 files and 12,415 functions, reporting 622 complexity findings and no duplication, dependency cycles or configured violations; all files mapped, 47/47 dependency rows declared. Historical inventory: 55 fixed, six assessed-retained, 594 pending. No thresholds or suppression policies changed. Continue batch eight as recorded above; no VM reinstall is needed.

### Batch eight implementation checkpoint

Separated runtime-boundary extraction planning, derived-graph reuse proof/materialization, HTTP summaries and carrier derivation. Preserved reuse predicates, phase ordering, coverage metadata and asynchronous extraction. Replaced the canonical extension switch with its exact 30-entry lookup table, preserving lowercase conversion and unknown-to-null behavior. Separated incremental index dependency planning, eligibility, bounded document requests and ordered batch writes/overlay commits. Preserved first-project-batch modifications/deletions, tombstones, generation chaining, base-shard/project-identity flags, status messages and memory-pressure rethrow; graph timing still ends before eligibility checks. Separated document selection from reference/co-change merging and per-document ranking. Separated legacy normalization, common fields, mailbox identity and current-protocol operation verification; operation keys still use the original wire request.

| Target | Before cyclomatic/cognitive | After |
| --- | --- | --- |
| collectRuntimeBoundaryGraph | 31/25 | 9/6 |
| supportedLanguageFromPath | 31/1 | 2/0 |
| tryMaterializeTypeScriptIncrementalIndex | 31/38 | 9/10 |
| docDrift | 28/45 | 6/6 |
| parseTypeScriptIndexEnvelope | 30/13 | 10/7 |

154 distinct focused tests across seven files pass: runtime boundaries, command accuracy, mailbox, incremental-index planning, reindex reliability, documentation drift and Git history. Source types, changed-file lint and diff review pass. No introduced finding in current-source review. Build/full suite/API/index verification is pending. No thresholds or suppressions changed, and no VM reinstall is needed for these behavior-preserving refactors.

Batch-nine queue from the complete 617-finding source scan: scanRepositoryText 21/44 (src/source/primitives/repository-text.ts:104), buildProjectInputFingerprintFromJournal 29/37 (src/platform/project-files.ts:696), modelBody.visitStatement 29/32 (src/queries/quality/slice-cohesion.ts:831), renderHealthReport 29/36 (src/runtime/cli-support.ts:1294), isPassthroughBody 29/29 (src/source/facts/source-callables.ts:207). Exact bodies read. Preserve streaming literal/full-text branches, skipped-file classification and semantic/count accounting before inclusion filtering; journal validation precedence, configured marker semantics, validation-before-mutation and sorted delta publication/cache persistence; predicate/guard stack, branch scope, loop unit order, try-handler region membership, labeled/jump/declaration units; health report text, order, policy/coverage calibration and action suffixes; sole-statement call shape, language-specific call forms, rejecting call-returned handlers and parameter defaults, positional identity forwarding. Start edits after batch-eight verification and commit.

### Batch eight completion

All checks passed: 154 focused tests, full suite 3,133 tests across 350 files, build, source types, changed-file lint, format, public API/consumer and skill links. Fresh index/diff-impact maps 21 changed symbols in five source files to 14 affected files. Source health accounted across 563 files and 12,434 functions, with 617 complexity findings and no reported duplication, dependency cycles or configured violations; all files mapped and 47/47 dependency rows declared. Historical inventory: 60 fixed, six assessed-retained, 589 pending. No new helper warnings, threshold changes or suppression-policy changes. Continue batch nine above; the VM does not need reinstalling for these behavior-preserving changes.

### Batch nine implementation checkpoint

Separated streaming literal probes from file-read recovery and final text materialization. Kept byte/text/semantic accounting before user inclusion filters and preserved missing/binary/unreadable/oversized distinctions. Separated journal readiness, source-entry validation and fingerprint updates; all entry validation still precedes filesystem mutation and only a successful delta persists the fingerprint cache. Split slice statement traversal into conditional, loop, exception and ordinary statement classification while preserving predicate stacks, exit guards, try/handler ranges and unit order. Split health rendering by section and gave positive finding rows an ordered table with lazy formatting. Split passthrough detection into direct-call shape and parameter-name validation without weakening defaults/call-returned-handler refusal.

| Target | Before cyclomatic/cognitive | After |
| --- | --- | --- |
| scanRepositoryText | 21/44 | 10/15 |
| buildProjectInputFingerprintFromJournal | 29/37 | 7/6 |
| modelBody.visitStatement | 29/32 | 9/9 |
| renderHealthReport | 29/36 | 8/9 |
| isPassthroughBody | 29/29 | 10/11 |

153 focused tests across eight files pass, including three new health-rendering cases covering no-action warning/coverage wording and all 12 positive finding rows with weighted counts. Types, changed-file lint and diff review pass. Two smaller helper warnings remain in the ranked queue: directForwardedCall 15/11 and journalEntryValidationReason 13/17. Build/full suite/API/index checks are pending. No thresholds, suppression policy or VM installation changes.

Batch-ten queue from the complete 614-finding scan: collectNextAnchorGraphRelationCandidates 27/43 (src/queries/internal/next-anchor-candidates.ts:245), buildTypeContainerMap 17/43 (src/source/facts/source-type-containers.ts:4), getJsTestExclusions 28/38 (src/analysis/framework-patterns.ts:114), decodeProjectInputChangeJournal 28/20 (src/domain/project-input-change-journal.ts:44), probeProjectFileBytesForLiterals 28/40 (src/platform/project-files.ts:271). Exact bodies read. Preserve causal-call/runtime/reference separation and counters, source line fallback, returned-alternative exclusion and behavior-line matching; Rust alias/field containers, Python superclass/type annotations and self-link refusal; source prefilter before AST/cache access, top-level test/hook eligibility and suppression order; bounded journal schema, entry/path uniqueness and completeness reasons; snapshot/live-read policies, literal/UTF-8 carry across chunks, optional hashes, identity revalidation, matched-only byte materialization and descriptor cleanup. Do not edit before batch-nine verification and commit.

### Batch nine completion

All checks passed: 153 focused tests, full suite 3,136 tests across 350 files, build, source types, changed-file lint, format, public API/consumer and skill links. Fresh index/diff-impact maps 17 changed symbols in five source files to seven affected files. Current-source health is accounted across 563 files and 12,463 functions, with 614 complexity findings and no reported duplication, dependency cycles or configured violations; all files mapped, 47/47 dependency rows declared. Historical inventory: 65 fixed, six assessed-retained, 584 pending. Two newly extracted helper warnings remain in the queue. Continue batch ten above. No thresholds/suppression policy changes or VM reinstall.

### Batch ten expanded to fifteen

User increased the batch size from five to fifteen on September 7. This applies to this in-progress batch and all subsequent batches. The same ranking, behavior preservation, no-suppression policy and verification requirements apply.

1. collectNextAnchorGraphRelationCandidates: cyclomatic 27, cognitive 43. `src/queries/internal/next-anchor-candidates.ts`.
2. buildTypeContainerMap: cyclomatic 17, cognitive 43. `src/source/facts/source-type-containers.ts`.
3. getJsTestExclusions: cyclomatic 28, cognitive 38. `src/analysis/framework-patterns.ts`.
4. decodeProjectInputChangeJournal: cyclomatic 28, cognitive 20. `src/domain/project-input-change-journal.ts`.
5. probeProjectFileBytesForLiterals: cyclomatic 28, cognitive 40. `src/platform/project-files.ts`.
6. programStateTemporalElementsForTopologyNodes: cyclomatic 28, cognitive 38. `src/queries/graph/program-state-temporal-edges.ts`.
7. touchExistingWorktreeLease: cyclomatic 28, cognitive 12. `src/reindex/shared-generation-store.ts`.
8. mayUseQueryServiceFastPath: cyclomatic 28, cognitive 2. `src/runtime/cli.ts`.
9. handleDead.<callback:budgetedDbCommand:1>: cyclomatic 28, cognitive 31. `src/runtime/query-commands/cleanup/handlers.ts`.
10. TsMorphSemanticProvider.addHierarchyMemberReferences: cyclomatic 22, cognitive 42. `src/semantic/typescript/ts-morph-provider.ts`.
11. cleanupPlan: cyclomatic 20, cognitive 41. `src/queries/cleanup/cleanup-plan.ts`.
12. httpExtractor.extract.<callback:visitDescendantsOfType:2>: cyclomatic 27, cognitive 27. `src/analysis/runtime-boundaries/extractors.ts`.
13. downloadVerifiedBinary: cyclomatic 27, cognitive 29. `src/platform/verified-binary-fetch.ts`.
14. reachesSameNameTarget: cyclomatic 27, cognitive 36. `src/queries/cleanup/twin-drift.ts`.
15. finalizeSystemMap: cyclomatic 27, cognitive 11. `src/queries/graph/system-map.ts`.

Cross-language containment assertions passed on the original implementation before extraction. Each additional target will be inspected for its decisions, effects, ordering and cleanup before editing.

### Parallel expansion authorized

The user requested independent subagent sets and combined validation to accelerate cleanup. The environment permits three concurrent subagents; each is assigned ten ranked symbols with exclusive source-file ownership, using Astra medium. The root agent retains its fifteen-file batch. Workers record their results in separate checkpoint files, avoid changing shared docs and build artifacts, and do not commit. Integration validates the combined tree.

Worker 1: targets in `/tmp/complexity-parallel-1-targets.json`; durable record `docs/plans/2026-09-07-complexity-worker-1.md`.

- decodeCliJsonEnvelope: cyclomatic 27, cognitive 27. `src/runtime/cli-json-envelope.ts`.
- catalogExplorationRoutes: cyclomatic 23, cognitive 40. `src/queries/internal/exploration-topology.ts`.
- selectExplorationTopology: cyclomatic 26, cognitive 28. `src/queries/internal/exploration-topology.ts`.
- validPersistedRange: cyclomatic 26, cognitive 5. `src/runtime/source-emission-session.ts`.
- parseProcessFileLockRecord: cyclomatic 25, cognitive 12. `src/platform/process-file-lock.ts`.
- repositoryContext: cyclomatic 25, cognitive 12. `src/queries/impact/context.ts`.
- validateWatchConfig: cyclomatic 25, cognitive 25. `src/runtime/config.ts`.
- parseBenchmarkCommand: cyclomatic 24, cognitive 4. `scripts/benchmark-query-service.ts`.
- buildRepositoryContextSourcePacket: cyclomatic 24, cognitive 34. `src/queries/impact/context.ts`.
- parseOverlayManifest: cyclomatic 24, cognitive 11. `src/reindex/typescript-overlay-store.ts`.

Worker 2: targets in `/tmp/complexity-parallel-2-targets.json`; durable record `docs/plans/2026-09-07-complexity-worker-2.md`.

- printJsonEnvelope: cyclomatic 27, cognitive 31. `src/runtime/command-kit/command-execution.ts`.
- truncateAtImplementationStart: cyclomatic 26, cognitive 30. `src/queries/cleanup/similar-signatures.ts`.
- reindex: cyclomatic 26, cognitive 24. `src/reindex/index.ts`.
- inflightClaims: cyclomatic 20, cognitive 38. `src/storage/bounded-mailbox.ts`.
- orientRecentDuplicate: cyclomatic 25, cognitive 24. `src/queries/cleanup/recent-duplicates.ts`.
- isClosureEdge.<callback:(edge.semantics ?? []).some:0>: cyclomatic 25, cognitive 21. `src/queries/internal/causal-corridor.ts`.
- prepareIndexerRun: cyclomatic 25, cognitive 27. `src/reindex/index.ts`.
- rowIdentity: cyclomatic 24, cognitive 13. `scripts/score-detector-labels.ts`.
- isTraversableEdge.<callback:(edge.semantics ?? []).some:0>: cyclomatic 24, cognitive 21. `src/queries/internal/causal-corridor.ts`.
- executeRequest: cyclomatic 24, cognitive 27. `src/runtime/query-service-server.ts`.

Worker 3: targets in `/tmp/complexity-parallel-3-targets.json`; durable record `docs/plans/2026-09-07-complexity-worker-3.md`.

- buildSetupSmokeTests: cyclomatic 27, cognitive 27. `src/runtime/project-setup.ts`.
- behaviorForNode: cyclomatic 26, cognitive 16. `src/queries/internal/connected-behavior.ts`.
- focusLinesForNode: cyclomatic 26, cognitive 30. `src/queries/internal/connected-behavior.ts`.
- factoryCallbackMemberTargets: cyclomatic 24, cognitive 38. `src/symbols/graph/member-call-targets.ts`.
- classifySimilarityEvidence: cyclomatic 25, cognitive 28. `src/queries/cleanup/similar.ts`.
- parseReindexActivityRecord: cyclomatic 25, cognitive 16. `src/reindex/reindex-activity.ts`.
- coChangePairsFromHistory: cyclomatic 24, cognitive 37. `src/analysis/git-history.ts`.
- resolveMember: cyclomatic 15, cognitive 36. `src/analysis/runtime-boundaries/object-members.ts`.
- collectFileMatches: cyclomatic 24, cognitive 22. `src/queries/navigation/source-search-batch.ts`.
- materializeSemanticCalleeCache.<callback:profileSpan:1>: cyclomatic 14, cognitive 36. `src/semantic/symbol-evidence.ts`.

### Root fifteen implementation checkpoint

The root-owned targets are implemented; this is an intermediate checkpoint, not a completed combined validation or commit. The first source review measured all fifteen below the existing warning thresholds. Three extracted helpers initially exceeded those thresholds and were split by source eligibility, hook declaration kind and bounded journal entry validation. One existing boundary-frontier callback moved under the new finalization phase; its unresolved/observed branches were then separated as well.

Preserved contracts:

- Graph anchors retain call/runtime/reference pass order, source eligibility, returned-alternative exclusions, strength and upstream/result/runtime counts. Source state/temporal construction retains mutation/value/temporal/unsupported ordering, map identities, unsupported frontiers and sorted blind spots. Full system-map finalization keeps topology-only early return, focused behavior, callback enrichment, corridor construction, recovery, counts and coverage.
- Type containment retains Rust field/variant/alias traversal, Python superclass and annotation consumers and TypeScript-like declarations without self-links. Framework exclusions retain source prefilter before AST/cache, current top-level declaration eligibility, test/hook/suppression order and cached results.
- Change journals retain schema, canonical relative paths, unique paths, entry/byte bounds and completeness explanations. File probes retain snapshot/live separation, bounded scratch reads, cross-chunk literals and UTF-8 carries, optional hashes, identity rechecks, matched-only byte materialization and descriptor cleanup.
- Lease touching still rechecks pointer, worktree ownership and accepted generation under the same repository lock before its 60-second throttle or durable write; failures return null and the lock is released. CLI fast-path command membership and required flags/profile exclusions are unchanged; its lookup set initializes before the entrypoint executes.
- Dead output retains category filters, exhaustive JSON groups/totals, 20-row human limits, complete LOC/count totals, explanations, ordering and empty behavior. Cleanup cascades retain pending/visited/blocked state, eligibility checks, predecessor-batch removal semantics and maximum depth. Hierarchy references retain ancestor and sibling-family insertion and profile counts.
- HTTP extraction retains decorator, Axum, fetch and method/client branch precedence and evidence strengths. Download verification retains abort/error classification, declared and observed length/checksum validation before promotion, descriptor ownership and staged-file cleanup. Twin delegation retains alias rules, receiver/import/re-export paths, three-hop bound and shared visited set.

Checks so far: 156 first-five tests in seven files, 98 middle tests in eleven files and 153 last-five tests in five files passed (system-map tests overlap; do not sum these as distinct). Cross-language containment assertions passed before and after extraction. Source types passed before the final helper cleanups. New output/journal tests and final focused reruns are in progress. Workers are still editing their exclusive files; full build, suite, API, fresh source scan and diff impact remain pending.

### Parallel review checkpoint

Root reviewed the combined source diffs. Worker 1 corrected a newly extracted overlay-header assertion so it proves only header fields and an unknown-record array; each record gets its own runtime validation. Worker 2 restored the existing reindex annotation to its original function and protected the service dispatch table against inherited object keys while retaining its old code fallback. Root requested preserving the original semantic-array `some` witness even for sparse arrays. Worker 3 corrected readonly source-line parameter contracts after the provisional typecheck.

The provisional combined source review correctly reported incomplete coverage when three worker files changed during analysis. Its deltas are not a completed review; repeat on the frozen tree before committing. It also identified several remaining target/helper warnings; workers have addressed those and the final scan must confirm them. Root's last causal-anchor helper now isolates callsite source rendering; its six focused tests pass. Added dead-output and journal-bound tests passed in the final 99-test focused run. Root changed-file ESLint passes. Worker-specific test and behavior details are in each worker checkpoint.

### Next parallel wave prepared

The first parallel wave reduced current complexity findings from 614 to 568 across 563/563 eligible source files; full tests are still running. The following assignments are prepared from that frozen, accounted scan. Do not begin source edits until the first wave passes verification and is committed.

root: targets `/tmp/complexity-wave2-root-targets.json`.

- parseSharedGenerationManifest: cyclomatic 27, cognitive 11. `src/reindex/shared-generation-store.ts`.
- handleSliceCohesion.<callback:budgetedDbCommand:1>: cyclomatic 22, cognitive 40. `src/runtime/query-commands/cleanup/handlers.ts`.
- sourceRangeNextAnchorPacket: cyclomatic 24, cognitive 38. `src/queries/internal/next-anchor-candidates.ts`.
- systemMapLiteralMatches: cyclomatic 24, cognitive 31. `src/queries/graph/system-map.ts`.
- validateIndexerAndSemanticConfig: cyclomatic 24, cognitive 33. `src/runtime/config.ts`.
- parseTypeScriptSemanticEnvelope: cyclomatic 24, cognitive 10. `src/semantic/typescript/session-protocol.ts`.
- extractPublicExports: cyclomatic 21, cognitive 35. `scripts/api-surface-contract.mjs`.
- summarizeClosures: cyclomatic 13, cognitive 35. `src/queries/quality/slice-cohesion.ts`.
- parseSourceSearchInvocation: cyclomatic 22, cognitive 35. `src/runtime/query-service-fastpath.ts`.
- tokenizeTsSafe: cyclomatic 17, cognitive 35. `src/source/primitives/source-stripper.ts`.
- validateSupportedMetadata: cyclomatic 23, cognitive 19. `src/domain/reindex-metadata.ts`.
- fingerprintProjectFile: cyclomatic 23, cognitive 23. `src/platform/project-files.ts`.
- executeSystemMap: cyclomatic 23, cognitive 15. `src/queries/graph/system-map.ts`.
- systemMapTopologyOwnerNodes: cyclomatic 23, cognitive 25. `src/queries/graph/system-map.ts`.
- buildHealthValidation: cyclomatic 23, cognitive 16. `src/queries/health/health-report.ts`.

worker-1: targets `/tmp/complexity-wave2-worker-1-targets.json`.

- captureOutputSnapshotPage: cyclomatic 23, cognitive 21. `src/runtime/output-pagination.ts`.
- parseCachedDefinition: cyclomatic 23, cognitive 9. `src/symbols/definition-catalog.ts`.
- programDataElementsForSystemMapRelations: cyclomatic 21, cognitive 33. `src/queries/graph/program-data-edges.ts`.
- isTypeScriptIndexRequest: cyclomatic 22, cognitive 7. `src/reindex/typescript-index-protocol.ts`.
- targetedCallerRowsMapForSymbols: cyclomatic 22, cognitive 26. `src/symbols/graph/call-graph-evidence.ts`.
- productionCallableDefinitions: cyclomatic 21, cognitive 31. `src/queries/internal/production-callables.ts`.
- sweepRepositoryCacheDirectory: cyclomatic 21, cognitive 24. `src/runtime/repository-cache-lifecycle.ts`.
- handleCheckDeps: cyclomatic 19, cognitive 31. `src/runtime/commands/command-handlers.ts`.
- findCallerFiles: cyclomatic 15, cognitive 31. `src/symbols/identifier-attribution.ts`.
- isObservationReceiptV1: cyclomatic 20, cognitive 10. `src/domain/observation-receipt.ts`.

worker-2: targets `/tmp/complexity-wave2-worker-2-targets.json`.

- parseLedger: cyclomatic 23, cognitive 8. `src/runtime/source-emission-session.ts`.
- maintainBoundedMailboxUnlocked: cyclomatic 16, cognitive 34. `src/storage/bounded-mailbox.ts`.
- deadCandidateDecision: cyclomatic 22, cognitive 22. `src/queries/internal/dead-candidate-gate.ts`.
- <callback:program.hook:1>: cyclomatic 22, cognitive 25. `src/runtime/cli-main.ts`.
- materializeBoundedLinks: cyclomatic 19, cognitive 32. `src/analysis/runtime-boundaries/graph.ts`.
- boundarySourceHashes: cyclomatic 21, cognitive 24. `src/analysis/runtime-boundaries/graph.ts`.
- decodeCurrentCorrelation: cyclomatic 21, cognitive 7. `src/semantic/rust/durable-session-protocol.ts`.
- decodeDurableRustMailboxResponse: cyclomatic 21, cognitive 15. `src/semantic/rust/durable-session-protocol.ts`.
- parseArgs: cyclomatic 20, cognitive 21. `scripts/typescript-semantic-provider-comparison.mjs`.
- buildProjectChangeManifest: cyclomatic 20, cognitive 16. `src/domain/project-input.ts`.

worker-3: targets `/tmp/complexity-wave2-worker-3-targets.json`.

- recordClojureMembers: cyclomatic 23, cognitive 30. `src/source/facts/clojure-facts.ts`.
- benchmarkArguments: cyclomatic 22, cognitive 12. `scripts/benchmark-query-service.ts`.
- planTypeScriptIncrementalUpdate: cyclomatic 22, cognitive 18. `src/reindex/typescript-incremental-index.ts`.
- TsMorphSemanticProvider.referencesForDefinitionsBySymbolScan.<callback:profileSpan:1>: cyclomatic 22, cognitive 25. `src/semantic/typescript/ts-morph-provider.ts`.
- TsMorphSemanticProvider.semanticCalleeForCallNode: cyclomatic 22, cognitive 33. `src/semantic/typescript/ts-morph-provider.ts`.
- validateJsonOutputOptions: cyclomatic 21, cognitive 22. `src/runtime/commands/command-registry.ts`.
- behaviorReceipt: cyclomatic 21, cognitive 18. `src/source/facts/behavior-skeleton.ts`.
- TsMorphSemanticProvider.calleeCoverageForDefinitions.visit: cyclomatic 14, cognitive 31. `src/semantic/typescript/ts-morph-provider.ts`.
- stronglyConnectedComponents: cyclomatic 11, cognitive 30. `src/analysis/strongly-connected-components.ts`.
- flattenRustUseTree: cyclomatic 20, cognitive 14. `src/language-parsers/languages/rust.ts`.

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


### Second parallel complexity wave in integration

All 45 selected targets are implemented. To balance elapsed time after workers finished their original sets, root transferred the untouched `system-map.ts` file (three targets) to worker 1 and `next-anchor-candidates.ts` (one target) to worker 3. Final ownership is root 11, worker 1 13, worker 2 10, worker 3 11, with no shared file editors. Worker checkpoints record the transfers.

All lanes are frozen for integration. Root reviewed worker 1; workers reviewed each other's lanes and root's changes. Focused tests passed. Initial combined review identified one new fingerprint helper above the limit; separating cache lookup from bounded content hashing removed it. Source typecheck identified a callable-owner helper type missing its `name` property; the responsible worker is correcting the type before build. Final build, full-suite tests, fresh source scan and indexed impact are pending. No coverage-based CRAP claim or agent benchmark is planned.


### Third parallel complexity wave prepared

Prepared from the frozen second-wave source scan: 522 remaining findings across 563/563 eligible files. Begin source edits only after second-wave full tests pass and its changes are committed. All 45 targets are the highest current findings by reported score; complete file ownership keeps multiple functions from one file in the same lane. Root takes nine targets to leave time for integration; each Astra-medium worker takes twelve.

root: `/tmp/complexity-wave3-root-targets.json`

- `reportUnknownConfigKeys` — 17, cognitive 34. (`src/runtime/config.ts`).
- `buildHealthActions` — 22, cognitive 26. (`src/queries/health/health-report.ts`).
- `compareApiSurfaces` — 21, cognitive 22. (`scripts/api-surface-contract.mjs`).
- `createDeclarationResolver.resolveExport` — 20, cognitive 29. (`scripts/api-surface-contract.mjs`).
- `clusterOutputs` — 15, cognitive 30. (`src/queries/quality/slice-cohesion.ts`).
- `parseManifest` — 19, cognitive 8. (`src/reindex/typescript-fragment-store.ts`).
- `readQueryServiceServerState` — 19, cognitive 9. (`src/runtime/query-service.ts`).
- `parseSqliteGenerationReaderLease` — 19, cognitive 8. (`src/storage/sqlite-generation.ts`).
- `renderTimeStateWrites.visit` — 15, cognitive 28. (`src/queries/quality/slice-cohesion.ts`).

worker-1: `/tmp/complexity-wave3-worker-1-targets.json`

- `expandRuntimeBoundaryFrontier` — 22, cognitive 24. (`src/queries/graph/system-map.ts`).
- `systemMapTopologyRelationEndpoint` — 20, cognitive 15. (`src/queries/graph/system-map.ts`).
- `compareNeutralNextAnchors` — 20, cognitive 1. (`src/queries/internal/next-anchor-candidates.ts`).
- `buildInspection` — 18, cognitive 30. (`src/queries/navigation/source-inspection.ts`).
- `detectCoarseBoundaries` — 13, cognitive 29. (`src/queries/graph/architecture.ts`).
- `parseSkillCommands` — 19, cognitive 17. (`scripts/render-command-reference.ts`).
- `sourceBindingOwnerAtLine` — 19, cognitive 16. (`src/queries/graph/system-map.ts`).
- `collectRemovedReferences` — 19, cognitive 22. (`src/queries/impact/newly-unreferenced-residue.ts`).
- `newlyUnreferencedResidue` — 19, cognitive 19. (`src/queries/impact/newly-unreferenced-residue.ts`).
- `createExplorationTopology` — 19, cognitive 15. (`src/queries/internal/exploration-topology.ts`).
- `inferKindNumber` — 19, cognitive 21. (`src/queries/navigation/by-kind.ts`).
- `codeBatchText` — 16, cognitive 28. (`src/runtime/query-commands/direct-navigation.ts`).

worker-2: `/tmp/complexity-wave3-worker-2-targets.json`

- `parseFastPathInvocation` — 22, cognitive 21. (`src/runtime/query-service-fastpath.ts`).
- `queryNavigationFastPath` — 20, cognitive 3. (`src/runtime/query-service-fastpath.ts`).
- `decodeDurableRustMailboxRequest` — 20, cognitive 16. (`src/semantic/rust/durable-session-protocol.ts`).
- `isIndexedDefinition` — 20, cognitive 5. (`src/semantic/rust/durable-session-protocol.ts`).
- `readDurableRustSessionServerState` — 20, cognitive 15. (`src/semantic/rust/durable-session.ts`).
- `runRustAnalyzerReferenceBatch` — 20, cognitive 17. (`src/semantic/rust/lsp-batch-worker.ts`).
- `RustAnalyzerLspClient.handleData` — 15, cognitive 30. (`src/semantic/rust/lsp-client.ts`).
- `decodeSemanticAvailability` — 20, cognitive 15. (`src/semantic/types.ts`).
- `ensureEvidenceCommandFreshness` — 19, cognitive 23. (`src/runtime/evidence-command-freshness.ts`).
- `parseCodeInvocation` — 19, cognitive 26. (`src/runtime/query-service-fastpath.ts`).
- `materializeSemanticReferenceBatch.<callback:profileSpan:1>` — 13, cognitive 28. (`src/semantic/shared-primitives.ts`).
- `claimBoundedMailboxRequestsUnlocked` — 17, cognitive 28. (`src/storage/bounded-mailbox.ts`).

worker-3: `/tmp/complexity-wave3-worker-3-targets.json`

- `loadGrammar` — 20, cognitive 4. (`src/source/ast/ast-runtime.ts`).
- `isStructuralEntryPath` — 20, cognitive 10. (`src/source/primitives/file-kind.ts`).
- `scoreLabels` — 18, cognitive 29. (`scripts/score-detector-labels.ts`).
- `parseScalaImportsAst` — 15, cognitive 29. (`src/language-parsers/languages/jvm.ts`).
- `runLeafCorpus` — 19, cognitive 23. (`scripts/affected-set-shadow-contract.mjs`).
- `parseCodexJsonl` — 19, cognitive 26. (`scripts/codex-exploration-trial-core.mjs`).
- `summarizeParsedJson` — 19, cognitive 27. (`scripts/semantic-command-calibration.mjs`).
- `main` — 19, cognitive 18. (`skills/scip-explore/scripts/capture-evidence.mjs`).
- `summarizeLanguageActivity` — 19, cognitive 18. (`src/reindex/reindex-activity.ts`).
- `collectLocalSqliteGenerations` — 19, cognitive 21. (`src/reindex/sqlite-generation-store.ts`).
- `readLease` — 19, cognitive 7. (`src/runtime/repository-cache-lifecycle.ts`).
- `collectSuppressionExclusions.walk` — 13, cognitive 28. (`src/analysis/framework-patterns.ts`).



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


### Third wave root implementation checkpoint

Root's nine selected targets are implemented across seven exclusive files. Fragment, server-state and reader-lease validators separate header, identity and record checks while retaining parse-before-validation order and existing failure results. Config diagnostics preserve field traversal order and suppression decision/evidence paths. Slice analysis preserves effect-callback reachability, closure state-write merging, union-find grouping, cluster input sources and remainder selection. Health action groups preserve stable priority ordering. API comparison and recursive declaration resolution preserve classification precedence, visited-set isolation and both caches.

Focused root checks: 208 distinct tests across eight files passed (157 initial + 22 API/health + 29 SQLite generation; slice reruns overlap). Root ESLint and formatting pass. Source typecheck before the final API/health edits passed; final combined typecheck remains required. Existing API tests and lint caught a temporary automatic-semicolon-insertion error while extracting a return expression; it was corrected and all 14 API contract tests rerun successfully. No root source/test processes remain after these focused checks. Root reviewed worker 1's lane and confirmed a missed candidate-state reference and new spread argument limits were corrected by the owner; final worker reruns and combined validation remain pending.


Third-wave integration: all lanes frozen and no focused test processes remain. Worker 1: 244 distinct tests across ten files; worker 2: 216 across eleven, including nine TypeScript provider tests for cold/warm fragment cache reuse and leaf-edit invalidation; worker 3: 113 across thirteen, including three new script regressions. Root: 208 across eight. Counts overlap between lanes. All lanes received a second diff review; no unresolved review issues remain. The semantic cache result property typo found in cross-review was corrected before final typecheck.

Combined typecheck, contract fixture compilation and changed-file ESLint pass. Accounted full source review resolves 45 findings with no introduced/worsened findings. No new helper exceeds 10/15. The enclosing semantic reference materializer remains 16/20 and stays on the queue; only its selected cache-scan callback was simplified. Build, full suite, reindex, fresh health and diff impact are in progress.


### Fourth parallel complexity wave prepared

Prepared from the frozen third-wave source scan: 477 remaining complexity findings, 563/563 eligible files. All 45 assignments are the highest remaining reported scores, with whole-file ownership. Root takes nine targets and each worker twelve. Begin source edits only after the third wave passes the full suite and is committed. No thresholds, source scope, suppressions or architectural policy changes; preserve behavior and avoid external release or agent benchmark actions.

root: `/tmp/complexity-wave4-root-targets.json`

- `sanitizeTerminalText` — 18, cognitive 19. (`src/platform/terminal-output.ts`).
- `deferredHealthPhaseResult` — 18, cognitive 1. (`src/runtime/cli-support.ts`).
- `validateProjectHeaderConfig` — 18, cognitive 19. (`src/runtime/config.ts`).
- `isOutputSnapshotReservation` — 18, cognitive 6. (`src/runtime/output-pagination.ts`).
- `pruneAbandonedOutputSnapshots` — 18, cognitive 21. (`src/runtime/output-pagination.ts`).
- `isEntryPointResult.<callback:value.every:0>` — 18, cognitive 5. (`src/runtime/query-service.ts`).
- `validPersistedEvidenceItem` — 18, cognitive 5. (`src/runtime/source-emission-session.ts`).
- `validPublication` — 18, cognitive 10. (`src/storage/sqlite-generation.ts`).
- `isSuppressionDecision` — 17, cognitive 5. (`src/domain/suppression-adjudication.ts`).

worker-1: `/tmp/complexity-wave4-worker-1-targets.json`

- `coChange` — 18, cognitive 22. (`src/queries/cleanup/co-change.ts`).
- `docsCitingFiles.<callback:profileSpan:1>` — 15, cognitive 27. (`src/queries/cleanup/doc-drift.ts`).
- `computeFileLeafUsageFromAst` — 14, cognitive 27. (`src/queries/internal/consumer-evidence.ts`).
- `countBranchesFromRegex` — 15, cognitive 27. (`src/queries/quality/complexity.ts`).
- `containerAccesses` — 12, cognitive 27. (`src/queries/quality/slice-cohesion.ts`).
- `handleDocDrift.<callback:dbCommand:0>` — 15, cognitive 27. (`src/runtime/query-commands/cleanup/handlers.ts`).
- `sourceInspectionSections` — 18, cognitive 14. (`src/runtime/query-commands/navigation.ts`).
- `collectBehaviorCandidates` — 18, cognitive 15. (`src/source/facts/behavior-skeleton.ts`).
- `indexServiceReceivers.<callback:walk:1>` — 18, cognitive 13. (`src/symbols/graph/member-call-targets.ts`).
- `pickAstCallCandidate` — 17, cognitive 27. (`src/symbols/leaf-symbol-index.ts`).
- `testQuality` — 13, cognitive 26. (`src/queries/cleanup/test-quality.ts`).
- `modelBody` — 17, cognitive 22. (`src/queries/quality/slice-cohesion.ts`).

worker-2: `/tmp/complexity-wave4-worker-2-targets.json`

- `prepareSharedGenerationCache` — 18, cognitive 22. (`src/reindex/index.ts`).
- `deriveProjectDependencies` — 15, cognitive 27. (`src/reindex/project-shards.ts`).
- `stripJsonComments` — 16, cognitive 27. (`src/reindex/project-shards.ts`).
- `runtimeBoundaryAugmentationStage.run` — 18, cognitive 18. (`src/reindex/runtime-boundaries.ts`).
- `findSharedBaselineGeneration` — 18, cognitive 21. (`src/reindex/shared-generation-store.ts`).
- `hydrateSharedGeneration` — 18, cognitive 20. (`src/reindex/shared-generation-store.ts`).
- `inspectLocalSqliteGenerationRetention` — 18, cognitive 14. (`src/reindex/sqlite-generation-store.ts`).
- `commitTypeScriptOverlay` — 18, cognitive 11. (`src/reindex/typescript-overlay-store.ts`).
- `buildSweepInventory` — 18, cognitive 27. (`src/runtime/repository-cache-lifecycle.ts`).
- `Watcher.constructor` — 18, cognitive 1. (`src/runtime/watch.ts`).
- `resolveReindexWorkerLaunch` — 18, cognitive 5. (`src/runtime/watch.ts`).
- `buildFreshReindexShardDiagnostics` — 17, cognitive 24. (`src/reindex/index.ts`).

worker-3: `/tmp/complexity-wave4-worker-3-targets.json`

- `runNpmRelease` — 18, cognitive 21. (`scripts/npm-release.ts`).
- `deriveConsumerDiscriminators` — 13, cognitive 27. (`src/analysis/runtime-boundaries/carrier-discriminators.ts`).
- `deriveParameterRoles.<callback:walk:1>` — 18, cognitive 17. (`src/analysis/runtime-boundaries/http-summaries.ts`).
- `propagateCompilerResolvedHttpSummaries.<callback:recordSpan:1>` — 12, cognitive 27. (`src/analysis/runtime-boundaries/http-summaries.ts`).
- `formatUninstallReport` — 18, cognitive 27. (`src/runtime/uninstall.ts`).
- `isResponseForKind` — 18, cognitive 15. (`src/semantic/rust/durable-session-protocol.ts`).
- `collectExtensions` — 13, cognitive 26. (`src/reindex/detect.ts`).
- `parseCargoJsonDiagnostics` — 17, cognitive 26. (`src/runtime/cleanup-verify.ts`).
- `legacyDispositionForReason` — 17, cognitive 2. (`src/analysis/framework-patterns.ts`).
- `loadFileAddRecords` — 17, cognitive 25. (`src/analysis/git-history.ts`).
- `incompleteMigration` — 17, cognitive 20. (`src/queries/impact/incomplete-migration.ts`).
- `sameFileCallClosureForRange` — 17, cognitive 21. (`src/queries/navigation/code.ts`).



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


### Fourth parallel wave implementation checkpoint

All 45 assigned targets have been refactored across exclusive files. Root targets and new helpers are at or below cyclomatic 10 / cognitive 15; the whole-source review confirms no changed/added over-limit functions. Root focused validation passed 330 tests in eight files, followed by 101 tests in the two files affected by final splits. Eighteen new cases cover every deferred health payload, timeout metadata, mutable-result isolation, overview rejection and runtime unknown-phase fallthrough.

Read-only cross-review completed in four lanes: root reviewed worker 1; worker 1 reviewed worker 3; worker 3 reviewed worker 2; worker 2 reviewed root. Root typecheck/tests caught and corrected an extraction return-newline mistake in snapshot liveness. Co-change helper types now retain actual Git pair fields. Source typechecking and both contract fixture compiles pass. Lint identified a redundant reservation initialization, corrected without changing behavior. No thresholds, policies, source scope or suppressions changed.

Combined build/full-suite/fresh-index/source-health/impact and public API validation are next. All worker lanes are frozen, with no worker processes running. No release actions, external agent benchmarks or VM changes ran.


### Fifth parallel wave assignments, recorded before edits

Fresh fourth-wave health selected the following 45 remaining highest-scoring functions (score descending, stable identity tie-break), with whole-file ownership. Implementation starts only after fourth-wave validation and commit. All targets and new helpers must reach cyclomatic ≤10 / cognitive ≤15 while preserving behavior, parsing and evidence calibration; source policy is unchanged.

root:

- `src/reindex/reindex-activity.ts` — `isValidLanguageActivity` (17, cognitive 8.).
- `src/domain/claim-qualification.ts` — `isClaimCoverage` (16, cognitive 12.).
- `src/domain/project-config.ts` — `decodeProjectConfig` (16, cognitive 19.).
- `src/domain/suppression-adjudication.ts` — `isSuppressionCounterevidence` (16, cognitive 7.).
- `src/runtime/config.ts` — `validateDeclaredCouplings` (16, cognitive 23.).
- `src/runtime/query-service-fastpath.ts` — `parseEntryPointsInvocation` (16, cognitive 22.).
- `src/runtime/query-service.ts` — `isSourceSearchResult` (16, cognitive 4.).
- `src/platform/git-worktree.ts` — `parseGitWorktreeList` (16, cognitive 25.).
- `scripts/semantic-command-calibration.mjs` — `parseArgs` (16, cognitive 17.).

worker-1:

- `src/semantic/typescript/local-flow.ts` — `buildTryStatement` (17, cognitive 19.).
- `src/semantic/typescript/local-flow.ts` — `collectNodeAccesses.visit` (17, cognitive 17.).
- `src/source/facts/clojure-facts.ts` — `buildClojureSourceFacts` (17, cognitive 25.).
- `src/source/facts/source-calls.ts` — `callTargetForNode` (17, cognitive 16.).
- `src/source/react-profile.ts` — `reactCandidateForNode` (17, cognitive 17.).
- `src/symbols/graph/member-call-targets.ts` — `importedMemberCallTargets` (17, cognitive 20.).
- `src/symbols/graph/static-value-flow.ts` — `resolveMember` (17, cognitive 19.).
- `src/source/primitives/source-identifier-prefilter.ts` — `sourceMayContainCandidateName` (14, cognitive 25.).
- `src/symbols/references/reference-callers.ts` — `addRustAttrCallers` (11, cognitive 25.).
- `src/queries/graph/cycles.ts` — `classifyCycle` (16, cognitive 15.).
- `src/queries/internal/consumer-evidence.ts` — `nativeConsumerClassifyEntry` (16, cognitive 12.).
- `src/queries/internal/exploration-topology.ts` — `shortestDirectedAnchorPath` (16, cognitive 23.).

worker-2:

- `src/reindex/shared-generation-store.ts` — `publishSharedGenerationOwned` (17, cognitive 16.).
- `src/reindex/sqlite-generation-store.ts` — `materializeGeneration` (17, cognitive 15.).
- `src/runtime/index-freshness.ts` — `getPublishedIndexFreshness` (17, cognitive 15.).
- `src/runtime/project-readiness.ts` — `getProjectCapabilities` (17, cognitive 19.).
- `src/runtime/watch-service.ts` — `ensureWatchService` (17, cognitive 15.).
- `src/reindex/index.ts` — `classifyLanguageShardReuse` (16, cognitive 22.).
- `src/reindex/indexer-runner.ts` — `runPreparedIndexer` (16, cognitive 23.).
- `src/reindex/shared-generation-store.ts` — `managedGenerationMatchesFingerprint` (16, cognitive 7.).
- `src/reindex/shared-generation-store.ts` — `prepareSharedGenerationForProject` (16, cognitive 18.).
- `src/reindex/shared-generation-store.ts` — `publishFreshLocalGenerationForProject` (16, cognitive 13.).
- `src/runtime/project-readiness.ts` — `languageCapability` (16, cognitive 16.).
- `src/reindex/sanitize.ts` — `sanitizeScipBuffer` (14, cognitive 25.).

worker-3:

- `scripts/api-surface-contract.mjs` — `compareReferencedDeclarations` (16, cognitive 25.).
- `src/platform/typescript-projects.ts` — `typeScriptProjectSelectionIsTreeOwned` (16, cognitive 25.).
- `src/runtime/query-commands/cleanup/handlers.ts` — `handleLocalityCandidates.<callback:budgetedDbCommand:1>` (16, cognitive 25.).
- `scripts/accuracy-calibration.mjs` — `renderRelationshipPacket` (16, cognitive 3.).
- `scripts/accuracy-calibration.mjs` — `runResampleMode` (16, cognitive 17.).
- `scripts/accuracy-calibration.mjs` — `runSummarizeMode` (16, cognitive 16.).
- `skills/scip-explore/scripts/capture-evidence.mjs` — `projectCommandResult` (16, cognitive 9.).
- `src/analysis/runtime-boundaries/extractors.ts` — `capabilityDescriptorHandler` (16, cognitive 22.).
- `src/platform/process-tree.ts` — `terminateOwnedProcessTree` (16, cognitive 23.).
- `src/queries/cleanup/drift.ts` — `patternDeviationDrift` (11, cognitive 24.).
- `src/queries/navigation/evidence.ts` — `qualifiedEvidence` (16, cognitive 12.).
- `src/runtime/query-commands/navigation.ts` — `sourceInspectionSections.searchRows.<callback:result.searches.map:0>` (16, cognitive 9.).


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


### Fifth parallel wave root implementation checkpoint

Root's nine assigned functions have been refactored. Validators retain their original field acceptance and short-circuit order; config decoding retains malformed/unsupported/version/schema-hint precedence and unknown fields. Coupling diagnostics retain name/files/reason ordering. Entrypoint argument parsing retains required output flags, delimiter handling and fallback behavior. Git worktree parsing retains NUL record boundaries, first-space field splitting and final unterminated record handling. Calibration argument parsing retains value consumption, limits and early help/list exits.

Initial focused run passed 210 tests in seven files; the requested domain claim test filename did not exist, so the actual runtime claim-qualification suite was located and is included in final focused checks. Six new isolated calibration parser cases pass without executing any benchmark entrypoint. Owned-file ESLint passes. Initial source metrics showed parseGitWorktreeList still at 10/18; extracting field decoding reduces nested parsing choices, with exact metrics recheck pending. Other eight targets and introduced helpers were already ≤10/15. Early source typecheck encountered another lane's temporary return-newline mistake, since corrected there; final frozen typecheck remains required.

Root frozen: all nine targets and helpers now ≤10/15; Git record parser is 8/14. Final focused rerun passed 30 tests across worktree, actual claim-qualification and calibration parser suites (20 overlap the earlier 210). Root total is 220 distinct focused tests. Scoped metrics captured after-functions but reported incomplete whole-source coverage because peers were editing; combined frozen-source review remains authoritative. No root processes running.


### Sixth parallel wave assignments: expanded to 90 targets

The user requested more horizontal scale. This session allows four concurrent agents total, so the next wave uses root plus three Astra-medium workers with larger exclusive file sets: root 15 targets and each worker 25. Ninety highest-ranked current findings occupy 68 distinct source/script files; no file is assigned twice. Fresh fifth-wave health confirms the ranking and source locations. Workers may prepare read-only during fifth-wave validation; no sixth-wave edits start until fifth-wave commit.

Every selected target and new helper must reach cyclomatic ≤10 / cognitive ≤15 while preserving decisions, evidence, ordering, cleanup and parsing behavior. Use one initial source review per lane and selective correction rechecks to avoid repeatedly scanning the full project for each file. Combined frozen-source review, full tests, public API/consumer/skill checks, fresh source health and indexed impact remain required. No source-policy, suppression or threshold changes; no external agent benchmarks.

root:

- `src/runtime/result-pagination.ts` — `isResultKeysetCursorPayload` (16, cognitive 4.).
- `src/runtime/source-emission-session.ts` — `sourceChunks` (16, cognitive 14.).
- `src/semantic/rust/durable-session-protocol.ts` — `isRustReferenceWorkerRequest` (16, cognitive 3.).
- `scripts/incremental-freshness-contract.mjs` — `parseArgs` (15, cognitive 16.).
- `src/runtime/cli-support.ts` — `parseHealthSemanticPrewarmMarker` (15, cognitive 14.).
- `src/runtime/output-pagination.ts` — `isLegacyOutputCursorPayload` (15, cognitive 3.).
- `src/runtime/output-pagination.ts` — `isOutputSnapshotPage` (15, cognitive 3.).
- `src/runtime/query-service-fastpath.ts` — `parseOutlineInvocation` (15, cognitive 20.).
- `src/runtime/query-service.ts` — `isOutlineResult` (15, cognitive 9.).
- `src/runtime/query-service.ts` — `isSymbolResolutionResult` (15, cognitive 5.).
- `src/runtime/query-service.ts` — `parseQueryServiceResponse` (15, cognitive 10.).
- `src/runtime/watch-service-prune.ts` — `assertWatcherArtifactsBelongToRoot` (15, cognitive 12.).
- `src/storage/bounded-mailbox.ts` — `completeBoundedMailboxClaim` (15, cognitive 13.).
- `src/reindex/worker.ts` — `parseTypeScriptWorkerConfig` (14, cognitive 11.).
- `src/runtime/cleanup-verify.ts` — `parseRuffJsonDiagnostics` (14, cognitive 21.).

worker-1:

- `src/semantic/rust/import-usage.ts` — `flattenRustUseTreePositions` (16, cognitive 7.).
- `src/source/facts/behavior-skeleton.ts` — `buildBehaviorOutline.emitNode` (16, cognitive 15.).
- `src/source/facts/behavior-skeleton.ts` — `addSwitchControlFacts` (15, cognitive 13.).
- `src/source/facts/behavior-skeleton.ts` — `behaviorSkeleton` (15, cognitive 10.).
- `src/source/facts/source-callables.ts` — `namedCallableNode` (16, cognitive 14.).
- `src/source/facts/source-callables.ts` — `directForwardedCall` (15, cognitive 11.).
- `src/symbols/graph/file-dep-graph.ts` — `fileDependencyPaths` (11, cognitive 24.).
- `src/symbols/graph/file-dep-graph.ts` — `isFileDependencyGraphPayload` (15, cognitive 7.).
- `src/symbols/references/reference-callers.ts` — `addAstCallsiteCallers` (13, cognitive 24.).
- `src/source/react-profile.ts` — `recordJsxElement` (14, cognitive 23.).
- `src/symbols/references/source-reference-scan.ts` — `scanSourceReferences` (15, cognitive 23.).
- `src/queries/internal/exploration-topology.ts` — `addAdjacentJunctions` (15, cognitive 17.).
- `src/queries/internal/next-anchor-candidates.ts` — `enrichResultCallbackControlSemantics` (15, cognitive 21.).
- `src/queries/quality/slice-cohesion.ts` — `sliceCohesionForDefinition` (15, cognitive 11.).
- `src/queries/quality/slice-cohesion.ts` — `projectFlowDependencies` (13, cognitive 21.).
- `src/semantic/typescript/local-flow.ts` — `addCrossCallableCandidates` (15, cognitive 21.).
- `src/semantic/typescript/local-flow.ts` — `isUseNode` (15, cognitive 13.).
- `src/semantic/typescript/local-flow.ts` — `addReachingDefinitionEdges` (11, cognitive 22.).
- `src/semantic/typescript/local-flow.ts` — `computePostdominators` (11, cognitive 22.).
- `src/source/facts/state-temporal-analysis.ts` — `mutationFact` (15, cognitive 11.).
- `src/source/vue/vue-profile.ts` — `buildBehaviorTokens` (15, cognitive 14.).
- `src/symbols/graph/member-call-targets.ts` — `resolveCallableTargetDefinitions` (15, cognitive 13.).
- `src/symbols/graph/member-call-targets.ts` — `serviceDeclarationFilesForImplementation` (13, cognitive 22.).
- `src/queries/impact/context.ts` — `discoverAffectedConsumerReuse` (10, cognitive 23.).
- `src/queries/internal/causal-corridor.ts` — `isSelectedCorridorEvidence.<callback:(edge.semantics ?? []).some:0>` (14, cognitive 16.).

worker-2:

- `src/runtime/setup.ts` — `uninstallSkills` (11, cognitive 23.).
- `src/reindex/shared-generation-store.ts` — `validateSourceGeneration` (15, cognitive 14.).
- `src/reindex/typescript-index-requester.ts` — `decodeDocumentResponse.fragments.<callback:response.fragments.map:0>` (15, cognitive 4.).
- `src/reindex/typescript-index-service.ts` — `TypeScriptIndexServiceHost.constructor` (15, cognitive 7.).
- `src/runtime/project-setup.ts` — `remediateIndexers` (15, cognitive 14.).
- `src/runtime/watch.ts` — `Watcher.handleFileChange` (15, cognitive 11.).
- `src/semantic/typescript/session-service.ts` — `TypeScriptSemanticServiceHost.status` (15, cognitive 12.).
- `src/reindex/affected-shadow.ts` — `collectAffectedSetShadowRecord` (14, cognitive 12.).
- `src/reindex/index.ts` — `collectIndexerOutputs` (10, cognitive 21.).
- `src/reindex/index.ts` — `publishFreshReindexArtifacts` (14, cognitive 13.).
- `src/reindex/shared-generation-store.ts` — `readSharedGeneration` (14, cognitive 10.).
- `src/reindex/sqlite-generation-store.ts` — `ensureImmutableSqliteGeneration` (14, cognitive 11.).
- `src/reindex/typescript-compiler-shards.ts` — `partitionTypeScriptCompilerInputsIntoShards` (14, cognitive 16.).
- `src/reindex/vue/augment-vue-workers.ts` — `awaitVueReferenceWorkers` (14, cognitive 12.).
- `src/reindex/vue/augment-vue-workers.ts` — `readWorkerResult` (14, cognitive 11.).
- `src/semantic/rust/durable-session-server.ts` — `processDurableRustSessionRequests` (15, cognitive 19.).
- `src/semantic/rust/provider.ts` — `createRustSemanticProvider` (15, cognitive 2.).
- `src/semantic/rust/scip-occurrence-callees.ts` — `loadScipOccurrenceCalleeIndex` (15, cognitive 19.).
- `src/semantic/rust/scip-occurrence-references.ts` — `loadScipOccurrenceReferenceIndex` (15, cognitive 17.).
- `src/semantic/shared-primitives.ts` — `materializeSemanticReferenceBatch` (16, cognitive 20.).
- `src/semantic/shared-primitives.ts` — `buildSemanticCalleeMap.<callback:profileSpan:1>` (12, cognitive 22.).
- `src/semantic/typescript/ts-morph-provider.ts` — `TsMorphSemanticProvider.definitionFromCompilerSymbol` (16, cognitive 22.).
- `src/semantic/typescript/ts-morph-provider.ts` — `TsMorphSemanticProvider.importUsageForSourceFile` (14, cognitive 24.).
- `src/semantic/typescript/ts-morph-provider.ts` — `TsMorphSemanticProvider.referencesForDefinitions` (15, cognitive 19.).
- `src/platform/fingerprint-stat-cache.ts` — `isFingerprintStatRecord` (14, cognitive 5.).

worker-3:

- `scripts/change-benchmark-core.mjs` — `checkStructure.visit` (15, cognitive 21.).
- `src/analysis/runtime-boundaries/extractors.ts` — `nodeChildProcessBindings` (15, cognitive 16.).
- `src/analysis/runtime-boundaries/graph.ts` — `buildRelationGroups` (12, cognitive 22.).
- `src/analysis/runtime-boundaries/wrapper-propagation.ts` — `propagateCompilerResolvedWrappers` (10, cognitive 22.).
- `src/language-parsers/languages/php.ts` — `parsePhpImportsAst` (10, cognitive 22.).
- `src/queries/cleanup/dead.ts` — `deadSummary` (12, cognitive 22.).
- `scripts/accuracy-calibration-core.mjs` — `parseDeadCalibrationOptions` (14, cognitive 20.).
- `scripts/accuracy-calibration.mjs` — `renderDeadPacket` (14, cognitive 3.).
- `scripts/api-surface-contract.mjs` — `normalizeNamedBindings` (14, cognitive 16.).
- `scripts/profile-scoreboard.mjs` — `profileScoreboard` (14, cognitive 18.).
- `scripts/scip-windows-provenance.mjs` — `inspectPortableExecutable` (14, cognitive 10.).
- `scripts/scip-windows-release.ts` — `runWindowsSidecarRelease` (14, cognitive 11.).
- `skills/scip-explore/scripts/capture-evidence.mjs` — `priorSourceCoverage` (14, cognitive 20.).
- `src/analysis/framework-patterns.ts` — `collectRustAstExclusions` (14, cognitive 13.).
- `src/analysis/framework-patterns.ts` — `normalizeExclusionEntry` (14, cognitive 13.).
- `src/analysis/runtime-boundaries/extractors.ts` — `capabilityRegistryExtractor.extract.<callback:visitDescendantsOfType:2>` (14, cognitive 15.).
- `src/analysis/runtime-boundaries/extractors.ts` — `effectHttpApiExtractor.extract.<callback:visitDescendantsOfType:2>` (14, cognitive 12.).
- `src/queries/cleanup/duplicate-bodies.ts` — `extractImplementationBody` (14, cognitive 17.).
- `src/queries/graph/architecture.ts` — `analyzeArchitectureGraph` (14, cognitive 15.).
- `src/queries/graph/deep-chains.ts` — `dependencyDepth` (14, cognitive 21.).
- `src/queries/graph/graph-evidence.ts` — `graphEvidence` (14, cognitive 11.).
- `src/queries/graph/system-map.ts` — `causalCorridorFocusLocations` (14, cognitive 15.).
- `src/queries/navigation/source-inspection.ts` — `inspectSource` (14, cognitive 11.).
- `src/runtime/commands/command-handlers.ts` — `renderSqliteGeneration` (14, cognitive 15.).
- `src/runtime/commands/command-handlers.ts` — `renderWatchReindexActivity` (14, cognitive 6.).


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


### Sixth parallel wave root implementation checkpoint

Root's 15 targets across 12 exclusive files are implemented and frozen. Every target and introduced helper is ≤10 cyclomatic / ≤15 cognitive in current source measurements; the final frozen combined scan remains authoritative. Root source typecheck and owned lint pass. Focused validation passed 261 tests across eight runtime/storage files, 15 Rust protocol/regression tests, 28 checker parsing/output tests, and seven new isolated script/worker-config tests: 311 distinct tests. Eleven fast-path tests passed again after consolidating shared output-flag handling and final result construction. Two initially requested test filenames did not exist; scip-query located the real Rust protocol and cleanup-plan suites, which were then run.

Changes preserve keyset cursor position/producer validation, output page character/byte bounds, Rust request field order, finite prewarm marker fields, exact-source-before-containing-source receipts, preview staging/chunk grouping, query response identity/errors/generation/result/receipt precedence, source outline recursion, symbol matched/unmatched payloads, watcher ownership record order, and mailbox metadata override/capacity sweep/publication-before-claim-removal with durable cleanup. The shared entrypoint/outline output flags have one implementation. Isolated tests run only selected declarations; no watcher, reindex process or freshness benchmark entrypoint is launched. Worker config tests distinguish malformed records, absent fields, filtered project lists and independent heap validation.

No source-policy/threshold/suppression changes, agent benchmarks, release actions or VM changes. All root test/check processes finished. Pending: worker2/3 implementation and frozen checks, four-way read-only cross-review, final source metrics/types/lint/build/full suite/API/consumer/skills/format/reindex/health/impact, updated inventory and commit. Current base remains20ba96c7.

All sixth-wave sources are frozen. Combined source review is accounted, resolves90findings and reports no introduced/worsened findings or added/modified functions above10/15. All90target measurements are established, with the first checkStructure.visit identified by exact diff at baseline228/current247(7/6), distinct from its unchanged same-name sibling. Source/contract type checks and changed-file ESLint pass. Worker1 passed221tests plus134rerun; worker2 passed348tests plus133rerun; worker3 passed426tests, and root311; counts overlap across lanes. All test/check processes completed before combined build. Root reviewed worker1, worker1 reviewed worker3, worker2 reviewed root with no findings; worker3 review of worker2 is pending. Three pre-existing ambiguous callback finding records remain uncomparable and are not counted resolved.


### Seventh parallel wave assignments (prepared before edits)

The next 90 current-source findings are assigned by whole file: root fifteen, each worker twenty-five. The four lanes share no source files. Start only after wave six is committed. Each lane must preserve behavior, avoid additions to exported class declarations, add meaningful regression coverage where needed, and freeze for combined checks.

root:

- `src/runtime/commands/command-handlers.ts:1121` — `renderWatchServiceIdentity`. renderWatchServiceIdentity: cyclomatic 14, cognitive 14.
- `src/runtime/commands/command-handlers.ts:1189` — `renderWatchTypeScriptStatus`. renderWatchTypeScriptStatus: cyclomatic 12, cognitive 20.
- `src/runtime/commands/command-handlers.ts:676` — `handleSetup`. handleSetup: cyclomatic 13, cognitive 12.
- `src/runtime/commands/command-registry.ts:48` — `registerCommandDescriptors.<callback:descriptors.map:0>`. registerCommandDescriptors.<callback:descriptors.map:0>: cyclomatic 14, cognitive 17.
- `src/runtime/project-setup.ts:866` — `startSetupWatchService`. startSetupWatchService: cyclomatic 14, cognitive 18.
- `src/runtime/query-commands/direct-navigation.ts:111` — `handleRefs.<callback:budgetedDbCommand:1>`. handleRefs.<callback:budgetedDbCommand:1>: cyclomatic 14, cognitive 12.
- `src/runtime/query-commands/navigation.ts:932` — `evidenceCommandSections`. evidenceCommandSections: cyclomatic 14, cognitive 10.
- `src/runtime/query-commands/navigation.ts:767` — `sourceInspectionUnitRow`. sourceInspectionUnitRow: cyclomatic 13, cognitive 17.
- `src/runtime/query-commands/navigation.ts:241` — `sourceSearchSections`. sourceSearchSections: cyclomatic 13, cognitive 12.
- `src/runtime/query-service-fastpath.ts:469` — `parseExactCompactOperand`. parseExactCompactOperand: cyclomatic 14, cognitive 18.
- `src/runtime/query-service-fastpath.ts:540` — `parseFilesInvocation`. parseFilesInvocation: cyclomatic 14, cognitive 18.
- `src/runtime/query-service.ts:1145` — `isMethodsResult`. isMethodsResult: cyclomatic 14, cognitive 8.
- `src/runtime/typescript-mailbox-worker.ts:98` — `parseWorkerData`. parseWorkerData: cyclomatic 14, cognitive 12.
- `src/runtime/watch-service.ts:599` — `planWatchServiceAction`. planWatchServiceAction: cyclomatic 14, cognitive 11.
- `src/runtime/watch-service.ts:669` — `stopLiveWatchProcess`. stopLiveWatchProcess: cyclomatic 13, cognitive 11.

worker-1:

- `src/analysis/runtime-boundaries/carrier-discriminators.ts:81` — `collectBodySummaryResult`. collectBodySummaryResult: cyclomatic 10, cognitive 20.
- `src/analysis/runtime-boundaries/carrier-discriminators.ts:187` — `resolveProducerDiscriminatorSeed`. resolveProducerDiscriminatorSeed: cyclomatic 13, cognitive 10.
- `src/queries/graph/system-map.ts:3576` — `selectCoverageDiverseDrilldownAnchors`. selectCoverageDiverseDrilldownAnchors: cyclomatic 11, cognitive 20.
- `src/queries/graph/test-boundary-policy.ts:48` — `testBoundaryViolations`. testBoundaryViolations: cyclomatic 10, cognitive 20.
- `src/analysis/git-history.ts:409` — `parseFileAddRecordsPayload`. parseFileAddRecordsPayload: cyclomatic 13, cognitive 10.
- `src/analysis/runtime-boundaries/extractors.ts:697` — `registryExtractor.extract.<callback:visitDescendantsOfType:2>`. registryExtractor.extract.<callback:visitDescendantsOfType:2>: cyclomatic 13, cognitive 11.
- `src/analysis/suppressions.ts:40` — `scanSuppressions`. scanSuppressions: cyclomatic 13, cognitive 15.
- `src/language-parsers/languages/clojure.ts:145` — `parseRequireVector`. parseRequireVector: cyclomatic 13, cognitive 17.
- `src/queries/cleanup/boundary-evidence.ts:68` — `hasCleanupIgnoreComment`. hasCleanupIgnoreComment: cyclomatic 13, cognitive 11.
- `src/queries/cleanup/callable-contracts.ts:20` — `isFrameworkContractCallable`. isFrameworkContractCallable: cyclomatic 13, cognitive 11.
- `src/queries/cleanup/dead.ts:537` — `deadSourceTargets`. deadSourceTargets: cyclomatic 13, cognitive 17.
- `src/queries/cleanup/decorative-checkers.ts:117` — `classifyChecker`. classifyChecker: cyclomatic 13, cognitive 15.
- `src/queries/cleanup/doc-citation-context.ts:61` — `listItemRange`. listItemRange: cyclomatic 13, cognitive 15.
- `src/queries/graph/architecture.ts:488` — `hasEnforceableArchitecturePolicy`. hasEnforceableArchitecturePolicy: cyclomatic 13, cognitive 2.
- `src/queries/graph/dependence-slice.ts:41` — `dependenceSlice`. dependenceSlice: cyclomatic 13, cognitive 13.
- `src/queries/internal/causal-corridor.ts:336` — `mechanicalOutcomeNodeIds`. mechanicalOutcomeNodeIds: cyclomatic 13, cognitive 10.
- `src/queries/internal/consumer-evidence.ts:527` — `classifyDefinitionConsumersNative`. classifyDefinitionConsumersNative: cyclomatic 13, cognitive 13.
- `src/queries/quality/slice-cohesion.ts:1214` — `aliasRoots`. aliasRoots: cyclomatic 13, cognitive 17.
- `src/queries/quality/slice-cohesion.ts:1439` — `isReadIdentifier`. isReadIdentifier: cyclomatic 13, cognitive 11.
- `src/queries/quality/slice-cohesion.ts:2019` — `statementOutputSeed`. statementOutputSeed: cyclomatic 13, cognitive 12.
- `src/source/facts/behavior-skeleton.ts:1453` — `recordShape`. recordShape: cyclomatic 13, cognitive 7.
- `src/source/facts/source-facts.ts:234` — `buildSourceFacts.walk`. buildSourceFacts.walk: cyclomatic 13, cognitive 12.
- `src/source/facts/source-reference-collectors.ts:30` — `collectCrossLanguageDispatchName`. collectCrossLanguageDispatchName: cyclomatic 13, cognitive 10.
- `src/source/primitives/source-text.ts:89` — `suppressionCommentsBeforeDefinition`. suppressionCommentsBeforeDefinition: cyclomatic 13, cognitive 11.
- `src/symbols/identifier-attribution.ts:68` — `attributeIdentifier`. attributeIdentifier: cyclomatic 13, cognitive 17.

worker-2:

- `src/semantic/rust/lsp-session-worker.ts:244` — `runSessionRequest`. runSessionRequest: cyclomatic 14, cognitive 11.
- `src/semantic/rust/lsp-session.ts:363` — `RustAnalyzerSessionResolver.fallbackReferencesAndCallees`. RustAnalyzerSessionResolver.fallbackReferencesAndCallees: cyclomatic 14, cognitive 14.
- `src/semantic/rust/lsp-session.ts:513` — `rustSemanticSessionSelection`. rustSemanticSessionSelection: cyclomatic 14, cognitive 8.
- `src/semantic/rust/provider.ts:739` — `parseWorkerResponse`. parseWorkerResponse: cyclomatic 14, cognitive 13.
- `src/semantic/typescript/ts-morph-provider.ts:1120` — `TsMorphSemanticProvider.collectPackageExports`. TsMorphSemanticProvider.collectPackageExports: cyclomatic 13, cognitive 21.
- `src/storage/atomic-file.ts:124` — `createFileAtomicExclusive`. createFileAtomicExclusive: cyclomatic 14, cognitive 12.
- `src/storage/sqlite-generation.ts:349` — `readImmutableGeneration`. readImmutableGeneration: cyclomatic 14, cognitive 12.
- `src/symbols/graph/file-dep-graph.ts:310` — `materializeCarriedFileDependencyGraph.<callback:profileSpan:1>`. materializeCarriedFileDependencyGraph.<callback:profileSpan:1>: cyclomatic 9, cognitive 21.
- `src/symbols/graph/member-call-targets.ts:602` — `serviceObjectMemberImplementations.<callback:walk:1>`. serviceObjectMemberImplementations.<callback:walk:1>: cyclomatic 14, cognitive 20.
- `src/domain/observation-receipt.ts:425` — `compareObservationStability`. compareObservationStability: cyclomatic 13, cognitive 20.
- `src/domain/observation-receipt.ts:693` — `v2SourceFactsAgree`. v2SourceFactsAgree: cyclomatic 13, cognitive 16.
- `src/reindex/index.ts:3052` — `materializeSqliteOutput`. materializeSqliteOutput: cyclomatic 12, cognitive 20.
- `src/reindex/install.ts:13` — `tryInstallIndexer`. tryInstallIndexer: cyclomatic 12, cognitive 20.
- `src/reindex/scip-sqlite-converter.ts:178` — `parseOccurrence`. parseOccurrence: cyclomatic 13, cognitive 17.
- `src/reindex/sqlite-generation-store.ts:546` — `readLocalGenerationRetentionResult`. readLocalGenerationRetentionResult: cyclomatic 13, cognitive 4.
- `src/runtime/repository-cache-lifecycle.ts:312` — `maybeSweepInactiveRepositoryCaches`. maybeSweepInactiveRepositoryCaches: cyclomatic 13, cognitive 13.
- `src/semantic/rust/durable-session-protocol.ts:410` — `decodeDurableRustSessionRequest`. decodeDurableRustSessionRequest: cyclomatic 13, cognitive 11.
- `src/semantic/rust/durable-session.ts:579` — `isBoundedMailboxStatus`. isBoundedMailboxStatus: cyclomatic 13, cognitive 4.
- `src/semantic/typescript/local-flow.ts:775` — `extractAccesses`. extractAccesses: cyclomatic 13, cognitive 15.
- `src/semantic/typescript/reference-fragment-shadow.ts:112` — `recordTypeScriptReferenceFragmentShadow.<callback:profileSpan:1>`. recordTypeScriptReferenceFragmentShadow.<callback:profileSpan:1>: cyclomatic 13, cognitive 14.
- `src/semantic/typescript/session-protocol.ts:151` — `isTypeScriptSemanticRequest`. isTypeScriptSemanticRequest: cyclomatic 13, cognitive 5.
- `src/semantic/typescript/session-service.ts:88` — `TypeScriptSemanticServiceHost.handle`. TypeScriptSemanticServiceHost.handle: cyclomatic 13, cognitive 6.
- `src/storage/bounded-mailbox.ts:337` — `claimBoundedMailboxRequests`. claimBoundedMailboxRequests: cyclomatic 13, cognitive 9.
- `src/storage/bounded-mailbox.ts:1119` — `readMailboxOwnerRecord`. readMailboxOwnerRecord: cyclomatic 13, cognitive 8.
- `src/symbols/definition-catalog.ts:1015` — `resolveCallableDefinitionEndLine`. resolveCallableDefinitionEndLine: cyclomatic 13, cognitive 15.

worker-3:

- `scripts/affected-set-shadow-contract.mjs:490` — `verifyShadow`. verifyShadow: cyclomatic 13, cognitive 12.
- `scripts/benchmark-query-service.ts:246` — `defaultOperand`. defaultOperand: cyclomatic 13, cognitive 12.
- `scripts/codex-exploration-trial-core.mjs:185` — `classifyExplorationCommand`. classifyExplorationCommand: cyclomatic 13, cognitive 16.
- `scripts/codex-exploration-trial.mjs:48` — `main`. main: cyclomatic 13, cognitive 7.
- `src/platform/git-worktree.ts:304` — `gitControlDirectoriesMatchHint`. gitControlDirectoriesMatchHint: cyclomatic 13, cognitive 13.
- `src/platform/process-tree.ts:200` — `signalKnownTree`. signalKnownTree: cyclomatic 13, cognitive 19.
- `src/platform/project-files.ts:819` — `journalEntryValidationReason`. journalEntryValidationReason: cyclomatic 13, cognitive 17.
- `src/platform/project-observation-snapshot.ts:409` — `fixedGitFileReader.read`. fixedGitFileReader.read: cyclomatic 13, cognitive 13.
- `src/platform/project-observation-snapshot.ts:504` — `isExcludedObservationArtifact`. isExcludedObservationArtifact: cyclomatic 13, cognitive 3.
- `src/runtime/cleanup-verify.ts:755` — `extendToBalanced`. extendToBalanced: cyclomatic 13, cognitive 14.
- `src/runtime/cleanup-verify.ts:954` — `parseCljKondoJsonDiagnostics`. parseCljKondoJsonDiagnostics: cyclomatic 13, cognitive 19.
- `src/runtime/cleanup-verify.ts:467` — `workingTreeInspectionFailureReason`. workingTreeInspectionFailureReason: cyclomatic 13, cognitive 12.
- `src/runtime/cli-json-envelope.ts:306` — `isCliEvidenceContextV1`. isCliEvidenceContextV1: cyclomatic 13, cognitive 8.
- `src/runtime/cli-support.ts:536` — `runHealthSemanticPrewarm`. runHealthSemanticPrewarm: cyclomatic 13, cognitive 12.
- `src/runtime/config.ts:704` — `validateCoverageContracts`. validateCoverageContracts: cyclomatic 13, cognitive 16.
- `src/runtime/health-report-cache.ts:156` — `isHealthReportCacheKey`. isHealthReportCacheKey: cyclomatic 13, cognitive 6.
- `src/runtime/isolated-analysis-runner.ts:146` — `parseIsolatedAnalysisResult`. parseIsolatedAnalysisResult: cyclomatic 13, cognitive 13.
- `src/runtime/output-pagination.ts:1715` — `parseOutputCursor`. parseOutputCursor: cyclomatic 13, cognitive 10.
- `src/runtime/query-commands/cleanup/handlers.ts:912` — `handleRecentDuplicates.<callback:budgetedDbCommand:1>`. handleRecentDuplicates.<callback:budgetedDbCommand:1>: cyclomatic 13, cognitive 17.
- `src/runtime/query-commands/impact.ts:74` — `handleCoChange.<callback:budgetedDbCommand:1>`. handleCoChange.<callback:budgetedDbCommand:1>: cyclomatic 13, cognitive 15.
- `src/runtime/query-commands/impact.ts:172` — `handleIncompleteMigration.<callback:budgetedDbCommand:1>`. handleIncompleteMigration.<callback:budgetedDbCommand:1>: cyclomatic 13, cognitive 15.
- `src/runtime/update-notice.ts:27` — `maybePrintUpdateNotice`. maybePrintUpdateNotice: cyclomatic 13, cognitive 6.
- `src/runtime/watch-service-prune.ts:42` — `pruneOrphanWatchServices`. pruneOrphanWatchServices: cyclomatic 13, cognitive 16.
- `src/runtime/watch.ts:951` — `Watcher.pollGitState`. Watcher.pollGitState: cyclomatic 13, cognitive 13.
- `scripts/accuracy-calibration-core.mjs:92` — `parseTypeScriptDetectorOptions`. parseTypeScriptDetectorOptions: cyclomatic 12, cognitive 19.


### Seventh wave expansion: finish each assigned file

To avoid returning to the same files in later waves, expand the next 90 ranked targets to all 177 current complexity findings in those same 74 exclusively assigned files. Ownership does not change: root28, worker1 54, worker2 54, worker3 41. The following 87 targets supplement the assignments above. 118 findings in 86 other files remain for the following wave. The updated manifests are `/tmp/complexity-wave7-{root,worker-1,worker-2,worker-3}-targets.json`; the initial90 lists are retained separately. No source edits have started.

root additional targets:

- `src/runtime/commands/command-handlers.ts:717` — `guidedProjectSetupOptions`. guidedProjectSetupOptions: cyclomatic 12, cognitive 12.
- `src/runtime/commands/command-handlers.ts:1291` — `renderStatusReport`. renderStatusReport: cyclomatic 12, cognitive 16.
- `src/runtime/project-setup.ts:450` — `prepareSetupRefreshConfig`. prepareSetupRefreshConfig: cyclomatic 12, cognitive 15.
- `src/runtime/project-setup.ts:779` — `refreshSetupIndex`. refreshSetupIndex: cyclomatic 12, cognitive 12.
- `src/runtime/watch-service.ts:544` — `parseLegacyWatchMetadata`. parseLegacyWatchMetadata: cyclomatic 12, cognitive 8.
- `src/runtime/project-setup.ts:558` — `prepareSetupAstParsers`. prepareSetupAstParsers: cyclomatic 11, cognitive 17.
- `src/runtime/project-setup.ts:947` — `renderProjectSetupReport`. renderProjectSetupReport: cyclomatic 10, cognitive 17.
- `src/runtime/commands/command-handlers.ts:132` — `handleReindex`. handleReindex: cyclomatic 11, cognitive 14.
- `src/runtime/commands/command-handlers.ts:1361` — `renderSharedCacheStatus`. renderSharedCacheStatus: cyclomatic 11, cognitive 5.
- `src/runtime/query-service.ts:927` — `ensureQueryServiceServer`. ensureQueryServiceServer: cyclomatic 11, cognitive 14.
- `src/runtime/query-service.ts:1390` — `isSerializedJsonResult`. isSerializedJsonResult: cyclomatic 11, cognitive 8.
- `src/runtime/query-service.ts:1449` — `requestPoolSize`. requestPoolSize: cyclomatic 11, cognitive 7.
- `src/runtime/query-service.ts:691` — `tryQueryWithService`. tryQueryWithService: cyclomatic 11, cognitive 13.

worker-1 additional targets:

- `src/analysis/git-history.ts:943` — `subjectLabelsFor`. subjectLabelsFor: cyclomatic 12, cognitive 11.
- `src/analysis/runtime-boundaries/extractors.ts:383` — `effectHttpApiImportedBindings`. effectHttpApiImportedBindings: cyclomatic 12, cognitive 12.
- `src/analysis/suppressions.ts:78` — `normalizeCategory`. normalizeCategory: cyclomatic 12, cognitive 11.
- `src/queries/cleanup/decorative-checkers.ts:248` — `returnExpressions`. returnExpressions: cyclomatic 12, cognitive 15.
- `src/queries/graph/system-map.ts:3385` — `buildSystemMapPresentation`. buildSystemMapPresentation: cyclomatic 12, cognitive 12.
- `src/queries/graph/system-map.ts:2596` — `syntaxDeclarationOwnersAtLine`. syntaxDeclarationOwnersAtLine: cyclomatic 12, cognitive 10.
- `src/queries/quality/slice-cohesion.ts:1276` — `isExitOnly`. isExitOnly: cyclomatic 12, cognitive 17.
- `src/queries/quality/slice-cohesion.ts:1154` — `tupleStateSetter`. tupleStateSetter: cyclomatic 12, cognitive 9.
- `src/queries/quality/slice-cohesion.ts:1895` — `writtenBase`. writtenBase: cyclomatic 12, cognitive 16.
- `src/source/facts/behavior-skeleton.ts:443` — `computeBehaviorConstructRange`. computeBehaviorConstructRange: cyclomatic 12, cognitive 13.
- `src/source/facts/source-reference-collectors.ts:47` — `collectRustAttrHelperNames`. collectRustAttrHelperNames: cyclomatic 12, cognitive 16.
- `src/language-parsers/languages/clojure.ts:41` — `parseClojureImports`. parseClojureImports: cyclomatic 10, cognitive 17.
- `src/analysis/runtime-boundaries/extractors.ts:757` — `persistenceExtractor.extract.<callback:visitDescendantsOfType:2>`. persistenceExtractor.extract.<callback:visitDescendantsOfType:2>: cyclomatic 11, cognitive 8.
- `src/analysis/runtime-boundaries/extractors.ts:818` — `queueExtractor.extract.<callback:visitDescendantsOfType:2>`. queueExtractor.extract.<callback:visitDescendantsOfType:2>: cyclomatic 11, cognitive 10.
- `src/language-parsers/languages/clojure.ts:280` — `parseForm`. parseForm: cyclomatic 11, cognitive 11.
- `src/language-parsers/languages/clojure.ts:122` — `parseRequireEntry`. parseRequireEntry: cyclomatic 11, cognitive 14.
- `src/queries/cleanup/decorative-checkers.ts:207` — `bodyHasFailureExit`. bodyHasFailureExit: cyclomatic 11, cognitive 12.
- `src/queries/cleanup/doc-citation-context.ts:20` — `fencedCodeRange`. fencedCodeRange: cyclomatic 11, cognitive 11.
- `src/queries/graph/architecture.ts:687` — `boundaryLimits`. boundaryLimits: cyclomatic 11, cognitive 12.
- `src/queries/graph/system-map.ts:3522` — `buildSystemMapDrilldown`. buildSystemMapDrilldown: cyclomatic 11, cognitive 15.
- `src/queries/graph/system-map.ts:846` — `materializeLiteralAnchorMatch`. materializeLiteralAnchorMatch: cyclomatic 11, cognitive 8.
- `src/queries/graph/system-map.ts:3239` — `relationTouchesSelectedOwner`. relationTouchesSelectedOwner: cyclomatic 11, cognitive 7.
- `src/queries/graph/system-map.ts:2910` — `systemMapTopologyRelationEdges`. systemMapTopologyRelationEdges: cyclomatic 11, cognitive 15.
- `src/queries/quality/slice-cohesion.ts:2039` — `callOutputSeed`. callOutputSeed: cyclomatic 11, cognitive 13.
- `src/source/facts/behavior-skeleton.ts:1205` — `behaviorConstructKind`. behaviorConstructKind: cyclomatic 11, cognitive 12.
- `src/source/facts/behavior-skeleton.ts:1340` — `collectBehaviorCandidates.<callback:walk:1>`. collectBehaviorCandidates.<callback:walk:1>: cyclomatic 11, cognitive 15.
- `src/analysis/runtime-boundaries/carrier-discriminators.ts:216` — `collectProducerDiscriminatorFields`. collectProducerDiscriminatorFields: cyclomatic 9, cognitive 16.
- `src/queries/quality/slice-cohesion.ts:1610` — `addContainerOrdering`. addContainerOrdering: cyclomatic 10, cognitive 16.
- `src/queries/quality/slice-cohesion.ts:1562` — `classifyFlowBindings`. classifyFlowBindings: cyclomatic 10, cognitive 16.

worker-2 additional targets:

- `src/reindex/index.ts:2092` — `publishFreshReindexArtifacts.<callback:profileSpan:1>`. publishFreshReindexArtifacts.<callback:profileSpan:1>: cyclomatic 12, cognitive 16.
- `src/reindex/sqlite-generation-store.ts:572` — `inspectSqliteGeneration`. inspectSqliteGeneration: cyclomatic 12, cognitive 14.
- `src/semantic/rust/durable-session.ts:165` — `DurableRustSessionHost.handle`. DurableRustSessionHost.handle: cyclomatic 12, cognitive 12.
- `src/semantic/rust/provider.ts:132` — `createRustSemanticProvider.calleesForDefinitions`. createRustSemanticProvider.calleesForDefinitions: cyclomatic 12, cognitive 11.
- `src/semantic/rust/provider.ts:166` — `createRustSemanticProvider.referencesAndCalleesForDefinitions`. createRustSemanticProvider.referencesAndCalleesForDefinitions: cyclomatic 12, cognitive 12.
- `src/semantic/typescript/local-flow.ts:1279` — `accessTarget`. accessTarget: cyclomatic 12, cognitive 12.
- `src/semantic/typescript/local-flow.ts:445` — `buildStatement`. buildStatement: cyclomatic 12, cognitive 10.
- `src/semantic/typescript/local-flow.ts:1081` — `isDeclarationNameOwner`. isDeclarationNameOwner: cyclomatic 12, cognitive 1.
- `src/semantic/typescript/session-service.ts:181` — `processTypeScriptSemanticMailbox`. processTypeScriptSemanticMailbox: cyclomatic 12, cognitive 15.
- `src/semantic/typescript/ts-morph-provider.ts:1265` — `TsMorphSemanticProvider.calleeMapForFile.<callback:profileSpan:1>`. TsMorphSemanticProvider.calleeMapForFile.<callback:profileSpan:1>: cyclomatic 12, cognitive 11.
- `src/semantic/typescript/ts-morph-provider.ts:1444` — `importIdentifiers`. importIdentifiers: cyclomatic 12, cognitive 7.
- `src/storage/atomic-file.ts:67` — `replaceFileAtomic`. replaceFileAtomic: cyclomatic 12, cognitive 10.
- `src/storage/bounded-mailbox.ts:274` — `enqueueBoundedMailboxRequest.<callback:withMailboxAdmissionLock:5>`. enqueueBoundedMailboxRequest.<callback:withMailboxAdmissionLock:5>: cyclomatic 12, cognitive 10.
- `src/storage/bounded-mailbox.ts:1074` — `ensureMailboxOwnerRecord`. ensureMailboxOwnerRecord: cyclomatic 12, cognitive 9.
- `src/symbols/definition-catalog.ts:979` — `buildDeclarationCandidatesMap`. buildDeclarationCandidatesMap: cyclomatic 10, cognitive 18.
- `src/symbols/definition-catalog.ts:1055` — `maskStructuralLine`. maskStructuralLine: cyclomatic 12, cognitive 18.
- `src/symbols/graph/file-dep-graph.ts:379` — `collectSourceDependencyEdges`. collectSourceDependencyEdges: cyclomatic 9, cognitive 18.
- `src/symbols/graph/member-call-targets.ts:826` — `reachedFactoryOptionMembers`. reachedFactoryOptionMembers: cyclomatic 12, cognitive 16.
- `src/symbols/graph/member-call-targets.ts:686` — `serviceAliasesForImplementation`. serviceAliasesForImplementation: cyclomatic 12, cognitive 14.
- `src/storage/sqlite-generation.ts:182` — `inspectSqliteGenerationReaderLeases`. inspectSqliteGenerationReaderLeases: cyclomatic 10, cognitive 17.
- `src/reindex/index.ts:2549` — `ensureScipCliAvailable`. ensureScipCliAvailable: cyclomatic 11, cognitive 15.
- `src/reindex/sqlite-generation-store.ts:614` — `stableMirrorsMatch`. stableMirrorsMatch: cyclomatic 11, cognitive 10.
- `src/semantic/rust/durable-session-protocol.ts:480` — `isRustImportDefinitionWorkerRequest`. isRustImportDefinitionWorkerRequest: cyclomatic 11, cognitive 3.
- `src/semantic/rust/durable-session.ts:395` — `dispatchDurableRustSessionRequest`. dispatchDurableRustSessionRequest: cyclomatic 11, cognitive 12.
- `src/semantic/typescript/ts-morph-provider.ts:452` — `TsMorphSemanticProvider.addReferencesFromSourceFileScan.addIdentifierReferences`. TsMorphSemanticProvider.addReferencesFromSourceFileScan.addIdentifierReferences: cyclomatic 11, cognitive 10.
- `src/symbols/graph/member-call-targets.ts:479` — `callExpressionForSite`. callExpressionForSite: cyclomatic 11, cognitive 15.
- `src/symbols/graph/member-call-targets.ts:990` — `constructedMemberCallTarget`. constructedMemberCallTarget: cyclomatic 11, cognitive 9.
- `src/symbols/graph/member-call-targets.ts:865` — `factoryOptionCallbackTargets`. factoryOptionCallbackTargets: cyclomatic 11, cognitive 10.

worker-3 additional targets:

- `scripts/accuracy-calibration-core.mjs:272` — `summarizeCalibration`. summarizeCalibration: cyclomatic 12, cognitive 9.
- `scripts/affected-set-shadow-contract.mjs:759` — `parseArgs`. parseArgs: cyclomatic 12, cognitive 13.
- `scripts/codex-exploration-trial.mjs:218` — `parseArgs`. parseArgs: cyclomatic 12, cognitive 8.
- `src/platform/project-files.ts:970` — `isProjectArtifactPath`. isProjectArtifactPath: cyclomatic 12, cognitive 3.
- `src/platform/project-observation-snapshot.ts:373` — `verifyKnownIndexInputs`. verifyKnownIndexInputs: cyclomatic 12, cognitive 9.
- `src/runtime/cleanup-verify.ts:105` — `verifyCleanupPlan`. verifyCleanupPlan: cyclomatic 12, cognitive 17.
- `src/runtime/output-pagination.ts:575` — `emitCapturedOutputPage`. emitCapturedOutputPage: cyclomatic 12, cognitive 12.
- `src/runtime/query-commands/cleanup/handlers.ts:434` — `handleSimilar.render`. handleSimilar.render: cyclomatic 10, cognitive 18.
- `src/platform/project-files.ts:944` — `listFilesystemProjectFiles`. listFilesystemProjectFiles: cyclomatic 8, cognitive 17.
- `src/platform/project-observation-snapshot.ts:482` — `listFilesystemRepositoryContentFiles`. listFilesystemRepositoryContentFiles: cyclomatic 8, cognitive 17.
- `scripts/accuracy-calibration-core.mjs:218` — `deterministicStratifiedSample`. deterministicStratifiedSample: cyclomatic 11, cognitive 15.
- `src/platform/project-files.ts:437` — `completeUtf8PrefixLength`. completeUtf8PrefixLength: cyclomatic 11, cognitive 15.
- `src/platform/project-files.ts:206` — `readProjectFile`. readProjectFile: cyclomatic 11, cognitive 9.
- `src/runtime/watch.ts:1563` — `scopedProjectInputChangeKind`. scopedProjectInputChangeKind: cyclomatic 11, cognitive 11.
- `src/runtime/cli-support.ts:301` — `commandAnalysisBudget`. commandAnalysisBudget: cyclomatic 10, cognitive 16.
- `src/runtime/query-commands/cleanup/handlers.ts:534` — `handleDrift.render`. handleDrift.render: cyclomatic 8, cognitive 16.


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
