import type {
  ChangeAmplificationSummary,
  CountLocSummary,
  HealthAnalyses,
  PolicyExclusionSummary,
} from './health-types.js';
import type { DetectorEvidenceAssessment } from './detector-evidence-contracts.js';

export type FindingEvidence = 'graph-fact' | 'heuristic' | 'change-graph';

export interface HealthAction {
  category: string;
  description: string;
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  count: number;
  locRecoverable: number;
  /** What kind of evidence backs this action — agents should trust accordingly. */
  evidence: FindingEvidence;
  /** Descriptor id in detectorEvidence; absent for analyses without a typed detector contract. */
  evidenceContractId?: string;
}

/** One detector policy that removed rows from a finding count, with the count it removed. */
export interface HealthPolicyExclusion {
  detector: string;
  reason: string;
  detail: string;
  count: number;
}

export interface HealthAxes {
  /** LOC in indexed no-observed-reference candidates (legacy field name: deletable). */
  deletable: { loc: number; symbols: number };
  cycles: { count: number };
  /** Files touched per observed commit; a commit may contain several unrelated changes. */
  changeAmplification: ChangeAmplificationSummary | null;
  /** File pairs changed in the same commits without an observed structural link; this is historical association. */
  hiddenCoupling: {
    pairCount: number;
    scoreCount: number;
    top: Array<{ fileA: string; fileB: string; together: number; confidence: number; scoreWeight?: number }>;
  } | null;
  /** What fraction of findings rest on graph facts vs heuristics, and how many the user has rejected. */
  evidenceQuality: {
    graphFindings: number;
    heuristicFindings: number;
    userSuppressed: number;
  };
}

/** Do flagged files attract more fix commits than the rest? The falsifiability check. */
export interface HealthValidation {
  flaggedFiles: number;
  flaggedFixDensity: number;
  baselineFixDensity: number;
  /** > 1 means findings concentrate where fixes happen — predictive signal. */
  ratio: number | null;
  /** Per-detector lift — which detectors actually predict fixes, auditable. */
  byCategory: Record<string, { flaggedFiles: number; fixDensity: number; lift: number | null }>;
  validationBasis: { method: 'subject-regex'; commitsScanned: number };
}

// scip-query: ignore-stale — public report envelope returned by health() and
// rendered by CLI/reporting entry points.
/** What a report was computed from, so two runs can be compared as the same or different input. */
export interface HealthProvenance {
  computedAt: string;
  generation: {
    /** Immutable index generation identity the report read. */
    identity: string;
    /** When that generation was published, when the generation store records it. */
    publishedAt: string | null;
    /** How that generation was produced, when the generation store records it. */
    mode: 'incremental' | 'full' | null;
  };
  /** Null when the project is not a git repository. */
  git: { head: string; branch: string | null; dirtyPaths: number } | null;
}

export interface HealthReport {
  overview: { documents: number; symbols: number; indexSizeBytes: number };
  /** Absent only on reports written by older builds. */
  provenance?: HealthProvenance;
  findings: {
    deadSymbols: number;
    deadLoc: number;
    cycles: number;
    similarPairs: number;
    duplicateBodyGroups: number;
    duplicateBodyLoc: number;
    twinDriftGroups: number;
    twinDriftLoc: number;
    reactComponentDuplicatePairs: number;
    reactHookCandidatePairs: number;
    reactHookCandidateScoreCount: number;
    reactLargeComponentPressureFiles: number;
    vueComponentDuplicatePairs: number;
    vueComposableCandidatePairs: number;
    vueComposableCandidateScoreCount: number;
    vueLargeViewPressureFiles: number;
    passthroughs: number;
    driftedFiles: number;
    hiddenCouplingPairs: number | null;
    hiddenCouplingScoreCount: number | null;
    coverageContractViolations: number;
  };
  axes: HealthAxes;
  validation: HealthValidation | null;
  suppressions: { total: number; byCategory: Record<string, number> } | null;
  actions: HealthAction[];
  /**
   * Rows detector policies removed from the counts above (test scaffolding,
   * vendored kit primitives, framework-mandated twins). Each row is still
   * listed by its detector command; it is disclosed here so an excluded
   * finding is never mistaken for an absent one.
   */
  policyExclusions: HealthPolicyExclusion[];
  /** Calibrated claim limits and recovery paths for detector evidence. */
  detectorEvidence: DetectorEvidenceAssessment[];
  warnings?: string[];
}

