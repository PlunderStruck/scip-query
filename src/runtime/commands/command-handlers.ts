import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { SupportedLanguage } from '../../domain/types.js';
import * as queries from '../../queries/index.js';
import {
  augmentAuxiliaryDocuments,
  augmentVueResolvedReferences,
  detectLanguages,
  reindex,
} from '../../reindex/index.js';
import {
  addFindingSuppression,
  loadProjectConfig,
  resolveIndexPaths,
  initProjectConfig,
  validateProjectConfig,
} from '../config.js';
import { getIndexFreshness } from '../index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from '../project-readiness.js';
import { Watcher } from '../watch.js';
import { setupAgent } from '../agent-setup.js';
import { installProjectAgentHooks } from '../agent-hooks.js';
import { renderProjectSetupReport, runProjectSetup } from '../project-setup.js';
import { setupCiWorkflow } from '../setup-ci.js';
import { installSkills, isScipInstalled, printScipInstallInstructions } from '../setup.js';
import { ALL_SOURCE_EXTENSIONS } from '../../source/source-fileset.js';
import { healthPhases } from '../../queries/health/health.js';
import { writeProfileEvent } from '../../instrumentation/profile.js';
import {
  collect,
  formatBytes,
  formatStatus,
  resolveCliProjectContext,
  resolveActiveDbPath,
  resolveProjectRoot,
  withDb,
} from '../cli-context.js';
import {
  renderDiffImpactReport,
  renderHealthReport,
  runIsolatedDiffImpactReport,
  runIsolatedHealthReport,
} from '../cli-support.js';
import {
  booleanOptionValue,
  commandOptions,
  numberOptionValue,
  printJsonEnvelope,
  stringArrayOptionValue,
  stringOptionValue,
} from './command-execution.js';

// Descriptor-backed query commands live under runtime/query-commands/*.
// This file owns side-effect lifecycles such as reindex, setup, watch, and
// install commands.
const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>([
  'typescript',
  'javascript',
  'java',
  'scala',
  'kotlin',
  'rust',
  'python',
  'ruby',
  'go',
  'cpp',
  'c',
  'csharp',
  'vb',
  'dart',
  'php',
  'clojure',
]);
const BENCH_TIMEOUT_MS = 180_000;
const BENCH_MAX_BUFFER = 100 * 1024 * 1024;
const SOURCE_EXTENSION_SET = new Set(ALL_SOURCE_EXTENSIONS);
const DEFAULT_BENCH_COMMANDS: readonly (readonly string[])[] = [
  ['status', '--json'],
  ['status', '--capabilities'],
  ['capabilities', '--json'],
  ['capability-matrix', '--json'],
  ['stats'],
  ['kind-counts'],
  ['diff-impact', '--json'],
  ['diff-gate', '--json'],
];
const HEAVY_BENCH_COMMANDS: readonly (readonly string[])[] = [
  ['health', '--json'],
  ['dead', '--json', '--full'],
  ['isolated', '--json', '--full'],
  ['similar', '--json', '--full'],
  ['similar-files', '--json', '--full'],
  ['recent-duplicates', '--json', '--full'],
  ['doc-drift', '--json', '--full'],
  ['unused-params', '--json', '--full'],
  ['wrapper-candidates', '--json', '--full'],
  ['passthrough-candidates', '--json', '--full'],
  ['stale-abstractions', '--json', '--full'],
  ['incomplete-migration', '--json', '--full'],
  ['cleanup-plan', '--verify', '--json'],
  ['complexity-hotspots', '--json', '--full'],
];

function supportedLanguages(values: readonly string[]): SupportedLanguage[] {
  return values.filter((value): value is SupportedLanguage => SUPPORTED_LANGUAGES.has(value as SupportedLanguage));
}

