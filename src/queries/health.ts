import type { ScipDatabase } from '../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../analysis/file-classifier.js';
import { dead } from './dead.js';
import { isolated } from './isolated.js';
import { cycles } from './cycles.js';
import { similarAll } from './similar.js';
import { extractCandidates } from './extract-candidates.js';
import { wrapperCandidates } from './wrapper-candidates.js';
import { passthroughCandidates } from './passthrough-candidates.js';
import { clearStaleAbstractionsCaches, staleAbstractions } from './stale-abstractions.js';
import { drift } from './drift.js';
import { complexityHotspots } from './complexity-hotspots.js';
import { stats } from './stats.js';
import type { HealthAction, HealthReport } from '../domain/types.js';
import { clearHealthAnalysisCaches, requestGarbageCollection } from './health-cache-control.js';

interface HealthAnalyses {
  statsResult: ReturnType<typeof stats>;
  warnings: string[];
  dead: CountLocSummary;
  isolated: CountLocSummary;
  realCycleCount: number;
  similarCount: number;
  extractCount: number;
  wrappers: CountLocSummary;
  passthroughs: CountLocSummary;
  stale: StaleSummary;
  drift: DriftSummary;
  complexity: ComplexitySummary;
}

interface CountLocSummary {
  count: number;
  loc: number;
}

interface StaleSummary extends CountLocSummary {
  unused: number;
  singleUse: number;
}

interface DriftSummary {
  count: number;
  unusedImports: number;
  layerViolations: number;
}

interface ComplexitySummary {
  top: Array<{ symbol: string; score: number }>;
  extremeCount: number;
}

interface HealthBudget {
  candidateScanLimit: number | undefined;
  releaseCachesBetweenPhases: boolean;
  warnings: string[];
}

const EXTREME_COMPLEXITY_SCORE = 50;
const LARGE_HEALTH_SYMBOL_THRESHOLD = 75_000;
const LARGE_HEALTH_DOCUMENT_THRESHOLD = 5_000;
const DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT = 2_500;
export const HEALTH_PHASES = [
  'overview',
  'dead',
  'isolated',
  'cycles',
  'similar',
  'extract-candidates',
  'wrapper-candidates',
  'passthrough-candidates',
  'stale-abstractions',
  'drift',
  'complexity-hotspots',
] as const;

export type HealthPhaseName = typeof HEALTH_PHASES[number];

type HealthPhaseResult =
  | { phase: 'overview'; statsResult: ReturnType<typeof stats>; warnings: string[] }
  | { phase: 'dead'; dead: CountLocSummary }
  | { phase: 'isolated'; isolated: CountLocSummary }
  | { phase: 'cycles'; realCycleCount: number }
  | { phase: 'similar'; similarCount: number }
  | { phase: 'extract-candidates'; extractCount: number }
  | { phase: 'wrapper-candidates'; wrappers: CountLocSummary }
  | { phase: 'passthrough-candidates'; passthroughs: CountLocSummary }
  | { phase: 'stale-abstractions'; stale: StaleSummary }
  | { phase: 'drift'; drift: DriftSummary }
  | { phase: 'complexity-hotspots'; complexity: ComplexitySummary };

type HealthPhaseRunner = (
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
  statsResult: ReturnType<typeof stats>,
) => HealthPhaseResult;

