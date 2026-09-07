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
