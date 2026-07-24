# Maintainability Candidate Register

Date: 2026-07-23
Release reviewed: 0.19.0
Companion plan: [2026-07-23-maintainability-baseline-reconciliation.md](./2026-07-23-maintainability-baseline-reconciliation.md)

## Purpose

A maintainability candidate is a detector-produced place where code shape resembles a known source of maintenance cost. It is evidence for review, not proof of debt: the same shape can be the necessary expression of a coherent workflow, an owned data contract, or deliberately separate product language.

This register records the disposition of every finding discovered by uncapped
0.19.0 maintainability scans. `Fix` means the code shape had no independent
responsibility and was changed. `Accept` means the shape preserves a named
responsibility that would become less clear, less local, or less type-safe if
mechanically removed. Accepted findings carry detector-specific source
comments, so they are quiet at the detector itself while any new unsuppressed
finding remains visible to health and the baseline gate.

## Outcome

- Fixed: 1 candidate.
- Accepted with a recorded source rationale: 253 candidates.
- Total uncapped inventory reviewed: 254 candidates: 195 extraction signals,
  52 stale-abstraction signals, 3 duplicate-body pairs, 2 similarity pairs,
  1 wrapper, and 1 passthrough.
- Architecture violations, cycles, dead exports, isolated files, and architecture drift: 0.
- Baseline identities for symbol-pair findings are normalized to repository-qualified names, so an npm version bump cannot make an unchanged finding appear new.

## Rationale codes

- **E1 — Workflow owner:** the function is the single owner of an ordered operation. Its calls share state, failure handling, or observability; extracting a callee cluster would split one lifecycle without creating an independently meaningful operation.
- **E2 — Cohesive algorithm:** the function is already the named abstraction for a calculation. The proposed cluster consists of its local mechanics rather than a reusable concept.
- **E3 — Feature-local pipeline:** the isolated helpers implement one detector, status reader, or compiler scan and have no separate consumer or policy boundary.
- **S1 — Owned contract:** the named type describes a protocol message, result, state record, dependency interface, or validated data shape. One external consumer does not make the contract stale because the defining module also constructs, validates, or owns it.
- **D1 — Product vocabulary:** structurally parallel recommendation functions intentionally retain framework- or policy-specific language and are expected to evolve independently.
- **M1 — Shared mechanism, distinct behavior:** similar callees are infrastructure used by different lifecycle stages or detector semantics; sharing the mechanism does not make the operations duplicates.
- **W1 — Reused predicate:** the small function is a named validation rule reused at multiple parsing boundaries; inlining would duplicate the rule and erase its meaning.
- **F1 — Empty facade:** the function forwarded once without validation, translation, policy, caching, or boundary ownership. It was inlined.

## Extraction candidates

All 195 extraction rows are signals, not direct actions. The detector asks
whether a locally isolated callee group deserves a name; it does not establish
that the group owns an independent responsibility.

