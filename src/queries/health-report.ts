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
  /** Risk deductions are empirically validated predictors; hygiene are tidiness signals. */
  kind: 'risk' | 'hygiene';
}

export interface HealthAxes {
  /** LOC provably removable with behavior preserved (dead + isolated). */
  deletable: { loc: number; symbols: number };
  cycles: { count: number };
  /** Files touched per commit — the measured cost of one conceptual change. */
  changeAmplification: ChangeAmplificationSummary | null;
  /** File pairs that co-change without a dependency edge — concepts the reference graph can't see. */
  hiddenCoupling: {
    pairCount: number;
    top: Array<{ fileA: string; fileB: string; together: number; confidence: number }>;
  } | null;
  /** Complexity hotspots weighted by churn — complex code nobody touches costs nothing. */
  churnWeightedComplexity: Array<{ symbol: string; file?: string; score: number; changes: number; weighted: number }> | null;
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
}

// scip-query: ignore-stale — public report envelope returned by health() and
// rendered by CLI/reporting entry points.
export interface HealthReport {
  /** Headline = min(riskScore, hygieneScore); kept for compatibility. */
  score: number;
  /** Empirically validated predictors only (graph facts, change-graph signals). */
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
    extractionCandidates: number;
    wrappers: number;
    passthroughs: number;
    staleTypes: number;
    driftedFiles: number;
    complexityHotspotCount: number;
    hiddenCouplingPairs: number | null;
  };
  axes: HealthAxes;
  validation: HealthValidation | null;
  suppressions: { total: number; byCategory: Record<string, number> } | null;
  actions: HealthAction[];
  topComplexity: Array<{ symbol: string; score: number; file?: string }>;
  warnings?: string[];
}

export function buildHealthReport(analyses: HealthAnalyses): HealthReport {
  const actions = buildHealthActions(analyses);
  const { breakdown } = computeHealthScore(analyses);
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
      extractionCandidates: analyses.extractCount,
      wrappers: analyses.wrappers.count,
      passthroughs: analyses.passthroughs.count,
      staleTypes: analyses.stale.count,
      driftedFiles: analyses.drift.count,
      complexityHotspotCount: analyses.complexity.extremeCount,
      hiddenCouplingPairs: analyses.gitEvidence?.hiddenCoupling.pairCount ?? null,
    },
    axes: buildHealthAxes(analyses),
    validation: buildHealthValidation(analyses),
    suppressions: analyses.suppressions,
    actions,
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
      heuristicFindings: analyses.similarCount
        + analyses.extractCount
        + analyses.wrappers.count
        + analyses.passthroughs.count
        + analyses.stale.count
        + analyses.drift.count,
      userSuppressed: analyses.suppressions?.total ?? 0,
    },
  };
}

