import type { ScipDatabase } from '../../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { dead } from '../cleanup/dead.js';
import { isolated } from '../cleanup/isolated.js';
import { cycles } from '../graph/cycles.js';
import { similarAllCount } from '../cleanup/similar.js';
import { duplicateBodyScan } from '../cleanup/duplicate-bodies.js';
import { allTwinGroups } from '../cleanup/twin-drift.js';
import {
  reactComponentDuplicateScan,
  type ReactComponentDuplicateResult,
} from '../frontend/react-component-duplicates.js';
import { reactHookCandidateScan, type ReactHookCandidateResult } from '../frontend/react-hook-candidates.js';
import { reactLargeComponentPressureScan } from '../frontend/react-large-component-pressure.js';
import { vueComponentDuplicates } from '../frontend/vue-component-duplicates.js';
import { vueComposableCandidates } from '../frontend/vue-composable-candidates.js';
import { vueLargeViewPressure } from '../frontend/vue-large-view-pressure.js';
import { extractCandidates } from '../cleanup/extract-candidates.js';
import { wrapperCandidates, type WrapperCandidate } from '../cleanup/wrapper-candidates.js';
import { passthroughCandidates } from '../cleanup/passthrough-candidates.js';
import { staleAbstractions } from '../cleanup/stale-abstractions.js';
import { drift } from '../cleanup/drift.js';
import { complexityHotspots } from '../quality/complexity-hotspots.js';
import { stats } from '../navigation/stats.js';
import { coChange, type CoChangeFinding } from '../cleanup/co-change.js';
import { gitEvidenceProduct } from '../../analysis/git-history.js';
import type { GitHistoryMode } from '../../analysis/git-history.js';
import { getSuppressionInventory } from '../../analysis/suppressions.js';
import { evaluateCoverageContracts } from '../cleanup/coverage-contracts.js';
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
  PolicyExclusionSummary,
  StaleSummary,
  SuppressionSummary,
} from './health-types.js';
import { assessDetectorEvidenceContracts } from './detector-evidence-contracts.js';

interface HealthBudget {
  candidateScanLimit: number | undefined;
  candidateResultLimit: number;
  complexityResultLimit: number;
  semantic: boolean;
  gitHistoryMode: GitHistoryMode;
  releaseCachesBetweenPhases: boolean;
  warnings: string[];
}

const EXTREME_COMPLEXITY_SCORE = 50;
const EXTREME_COMPLEXITY_MIN_BRANCHES = 10;
const LARGE_HEALTH_SYMBOL_THRESHOLD = 25_000;
const LARGE_HEALTH_DOCUMENT_THRESHOLD = 2_500;
const DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT = 2_500;
const DEFAULT_HEALTH_CANDIDATE_RESULT_LIMIT = 50;
const DEFAULT_HEALTH_COMPLEXITY_RESULT_LIMIT = 10;
export const HEALTH_PHASES = [
  'overview',
  'dead',
  'isolated',
  'cycles',
  'similar',
  'duplicate-bodies',
  'twin-drift',
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
  'coverage-contracts',
] as const;

export type HealthPhaseName = (typeof HEALTH_PHASES)[number];

