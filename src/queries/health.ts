import type { ScipDatabase } from '../db.js';
import { isEntrySurface } from '../entry-surfaces.js';
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
import type { HealthAction, HealthReport } from '../types.js';

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
  const driftResult = drift(db, { scope });
  const complexResult = complexityHotspots(db, { scope, minLoc: 10, limit: 10 });

  // ── False-positive filtering ─────────────────────────────

  // Dead code: only count truly dead symbols (zero refs anywhere),
  // excluding entry points AND file-internal helpers (which are fine).
  const trueDeadSymbols = deadResult.symbols.filter(
    (s) => !isEntrySurface(db, s.relativePath) && s.kind === 'dead-code',
  );
  const trueDeadCount = trueDeadSymbols.length;
  const trueDeadLoc = trueDeadSymbols.reduce((sum, s) => sum + s.loc, 0);

  // Isolated: same entry-point filtering
  const trueIsolatedCount = isolatedResult.filter(
    (s) => !isEntrySurface(db, s.relativePath),
  ).length;

  const trueStaleCount = staleResult.length;

  // Drift: now uses usage-based detection (unused imports, layer violations, pattern deviations)
  // The drift command already filters structural roles internally.
  const trueDriftCount = driftResult.results.length;

  // Similar pairs: the similar command now uses TF-IDF weighted cosine
  // similarity which automatically discounts infrastructure callees.
  // The sharedCallees list only contains significant (above-median IDF) callees.
  // We can trust the count directly.
  const trueSimilarCount = similarResult.length;

  // ── Build prioritized action list ────────────────────────

  const actions: HealthAction[] = [];

  if (trueDeadCount > 0) {
    actions.push({
      category: 'Dead code',
      description: `${trueDeadCount} symbols with zero references anywhere — safe to delete`,
      effort: 'low',
      impact: 'high',
      count: trueDeadCount,
      locRecoverable: trueDeadLoc,
    });
  }

  if (trueIsolatedCount > 0) {
    actions.push({
      category: 'Isolated symbols',
      description: `${trueIsolatedCount} symbols completely disconnected from the codebase graph`,
      effort: 'low',
      impact: 'medium',
        count: trueIsolatedCount,
        locRecoverable: isolatedResult
          .filter((s) => !isEntrySurface(db, s.relativePath))
          .reduce((sum, s) => sum + s.loc, 0),
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

  if (trueSimilarCount > 0) {
    actions.push({
      category: 'Similar functions',
      description: `${trueSimilarCount} pairs with real logic overlap (beyond shared imports) — consolidation candidates`,
      effort: 'medium',
      impact: 'medium',
      count: trueSimilarCount,
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

  if (trueStaleCount > 0) {
    const unused = staleResult.filter((s) => s.consumers === 0).length;
    const singleUse = trueStaleCount - unused;
    const parts: string[] = [];
    if (unused > 0) parts.push(`${unused} unused`);
    if (singleUse > 0) parts.push(`${singleUse} single-consumer (not in types file)`);
    actions.push({
      category: 'Stale abstractions',
      description: `${parts.join(', ')} — premature abstraction`,
      effort: 'low',
      impact: 'medium',
      count: trueStaleCount,
      locRecoverable: staleResult.reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (trueDriftCount > 0) {
    const parts: string[] = [];
    if (driftResult.unusedImports > 0) parts.push(`${driftResult.unusedImports} unused imports`);
    if (driftResult.layerViolations > 0) parts.push(`${driftResult.layerViolations} layer violations`);
    if (driftResult.patternDeviations > 0) parts.push(`${driftResult.patternDeviations} unique deps`);
    actions.push({
      category: 'Structural drift',
      description: parts.join(', '),
      effort: driftResult.layerViolations > 0 ? 'medium' : 'low',
      impact: driftResult.layerViolations > 0 ? 'medium' : 'low',
      count: trueDriftCount,
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

  // ── Compute health score (0-100) ─────────────────────────
  //
  // Uses filtered counts (false positives removed).
  // Deductions scale with codebase size so a 10-file project
  // and a 1000-file project aren't penalized the same way.
  const fileCount = Math.max(s.documents, 1);
  const symbolCount = Math.max(s.symbols, 1);

  let score = 100;

  // Dead code: deduct based on % of symbols that are dead, not raw count
  const deadPercent = trueDeadCount / symbolCount;
  score -= Math.min(20, Math.round(deadPercent * 200));

  // Isolated: same percentage-based
  const isolatedPercent = trueIsolatedCount / symbolCount;
  score -= Math.min(10, Math.round(isolatedPercent * 200));

  // Cycles: these are always bad, flat penalty
  score -= Math.min(15, cycleResult.length * 5);

  // Similar pairs: only count true logic overlap, not boilerplate
  score -= Math.min(10, trueSimilarCount * 2);

  // Extract candidates: mild penalty
  score -= Math.min(5, extractResult.length * 2);

  // Wrappers: mild
  score -= Math.min(3, wrapperResult.length);

  // Passthroughs: mild
  score -= Math.min(3, passthroughResult.length);

  // Stale abstractions: percentage-based with filtered count
  const stalePercent = trueStaleCount / Math.max(symbolCount * 0.1, 1);
  score -= Math.min(8, Math.round(stalePercent * 10));

  // Drift: percentage of files that deviate
  const driftPercent = trueDriftCount / fileCount;
  score -= Math.min(5, Math.round(driftPercent * 50));

  // Complexity: only penalize extreme outliers
  const extremeComplexity = complexResult.filter((r) => r.score > 50).length;
  score -= Math.min(5, extremeComplexity * 2);

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    overview: {
      documents: s.documents,
      symbols: s.symbols,
      indexSizeBytes: s.indexSizeBytes,
    },
    findings: {
      deadSymbols: trueDeadCount,
      deadLoc: trueDeadLoc,
      isolatedSymbols: trueIsolatedCount,
        isolatedLoc: isolatedResult
          .filter((s) => !isEntrySurface(db, s.relativePath))
          .reduce((sum, s) => sum + s.loc, 0),
      cycles: cycleResult.length,
      similarPairs: trueSimilarCount,
      extractionCandidates: extractResult.length,
      wrappers: wrapperResult.length,
      passthroughs: passthroughResult.length,
      staleTypes: trueStaleCount,
      driftedFiles: trueDriftCount,
      complexityHotspotCount: complexResult.length,
    },
    actions,
    topComplexity: complexResult.slice(0, 5).map((r) => ({
      symbol: r.shortName,
      score: r.score,
    })),
  };
}
