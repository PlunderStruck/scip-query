import type { ScipDatabase } from '../../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { dead } from '../cleanup/dead.js';
import { isolated } from '../cleanup/isolated.js';
import { cycles } from '../graph/cycles.js';
import { similarAll } from '../cleanup/similar.js';
import { reactComponentDuplicates } from '../frontend/react-component-duplicates.js';
import { reactHookCandidates } from '../frontend/react-hook-candidates.js';
import { reactLargeComponentPressure } from '../frontend/react-large-component-pressure.js';
import { vueComponentDuplicates } from '../frontend/vue-component-duplicates.js';
import { vueComposableCandidates } from '../frontend/vue-composable-candidates.js';
import { vueLargeViewPressure } from '../frontend/vue-large-view-pressure.js';
import { extractCandidates } from '../cleanup/extract-candidates.js';
import { wrapperCandidates } from '../cleanup/wrapper-candidates.js';
import { passthroughCandidates } from '../cleanup/passthrough-candidates.js';
import { staleAbstractions } from '../cleanup/stale-abstractions.js';
import { drift } from '../cleanup/drift.js';
import { complexityHotspots } from '../quality/complexity-hotspots.js';
import { stats } from '../navigation/stats.js';
import { coChange } from '../impact/co-change.js';
import { getChangeAmplification, getFileChurn } from '../../analysis/git-history.js';
import { getSuppressionInventory } from '../../analysis/suppressions.js';
import { buildHealthReport } from './health-report.js';
import { HEALTH_DETECTOR_PROFILES } from '../internal/health-detector-profiles.js';
import { clearWholeProjectEvidenceCaches } from '../internal/cache-invalidation.js';
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
  candidateResultLimit: number;
  complexityResultLimit: number;
  releaseCachesBetweenPhases: boolean;
  warnings: string[];
}

const EXTREME_COMPLEXITY_SCORE = 50;
const LARGE_HEALTH_SYMBOL_THRESHOLD = 75_000;
const LARGE_HEALTH_DOCUMENT_THRESHOLD = 5_000;
const DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT = 2_500;
const DEFAULT_HEALTH_CANDIDATE_RESULT_LIMIT = 50;
const DEFAULT_HEALTH_COMPLEXITY_RESULT_LIMIT = 10;
export const HEALTH_PHASES = [
  'overview',
  'dead',
  'isolated',
  'cycles',
  'similar',
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
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
  | { phase: 'react-component-duplicates'; reactComponentDuplicates: CountLocSummary }
  | { phase: 'react-hook-candidates'; reactHookCandidates: CountLocSummary }
  | { phase: 'react-large-component-pressure'; reactLargeComponentPressure: CountLocSummary }
  | { phase: 'vue-component-duplicates'; vueComponentDuplicates: CountLocSummary }
  | { phase: 'vue-composable-candidates'; vueComposableCandidates: CountLocSummary }
  | { phase: 'vue-large-view-pressure'; vueLargeViewPressure: CountLocSummary }
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
  'react-component-duplicates': (db, scope, budget) => ({
    phase: 'react-component-duplicates',
    reactComponentDuplicates: summarizeReactComponentDuplicates(db, scope, budget),
  }),
  'react-hook-candidates': (db, scope, budget) => ({
    phase: 'react-hook-candidates',
    reactHookCandidates: summarizeReactHookCandidates(db, scope, budget),
  }),
  'react-large-component-pressure': (db, scope, budget) => ({
    phase: 'react-large-component-pressure',
    reactLargeComponentPressure: summarizeReactLargeComponentPressure(db, scope, budget),
  }),
  'vue-component-duplicates': (db, scope, budget) => ({
    phase: 'vue-component-duplicates',
    vueComponentDuplicates: summarizeVueComponentDuplicates(db, scope, budget),
  }),
  'vue-composable-candidates': (db, scope, budget) => ({
    phase: 'vue-composable-candidates',
    vueComposableCandidates: summarizeVueComposableCandidates(db, scope, budget),
  }),
  'vue-large-view-pressure': (db, scope, budget) => ({
    phase: 'vue-large-view-pressure',
    vueLargeViewPressure: summarizeVueLargeViewPressure(db, scope, budget),
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
    reactComponentDuplicates: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'react-component-duplicates' }>>(
      phaseResults,
      'react-component-duplicates',
    ).reactComponentDuplicates,
    reactHookCandidates: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'react-hook-candidates' }>>(
      phaseResults,
      'react-hook-candidates',
    ).reactHookCandidates,
    reactLargeComponentPressure: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'react-large-component-pressure' }>>(
      phaseResults,
      'react-large-component-pressure',
    ).reactLargeComponentPressure,
    vueComponentDuplicates: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'vue-component-duplicates' }>>(
      phaseResults,
      'vue-component-duplicates',
    ).vueComponentDuplicates,
    vueComposableCandidates: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'vue-composable-candidates' }>>(
      phaseResults,
      'vue-composable-candidates',
    ).vueComposableCandidates,
    vueLargeViewPressure: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'vue-large-view-pressure' }>>(
      phaseResults,
      'vue-large-view-pressure',
    ).vueLargeViewPressure,
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
    similarAll(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.similar,
      limit: budget.candidateResultLimit,
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
      ...HEALTH_DETECTOR_PROFILES.extract,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    }).length,
  );
}