type HealthPhaseResult =
  | { phase: 'overview'; statsResult: ReturnType<typeof stats>; warnings: string[] }
  | { phase: 'dead'; dead: CountLocSummary }
  | { phase: 'isolated'; isolated: CountLocSummary }
  | { phase: 'cycles'; realCycleCount: number }
  | { phase: 'similar'; similarCount: number }
  | { phase: 'duplicate-bodies'; duplicateBodies: CountLocSummary }
  | { phase: 'twin-drift'; twinDrift: CountLocSummary }
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
  | { phase: 'suppressions'; suppressions: SuppressionSummary }
  | { phase: 'coverage-contracts'; coverageContracts: CountLocSummary };

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
  'duplicate-bodies': (db, scope, budget) => ({
    phase: 'duplicate-bodies',
    duplicateBodies: summarizeDuplicateBodies(db, scope, budget),
  }),
  'twin-drift': (db, scope, budget) => ({
    phase: 'twin-drift',
    twinDrift: summarizeHealthTwinDrift(db, scope, budget),
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
  'coverage-contracts': (db, _scope, budget) => ({
    phase: 'coverage-contracts',
    coverageContracts: summarizeCoverageContracts(db, budget),
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
export function health(db: ScipDatabase, opts: { scope?: string; full?: boolean } = {}): HealthReport {
  return withHealthRun(db, opts.full !== false, (statsResult, budget) => {
    const analyses = runHealthAnalyses(db, opts.scope, statsResult, budget);
    return buildHealthReport(analyses);
  });
}

export function healthPhase(
  db: ScipDatabase,
  phase: HealthPhaseName,
  opts: { scope?: string; full?: boolean } = {},
): HealthPhaseResult {
  return healthPhases(db, [phase], opts)[0]!;
}

export function healthPhases(
  db: ScipDatabase,
  phases: readonly HealthPhaseName[],
  opts: { scope?: string; full?: boolean } = {},
): HealthPhaseResult[] {
  return withHealthRun(db, opts.full !== false, (statsResult, budget) => {
    const sharedCacheBudget = { ...budget, releaseCachesBetweenPhases: false };
    return phases.map((phase) => HEALTH_PHASE_RUNNERS[phase](db, opts.scope, sharedCacheBudget, statsResult));
  });
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
  const overview = requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'overview' }>>(phaseResults, 'overview');
  const analyses: HealthAnalyses = {
    statsResult: overview.statsResult,
    warnings: overview.warnings,
    detectorEvidence: assessDetectorEvidenceContracts(),
    dead: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'dead' }>>(phaseResults, 'dead').dead,
    isolated: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'isolated' }>>(phaseResults, 'isolated').isolated,
    realCycleCount: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'cycles' }>>(phaseResults, 'cycles')
      .realCycleCount,
    similarCount: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'similar' }>>(phaseResults, 'similar')
      .similarCount,
    duplicateBodies: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'duplicate-bodies' }>>(
      phaseResults,
      'duplicate-bodies',
    ).duplicateBodies,
    twinDrift: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'twin-drift' }>>(phaseResults, 'twin-drift')
      .twinDrift,
    reactComponentDuplicates: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'react-component-duplicates' }>>(
      phaseResults,
      'react-component-duplicates',
    ).reactComponentDuplicates,
    reactHookCandidates: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'react-hook-candidates' }>>(
      phaseResults,
      'react-hook-candidates',
    ).reactHookCandidates,
    reactLargeComponentPressure: requiredHealthPhase<
      Extract<HealthPhaseResult, { phase: 'react-large-component-pressure' }>
    >(phaseResults, 'react-large-component-pressure').reactLargeComponentPressure,
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
    gitEvidence:
      optionalHealthPhase<Extract<HealthPhaseResult, { phase: 'git-evidence' }>>(phaseResults, 'git-evidence')
        ?.gitEvidence ?? null,
    suppressions:
      optionalHealthPhase<Extract<HealthPhaseResult, { phase: 'suppressions' }>>(phaseResults, 'suppressions')
        ?.suppressions ?? null,
    coverageContracts: requiredHealthPhase<Extract<HealthPhaseResult, { phase: 'coverage-contracts' }>>(
      phaseResults,
      'coverage-contracts',
    ).coverageContracts,
  };
  return analyses;
}

function optionalHealthPhase<T extends HealthPhaseResult>(
  results: readonly HealthPhaseResult[],
  phase: T['phase'],
): T | undefined {
  return results.find((entry) => entry.phase === phase) as T | undefined;
}