const HEALTH_PHASE_RUNNERS: Record<HealthPhaseName, HealthPhaseRunner> = {
  overview: (_db, _scope, budget, statsResult) => ({
    phase: 'overview',
    statsResult,
    warnings: budget.warnings,
  }),
  dead: (db, scope, budget) => ({
    phase: 'dead',
    dead: summarizeHealthDead(db, scope, budget),
  }),
  isolated: (db, scope, budget) => ({
    phase: 'isolated',
    isolated: summarizeHealthIsolated(db, scope, budget),
  }),
  cycles: (db, scope, budget) => ({
    phase: 'cycles',
    realCycleCount: countRealHealthCycles(db, scope, budget),
  }),
  similar: (db, scope, budget) => ({
    phase: 'similar',
    similarCount: countSimilarHealthCandidates(db, scope, budget),
  }),
  'extract-candidates': (db, scope, budget) => ({
    phase: 'extract-candidates',
    extractCount: countExtractionHealthCandidates(db, scope, budget),
  }),
  'wrapper-candidates': (db, scope, budget) => ({
    phase: 'wrapper-candidates',
    wrappers: summarizeHealthWrappers(db, scope, budget),
  }),
  'passthrough-candidates': (db, scope, budget) => ({
    phase: 'passthrough-candidates',
    passthroughs: summarizeHealthPassthroughs(db, scope, budget),
  }),
  'stale-abstractions': (db, scope, budget) => ({
    phase: 'stale-abstractions',
    stale: summarizeHealthStaleAbstractions(db, scope, budget),
  }),
  drift: (db, scope, budget) => ({
    phase: 'drift',
    drift: summarizeHealthDrift(db, scope, budget),
  }),
  'complexity-hotspots': (db, scope, budget) => ({
    phase: 'complexity-hotspots',
    complexity: summarizeHealthComplexity(db, scope, budget),
  }),
};

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
  opts: { scope?: string; full?: boolean } = {},
): HealthReport {
  return withHealthRun(db, opts.full === true, (statsResult, budget) => {
    const analyses = runHealthAnalyses(db, opts.scope, statsResult, budget);
    return buildHealthReport(analyses);
  });
}

export function healthPhase(
  db: ScipDatabase,
  phase: HealthPhaseName,
  opts: { scope?: string; full?: boolean } = {},
): HealthPhaseResult {
  return withHealthRun(db, opts.full === true, (statsResult, budget) =>
    HEALTH_PHASE_RUNNERS[phase](db, opts.scope, budget, statsResult),
  );
}

function withHealthRun<T>(
  db: ScipDatabase,
  full: boolean,
  run: (statsResult: ReturnType<typeof stats>, budget: HealthBudget) => T,
): T {
  const statsResult = stats(db);
  const budget = healthBudget(statsResult, full);
  try {
    return run(statsResult, budget);
  } finally {
    clearHealthAnalysisCaches(db, { semanticProvider: true });
    requestGarbageCollection();
  }
}

export function healthReportFromPhases(phaseResults: HealthPhaseResult[]): HealthReport {
  const overview = requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'overview' }>>(
    phaseResults,
    'overview',
  );
  const analyses: HealthAnalyses = {
    statsResult: overview.statsResult,
    warnings: overview.warnings,
    dead: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'dead' }>>(phaseResults, 'dead').dead,
    isolated: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'isolated' }>>(
      phaseResults,
      'isolated',
    ).isolated,
    realCycleCount: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'cycles' }>>(
      phaseResults,
      'cycles',
    ).realCycleCount,
    similarCount: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'similar' }>>(
      phaseResults,
      'similar',
    ).similarCount,
    extractCount: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'extract-candidates' }>>(
      phaseResults,
      'extract-candidates',
    ).extractCount,
    wrappers: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'wrapper-candidates' }>>(
      phaseResults,
      'wrapper-candidates',
    ).wrappers,
    passthroughs: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'passthrough-candidates' }>>(
      phaseResults,
      'passthrough-candidates',
    ).passthroughs,
    stale: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'stale-abstractions' }>>(
      phaseResults,
      'stale-abstractions',
    ).stale,
    drift: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'drift' }>>(phaseResults, 'drift').drift,
    complexity: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'complexity-hotspots' }>>(
      phaseResults,
      'complexity-hotspots',
    ).complexity,
  };
  return buildHealthReport(analyses);
}

function requiredHealthPhase<T extends HealthPhaseResult>(
  results: readonly HealthPhaseResult[],
  phase: T['phase'],
): T {
  const result = results.find((entry) => entry.phase === phase);
  if (!result) throw new Error(`Missing health phase result: ${phase}`);
  return result as T;
}