|   # | Candidate                                                                                                  | Disposition |
| --: | ---------------------------------------------------------------------------------------------------------- | ----------- |
|   1 | `src:runtime:project-setup:runProjectSetup()`                                                              | Accept E1   |
|   2 | `src:semantic:rust:lsp-session-worker:runSessionRequest()`                                                 | Accept E1   |
|   3 | `src:semantic:rust:provider:createRustSemanticProvider()`                                                  | Accept E1   |
|   4 | `src:runtime:watch-server:runWatchServiceServer()`                                                         | Accept E1   |
|   5 | `src:queries:impact:plan-context:planContext()`                                                            | Accept E1   |
|   6 | `src:semantic:shared-primitives:materializeSemanticReferenceBatch()`                                       | Accept E1   |
|   7 | `src:reindex:index:runLanguageIndexersForFreshReindex()`                                                   | Accept E1   |
|   8 | `src:semantic:symbol-evidence:materializeSemanticCalleeCache()`                                            | Accept E1   |
|   9 | `src:queries:impact:incomplete-migration:incompleteMigration()`                                            | Accept E1   |
|  10 | `src:queries:cleanup:similar:similarAll()`                                                                 | Accept E1   |
|  11 | `src:queries:graph:architecture:analyzeArchitectureGraph()`                                                | Accept E2   |
|  12 | `src:semantic:shared-primitives:semanticReferenceMap()`                                                    | Accept E1   |
|  13 | `src:semantic:rust:lsp-batch-worker:runRustAnalyzerReferenceBatch()`                                       | Accept E1   |
|  14 | `src:semantic:rust:lsp-session:createWorkerRustAnalyzerSessionRequester()`                                 | Accept E1   |
|  15 | `src:queries:impact:diff-gate:runEchoCheck()`                                                              | Accept E1   |
|  16 | `src:tla:scaffold:scaffoldTlaModel()`                                                                      | Accept E1   |
|  17 | `src:queries:impact:diff-gate:diffGate()`                                                                  | Accept E1   |
|  18 | `src:reindex:index:runFreshReindex()`                                                                      | Accept E1   |
|  19 | `src:semantic:rust:lsp-session-worker:openNewSourceDocuments()`                                            | Accept E1   |
|  20 | `src:queries:cleanup:doc-drift:docDrift()`                                                                 | Accept E3   |
|  21 | `src:analysis:git-history:coChangePairsFromHistory()`                                                      | Accept E2   |
|  22 | `src:reindex:affected-shadow:readAffectedSetShadowStatus()`                                                | Accept E3   |
|  23 | `src:runtime:repository-cache-lifecycle:maybeSweepRepositoryCache()`                                       | Accept E1   |
|  24 | `src:queries:impact:diff-gate:runCoChangePartnerCheck()`                                                   | Accept E1   |
|  25 | `src:tla:trace-spec:runTraceCheck()`                                                                       | Accept E1   |
|  26 | `src:queries:impact:co-change:coChange()`                                                                  | Accept E1   |
|  27 | `src:runtime:cli-support:runHealthSemanticPrewarm()`                                                       | Accept E1   |
|  28 | `src:runtime:query-commands:tla:runTlaVerify()`                                                            | Accept E1   |
|  29 | `src:semantic:rust:default-impl-references:rustDefaultImplReferencesForDefinition()`                       | Accept E1   |
|  30 | `src:semantic:rust:provider:resolveSignaturesWithWorker()`                                                 | Accept E1   |
|  31 | `src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:referencesForDefinitions()`             | Accept E1   |
|  32 | `src:runtime:commands:command-handlers:guidedProjectSetupOptions()`                                        | Accept E1   |
|  33 | `src:queries:cleanup:similar:similarBySourceShape()`                                                       | Accept E1   |
|  34 | `src:queries:internal:production-callables:productionCallableDefinitions()`                                | Accept E1   |
|  35 | `src:reindex:shared-generation-store:publishFreshLocalGenerationForProject()`                              | Accept E1   |
|  36 | `src:runtime:cleanup-verify:verifyCleanupPlan()`                                                           | Accept E1   |
|  37 | `src:runtime:repository-cache-lifecycle:inspectSharedCacheStatus()`                                        | Accept E1   |
|  38 | `src:semantic:rust:durable-session:createDurableRustAnalyzerSessionRequester()`                            | Accept E1   |
|  39 | `src:runtime:project-setup:remediateIndexers()`                                                            | Accept E2   |
|  40 | `src:semantic:rust:lsp-session-worker:runImportDefinitionRequest()`                                        | Accept E1   |
|  41 | `src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:referencesForDefinitionsBySymbolScan()` | Accept E1   |
|  42 | `src:queries:cleanup:locality-candidates:buildLocalityCandidate()`                                         | Accept E1   |
|  43 | `src:semantic:rust:lsp-session-worker:sessionForPaths()`                                                   | Accept E1   |
|  44 | `src:queries:cleanup:test-quality:testQuality()`                                                           | Accept E1   |
|  45 | `src:reindex:incremental-sqlite-publication:patchIncrementalSqliteGeneration()`                            | Accept E1   |
|  46 | `src:reindex:shared-generation-store:publishSharedGeneration()`                                            | Accept E1   |
|  47 | `src:reindex:shared-generation-store:hydrateSharedGeneration()`                                            | Accept E1   |
|  48 | `src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:addReferencesFromSourceFileScan()`      | Accept E3   |
|  49 | `src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:importUsageForSourceFile()`             | Accept E1   |
|  50 | `src:queries:impact:diff-impact:diffImpactPartial()`                                                       | Accept E1   |

The default health view reported the first 50 rows. An uncapped `--full` pass exposed 145 additional lower-ranked signals. Each was reviewed at its concrete declaration and accepted under E1, E2, or E3; the nearby `ignore-extract` comment records the exact rationale that the detector now enforces.