function healthScoreCount(summary: { count: number; scoreCount?: number }): number {
  return summary.scoreCount ?? summary.count;
}

export function buildHealthReport(analyses: HealthAnalyses, provenance?: HealthProvenance): HealthReport {
  const actions = buildHealthActions(analyses);

  return {
    overview: {
      documents: analyses.statsResult.documents,
      symbols: analyses.statsResult.symbols,
      indexSizeBytes: analyses.statsResult.indexSizeBytes,
    },
    ...(provenance ? { provenance } : {}),
    findings: {
      deadSymbols: analyses.dead.count,
      deadLoc: analyses.dead.loc,
      cycles: analyses.realCycleCount,
      similarPairs: analyses.similarCount,
      duplicateBodyGroups: analyses.duplicateBodies.count,
      duplicateBodyLoc: analyses.duplicateBodies.loc,
      twinDriftGroups: analyses.twinDrift.count,
      twinDriftLoc: analyses.twinDrift.loc,
      reactComponentDuplicatePairs: analyses.reactComponentDuplicates.count,
      reactHookCandidatePairs: analyses.reactHookCandidates.count,
      reactHookCandidateScoreCount: healthScoreCount(analyses.reactHookCandidates),
      reactLargeComponentPressureFiles: analyses.reactLargeComponentPressure.count,
      vueComponentDuplicatePairs: analyses.vueComponentDuplicates.count,
      vueComposableCandidatePairs: analyses.vueComposableCandidates.count,
      vueComposableCandidateScoreCount: healthScoreCount(analyses.vueComposableCandidates),
      vueLargeViewPressureFiles: analyses.vueLargeViewPressure.count,
      passthroughs: analyses.passthroughs.count,
      driftedFiles: analyses.drift.count,
      hiddenCouplingPairs: analyses.gitEvidence?.hiddenCoupling.pairCount ?? null,
      hiddenCouplingScoreCount: analyses.gitEvidence?.hiddenCoupling.scoreCount ?? null,
      coverageContractViolations: analyses.coverageContracts.count,
    },
    axes: buildHealthAxes(analyses),
    validation: buildHealthValidation(analyses),
    suppressions: analyses.suppressions,
    actions,
    policyExclusions: collectPolicyExclusions(analyses),
    detectorEvidence: analyses.detectorEvidence,
    warnings: analyses.warnings.length > 0 ? analyses.warnings : undefined,
  };
}

const POLICY_EXCLUSION_SOURCES: ReadonlyArray<[detector: string, pick: (analyses: HealthAnalyses) => CountLocSummary]> =
  [
    ['react-component-duplicates', (analyses) => analyses.reactComponentDuplicates],
    ['react-hook-candidates', (analyses) => analyses.reactHookCandidates],
    ['react-large-component-pressure', (analyses) => analyses.reactLargeComponentPressure],
    ['duplicate-bodies', (analyses) => analyses.duplicateBodies],
    ['dead', (analyses) => analyses.dead],
  ];

function collectPolicyExclusions(analyses: HealthAnalyses): HealthPolicyExclusion[] {
  const exclusions: HealthPolicyExclusion[] = [];
  const push = (detector: string, rows: ReadonlyArray<PolicyExclusionSummary> | undefined): void => {
    for (const exclusion of rows ?? []) {
      if (exclusion.count <= 0) continue;
      exclusions.push({ detector, reason: exclusion.reason, detail: exclusion.detail, count: exclusion.count });
    }
  };
  for (const [detector, pick] of POLICY_EXCLUSION_SOURCES) push(detector, pick(analyses).exclusions);
  push('cycles', analyses.cycleExclusions);
  push('co-change', analyses.gitEvidence?.hiddenCoupling.exclusions);
  return exclusions;
}

