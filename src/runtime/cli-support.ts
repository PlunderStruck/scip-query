import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ScipDatabase } from '../storage/db.js';
import * as queries from '../queries/index.js';
import { sourceFrameworkApplicability } from '../source/source-fileset.js';
import { formatBytes, withDb } from './cli-context.js';
import {
  chunked,
  groupAnalysisTasks,
  runAnalysisTasks,
  runIsolatedJsonProcessAsync,
} from './isolated-analysis-runner.js';
import { render } from './render.js';

const require = createRequire(import.meta.url);
export const { version: cliVersion } = loadCliPackageInfo();
export const HEALTH_PHASE_COMMAND = '__health-phase';
export const DIFF_IMPACT_BATCH_COMMAND = '__diff-impact-batch';
const DIFF_IMPACT_BATCH_SIZE = 10;
const DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY = 4;
const MAX_DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY = 8;
const LARGE_COMMAND_SYMBOL_THRESHOLD = 25_000;
const LARGE_COMMAND_DOCUMENT_THRESHOLD = 2_500;
const DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT = 2_500;
const DEFAULT_HEALTH_PHASE_CONCURRENCY = 4;
const MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY = 12;
const REACT_HEALTH_PHASES = new Set<HealthPhaseName>([
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
]);
const VUE_HEALTH_PHASES = new Set<HealthPhaseName>([
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
]);
const VUE_HEALTH_TASK_PHASES = new Set<HealthPhaseName>([...VUE_HEALTH_PHASES, 'suppressions']);
const SIMILAR_EXTRACT_HEALTH_PHASES = new Set<HealthPhaseName>(['similar', 'extract-candidates']);

function loadCliPackageInfo(): { version: string } {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      return require(path) as { version: string };
    } catch {
      // Source runs from src/runtime; bundled CLI runs from dist.
    }
  }
  return { version: '0.0.0' };
}

type HealthReport = ReturnType<typeof queries.health>;
type HealthPhaseName = (typeof queries.HEALTH_PHASES)[number];
type HealthPhaseResult = ReturnType<typeof queries.healthPhase>;
type DiffImpactResult = ReturnType<typeof queries.diffImpact>;
type DiffImpactPartial = ReturnType<typeof queries.diffImpactPartial>;
type AvailableCpus = () => number;
type ConcurrencyResolver = (itemCount: number, env?: NodeJS.ProcessEnv, availableCpus?: AvailableCpus) => number;
type HealthPhaseTask = HealthPhaseName[];

export interface HealthCliOptions {
  scope?: string;
  full?: boolean;
  json?: boolean;
}

export interface DiffImpactCliOptions {
  base?: string;
}

export function renderHeuristicNotice(label: string): void {
  console.log(`Heuristic ${label}: review before acting; these are candidates, not exact compiler facts.\n`);
}

interface CommandAnalysisBudget {
  scanLimit?: number;
  semantic: boolean;
}

export function isLargeCommandIndex(db: ScipDatabase): boolean {
  const statsResult = queries.stats(db);
  return (
    statsResult.symbols >= LARGE_COMMAND_SYMBOL_THRESHOLD || statsResult.documents >= LARGE_COMMAND_DOCUMENT_THRESHOLD
  );
}

export function commandAnalysisBudget(
  db: ScipDatabase,
  commandName: string,
  full: boolean | undefined,
  opts: { quiet?: boolean } = {},
): CommandAnalysisBudget {
  if (!isLargeCommandIndex(db)) return { semantic: true };

  if (full) {
    if (!opts.quiet) {
      console.error(
        `Large index detected; ${commandName} is running the unbounded semantic pass because --full was supplied.`,
      );
    }
    return { semantic: true };
  }

  if (!opts.quiet) {
    console.error(
      `Large index detected; ${commandName} will scan the highest-priority ${DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT} candidates with semantic enrichment disabled. ` +
        `Run "scip-query ${commandName} --full" for the unbounded semantic pass.`,
    );
  }
  return { scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT, semantic: false };
}

