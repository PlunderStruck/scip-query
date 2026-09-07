# Wave 7 worker 2 complexity refactors

Baseline: `623e4e63`. Own all 54 assigned findings across the 22 manifest files. Other workers are active; preserve their changes.

## Plan

Read the added targets before editing. Separate cohesive validation, collection, parsing and resource-handling responsibilities while preserving order, callback receivers, fallback/error contracts, lock scope, cleanup, cache sharing and publication semantics. No new members on exported classes or public API changes. Every target and new helper must be at most 10 cyclomatic / 15 cognitive. Use installed focused tests/lint/format and one full source review filtered to owned files, with correction checks as needed. Root owns build, API, fullsuite, final health, impact and commit.

## Targets

- `src/semantic/rust/lsp-session-worker.ts`: `runSessionRequest` (runSessionRequest: cyclomatic 14, cognitive 11.)
- `src/semantic/rust/lsp-session.ts`: `RustAnalyzerSessionResolver.fallbackReferencesAndCallees` (RustAnalyzerSessionResolver.fallbackReferencesAndCallees: cyclomatic 14, cognitive 14.)
- `src/semantic/rust/lsp-session.ts`: `rustSemanticSessionSelection` (rustSemanticSessionSelection: cyclomatic 14, cognitive 8.)
- `src/semantic/rust/provider.ts`: `parseWorkerResponse` (parseWorkerResponse: cyclomatic 14, cognitive 13.)
- `src/semantic/typescript/ts-morph-provider.ts`: `TsMorphSemanticProvider.collectPackageExports` (TsMorphSemanticProvider.collectPackageExports: cyclomatic 13, cognitive 21.)
- `src/storage/atomic-file.ts`: `createFileAtomicExclusive` (createFileAtomicExclusive: cyclomatic 14, cognitive 12.)
- `src/storage/sqlite-generation.ts`: `readImmutableGeneration` (readImmutableGeneration: cyclomatic 14, cognitive 12.)
- `src/symbols/graph/file-dep-graph.ts`: `materializeCarriedFileDependencyGraph.<callback:profileSpan:1>` (materializeCarriedFileDependencyGraph.<callback:profileSpan:1>: cyclomatic 9, cognitive 21.)
- `src/symbols/graph/member-call-targets.ts`: `serviceObjectMemberImplementations.<callback:walk:1>` (serviceObjectMemberImplementations.<callback:walk:1>: cyclomatic 14, cognitive 20.)
- `src/domain/observation-receipt.ts`: `compareObservationStability` (compareObservationStability: cyclomatic 13, cognitive 20.)
- `src/reindex/index.ts`: `materializeSqliteOutput` (materializeSqliteOutput: cyclomatic 12, cognitive 20.)
- `src/reindex/install.ts`: `tryInstallIndexer` (tryInstallIndexer: cyclomatic 12, cognitive 20.)
- `src/domain/observation-receipt.ts`: `v2SourceFactsAgree` (v2SourceFactsAgree: cyclomatic 13, cognitive 16.)
- `src/reindex/scip-sqlite-converter.ts`: `parseOccurrence` (parseOccurrence: cyclomatic 13, cognitive 17.)
- `src/reindex/sqlite-generation-store.ts`: `readLocalGenerationRetentionResult` (readLocalGenerationRetentionResult: cyclomatic 13, cognitive 4.)
- `src/runtime/repository-cache-lifecycle.ts`: `maybeSweepInactiveRepositoryCaches` (maybeSweepInactiveRepositoryCaches: cyclomatic 13, cognitive 13.)
- `src/semantic/rust/durable-session-protocol.ts`: `decodeDurableRustSessionRequest` (decodeDurableRustSessionRequest: cyclomatic 13, cognitive 11.)
- `src/semantic/rust/durable-session.ts`: `isBoundedMailboxStatus` (isBoundedMailboxStatus: cyclomatic 13, cognitive 4.)
- `src/semantic/typescript/local-flow.ts`: `extractAccesses` (extractAccesses: cyclomatic 13, cognitive 15.)
- `src/semantic/typescript/reference-fragment-shadow.ts`: `recordTypeScriptReferenceFragmentShadow.<callback:profileSpan:1>` (recordTypeScriptReferenceFragmentShadow.<callback:profileSpan:1>: cyclomatic 13, cognitive 14.)
- `src/semantic/typescript/session-protocol.ts`: `isTypeScriptSemanticRequest` (isTypeScriptSemanticRequest: cyclomatic 13, cognitive 5.)
- `src/semantic/typescript/session-service.ts`: `TypeScriptSemanticServiceHost.handle` (TypeScriptSemanticServiceHost.handle: cyclomatic 13, cognitive 6.)
- `src/storage/bounded-mailbox.ts`: `claimBoundedMailboxRequests` (claimBoundedMailboxRequests: cyclomatic 13, cognitive 9.)
- `src/storage/bounded-mailbox.ts`: `readMailboxOwnerRecord` (readMailboxOwnerRecord: cyclomatic 13, cognitive 8.)
- `src/symbols/definition-catalog.ts`: `resolveCallableDefinitionEndLine` (resolveCallableDefinitionEndLine: cyclomatic 13, cognitive 15.)
- `src/reindex/index.ts`: `publishFreshReindexArtifacts.<callback:profileSpan:1>` (publishFreshReindexArtifacts.<callback:profileSpan:1>: cyclomatic 12, cognitive 16.)
- `src/reindex/sqlite-generation-store.ts`: `inspectSqliteGeneration` (inspectSqliteGeneration: cyclomatic 12, cognitive 14.)
- `src/semantic/rust/durable-session.ts`: `DurableRustSessionHost.handle` (DurableRustSessionHost.handle: cyclomatic 12, cognitive 12.)
- `src/semantic/rust/provider.ts`: `createRustSemanticProvider.calleesForDefinitions` (createRustSemanticProvider.calleesForDefinitions: cyclomatic 12, cognitive 11.)
- `src/semantic/rust/provider.ts`: `createRustSemanticProvider.referencesAndCalleesForDefinitions` (createRustSemanticProvider.referencesAndCalleesForDefinitions: cyclomatic 12, cognitive 12.)
- `src/semantic/typescript/local-flow.ts`: `accessTarget` (accessTarget: cyclomatic 12, cognitive 12.)
- `src/semantic/typescript/local-flow.ts`: `buildStatement` (buildStatement: cyclomatic 12, cognitive 10.)
- `src/semantic/typescript/local-flow.ts`: `isDeclarationNameOwner` (isDeclarationNameOwner: cyclomatic 12, cognitive 1.)
- `src/semantic/typescript/session-service.ts`: `processTypeScriptSemanticMailbox` (processTypeScriptSemanticMailbox: cyclomatic 12, cognitive 15.)
- `src/semantic/typescript/ts-morph-provider.ts`: `TsMorphSemanticProvider.calleeMapForFile.<callback:profileSpan:1>` (TsMorphSemanticProvider.calleeMapForFile.<callback:profileSpan:1>: cyclomatic 12, cognitive 11.)
- `src/semantic/typescript/ts-morph-provider.ts`: `importIdentifiers` (importIdentifiers: cyclomatic 12, cognitive 7.)
- `src/storage/atomic-file.ts`: `replaceFileAtomic` (replaceFileAtomic: cyclomatic 12, cognitive 10.)
- `src/storage/bounded-mailbox.ts`: `enqueueBoundedMailboxRequest.<callback:withMailboxAdmissionLock:5>` (enqueueBoundedMailboxRequest.<callback:withMailboxAdmissionLock:5>: cyclomatic 12, cognitive 10.)
- `src/storage/bounded-mailbox.ts`: `ensureMailboxOwnerRecord` (ensureMailboxOwnerRecord: cyclomatic 12, cognitive 9.)
- `src/symbols/definition-catalog.ts`: `buildDeclarationCandidatesMap` (buildDeclarationCandidatesMap: cyclomatic 10, cognitive 18.)
- `src/symbols/definition-catalog.ts`: `maskStructuralLine` (maskStructuralLine: cyclomatic 12, cognitive 18.)
- `src/symbols/graph/file-dep-graph.ts`: `collectSourceDependencyEdges` (collectSourceDependencyEdges: cyclomatic 9, cognitive 18.)
- `src/symbols/graph/member-call-targets.ts`: `reachedFactoryOptionMembers` (reachedFactoryOptionMembers: cyclomatic 12, cognitive 16.)
- `src/symbols/graph/member-call-targets.ts`: `serviceAliasesForImplementation` (serviceAliasesForImplementation: cyclomatic 12, cognitive 14.)
- `src/storage/sqlite-generation.ts`: `inspectSqliteGenerationReaderLeases` (inspectSqliteGenerationReaderLeases: cyclomatic 10, cognitive 17.)
- `src/reindex/index.ts`: `ensureScipCliAvailable` (ensureScipCliAvailable: cyclomatic 11, cognitive 15.)
- `src/reindex/sqlite-generation-store.ts`: `stableMirrorsMatch` (stableMirrorsMatch: cyclomatic 11, cognitive 10.)
- `src/semantic/rust/durable-session-protocol.ts`: `isRustImportDefinitionWorkerRequest` (isRustImportDefinitionWorkerRequest: cyclomatic 11, cognitive 3.)
- `src/semantic/rust/durable-session.ts`: `dispatchDurableRustSessionRequest` (dispatchDurableRustSessionRequest: cyclomatic 11, cognitive 12.)
- `src/semantic/typescript/ts-morph-provider.ts`: `TsMorphSemanticProvider.addReferencesFromSourceFileScan.addIdentifierReferences` (TsMorphSemanticProvider.addReferencesFromSourceFileScan.addIdentifierReferences: cyclomatic 11, cognitive 10.)
- `src/symbols/graph/member-call-targets.ts`: `callExpressionForSite` (callExpressionForSite: cyclomatic 11, cognitive 15.)
- `src/symbols/graph/member-call-targets.ts`: `constructedMemberCallTarget` (constructedMemberCallTarget: cyclomatic 11, cognitive 9.)
- `src/symbols/graph/member-call-targets.ts`: `factoryOptionCallbackTargets` (factoryOptionCallbackTargets: cyclomatic 11, cognitive 10.)
- `src/symbols/graph/file-dep-graph.ts`: `materializeCarriedFileDependencyGraph.<callback:profileSpan:1>` (materializeCarriedFileDependencyGraph.<callback:profileSpan:1>: cyclomatic 8, cognitive 16.)

