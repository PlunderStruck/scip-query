import type { ScipDatabase } from '../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../analysis/file-classifier.js';
import { dead } from './dead.js';
import { isolated } from './isolated.js';
import { cycles } from './cycles.js';
import { similarAll } from './similar.js';
import { extractCandidates } from './extract-candidates.js';
import { wrapperCandidates } from './wrapper-candidates.js';
import { passthroughCandidates } from './passthrough-candidates.js';
import { staleAbstractions } from './stale-abstractions.js';
import { drift } from './drift.js';
import { complexityHotspots } from './complexity-hotspots.js';
import { stats } from './stats.js';
import type { HealthAction, HealthReport } from '../domain/types.js';

interface HealthAnalyses {
  statsResult: ReturnType<typeof stats>;
  deadResult: ReturnType<typeof dead>;
  isolatedResult: ReturnType<typeof isolated>;
  cycleResult: ReturnType<typeof cycles>;
  similarResult: ReturnType<typeof similarAll>;
  extractResult: ReturnType<typeof extractCandidates>;
  wrapperResult: ReturnType<typeof wrapperCandidates>;
  passthroughResult: ReturnType<typeof passthroughCandidates>;
  staleResult: ReturnType<typeof staleAbstractions>;
  driftResult: ReturnType<typeof drift>;
  complexResult: ReturnType<typeof complexityHotspots>;
}

interface HealthSignals {
  trueDeadCount: number;
  trueDeadLoc: number;
  trueIsolatedCount: number;
  trueIsolatedLoc: number;
  trueStaleCount: number;
  trueDriftCount: number;
  trueSimilarCount: number;
  realCycleCount: number;
}

const EXTREME_COMPLEXITY_SCORE = 50;

/**
 * Single composite health report that runs all de-bloat analyses
 * and produces a prioritized action list.
 *
 * The scoring formula accounts for common false positives:
 * - Entry points (CLI, workers, barrels) appearing as "dead code"
 * - Typed result interfaces with 1 consumer (normal for APIs)
 * - Consistent import patterns across sibling modules (not duplication)
 * - Barrel and orchestrator files deviating from sibling patterns (expected)
 */
export function health(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): HealthReport {
  const analyses = runHealthAnalyses(db, opts.scope);
  const signals = filterHealthSignals(db, analyses);
  const actions = buildHealthActions(analyses, signals);
  const score = computeHealthScore(analyses, signals);

  return {
    score,
    overview: {
      documents: analyses.statsResult.documents,
      symbols: analyses.statsResult.symbols,
      indexSizeBytes: analyses.statsResult.indexSizeBytes,
    },
    findings: {
      deadSymbols: signals.trueDeadCount,
      deadLoc: signals.trueDeadLoc,
      isolatedSymbols: signals.trueIsolatedCount,
      isolatedLoc: signals.trueIsolatedLoc,
      cycles: signals.realCycleCount,
      similarPairs: signals.trueSimilarCount,
      extractionCandidates: analyses.extractResult.length,
      wrappers: analyses.wrapperResult.length,
      passthroughs: analyses.passthroughResult.length,
      staleTypes: signals.trueStaleCount,
      driftedFiles: signals.trueDriftCount,
      complexityHotspotCount: extremeComplexityCount(analyses),
    },
    actions,
    topComplexity: analyses.complexResult.slice(0, 5).map((r) => ({
      symbol: r.shortName,
      score: r.score,
    })),
  };
}

function runHealthAnalyses(db: ScipDatabase, scope: string | undefined): HealthAnalyses {
  return {
    statsResult: stats(db),
    deadResult: dead(db, { scope, minLoc: 3, skipBarrels: true }),
    isolatedResult: isolated(db, { scope, minLoc: 3 }),
    cycleResult: cycles(db, { scope }),
    similarResult: similarAll(db, { scope, minSimilarity: 0.6, limit: 50, minCallees: 4 }),
    extractResult: extractCandidates(db, { scope, minLoc: 15, minCallees: 5, limit: 50 }),
    wrapperResult: wrapperCandidates(db, { scope, maxLoc: 15, limit: 50 }),
    passthroughResult: passthroughCandidates(db, { scope, maxLoc: 15, limit: 50 }),
    staleResult: staleAbstractions(db, { scope, minLoc: 3, limit: 50 }),
    driftResult: drift(db, { scope }),
    complexResult: complexityHotspots(db, { scope, minLoc: 10, limit: 10 }),
  };
}

function filterHealthSignals(db: ScipDatabase, analyses: HealthAnalyses): HealthSignals {
  const trueDeadSymbols = analyses.deadResult.symbols.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath)
      && !isRootedSymbol(db, symbol.symbol, symbol.relativePath)
      && symbol.kind === 'dead-code',
  );
  const trueIsolatedSymbols = analyses.isolatedResult.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath)
      && !isRootedSymbol(db, symbol.symbol, symbol.relativePath),
  );

  return {
    trueDeadCount: trueDeadSymbols.length,
    trueDeadLoc: trueDeadSymbols.reduce((sum, symbol) => sum + symbol.loc, 0),
    trueIsolatedCount: trueIsolatedSymbols.length,
    trueIsolatedLoc: trueIsolatedSymbols.reduce((sum, symbol) => sum + symbol.loc, 0),
    trueStaleCount: analyses.staleResult.length,
    trueDriftCount: analyses.driftResult.unusedImports + analyses.driftResult.layerViolations,
    trueSimilarCount: analyses.similarResult.length,
    realCycleCount: analyses.cycleResult.filter((cycle) => cycle.kind === 'real').length,
  };
}

