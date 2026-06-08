import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ScipDatabase } from '../storage/db.js';
import * as queries from '../queries/index.js';
import { formatBytes, withDb } from './cli-context.js';
import { chunked, runIsolatedJsonProcess } from './isolated-analysis-runner.js';
import { render } from './render.js';

const require = createRequire(import.meta.url);
export const { version: cliVersion } = loadCliPackageInfo();
export const HEALTH_PHASE_COMMAND = '__health-phase';
export const DIFF_IMPACT_BATCH_COMMAND = '__diff-impact-batch';
const DIFF_IMPACT_BATCH_SIZE = 10;
const LARGE_COMMAND_SYMBOL_THRESHOLD = 75_000;
const LARGE_COMMAND_DOCUMENT_THRESHOLD = 5_000;
const DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT = 2_500;

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
type HealthPhaseName = typeof queries.HEALTH_PHASES[number];
type HealthPhaseResult = ReturnType<typeof queries.healthPhase>;
type DiffImpactResult = ReturnType<typeof queries.diffImpact>;
type DiffImpactPartial = ReturnType<typeof queries.diffImpactPartial>;

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

export function commandAnalysisBudget(
  db: ScipDatabase,
  commandName: string,
  full: boolean | undefined,
): CommandAnalysisBudget {
  const statsResult = queries.stats(db);
  const isLargeIndex = statsResult.symbols >= LARGE_COMMAND_SYMBOL_THRESHOLD
    || statsResult.documents >= LARGE_COMMAND_DOCUMENT_THRESHOLD;

  if (!isLargeIndex) return { semantic: true };

  if (full) {
    console.error(`Large index detected; ${commandName} is running the unbounded semantic pass because --full was supplied.`);
    return { semantic: true };
  }

  console.error(
    `Large index detected; ${commandName} will scan the highest-priority ${DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT} candidates with semantic enrichment disabled. ` +
    `Run "scip-query ${commandName} --full" for the unbounded semantic pass.`,
  );
  return { scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT, semantic: false };
}

export function runIsolatedHealthReport(opts: HealthCliOptions): HealthReport {
  const phaseResults = queries.HEALTH_PHASES.map((phase) => runHealthPhaseProcess(phase, opts));
  return queries.healthReportFromPhases(phaseResults);
}

function runHealthPhaseProcess(phase: HealthPhaseName, opts: HealthCliOptions): HealthPhaseResult {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [phase];
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.full) args.push('--full');

  return runIsolatedJsonProcess<HealthPhaseResult>({
    cliPath,
    command: HEALTH_PHASE_COMMAND,
    args,
    label: `Health phase "${phase}"`,
  });
}

export function renderHealthReport(report: HealthReport, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\n  Codebase Health Score: ${report.score}/100\n`);
  console.log(`  ${report.overview.documents} files | ${report.overview.symbols} symbols | ${formatBytes(report.overview.indexSizeBytes)}\n`);

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
  if (f.extractionCandidates > 0) console.log(`    Extract candidates:   ${f.extractionCandidates}`);
  if (f.wrappers > 0) console.log(`    Wrapper functions:    ${f.wrappers}`);
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

  if (report.actions.length === 0) {
    console.log('\n  No issues found. Codebase is clean.');
  }
}

export function runIsolatedDiffImpactReport(opts: DiffImpactCliOptions): DiffImpactResult {
  return withDb((db) => {
    const plan = queries.diffImpactPlan(db, { base: opts.base });
    if (plan.note) {
      return queries.diffImpact(db, { base: opts.base });
    }
    if (plan.changedFiles.length === 0) {
      return queries.diffImpact(db, { base: opts.base });
    }

    const partials: DiffImpactPartial[] = [];
    for (const batch of chunked(plan.changedFiles, DIFF_IMPACT_BATCH_SIZE)) {
      partials.push(runDiffImpactBatchProcess(batch, opts));
    }
    return queries.mergeDiffImpactPartials(plan.changedFiles, partials);
  });
}

function runDiffImpactBatchProcess(files: readonly string[], opts: DiffImpactCliOptions): DiffImpactPartial {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [];
  if (opts.base) args.push('--base', opts.base);

  return runIsolatedJsonProcess<DiffImpactPartial>({
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