function buildHealthReport(analyses: HealthAnalyses): HealthReport {
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

function runHealthAnalyses(
  db: ScipDatabase,
  scope: string | undefined,
  statsResult: ReturnType<typeof stats>,
  budget: HealthBudget,
): HealthAnalyses {
  const reachability = summarizeReachabilityHealth(db, scope, budget);
  const candidates = summarizeCandidateHealth(db, scope, budget);
  const structure = summarizeStructureHealth(db, scope, budget);
  return {
    statsResult,
    warnings: budget.warnings,
    ...reachability,
    ...candidates,
    ...structure,
  };
}

function summarizeReachabilityHealth(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): Pick<HealthAnalyses, 'dead' | 'isolated' | 'realCycleCount'> {
  return {
    dead: summarizeHealthDead(db, scope, budget),
    isolated: summarizeHealthIsolated(db, scope, budget),
    realCycleCount: countRealHealthCycles(db, scope, budget),
  };
}

function summarizeCandidateHealth(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): Pick<HealthAnalyses, 'similarCount' | 'extractCount' | 'wrappers' | 'passthroughs' | 'stale'> {
  return {
    similarCount: countSimilarHealthCandidates(db, scope, budget),
    extractCount: countExtractionHealthCandidates(db, scope, budget),
    wrappers: summarizeHealthWrappers(db, scope, budget),
    passthroughs: summarizeHealthPassthroughs(db, scope, budget),
    stale: summarizeHealthStaleAbstractions(db, scope, budget),
  };
}

function summarizeStructureHealth(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): Pick<HealthAnalyses, 'drift' | 'complexity'> {
  return {
    drift: summarizeHealthDrift(db, scope, budget),
    complexity: summarizeHealthComplexity(db, scope, budget),
  };
}

function summarizeHealthDead(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'dead', () => {
    const deadResult = dead(db, { scope, minLoc: 3, skipBarrels: true });
    return summarizeLoc(filterHealthDeadSymbols(db, deadResult.symbols));
  });
}

function summarizeHealthIsolated(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'isolated', () => {
    const isolatedResult = isolated(db, { scope, minLoc: 3 });
    return summarizeLoc(filterHealthIsolatedSymbols(db, isolatedResult));
  });
}

function countRealHealthCycles(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): number {
  return runHealthPhase(db, budget, 'cycles', () => {
    const cycleResult = cycles(db, { scope });
    return cycleResult.filter((cycle) => cycle.kind === 'real').length;
  });
}

function countSimilarHealthCandidates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): number {
  return runHealthPhase(db, budget, 'similar', () =>
    similarAll(db, {
      scope,
      minSimilarity: 0.6,
      limit: 50,
      minCallees: 4,
      scanLimit: budget.candidateScanLimit,
    }).length,
  );
}

function countExtractionHealthCandidates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): number {
  return runHealthPhase(db, budget, 'extract-candidates', () =>
    extractCandidates(db, {
      scope,
      minLoc: 15,
      minCallees: 5,
      limit: 50,
      scanLimit: budget.candidateScanLimit,
    }).length,
  );
}

function summarizeHealthWrappers(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'wrapper-candidates', () =>
    summarizeLoc(wrapperCandidates(db, {
      scope,
      maxLoc: 15,
      limit: 50,
      scanLimit: budget.candidateScanLimit,
    })),
  );
}

function summarizeHealthPassthroughs(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'passthrough-candidates', () =>
    summarizeLoc(passthroughCandidates(db, {
      scope,
      maxLoc: 15,
      limit: 50,
      scanLimit: budget.candidateScanLimit,
    })),
  );
}