// scip-query: ignore-extract — side-effect command lifecycle: option decoding,
// config/path resolution, reindex execution, and process-facing error handling
// are one CLI action.
export async function handleReindex(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  try {
    const languages = supportedLanguages(stringArrayOptionValue(opts, 'language'));
    const result = await reindex({
      projectRoot,
      languages: languages.length > 0 ? languages : config.languages,
      outputScip: paths.indexPath,
      outputDb: paths.dbPath,
      pnpmWorkspaces: booleanOptionValue(opts, 'pnpmWorkspaces') || config.indexer?.typescript?.pnpmWorkspaces,
      typescriptProjectMode: config.indexer?.typescript?.projectMode,
      typescriptProjects: config.indexer?.typescript?.projects,
      clojureConfigPath: config.indexer?.clojure?.configPath,
      skipIfUnchanged: !booleanOptionValue(opts, 'force'),
      allowPartial: booleanOptionValue(opts, 'allowPartial'),
      indexerConcurrency: numberOptionValue(opts, 'indexerConcurrency') ?? config.indexerConcurrency,
      trigger: { kind: 'manual-cli', detail: 'scip-query reindex' },
    });
    console.log(
      `${result.reused ? 'Reused' : 'Indexed'} ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleAugmentSources(): void {
  const projectRoot = resolveProjectRoot();
  const dbPath = resolveActiveDbPath(projectRoot);
  try {
    const result = augmentAuxiliaryDocuments({
      projectRoot,
      dbPath,
      onStatus: (message) => console.log(message),
    });
    console.log(`Scanned ${result.scanned} auxiliary source files; inserted ${result.inserted}.`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleAugmentVue(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const dbPath = resolveActiveDbPath(projectRoot);
  try {
    const result = augmentVueResolvedReferences({
      projectRoot,
      dbPath,
      tsconfig: stringOptionValue(opts, 'project') ?? 'frontend/tsconfig.scip.json',
      onStatus: (message) => console.log(message),
    });
    console.log(
      `Vue files: ${result.vueFiles}; resolved references: ${result.resolvedReferences}; inserted mentions: ${result.insertedMentions}.`,
    );
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleDiffImpactBatch(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  withDb((db) => {
    const files = JSON.parse(process.env['SCIP_QUERY_DIFF_IMPACT_FILES'] ?? '[]') as string[];
    const plan = queries.diffImpactPlan(db, { base: stringOptionValue(opts, 'base') });
    const result = queries.diffImpactPartial(db, files, plan.changedFiles, plan.changedRanges);
    console.log(JSON.stringify(result));
  });
}

export async function handleDiffImpact(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  try {
    const result = await runIsolatedDiffImpactReport({ base: stringOptionValue(opts, 'base') });
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('diff-impact', [], opts, result);
      return;
    }
    renderDiffImpactReport(result);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleHealthPhase(phase: unknown, rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const phases = String(phase)
    .split(',')
    .filter((entry) => entry.length > 0);
  withDb((db) => {
    const validPhases: Array<(typeof queries.HEALTH_PHASES)[number]> = [];
    for (const entry of phases) {
      if (!queries.HEALTH_PHASES.includes(entry as (typeof queries.HEALTH_PHASES)[number])) {
        console.error(`error: Unknown health phase: ${entry}`);
        process.exit(1);
      }
      validPhases.push(entry as (typeof queries.HEALTH_PHASES)[number]);
    }
    const phaseOpts = {
      scope: stringOptionValue(opts, 'scope'),
      full: booleanOptionValue(opts, 'full'),
    };
    const result =
      validPhases.length === 1
        ? queries.healthPhase(db, validPhases[0]!, phaseOpts)
        : healthPhases(db, validPhases, phaseOpts);
    console.log(JSON.stringify(result));
  });
}

export async function handleHealth(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  if (booleanOptionValue(opts, 'writeBaseline') || booleanOptionValue(opts, 'baseline')) {
    handleHealthBaseline(opts);
    return;
  }
  try {
    const report = await runIsolatedHealthReport({
      scope: stringOptionValue(opts, 'scope'),
      full: true,
      json: booleanOptionValue(opts, 'json'),
    });
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('health', [], opts, report);
      return;
    }
    renderHealthReport(report, false);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

interface BenchIndexRun {
  durationMs: number;
  result: 'rebuilt' | 'reused';
  languages: SupportedLanguage[];
  files?: number;
  symbols?: number;
}

interface BenchCommandRun {
  command: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  profilePath?: string;
}

interface BenchReport {
  projectRoot: string;
  repoFiles: number | null;
  sourceFiles: number | null;
  index: ReturnType<typeof statusStats>;
  coldIndex?: BenchIndexRun;
  warmIndex?: BenchIndexRun;
  commands: BenchCommandRun[];
}

export async function handleBench(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const timeoutMs = numberOptionValue(opts, 'timeoutMs') ?? BENCH_TIMEOUT_MS;
  const progress = booleanOptionValue(opts, 'progress');
  const profile = booleanOptionValue(opts, 'profile');
  const profileOut = stringOptionValue(opts, 'profileOut');
  const report: BenchReport = {
    projectRoot,
    ...repoFileCounts(projectRoot),
    index: statusStats(existsSync(resolveActiveDbPath(projectRoot))),
    commands: [],
  };

  if (booleanOptionValue(opts, 'coldIndex')) {
    reportBenchProgress(progress, 'cold index started');
    report.coldIndex = await measureColdIndex(projectRoot);
    reportBenchProgress(progress, `cold index finished ${report.coldIndex.durationMs}ms`);
    writeProfileEvent(
      {
        type: 'bench-index',
        phase: 'cold-index',
        projectRoot,
        durationMs: report.coldIndex.durationMs,
        result: report.coldIndex.result,
        files: report.coldIndex.files,
        symbols: report.coldIndex.symbols,
      },
      profileOut,
    );
    reportBenchProgress(progress, 'warm index started');
    report.warmIndex = await measureWarmIndex(projectRoot);
    reportBenchProgress(progress, `warm index finished ${report.warmIndex.durationMs}ms`);
    writeProfileEvent(
      {
        type: 'bench-index',
        phase: 'warm-index',
        projectRoot,
        durationMs: report.warmIndex.durationMs,
        result: report.warmIndex.result,
        files: report.warmIndex.files,
        symbols: report.warmIndex.symbols,
      },
      profileOut,
    );
    report.index = statusStats(existsSync(resolveActiveDbPath(projectRoot)));
  }

  for (const command of benchCommandMatrix(opts)) {
    report.commands.push(runBenchCommand(projectRoot, command, timeoutMs, { progress, profile, profileOut }));
  }

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('bench', [], opts, report);
    return;
  }
  renderBenchReport(report);
}

async function measureColdIndex(projectRoot: string): Promise<BenchIndexRun> {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  const cacheDir = dirname(paths.dbPath);
  const backupDir = `${cacheDir}.bench-backup-${Date.now()}`;
  let moved = false;

  if (existsSync(cacheDir)) {
    renameSync(cacheDir, backupDir);
    moved = true;
  }

  try {
    const result = await measureAsync(() =>
      reindex({
        projectRoot,
        languages: config.languages,
        outputScip: paths.indexPath,
        outputDb: paths.dbPath,
        pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
        typescriptProjectMode: config.indexer?.typescript?.projectMode,
        typescriptProjects: config.indexer?.typescript?.projects,
        clojureConfigPath: config.indexer?.clojure?.configPath,
        skipIfUnchanged: true,
        allowPartial: true,
        indexerConcurrency: config.indexerConcurrency,
        trigger: { kind: 'manual-cli', detail: 'scip-query bench --cold-index' },
        onStatus: () => {},
      }),
    );
    if (moved) rmSync(backupDir, { recursive: true, force: true });
    return {
      durationMs: result.durationMs,
      result: result.value.reused ? 'reused' : 'rebuilt',
      languages: result.value.languages,
      ...currentIndexCounts(projectRoot),
    };
  } catch (error) {
    if (moved && !existsSync(cacheDir)) renameSync(backupDir, cacheDir);
    throw error;
  }
}

// scip-query: ignore-similar - warm and cold benchmark paths stay parallel so timing comparisons stay honest.
async function measureWarmIndex(projectRoot: string): Promise<BenchIndexRun> {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  const result = await measureAsync(() =>
    reindex({
      projectRoot,
      languages: config.languages,
      outputScip: paths.indexPath,
      outputDb: paths.dbPath,
      pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
      typescriptProjectMode: config.indexer?.typescript?.projectMode,
      typescriptProjects: config.indexer?.typescript?.projects,
      clojureConfigPath: config.indexer?.clojure?.configPath,
      skipIfUnchanged: true,
      allowPartial: true,
      indexerConcurrency: config.indexerConcurrency,
      trigger: { kind: 'manual-cli', detail: 'scip-query bench warm index' },
      onStatus: () => {},
    }),
  );
  return {
    durationMs: result.durationMs,
    result: result.value.reused ? 'reused' : 'rebuilt',
    languages: result.value.languages,
    ...currentIndexCounts(projectRoot),
  };
}

async function measureAsync<T>(run: () => Promise<T>): Promise<{ durationMs: number; value: T }> {
  const started = performance.now();
  const value = await run();
  return { durationMs: Math.round(performance.now() - started), value };
}

function currentIndexCounts(projectRoot: string): { files?: number; symbols?: number } {
  if (!existsSync(resolveActiveDbPath(projectRoot))) return {};
  return withDb((db) => {
    const s = queries.stats(db);
    return { files: s.documents, symbols: s.symbols };
  });
}

function benchCommandMatrix(opts: Record<string, unknown>): string[][] {
  const explicit = stringArrayOptionValue(opts, 'command');
  if (explicit.length > 0) return explicit.map(splitBenchCommand).filter((command) => command.length > 0);
  return [
    ...DEFAULT_BENCH_COMMANDS.map((command) => [...command]),
    ...(booleanOptionValue(opts, 'includeHeavy') ? HEAVY_BENCH_COMMANDS.map((command) => [...command]) : []),
  ];
}

function splitBenchCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((part, index) => !(index === 0 && part === 'scip-query'));
}

interface BenchCommandOptions {
  progress?: boolean;
  profile?: boolean;
  profileOut?: string;
}

function runBenchCommand(
  projectRoot: string,
  command: readonly string[],
  timeoutMs: number,
  opts: BenchCommandOptions = {},
): BenchCommandRun {
  const label = `scip-query ${command.join(' ')}`;
  reportBenchProgress(opts.progress, `${label} started`);
  writeProfileEvent(
    {
      type: 'bench-command-start',
      command: label,
      projectRoot,
    },
    opts.profileOut,
  );
  const started = performance.now();
  const env = opts.profile ? benchProfileEnv(label, opts.profileOut) : process.env;
  const result = spawnSync(process.execPath, [...process.execArgv, process.argv[1] ?? '', ...command], {
    cwd: projectRoot,
    env,
    encoding: 'buffer',
    maxBuffer: BENCH_MAX_BUFFER,
    timeout: timeoutMs,
  });
  const durationMs = Math.round(performance.now() - started);
  const run = {
    command: label,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.name === 'ETIMEDOUT',
    stdoutBytes: result.stdout?.length ?? 0,
    stderrBytes: result.stderr?.length ?? 0,
    ...(opts.profileOut ? { profilePath: opts.profileOut } : {}),
  };
  reportBenchProgress(
    opts.progress,
    `${label} finished ${durationMs}ms exit=${run.exitCode ?? run.signal ?? 'unknown'}${run.timedOut ? ' timed-out' : ''}`,
  );
  writeProfileEvent(
    {
      type: 'bench-command-finish',
      command: label,
      projectRoot,
      durationMs,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      stdoutBytes: run.stdoutBytes,
      stderrBytes: run.stderrBytes,
    },
    opts.profileOut,
  );
  return run;
}

function reportBenchProgress(enabled: boolean | undefined, message: string): void {
  if (enabled) process.stderr.write(`[bench] ${message}\n`);
}

function benchProfileEnv(command: string, profileOut: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SCIP_QUERY_PROFILE: '1',
    SCIP_QUERY_PROFILE_COMMAND: command,
    ...(profileOut ? { SCIP_QUERY_PROFILE_OUT: profileOut } : {}),
  };
}

function repoFileCounts(projectRoot: string): { repoFiles: number | null; sourceFiles: number | null } {
  const result = spawnSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: BENCH_MAX_BUFFER,
  });
  if (result.status !== 0) return { repoFiles: null, sourceFiles: null };
  const files = result.stdout.split('\n').filter(Boolean);
  return {
    repoFiles: files.length,
    sourceFiles: files.filter((file) => SOURCE_EXTENSION_SET.has(extname(file).toLowerCase())).length,
  };
}

function renderBenchReport(report: BenchReport): void {
  console.log('scip-query bench');
  console.log(`Project: ${report.projectRoot}`);
  console.log(`Repo files: ${report.repoFiles ?? 'unknown'}; source-like files: ${report.sourceFiles ?? 'unknown'}`);
  if (report.index) {
    console.log(
      `Index: ${report.index.files} files, ${report.index.symbols} symbols, ${formatBytes(report.index.indexSizeBytes)}`,
    );
  }
  if (report.coldIndex) {
    renderBenchIndexRun('Cold index', report.coldIndex);
  }
  if (report.warmIndex) {
    renderBenchIndexRun('Warm index', report.warmIndex);
  }
  console.log('\nCommands:');
  for (const row of [...report.commands].sort((a, b) => b.durationMs - a.durationMs)) {
    const status = row.timedOut
      ? 'timeout'
      : row.exitCode === 0
        ? 'ok'
        : `exit ${row.exitCode ?? row.signal ?? 'unknown'}`;
    console.log(
      `  ${String(row.durationMs).padStart(7)}ms  ${status.padEnd(10)}  ${String(row.stdoutBytes).padStart(8)}B out  ${row.command}`,
    );
  }
}

function renderBenchIndexRun(label: string, run: BenchIndexRun): void {
  console.log(
    `${label}: ${run.durationMs}ms, ${run.result}, ${run.languages.join(', ')}${run.files ? `, ${run.files} files` : ''}${run.symbols ? `, ${run.symbols} symbols` : ''}`,
  );
}

// The ratchet: `--write-baseline` snapshots finding identities;
// `--baseline` exits 1 when findings appear that the snapshot lacks.
// "Don't get worse" is the objective CI gate — absolute scores are not.
function handleHealthBaseline(opts: Record<string, unknown>): void {
  const scope = stringOptionValue(opts, 'scope');
  withDb((db) => {
    if (booleanOptionValue(opts, 'writeBaseline')) {
      const result = queries.writeHealthBaseline(db, { scope });
      console.log(`Baseline written to ${result.path} (${result.findingCount} finding(s)).`);
      return;
    }
    const comparison = queries.checkHealthBaseline(db, { scope });
    if (comparison.fixedFindings.length > 0) {
      console.log(
        `${comparison.fixedFindings.length} finding(s) fixed since baseline. Re-run --write-baseline to ratchet down.`,
      );
    }
    if (comparison.newFindings.length === 0) {
      console.log(
        `OK: no new findings vs baseline (${comparison.baselineCount} baselined, ${comparison.current.length} current).`,
      );
      return;
    }
    console.log(`FAIL: ${comparison.newFindings.length} new finding(s) vs ${comparison.baselinePath}:`);
    for (const finding of comparison.newFindings) {
      console.log(`  + ${finding}`);
    }
    process.exitCode = 1;
  });
}

export function handleInstallSkills(): void {
  const result = installSkills();
  const total = result.installed.length + result.alreadyLinked.length;
  console.log(
    `\n${result.installed.length} installed, ${result.alreadyLinked.length} already linked, ${result.skipped.length} skipped.`,
  );
  if (total > 0) {
    console.log('Skills will be available in your next Claude Code / Codex session.');
  }
}

export function handleSetupHooks(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = installProjectAgentHooks(projectRoot);
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('setup-hooks', [], opts, result);
    return;
  }

  for (const target of result.installed) console.log(`  done: ${target}`);
  for (const target of result.updated) console.log(`  update: ${target}`);
  for (const target of result.unchanged) console.log(`  ok:   ${target} (already configured)`);
  for (const target of result.removed) console.log(`  remove: legacy user-level ${target}`);
  for (const skip of result.skipped) console.log(`  skip: ${skip.target} — ${skip.reason}`);

  const total = result.installed.length + result.updated.length + result.unchanged.length;
  if (total > 0) {
    console.log('\nProject-local scip-query hooks are configured for this repository.');
    console.log('Review new or changed hooks in Codex/Claude Code with /hooks before they run.');
  } else {
    console.log('\nNo project-local hook config was written.');
  }
}

export function handleCheckDeps(): void {
  let hasProblems = false;
  if (isScipInstalled()) {
    console.log('scip CLI: installed');
  } else {
    printScipInstallInstructions();
    hasProblems = true;
  }

  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const readiness = getProjectReadiness(projectRoot, config);
  if (readiness.languages.length === 0) {
    console.log('\nNo supported project languages detected in the current directory.');
    process.exitCode = hasProblems ? 1 : 0;
    return;
  }

  console.log(`\nDetected languages: ${readiness.languages.join(', ')}`);
  console.log('\nIndexer readiness:');
  for (const status of readiness.indexers) {
    const prefix = status.runnable ? '  OK' : status.installed ? '  WARN' : '  MISSING';
    const resolved = status.resolvedBinary ? ` (${status.resolvedBinary})` : '';
    console.log(`${prefix} ${status.language}: ${status.binaryLabel}${resolved}`);
    if (status.note) console.log(`    ${status.note}`);
    if (!status.installed && status.installUrl) console.log(`    install: ${status.installUrl}`);
    if (!status.runnable) hasProblems = true;
  }

  if (readiness.semantic) {
    const status = readiness.semantic;
    const prefix = status.available ? '  OK' : status.dependencyAvailable ? '  WARN' : '  MISSING';
    const configPath =
      status.tsconfigPaths && status.tsconfigPaths.length > 1
        ? ` (${status.tsconfigPaths.length} tsconfigs)`
        : status.tsconfigPath
          ? ` (${status.tsconfigPath})`
          : '';
    console.log('\nSemantic provider readiness:');
    console.log(`${prefix} typescript: ts-morph${configPath}`);
    if (status.reason) console.log(`    ${status.reason}; semantic checks will fall back to SCIP/source evidence`);
  }

  process.exitCode = hasProblems ? 1 : 0;
}

export function handleCapabilities(rawOpts: unknown): void {
  renderCapabilities(rawOpts, 'capabilities');
}

export function handleCapabilityMatrix(rawOpts: unknown): void {
  renderCapabilities(rawOpts, 'capability-matrix');
}

function renderCapabilities(rawOpts: unknown, command: 'capabilities' | 'capability-matrix'): void {
  const opts = commandOptions(rawOpts);
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();
  const readiness = getProjectReadiness(projectRoot, config);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  const report = getProjectCapabilities(readiness, {
    hasIndexedGraph: existsSync(dbPath) && freshness.state !== 'missing',
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope(command, [], opts, report);
    return;
  }
  renderCapabilityReport(report);
}

export function handleInit(): void {
  const projectRoot = resolveProjectRoot();
  const languages = detectLanguages(projectRoot);
  const configPath = initProjectConfig(projectRoot, languages);
  console.log(`Config written to ${configPath}`);
  console.log(`Detected languages: ${languages.join(', ') || '(none)'}`);
}

// scip-query: ignore-similar — shares CLI option/project/json scaffolding with
// capability rendering, but validates config diagnostics instead of capability
// evidence.
export function handleConfigValidate(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const diagnostics = validateProjectConfig(config, { projectRoot });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('config-validate', [], opts, { diagnostics });
  } else if (diagnostics.length === 0) {
    console.log('Config OK.');
  } else {
    for (const diagnostic of diagnostics) {
      console.log(`${diagnostic.level.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.level === 'error')) process.exitCode = 1;
}

export function handleSuppress(id: unknown, rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const reason = stringOptionValue(opts, 'reason');
  if (!reason || reason.trim() === '') {
    console.error('error: suppress requires --reason <text>.');
    process.exitCode = 1;
    return;
  }
  try {
    const result = addFindingSuppression(resolveProjectRoot(), {
      id: String(id),
      check: stringOptionValue(opts, 'check'),
      file: stringOptionValue(opts, 'file'),
      reason,
      expiresAt: stringOptionValue(opts, 'expiresAt'),
    });
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('suppress', [String(id)], opts, result);
      return;
    }
    console.log(`Suppression added to ${result.path} (${result.suppressionCount} total).`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

export function handleDoctor(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const { report, hasIndexerProblems, hasErrors } = buildProjectDiagnosticReport('doctor');
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('doctor', [], opts, report);
  } else {
    renderDoctorReport(report, hasIndexerProblems);
  }
  process.exitCode = hasErrors ? 1 : 0;
}

// scip-query: ignore-similar - doctor/status share readiness collection while rendering different command surfaces.
function buildProjectDiagnosticReport(command: 'doctor' | 'status'): {
  report: {
    command: 'doctor' | 'status';
    projectRoot: string;
    dbPath: string;
    configuredDbPath: string;
    exists: boolean;
    configDiagnostics: ReturnType<typeof validateProjectConfig>;
    readiness: ReturnType<typeof getProjectReadiness>;
    freshness: ReturnType<typeof getIndexFreshness>;
    capabilities: ReturnType<typeof getProjectCapabilities>;
    ok: boolean;
  };
  hasIndexerProblems: boolean;
  hasErrors: boolean;
} {
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();
  const configDiagnostics = validateProjectConfig(config, { projectRoot });
  const readiness = getProjectReadiness(projectRoot, config);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  const exists = existsSync(dbPath);
  const capabilities = getProjectCapabilities(readiness, {
    hasIndexedGraph: exists && freshness.state !== 'missing',
  });
  const hasIndexerProblems = readiness.indexers.some((indexer) => !indexer.runnable);
  const hasErrors =
    configDiagnostics.some((diagnostic) => diagnostic.level === 'error') ||
    hasIndexerProblems ||
    freshness.state === 'missing' ||
    freshness.state === 'stale';
  return {
    report: {
      command,
      projectRoot,
      dbPath,
      configuredDbPath: paths.dbPath,
      exists,
      configDiagnostics,
      readiness,
      freshness,
      capabilities,
      ok: !hasErrors,
    },
    hasIndexerProblems,
    hasErrors,
  };
}

export function handleSetupAgent(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = setupAgent(projectRoot, { gitHook: booleanOptionValue(opts, 'gitHook') });
  for (const target of result.written) console.log(`  done: ${target}`);
  for (const target of result.unchanged) console.log(`  ok:   ${target} (already wired)`);
  for (const skip of result.skipped) console.log(`  skip: ${skip.target} — ${skip.reason}`);
  console.log('\nAgents reading this project now know to route through the scip-query skills and gate their diffs.');
  console.log('Keep the index fresh (`scip-query reindex` or `scip-query watch`) so the gate sees current code.');
}

export async function handleSetup(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  try {
    const report = await runProjectSetup({ gitHook: booleanOptionValue(opts, 'gitHook') });
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('setup', [], opts, report);
    } else {
      renderProjectSetupReport(report);
    }
    process.exitCode = report.verdict === 'blocked' ? 1 : 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleSetupCi(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = setupCiWorkflow(projectRoot, {
    force: booleanOptionValue(opts, 'force'),
    dryRun: booleanOptionValue(opts, 'dryRun'),
  });
  if (booleanOptionValue(opts, 'dryRun')) {
    console.log(result.content);
    return;
  }
  if (result.skipped) {
    console.log(`skip: ${result.path} — ${result.reason}`);
    return;
  }
  console.log(`done: ${result.path}`);
}

// scip-query: ignore-extract — long-running watch command lifecycle: option
// overrides, watcher callbacks, start/stop behavior, and SIGINT handling are
// one process action.
export function handleWatch(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const debounce = numberOptionValue(opts, 'debounce');
  const cooldown = numberOptionValue(opts, 'cooldown');
  const gitPoll = numberOptionValue(opts, 'gitPoll');
  if (debounce) (config.watch ??= {}).debounceMs = debounce;
  if (cooldown) (config.watch ??= {}).cooldownMs = cooldown;
  if (gitPoll) (config.watch ??= {}).gitPollMs = gitPoll;

  const watcher = new Watcher({
    projectRoot,
    config,
    languages: config.languages,
    onStatus: (status) => {
      process.stdout.write(`\r\x1b[K${formatStatus(status)}`);
    },
    onReindexComplete: (durationMs) => {
      console.log(`\nReindex complete in ${(durationMs / 1000).toFixed(1)}s`);
    },
    onError: (err) => {
      console.error(`\nWatch error: ${err.message}`);
    },
  });

  console.log(`Watching ${projectRoot}`);
  console.log(
    `Debounce: ${config.watch?.debounceMs ?? 30000}ms | Cooldown: ${config.watch?.cooldownMs ?? 60000}ms | Git poll: ${config.watch?.gitPollMs ?? 2000}ms`,
  );
  console.log('Press Ctrl+C to stop.\n');
  watcher.start();

  process.on('SIGINT', () => {
    watcher.stop();
    console.log('\nStopped.');
    process.exit(0);
  });
}

export function handleStatus(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const { report } = buildProjectDiagnosticReport('status');
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('status', [], opts, { ...report, stats: statusStats(report.exists) });
    return;
  }
  renderStatusReport(report, { capabilities: booleanOptionValue(opts, 'capabilities') });
}

function renderDoctorReport(
  report: ReturnType<typeof buildProjectDiagnosticReport>['report'],
  hasIndexerProblems: boolean,
): void {
  console.log(`Doctor: ${report.ok ? 'OK' : 'needs attention'}`);
  for (const diagnostic of report.configDiagnostics) {
    console.log(`  ${diagnostic.level.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}`);
  }
  if (hasIndexerProblems) {
    for (const indexer of report.readiness.indexers.filter((status) => !status.runnable)) {
      console.log(`  MISSING ${indexer.language}: ${indexer.note ?? indexer.binaryLabel}`);
    }
  }
  console.log(
    `  Freshness: ${report.freshness.state}${report.freshness.remedy ? ` (${report.freshness.remedy})` : ''}`,
  );
  renderCapabilityReport(report.capabilities);
}

function renderStatusReport(
  report: ReturnType<typeof buildProjectDiagnosticReport>['report'],
  opts: { capabilities: boolean },
): void {
  console.log(`Project:  ${report.projectRoot}`);
  console.log(`DB path:  ${report.dbPath}`);
  if (report.dbPath !== report.configuredDbPath) {
    console.log(`Config:   ${report.configuredDbPath} (fallback to project root index.db)`);
  }
  if (report.readiness.semantic) {
    const semanticState = report.readiness.semantic.available ? 'available' : 'fallback';
    const suffix =
      report.readiness.semantic.tsconfigPaths && report.readiness.semantic.tsconfigPaths.length > 1
        ? ` (${report.readiness.semantic.tsconfigPaths.length} tsconfigs)`
        : report.readiness.semantic.tsconfigPath
          ? ` (${report.readiness.semantic.tsconfigPath})`
          : '';
    console.log(`TS sem:   ${semanticState}${suffix}`);
    if (report.readiness.semantic.reason) console.log(`TS note:  ${report.readiness.semantic.reason}`);
  }
  console.log(`Exists:   ${report.exists ? 'yes' : 'no'}`);
  console.log(`Fresh:    ${report.freshness.state}${report.freshness.remedy ? ` (${report.freshness.remedy})` : ''}`);
  if (report.freshness.lastRefresh) {
    console.log(`Refresh:  ${formatLastRefresh(report.freshness.lastRefresh)}`);
  }

  renderStatusStats(report.exists);
  if (opts.capabilities) {
    console.log('');
    renderCapabilityReport(report.capabilities);
  }
}

function formatLastRefresh(refresh: NonNullable<ReturnType<typeof getIndexFreshness>['lastRefresh']>): string {
  const seconds = (refresh.durationMs / 1000).toFixed(1);
  const detail = refresh.trigger.detail ? ` (${refresh.trigger.detail})` : '';
  const error = refresh.error ? `: ${refresh.error}` : '';
  return `${refresh.result} by ${refresh.trigger.kind}${detail} in ${seconds}s at ${refresh.completedAt}${error}`;
}

function statusStats(exists: boolean):
  | {
      symbols: number;
      files: number;
      indexSizeBytes: number;
      lastBuilt?: string;
    }
  | undefined {
  if (!exists) return undefined;
  return withDb((db) => {
    const s = queries.stats(db);
    return {
      symbols: s.symbols,
      files: s.documents,
      indexSizeBytes: s.indexSizeBytes,
      lastBuilt: s.lastBuilt?.toISOString(),
    };
  });
}

function renderStatusStats(exists: boolean): void {
  if (!exists) return;
  withDb((db) => {
    const s = queries.stats(db);
    console.log(`Symbols:  ${s.symbols}`);
    console.log(`Files:    ${s.documents}`);
    console.log(`Size:     ${formatBytes(s.indexSizeBytes)}`);
    if (s.lastBuilt) {
      const ago = Math.round((Date.now() - s.lastBuilt.getTime()) / 1000);
      console.log(`Built:    ${ago}s ago`);
    }
  });
}

function renderCapabilityReport(report: ReturnType<typeof getProjectCapabilities>): void {
  console.log(`Capabilities for: ${report.languages.join(', ') || '(no detected languages)'}`);
  for (const capability of report.capabilities) {
    console.log(`  ${capability.status.toUpperCase().padEnd(11)} ${capability.label} [${capability.evidence}]`);
    console.log(`             ${capability.reason}`);
  }
  if (report.matrix.length === 0) return;

  console.log('\nLanguage matrix:');
  for (const row of report.matrix) {
    console.log(`  ${row.language}`);
    for (const capability of [row.indexing, row.sourceFacts, row.semantic, row.detectors, row.cleanupVerification]) {
      console.log(`    ${capability.status.toUpperCase().padEnd(11)} ${capability.label}`);
      console.log(`               ${capability.reason}`);
    }
  }
}

export { collect };