function requiredHealthPhase<T extends HealthPhaseResult>(results: readonly HealthPhaseResult[], phase: T['phase']): T {
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

function summarizeHealthDead(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): CountLocSummary {
  return runHealthPhase(db, budget, 'dead', () => {
    const deadResult = dead(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.dead,
      scanLimit: budget.candidateScanLimit,
      semantic: budget.semantic,
    });
    const applicability = deadResult.applicability;
    return {
      ...summarizeLoc(filterHealthDeadSymbols(db, deadResult.symbols)),
      exclusions: mergePolicyExclusions([
        {
          reason: 'entry-surface-symbols',
          detail:
            'zero-reference symbols in framework entry surfaces (route handlers, pages, scheduled tasks, live barrels) that the framework invokes',
          count: applicability.entrySurfaceExcluded,
        },
        {
          reason: 'generated-artifact-symbols',
          detail:
            'zero-reference symbols in generated artifacts (migration dumps, codegen output) owned by their generator',
          count: applicability.generatedArtifactExcluded ?? 0,
        },
      ]),
    };
  });
}

function summarizeHealthIsolated(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): CountLocSummary {
  return runHealthPhase(db, budget, 'isolated', () => {
    const isolatedResult = isolated(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.isolated,
      scanLimit: budget.candidateScanLimit,
      semantic: budget.semantic,
    });
    return summarizeLoc(filterHealthIsolatedSymbols(db, isolatedResult));
  });
}

function countRealHealthCycles(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): number {
  return runHealthPhase(db, budget, 'cycles', () => {
    const cycleResult = cycles(db, { scope });
    return cycleResult.filter((cycle) => cycle.kind === 'real').length;
  });
}

function countSimilarHealthCandidates(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): number {
  const count = runHealthPhase(db, budget, 'similar', () =>
    similarAllCount(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.similar,
      scanLimit: budget.candidateScanLimit,
      semantic: budget.semantic,
    }),
  );
  return Math.min(count, budget.candidateResultLimit);
}

function countExtractionHealthCandidates(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): number {
  return runHealthPhase(
    db,
    budget,
    'extract-candidates',
    () =>
      extractCandidates(db, {
        scope,
        ...HEALTH_DETECTOR_PROFILES.extract,
        limit: budget.candidateResultLimit,
        scanLimit: budget.candidateScanLimit,
        semantic: budget.semantic,
      }).length,
  );
}

function summarizeDuplicateBodies(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): CountLocSummary {
  return runHealthPhase(db, budget, 'duplicate-bodies', () => {
    const scan = duplicateBodyScan(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.duplicateBodies,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    const files = new Set<string>();
    let duplicateLoc = 0;
    for (const group of scan.groups) {
      for (const entry of group.functions.slice(1)) {
        files.add(entry.file);
        duplicateLoc += entry.loc;
      }
    }
    return {
      count: scan.groups.length,
      loc: duplicateLoc,
      files: [...files],
      exclusions: scan.exclusions.map((exclusion) => ({
        reason: exclusion.reason,
        detail: `${exclusion.detail}; group members removed before counting`,
        count: exclusion.count,
      })),
    };
  });
}

/**
 * Q1: same-name-family (or near-name) twins with divergent or identical
 * bodies, post all twin-drift exclusions (delegation pairs, synthetic
 * `<...>` leaves, test-only clusters). 'homonym' groups are intentionally
 * excluded — a coincidental name reuse below the similarity floor is not a
 * drifted-concept signal. Scan-limited via `budget.candidateScanLimit`, the
 * same shared analysis-budget cap every other candidate-style detector uses
 * on large indexes — twin-drift's own clustering has no separate per-file
 * evidence cache today, matching duplicate-bodies/similar at this layer.
 */
function summarizeHealthTwinDrift(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): CountLocSummary {
  return runHealthPhase(db, budget, 'twin-drift', () => {
    const groups = allTwinGroups(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.twinDrift,
      scanLimit: budget.candidateScanLimit,
    }).filter((group) => group.relationship === 'divergent' || group.relationship === 'identical');
    const files = new Set<string>();
    let loc = 0;
    for (const group of groups) {
      for (const member of group.members) {
        files.add(member.file);
        loc += member.loc;
      }
    }
    return { count: groups.length, loc, files: [...files].sort() };
  });
}