function summarizeHealthStaleAbstractions(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): StaleSummary {
  return runHealthPhase(db, budget, 'stale-abstractions', () => {
    const staleResult = staleAbstractions(db, {
      scope,
      minLoc: 3,
      limit: 50,
      scanLimit: budget.candidateScanLimit,
    });
    const unused = staleResult.filter((s) => s.consumers === 0).length;
    return {
      count: staleResult.length,
      loc: staleResult.reduce((sum, r) => sum + r.loc, 0),
      unused,
      singleUse: staleResult.length - unused,
    };
  });
}

function summarizeHealthDrift(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): DriftSummary {
  return runHealthPhase(db, budget, 'drift', () => {
    const driftResult = drift(db, { scope });
    return {
      count: driftResult.unusedImports + driftResult.layerViolations,
      unusedImports: driftResult.unusedImports,
      layerViolations: driftResult.layerViolations,
    };
  });
}

function summarizeHealthComplexity(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): ComplexitySummary {
  return runHealthPhase(db, budget, 'complexity-hotspots', () => {
    const complexResult = complexityHotspots(db, {
      scope,
      minLoc: 10,
      limit: 10,
      scanLimit: budget.candidateScanLimit,
    });
    return {
      top: complexResult.slice(0, 5).map((r) => ({
        symbol: r.shortName,
        score: r.score,
      })),
      extremeCount: complexResult.filter((r) => r.score > EXTREME_COMPLEXITY_SCORE).length,
    };
  });
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

function healthBudget(
  statsResult: ReturnType<typeof stats>,
  full: boolean,
): HealthBudget {
  const isLargeIndex = statsResult.symbols >= LARGE_HEALTH_SYMBOL_THRESHOLD
    || statsResult.documents >= LARGE_HEALTH_DOCUMENT_THRESHOLD;

  if (!isLargeIndex) {
    return {
      candidateScanLimit: undefined,
      releaseCachesBetweenPhases: true,
      warnings: [],
    };
  }

  if (full) {
    return {
      candidateScanLimit: undefined,
      releaseCachesBetweenPhases: true,
      warnings: [
        'Large index detected; running unbounded health analyses because --full was supplied.',
      ],
    };
  }

  return {
    candidateScanLimit: DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT,
    releaseCachesBetweenPhases: true,
    warnings: [
      `Large index detected; candidate-style health checks scanned their highest-priority ${DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT} symbols. Run "scip-query health --full" for unbounded candidate counts.`,
    ],
  };
}

function releaseHealthPhaseCaches(db: ScipDatabase, budget: HealthBudget): void {
  if (!budget.releaseCachesBetweenPhases) return;
  clearStaleAbstractionsCaches(db);
  clearHealthAnalysisCaches(db);
  requestGarbageCollection();
}

function runHealthPhase<T>(
  db: ScipDatabase,
  budget: HealthBudget,
  name: string,
  analyze: () => T,
): T {
  traceHealthPhase(name);
  try {
    return analyze();
  } finally {
    releaseHealthPhaseCaches(db, budget);
  }
}

function traceHealthPhase(name: string): void {
  if (process.env['SCIP_QUERY_HEALTH_TRACE'] !== '1') return;
  console.error(`[health] ${name}`);
}

function filterHealthDeadSymbols(
  db: ScipDatabase,
  symbols: Array<{ relativePath: string; symbol: string; kind: string; loc: number }>,
): Array<{ loc: number }> {
  return symbols.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath)
      && !isRootedSymbol(db, symbol.symbol, symbol.relativePath)
      && symbol.kind === 'dead-code',
  );
}

function filterHealthIsolatedSymbols(
  db: ScipDatabase,
  symbols: Array<{ relativePath: string; symbol: string; loc: number }>,
): Array<{ loc: number }> {
  return symbols.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath)
      && !isRootedSymbol(db, symbol.symbol, symbol.relativePath),
  );
}

function summarizeLoc(items: Array<{ loc: number }>): CountLocSummary {
  return {
    count: items.length,
    loc: items.reduce((sum, item) => sum + item.loc, 0),
  };
}