export async function runIsolatedHealthReport(opts: HealthCliOptions): Promise<HealthReport> {
  const { applicability, overview } = withDb((db) => ({
    applicability: healthPhaseApplicability(db, opts),
    overview: queries.healthPhase(db, 'overview', opts),
  }));
  const resultByPhase = new Map<HealthPhaseName, HealthPhaseResult>();
  resultByPhase.set('overview', overview);
  const runnablePhases = queries.HEALTH_PHASES.filter((phase) => {
    if (phase === 'overview') return false;
    if (shouldRunHealthPhase(phase, applicability)) return true;
    resultByPhase.set(phase, skippedHealthPhaseResult(phase));
    return false;
  });

  const runnableTasks = healthPhaseTasks(runnablePhases);
  const runnableResults = await runAnalysisTasks(runnableTasks, healthPhaseConcurrency(runnableTasks.length), (task) =>
    runHealthPhaseTaskProcess(task, opts),
  );
  runnableResults.flat().forEach((result) => resultByPhase.set(result.phase, result));

  return queries.healthReportFromPhases(queries.HEALTH_PHASES.map((phase) => resultByPhase.get(phase)!));
}

function healthPhaseApplicability(db: ScipDatabase, opts: HealthCliOptions) {
  return sourceFrameworkApplicability(db, { scope: opts.scope });
}

export function shouldRunHealthPhase(
  phase: HealthPhaseName,
  applicability: ReturnType<typeof sourceFrameworkApplicability>,
): boolean {
  if (REACT_HEALTH_PHASES.has(phase)) return applicability.react;
  if (VUE_HEALTH_PHASES.has(phase)) return applicability.vue;
  return true;
}

export function healthPhaseTasks(phases: readonly HealthPhaseName[]): HealthPhaseTask[] {
  return groupAnalysisTasks(phases, [REACT_HEALTH_PHASES, VUE_HEALTH_TASK_PHASES, SIMILAR_EXTRACT_HEALTH_PHASES]);
}

export function skippedHealthPhaseResult(phase: HealthPhaseName): HealthPhaseResult {
  switch (phase) {
    case 'react-component-duplicates':
      return { phase, reactComponentDuplicates: { count: 0, loc: 0, files: [] } };
    case 'react-hook-candidates':
      return { phase, reactHookCandidates: { count: 0, loc: 0, files: [] } };
    case 'react-large-component-pressure':
      return { phase, reactLargeComponentPressure: { count: 0, loc: 0, files: [] } };
    case 'vue-component-duplicates':
      return { phase, vueComponentDuplicates: { count: 0, loc: 0, files: [] } };
    case 'vue-composable-candidates':
      return { phase, vueComposableCandidates: { count: 0, loc: 0, files: [] } };
    case 'vue-large-view-pressure':
      return { phase, vueLargeViewPressure: { count: 0, loc: 0, files: [] } };
    default:
      throw new Error(`Health phase "${phase}" cannot be synthesized.`);
  }
}

function runHealthPhaseTaskProcess(phases: HealthPhaseTask, opts: HealthCliOptions): Promise<HealthPhaseResult[]> {
  if (phases.length === 1) return runHealthPhaseProcess(phases[0]!, opts).then((result) => [result]);

  const phaseArg = phases.join(',');
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [phaseArg];
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.full) args.push('--full');

  return runIsolatedJsonProcessAsync<HealthPhaseResult[]>({
    cliPath,
    command: HEALTH_PHASE_COMMAND,
    args,
    label: `Health phases "${phaseArg}"`,
  });
}

function runHealthPhaseProcess(phase: HealthPhaseName, opts: HealthCliOptions): Promise<HealthPhaseResult> {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [phase];
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.full) args.push('--full');

  return runIsolatedJsonProcessAsync<HealthPhaseResult>({
    cliPath,
    command: HEALTH_PHASE_COMMAND,
    args,
    label: `Health phase "${phase}"`,
  });
}