function buildHealthAxes(analyses: HealthAnalyses): HealthAxes {
  return {
    deletable: {
      loc: analyses.dead.loc,
      symbols: analyses.dead.count,
    },
    cycles: { count: analyses.realCycleCount },
    changeAmplification: analyses.gitEvidence?.amplification ?? null,
    hiddenCoupling: analyses.gitEvidence?.hiddenCoupling ?? null,
    evidenceQuality: {
      // Graph facts: zero-reference symbols and import cycles are read
      // directly off the reference graph.
      graphFindings: analyses.dead.count + analyses.realCycleCount,
      // Heuristics: every "candidate"-style detector.
      heuristicFindings:
        analyses.similarCount +
        analyses.duplicateBodies.count +
        analyses.twinDrift.count +
        analyses.reactComponentDuplicates.count +
        analyses.reactHookCandidates.count +
        analyses.reactLargeComponentPressure.count +
        analyses.vueComponentDuplicates.count +
        analyses.vueComposableCandidates.count +
        analyses.vueLargeViewPressure.count +
        analyses.passthroughs.count +
        analyses.drift.count,
      userSuppressed: analyses.suppressions?.total ?? 0,
    },
  };
}

function buildHealthValidation(analyses: HealthAnalyses): HealthValidation | null {
  const fileStats = analyses.gitEvidence?.fileStats;
  if (!fileStats) return null;

  const categories: Record<string, string[]> = {
    dead: analyses.dead.files ?? [],
    twinDrift: analyses.twinDrift.files ?? [],
    passthroughs: analyses.passthroughs.files ?? [],
    reactComponents: analyses.reactComponentDuplicates.files ?? [],
    reactHooks: analyses.reactHookCandidates.files ?? [],
    reactLargeComponents: analyses.reactLargeComponentPressure.files ?? [],
    vueComponents: analyses.vueComponentDuplicates.files ?? [],
    vueComposables: analyses.vueComposableCandidates.files ?? [],
    vueLargeViews: analyses.vueLargeViewPressure.files ?? [],
  };
  const flagged = new Set<string>(Object.values(categories).flat());

  let flaggedFixes = 0;
  let baselineFixes = 0;
  let baselineFiles = 0;
  for (const [file, stats] of Object.entries(fileStats)) {
    if (flagged.has(file)) {
      flaggedFixes += stats.fixChanges;
    } else {
      baselineFixes += stats.fixChanges;
      baselineFiles += 1;
    }
  }

  const flaggedFixDensity = flagged.size > 0 ? round2(flaggedFixes / flagged.size) : 0;
  const baselineFixDensity = baselineFiles > 0 ? round2(baselineFixes / baselineFiles) : 0;

  const byCategory: HealthValidation['byCategory'] = {};
  for (const [category, files] of Object.entries(categories)) {
    const unique = new Set(files);
    if (unique.size === 0) continue;
    let fixes = 0;
    for (const file of unique) fixes += fileStats[file]?.fixChanges ?? 0;
    const density = round2(fixes / unique.size);
    byCategory[category] = {
      flaggedFiles: unique.size,
      fixDensity: density,
      lift: baselineFixDensity > 0 ? round2(density / baselineFixDensity) : null,
    };
  }

  return {
    flaggedFiles: flagged.size,
    flaggedFixDensity,
    baselineFixDensity,
    ratio: flagged.size > 0 && baselineFixDensity > 0 ? round2(flaggedFixDensity / baselineFixDensity) : null,
    byCategory,
    validationBasis: {
      method: 'subject-regex',
      commitsScanned: analyses.gitEvidence?.commitsScanned ?? 0,
    },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatScoreCount(count: number): string {
  return Number.isInteger(count) ? String(count) : count.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function scoreCountNote(
  summary: { count: number; scoreCount?: number },
  reason = 'existing shared infrastructure discount',
): string {
  const scoreCount = healthScoreCount(summary);
  if (Math.abs(scoreCount - summary.count) < 0.01) return '';
  return ` (combined pair weight ${formatScoreCount(scoreCount)} after ${reason})`;
}

function buildHealthActions(analyses: HealthAnalyses): HealthAction[] {
  const actions: HealthAction[] = [];

  if (analyses.dead.count > 0) {
    actions.push({
      category: 'Dead code',
      evidence: 'graph-fact',
      evidenceContractId: 'dead-visible-references',
      description: `${analyses.dead.count} indexed symbols with no visible repository references — review runtime/framework roots and the capability disclosure, then verify any deletion with cleanup-plan --verify`,
      effort: 'low',
      impact: 'high',
      count: analyses.dead.count,
      locRecoverable: analyses.dead.loc,
    });
  }

  if (analyses.realCycleCount > 0) {
    actions.push({
      category: 'Circular dependencies',
      evidence: 'graph-fact',
      description: `${analyses.realCycleCount} cyclic import/re-export component(s), including type-only dependencies — inspect ownership and runtime effects before changing them`,
      effort: 'medium',
      impact: 'high',
      count: analyses.realCycleCount,
      locRecoverable: 0,
    });
  }

  if (analyses.similarCount > 0) {
    actions.push({
      category: 'Similar functions',
      evidence: 'heuristic',
      evidenceContractId: 'duplicate-structural-candidate',
      description: `${analyses.similarCount} pairs share disclosed call or source-token evidence beyond imports — review domain identity before considering consolidation`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.similarCount,
      locRecoverable: 0,
    });
  }

  if (analyses.duplicateBodies.count > 0) {
    actions.push({
      category: 'Duplicate function bodies',
      evidence: 'heuristic',
      evidenceContractId: 'duplicate-structural-candidate',
      description: `${analyses.duplicateBodies.count} exact small-body group(s) across files — consolidate only when the domain concept matches`,
      effort: 'low',
      impact: 'medium',
      count: analyses.duplicateBodies.count,
      locRecoverable: analyses.duplicateBodies.loc,
    });
  }

  if (analyses.twinDrift.count > 0) {
    actions.push({
      category: 'Drifted twin implementations',
      evidence: 'heuristic',
      description: `${analyses.twinDrift.count} same-name (or near-name) function group(s) across files with diverged or identical bodies — determine whether they represent the same concept before acting`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.twinDrift.count,
      locRecoverable: 0,
    });
  }

  if (analyses.reactComponentDuplicates.count > 0) {
    actions.push({
      category: 'Duplicated React components',
      evidence: 'heuristic',
      description: `${analyses.reactComponentDuplicates.count} React component pair(s) share JSX structure${scoreCountNote(analyses.reactComponentDuplicates, 'support-tier discount')} — review whether local product intent justifies reuse`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.reactComponentDuplicates.count,
      locRecoverable: analyses.reactComponentDuplicates.loc,
    });
  }

  if (analyses.reactHookCandidates.count > 0) {
    actions.push({
      category: 'Duplicated React hook behavior',
      evidence: 'heuristic',
      description: `${analyses.reactHookCandidates.count} React component pair(s) share state/effect/request behavior${scoreCountNote(analyses.reactHookCandidates)} — review whether a common hook would preserve ownership and lifecycle semantics`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.reactHookCandidates.count,
      locRecoverable: analyses.reactHookCandidates.loc,
    });
  }

  if (analyses.reactLargeComponentPressure.count > 0) {
    actions.push({
      category: 'Large React components',
      evidence: 'heuristic',
      description: `${analyses.reactLargeComponentPressure.count} React component(s) concentrate JSX/behavior pressure — split by reason to change`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.reactLargeComponentPressure.count,
      locRecoverable: 0,
    });
  }

  if (analyses.vueComponentDuplicates.count > 0) {
    actions.push({
      category: 'Duplicated Vue components',
      evidence: 'heuristic',
      description: `${analyses.vueComponentDuplicates.count} Vue component pair(s) share template structure — review whether local product intent justifies reuse`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.vueComponentDuplicates.count,
      locRecoverable: analyses.vueComponentDuplicates.loc,
    });
  }

  if (analyses.vueComposableCandidates.count > 0) {
    actions.push({
      category: 'Duplicated Vue behavior',
      evidence: 'heuristic',
      description: `${analyses.vueComposableCandidates.count} Vue component pair(s) share state/effect/request behavior${scoreCountNote(analyses.vueComposableCandidates)} — review whether a common composable would preserve ownership and lifecycle semantics`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.vueComposableCandidates.count,
      locRecoverable: analyses.vueComposableCandidates.loc,
    });
  }

  if (analyses.vueLargeViewPressure.count > 0) {
    actions.push({
      category: 'Large Vue views',
      evidence: 'heuristic',
      description: `${analyses.vueLargeViewPressure.count} Vue file(s) concentrate template/script/style pressure — split by reason to change`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.vueLargeViewPressure.count,
      locRecoverable: 0,
    });
  }

  if (analyses.passthroughs.count > 0) {
    actions.push({
      category: 'Passthrough functions',
      evidence: 'heuristic',
      evidenceContractId: 'passthrough-forwarding-candidate',
      description: `${analyses.passthroughs.count} functions that literally forward to one callee — inspect whether each is unnecessary indirection or an intentional boundary`,
      effort: 'low',
      impact: 'low',
      count: analyses.passthroughs.count,
      locRecoverable: analyses.passthroughs.loc,
    });
  }

  if (analyses.drift.count > 0) {
    const parts: string[] = [];
    if (analyses.drift.unusedImports > 0) parts.push(`${analyses.drift.unusedImports} unused imports`);
    if (analyses.drift.architectureViolations > 0) {
      parts.push(`${analyses.drift.architectureViolations} declared architecture violations`);
    }
    actions.push({
      category: 'Structural drift',
      evidence: 'heuristic',
      description: `${parts.join(', ')} — repair direct dependency-rule breaks; inspect boundary signals with \`drift --architecture\``,
      effort: analyses.drift.architectureViolations > 0 ? 'medium' : 'low',
      impact: analyses.drift.architectureViolations > 0 ? 'medium' : 'low',
      count: analyses.drift.count,
      locRecoverable: 0,
    });
  }

  if (analyses.coverageContracts.count > 0) {
    actions.push({
      category: 'Coverage contract drift',
      evidence: 'graph-fact',
      description: `${analyses.coverageContracts.count} configured coverage contract(s) drifted from their ground-truth source (enumeration rot) — run \`scip-query health --json\` for the missing/extra keys`,
      effort: 'low',
      impact: 'medium',
      count: analyses.coverageContracts.count,
      locRecoverable: 0,
    });
  }

  if (analyses.gitEvidence && analyses.gitEvidence.hiddenCoupling.pairCount > 0) {
    const top = analyses.gitEvidence.hiddenCoupling.top[0];
    actions.push({
      category: 'Hidden coupling',
      evidence: 'change-graph',
      description:
        `${analyses.gitEvidence.hiddenCoupling.pairCount} file pair(s) co-change without a structural link` +
        scoreCountNote(
          {
            count: analyses.gitEvidence.hiddenCoupling.pairCount,
            scoreCount: analyses.gitEvidence.hiddenCoupling.scoreCount,
          },
          'broad/stale-history discount',
        ) +
        (top ? ` (e.g. ${top.fileA} ↔ ${top.fileB})` : '') +
        ' — inspect whether a shared concept, generated artifact, or coordinated contract explains the history',
      effort: 'medium',
      impact: 'high',
      count: analyses.gitEvidence.hiddenCoupling.pairCount,
      locRecoverable: 0,
    });
  }

  // Sort: high impact + low effort first
  const impactWeight = { high: 3, medium: 2, low: 1 };
  const effortWeight = { low: 3, medium: 2, high: 1 };
  actions.sort((a, b) => {
    const scoreA = impactWeight[a.impact] * effortWeight[a.effort];
    const scoreB = impactWeight[b.impact] * effortWeight[b.effort];
    return scoreB - scoreA;
  });
  return actions;
}