## Evidence and results

Initial 25 targets read during preparation; added-target reading and implementation underway. No tests or source changes occurred before START.

## First packet verification and authorized continuation

Implemented all 54 initial targets. Corrected source review `/tmp/wave7-worker2-review-corrected.json` is accounted with no problems; all 136 owned after-functions are at most 10 cyclomatic and 15 cognitive. Focused suites passed 423 distinct tests across 26 files; final adjustment suites passed another overlapping 57 tests. Owned lint, formatting and diff checks passed. A final type check identified the installer helper promise return annotation; corrected to the actual installer return type without runtime changes and rerunning types.

Continue directly with 34 additional targets in `/tmp/complexity-wave8-worker-2-targets.json`, bringing ownership to 88 targets across 51 files. Read each added implementation before edits, separate cohesive responsibilities while preserving evaluation order, defaults, parser fallbacks, cache identity/lifetimes and state effects. Run focused source suites, owned lint/format, and one continuation review filtered to these owned files; final combined validation remains root-owned.

## Final continuation result

Completed all 88 targets across 51 owned source files. All 227 measured owned after-functions (including 120 added identities, some due callback pairing) are at most 10 cyclomatic and 15 cognitive. Exact target metrics: `/tmp/complexity-final-worker-2-metrics.json`; complete owned function records: `/tmp/wave8-worker2-metrics.json`. The continuation review `/tmp/wave8-worker2-review.json` and process-identity correction review `/tmp/wave8-worker2-review-pid.json` both report accounted coverage and no problems. Three callbacks were paired manually through exact diff, retaining both same-ID file-dependency baseline locations (292 and 310) separately.

