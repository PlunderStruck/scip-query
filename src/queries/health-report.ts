import type { HealthAnalyses } from './health-types.js';

export interface HealthAction {
  category: string;
  description: string;
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  count: number;
  locRecoverable: number;
}

// scip-query: ignore-stale — public report envelope returned by health() and
// rendered by CLI/reporting entry points.
export interface HealthReport {
  score: number;
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
  };
  actions: HealthAction[];
  topComplexity: Array<{ symbol: string; score: number }>;
  warnings?: string[];
}

export function buildHealthReport(analyses: HealthAnalyses): HealthReport {
  const actions = buildHealthActions(analyses);
  const score = computeHealthScore(analyses);

  return {
    score,
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
    },
    actions,
    topComplexity: analyses.complexity.top,
    warnings: analyses.warnings.length > 0 ? analyses.warnings : undefined,
  };
}

function buildHealthActions(analyses: HealthAnalyses): HealthAction[] {
  const actions: HealthAction[] = [];

  if (analyses.dead.count > 0) {
    actions.push({
      category: 'Dead code',
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
      description: parts.join(', '),
      effort: analyses.drift.layerViolations > 0 ? 'medium' : 'low',
      impact: analyses.drift.layerViolations > 0 ? 'medium' : 'low',
      count: analyses.drift.count,
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

function computeHealthScore(analyses: HealthAnalyses): number {
  const fileCount = Math.max(analyses.statsResult.documents, 1);
  const symbolCount = Math.max(analyses.statsResult.symbols, 1);
  let score = 100;

  const deadPercent = analyses.dead.count / symbolCount;
  score -= Math.min(20, Math.round(deadPercent * 200));

  const isolatedPercent = analyses.isolated.count / symbolCount;
  score -= Math.min(10, Math.round(isolatedPercent * 200));

  score -= Math.min(15, analyses.realCycleCount * 5);

  const similarPerMille = analyses.similarCount / symbolCount * 1000;
  score -= Math.min(10, Math.round(similarPerMille));

  const extractPerMille = analyses.extractCount / symbolCount * 1000;
  score -= Math.min(5, Math.round(extractPerMille / 2));

  score -= Math.min(3, analyses.wrappers.count);
  score -= Math.min(3, analyses.passthroughs.count);

  const stalePercent = analyses.stale.count / Math.max(symbolCount * 0.1, 1);
  score -= Math.min(8, Math.round(stalePercent * 10));

  const driftPercent = analyses.drift.count / fileCount;
  score -= Math.min(5, Math.round(driftPercent * 50));

  score -= Math.min(5, analyses.complexity.extremeCount * 2);

  return Math.max(0, Math.min(100, score));
}
