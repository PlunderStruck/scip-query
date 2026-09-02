export { stats } from './navigation/stats.js';
export { files } from './navigation/files.js';
export { searchSource } from './navigation/source-search.js';
export { discoverAnchors, normalizeAnchorQuery } from './graph/anchor-discovery.js';
export { inspectSource } from './navigation/source-inspection.js';
export { symbols } from './navigation/symbols.js';
export { methods, resolveMethods } from './navigation/methods.js';
export { refs } from './navigation/refs.js';
export { qualifiedTraceEvidence, trace, traceEvidence } from './navigation/trace.js';
export { evidence, qualifiedEvidence } from './navigation/evidence.js';
export { GRAPH_EVIDENCE_FAMILIES, GRAPH_EVIDENCE_VIEWS, graphEvidence } from './graph/graph-evidence.js';
export { deps, rdeps } from './navigation/deps.js';
export { moduleMap, system } from './navigation/system.js';
export { consumerSurface, surface } from './navigation/surface.js';
export { dead } from './cleanup/dead.js';
export { hotspots, referenceHotspots } from './graph/hotspots.js';
export { imports, importedBy, unusedImports } from './navigation/imports.js';
export { outline } from './navigation/outline.js';
export { members } from './navigation/members.js';
export { externalSymbolFanOut, fanIn, fanOut, fileDependencyOutDegree, topFanIn, topFanOut } from './graph/fan.js';
export { coupling, sharedSymbolCoupling, topCoupling, topSharedSymbolCoupling } from './graph/coupling.js';
export { cycles, cycleSummary, dependencyCycles, dependencyCycleSummary } from './graph/cycles.js';
export { analyzeArchitectureGraph, architecture, architectureFindingIdentities } from './graph/architecture.js';
export { bottlenecks, coordinationHubs } from './graph/bottlenecks.js';
export { isolated } from './cleanup/isolated.js';
export { byKind, kindCounts } from './navigation/by-kind.js';
export { deepChains, dependencyDepth } from './graph/deep-chains.js';
export { hierarchy, ownershipChain } from './navigation/hierarchy.js';
export { callGraph } from './navigation/call-graph.js';
export { entryCallMap, entryPoints } from './graph/entry-map.js';
export { systemMap } from './graph/system-map.js';
export { similar, similarAll, similarAllCount, similarConsolidationPlan } from './cleanup/similar.js';
export { similarFiles } from './cleanup/similar-files.js';
export { reactComponentDuplicates } from './frontend/react-component-duplicates.js';
export { reactHookCandidates } from './frontend/react-hook-candidates.js';
export { reactLargeComponentPressure } from './frontend/react-large-component-pressure.js';
export { vueComponentDuplicates } from './frontend/vue-component-duplicates.js';
export { vueComposableCandidates } from './frontend/vue-composable-candidates.js';
export { vueLargeViewPressure } from './frontend/vue-large-view-pressure.js';
export { similarChains } from './cleanup/similar-chains.js';
export { extractCandidates } from './cleanup/extract-candidates.js';
export { localityCandidates } from './cleanup/locality-candidates.js';
export { affected, possibleImpactClosure } from './graph/affected.js';
export { changeSurface } from './impact/change-surface.js';
export { cleanupPlan } from './cleanup/cleanup-plan.js';
export { incompleteMigration } from './impact/incomplete-migration.js';
export { coChange } from './cleanup/co-change.js';
export { docDrift } from './cleanup/doc-drift.js';
export {
  duplicateBodies,
  duplicateBodyScan,
  exactDuplicateBodyMatches,
  normalizeBody,
  groupByHash,
} from './cleanup/duplicate-bodies.js';
export { twinDrift, groupTwins, allTwinGroups } from './cleanup/twin-drift.js';
export { twinAb, defaultTwinAbOutPath } from './cleanup/twin-ab.js';
export { notImplemented } from './cleanup/not-implemented.js';
export { decorativeCheckers } from './cleanup/decorative-checkers.js';
export { testQuality } from './cleanup/test-quality.js';
export { recentDuplicates } from './cleanup/recent-duplicates.js';
export { repositoryContext } from './impact/context.js';
/** @deprecated Use `repositoryContext`. */
export { planContext } from './impact/plan-context.js';
export { checkHealthBaseline, collectBaselineFindings, writeHealthBaseline } from './health/health-baseline.js';
export { checkArchitectureBaseline } from './graph/architecture-baseline.js';
export {
  createBaseContentResultReader,
  diffImpact,
  diffImpactPartial,
  diffImpactPlan,
  mergeDiffImpactPartials,
  readBaseContent,
  readBaseContents,
} from './impact/diff-impact.js';
export { drift } from './cleanup/drift.js';
export { wrapperCandidates } from './cleanup/wrapper-candidates.js';
export { passthroughCandidates } from './cleanup/passthrough-candidates.js';
export { staleAbstractions } from './cleanup/stale-abstractions.js';
export { unusedParams } from './cleanup/unused-params.js';
export { complexityHotspots } from './quality/complexity-hotspots.js';
export { HEALTH_PHASES, health, healthPhase, healthReportFromPhases } from './health/health.js';
export { convergence } from './cleanup/convergence.js';
export { code, codeBatch } from './navigation/code.js';
export { complexity } from './quality/complexity.js';
export { dataflow, referenceNeighborhood } from './navigation/dataflow.js';
export { valueFlow } from './graph/value-flow.js';
export { slice, referenceReachability } from './navigation/slice.js';
export { dependenceSlice } from './graph/dependence-slice.js';
export { redundantReexports } from './cleanup/redundant-reexports.js';
export { selfAudit } from './quality/self-audit.js';
export { similarSignatures } from './cleanup/similar-signatures.js';

