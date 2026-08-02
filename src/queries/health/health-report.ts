import type { ChangeAmplificationSummary, HealthAnalyses } from './health-types.js';

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
}

/** One deduction line — the score is the sum of these, so it is auditable. */
export interface ScoreDeduction {
  axis: string;
  points: number;
  detail: string;
  /** Risk deductions use graph/change evidence; hygiene deductions use candidate signals. */
  kind: 'risk' | 'hygiene';
}

export interface HealthPressure {
  axis: string;
  category: string;
  kind: ScoreDeduction['kind'];
  count: number;
  threshold: number;
  ratio: number;
  extraPenalty: number;
}

export interface HealthAxes {
  /** LOC in indexed zero-reference or disconnected candidates (legacy field name: deletable). */
  deletable: { loc: number; symbols: number };
  cycles: { count: number };
  /** Files touched per commit — the measured cost of one conceptual change. */
  changeAmplification: ChangeAmplificationSummary | null;
  /** File pairs that co-change without a structural link — concepts the visible graph can't see. */
  hiddenCoupling: {
    pairCount: number;
    scoreCount: number;
    top: Array<{ fileA: string; fileB: string; together: number; confidence: number; scoreWeight?: number }>;
  } | null;
  /** Complexity hotspots weighted by churn — complex code nobody touches costs nothing. */
  churnWeightedComplexity: Array<{
    symbol: string;
    file?: string;
    score: number;
    changes: number;
    weighted: number;
  }> | null;
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
export interface HealthReport {
  /** Headline = min(riskScore, hygieneScore); kept for compatibility. */
  score: number;
  /** Risk-oriented graph facts and change-graph signals; the composite remains experimental. */
  riskScore: number;
  /** Tidiness signals (candidate detectors) — real but not fix-predictive. */
  hygieneScore: number;
  scoreBreakdown: ScoreDeduction[];
  overview: { documents: number; symbols: number; indexSizeBytes: number };
  findings: {
    deadSymbols: number;
    deadLoc: number;
    isolatedSymbols: number;
    isolatedLoc: number;
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
    extractionCandidates: number;
    wrappers: number;
    wrapperScoreCount: number;
    passthroughs: number;
    staleTypes: number;
    driftedFiles: number;
    complexityHotspotCount: number;
    hiddenCouplingPairs: number | null;
    hiddenCouplingScoreCount: number | null;
    coverageContractViolations: number;
  };
  axes: HealthAxes;
  validation: HealthValidation | null;
  suppressions: { total: number; byCategory: Record<string, number> } | null;
  actions: HealthAction[];
  pressure: HealthPressure[];
  topComplexity: Array<{ symbol: string; score: number; file?: string }>;
  warnings?: string[];
}

function healthScoreCount(summary: { count: number; scoreCount?: number }): number {
  return summary.scoreCount ?? summary.count;
}

export function buildHealthReport(analyses: HealthAnalyses): HealthReport {
  const actions = buildHealthActions(analyses);
  const { breakdown, pressure } = computeHealthScore(analyses);
  const riskScore = scoreFromDeductions(breakdown, 'risk');
  const hygieneScore = scoreFromDeductions(breakdown, 'hygiene');

  return {
    score: Math.min(riskScore, hygieneScore),
    riskScore,
    hygieneScore,
    scoreBreakdown: breakdown,
    overview: {
      documents: analyses.statsResult.documents,
      symbols: analyses.statsResult.symbols,
      indexSizeBytes: analyses.statsResult.indexSizeBytes,
    },
    findings: {
      deadSymbols: analyses.dead.count,
      deadLoc: analyses.dead.loc,
      isolatedSymbols: analyses.isolated.count,
      isolatedLoc: analyses.isolated.loc,
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
      extractionCandidates: analyses.extractCount,
      wrappers: analyses.wrappers.count,
      wrapperScoreCount: healthScoreCount(analyses.wrappers),
      passthroughs: analyses.passthroughs.count,
      staleTypes: analyses.stale.count,
      driftedFiles: analyses.drift.count,
      complexityHotspotCount: analyses.complexity.extremeCount,
      hiddenCouplingPairs: analyses.gitEvidence?.hiddenCoupling.pairCount ?? null,
      hiddenCouplingScoreCount: analyses.gitEvidence?.hiddenCoupling.scoreCount ?? null,
      coverageContractViolations: analyses.coverageContracts.count,
    },
    axes: buildHealthAxes(analyses),
    validation: buildHealthValidation(analyses),
    suppressions: analyses.suppressions,
    actions,
    pressure,
    topComplexity: analyses.complexity.top,
    warnings: analyses.warnings.length > 0 ? analyses.warnings : undefined,
  };
}

function buildHealthAxes(analyses: HealthAnalyses): HealthAxes {
  return {
    deletable: {
      loc: analyses.dead.loc + analyses.isolated.loc,
      symbols: analyses.dead.count + analyses.isolated.count,
    },
    cycles: { count: analyses.realCycleCount },
    changeAmplification: analyses.gitEvidence?.amplification ?? null,
    hiddenCoupling: analyses.gitEvidence?.hiddenCoupling ?? null,
    churnWeightedComplexity: buildChurnWeightedComplexity(analyses),
    evidenceQuality: {
      // Graph facts: zero-reference symbols and import cycles are read
      // directly off the reference graph.
      graphFindings: analyses.dead.count + analyses.isolated.count + analyses.realCycleCount,
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
        analyses.extractCount +
        analyses.wrappers.count +
        analyses.passthroughs.count +
        analyses.stale.count +
        analyses.drift.count,
      userSuppressed: analyses.suppressions?.total ?? 0,
    },
  };
}

function buildChurnWeightedComplexity(analyses: HealthAnalyses): HealthAxes['churnWeightedComplexity'] {
  const fileStats = analyses.gitEvidence?.fileStats;
  if (!fileStats) return null;
  return analyses.complexity.top
    .map((entry) => {
      const changes = entry.file ? (fileStats[entry.file]?.changes ?? 0) : 0;
      return {
        ...entry,
        changes,
        weighted: round2(entry.score * Math.log2(1 + changes)),
      };
    })
    .sort((left, right) => right.weighted - left.weighted);
}

function buildHealthValidation(analyses: HealthAnalyses): HealthValidation | null {
  const fileStats = analyses.gitEvidence?.fileStats;
  if (!fileStats) return null;

  const categories: Record<string, string[]> = {
    dead: analyses.dead.files ?? [],
    isolated: analyses.isolated.files ?? [],
    twinDrift: analyses.twinDrift.files ?? [],
    wrappers: analyses.wrappers.files ?? [],
    passthroughs: analyses.passthroughs.files ?? [],
    stale: analyses.stale.files ?? [],
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
  return ` (${formatScoreCount(scoreCount)} score-weighted after ${reason})`;
}

function scoreWeightedDetail(summary: { count: number; scoreCount?: number }, unit: string): string {
  const scoreCount = healthScoreCount(summary);
  const raw = `${summary.count} ${unit}`;
  if (Math.abs(scoreCount - summary.count) < 0.01) return raw;
  return `${raw} (${formatScoreCount(scoreCount)} score-weighted)`;
}

function buildHealthActions(analyses: HealthAnalyses): HealthAction[] {
  const actions: HealthAction[] = [];

  if (analyses.dead.count > 0) {
    actions.push({
      category: 'Dead code',
      evidence: 'graph-fact',
      description: `${analyses.dead.count} indexed symbols with no visible repository references — review runtime/framework roots and the capability disclosure, then verify any deletion with cleanup-plan --verify`,
      effort: 'low',
      impact: 'high',
      count: analyses.dead.count,
      locRecoverable: analyses.dead.loc,
    });
  }

  if (analyses.isolated.count > 0) {
    actions.push({
      category: 'Isolated symbols',
      evidence: 'graph-fact',
      description: `${analyses.isolated.count} symbols completely disconnected from the codebase graph`,
      effort: 'low',
      impact: 'medium',
      count: analyses.isolated.count,
      locRecoverable: analyses.isolated.loc,
    });
  }

  if (analyses.realCycleCount > 0) {
    actions.push({
      category: 'Circular dependencies',
      evidence: 'graph-fact',
      description: `${analyses.realCycleCount} indexed dependency cycle(s) — inspect ownership and runtime order before choosing whether or how to break them`,
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
      description: `${analyses.reactComponentDuplicates.count} React component pair(s) share JSX structure — review whether local product intent justifies reuse`,
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

  if (analyses.extractCount > 0) {
    actions.push({
      category: 'Extraction candidates',
      evidence: 'heuristic',
      description: `${analyses.extractCount} large functions with isolated callee clusters — review same-file or feature-local extraction seams`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.extractCount,
      locRecoverable: 0,
    });
  }

  if (analyses.wrappers.count > 0) {
    actions.push({
      category: 'Wrapper functions',
      evidence: 'heuristic',
      description: `${analyses.wrappers.count} single-consumer symbols${scoreCountNote(analyses.wrappers, 'boundary-evidence discount')} — inspect whether each is indirection or an intentional API, framework, or ownership boundary`,
      effort: 'low',
      impact: 'low',
      count: analyses.wrappers.count,
      locRecoverable: analyses.wrappers.loc,
    });
  }

  if (analyses.passthroughs.count > 0) {
    actions.push({
      category: 'Passthrough functions',
      evidence: 'heuristic',
      description: `${analyses.passthroughs.count} functions that literally forward to one callee — inspect whether each is unnecessary indirection or an intentional boundary`,
      effort: 'low',
      impact: 'low',
      count: analyses.passthroughs.count,
      locRecoverable: analyses.passthroughs.loc,
    });
  }

  if (analyses.stale.count > 0) {
    const parts: string[] = [];
    if (analyses.stale.unused > 0) parts.push(`${analyses.stale.unused} unused`);
    if (analyses.stale.singleUse > 0) parts.push(`${analyses.stale.singleUse} single-consumer (not in types file)`);
    actions.push({
      category: 'Stale abstractions',
      evidence: 'heuristic',
      description: `${parts.join(', ')} — review public, runtime-registration, and ownership evidence before removing, moving, or inlining`,
      effort: 'low',
      impact: 'medium',
      count: analyses.stale.count,
      locRecoverable: analyses.stale.loc,
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

// Every deduction is recorded in the breakdown — the headline number is the
// sum of auditable lines, not an opaque formula.
const DEDUCTION_KIND: Record<string, ScoreDeduction['kind']> = {
  'dead-code': 'risk',
  isolated: 'risk',
  cycles: 'risk',
  complexity: 'risk',
  'hidden-coupling': 'risk',
  'cycles-pressure': 'risk',
  'complexity-pressure': 'risk',
  'hidden-coupling-pressure': 'risk',
  similar: 'hygiene',
  'duplicate-bodies': 'hygiene',
  'twin-drift': 'hygiene',
  'react-component-duplicates': 'hygiene',
  'react-hook-candidates': 'hygiene',
  'react-large-component-pressure': 'hygiene',
  'vue-component-duplicates': 'hygiene',
  'vue-composable-candidates': 'hygiene',
  'vue-large-view-pressure': 'hygiene',
  extract: 'hygiene',
  wrappers: 'hygiene',
  passthroughs: 'hygiene',
  'stale-abstractions': 'hygiene',
  drift: 'hygiene',
  'similar-pressure': 'hygiene',
  'duplicate-bodies-pressure': 'hygiene',
  'twin-drift-pressure': 'hygiene',
  'react-component-duplicates-pressure': 'hygiene',
  'react-hook-candidates-pressure': 'hygiene',
  'react-large-component-pressure-pressure': 'hygiene',
  'vue-component-duplicates-pressure': 'hygiene',
  'vue-composable-candidates-pressure': 'hygiene',
  'vue-large-view-pressure-pressure': 'hygiene',
  'extract-pressure': 'hygiene',
  'wrappers-pressure': 'hygiene',
  'passthroughs-pressure': 'hygiene',
  'stale-abstractions-pressure': 'hygiene',
  'drift-pressure': 'hygiene',
};

function scoreFromDeductions(breakdown: readonly ScoreDeduction[], kind: ScoreDeduction['kind']): number {
  const total = breakdown.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.points, 0);
  return Math.max(0, Math.min(100, 100 - total));
}

function computeHealthScore(analyses: HealthAnalyses): { breakdown: ScoreDeduction[]; pressure: HealthPressure[] } {
  const fileCount = Math.max(analyses.statsResult.documents, 1);
  const symbolCount = Math.max(analyses.statsResult.symbols, 1);
  const breakdown: ScoreDeduction[] = [];
  const pressure: HealthPressure[] = [];
  const deduct = (axis: string, points: number, detail: string): void => {
    if (points > 0) breakdown.push({ axis, points, detail, kind: DEDUCTION_KIND[axis] ?? 'hygiene' });
  };
  const pressureDeduct = (
    axis: string,
    category: string,
    count: number,
    threshold: number,
    maxPoints: number,
    weight: number,
    unit: string,
  ): void => {
    const normalizedThreshold = Math.max(threshold, 1);
    if (count <= normalizedThreshold) return;
    const ratio = count / normalizedThreshold;
    const points = Math.min(maxPoints, Math.ceil(Math.log2(ratio) * weight));
    if (points <= 0) return;
    const kind = DEDUCTION_KIND[axis] ?? 'hygiene';
    pressure.push({
      axis,
      category,
      kind,
      count,
      threshold: round2(normalizedThreshold),
      ratio: round2(ratio),
      extraPenalty: points,
    });
    deduct(
      axis,
      points,
      `${count} ${unit} exceed pressure threshold ${round2(normalizedThreshold)} (${round2(ratio)}x)`,
    );
  };

  const deadPercent = analyses.dead.count / symbolCount;
  deduct(
    'dead-code',
    Math.min(20, Math.round(deadPercent * 200)),
    `${analyses.dead.count} dead symbols (${analyses.dead.loc} LOC deletable)`,
  );

  const isolatedPercent = analyses.isolated.count / symbolCount;
  deduct(
    'isolated',
    Math.min(10, Math.round(isolatedPercent * 200)),
    `${analyses.isolated.count} isolated symbols (${analyses.isolated.loc} LOC deletable)`,
  );

  deduct('cycles', Math.min(15, analyses.realCycleCount * 5), `${analyses.realCycleCount} real dependency cycle(s)`);

  const similarPerMille = (analyses.similarCount / symbolCount) * 1000;
  deduct('similar', Math.min(10, Math.round(similarPerMille)), `${analyses.similarCount} similar function pair(s)`);

  const duplicateBodyPerMille = (analyses.duplicateBodies.count / symbolCount) * 1000;
  deduct(
    'duplicate-bodies',
    Math.min(10, Math.round(duplicateBodyPerMille * 2)),
    `${analyses.duplicateBodies.count} exact duplicate small-body group(s) (${analyses.duplicateBodies.loc} duplicate LOC)`,
  );

  const twinDriftPerMille = (analyses.twinDrift.count / symbolCount) * 1000;
  deduct(
    'twin-drift',
    Math.min(10, Math.round(twinDriftPerMille * 2)),
    `${analyses.twinDrift.count} drifted twin implementation group(s) (same or near-same name, diverged or identical bodies)`,
  );

  const reactDuplicatePerMille = (analyses.reactComponentDuplicates.count / fileCount) * 1000;
  deduct(
    'react-component-duplicates',
    Math.min(10, Math.round(reactDuplicatePerMille)),
    `${analyses.reactComponentDuplicates.count} duplicated React component pair(s)`,
  );

  const reactHookScoreCount = healthScoreCount(analyses.reactHookCandidates);
  const reactHookPerMille = (reactHookScoreCount / fileCount) * 1000;
  deduct(
    'react-hook-candidates',
    Math.min(10, Math.round(reactHookPerMille)),
    scoreWeightedDetail(analyses.reactHookCandidates, 'duplicated React behavior pair(s)'),
  );

  const reactLargeComponentPerMille = (analyses.reactLargeComponentPressure.count / fileCount) * 1000;
  deduct(
    'react-large-component-pressure',
    Math.min(5, Math.round(reactLargeComponentPerMille / 2)),
    `${analyses.reactLargeComponentPressure.count} large React component pressure file(s)`,
  );

  const vueDuplicatePerMille = (analyses.vueComponentDuplicates.count / fileCount) * 1000;
  deduct(
    'vue-component-duplicates',
    Math.min(10, Math.round(vueDuplicatePerMille)),
    `${analyses.vueComponentDuplicates.count} duplicated Vue component pair(s)`,
  );

  const vueComposableScoreCount = healthScoreCount(analyses.vueComposableCandidates);
  const vueComposablePerMille = (vueComposableScoreCount / fileCount) * 1000;
  deduct(
    'vue-composable-candidates',
    Math.min(10, Math.round(vueComposablePerMille)),
    scoreWeightedDetail(analyses.vueComposableCandidates, 'duplicated Vue behavior pair(s)'),
  );

  const vueLargeViewPerMille = (analyses.vueLargeViewPressure.count / fileCount) * 1000;
  deduct(
    'vue-large-view-pressure',
    Math.min(5, Math.round(vueLargeViewPerMille / 2)),
    `${analyses.vueLargeViewPressure.count} large Vue view pressure file(s)`,
  );

  const wrapperScoreCount = healthScoreCount(analyses.wrappers);
  deduct('wrappers', Math.min(3, wrapperScoreCount), scoreWeightedDetail(analyses.wrappers, 'wrapper candidate(s)'));
  const passthroughScoreCount = healthScoreCount(analyses.passthroughs);
  deduct(
    'passthroughs',
    Math.min(3, passthroughScoreCount),
    scoreWeightedDetail(analyses.passthroughs, 'passthrough candidate(s)'),
  );

  deduct(
    'stale-abstractions',
    Math.min(8, analyses.stale.unused),
    `${analyses.stale.unused} unused stale abstraction(s); ${analyses.stale.singleUse} single-consumer signal(s)`,
  );

  const driftPercent = analyses.drift.direct / fileCount;
  deduct(
    'drift',
    Math.min(5, Math.round(driftPercent * 50)),
    `${analyses.drift.direct} direct drift finding(s); ${analyses.drift.signal} signal drift finding(s)`,
  );

  deduct(
    'complexity',
    Math.min(5, analyses.complexity.extremeCount * 2),
    `${analyses.complexity.extremeCount} extreme complexity hotspot(s)`,
  );

  if (analyses.gitEvidence) {
    const hiddenCouplingScoreCount = analyses.gitEvidence.hiddenCoupling.scoreCount;
    deduct(
      'hidden-coupling',
      Math.min(5, Math.ceil(hiddenCouplingScoreCount / 10)),
      scoreWeightedDetail(
        { count: analyses.gitEvidence.hiddenCoupling.pairCount, scoreCount: hiddenCouplingScoreCount },
        'co-changing pair(s) without a structural link',
      ),
    );
  }

  pressureDeduct('cycles-pressure', 'Circular dependencies', analyses.realCycleCount, 3, 10, 3, 'cycle(s)');
  pressureDeduct(
    'complexity-pressure',
    'Extreme complexity',
    analyses.complexity.extremeCount,
    3,
    5,
    2,
    'extreme complexity hotspot(s)',
  );
  if (analyses.gitEvidence) {
    const hiddenCouplingScoreCount = analyses.gitEvidence.hiddenCoupling.scoreCount;
    pressureDeduct(
      'hidden-coupling-pressure',
      'Hidden coupling',
      hiddenCouplingScoreCount,
      50,
      10,
      4,
      'score-weighted co-changing pair(s)',
    );
  }

  pressureDeduct(
    'similar-pressure',
    'Similar functions',
    analyses.similarCount,
    Math.max(50, symbolCount * 0.01),
    8,
    4,
    'similar function pair(s)',
  );
  pressureDeduct(
    'duplicate-bodies-pressure',
    'Duplicate function bodies',
    analyses.duplicateBodies.count,
    Math.max(20, symbolCount * 0.005),
    8,
    4,
    'exact duplicate small-body group(s)',
  );
  pressureDeduct(
    'twin-drift-pressure',
    'Drifted twin implementations',
    analyses.twinDrift.count,
    Math.max(20, symbolCount * 0.005),
    8,
    4,
    'drifted twin implementation group(s)',
  );
  pressureDeduct(
    'react-component-duplicates-pressure',
    'Duplicated React components',
    analyses.reactComponentDuplicates.count,
    Math.max(10, fileCount * 0.01),
    8,
    4,
    'duplicated React component pair(s)',
  );
  pressureDeduct(
    'react-hook-candidates-pressure',
    'Duplicated React hook behavior',
    reactHookScoreCount,
    Math.max(10, fileCount * 0.01),
    8,
    4,
    'duplicated React behavior pair(s)',
  );
  pressureDeduct(
    'react-large-component-pressure-pressure',
    'Large React components',
    analyses.reactLargeComponentPressure.count,
    Math.max(10, fileCount * 0.01),
    4,
    2,
    'large React component pressure file(s)',
  );
  pressureDeduct(
    'vue-component-duplicates-pressure',
    'Duplicated Vue components',
    analyses.vueComponentDuplicates.count,
    Math.max(10, fileCount * 0.01),
    8,
    4,
    'duplicated Vue component pair(s)',
  );
  pressureDeduct(
    'vue-composable-candidates-pressure',
    'Duplicated Vue behavior',
    vueComposableScoreCount,
    Math.max(10, fileCount * 0.01),
    8,
    4,
    'duplicated Vue behavior pair(s)',
  );
  pressureDeduct(
    'vue-large-view-pressure-pressure',
    'Large Vue views',
    analyses.vueLargeViewPressure.count,
    Math.max(10, fileCount * 0.01),
    4,
    2,
    'large Vue view pressure file(s)',
  );
  pressureDeduct(
    'extract-pressure',
    'Extraction candidates',
    analyses.extractCount,
    Math.max(50, symbolCount * 0.01),
    4,
    2,
    'extraction candidate(s)',
  );
  pressureDeduct('wrappers-pressure', 'Wrapper functions', wrapperScoreCount, 50, 4, 2, 'wrapper candidate(s)');
  pressureDeduct(
    'passthroughs-pressure',
    'Passthrough functions',
    passthroughScoreCount,
    50,
    4,
    2,
    'passthrough candidate(s)',
  );
  pressureDeduct(
    'stale-abstractions-pressure',
    'Single-consumer stale abstraction signals',
    analyses.stale.singleUse,
    Math.max(50, symbolCount * 0.02),
    4,
    2,
    'single-consumer stale abstraction signal(s)',
  );
  pressureDeduct(
    'drift-pressure',
    'Structural drift signals',
    analyses.drift.signal,
    Math.max(10, fileCount * 0.1),
    4,
    2,
    'signal drift finding(s)',
  );

  return { breakdown, pressure };
}