function summarizeReactComponentDuplicates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'react-component-duplicates', () => {
    const scan = reactComponentDuplicateScan(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    const counted = scan.results.filter((result) => reactComponentHealthScore(result) > 0);
    return {
      ...summarizePairLocWithScore(counted, reactComponentHealthScore),
      exclusions: mergePolicyExclusions(scan.exclusions, [
        {
          reason: 'support-tier-pairs',
          detail:
            'support-tier pairs (generic structure only, or framework route scaffolding); listed by react-component-duplicates but not counted',
          count: scan.results.length - counted.length,
        },
      ]),
    };
  });
}

function summarizeReactHookCandidates(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'react-hook-candidates', () => {
    const scan = reactHookCandidateScan(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    const counted: ReactHookCandidateResult[] = [];
    const uncounted = new Map<string, PolicyExclusionSummary>();
    for (const result of scan.results) {
      const verdict = reactHookHealthVerdict(result);
      if (verdict.weight > 0) {
        counted.push(result);
        continue;
      }
      const exclusion = uncounted.get(verdict.reason) ?? { reason: verdict.reason, detail: verdict.detail, count: 0 };
      exclusion.count += 1;
      uncounted.set(verdict.reason, exclusion);
    }
    return {
      ...summarizePairLocWithScore(counted, reactHookHealthScore),
      exclusions: mergePolicyExclusions(scan.exclusions, [...uncounted.values()]),
    };
  });
}