Continuation responsibilities: per-import parsing; graph frontier edge recording and terminal projection; snapshot configuration and process-ID validation; bounded source-fact attachment; static concatenation/import/template evaluation; language discrimination; occurrence wire identity; worktree generation/action equality; shard validation; emitter path normalization; fragment blob verification and replacement validation; service heartbeat; exact semantic reference materialization and provider grouping; caller inversion and AST/chunk partition; callable parameter facts, source continuation detection, ignore body prefixing, React kind validation, Vue fallback calls, wildcard aliases and auxiliary source collection. Original ordering, cache keys/sharing, parser fallbacks, depth bounds, error strings and cleanup/lock scopes remain intact. No exported class members were added.

Validation passed: 654 distinct tests across 52 files, including 6 new regressions across the two uniquely named worker test files. New continuation tests preserve process-property read ordering, version rejection precedence and sparse snapshot acceptance. Logs: `/tmp/wave7-worker2-tests-{a,b,c,correction,final-adjustment}.log` and `/tmp/wave8-worker2-tests-{a,b,c,d}.log`. Final TypeScript check `/tmp/wave8-worker2-types-final.log` passed. Owned eslint, prettier check and diff check passed in `/tmp/wave8-worker2-final-{lint,format,diff}.log`. Reviewed every owned source diff against 623e4e63. No source/test edits planned and no test processes remain. Root retains final combined build, API/full-suite/source-health/diff-impact validation and commit.

