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
  const driftResult = drift(db, { scope, minDeviation: 30 });
  const complexResult = complexityHotspots(db, { scope, minLoc: 10, limit: 10 });

  const isolatedLoc = isolatedResult.reduce((sum, r) => sum + r.loc, 0);

  // ── False-positive filtering ─────────────────────────────

  // Entry points and barrels appear as dead/isolated because nothing imports them.
  // Filter them out of the scoring (but still report them with a note).
  const entryPointPatterns = ['/index.ts', '/index.js', 'cli.ts', 'worker.ts', 'postinstall.ts', '/mod.rs', '__init__.py', 'main.ts', 'main.rs', 'main.go', 'main.py'];
  const isEntryPoint = (path: string) => entryPointPatterns.some((p) => path.endsWith(p));

  // Dead code: separate true dead from entry-point false positives
  const trueDeadCount = deadResult.symbols.filter(
    (s) => !isEntryPoint(s.relativePath),
  ).length;
  const trueDeadLoc = deadResult.symbols
    .filter((s) => !isEntryPoint(s.relativePath))
    .reduce((sum, s) => sum + s.loc, 0);

  // Isolated: same entry-point filtering
  const trueIsolatedCount = isolatedResult.filter(
    (s) => !isEntryPoint(s.relativePath),
  ).length;

  // Stale abstractions: types defined in a dedicated types file with exactly
  // 1 consumer are normal API types, not premature abstractions.
  // Only count as stale if: 0 consumers, OR 1 consumer but NOT in a types file.
  const trueStaleCount = staleResult.filter((s) => {
    if (s.consumers === 0) return true; // truly unused — always stale
    // 1-consumer types in a dedicated types file are normal API types
    const isTypesFile = s.file.includes('types.ts') || s.file.includes('types/');
    return !isTypesFile;
  }).length;

  // Drift: barrels, entry points, and orchestrators naturally deviate.
  const trueDriftCount = driftResult.filter((d) => {
    const basename = d.file.split('/').pop() ?? '';
    return !isEntryPoint(d.file)
      && !basename.startsWith('index.')
      && !d.file.includes('health.');
  }).length;

  // Similar pairs: only count pairs where similarity is driven by
  // actual logic overlap, not just shared imports. Pairs where the
  // shared callees are ALL infrastructure (db, types, shortenSymbol)
  // are boilerplate overlap, not real duplication.
  const infraSymbols = new Set<string>();
  // Build the set of "universal" callees (referenced by many modules)
  for (const pair of similarResult) {
    for (const callee of pair.sharedCallees) {
      infraSymbols.add(callee);
    }
  }
  // Count shared callees that appear in >70% of similar pairs = infrastructure
  const calleeFreq = new Map<string, number>();
  for (const pair of similarResult) {
    for (const callee of pair.sharedCallees) {
      calleeFreq.set(callee, (calleeFreq.get(callee) ?? 0) + 1);
    }
  }
  const universalCallees = new Set<string>();
  const pairCount = similarResult.length || 1;
  for (const [callee, freq] of calleeFreq) {
    if (freq / pairCount > 0.7) universalCallees.add(callee);
  }
  // A pair has "real" similarity only if it shares callees beyond universal ones
  const trueSimilarCount = similarResult.filter((pair) => {
    const nonUniversal = pair.sharedCallees.filter((c) => !universalCallees.has(c));
    return nonUniversal.length >= 2; // at least 2 non-infrastructure shared callees
  }).length;

  // ── Build prioritized action list ────────────────────────

  const actions: HealthAction[] = [];

  if (trueDeadCount > 0) {
    const deadExports = deadResult.symbols.filter(
      (s) => !isEntryPoint(s.relativePath) && s.kind === 'dead-export',
    ).length;
    const deadCode = trueDeadCount - deadExports;
    const parts: string[] = [];
    if (deadCode > 0) parts.push(`${deadCode} with zero references anywhere`);
    if (deadExports > 0) parts.push(`${deadExports} dead exports (used locally, never imported)`);
    actions.push({
      category: 'Dead code',
      description: `${parts.join(', ')} — safe to delete or make private`,
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
        .filter((s) => !isEntryPoint(s.relativePath))
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
      locRecoverable: staleResult
        .filter((s) => s.consumers === 0 || !s.file.includes('types'))
        .reduce((sum, r) => sum + r.loc, 0),
    });
  }

  if (trueDriftCount > 0) {
    actions.push({
      category: 'Pattern drift',
      description: `${trueDriftCount} files deviate from their directory's typical dependency pattern (excluding barrels/entry points)`,
      effort: 'medium',
      impact: 'low',
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
        .filter((s) => !isEntryPoint(s.relativePath))
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