export type { StatsResult } from './navigation/stats.js';
export type { FileResult } from './navigation/files.js';
export type {
  SourceSearchFileCoverage,
  SourceSearchIdentity,
  SourceSearchIdentityCoverage,
  SourceSearchMatch,
  SourceSearchOptions,
  SourceSearchResult,
  SourceSearchScopeHint,
  SourceSearchTextCoverage,
  SourceObservationFreshness,
  SourceSemanticFreshnessState,
} from './navigation/source-search.js';
export type {
  AnchorDiscoveryCandidate,
  AnchorDiscoveryGroup,
  AnchorDiscoveryMatchSource,
  AnchorDiscoveryOptions,
  AnchorDiscoveryRelation,
  AnchorDiscoveryResult,
  AnchorDiscoveryTermMatch,
  AnchorDiscoveryUpstreamEntry,
} from './graph/anchor-discovery.js';
export type {
  SourceInspectionContinuation,
  SourceInspectionChannelCoverage,
  SourceInspectionEvidenceBudgets,
  SourceInspectionEvidenceChannel,
  SourceInspectionLocation,
  SourceInspectionOmissionAnchor,
  SourceInspectionOmissionGroup,
  SourceInspectionOptions,
  SourceInspectionPacketCoverage,
  SourceInspectionPathUnit,
  SourceInspectionResult,
  SourceInspectionRuntimeFact,
  SourceInspectionSearch,
  SourceInspectionSearchScope,
  SourceInspectionSlice,
  SourceInspectionSourceUnit,
  SourceInspectionStoppingStatus,
  SourceInspectionStoppingSummary,
  SourceInspectionUnit,
  SourceInspectionUnitRole,
  SourceInspectionView,
  BehaviorSignal,
  BehaviorSkeleton,
} from './navigation/source-inspection.js';
export type { SymbolResult } from './navigation/symbols.js';
export type { MethodResult, MethodsOwner, MethodsResolution, ResolveMethodsOptions } from './navigation/methods.js';
export type { RefResult } from './navigation/refs.js';
export type { DepResult } from './navigation/deps.js';
export type {
  QualifiedTraceEvidenceResult,
  TraceClaimEligibility,
  TraceClaimSupport,
  TraceEvidenceResult,
  TraceReferenceEvidence,
  TraceReferenceProvenance,
  TraceReferenceSourceKind,
  TraceResult,
} from './navigation/trace.js';
export type {
  EvidenceOptions,
  EvidencePart,
  EvidenceReferenceWindow,
  EvidenceRelatedSymbol,
  EvidenceResult,
  QualifiedEvidenceResult,
} from './navigation/evidence.js';
export type {
  GraphEvidenceCoverage,
  GraphEvidenceEdge,
  GraphEvidenceFamily,
  GraphEvidenceFold,
  GraphEvidenceInventoryRow,
  GraphEvidenceNode,
  GraphEvidenceOptions,
  GraphEvidenceResult,
  GraphEvidenceSelection,
  GraphEvidenceSelectors,
  GraphEvidenceTarget,
  GraphEvidenceView,
  GraphProjectionDirection,
} from './graph/graph-evidence.js';
export type { SystemResult } from './navigation/system.js';
export type { ConsumerSurfaceResult, SurfaceResult } from './navigation/surface.js';
export type { DeadSymbolResult, DeadSummary } from './cleanup/dead.js';
export type { HotspotResult } from './graph/hotspots.js';
export type { ImportResult, UnusedImportResult } from './navigation/imports.js';
export type { OutlineNode } from './navigation/outline.js';
export type { MemberResult } from './navigation/members.js';
export type { FanResult } from './graph/fan.js';
export type { CouplingResult } from './graph/coupling.js';
export type { CycleResult, CycleSummary, FileDependencyEdgeBasis } from './graph/cycles.js';
export type {
  ArchitectureAmbiguousFile,
  ArchitectureBoundaryEdge,
  ArchitectureBoundarySummary,
  ArchitectureCoverage,
  ArchitectureCycle,
  ArchitectureFileEdge,
  ArchitecturePolicyStatus,
  ArchitectureReciprocalPair,
  ArchitectureReport,
} from './graph/architecture.js';
export type { BottleneckResult, CoordinationHubCalleeEvidence } from './graph/bottlenecks.js';
export type { IsolatedResult } from './cleanup/isolated.js';
export type { ByKindResult } from './navigation/by-kind.js';
export type { DeepChainResult } from './graph/deep-chains.js';
export type { HierarchyNode } from './navigation/hierarchy.js';
export type { CallGraphEvidenceRow, CallGraphResult } from './navigation/call-graph.js';
export type {
  EntryCallMapResult,
  EntryMapCoverage,
  EntryMapExternalCall,
  EntryMapRegion,
  EntryMapRegionEdge,
  EntryMapSymbol,
  EntryMapSymbolEdge,
  EntryPointConfidence,
  EntryPointEvidence,
  EntryPointResult,
  EntryPointsOptions,
} from './graph/entry-map.js';
export type {
  ConnectedBehaviorLine,
  ConnectedBehaviorOptions,
  ConnectedBehaviorPacket,
  ConnectedBehaviorPath,
  ConnectedBehaviorRepresentation,
  ConnectedBehaviorStep,
  ConnectedBehaviorStepRole,
  ConnectedBehaviorTransition,
  SystemMapAnchor,
  SystemMapAnchorCandidate,
  SystemMapAnchorKind,
  SystemMapAnchorStatus,
  SystemMapBoundaryParticipant,
  SystemMapCoverage,
  SystemMapDrilldown,
  SystemMapDrilldownAnchor,
  SystemMapEvidenceFloor,
  SystemMapExternalBoundary,
  SystemMapFile,
  SystemMapLiteralHit,
  SystemMapNotableSymbol,
  SystemMapOptions,
  SystemMapRegion,
  SystemMapRegionRelation,
  SystemMapReferenceScope,
  SystemMapRelation,
  SystemMapRelationEvidence,
  SystemMapRelationFamilyCoverage,
  SystemMapRelationKind,
  SystemMapRelationStrength,
  SystemMapResult,
  SystemMapSourceScope,
  SystemMapSourceConstruct,
  SystemMapSymbol,
} from './graph/system-map.js';
export type {
  ExplorationAnchorStatus,
  ExplorationDisposition,
  ExplorationDispositionCounts,
  ExplorationCompletion,
  ExplorationCompletionStatus,
  ExplorationEvidenceSource,
  ExplorationEvidenceStrength,
  ExplorationFrontierGroup,
  ExplorationSourceLocation,
  ExplorationTopology,
  ExplorationTopologyAnchor,
  ExplorationTopologyCoverage,
  ExplorationTopologyEdge,
  ExplorationTopologyInput,
  ExplorationTopologyNode,
  ExplorationTopologyPath,
} from './internal/exploration-topology.js';
export type {
  DriftActionTier,
  DriftArchitectureEvidence,
  DriftPolicyBasis,
  DriftResult,
  DriftSummary,
} from './cleanup/drift.js';
export type { WrapperActionTier, WrapperCandidate } from './cleanup/wrapper-candidates.js';
export type { PassthroughCandidate } from './cleanup/passthrough-candidates.js';
export type { StaleAbstraction, StaleAbstractionActionTier, StalenessKind } from './cleanup/stale-abstractions.js';
export type { UnusedParamsFinding } from './cleanup/unused-params.js';
export type { ComplexityHotspot } from './quality/complexity-hotspots.js';
export type {
  SimilarActionTier,
  SimilarConsolidationPlan,
  SimilarEvidenceClass,
  SimilarSymbolResult,
} from './cleanup/similar.js';
export type { SimilarFileResult } from './cleanup/similar-files.js';
export type { ReactComponentDuplicateResult } from './frontend/react-component-duplicates.js';
export type {
  ReactHookActionTier,
  ReactHookCandidateResult,
  ReactHookEvidenceClass,
} from './frontend/react-hook-candidates.js';
export type {
  ReactLargeComponentContextKind,
  ReactLargeComponentPressureResult,
  ReactLargeComponentRecommendationKind,
} from './frontend/react-large-component-pressure.js';
export type { VueComponentDuplicateResult } from './frontend/vue-component-duplicates.js';
export type {
  VueComposableActionTier,
  VueComposableCandidateResult,
  VueComposableEvidenceClass,
} from './frontend/vue-composable-candidates.js';
export type {
  VueLargeViewContextKind,
  VueLargeViewPressureResult,
  VueLargeViewRecommendationKind,
} from './frontend/vue-large-view-pressure.js';
export type { SimilarChainResult } from './cleanup/similar-chains.js';
export type {
  ExtractCandidate,
  ExtractCandidateActionTier,
  ExtractCandidateKind,
} from './cleanup/extract-candidates.js';
export type {
  LocalityActionTier,
  LocalityCandidate,
  LocalityCandidatesOptions,
  LocalityConsumerCoverage,
  LocalityDirectoryAncestor,
  LocalityRecommendedTier,
  LocalitySourceUnit,
} from './cleanup/locality-candidates.js';
export type { HealthAction, HealthReport } from './health/health-report.js';
export type { ConvergenceResult } from './cleanup/convergence.js';
export type {
  CodeBatchEntry,
  CodeBatchResult,
  CodeFileCoverage,
  CodeFileDefinitionLedgerEntry,
  CodeFileMemberMode,
  CodeRangeCoverage,
  CodeResolutionCandidate,
  CodeResult,
  CodeSelectorKind,
  CodeSelectorStatus,
} from './navigation/code.js';
export type { BindingClosure, BindingDefinitionEvidence, CoveredSourceRange } from './navigation/binding-closure.js';
export type { ComplexityResult } from './quality/complexity.js';
export type { DataflowResult, ReferenceNeighborhoodResult } from './navigation/dataflow.js';
export type { ValueFlowCoverage, ValueFlowResult } from './graph/value-flow.js';
export type { SliceResult } from './navigation/slice.js';
export type {
  DependenceSliceCoverage,
  DependenceSliceDirection,
  DependenceSliceEdge,
  DependenceSliceResult,
} from './graph/dependence-slice.js';
export type { AffectedResult } from './graph/affected.js';
export type { ChangeSurfaceEntry, ChangeSurfaceResult } from './impact/change-surface.js';
export type { CleanupBatch, CleanupPlanEntry, CleanupPlanResult } from './cleanup/cleanup-plan.js';
export type { CoChangeFinding, CoChangeResult } from './cleanup/co-change.js';
export type { DocDriftFinding, DocDriftResult, DocDriftSubject, DocFileCitation } from './cleanup/doc-drift.js';
export type { DuplicateBodyEntry, DuplicateBodyGroup } from './cleanup/duplicate-bodies.js';
export type { TwinGroup, TwinMember, TwinRelationship, TwinDriftRecord } from './cleanup/twin-drift.js';
export type { TwinAbOptions, TwinAbOutcome, TwinAbSuccess, TwinAbRefusal, TwinAbSymbol } from './cleanup/twin-ab.js';
export type {
  NotImplementedFinding,
  NotImplementedStubKind,
  NotImplementedReachability,
} from './cleanup/not-implemented.js';
export type {
  DecorativeCheckerFinding,
  DecorativeCheckerNameKind,
  DecorativeCheckerResolution,
} from './cleanup/decorative-checkers.js';
export type {
  TestQualityReport,
  TestQualityOptions,
  AssertionFreeFinding,
  AssertionFreeSeverity,
  SkippedTestFinding,
  SkippedTestKind,
  SkipRot,
  MockEchoFinding,
} from './cleanup/test-quality.js';
export type {
  RecentDuplicateBasis,
  RecentDuplicateDomain,
  RecentDuplicateFinding,
  RecentDuplicatesResult,
} from './cleanup/recent-duplicates.js';
export type { BaselineComparison, HealthBaselineFile } from './internal/baseline-file.js';
export type {
  RepositoryContextAffectedConsumer,
  RepositoryContextConsumerReuse,
  RepositoryContextConsumerReuseCandidate,
  RepositoryContextConsumerReuseCoverage,
  RepositoryContextOptions,
  RepositoryContextPrimaryCallable,
  RepositoryContextResult,
  RepositoryContextSourcePacket,
  RepositoryContextSourceSlice,
} from './impact/context.js';
/** @deprecated Use the corresponding `RepositoryContext*` types. */
export type { PlanContextHistory, PlanContextOptions, PlanContextResult } from './impact/plan-context.js';
export type {
  BaseContentGitRuntime,
  BaseContentLookupOptions,
  BaseContentReaderOptions,
  BaseContentResult,
  BaseContentResultReader,
  BaseContentsLookupOptions,
  DiffImpactEvidenceRuntime,
  DiffImpactEvidenceTier,
  DiffImpactEvidenceTierStatus,
  DiffImpactPartial,
  DiffImpactPartialOptions,
  DiffImpactResult,
} from './impact/diff-impact.js';
export type { RedundantReexport, RedundantReexportActionTier } from './cleanup/redundant-reexports.js';
export type { AuditDisagreement, AuditQuestionScore, SelfAuditResult } from './quality/self-audit.js';
export type { SimilarSignatureGroup } from './cleanup/similar-signatures.js';
/** @deprecated Historical outcome-event record types; the journal itself was retired. */
export type {
  OutcomeEvent,
  OutcomeEventKind,
  OutcomeObserverAuthority,
  OutcomeObserverKind,
  OutcomeObserverProvenance,
} from './compatibility/outcome-events.js';
