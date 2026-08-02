export { stats } from './navigation/stats.js';
export { files } from './navigation/files.js';
export { symbols } from './navigation/symbols.js';
export { methods, resolveMethods } from './navigation/methods.js';
export { refs } from './navigation/refs.js';
export { trace } from './navigation/trace.js';
export { deps, rdeps } from './navigation/deps.js';
export { system } from './navigation/system.js';
export { surface } from './navigation/surface.js';
export { dead } from './cleanup/dead.js';
export { hotspots } from './graph/hotspots.js';
export { imports, importedBy, unusedImports } from './navigation/imports.js';
export { outline } from './navigation/outline.js';
export { members } from './navigation/members.js';
export { fanIn, fanOut, topFanIn, topFanOut } from './graph/fan.js';
export { coupling, topCoupling } from './graph/coupling.js';
export { cycles, cycleSummary } from './graph/cycles.js';
export { analyzeArchitectureGraph, architecture } from './graph/architecture.js';
export { bottlenecks } from './graph/bottlenecks.js';
export { isolated } from './cleanup/isolated.js';
export { byKind, kindCounts } from './navigation/by-kind.js';
export { deepChains } from './graph/deep-chains.js';
export { hierarchy } from './navigation/hierarchy.js';
export { callGraph } from './navigation/call-graph.js';
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
export { affected } from './graph/affected.js';
export { changeSurface } from './impact/change-surface.js';
export { cleanupPlan } from './cleanup/cleanup-plan.js';
export {
  DIFF_GATE_CHECKS,
  diffGate,
  blockingFindings,
  diffGateFailedClosed,
  diffGateFailureReason,
} from './impact/diff-gate.js';
export { incompleteMigration } from './impact/incomplete-migration.js';
export { coChange } from './cleanup/co-change.js';
export { docDrift } from './cleanup/doc-drift.js';
export { duplicateBodies, exactDuplicateBodyMatches, normalizeBody, groupByHash } from './cleanup/duplicate-bodies.js';
export { twinDrift, groupTwins, allTwinGroups } from './cleanup/twin-drift.js';
export { twinAb, defaultTwinAbOutPath } from './cleanup/twin-ab.js';
export { notImplemented } from './cleanup/not-implemented.js';
export { decorativeCheckers } from './cleanup/decorative-checkers.js';
export { testQuality } from './cleanup/test-quality.js';
export { recentDuplicates } from './cleanup/recent-duplicates.js';
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
export { computeEffectiveness, parseSinceMs } from './health/effectiveness.js';
export { convergence } from './cleanup/convergence.js';
export { code } from './navigation/code.js';
export { complexity } from './quality/complexity.js';
export { dataflow } from './navigation/dataflow.js';
export { slice } from './navigation/slice.js';
export { redundantReexports } from './cleanup/redundant-reexports.js';
export { selfAudit } from './quality/self-audit.js';
export { similarSignatures } from './cleanup/similar-signatures.js';

export type { StatsResult } from './navigation/stats.js';
export type { FileResult } from './navigation/files.js';
export type { SymbolResult } from './navigation/symbols.js';
export type { MethodResult, MethodsOwner, MethodsResolution, ResolveMethodsOptions } from './navigation/methods.js';
export type { RefResult } from './navigation/refs.js';
export type { DepResult } from './navigation/deps.js';
export type { TraceResult } from './navigation/trace.js';
export type { SystemResult } from './navigation/system.js';
export type { SurfaceResult } from './navigation/surface.js';
export type { DeadSymbolResult, DeadSummary } from './cleanup/dead.js';
export type { HotspotResult } from './graph/hotspots.js';
export type { ImportResult, UnusedImportResult } from './navigation/imports.js';
export type { OutlineNode } from './navigation/outline.js';
export type { MemberResult } from './navigation/members.js';
export type { FanResult } from './graph/fan.js';
export type { CouplingResult } from './graph/coupling.js';
export type { CycleResult, CycleSummary } from './graph/cycles.js';
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
export type { BottleneckResult } from './graph/bottlenecks.js';
export type { IsolatedResult } from './cleanup/isolated.js';
export type { ByKindResult } from './navigation/by-kind.js';
export type { DeepChainResult } from './graph/deep-chains.js';
export type { HierarchyNode } from './navigation/hierarchy.js';
export type { CallGraphResult } from './navigation/call-graph.js';
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
  CheckEffectiveness,
  EffectivenessAnomaly,
  EffectivenessAnomalySample,
  EffectivenessAuthority,
  EffectivenessOptions,
  EffectivenessProvenanceSummary,
  EffectivenessReport,
  OutcomeEvent,
  OutcomeEventKind,
  OutcomeObserverAuthority,
  OutcomeObserverKind,
  OutcomeObserverProvenance,
} from './health/effectiveness.js';
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
export type { CodeResult } from './navigation/code.js';
export type { ComplexityResult } from './quality/complexity.js';
export type { DataflowResult } from './navigation/dataflow.js';
export type { SliceResult } from './navigation/slice.js';
export type { AffectedResult } from './graph/affected.js';
export type { ChangeSurfaceEntry, ChangeSurfaceResult } from './impact/change-surface.js';
export type { CleanupBatch, CleanupPlanEntry, CleanupPlanResult } from './cleanup/cleanup-plan.js';
export type {
  DiffGateActionTier,
  DiffGateCheck,
  DiffGateFinding,
  DiffGateResult,
  DocCitationKind,
} from './impact/diff-gate.js';
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
  PlanContextAffectedConsumer,
  PlanContextConsumerReuse,
  PlanContextConsumerReuseCandidate,
  PlanContextConsumerReuseCoverage,
  PlanContextOptions,
  PlanContextPrimaryCallable,
  PlanContextResult,
  PlanContextSourcePacket,
  PlanContextSourceSlice,
} from './impact/plan-context.js';
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