function summarizeReactComponentDuplicates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'react-component-duplicates', () => {
    const results = reactComponentDuplicates(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return summarizePairLoc(results);
  });
}

function summarizeReactHookCandidates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'react-hook-candidates', () => {
    const results = reactHookCandidates(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return summarizePairLocWithScore(results, reactHookHealthScore);
  });
}

function summarizeReactLargeComponentPressure(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'react-large-component-pressure', () => {
    const results = reactLargeComponentPressure(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return summarizeUniqueFileLoc(results);
  });
}

function summarizeVueComponentDuplicates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'vue-component-duplicates', () => {
    const results = vueComponentDuplicates(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return summarizePairLoc(results);
  });
}

function summarizeVueComposableCandidates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'vue-composable-candidates', () => {
    const results = vueComposableCandidates(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return summarizePairLocWithScore(results, vueComposableHealthScore);
  });
}

function summarizeVueLargeViewPressure(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'vue-large-view-pressure', () => {
    const results = vueLargeViewPressure(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return summarizeLoc(results);
  });
}

function summarizeHealthWrappers(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return summarizeHealthLocQuery(db, budget, 'wrapper-candidates', () =>
    wrapperCandidates(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.wrappers,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    }),
  );
}

function summarizeHealthPassthroughs(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return summarizeHealthLocQuery(db, budget, 'passthrough-candidates', () =>
    passthroughCandidates(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.passthroughs,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    }),
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
      ...HEALTH_DETECTOR_PROFILES.stale,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
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
    const coChangeResult = coChange(db, undefined, { limit: budget.candidateResultLimit });
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
      limit: budget.complexityResultLimit,
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
  const candidateResultLimit = full
    ? Number.POSITIVE_INFINITY
    : DEFAULT_HEALTH_CANDIDATE_RESULT_LIMIT;
  const complexityResultLimit = full
    ? Number.POSITIVE_INFINITY
    : DEFAULT_HEALTH_COMPLEXITY_RESULT_LIMIT;

  if (!isLargeIndex || full) {
    return {
      candidateScanLimit: undefined,
      candidateResultLimit,
      complexityResultLimit,
      releaseCachesBetweenPhases: true,
      warnings: full && isLargeIndex
        ? ['Large index detected; running health without candidate scan or result caps because --full was supplied.']
        : [],
    };
  }

  return {
    candidateScanLimit: DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT,
    candidateResultLimit,
    complexityResultLimit,
    releaseCachesBetweenPhases: true,
    warnings: [
      `Large index detected; candidate-style health checks scanned their highest-priority ${DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT} symbols and reported their top ${DEFAULT_HEALTH_CANDIDATE_RESULT_LIMIT} findings. Run "scip-query health --full" for unbounded candidate counts.`,
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

function summarizeUniqueFileLoc(items: Array<{ file: string; loc: number }>): CountLocSummary {
  const fileLoc = new Map<string, number>();
  for (const item of items) {
    fileLoc.set(item.file, Math.max(fileLoc.get(item.file) ?? 0, item.loc));
  }
  return {
    count: fileLoc.size,
    loc: [...fileLoc.values()].reduce((sum, loc) => sum + loc, 0),
    files: [...fileLoc.keys()],
  };
}

function summarizePairLoc(items: Array<{ fileA: string; fileB: string; locA: number; locB: number }>): CountLocSummary {
  const fileLoc = new Map<string, number>();
  for (const item of items) {
    fileLoc.set(item.fileA, Math.max(fileLoc.get(item.fileA) ?? 0, item.locA));
    fileLoc.set(item.fileB, Math.max(fileLoc.get(item.fileB) ?? 0, item.locB));
  }
  return {
    count: items.length,
    loc: [...fileLoc.values()].reduce((sum, loc) => sum + loc, 0),
    files: [...fileLoc.keys()],
  };
}

function summarizePairLocWithScore<T extends { fileA: string; fileB: string; locA: number; locB: number }>(
  items: T[],
  score: (item: T) => number,
): CountLocSummary {
  const summary = summarizePairLoc(items);
  return {
    ...summary,
    scoreCount: roundHealthScoreCount(items.reduce((sum, item) => sum + score(item), 0)),
  };
}

function reactHookHealthScore(candidate: {
  sharedHooks: readonly string[];
  sharedState: readonly string[];
  sharedRequests: readonly string[];
  sharedEffects: readonly string[];
  sharedHandlers: readonly string[];
  sharedHandlerVerbs: readonly string[];
}): number {
  const existingSharedAbstraction = candidate.sharedHooks.length > 0;
  const concreteSignals = concreteBehaviorSignalCount({
    namedState: candidate.sharedState,
    requests: candidate.sharedRequests,
    lifecycle: candidate.sharedEffects,
    functions: candidate.sharedHandlers,
  });
  if (existingSharedAbstraction && concreteSignals <= 2) return 0;
  if (existingSharedAbstraction) return 0.5;
  if (hasOnlyGenericBehavior(candidate.sharedState, candidate.sharedHandlers, candidate.sharedHandlerVerbs)) return 0.25;
  return concreteSignals >= 2 ? 1 : 0.5;
}

function vueComposableHealthScore(candidate: {
  sharedComposables: readonly string[];
  sharedStores: readonly string[];
  sharedRequests: readonly string[];
  sharedLifecycle: readonly string[];
  sharedFunctions: readonly string[];
  sharedFunctionVerbs: readonly string[];
  sharedBindings: readonly string[];
}): number {
  const existingSharedAbstraction = candidate.sharedComposables.length + candidate.sharedStores.length > 0;
  const concreteSignals = concreteBehaviorSignalCount({
    namedState: candidate.sharedBindings,
    requests: candidate.sharedRequests,
    lifecycle: candidate.sharedLifecycle,
    functions: candidate.sharedFunctions,
  });
  if (existingSharedAbstraction && concreteSignals <= 2) return 0;
  if (existingSharedAbstraction) return 0.5;
  if (hasOnlyGenericBehavior(candidate.sharedBindings, candidate.sharedFunctions, candidate.sharedFunctionVerbs)) return 0.25;
  return concreteSignals >= 2 ? 1 : 0.5;
}

function concreteBehaviorSignalCount(parts: {
  namedState: readonly string[];
  requests: readonly string[];
  lifecycle: readonly string[];
  functions: readonly string[];
}): number {
  return (parts.requests.length * 2)
    + parts.lifecycle.length
    + parts.namedState.filter((name) => !GENERIC_BEHAVIOR_NAMES.has(normalizeBehaviorName(name))).length
    + Math.min(parts.functions.length, 3);
}

function hasOnlyGenericBehavior(
  names: readonly string[],
  functions: readonly string[],
  verbs: readonly string[],
): boolean {
  const tokens = [...names, ...functions, ...verbs].map(normalizeBehaviorName);
  return tokens.length > 0 && tokens.every((token) => GENERIC_BEHAVIOR_NAMES.has(token));
}

function normalizeBehaviorName(name: string): string {
  return name.replace(/^handle/, '').replace(/^is/, '').replace(/^has/, '').toLowerCase();
}

function roundHealthScoreCount(count: number): number {
  return Math.round(count * 100) / 100;
}

const GENERIC_BEHAVIOR_NAMES = new Set([
  'add',
  'apply',
  'cancel',
  'change',
  'clear',
  'close',
  'create',
  'delete',
  'draft',
  'edit',
  'error',
  'filter',
  'form',
  'load',
  'loading',
  'name',
  'open',
  'refresh',
  'remove',
  'reset',
  'save',
  'saving',
  'search',
  'select',
  'selected',
  'submit',
  'toggle',
  'update',
  'value',
]);