function summarizeReactLargeComponentPressure(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'react-large-component-pressure', () => {
    const scan = reactLargeComponentPressureScan(db, {
      scope,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
    });
    return { ...summarizeUniqueFileLoc(scan.results), exclusions: mergePolicyExclusions(scan.exclusions, []) };
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

function summarizeHealthWrappers(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): CountLocSummary {
  return runHealthPhase(db, budget, 'wrapper-candidates', () => {
    const results = wrapperCandidates(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.wrappers,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
      semantic: budget.semantic,
    });
    // The wrapper claim is "one consumer and wrapper-shaped delegation"; a
    // single-consumer helper that computes something satisfies only half of
    // it, so it stays a disclosed review lead rather than a counted finding.
    const forwarding = results.filter((candidate) => candidate.bodyShape === 'forwarding');
    const helpers = results.length - forwarding.length;
    return {
      ...summarizeLocWithScore(forwarding, wrapperHealthScore),
      exclusions:
        helpers > 0
          ? [
              {
                reason: 'single-consumer-helpers',
                detail:
                  'single-consumer callables whose body computes or branches instead of forwarding one call; listed by wrapper-candidates as signal tier',
                count: helpers,
              },
            ]
          : [],
    };
  });
}

function summarizeHealthPassthroughs(
  db: ScipDatabase,
  scope: string | undefined,
  budget: HealthBudget,
): CountLocSummary {
  return runHealthPhase(db, budget, 'passthrough-candidates', () => {
    const results = passthroughCandidates(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.passthroughs,
      limit: budget.candidateResultLimit,
      scanLimit: budget.candidateScanLimit,
      semantic: budget.semantic,
    });
    return summarizeLocWithScore(results, passthroughHealthScore);
  });
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
      semantic: budget.semantic,
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function summarizeGitEvidence(db: ScipDatabase, budget: HealthBudget): GitEvidenceSummary | null {
  return runHealthPhase(db, budget, 'git-evidence', () => {
    const git = gitEvidenceProduct(db, { historyMode: budget.gitHistoryMode });
    const churn = git.fileChurn();
    if (!churn) return null;
    const history = git.commitHistory();
    const coChangeResult = coChange(db, undefined, {
      limit: budget.candidateResultLimit,
      historyMode: budget.gitHistoryMode,
    });
    const fileStats: Record<string, { changes: number; fixChanges: number }> = {};
    for (const [file, entry] of churn) {
      fileStats[file] = { changes: entry.changes, fixChanges: entry.fixChanges };
    }
    const counted = coChangeResult.findings.filter((finding) => hiddenCouplingHealthVerdict(finding).counted);
    const excluded = new Map<string, PolicyExclusionSummary>();
    for (const finding of coChangeResult.findings) {
      const verdict = hiddenCouplingHealthVerdict(finding);
      if (verdict.counted) continue;
      const entry = excluded.get(verdict.reason) ?? { reason: verdict.reason, detail: verdict.detail, count: 0 };
      entry.count += 1;
      excluded.set(verdict.reason, entry);
    }
    // Lead with the pair that carries the most score weight: a generated
    // journal that co-changes 290 times is a striking example of nothing.
    const ranked = [...counted].sort(
      (left, right) =>
        hiddenCouplingHealthScore(right) - hiddenCouplingHealthScore(left) || right.together - left.together,
    );
    return {
      amplification: git.changeAmplification(),
      hiddenCoupling: {
        pairCount: counted.length,
        scoreCount: roundHealthScoreCount(
          counted.reduce((sum, finding) => sum + hiddenCouplingHealthScore(finding), 0),
        ),
        exclusions: [...excluded.values()].sort((left, right) => left.reason.localeCompare(right.reason)),
        top: ranked.slice(0, 5).map((finding) => ({
          fileA: finding.fileA,
          fileB: finding.fileB,
          together: finding.together,
          confidence: finding.confidence,
          focusedTogether: finding.focusedTogether,
          broadTogether: finding.broadTogether,
          broadCommitRatio: finding.broadCommitRatio,
          lastTogetherAt: finding.lastTogetherAt,
          recentTogether: finding.recentTogether,
          commitScope: finding.commitScope,
          recency: finding.recency,
          scoreWeight: hiddenCouplingHealthScore(finding),
          subjectContext: finding.subjectContext,
        })),
      },
      fileStats,
      commitsScanned: history?.commits.length ?? 0,
    };
  });
}

function summarizeSuppressions(db: ScipDatabase, budget: HealthBudget): SuppressionSummary {
  return runHealthPhase(db, budget, 'suppressions', () => {
    const inventory = getSuppressionInventory(db);
    return { total: inventory.total, byCategory: { ...inventory.byCategory } };
  });
}

function summarizeCoverageContracts(db: ScipDatabase, budget: HealthBudget): CountLocSummary {
  return runHealthPhase(db, budget, 'coverage-contracts', () => {
    const contracts = db.config.coverageContracts ?? [];
    const results = evaluateCoverageContracts(db, contracts);
    const violations = results.filter((result) => result.status !== 'ok');
    return {
      count: violations.length,
      loc: 0,
      files: [...new Set(violations.map((result) => result.file))].sort(),
    };
  });
}

function summarizeHealthDrift(db: ScipDatabase, scope: string | undefined, budget: HealthBudget): DriftSummary {
  return runHealthPhase(db, budget, 'drift', () => {
    // Health always wants the full unused-import/architecture-violation count for
    // scoring, not the CLI's 21.2 default display cap — pattern-deviation is
    // already excluded above, so there's no volume problem left to bound.
    const driftResult = drift(db, {
      scope,
      ...HEALTH_DETECTOR_PROFILES.drift,
      includePatternDeviations: false,
      limit: Number.POSITIVE_INFINITY,
      semantic: budget.semantic,
    });
    const healthVisible = driftResult.results.filter((result) => result.kind !== 'pattern-deviation');
    const direct = healthVisible.filter((result) => result.actionTier === 'direct').length;
    const signal = healthVisible.length - direct;
    return {
      count: healthVisible.length,
      unusedImports: driftResult.unusedImports,
      architectureViolations: driftResult.architectureViolations,
      layerViolations: driftResult.layerViolations,
      direct,
      signal,
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
      semantic: budget.semantic,
    });
    // The score multiplies fan-in, so a 50-line primitive that every file
    // imports outranks genuinely tangled code. "Extreme" is reserved for
    // callables that also carry branch pressure; a popular leaf is a hot
    // dependency, not a complexity hotspot.
    const extreme = complexResult.filter(
      (r) => r.score > EXTREME_COMPLEXITY_SCORE && r.branches >= EXTREME_COMPLEXITY_MIN_BRANCHES,
    );
    const popularLeaves = complexResult.filter(
      (r) => r.score > EXTREME_COMPLEXITY_SCORE && r.branches < EXTREME_COMPLEXITY_MIN_BRANCHES,
    ).length;
    return {
      top: complexResult.slice(0, 5).map((r) => ({
        symbol: r.shortName,
        score: r.score,
        file: r.file,
      })),
      extremeCount: extreme.length,
      exclusions:
        popularLeaves > 0
          ? [
              {
                reason: 'popular-low-branch-callables',
                detail: `callables above the extreme score only through fan-in, with fewer than ${EXTREME_COMPLEXITY_MIN_BRANCHES} branches`,
                count: popularLeaves,
              },
            ]
          : [],
    };
  });
}