function buildHealthActions(analyses: HealthAnalyses, signals: HealthSignals): HealthAction[] {
  const actions: HealthAction[] = [];

  if (signals.trueDeadCount > 0) {
    actions.push({
      category: 'Dead code',
      description: `${signals.trueDeadCount} symbols with zero references anywhere — safe to delete`,
      effort: 'low',
      impact: 'high',
      count: signals.trueDeadCount,
      locRecoverable: signals.trueDeadLoc,
    });
  }

  if (signals.trueIsolatedCount > 0) {
    actions.push({
      category: 'Isolated symbols',
      description: `${signals.trueIsolatedCount} symbols completely disconnected from the codebase graph`,
      effort: 'low',
      impact: 'medium',
      count: signals.trueIsolatedCount,
      locRecoverable: signals.trueIsolatedLoc,
    });
  }

  if (signals.realCycleCount > 0) {
    actions.push({
      category: 'Circular dependencies',
      description: `${signals.realCycleCount} cycle(s) — break with dependency inversion or module restructuring`,
      effort: 'medium',
      impact: 'high',
      count: signals.realCycleCount,
      locRecoverable: 0,
    });
  }

  if (signals.trueSimilarCount > 0) {
    actions.push({
      category: 'Similar functions',
      description: `${signals.trueSimilarCount} pairs with real logic overlap (beyond shared imports) — consolidation candidates`,
      effort: 'medium',
      impact: 'medium',
      count: signals.trueSimilarCount,
      locRecoverable: 0,
    });
  }

  if (analyses.extractResult.length > 0) {
    actions.push({
      category: 'Extraction candidates',
      description: `${analyses.extractResult.length} large functions with isolated callee clusters — extract method opportunities`,
      effort: 'medium',
      impact: 'medium',
      count: analyses.extractResult.length,
      locRecoverable: 0,
    });
  }

  if (analyses.wrapperResult.length > 0) {
    actions.push({
      category: 'Wrapper functions',
      description: `${analyses.wrapperResult.length} single-consumer symbols that could be inlined`,
      effort: 'low',
      impact: 'low',
      count: analyses.wrapperResult.length,
      locRecoverable: analyses.wrapperResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (analyses.passthroughResult.length > 0) {
    actions.push({
      category: 'Passthrough functions',
      description: `${analyses.passthroughResult.length} functions that just forward to one callee — unnecessary indirection`,
      effort: 'low',
      impact: 'low',
      count: analyses.passthroughResult.length,
      locRecoverable: analyses.passthroughResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (signals.trueStaleCount > 0) {
    const unused = analyses.staleResult.filter((s) => s.consumers === 0).length;
    const singleUse = signals.trueStaleCount - unused;
    const parts: string[] = [];
    if (unused > 0) parts.push(`${unused} unused`);
    if (singleUse > 0) parts.push(`${singleUse} single-consumer (not in types file)`);
    actions.push({
      category: 'Stale abstractions',
      description: `${parts.join(', ')} — premature abstraction`,
      effort: 'low',
      impact: 'medium',
      count: signals.trueStaleCount,
      locRecoverable: analyses.staleResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (signals.trueDriftCount > 0) {
    const parts: string[] = [];
    if (analyses.driftResult.unusedImports > 0) parts.push(`${analyses.driftResult.unusedImports} unused imports`);
    if (analyses.driftResult.layerViolations > 0) parts.push(`${analyses.driftResult.layerViolations} layer violations`);
    actions.push({
      category: 'Structural drift',
      description: parts.join(', '),
      effort: analyses.driftResult.layerViolations > 0 ? 'medium' : 'low',
      impact: analyses.driftResult.layerViolations > 0 ? 'medium' : 'low',
      count: signals.trueDriftCount,
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

function computeHealthScore(analyses: HealthAnalyses, signals: HealthSignals): number {
  const fileCount = Math.max(analyses.statsResult.documents, 1);
  const symbolCount = Math.max(analyses.statsResult.symbols, 1);
  let score = 100;

  const deadPercent = signals.trueDeadCount / symbolCount;
  score -= Math.min(20, Math.round(deadPercent * 200));

  const isolatedPercent = signals.trueIsolatedCount / symbolCount;
  score -= Math.min(10, Math.round(isolatedPercent * 200));

  score -= Math.min(15, signals.realCycleCount * 5);

  const similarPerMille = signals.trueSimilarCount / symbolCount * 1000;
  score -= Math.min(10, Math.round(similarPerMille));

  const extractPerMille = analyses.extractResult.length / symbolCount * 1000;
  score -= Math.min(5, Math.round(extractPerMille / 2));

  score -= Math.min(3, analyses.wrapperResult.length);
  score -= Math.min(3, analyses.passthroughResult.length);

  const stalePercent = signals.trueStaleCount / Math.max(symbolCount * 0.1, 1);
  score -= Math.min(8, Math.round(stalePercent * 10));

  const driftPercent = signals.trueDriftCount / fileCount;
  score -= Math.min(5, Math.round(driftPercent * 50));

  const extremeComplexity = extremeComplexityCount(analyses);
  score -= Math.min(5, extremeComplexity * 2);

  return Math.max(0, Math.min(100, score));
}

function extremeComplexityCount(analyses: HealthAnalyses): number {
  return analyses.complexResult.filter((r) => r.score > EXTREME_COMPLEXITY_SCORE).length;
}