| # | Candidate declaration | Disposition |
| --: | --- | --- |
| 51 | `src/analysis/file-classifier.ts` — `export function isRootedSymbol(db: ScipDatabase, symbol: string, file: string): boolean {` | Accept (source rationale) |
| 52 | `src/analysis/file-classifier.ts` — `function packageSurfaceReachability(db: ScipDatabase): Map<string, PackageSurfaceVisibility> {` | Accept (source rationale) |
| 53 | `src/analysis/git-history.ts` — `function loadFocusedCommitHistory(` | Accept (source rationale) |
| 54 | `src/instrumentation/profile.ts` — `export function writeProfileEvent(event: ProfileMetadata, outputPath = profileOutputPath()): void {` | Accept (source rationale) |
| 55 | `src/language-parsers/languages/clojure.ts` — `function parseForm(source: string, start: number): { form: ClojureForm; index: number } \| null {` | Accept (source rationale) |
| 56 | `src/platform/git-worktree.ts` — `export function resolveGitWorktreeIdentity(` | Accept (source rationale) |
| 57 | `src/platform/repository-cache-lock.ts` — `export function acquireProcessFileLock(` | Accept (source rationale) |
| 58 | `src/queries/cleanup/cleanup-plan.ts` — `export function cleanupPlan(` | Accept (source rationale) |
| 59 | `src/queries/cleanup/decorative-checkers.ts` — `function classifyChecker(` | Accept (source rationale) |
| 60 | `src/queries/cleanup/doc-drift.ts` — `function buildDocDriftScanIndex(db: ScipDatabase, historyMode: GitHistoryMode): DocDriftScanIndex \| null {` | Accept (source rationale) |
| 61 | `src/queries/cleanup/duplicate-bodies.ts` — `function duplicateBodyEntry(` | Accept (source rationale) |
| 62 | `src/queries/cleanup/locality-candidates.ts` — `export function localityCandidates(db: ScipDatabase, options: LocalityCandidatesOptions = {}): LocalityCandidate[] {` | Accept (source rationale) |
| 63 | `src/queries/cleanup/locality-candidates.ts` — `function resolveTargetSourceUnits(db: ScipDatabase, index: ProjectIndex, target: string): SourceUnitWithDefinition[] {` | Accept (source rationale) |
| 64 | `src/queries/cleanup/not-implemented.ts` — `export function notImplemented(` | Accept (source rationale) |
| 65 | `src/queries/cleanup/not-implemented.ts` — `function classifyStub(db: ScipDatabase, def: IndexedDefinition): StubCandidate \| null {` | Accept (source rationale) |
| 66 | `src/queries/cleanup/passthrough-candidates.ts` — `function passthroughCandidateForSymbol(` | Accept (source rationale) |
| 67 | `src/queries/cleanup/recent-duplicates.ts` — `export function recentDuplicates(` | Accept (source rationale) |
| 68 | `src/queries/cleanup/recent-duplicates.ts` — `function collectRecentDuplicateCandidates(` | Accept (source rationale) |
| 69 | `src/queries/cleanup/recent-duplicates.ts` — `function frontendDuplicateCandidates<TPair extends FrontendDuplicatePair>(` | Accept (source rationale) |
| 70 | `src/queries/cleanup/redundant-reexports.ts` — `function sourceRedundantReexportsForBarrel(` | Accept (source rationale) |
| 71 | `src/queries/cleanup/similar-chains.ts` — `function compareFilteredChains(a: FilteredChain, b: FilteredChain, minSimilarity: number): SimilarChainResult \| null {` | Accept (source rationale) |
| 72 | `src/queries/cleanup/similar-signatures.ts` — `function groupDefinitionsBySignature(` | Accept (source rationale) |
| 73 | `src/queries/cleanup/similar.ts` — `function compareAgainstFingerprints(` | Accept (source rationale) |
| 74 | `src/queries/cleanup/similar.ts` — `export function comparePair(` | Accept (source rationale) |
| 75 | `src/queries/cleanup/similar.ts` — `function targetPrunedSourceCandidatesForTarget(` | Accept (source rationale) |
| 76 | `src/queries/cleanup/similar.ts` — `function sourceFingerprintsForDefinitions(` | Accept (source rationale) |
| 77 | `src/queries/cleanup/stale-abstractions.ts` — `function staleTypeCandidates(` | Accept (source rationale) |
| 78 | `src/queries/cleanup/stale-abstractions.ts` — `function getSingletonBackedClassIds(` | Accept (source rationale) |
| 79 | `src/queries/cleanup/twin-ab.ts` — `function resolveTwinAbSymbol(db: ScipDatabase, ref: string): { ok: true; symbol: TwinAbSymbol } \| TwinAbRefusal {` | Accept (source rationale) |
| 80 | `src/queries/cleanup/twin-drift.ts` — `function twinDriftRecords(db: ScipDatabase, opts: { scope?: string; scanLimit?: number }): TwinDriftRecord[] {` | Accept (source rationale) |
| 81 | `src/queries/cleanup/twin-drift.ts` — `function twinDriftCandidateDefinitions(definitions: readonly IndexedDefinition[]): IndexedDefinition[] {` | Accept (source rationale) |
| 82 | `src/queries/cleanup/twin-drift.ts` — `function twinDriftRecord(db: ScipDatabase, definition: IndexedDefinition): TwinDriftRecord \| null {` | Accept (source rationale) |
| 83 | `src/queries/cleanup/unused-params.ts` — `export function unusedParams(` | Accept (source rationale) |
| 84 | `src/queries/cleanup/wrapper-candidates.ts` — `function consumerMapForWrapperCandidates(` | Accept (source rationale) |
| 85 | `src/queries/frontend/react-hook-candidates.ts` — `function compareReactHookProfiles(` | Accept (source rationale) |
| 86 | `src/queries/frontend/react-large-component-pressure.ts` — `function reactPressureResult(` | Accept (source rationale) |
| 87 | `src/queries/frontend/vue-composable-candidates.ts` — `function compareVueComposableProfiles(` | Accept (source rationale) |
| 88 | `src/queries/graph/coupling.ts` — `export function topCoupling(db: ScipDatabase, opts: { limit?: number; scope?: string } = {}): CouplingResult[] {` | Accept (source rationale) |
| 89 | `src/queries/health/health.ts` — `function summarizeGitEvidence(db: ScipDatabase, budget: HealthBudget): GitEvidenceSummary \| null {` | Accept (source rationale) |
| 90 | `src/queries/impact/diff-gate.ts` — `function runDocReferenceCheck(` | Accept (source rationale) |
| 91 | `src/queries/impact/diff-gate.ts` — `function buildDocReferenceFindingDraft(` | Accept (source rationale) |
| 92 | `src/queries/impact/diff-gate.ts` — `function runNewDeadCheck(` | Accept (source rationale) |
| 93 | `src/queries/impact/diff-impact.ts` — `export function attributeResidue(` | Accept (source rationale) |
| 94 | `src/queries/impact/diff-impact.ts` — `function attributeChangedRangeResidue(` | Accept (source rationale) |
| 95 | `src/queries/internal/candidate-scan.ts` — `export function runCandidateAnalysis<TCandidate, TContext = undefined, TResult = never>(` | Accept (source rationale) |
| 96 | `src/queries/internal/consumer-evidence.ts` — `function buildDefinitionConsumerEvidence(` | Accept (source rationale) |
| 97 | `src/queries/internal/consumer-evidence.ts` — `function classifyDefinitionConsumersNative(` | Accept (source rationale) |
| 98 | `src/queries/internal/consumer-evidence.ts` — `function nativeConsumerClassifyPayload(` | Accept (source rationale) |
| 99 | `src/queries/internal/pairwise-profiles.ts` — `export function rankedPairwiseProfileResults<` | Accept (source rationale) |
| 100 | `src/queries/navigation/by-kind.ts` — `export function kindCounts(` | Accept (source rationale) |
| 101 | `src/queries/navigation/imports.ts` — `function sourceFileImportEntries(db: ScipDatabase, importer: string): ImportEntry[] {` | Accept (source rationale) |
| 102 | `src/queries/navigation/members.ts` — `export function members(db: ScipDatabase, symbolPattern: string): MemberResult[] {` | Accept (source rationale) |
| 103 | `src/queries/navigation/methods.ts` — `export function methods(db: ScipDatabase, className: string): MethodResult[] {` | Accept (source rationale) |
| 104 | `src/queries/quality/complexity-hotspots.ts` — `export function complexityHotspots(` | Accept (source rationale) |
| 105 | `src/queries/quality/complexity.ts` — `export function branchEstimateForDefinition(db: ScipDatabase, definition: SymbolMatch): BranchEstimate {` | Accept (source rationale) |
| 106 | `src/queries/quality/self-audit.ts` — `function buildClojureSourceOracle(` | Accept (source rationale) |
| 107 | `src/reindex/affected-shadow.ts` — `export function collectAffectedSetShadowRecord(` | Accept (source rationale) |
| 108 | `src/reindex/index.ts` — `function reuseExistingIndexIfPossible(opts: {` | Accept (source rationale) |
| 109 | `src/reindex/index.ts` — `function planTypeScriptProjectShardReuse(` | Accept (source rationale) |
| 110 | `src/reindex/index.ts` — `function publishFullyReusedLanguageShardArtifacts(` | Accept (source rationale) |
| 111 | `src/reindex/index.ts` — `function materializeSqliteOutput(opts: {` | Accept (source rationale) |
| 112 | `src/reindex/index.ts` — `async function acquireReindexLock(` | Accept (source rationale) |
| 113 | `src/reindex/shared-generation-store.ts` — `export function readSharedGeneration(` | Accept (source rationale) |
| 114 | `src/reindex/shared-generation-store.ts` — `export function prepareSharedGenerationForProject(` | Accept (source rationale) |
| 115 | `src/reindex/shared-generation-store.ts` — `export async function acquireSharedGenerationBuildLock(` | Accept (source rationale) |
| 116 | `src/reindex/shared-generation-store.ts` — `export function touchExistingWorktreeLease(` | Accept (source rationale) |
| 117 | `src/reindex/shared-generation-store.ts` — `function importPeerGeneration(` | Accept (source rationale) |
| 118 | `src/reindex/shared-generation-store.ts` — `function validateSourceGeneration(` | Accept (source rationale) |
| 119 | `src/reindex/sqlite-generation-store.ts` — `export function promoteReindexArtifacts(input: PromoteReindexArtifactsInput): PromoteReindexArtifactsResult {` | Accept (source rationale) |
| 120 | `src/reindex/sqlite-generation-store.ts` — `export function refreshSqliteGenerationMetadata(` | Accept (source rationale) |
| 121 | `src/reindex/vue/augment-vue-workers.ts` — `export function awaitVueReferenceWorkers(opts: {` | Accept (source rationale) |
| 122 | `src/reindex/vue/augment-vue.ts` — `function augmentVueResolvedReferencesFromIndexedDocuments(opts: AugmentVueResolvedOptions): AugmentVueResolvedResult {` | Accept (source rationale) |
| 123 | `src/runtime/agent-hooks.ts` — `function ensureProjectHookGitExcludes(projectRoot: string, result: InstallUserAgentHooksResult, dryRun = false): void {` | Accept (source rationale) |
| 124 | `src/runtime/agent-hooks.ts` — `export function runStopHookDiffGate(hookInput: string): DiffGateResult \| undefined {` | Accept (source rationale) |
| 125 | `src/runtime/agent-hooks.ts` — `export async function renderAgentHookContext(hookInput: string): Promise<unknown \| undefined> {` | Accept (source rationale) |
| 126 | `src/runtime/ast-parser-setup.ts` — `export function setupAstParsers(` | Accept (source rationale) |
| 127 | `src/runtime/cleanup-verify.ts` — `export function deleteLineRanges(` | Accept (source rationale) |
| 128 | `src/runtime/cli-support.ts` — `export async function runIsolatedHealthReport(opts: HealthCliOptions): Promise<HealthReport> {` | Accept (source rationale) |
| 129 | `src/runtime/cli-support.ts` — `export async function runIsolatedDiffImpactReport(opts: DiffImpactCliOptions): Promise<DiffImpactResult> {` | Accept (source rationale) |
| 130 | `src/runtime/commands/command-execution.ts` — `function runCommandOutput<Output, Ctx extends DbCommandContext>(ctx: Ctx, spec: CommandOutputSpec<Output, Ctx>): void {` | Accept (source rationale) |
| 131 | `src/runtime/commands/command-handlers.ts` — `export async function handleBench(rawOpts: unknown): Promise<void> {` | Accept (source rationale) |
| 132 | `src/runtime/commands/command-handlers.ts` — `async function measureColdIndex(projectRoot: string): Promise<BenchIndexRun> {` | Accept (source rationale) |
| 133 | `src/runtime/commands/command-handlers.ts` — `export function handleCheckDeps(): void {` | Accept (source rationale) |
| 134 | `src/runtime/commands/command-handlers.ts` — `export function handleStatus(rawOpts: unknown): void {` | Accept (source rationale) |
| 135 | `src/runtime/commands/command-handlers.ts` — `function renderStatusReport(` | Accept (source rationale) |
| 136 | `src/runtime/diff-gate-outcomes.ts` — `export function recordDiffGateOutcomes(` | Accept (source rationale) |
| 137 | `src/runtime/health-report-cache.ts` — `export function readHealthReportCache(` | Accept (source rationale) |
| 138 | `src/runtime/health-report-cache.ts` — `export function writeHealthReportCache(` | Accept (source rationale) |
| 139 | `src/runtime/project-readiness.ts` — `export function getProjectReadiness(projectRoot: string, config: ProjectConfig): ProjectReadiness {` | Accept (source rationale) |
| 140 | `src/runtime/project-setup.ts` — `async function runSetupHealth(dbPath: string, steps: ProjectSetupStep[]): Promise<ProjectSetupHealthSummary> {` | Accept (source rationale) |
| 141 | `src/runtime/query-commands/tla.ts` — `const handleTla: CommandHandler = async (...rawArgs: unknown[]) => {` | Accept (source rationale) |
| 142 | `src/runtime/repository-cache-lifecycle.ts` — `function buildSweepInventory(` | Accept (source rationale) |
| 143 | `src/runtime/update-notice.ts` — `export async function maybePrintUpdateNotice(opts: UpdateNoticeOptions = {}): Promise<void> {` | Accept (source rationale) |
| 144 | `src/runtime/watch-service.ts` — `function inspectWatchServiceWithIdentity(` | Accept (source rationale) |
| 145 | `src/runtime/watch-service.ts` — `export function stopWatchService(opts: WatchServiceControllerOptions): WatchServiceStopResult {` | Accept (source rationale) |
| 146 | `src/runtime/watch-service.ts` — `export function acquireWatchProcessLock(` | Accept (source rationale) |
| 147 | `src/semantic/rust/callee-symbol-resolution.ts` — `export function createRustCalleeSymbolResolver(db: ScipDatabase): (callee: SemanticCallee) => string {` | Accept (source rationale) |
| 148 | `src/semantic/rust/durable-session-server.ts` — `async function runDurableRustSessionServer(sessionDir: string, semanticWorkerPath: string): Promise<void> {` | Accept (source rationale) |
| 149 | `src/semantic/rust/durable-session.ts` — `export function createDurableRustSessionIdentity(` | Accept (source rationale) |
| 150 | `src/semantic/rust/durable-session.ts` — `function dispatchDurableRustSessionRequest<Response>(` | Accept (source rationale) |
| 151 | `src/semantic/rust/durable-session.ts` — `function ensureDurableRustSessionServer(` | Accept (source rationale) |
| 152 | `src/semantic/rust/lsp-batch-worker.ts` — `export async function calleesForDefinition(` | Accept (source rationale) |
| 153 | `src/semantic/rust/lsp-session-readiness.ts` — `export async function waitForRustAnalyzerPostOpenReadiness(` | Accept (source rationale) |
| 154 | `src/semantic/rust/lsp-session-worker.ts` — `async function handleMessage(message: RustSessionWorkerMessage): Promise<void> {` | Accept (source rationale) |
| 155 | `src/semantic/rust/lsp-session.ts` — `export function createConfiguredRustAnalyzerSessionRequester(` | Accept (source rationale) |
| 156 | `src/semantic/shared-primitives.ts` — `export function exactSemanticCallerMap(` | Accept (source rationale) |
| 157 | `src/semantic/shared-primitives.ts` — `function buildSemanticSignature(db: ScipDatabase, definition: IndexedDefinition): string \| null {` | Accept (source rationale) |
| 158 | `src/semantic/typescript/remote-provider.ts` — `export function createServiceBackedTypeScriptProvider(` | Accept (source rationale) |
| 159 | `src/semantic/typescript/semantic-identity.ts` — `export function createTypeScriptSemanticIdentityBuilder(` | Accept (source rationale) |
| 160 | `src/semantic/typescript/session-service.ts` — `export function processTypeScriptSemanticMailbox(` | Accept (source rationale) |
| 161 | `src/semantic/typescript/tsserver-provider.ts` — `export function createTsServerProvider(db: ScipDatabase): SemanticProvider {` | Accept (source rationale) |
| 162 | `src/semantic/typescript/tsserver-provider.ts` — `export function compareTypeScriptReferenceProviders(` | Accept (source rationale) |
| 163 | `src/source/import-path-resolver.ts` — `function resolveTsconfigPathAliasImport(db: ScipDatabase, importerPath: string, specifier: string): string \| null {` | Accept (source rationale) |
| 164 | `src/source/import-path-resolver.ts` — `function resolveWorkspacePackageImport(db: ScipDatabase, specifier: string): string \| null {` | Accept (source rationale) |
| 165 | `src/source/react-profile.ts` — `function buildReactComponentBehaviorProfilesForFileUncached(` | Accept (source rationale) |
| 166 | `src/source/react-profile.ts` — `function reactCandidateForNode(node: SyntaxNode): ReactCandidate \| null {` | Accept (source rationale) |
| 167 | `src/source/react-profile.ts` — `function recordJsxElement(node: SyntaxNode, facts: JsxFacts): void {` | Accept (source rationale) |
| 168 | `src/source/react-profile.ts` — `function collectBehaviorFacts(root: SyntaxNode, language: AstLanguage): BehaviorFacts {` | Accept (source rationale) |
| 169 | `src/source/source-callables.ts` — `export function callableFactForNode(node: SyntaxNode, language: AstLanguage) {` | Accept (source rationale) |
| 170 | `src/source/vue/vue-profile.ts` — `function buildVueComponentBehaviorProfileUncached(` | Accept (source rationale) |
| 171 | `src/source/vue/vue-script-facts.ts` — `export function buildVueScriptFacts(unit: VueSfcUnit): VueScriptFacts {` | Accept (source rationale) |
| 172 | `src/source/vue/vue-template.ts` — `function recordElement(` | Accept (source rationale) |
| 173 | `src/symbols/references/reference-sites.ts` — `export function referenceEvidenceForSymbol(` | Accept (source rationale) |
| 174 | `src/symbols/symbol-lookup.ts` — `export function resolveSymbol(db: ScipDatabase, symbolPattern: string): SymbolResolution {` | Accept (source rationale) |
| 175 | `src/symbols/symbol-lookup.ts` — `function pathQualifiedCandidates(` | Accept (source rationale) |
| 176 | `src/symbols/symbol-lookup.ts` — `function fuzzySymbolResolution(db: ScipDatabase, symbolPattern: string): SymbolResolution {` | Accept (source rationale) |
| 177 | `src/symbols/symbol-lookup.ts` — `export function nearestSymbolNames(db: ScipDatabase, symbolPattern: string, limit = 5): string[] {` | Accept (source rationale) |
| 178 | `src/tla/conformance.ts` — `function aliasesForVariables(` | Accept (source rationale) |
| 179 | `src/tla/conformance.ts` — `function resolveActions(` | Accept (source rationale) |
| 180 | `src/tla/conformance.ts` — `function collectAstReads(` | Accept (source rationale) |
| 181 | `src/tla/conformance.ts` — `function recordStatementCallNode(` | Accept (source rationale) |
| 182 | `src/tla/conformance.ts` — `function collectSourceScanWrites(` | Accept (source rationale) |
| 183 | `src/tla/conformance.ts` — `function collectSourceScanReads(` | Accept (source rationale) |
| 184 | `src/tla/conformance.ts` — `function resolveReferent(` | Accept (source rationale) |
| 185 | `src/tla/model-contract.ts` — `function parseContract(raw: unknown, errors: string[]): TlaModelContract \| null {` | Accept (source rationale) |
| 186 | `src/tla/model-contract.ts` — `function parseVariables(raw: unknown, errors: string[]): Record<string, TlaVariableMapping> {` | Accept (source rationale) |
| 187 | `src/tla/tool-runner.ts` — `function resolveTlaCommand(opts: TlaToolRunOptions, spawn: CommandAvailabilitySpawn): ResolvedCommand {` | Accept (source rationale) |
| 188 | `src/semantic/rust/durable-session.ts` — `handle(request: DurableRustSessionRequest)` | Accept E1 |
| 189 | `src/semantic/rust/lsp-client.ts` — `request<T>(method, params, opts)` | Accept E1 |
| 190 | `src/semantic/rust/lsp-client.ts` — `dispatchMessage(message)` | Accept E1 |
| 191 | `src/semantic/rust/lsp-session.ts` — `fallbackReferencesAndCallees()` | Accept E1 |
| 192 | `src/semantic/typescript/session-service.ts` — `handle(generation, request)` | Accept E1 |
| 193 | `src/semantic/typescript/session-service.ts` — `syncGeneration(requestedGeneration)` | Accept E1 |
| 194 | `src/semantic/typescript/ts-morph-provider.ts` — `addHierarchyMemberReferences()` | Accept E3 |
| 195 | `src/semantic/typescript/ts-morph-provider.ts` — `semanticCalleeForCallNode()` | Accept E2 |