function healthBudget(statsResult: ReturnType<typeof stats>, full: boolean): HealthBudget {
  const isLargeIndex =
    statsResult.symbols >= LARGE_HEALTH_SYMBOL_THRESHOLD || statsResult.documents >= LARGE_HEALTH_DOCUMENT_THRESHOLD;
  const candidateResultLimit = full ? Number.POSITIVE_INFINITY : DEFAULT_HEALTH_CANDIDATE_RESULT_LIMIT;
  const complexityResultLimit = full ? Number.POSITIVE_INFINITY : DEFAULT_HEALTH_COMPLEXITY_RESULT_LIMIT;

  if (!isLargeIndex || full) {
    return {
      candidateScanLimit: undefined,
      candidateResultLimit,
      complexityResultLimit,
      semantic: true,
      gitHistoryMode: full ? 'full' : 'bounded',
      releaseCachesBetweenPhases: true,
      warnings:
        full && isLargeIndex
          ? ['Large index detected; running health without candidate scan or result caps because full mode is enabled.']
          : [],
    };
  }

  return {
    candidateScanLimit: DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT,
    candidateResultLimit,
    complexityResultLimit,
    semantic: false,
    gitHistoryMode: 'bounded',
    releaseCachesBetweenPhases: true,
    warnings: [
      `Large index detected; candidate-style health checks scanned their highest-priority ${DEFAULT_HEALTH_CANDIDATE_SCAN_LIMIT} symbols and reported their top ${DEFAULT_HEALTH_CANDIDATE_RESULT_LIMIT} findings. Enable full mode for unbounded candidate counts.`,
    ],
  };
}

function releaseHealthPhaseCaches(db: ScipDatabase, budget: HealthBudget): void {
  if (!budget.releaseCachesBetweenPhases) return;
  clearWholeProjectEvidenceCaches(db);
  requestGarbageCollection();
}

function runHealthPhase<T>(db: ScipDatabase, budget: HealthBudget, name: string, analyze: () => T): T {
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
): Array<{ loc: number; relativePath: string }> {
  return symbols.filter(
    (symbol) =>
      !isEntrySurface(db, symbol.relativePath) &&
      !isRootedSymbol(db, symbol.symbol, symbol.relativePath) &&
      symbol.kind === 'dead-code',
  );
}