// scip-query: ignore-similar — public scheduler entrypoints intentionally share
// the resolver factory; their env key and default cap are the product variation.
export const healthPhaseConcurrency = createAdaptiveConcurrencyResolver({
  envKey: 'SCIP_QUERY_HEALTH_CONCURRENCY',
  defaultMinimum: DEFAULT_HEALTH_PHASE_CONCURRENCY,
  defaultMaximum: MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY,
});

export function renderHealthReport(report: HealthReport, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\n  Codebase Health Score: ${report.score}/100`);
  console.log(`    Risk:    ${report.riskScore}/100  (validated predictors: graph facts + change graph)`);
  console.log(`    Hygiene: ${report.hygieneScore}/100  (tidiness candidates)\n`);
  console.log(
    `  ${report.overview.documents} files | ${report.overview.symbols} symbols | ${formatBytes(report.overview.indexSizeBytes)}\n`,
  );

  if (report.warnings && report.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warning of report.warnings) {
      console.log(`    ${warning}`);
    }
    console.log('');
  }

  console.log('  Findings:');
  const f = report.findings;
  if (f.deadSymbols > 0) console.log(`    Dead code:            ${f.deadSymbols} symbols (${f.deadLoc} LOC)`);
  if (f.isolatedSymbols > 0) console.log(`    Isolated symbols:     ${f.isolatedSymbols} (${f.isolatedLoc} LOC)`);
  if (f.cycles > 0) console.log(`    Circular deps:        ${f.cycles}`);
  if (f.similarPairs > 0) console.log(`    Similar pairs:        ${f.similarPairs}`);
  if (f.reactComponentDuplicatePairs > 0)
    console.log(`    React components:     ${f.reactComponentDuplicatePairs} duplicate pair(s)`);
  if (f.reactHookCandidatePairs > 0) {
    console.log(
      `    React hook reuse:     ${formatScoreAwareCount(f.reactHookCandidatePairs, f.reactHookCandidateScoreCount)} candidate pair(s)`,
    );
  }
  if (f.reactLargeComponentPressureFiles > 0)
    console.log(`    React large comps:    ${f.reactLargeComponentPressureFiles} component(s)`);
  if (f.vueComponentDuplicatePairs > 0)
    console.log(`    Vue components:       ${f.vueComponentDuplicatePairs} duplicate pair(s)`);
  if (f.vueComposableCandidatePairs > 0) {
    console.log(
      `    Vue composables:      ${formatScoreAwareCount(f.vueComposableCandidatePairs, f.vueComposableCandidateScoreCount)} candidate pair(s)`,
    );
  }
  if (f.vueLargeViewPressureFiles > 0) console.log(`    Vue large views:      ${f.vueLargeViewPressureFiles} file(s)`);
  if (f.extractionCandidates > 0) console.log(`    Extract candidates:   ${f.extractionCandidates}`);
  if (f.wrappers > 0)
    console.log(`    Wrapper functions:    ${formatScoreAwareCount(f.wrappers, f.wrapperScoreCount)}`);
  if (f.passthroughs > 0) console.log(`    Passthroughs:         ${f.passthroughs}`);
  if (f.staleTypes > 0) console.log(`    Stale abstractions:   ${f.staleTypes}`);
  if (f.driftedFiles > 0) console.log(`    Pattern drift:        ${f.driftedFiles} files`);
  if (f.complexityHotspotCount > 0) console.log(`    Complexity hotspots:  ${f.complexityHotspotCount}`);

  if (report.actions.length > 0) {
    console.log('\n  Prioritized Actions (highest impact + lowest effort first):');
    for (let i = 0; i < report.actions.length; i++) {
      const a = report.actions[i]!;
      const loc = a.locRecoverable > 0 ? ` (~${a.locRecoverable} LOC recoverable)` : '';
      console.log(`    ${i + 1}. [${a.effort} effort / ${a.impact} impact] ${a.description}${loc}`);
    }
  }

  if (report.topComplexity.length > 0) {
    console.log('\n  Top Complexity Hotspots:');
    for (const c of report.topComplexity) {
      console.log(`    ${c.score.toFixed(1).padStart(6)}  ${c.symbol}`);
    }
  }

  renderHealthAxes(report);
  renderHealthPressure(report);

  if (report.scoreBreakdown.length > 0) {
    console.log('\n  Score Breakdown (100 minus the following):');
    for (const deduction of report.scoreBreakdown) {
      console.log(`    -${String(deduction.points).padStart(2)}  ${deduction.axis}: ${deduction.detail}`);
    }
  }

  if (report.actions.length === 0) {
    console.log('\n  No issues found. Codebase is clean.');
  }
}

function formatScoreAwareCount(rawCount: number, scoreCount: number): string {
  if (Math.abs(rawCount - scoreCount) < 0.01) return String(rawCount);
  return `${rawCount} (${formatCompactNumber(scoreCount)} score-weighted)`;
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function renderHealthPressure(report: HealthReport): void {
  if (report.pressure.length === 0) return;
  console.log('\n  Maintenance Pressure:');
  for (const pressure of report.pressure) {
    console.log(
      `    ${pressure.category}: ${pressure.count} / ${pressure.threshold} threshold ` +
        `(${pressure.ratio}x, -${pressure.extraPenalty} ${pressure.kind})`,
    );
  }
}

function renderHealthAxes(report: HealthReport): void {
  const axes = report.axes;
  console.log('\n  Axes:');
  console.log(`    Deletable:            ${axes.deletable.loc} LOC across ${axes.deletable.symbols} symbols`);
  if (axes.changeAmplification) {
    const amp = axes.changeAmplification;
    console.log(
      `    Change amplification: ${amp.medianFilesPerCommit} files/commit median, ${amp.p90FilesPerCommit} p90 (${amp.commitsAnalyzed} commits)`,
    );
  }
  if (axes.hiddenCoupling && axes.hiddenCoupling.pairCount > 0) {
    console.log(
      `    Hidden coupling:      ${axes.hiddenCoupling.pairCount} co-changing pair(s) without a dependency edge`,
    );
    for (const pair of axes.hiddenCoupling.top.slice(0, 3)) {
      console.log(
        `      ${pair.fileA} <-> ${pair.fileB}  (${pair.together}x together, ${Math.round(pair.confidence * 100)}%)`,
      );
    }
  }
  if (axes.churnWeightedComplexity && axes.churnWeightedComplexity.length > 0) {
    const top = axes.churnWeightedComplexity[0]!;
    if (top.weighted > 0) {
      console.log(
        `    Churn x complexity:   hottest is ${top.symbol} (${top.changes} changes, weighted ${top.weighted})`,
      );
    }
  }
  const quality = axes.evidenceQuality;
  console.log(
    `    Evidence quality:     ${quality.graphFindings} graph-fact finding(s), ${quality.heuristicFindings} heuristic finding(s), ${quality.userSuppressed} user-suppressed`,
  );
  if (report.validation && report.validation.flaggedFiles > 0) {
    const v = report.validation;
    const ratio = v.ratio === null ? 'n/a' : `${v.ratio}x`;
    console.log(
      `    Validation:           flagged files fix-density ${v.flaggedFixDensity} vs baseline ${v.baselineFixDensity} (${ratio})`,
    );
  }
}

export async function runIsolatedDiffImpactReport(opts: DiffImpactCliOptions): Promise<DiffImpactResult> {
  const plan = withDb((db) => {
    const plan = queries.diffImpactPlan(db, { base: opts.base });
    if (plan.note) {
      return { kind: 'complete' as const, result: queries.diffImpact(db, { base: opts.base }) };
    }
    if (plan.changedFiles.length === 0) {
      return { kind: 'complete' as const, result: queries.diffImpact(db, { base: opts.base }) };
    }
    return { kind: 'batched' as const, plan };
  });

  if (plan.kind === 'complete') return plan.result;

  const batches = chunked(plan.plan.changedFiles, DIFF_IMPACT_BATCH_SIZE);
  const partials = await runAnalysisTasks(batches, diffImpactBatchConcurrency(batches.length), (batch) =>
    runDiffImpactBatchProcess(batch, opts),
  );
  return queries.mergeDiffImpactPartials(plan.plan.changedFiles, partials);
}

// scip-query: ignore-similar — parallel to healthPhaseConcurrency by design:
// same adaptive policy, different workload/env key/default cap.
export const diffImpactBatchConcurrency = createAdaptiveConcurrencyResolver({
  envKey: 'SCIP_QUERY_DIFF_IMPACT_CONCURRENCY',
  defaultMinimum: DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY,
  defaultMaximum: MAX_DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY,
});

function createAdaptiveConcurrencyResolver(opts: {
  envKey: string;
  defaultMinimum: number;
  defaultMaximum: number;
}): ConcurrencyResolver {
  return (itemCount, env = process.env, availableCpus = availableParallelism) =>
    adaptiveConcurrency(itemCount, env, availableCpus, opts);
}

function adaptiveConcurrency(
  itemCount: number,
  env: NodeJS.ProcessEnv,
  availableCpus: AvailableCpus,
  opts: { envKey: string; defaultMinimum: number; defaultMaximum: number },
): number {
  const raw = env[opts.envKey];
  const defaultConcurrency = defaultAdaptiveConcurrency(availableCpus, opts);
  const parsed = raw ? parseInt(raw, 10) : defaultConcurrency;
  if (!Number.isFinite(parsed) || parsed < 1) return Math.min(defaultConcurrency, itemCount);
  return Math.min(parsed, itemCount);
}

function defaultAdaptiveConcurrency(
  availableCpus: AvailableCpus,
  opts: { defaultMinimum: number; defaultMaximum: number },
): number {
  const cpuCount = availableCpus();
  const adaptive = Number.isFinite(cpuCount) ? Math.max(opts.defaultMinimum, cpuCount - 1) : 0;
  return Math.min(opts.defaultMaximum, Math.max(opts.defaultMinimum, adaptive));
}

function runDiffImpactBatchProcess(files: readonly string[], opts: DiffImpactCliOptions): Promise<DiffImpactPartial> {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [];
  if (opts.base) args.push('--base', opts.base);

  return runIsolatedJsonProcessAsync<DiffImpactPartial>({
    cliPath,
    command: DIFF_IMPACT_BATCH_COMMAND,
    args,
    env: {
      ...process.env,
      SCIP_QUERY_DIFF_IMPACT_FILES: JSON.stringify(files),
    },
    label: 'Diff-impact batch',
  });
}

export function renderDiffImpactReport(result: DiffImpactResult): void {
  console.log(`Changed files: ${result.summary.totalChangedFiles}`);
  console.log(`Changed symbols: ${result.summary.totalChangedSymbols}`);
  console.log(`Affected consumer files: ${result.summary.totalAffectedFiles}`);
  if (result.summary.note) {
    console.log(`Note: ${result.summary.note}`);
  }
  console.log('');
  if (result.changedSymbols.length > 0) {
    console.log('Changed symbols:');
    render.list(result.changedSymbols, (s) => `  ${s.file}  ${s.shortName}  (fan-in: ${s.fanIn})`);
  }
  if (result.affectedConsumers.length > 0) {
    console.log('\nAffected consumer files:');
    render.list(result.affectedConsumers, (c) => `  ${c.file}  (${c.consumedSymbols} symbol(s))`);
  }
}