## Stale-abstraction candidates

All 52 rows are named TypeScript contracts. The two high-confidence rows are
service status messages owned by protocol modules; the other 50 are used by
their defining modules to construct, validate, or constrain the data. Inlining
these shapes would remove contract names without removing behavior.

|   # | Candidate                                                                         | Disposition |
| --: | --------------------------------------------------------------------------------- | ----------- |
|   1 | `src:reindex:typescript-index-protocol:TypeScriptIndexServiceStatus`              | Accept S1   |
|   2 | `src:semantic:typescript:session-protocol:TypeScriptSemanticServiceStatus`        | Accept S1   |
|   3 | `src:reindex:typescript-incremental-index:MaterializedTypeScriptIncrementalIndex` | Accept S1   |
|   4 | `src:reindex:affected-shadow:AffectedSetShadowStatus`                             | Accept S1   |
|   5 | `src:runtime:cli-support:HealthSemanticPrewarmRuntime`                            | Accept S1   |
|   6 | `src:runtime:repository-cache-lifecycle:SharedCacheStatus`                        | Accept S1   |
|   7 | `src:tla:conformance:TlaConformanceResult`                                        | Accept S1   |
|   8 | `src:tla:tool-runner:TlaToolRunOptions`                                           | Accept S1   |
|   9 | `src:runtime:project-setup:ProjectSetupOptions`                                   | Accept S1   |
|  10 | `src:queries:health:finding-outcome-ledger:DetectorPrecisionStats`                | Accept S1   |
|  11 | `src:reindex:sqlite-generation-store:SqliteGenerationInspection`                  | Accept S1   |
|  12 | `src:semantic:rust:lsp-session:RustSemanticSessionStatus`                         | Accept S1   |
|  13 | `src:reindex:vue:augment-vue:VueReferenceComputationOptions`                      | Accept S1   |
|  14 | `src:runtime:agent-hooks:InstallUserAgentHooksResult`                             | Accept S1   |
|  15 | `src:runtime:ast-parser-setup:AstParserSetupResult`                               | Accept S1   |
|  16 | `src:runtime:project-setup:ProjectSetupGuidedAction`                              | Accept S1   |
|  17 | `src:reindex:affected-shadow:AffectedSetShadowRuntime`                            | Accept S1   |
|  18 | `src:tla:model-contract:TlaModuleFacts`                                           | Accept S1   |
|  19 | `src:analysis:framework-patterns:ExclusionEntry`                                  | Accept S1   |
|  20 | `src:reindex:affected-shadow:EvaluatedAffectedSetShadowRecord`                    | Accept S1   |
|  21 | `src:reindex:typescript-document-emitter:TypeScriptDocumentEmitterOptions`        | Accept S1   |
|  22 | `src:runtime:repository-cache-lifecycle:RepositoryCacheLeaseInventory`            | Accept S1   |
|  23 | `src:runtime:watch-service:WatchServiceInspection`                                | Accept S1   |
|  24 | `src:semantic:rust:durable-session:DurableRustSessionIdentityRuntime`             | Accept S1   |
|  25 | `src:semantic:rust:lsp-session-worker:RustAnalyzerSessionState`                   | Accept S1   |
|  26 | `src:storage:evidence-cache:SemanticCalleeCacheEntry`                             | Accept S1   |
|  27 | `src:platform:project-files:ProjectInputFingerprintOptions`                       | Accept S1   |
|  28 | `src:runtime:project-setup:ProjectSetupGuidedFiles`                               | Accept S1   |
|  29 | `src:runtime:repository-cache-lifecycle:RepositoryCacheGenerationInventory`       | Accept S1   |
|  30 | `src:semantic:rust:durable-session:DurableRustSessionServerState`                 | Accept S1   |
|  31 | `src:semantic:rust:lsp-session-readiness:RustAnalyzerReadinessClient`             | Accept S1   |
|  32 | `src:symbols:graph:call-graph-evidence:CalleeRow`                                 | Accept S1   |
|  33 | `src:platform:watch-service-state:WatchServicePaths`                              | Accept S1   |
|  34 | `src:reindex:affected-shadow:DocumentFactRecord`                                  | Accept S1   |
|  35 | `src:reindex:typescript-index-protocol:TypeScriptIndexMailboxPaths`               | Accept S1   |
|  36 | `src:runtime:agent-setup:RemoveAgentSetupResult`                                  | Accept S1   |
|  37 | `src:runtime:cli-support:AnalysisBudgetDisclosure`                                | Accept S1   |
|  38 | `src:runtime:config:ProjectAutomaticRefreshConfigResult`                          | Accept S1   |
|  39 | `src:runtime:setup:UninstallSkillsResult`                                         | Accept S1   |
|  40 | `src:semantic:rust:engine-identity:RustCompilerEngineIdentity`                    | Accept S1   |
|  41 | `src:semantic:typescript:session-protocol:TypeScriptSemanticMailboxPaths`         | Accept S1   |
|  42 | `src:platform:git-worktree:GitReader`                                             | Accept S1   |
|  43 | `src:runtime:watch-service:WatchServiceEnsureResult`                              | Accept S1   |
|  44 | `src:runtime:watch-service:WatchServiceAutoEnsureResult`                          | Accept S1   |
|  45 | `src:source:source-facts:SourceFactsUnavailable`                                  | Accept S1   |
|  46 | `src:tla:trace-spec:TraceActionCoverage`                                          | Accept S1   |
|  47 | `src:reindex:typescript-document-emitter:TypeScriptDocumentEmitterCreation`       | Accept S1   |
|  48 | `src:runtime:profile-work-audit:ProfileEvent`                                     | Accept S1   |
|  49 | `src:semantic:rust:import-usage:RustSourceImportUsageResolver`                    | Accept S1   |
|  50 | `src:semantic:typescript:semantic-identity:TypeScriptSemanticIdentityBuilder`     | Accept S1   |
|  51 | `src:semantic:typescript:semantic-identity:TypeScriptSemanticIdentity`            | Accept S1   |
|  52 | `src:reindex:affected-shadow:AffectedShadowDatabase`                             | Accept S1   |