function filterHealthIsolatedSymbols(
  db: ScipDatabase,
  symbols: Array<{ relativePath: string; symbol: string; loc: number }>,
): Array<{ loc: number; relativePath: string }> {
  return symbols.filter(
    (symbol) => !isEntrySurface(db, symbol.relativePath) && !isRootedSymbol(db, symbol.symbol, symbol.relativePath),
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

function summarizeLocWithScore<T extends { loc: number; relativePath?: string; file?: string }>(
  items: T[],
  score: (item: T) => number,
): CountLocSummary {
  const summary = summarizeLoc(items);
  return {
    ...summary,
    scoreCount: roundHealthScoreCount(items.reduce((sum, item) => sum + score(item), 0)),
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

function reactComponentHealthScore(result: Pick<ReactComponentDuplicateResult, 'actionTier'>): number {
  return result.actionTier === 'signal' ? 1 : 0;
}

type ReactHookHealthCandidate = Pick<
  ReactHookCandidateResult,
  | 'sharedHooks'
  | 'sharedState'
  | 'sharedRequests'
  | 'sharedEffects'
  | 'sharedHandlers'
  | 'sharedHandlerVerbs'
  | 'evidenceClass'
>;

function reactHookHealthScore(candidate: ReactHookHealthCandidate): number {
  return reactHookHealthVerdict(candidate).weight;
}

/**
 * Health weight of one shared-behavior pair, with the policy that zeroed it.
 * A pair whose overlap is entirely generic React mechanics, or that only
 * repeats a framework route's scaffolding, or whose concrete behavior is
 * already carried by a hook both sides call, is not a hook-extraction
 * finding; it stays visible in the detector output and is disclosed here.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; the weight tiers are one scoring policy.
function reactHookHealthVerdict(candidate: ReactHookHealthCandidate): {
  weight: number;
  reason: string;
  detail: string;
} {
  if (candidate.evidenceClass === 'generic-workflow-scaffolding') {
    return {
      weight: 0,
      reason: 'generic-workflow-pairs',
      detail: 'pairs whose shared behavior is only generic React mechanics (open/close/submit state and handlers)',
    };
  }
  // A framework hook (`useQueryClient`, `useRouter`) is plumbing every
  // component uses; only a project hook both sides call counts as an
  // abstraction that already carries their shared behavior.
  const existingSharedAbstraction = candidate.sharedHooks.some((hook) => !GENERIC_HOOK_NAMES.has(hook));
  const concreteSignals = concreteBehaviorSignalCount({
    namedState: candidate.sharedState,
    requests: candidate.sharedRequests,
    lifecycle: candidate.sharedEffects,
    functions: candidate.sharedHandlers,
  });
  if (existingSharedAbstraction && concreteSignals <= 2) {
    return {
      weight: 0,
      reason: 'shared-hook-covered-pairs',
      detail: 'pairs whose concrete shared behavior is already carried by a project hook both sides call',
    };
  }
  if (!existingSharedAbstraction && concreteSignals === 0) {
    return {
      weight: 0,
      reason: 'generic-workflow-pairs',
      detail: 'pairs whose shared behavior is only generic React mechanics (open/close/submit state and handlers)',
    };
  }
  const counted = { reason: 'counted', detail: 'counted' };
  if (existingSharedAbstraction) return { weight: 0.5, ...counted };
  if (hasOnlyGenericBehavior(candidate.sharedState, candidate.sharedHandlers, candidate.sharedHandlerVerbs))
    return { weight: 0.25, ...counted };
  return { weight: concreteSignals >= 2 ? 1 : 0.5, ...counted };
}

function mergePolicyExclusions(...groups: ReadonlyArray<readonly PolicyExclusionSummary[]>): PolicyExclusionSummary[] {
  const merged = new Map<string, PolicyExclusionSummary>();
  for (const group of groups) {
    for (const exclusion of group) {
      if (exclusion.count <= 0) continue;
      const existing = merged.get(exclusion.reason);
      if (existing) existing.count += exclusion.count;
      else merged.set(exclusion.reason, { ...exclusion });
    }
  }
  return [...merged.values()].sort((left, right) => left.reason.localeCompare(right.reason));
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
  if (hasOnlyGenericBehavior(candidate.sharedBindings, candidate.sharedFunctions, candidate.sharedFunctionVerbs))
    return 0.25;
  return concreteSignals >= 2 ? 1 : 0.5;
}

function concreteBehaviorSignalCount(parts: {
  namedState: readonly string[];
  requests: readonly string[];
  lifecycle: readonly string[];
  functions: readonly string[];
}): number {
  // A bare `.mutate()`, `fetch()`, or `useQuery()` names the runtime, not a
  // product request; only a request with a domain name counts as concrete.
  const domainRequests = parts.requests.filter((name) => !GENERIC_REQUEST_NAMES.has(name));
  return (
    domainRequests.length * 2 +
    parts.lifecycle.length +
    parts.namedState.filter((name) => !GENERIC_BEHAVIOR_NAMES.has(normalizeBehaviorName(name))).length +
    Math.min(parts.functions.length, 3)
  );
}

const GENERIC_HOOK_NAMES = new Set([
  'useForm',
  'useFormContext',
  'useInfiniteQuery',
  'useMutation',
  'useParams',
  'usePathname',
  'useQuery',
  'useQueryClient',
  'useRouter',
  'useSearchParams',
  'useSelector',
  'useDispatch',
  'useSuspenseQuery',
  'useTheme',
  'useTranslation',
]);

const GENERIC_REQUEST_NAMES = new Set([
  'axios',
  'fetch',
  'gql',
  'graphql',
  'mutate',
  'query',
  'request',
  'useInfiniteQuery',
  'useMutation',
  'useQuery',
  'useSuspenseQuery',
]);

function hasOnlyGenericBehavior(
  names: readonly string[],
  functions: readonly string[],
  verbs: readonly string[],
): boolean {
  const tokens = [...names, ...functions, ...verbs].map(normalizeBehaviorName);
  return tokens.length > 0 && tokens.every((token) => GENERIC_BEHAVIOR_NAMES.has(token));
}

function normalizeBehaviorName(name: string): string {
  return name
    .replace(/^handle/, '')
    .replace(/^is/, '')
    .replace(/^has/, '')
    .toLowerCase();
}

function wrapperHealthScore(candidate: WrapperCandidate): number {
  return candidate.actionTier === 'signal' ? 0.25 : 1;
}

function passthroughHealthScore(candidate: { actionTier?: 'direct' | 'signal' }): number {
  return candidate.actionTier === 'signal' ? 0.25 : 1;
}

function hiddenCouplingHealthScore(finding: Pick<CoChangeFinding, 'commitScope' | 'recency' | 'partnerClass'>): number {
  if (!hiddenCouplingHealthVerdict(finding).counted) return 0;
  if (finding.commitScope === 'broad-sweep') return finding.recency === 'recent' ? 0.25 : 0;
  if (finding.commitScope === 'mixed') return finding.recency === 'recent' ? 0.5 : 0.25;
  return finding.recency === 'recent' ? 1 : 0.5;
}

/**
 * Whether a co-change pair is hidden coupling in the sense the score claims:
 * two source units that implement one concept without a visible link. A
 * document that changes alongside the code it describes is documentation
 * kept in sync (doc-drift owns the failure mode); a generated artifact
 * changes with its source because a tool rewrites it. Both stay visible in
 * `co-change` and are disclosed here instead of counted.
 */
function hiddenCouplingHealthVerdict(finding: Pick<CoChangeFinding, 'partnerClass'>): {
  counted: boolean;
  reason: string;
  detail: string;
} {
  switch (finding.partnerClass) {
    case 'doc-code':
      return {
        counted: false,
        reason: 'doc-sync-pairs',
        detail: 'documentation that changes alongside the code it describes (doc-drift owns stale docs)',
      };
    case 'generated-artifact':
      return {
        counted: false,
        reason: 'generated-artifact-pairs',
        detail: 'generated artifacts (migration journals, snapshots, codegen output) rewritten from their source',
      };
    default:
      return { counted: true, reason: 'counted', detail: 'counted' };
  }
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
