import type { ScipDatabase } from '../db.js';
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

export interface HealthAction {
  category: string;
  description: string;
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  count: number;
  locRecoverable: number;
}

export interface HealthReport {
  /** 0-100, higher is healthier */
  score: number;
  overview: {
    documents: number;
    symbols: number;
    indexSizeBytes: number;
  };
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
}

/**
 * Single composite health report that runs all de-bloat analyses
 * and produces a prioritized action list.
 */
export function health(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): HealthReport {
  const { scope } = opts;

  // Run all analyses
  const s = stats(db);
  const deadResult = dead(db, { scope, minLoc: 3, skipBarrels: true });
  const isolatedResult = isolated(db, { scope, minLoc: 3 });
  const cycleResult = cycles(db, { scope });
  const similarResult = similarAll(db, { scope, minSimilarity: 0.6, limit: 50, minCallees: 4 });
  const extractResult = extractCandidates(db, { scope, minLoc: 15, minCallees: 5, limit: 50 });
  const wrapperResult = wrapperCandidates(db, { scope, maxLoc: 15, limit: 50 });
  const passthroughResult = passthroughCandidates(db, { scope, maxLoc: 15, limit: 50 });
  const staleResult = staleAbstractions(db, { scope, minLoc: 3, limit: 50 });
  const driftResult = drift(db, { scope, minDeviation: 30 });
  const complexResult = complexityHotspots(db, { scope, minLoc: 10, limit: 10 });

  const isolatedLoc = isolatedResult.reduce((sum, r) => sum + r.loc, 0);

  // Build prioritized action list
  const actions: HealthAction[] = [];

  if (deadResult.deadCodeCount > 0) {
    actions.push({
      category: 'Dead code',
      description: `${deadResult.deadCodeCount} symbols with zero references anywhere — safe to delete`,
      effort: 'low',
      impact: 'high',
      count: deadResult.deadCodeCount,
      locRecoverable: deadResult.totalLoc,
    });
  }

  if (isolatedResult.length > 0) {
    actions.push({
      category: 'Isolated symbols',
      description: `${isolatedResult.length} symbols completely disconnected from the codebase graph`,
      effort: 'low',
      impact: 'medium',
      count: isolatedResult.length,
      locRecoverable: isolatedLoc,
    });
  }

  if (cycleResult.length > 0) {
    actions.push({
      category: 'Circular dependencies',
      description: `${cycleResult.length} cycle(s) — break with dependency inversion or module restructuring`,
      effort: 'medium',
      impact: 'high',
      count: cycleResult.length,
      locRecoverable: 0,
    });
  }

  if (similarResult.length > 0) {
    actions.push({
      category: 'Similar functions',
      description: `${similarResult.length} pairs of functions with >60% callee overlap — consolidation candidates`,
      effort: 'medium',
      impact: 'medium',
      count: similarResult.length,
      locRecoverable: 0,
    });
  }

  if (extractResult.length > 0) {
    actions.push({
      category: 'Extraction candidates',
      description: `${extractResult.length} large functions with isolated callee clusters — extract method opportunities`,
      effort: 'medium',
      impact: 'medium',
      count: extractResult.length,
      locRecoverable: 0,
    });
  }

  if (wrapperResult.length > 0) {
    actions.push({
      category: 'Wrapper functions',
      description: `${wrapperResult.length} single-consumer symbols that could be inlined`,
      effort: 'low',
      impact: 'low',
      count: wrapperResult.length,
      locRecoverable: wrapperResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (passthroughResult.length > 0) {
    actions.push({
      category: 'Passthrough functions',
      description: `${passthroughResult.length} functions that just forward to one callee — unnecessary indirection`,
      effort: 'low',
      impact: 'low',
      count: passthroughResult.length,
      locRecoverable: passthroughResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (staleResult.length > 0) {
    actions.push({
      category: 'Stale abstractions',
      description: `${staleResult.length} types/interfaces with 0-1 consumers — premature abstraction`,
      effort: 'low',
      impact: 'medium',
      count: staleResult.length,
      locRecoverable: staleResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (driftResult.length > 0) {
    actions.push({
      category: 'Pattern drift',
      description: `${driftResult.length} files deviate from their directory's typical dependency pattern`,
      effort: 'medium',
      impact: 'low',
      count: driftResult.length,
      locRecoverable: 0,
    });
  }

  // Sort: high impact + low effort first
  const impactScore = { high: 3, medium: 2, low: 1 };
  const effortScore = { low: 3, medium: 2, high: 1 };
  actions.sort((a, b) => {
    const scoreA = impactScore[a.impact] * effortScore[a.effort];
    const scoreB = impactScore[b.impact] * effortScore[b.effort];
    return scoreB - scoreA;
  });

  // Compute health score (0-100)
  // Start at 100, deduct for each finding category
  let score = 100;
  score -= Math.min(20, deadResult.totalCount * 2);
  score -= Math.min(10, isolatedResult.length * 2);
  score -= Math.min(15, cycleResult.length * 5);
  score -= Math.min(10, similarResult.length);
  score -= Math.min(5, extractResult.length);
  score -= Math.min(5, wrapperResult.length);
  score -= Math.min(5, passthroughResult.length);
  score -= Math.min(10, staleResult.length * 2);
  score -= Math.min(5, driftResult.length);
  score -= Math.min(5, complexResult.length > 5 ? complexResult.length - 5 : 0);
  score = Math.max(0, score);

  return {
    score,
    overview: {
      documents: s.documents,
      symbols: s.symbols,
      indexSizeBytes: s.indexSizeBytes,
    },
    findings: {
      deadSymbols: deadResult.totalCount,
      deadLoc: deadResult.totalLoc,
      isolatedSymbols: isolatedResult.length,
      isolatedLoc,
      cycles: cycleResult.length,
      similarPairs: similarResult.length,
      extractionCandidates: extractResult.length,
      wrappers: wrapperResult.length,
      passthroughs: passthroughResult.length,
      staleTypes: staleResult.length,
      driftedFiles: driftResult.length,
      complexityHotspotCount: complexResult.length,
    },
    actions,
    topComplexity: complexResult.slice(0, 5).map((r) => ({
      symbol: r.shortName,
      score: r.score,
    })),
  };
}
