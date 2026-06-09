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
import { coChange } from './co-change.js';
import { getChangeAmplification, getFileChurn } from '../analysis/git-history.js';
import { getSuppressionInventory } from '../analysis/suppressions.js';
import { buildHealthReport } from './health-report.js';
import { HEALTH_DETECTOR_PROFILES } from './internal/health-detector-profiles.js';
import { clearWholeProjectEvidenceCaches } from './internal/cache-invalidation.js';
import { requestGarbageCollection } from './health-cache-control.js';
import type { HealthReport } from './health-report.js';

import type {
  ComplexitySummary,
  CountLocSummary,
  DriftSummary,
  GitEvidenceSummary,
  HealthAnalyses,
  StaleSummary,
  SuppressionSummary,
} from './health-types.js';

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
  'git-evidence',
  'suppressions',
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
  | { phase: 'complexity-hotspots'; complexity: ComplexitySummary }
  | { phase: 'git-evidence'; gitEvidence: GitEvidenceSummary | null }
  | { phase: 'suppressions'; suppressions: SuppressionSummary };

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
  'git-evidence': (db, _scope, budget) => ({
    phase: 'git-evidence',
    gitEvidence: summarizeGitEvidence(db, budget),
  }),
  suppressions: (db, _scope, budget) => ({
    phase: 'suppressions',
    suppressions: summarizeSuppressions(db, budget),
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
    clearWholeProjectEvidenceCaches(db, { semanticProvider: true });
    requestGarbageCollection();
  }
}

export function healthReportFromPhases(phaseResults: HealthPhaseResult[]): HealthReport {
  return buildHealthReport(healthAnalysesFromPhases(phaseResults));
}

function healthAnalysesFromPhases(phaseResults: readonly HealthPhaseResult[]): HealthAnalyses {
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
    // Optional phases — older phase orchestrations may not run them.
    gitEvidence: optionalHealthPhase<Extract<HealthPhaseResult, { phase: 'git-evidence' }>>(
      phaseResults,
      'git-evidence',
    )?.gitEvidence ?? null,
    suppressions: optionalHealthPhase<Extract<HealthPhaseResult, { phase: 'suppressions' }>>(
      phaseResults,
      'suppressions',
    )?.suppressions ?? null,
  };
  return analyses;
}

function optionalHealthPhase<T extends HealthPhaseResult>(
  results: readonly HealthPhaseResult[],
  phase: T['phase'],
): T | undefined {
  return results.find((entry) => entry.phase === phase) as T | undefined;
}

function requiredHealthPhase<T extends HealthPhaseResult>(
  results: readonly HealthPhaseResult[],
  phase: T['phase'],
): T {
  const result = results.find((entry) => entry.phase === phase);
  if (!result) throw new Error(`Missing health phase result: ${phase}`);
  return result as T;
}

function runHealthAnalyses(
  db: ScipDatabase,
  scope: string | undefined,
  statsResult: ReturnType<typeof stats>,
  budget: HealthBudget,
): HealthAnalyses {
  return healthAnalysesFromPhases(
    HEALTH_PHASES.map((phase) => HEALTH_PHASE_RUNNERS[phase](db, scope, budget, statsResult)),
  );
}

function summarizeHealthDead(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'dead', () => {
    const deadResult = dead(db, { scope, ...HEALTH_DETECTOR_PROFILES.dead, scanLimit: budget.candidateScanLimit });
    return summarizeLoc(filterHealthDeadSymbols(db, deadResult.symbols));
  });
}

function summarizeHealthIsolated(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'isolated', () => {
    const isolatedResult = isolated(db, { scope, ...HEALTH_DETECTOR_PROFILES.isolated, scanLimit: budget.candidateScanLimit });
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
    similarAll(db, { scope, ...HEALTH_DETECTOR_PROFILES.similar, scanLimit: budget.candidateScanLimit }).length,
  );
}

function countExtractionHealthCandidates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): number {
  return runHealthPhase(db, budget, 'extract-candidates', () =>
    extractCandidates(db, { scope, ...HEALTH_DETECTOR_PROFILES.extract, scanLimit: budget.candidateScanLimit }).length,
  );
}

function summarizeHealthWrappers(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return summarizeHealthLocQuery(db, budget, 'wrapper-candidates', () =>
    wrapperCandidates(db, { scope, ...HEALTH_DETECTOR_PROFILES.wrappers, scanLimit: budget.candidateScanLimit }),
  );
}