function buildChurnWeightedComplexity(
  analyses: HealthAnalyses,
): HealthAxes['churnWeightedComplexity'] {
  const fileStats = analyses.gitEvidence?.fileStats;
  if (!fileStats) return null;
  return analyses.complexity.top
    .map((entry) => {
      const changes = entry.file ? fileStats[entry.file]?.changes ?? 0 : 0;
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
    wrappers: analyses.wrappers.files ?? [],
    passthroughs: analyses.passthroughs.files ?? [],
    stale: analyses.stale.files ?? [],
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
    ratio: flagged.size > 0 && baselineFixDensity > 0
      ? round2(flaggedFixDensity / baselineFixDensity)
      : null,
    byCategory,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildHealthActions(analyses: HealthAnalyses): HealthAction[] {
  const actions: HealthAction[] = [];

  if (analyses.dead.count > 0) {
    actions.push({
      category: 'Dead code',
      evidence: 'graph-fact',
      description: `${analyses.dead.count} symbols with zero references anywhere — safe to delete`,
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
      description: `${analyses.realCycleCount} cycle(s) — break with dependency inversion or module restructuring`,
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
      description: `${analyses.similarCount} pairs with real logic overlap (beyond shared imports) — consolidation candidates`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.similarCount,
      locRecoverable: 0,
    });
  }

  if (analyses.extractCount > 0) {
    actions.push({
      category: 'Extraction candidates',
      evidence: 'heuristic',
      description: `${analyses.extractCount} large functions with isolated callee clusters — extract method opportunities`,
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
      description: `${analyses.wrappers.count} single-consumer symbols that could be inlined`,
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
      description: `${analyses.passthroughs.count} functions that just forward to one callee — unnecessary indirection`,
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
      description: `${parts.join(', ')} — premature abstraction`,
      effort: 'low',
      impact: 'medium',
      count: analyses.stale.count,
      locRecoverable: analyses.stale.loc,
    });
  }

  if (analyses.drift.count > 0) {
    const parts: string[] = [];
    if (analyses.drift.unusedImports > 0) parts.push(`${analyses.drift.unusedImports} unused imports`);
    if (analyses.drift.layerViolations > 0) parts.push(`${analyses.drift.layerViolations} layer violations`);
    actions.push({
      category: 'Structural drift',
      evidence: 'heuristic',
      description: parts.join(', '),
      effort: analyses.drift.layerViolations > 0 ? 'medium' : 'low',
      impact: analyses.drift.layerViolations > 0 ? 'medium' : 'low',
      count: analyses.drift.count,
      locRecoverable: 0,
    });
  }

  if (analyses.gitEvidence && analyses.gitEvidence.hiddenCoupling.pairCount > 0) {
    const top = analyses.gitEvidence.hiddenCoupling.top[0];
    actions.push({
      category: 'Hidden coupling',
      evidence: 'change-graph',
      description: `${analyses.gitEvidence.hiddenCoupling.pairCount} file pair(s) co-change without a dependency edge`
        + (top ? ` (e.g. ${top.fileA} ↔ ${top.fileB})` : '')
        + ' — name the shared concept or enforce the sync',
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
  similar: 'hygiene',
  extract: 'hygiene',
  wrappers: 'hygiene',
  passthroughs: 'hygiene',
  'stale-abstractions': 'hygiene',
  drift: 'hygiene',
};

function scoreFromDeductions(breakdown: readonly ScoreDeduction[], kind: ScoreDeduction['kind']): number {
  const total = breakdown.filter((entry) => entry.kind === kind)
    .reduce((sum, entry) => sum + entry.points, 0);
  return Math.max(0, Math.min(100, 100 - total));
}

function computeHealthScore(analyses: HealthAnalyses): { breakdown: ScoreDeduction[] } {
  const fileCount = Math.max(analyses.statsResult.documents, 1);
  const symbolCount = Math.max(analyses.statsResult.symbols, 1);
  const breakdown: ScoreDeduction[] = [];
  const deduct = (axis: string, points: number, detail: string): void => {
    if (points > 0) breakdown.push({ axis, points, detail, kind: DEDUCTION_KIND[axis] ?? 'hygiene' });
  };

  const deadPercent = analyses.dead.count / symbolCount;
  deduct('dead-code', Math.min(20, Math.round(deadPercent * 200)),
    `${analyses.dead.count} dead symbols (${analyses.dead.loc} LOC deletable)`);

  const isolatedPercent = analyses.isolated.count / symbolCount;
  deduct('isolated', Math.min(10, Math.round(isolatedPercent * 200)),
    `${analyses.isolated.count} isolated symbols (${analyses.isolated.loc} LOC deletable)`);

  deduct('cycles', Math.min(15, analyses.realCycleCount * 5),
    `${analyses.realCycleCount} real dependency cycle(s)`);

  const similarPerMille = analyses.similarCount / symbolCount * 1000;
  deduct('similar', Math.min(10, Math.round(similarPerMille)),
    `${analyses.similarCount} similar function pair(s)`);

  const extractPerMille = analyses.extractCount / symbolCount * 1000;
  deduct('extract', Math.min(5, Math.round(extractPerMille / 2)),
    `${analyses.extractCount} extraction candidate(s)`);

  deduct('wrappers', Math.min(3, analyses.wrappers.count),
    `${analyses.wrappers.count} wrapper candidate(s)`);
  deduct('passthroughs', Math.min(3, analyses.passthroughs.count),
    `${analyses.passthroughs.count} passthrough candidate(s)`);

  const stalePercent = analyses.stale.count / Math.max(symbolCount * 0.1, 1);
  deduct('stale-abstractions', Math.min(8, Math.round(stalePercent * 10)),
    `${analyses.stale.count} stale abstraction(s)`);

  const driftPercent = analyses.drift.count / fileCount;
  deduct('drift', Math.min(5, Math.round(driftPercent * 50)),
    `${analyses.drift.count} drift finding(s)`);

  deduct('complexity', Math.min(5, analyses.complexity.extremeCount * 2),
    `${analyses.complexity.extremeCount} extreme complexity hotspot(s)`);

  if (analyses.gitEvidence) {
    deduct('hidden-coupling', Math.min(5, analyses.gitEvidence.hiddenCoupling.pairCount),
      `${analyses.gitEvidence.hiddenCoupling.pairCount} co-changing pair(s) without a dependency edge`);
  }

  return { breakdown };
}