### Exact target measurements

| Baseline file:line and function                                                                                                    | Before C/Cog | After C/Cog |
| ---------------------------------------------------------------------------------------------------------------------------------- | -----------: | ----------: |
| `src/semantic/rust/lsp-session-worker.ts:244 runSessionRequest`                                                                    |        14/11 |       10/10 |
| `src/semantic/rust/lsp-session.ts:363 RustAnalyzerSessionResolver.fallbackReferencesAndCallees`                                    |        14/14 |         6/5 |
| `src/semantic/rust/lsp-session.ts:513 rustSemanticSessionSelection`                                                                |         14/8 |        10/6 |
| `src/semantic/rust/provider.ts:739 parseWorkerResponse`                                                                            |        14/13 |         8/7 |
| `src/semantic/typescript/ts-morph-provider.ts:1120 TsMorphSemanticProvider.collectPackageExports`                                  |        13/21 |        9/13 |
| `src/storage/atomic-file.ts:124 createFileAtomicExclusive`                                                                         |        14/12 |        10/6 |
| `src/storage/sqlite-generation.ts:349 readImmutableGeneration`                                                                     |        14/12 |        10/8 |
| `src/symbols/graph/member-call-targets.ts:602 serviceObjectMemberImplementations.<callback:walk:1>`                                |        14/20 |        9/11 |
| `src/domain/observation-receipt.ts:425 compareObservationStability`                                                                |        13/20 |        9/10 |
| `src/reindex/index.ts:3052 materializeSqliteOutput`                                                                                |        12/20 |        7/11 |
| `src/reindex/install.ts:13 tryInstallIndexer`                                                                                      |        12/20 |        9/12 |
| `src/domain/observation-receipt.ts:693 v2SourceFactsAgree`                                                                         |        13/16 |         8/9 |
| `src/reindex/scip-sqlite-converter.ts:178 parseOccurrence`                                                                         |        13/17 |         9/9 |
| `src/reindex/sqlite-generation-store.ts:546 readLocalGenerationRetentionResult`                                                    |         13/4 |         9/3 |
| `src/runtime/repository-cache-lifecycle.ts:312 maybeSweepInactiveRepositoryCaches`                                                 |        13/13 |         7/5 |
| `src/semantic/rust/durable-session-protocol.ts:410 decodeDurableRustSessionRequest`                                                |        13/11 |         8/9 |
| `src/semantic/rust/durable-session.ts:579 isBoundedMailboxStatus`                                                                  |         13/4 |         8/4 |
| `src/semantic/typescript/local-flow.ts:775 extractAccesses`                                                                        |        13/15 |         9/9 |
| `src/semantic/typescript/reference-fragment-shadow.ts:112 recordTypeScriptReferenceFragmentShadow.<callback:profileSpan:1>`        |        13/14 |       10/11 |
| `src/semantic/typescript/session-protocol.ts:151 isTypeScriptSemanticRequest`                                                      |         13/5 |         9/2 |
| `src/semantic/typescript/session-service.ts:88 TypeScriptSemanticServiceHost.handle`                                               |         13/6 |         4/3 |
| `src/storage/bounded-mailbox.ts:337 claimBoundedMailboxRequests`                                                                   |         13/9 |         8/5 |
| `src/storage/bounded-mailbox.ts:1119 readMailboxOwnerRecord`                                                                       |         13/8 |         8/7 |
| `src/symbols/definition-catalog.ts:1015 resolveCallableDefinitionEndLine`                                                          |        13/15 |         8/7 |
| `src/reindex/sqlite-generation-store.ts:572 inspectSqliteGeneration`                                                               |        12/14 |        10/9 |
| `src/semantic/rust/durable-session.ts:165 DurableRustSessionHost.handle`                                                           |        12/12 |         8/9 |
| `src/semantic/rust/provider.ts:132 createRustSemanticProvider.calleesForDefinitions`                                               |        12/11 |         6/5 |
| `src/semantic/rust/provider.ts:166 createRustSemanticProvider.referencesAndCalleesForDefinitions`                                  |        12/12 |         8/7 |
| `src/semantic/typescript/local-flow.ts:1279 accessTarget`                                                                          |        12/12 |        9/10 |
| `src/semantic/typescript/local-flow.ts:445 buildStatement`                                                                         |        12/10 |         8/6 |
| `src/semantic/typescript/local-flow.ts:1081 isDeclarationNameOwner`                                                                |         12/1 |        10/1 |
| `src/semantic/typescript/session-service.ts:181 processTypeScriptSemanticMailbox`                                                  |        12/15 |       10/10 |
| `src/semantic/typescript/ts-morph-provider.ts:1265 TsMorphSemanticProvider.calleeMapForFile.<callback:profileSpan:1>`              |        12/11 |        10/9 |
| `src/semantic/typescript/ts-morph-provider.ts:1444 importIdentifiers`                                                              |         12/7 |         7/4 |
| `src/storage/atomic-file.ts:67 replaceFileAtomic`                                                                                  |        12/10 |         8/4 |
| `src/storage/bounded-mailbox.ts:274 enqueueBoundedMailboxRequest.<callback:withMailboxAdmissionLock:5>`                            |        12/10 |         9/7 |
| `src/storage/bounded-mailbox.ts:1074 ensureMailboxOwnerRecord`                                                                     |         12/9 |         8/6 |
| `src/symbols/definition-catalog.ts:979 buildDeclarationCandidatesMap`                                                              |        10/18 |         4/3 |
| `src/symbols/definition-catalog.ts:1055 maskStructuralLine`                                                                        |        12/18 |         9/9 |
| `src/symbols/graph/file-dep-graph.ts:379 collectSourceDependencyEdges`                                                             |         9/18 |         4/4 |
| `src/symbols/graph/member-call-targets.ts:826 reachedFactoryOptionMembers`                                                         |        12/16 |         7/6 |
| `src/symbols/graph/member-call-targets.ts:686 serviceAliasesForImplementation`                                                     |        12/14 |         5/5 |
| `src/storage/sqlite-generation.ts:182 inspectSqliteGenerationReaderLeases`                                                         |        10/17 |        9/15 |
| `src/reindex/index.ts:2549 ensureScipCliAvailable`                                                                                 |        11/15 |         6/6 |
| `src/reindex/sqlite-generation-store.ts:614 stableMirrorsMatch`                                                                    |        11/10 |         8/7 |
| `src/semantic/rust/durable-session-protocol.ts:480 isRustImportDefinitionWorkerRequest`                                            |         11/3 |         7/2 |
| `src/semantic/rust/durable-session.ts:395 dispatchDurableRustSessionRequest`                                                       |        11/12 |         9/9 |
| `src/semantic/typescript/ts-morph-provider.ts:452 TsMorphSemanticProvider.addReferencesFromSourceFileScan.addIdentifierReferences` |        11/10 |         9/8 |
| `src/symbols/graph/member-call-targets.ts:479 callExpressionForSite`                                                               |        11/15 |         4/2 |
| `src/symbols/graph/member-call-targets.ts:990 constructedMemberCallTarget`                                                         |         11/9 |         8/6 |
| `src/symbols/graph/member-call-targets.ts:865 factoryOptionCallbackTargets`                                                        |        11/10 |         5/5 |
| `src/language-parsers/languages/python.ts:32 parsePythonImportsAst`                                                                |        10/19 |        7/11 |
| `src/queries/graph/entry-map.ts:338 reachableCallGraph`                                                                            |        11/19 |        7/10 |
| `src/queries/graph/program-control-edges.ts:17 programControlElementsForTopologyNodes`                                             |        12/19 |        8/10 |
| `src/semantic/shared-primitives.ts:343 exactSemanticCallerMap`                                                                     |        11/19 |         6/6 |
| `src/symbols/graph/call-graph-evidence.ts:140 buildCallerRowsMap.<callback:CALLER_ROWS_CACHE.get:1>`                               |        10/19 |         5/5 |
| `src/domain/process-identity.ts:26 parseProcessIdentity`                                                                           |         12/4 |        10/4 |
| `src/domain/project-input.ts:96 projectInputSnapshotOrNull`                                                                        |        12/11 |         8/7 |
| `src/language-parsers/source-evidence.ts:51 sourceEvidenceForFile`                                                                 |        12/14 |         8/7 |
| `src/source/facts/state-temporal-analysis.ts:242 resourceIdentity`                                                                 |         12/6 |         4/3 |
| `src/symbols/graph/static-value-flow.ts:32 evaluateNode`                                                                           |        12/14 |       10/10 |
| `src/symbols/graph/static-value-flow.ts:155 resolveIdentifier`                                                                     |        12/13 |        9/10 |
| `src/symbols/graph/static-value-flow.ts:282 stringTerm`                                                                            |        12/10 |         7/5 |
| `src/symbols/symbol-lookup.ts:461 findDirectSymbolCandidates.directMatches.<callback:candidates.filter:0>`                         |         12/1 |         8/1 |
| `src/reindex/affected-set.ts:90 reverseDependencyClosure`                                                                          |        11/16 |         6/8 |
| `src/reindex/detect.ts:77 detectLanguages`                                                                                         |        11/14 |         6/8 |
| `src/reindex/sanitize.ts:115 countDanglingDefinitionOccurrences`                                                                   |        11/15 |         6/7 |
| `src/reindex/shared-generation-store.ts:1057 worktreeLeaseEqualsExceptLastSeen`                                                    |         11/1 |         7/1 |
| `src/reindex/typescript-compiler-shards.ts:68 typescriptCompilerShardCount`                                                        |        11/12 |        9/10 |
| `src/reindex/typescript-document-emitter.ts:289 TypeScriptDocumentEmitter.advance`                                                 |        11/11 |       10/11 |
| `src/reindex/typescript-fragment-store.ts:292 prepareTypeScriptIndexAssembly`                                                      |        11/16 |        8/12 |
| `src/reindex/typescript-fragment-store.ts:228 readTypeScriptFragmentGeneration`                                                    |        11/12 |         8/8 |
| `src/reindex/typescript-index-requester.ts:212 usableServiceState`                                                                 |         11/5 |        10/5 |
| `src/reindex/vue/augment-vue-runtime.ts:606 volarLanguageIdForPath`                                                                |         11/1 |         8/1 |
| `src/semantic/typescript/tsserver-provider.ts:168 TsServerSemanticProvider.computeReferences`                                      |        11/13 |        9/12 |
| `src/source/facts/source-callables.ts:103 parameterFacts`                                                                          |        11/12 |         5/6 |
| `src/source/facts/source-construct.ts:64 focusedSourceConstructRange`                                                              |         11/8 |         9/7 |
| `src/source/primitives/gitignore-filter.ts:112 prefixGitignorePattern`                                                             |        11/10 |         7/6 |
| `src/source/react-profile.ts:268 deserializeReactComponentBehaviorProfile`                                                         |         11/8 |        10/7 |
| `src/source/vue/vue-script-facts.ts:183 collectFallbackScriptFacts`                                                                |        11/10 |         7/6 |
| `src/symbols/graph/call-graph-evidence.ts:340 buildCalleeMap`                                                                      |        11/11 |         8/6 |
| `src/language-parsers/languages/ruby.ts:53 parseRubyImportsAst`                                                                    |        10/16 |        8/13 |
| `src/semantic/shared-primitives.ts:718 semanticReferenceMap.groupReferenceDefinitions`                                             |         9/16 |        8/13 |
| `src/source/primitives/import-path-resolver.ts:281 matchTsconfigPathAlias`                                                         |         9/16 |         4/6 |
| `src/source/primitives/source-fileset.ts:149 getSourceFiles.<callback:SOURCE_FILES_CACHE.get:2>`                                   |         9/16 |         5/7 |
| `src/symbols/graph/file-dep-graph.ts:310 materializeCarriedFileDependencyGraph.<callback:profileSpan:1>`                           |         9/21 |         3/3 |
| `src/symbols/graph/file-dep-graph.ts:292 materializeCarriedFileDependencyGraph.<callback:profileSpan:1>`                           |         8/16 |         4/7 |
| `src/reindex/index.ts:2092 publishFreshReindexArtifacts.<callback:profileSpan:1>`                                                  |        12/16 |        9/11 |
