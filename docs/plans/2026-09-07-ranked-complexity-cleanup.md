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