function summarizeHealthPassthroughs(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return summarizeHealthLocQuery(db, budget, 'passthrough-candidates', () =>
    passthroughCandidates(db, { scope, ...HEALTH_DETECTOR_PROFILES.passthroughs, scanLimit: budget.candidateScanLimit }),
  );
}

function summarizeHealthStaleAbstractions(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): StaleSummary {
  return runHealthPhase(db, budget, 'stale-abstractions', () => {
    const staleResult = staleAbstractions(db, { scope, ...HEALTH_DETECTOR_PROFILES.stale, scanLimit: budget.candidateScanLimit });
    const unused = staleResult.filter((s) => s.consumers === 0).length;
    return {
      count: staleResult.length,
      loc: staleResult.reduce((sum, r) => sum + r.loc, 0),
      files: [...new Set(staleResult.map((r) => r.file))],
      unused,
      singleUse: staleResult.length - unused,
    };
  });
}

function summarizeGitEvidence(db: ScipDatabase, budget: HealthBudget): GitEvidenceSummary | null {
  return runHealthPhase(db, budget, 'git-evidence', () => {
    const churn = getFileChurn(db);
    if (!churn) return null;
    const coChangeResult = coChange(db, undefined, { limit: 50 });
    const fileStats: Record<string, { changes: number; fixChanges: number }> = {};
    for (const [file, entry] of churn) {
      fileStats[file] = { changes: entry.changes, fixChanges: entry.fixChanges };
    }
    return {
      amplification: getChangeAmplification(db),
      hiddenCoupling: {
        pairCount: coChangeResult.findings.length,
        top: coChangeResult.findings.slice(0, 5).map((finding) => ({
          fileA: finding.fileA,
          fileB: finding.fileB,
          together: finding.together,
          confidence: finding.confidence,
        })),
      },
      fileStats,
    };
  });
}

function summarizeSuppressions(db: ScipDatabase, budget: HealthBudget): SuppressionSummary {
  return runHealthPhase(db, budget, 'suppressions', () => {
    const inventory = getSuppressionInventory(db);
    return { total: inventory.total, byCategory: { ...inventory.byCategory } };
  });
}

function summarizeHealthDrift(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): DriftSummary {
  return runHealthPhase(db, budget, 'drift', () => {
    const driftResult = drift(db, { scope, ...HEALTH_DETECTOR_PROFILES.drift });
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
      semantic: false,
    });
    return {
      top: complexResult.slice(0, 5).map((r) => ({
        symbol: r.shortName,
        score: r.score,
        file: r.file,
      })),
      extremeCount: complexResult.filter((r) => r.score > EXTREME_COMPLEXITY_SCORE).length,
    };
  });
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
  clearWholeProjectEvidenceCaches(db);
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

function summarizeHealthLocQuery<T extends { loc: number }>(
  db: ScipDatabase,
  budget: HealthBudget,
  name: string,
  query: () => T[],
): CountLocSummary {
  return runHealthPhase(db, budget, name, () => summarizeLoc(query()));
}

function traceHealthPhase(name: string): void {
  if (process.env['SCIP_QUERY_HEALTH_TRACE'] !== '1') return;
  console.error(`[health] ${name}`);
}

function filterHealthDeadSymbols(
  db: ScipDatabase,
  symbols: Array<{ relativePath: string; symbol: string; kind: string; loc: number }>,
): Array<{ loc: number; relativePath: string }> {
  return symbols.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath)
      && !isRootedSymbol(db, symbol.symbol, symbol.relativePath)
      && symbol.kind === 'dead-code',
  );
}

function filterHealthIsolatedSymbols(
  db: ScipDatabase,
  symbols: Array<{ relativePath: string; symbol: string; loc: number }>,
): Array<{ loc: number; relativePath: string }> {
  return symbols.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath)
      && !isRootedSymbol(db, symbol.symbol, symbol.relativePath),
  );
}

function summarizeLoc(items: Array<{ loc: number; relativePath?: string; file?: string }>): CountLocSummary {
  const files = new Set<string>();
  for (const item of items) {
    const file = item.relativePath ?? item.file;
    if (file) files.add(file);
  }
  return {
    count: items.length,
    loc: items.reduce((sum, item) => sum + item.loc, 0),
    files: [...files],
  };
}