## Duplicate-body candidates

| Candidate pair                                                    | Disposition | Reason                                                                                                                                        |
| ----------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `reactHookRecommendation()` / `vueComposableRecommendation()`     | Accept D1   | The cases are parallel, but the recommendations name different framework mechanisms: React hooks/controllers versus Vue composables/stores.   |
| `reactComponentRecommendation()` / `vueComponentRecommendation()` | Accept D1   | The functions preserve framework-specific UI vocabulary and may evolve with different framework guidance.                                     |
| `echoRemediation()` / `baselineRemediation()`                     | Accept D1   | One explains cross-file echo remediation; the other explains baseline policy. Their control shape matches, but their product policies do not. |

## Similarity candidates

| Candidate pair                                                                    | Disposition | Reason                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareSharedGenerationForProject()` / `publishFreshLocalGenerationForProject()` | Accept M1   | Preparation reads or imports an available generation; publication creates and leases a fresh generation. They share cache/worktree primitives because they are adjacent lifecycle stages, not because they are the same operation. |
| `duplicateBodyCandidates()` / `similarSignatureCandidates()`                      | Accept M1   | Both enumerate definitions through common query infrastructure, but one compares normalized implementations and the other compares callable signatures.                                                                            |

## Wrapper and passthrough candidates

| Candidate                        | Disposition | Reason                                                                                                                                                                                                                       |
| -------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isValidWatchServiceTimestamp()` | Accept W1   | The predicate is referenced eleven times by state, refresh, service-status, activity, and lock validation. The wrapper detector reports one external consumer but does not count those same-module uses as separate callers. |
| `computeReindexFingerprint()`    | Fix F1      | The private one-use function only called `buildProjectInputFingerprint()` with unchanged arguments. The call is now direct inside the existing `reindex.fingerprint` profile span.                                           |

## Ratchet policy

The source suppressions are reviewed-state exceptions: each is attached to one
exact declaration and one detector category, with a nearby reason. They are
not detector-wide disables. After these accepted rows are filtered and the
one legitimate passthrough is fixed, the health baseline contains no current
maintainability identities. Any new unsuppressed identity therefore fails the
baseline check.
