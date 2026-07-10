import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { IndexedDefinition, SupportedLanguage } from '../../domain/types.js';
import * as queries from '../../queries/index.js';
import {
  augmentAuxiliaryDocuments,
  augmentVueResolvedReferences,
  detectLanguages,
  reindex,
} from '../../reindex/index.js';
import {
  formatAffectedSetShadowStatus,
  readAffectedSetShadowStatus,
  type AffectedSetShadowStatus,
} from '../../reindex/affected-shadow.js';
import { inspectSqliteGeneration, type SqliteGenerationInspection } from '../../reindex/sqlite-generation-store.js';
import {
  loadProjectConfig,
  resolveIndexStoragePaths,
  resolveWatchConfig,
  initProjectConfig,
  validateProjectConfig,
  SUPPORTED_LANGUAGES,
} from '../config.js';
import { writeSuppressionFile } from '../../storage/suppression-store.js';
import { LEDGER_DIR, LEDGER_FILENAME, readOutcomeEvents } from '../../storage/outcome-events.js';
import { computeEffectiveness, parseSinceMs } from '../../queries/health/effectiveness.js';
import { getIndexFreshness } from '../index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from '../project-readiness.js';
import { Watcher } from '../watch.js';
import {
  acquireWatchProcessLock,
  ensureWatchService,
  inspectWatchService,
  stopWatchService,
  WATCH_LOCK_FILE,
  type WatchServiceInspection,
} from '../watch-service.js';
import { setupAgent } from '../agent-setup.js';
import { installProjectAgentHooks } from '../agent-hooks.js';
import {
  planGuidedProjectSetup,
  renderProjectSetupReport,
  runProjectSetup,
  type ProjectSetupGuidedAction,
  type ProjectSetupGuidedActionId,
  type ProjectSetupGuidedFiles,
  type ProjectSetupOptions,
} from '../project-setup.js';
import { setupCiWorkflow } from '../setup-ci.js';
import { installSkills, isScipInstalled, printScipInstallInstructions } from '../setup.js';
import { runUninstall } from '../uninstall.js';
import { ALL_SOURCE_EXTENSIONS } from '../../source/source-fileset.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { createTsMorphProvider } from '../../semantic/typescript/ts-morph-provider.js';
import {
  compareTypeScriptReferenceProviders,
  createTsServerProvider,
} from '../../semantic/typescript/tsserver-provider.js';
import { isTypeScriptLike } from '../../semantic/typescript/source-kinds.js';
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
  cliVersion,
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
const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
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
  return values.filter((value): value is SupportedLanguage => SUPPORTED_LANGUAGE_SET.has(value as SupportedLanguage));
}

// scip-query: ignore-extract — side-effect command lifecycle: option decoding,
// config/path resolution, reindex execution, and process-facing error handling
// are one CLI action.
export async function handleReindex(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
  const json = booleanOptionValue(opts, 'json');
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
      skipAutoInstall: process.env['SCIP_QUERY_SKIP_AUTO_INSTALL'] === '1',
      indexerConcurrency: numberOptionValue(opts, 'indexerConcurrency') ?? config.indexerConcurrency,
      trigger: { kind: 'manual-cli', detail: 'scip-query reindex' },
      // --json output must be pure JSON on stdout, matching every other
      // --json command; the same "onStatus: () => {}" silencing is already
      // used for reindex() calls from `bench` (see measureColdIndex /
      // measureWarmIndex below), which has the same "reindex has progress
      // logging but this caller needs machine-readable stdout" shape.
      ...(json ? { onStatus: () => {} } : {}),
    });
    if (json) {
      printJsonEnvelope('reindex', [], opts, result);
      return;
    }
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
      full: booleanOptionValue(opts, 'full'),
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

interface TypeScriptSemanticCompareReport {
  projectRoot: string;
  selection: {
    scope: string | null;
    full: boolean;
    limit: number | null;
    maxMismatchDetails: number;
    totalTypeScriptDefinitions: number;
    scopedDefinitions: number;
    comparedDefinitions: number;
  };
  baseline: {
    provider: 'ts-morph';
    createMs: number;
    availability: unknown;
  };
  candidate: {
    provider: 'tsserver';
    createMs: number;
    availability: unknown;
  };
  comparison: ReturnType<typeof compareTypeScriptReferenceProviders>;
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

export function handleTypeScriptSemanticCompare(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  withDb((db) => {
    const projectRoot = db.config.projectRoot;
    const scope = stringOptionValue(opts, 'scope') ?? null;
    const full = booleanOptionValue(opts, 'full');
    const limit = numberOptionValue(opts, 'limit') ?? 200;
    const maxMismatchDetails = Math.max(0, numberOptionValue(opts, 'maxMismatches') ?? 10);
    const definitions = getAllDefinitions(db)
      .filter((definition) => isTypeScriptLike(definition.relativePath))
      .filter((definition) => !db.isIgnored(definition.relativePath))
      .sort(compareDefinitionsForCalibration);
    const scopedDefinitions = scope
      ? definitions.filter((definition) => definition.relativePath.includes(scope))
      : definitions;
    const selectedDefinitions = full ? scopedDefinitions : scopedDefinitions.slice(0, limit);

    const baselineStart = performance.now();
    const baseline = createTsMorphProvider(db);
    const baselineCreateMs = Number((performance.now() - baselineStart).toFixed(3));
    const candidateStart = performance.now();
    const candidate = createTsServerProvider(db);
    const candidateCreateMs = Number((performance.now() - candidateStart).toFixed(3));
    const comparison = compareTypeScriptReferenceProviders(selectedDefinitions, baseline, candidate);
    const report: TypeScriptSemanticCompareReport = {
      projectRoot,
      selection: {
        scope,
        full,
        limit: full ? null : limit,
        maxMismatchDetails,
        totalTypeScriptDefinitions: definitions.length,
        scopedDefinitions: scopedDefinitions.length,
        comparedDefinitions: selectedDefinitions.length,
      },
      baseline: {
        provider: 'ts-morph',
        createMs: baselineCreateMs,
        availability: baseline.availability(),
      },
      candidate: {
        provider: 'tsserver',
        createMs: candidateCreateMs,
        availability: candidate.availability(),
      },
      comparison: {
        ...comparison,
        mismatches: comparison.mismatches.slice(0, maxMismatchDetails),
      },
    };

    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('typescript-semantic-compare', [], opts, report);
      return;
    }
    renderTypeScriptSemanticCompareReport(report);
  });
}

async function measureColdIndex(projectRoot: string): Promise<BenchIndexRun> {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
  const cacheDir = dirname(paths.dbPath);
  const backupDir = `${cacheDir}.bench-backup-${Date.now()}`;
  restoreBenchIndexCache(cacheDir);
  const moved = moveBenchIndexCacheAside(cacheDir, backupDir);

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
    finishBenchIndexCacheRestore(cacheDir, backupDir, moved, 'discard-backup');
    return {
      durationMs: result.durationMs,
      result: result.value.reused ? 'reused' : 'rebuilt',
      languages: result.value.languages,
      ...currentIndexCounts(projectRoot),
    };
  } catch (error) {
    finishBenchIndexCacheRestore(cacheDir, backupDir, moved, 'restore-backup');
    throw error;
  }
}

interface BenchRestoreFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, opts: { recursive?: boolean; force?: boolean }): void;
  unlinkSync(path: string): void;
}

const NODE_BENCH_RESTORE_FS: BenchRestoreFs = {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  unlinkSync,
};

interface BenchRestoreMarker {
  originalPath: string;
  backupPath: string;
}

export function benchRestoreMarkerPath(cacheDir: string): string {
  return join(dirname(cacheDir), 'bench-restore.json');
}

export function restoreBenchIndexCache(cacheDir: string, fs: BenchRestoreFs = NODE_BENCH_RESTORE_FS): boolean {
  const markerPath = benchRestoreMarkerPath(cacheDir);
  if (!fs.existsSync(markerPath)) return false;
  const marker = parseBenchRestoreMarker(fs.readFileSync(markerPath, 'utf8'));
  if (marker && !fs.existsSync(marker.originalPath) && fs.existsSync(marker.backupPath)) {
    fs.renameSync(marker.backupPath, marker.originalPath);
  }
  fs.unlinkSync(markerPath);
  return true;
}

export function moveBenchIndexCacheAside(
  cacheDir: string,
  backupDir: string,
  fs: BenchRestoreFs = NODE_BENCH_RESTORE_FS,
): boolean {
  if (!fs.existsSync(cacheDir)) return false;
  fs.writeFileSync(benchRestoreMarkerPath(cacheDir), JSON.stringify({ originalPath: cacheDir, backupPath: backupDir }));
  fs.renameSync(cacheDir, backupDir);
  return true;
}

export function finishBenchIndexCacheRestore(
  cacheDir: string,
  backupDir: string,
  moved: boolean,
  mode: 'discard-backup' | 'restore-backup',
  fs: BenchRestoreFs = NODE_BENCH_RESTORE_FS,
): void {
  if (moved && mode === 'restore-backup' && !fs.existsSync(cacheDir) && fs.existsSync(backupDir)) {
    fs.renameSync(backupDir, cacheDir);
  } else if (moved && mode === 'discard-backup') {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  const markerPath = benchRestoreMarkerPath(cacheDir);
  if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
}

function parseBenchRestoreMarker(payload: string): BenchRestoreMarker | null {
  try {
    const raw = JSON.parse(payload) as Partial<BenchRestoreMarker>;
    return typeof raw.originalPath === 'string' && typeof raw.backupPath === 'string'
      ? { originalPath: raw.originalPath, backupPath: raw.backupPath }
      : null;
  } catch {
    return null;
  }
}

// scip-query: ignore-similar - warm and cold benchmark paths stay parallel so timing comparisons stay honest.
async function measureWarmIndex(projectRoot: string): Promise<BenchIndexRun> {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
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
  const env = {
    ...(opts.profile ? benchProfileEnv(label, opts.profileOut) : process.env),
    SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
  };
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
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.error?.name === 'ETIMEDOUT',
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

function renderTypeScriptSemanticCompareReport(report: TypeScriptSemanticCompareReport): void {
  console.log('TypeScript semantic provider comparison');
  console.log(`Project: ${report.projectRoot}`);
  console.log(
    `Definitions: ${report.selection.comparedDefinitions}/${report.selection.scopedDefinitions} compared` +
      (report.selection.scope ? `, scope ${report.selection.scope}` : ''),
  );
  console.log(
    `ts-morph: create ${report.baseline.createMs}ms, refs ${report.comparison.baselineMs}ms, refs ${report.comparison.baselineReferenceCount}`,
  );
  console.log(
    `tsserver: create ${report.candidate.createMs}ms, refs ${report.comparison.candidateMs}ms, refs ${report.comparison.candidateReferenceCount}`,
  );
  console.log(
    `Matches: ${report.comparison.matches}; mismatches: ${report.comparison.mismatchCount}; missing refs: ${report.comparison.missingReferenceCount}; extra refs: ${report.comparison.extraReferenceCount}`,
  );
  if (report.comparison.mismatches.length === 0) return;
  console.log('\nMismatch samples:');
  for (const mismatch of report.comparison.mismatches) {
    console.log(`  ${mismatch.symbol}`);
    console.log(`    missing=${mismatch.missing.length} extra=${mismatch.extra.length}`);
  }
}

function compareDefinitionsForCalibration(left: IndexedDefinition, right: IndexedDefinition): number {
  return (
    left.relativePath.localeCompare(right.relativePath) ||
    left.startLine - right.startLine ||
    (left.startChar ?? 0) - (right.startChar ?? 0) ||
    left.symbolId - right.symbolId
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
    `\n${result.installed.length} installed, ${result.alreadyLinked.length} already linked, ${result.pruned.length} pruned, ${result.skipped.length} skipped.`,
  );
  if (total > 0) {
    console.log('Skills will be available in your next Claude Code / Codex session.');
  }
}

export function handleSetupHooks(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = installProjectAgentHooks(projectRoot, {
    shared: booleanOptionValue(opts, 'shared'),
    remove: booleanOptionValue(opts, 'remove'),
    force: booleanOptionValue(opts, 'force'),
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('setup-hooks', [], opts, result);
    return;
  }

  for (const target of result.installed) console.log(`  done: ${target}`);
  for (const target of result.updated) console.log(`  update: ${target}`);
  for (const target of result.unchanged) console.log(`  ok:   ${target} (already configured)`);
  for (const target of result.removed) console.log(`  remove: ${target}`);
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

  const semanticEntries = semanticReadinessEntries(readiness);
  if (semanticEntries.length > 0) {
    console.log('\nSemantic provider readiness:');
  }
  for (const status of semanticEntries) {
    const prefix = status.available ? '  OK' : status.dependencyAvailable ? '  WARN' : '  MISSING';
    console.log(`${prefix} ${status.language}: ${semanticProviderLabel(status)}${semanticDetailSuffix(status)}`);
    if (status.reason) console.log(`    ${status.reason}`);
  }

  process.exitCode = hasProblems ? 1 : 0;
}

export function handleCapabilities(rawOpts: unknown): void {
  renderCapabilities(rawOpts, 'capabilities');
}

export function handleCapabilityMatrix(rawOpts: unknown): void {
  if (!booleanOptionValue(commandOptions(rawOpts), 'json')) {
    console.error('note: capability-matrix is deprecated; use "scip-query capabilities --matrix".');
  }
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
    const result = writeSuppressionFile(resolveProjectRoot(), {
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
    console.log(`Suppression written to ${result.path}.`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

export function handleEffectiveness(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const now = Date.now();
  const sinceRaw = stringOptionValue(opts, 'since');
  let sinceMs: number | undefined;
  if (sinceRaw) {
    const parsed = parseSinceMs(sinceRaw, now);
    if (parsed === null) {
      console.error(`error: could not parse --since "${sinceRaw}" (use 30d, 12w, or an ISO date).`);
      process.exitCode = 1;
      return;
    }
    sinceMs = parsed;
  }

  const projectRoot = resolveProjectRoot();
  const events = readOutcomeEvents(projectRoot);
  const report = computeEffectiveness(events, { sinceMs, check: stringOptionValue(opts, 'check') });

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('effectiveness', [], opts, report);
    return;
  }

  if (report.checks.length === 0) {
    console.log(
      events.length === 0
        ? `No outcome events recorded yet (${join(LEDGER_DIR, LEDGER_FILENAME)} is missing or empty). Events accrue as the diff-gate stop hook runs; commit the ledger so history is shared.`
        : 'No findings match the requested window/check.',
    );
    return;
  }

  const header = ['check', 'caught', 'fixed', 'suppressed', 'open', 'moved', 'precision', 'median-days-to-fix'];
  const rows = report.checks.map((entry) => [
    entry.check,
    String(entry.caught),
    String(entry.fixed),
    String(entry.suppressed),
    String(entry.open),
    String(entry.moved),
    entry.precision === null ? '-' : `${Math.round(entry.precision * 100)}%`,
    entry.medianDaysToFix === null ? '-' : entry.medianDaysToFix.toFixed(1),
  ]);
  const widths = header.map((label, column) => Math.max(label.length, ...rows.map((row) => row[column].length)));
  const formatRow = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  console.log(formatRow(header));
  for (const row of rows) console.log(formatRow(row));

  const totalFixed = report.checks.reduce((sum, entry) => sum + entry.fixed, 0);
  const totalSuppressed = report.checks.reduce((sum, entry) => sum + entry.suppressed, 0);
  const concluded = totalFixed + totalSuppressed;
  if (concluded > 0) {
    console.log(
      `\n${totalFixed} finding(s) fixed by code changes, ${totalSuppressed} suppressed — overall precision ${Math.round(
        (totalFixed / concluded) * 100,
      )}%.`,
    );
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
  const hasAttention =
    configDiagnostics.some((diagnostic) => diagnostic.level === 'error') ||
    hasIndexerProblems ||
    freshness.state === 'missing' ||
    freshness.state === 'stale';
  const hasErrors =
    configDiagnostics.some((diagnostic) => diagnostic.level === 'error') ||
    hasIndexerProblems ||
    freshness.state === 'missing';
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
      ok: !hasAttention,
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
    let setupOptions: ProjectSetupOptions = {
      gitHook: booleanOptionValue(opts, 'gitHook'),
      noHooks: booleanOptionValue(opts, 'noHooks') || opts['hooks'] === false,
      dossierDir: stringOptionValue(opts, 'dossierDir'),
    };
    if (booleanOptionValue(opts, 'guided')) {
      setupOptions = await guidedProjectSetupOptions(setupOptions, { json: booleanOptionValue(opts, 'json') });
    }
    const report = await runProjectSetup(setupOptions);
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

async function guidedProjectSetupOptions(
  base: ProjectSetupOptions,
  opts: { json: boolean },
): Promise<ProjectSetupOptions> {
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();
  const readiness = getProjectReadiness(projectRoot, config);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  const capabilities = getProjectCapabilities(readiness, {
    hasIndexedGraph: existsSync(dbPath) && freshness.state !== 'missing',
  });
  const plan = planGuidedProjectSetup({
    files: guidedProjectSetupFiles(projectRoot),
    readiness,
    capabilities,
  });
  const selected =
    opts.json || !process.stdin.isTTY
      ? recommendedGuidedActions(plan.actions)
      : await promptGuidedActions(plan.actions);
  const agentActionSelected = selected.has('create-agent-guidance') || selected.has('update-agent-guidance');
  return {
    ...base,
    noHooks:
      base.noHooks ||
      (plan.actions.some((action) => action.id === 'install-project-hooks') && !selected.has('install-project-hooks')),
    noAgentGuidance: !agentActionSelected,
  };
}

function guidedProjectSetupFiles(projectRoot: string): ProjectSetupGuidedFiles {
  return {
    agentsMd: existsSync(join(projectRoot, 'AGENTS.md')),
    claudeMd: existsSync(join(projectRoot, 'CLAUDE.md')),
    codexHooks: existsSync(join(projectRoot, '.codex', 'hooks.json')),
    claudeSettings: existsSync(join(projectRoot, '.claude', 'settings.json')),
  };
}

function recommendedGuidedActions(actions: readonly ProjectSetupGuidedAction[]): Set<ProjectSetupGuidedActionId> {
  return new Set(actions.filter((action) => action.recommended).map((action) => action.id));
}

async function promptGuidedActions(
  actions: readonly ProjectSetupGuidedAction[],
): Promise<Set<ProjectSetupGuidedActionId>> {
  if (actions.length === 0) return new Set();
  console.log('Guided setup choices:');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = new Set<ProjectSetupGuidedActionId>();
    for (const action of actions) {
      console.log(`- ${action.label}: ${action.reason}`);
      if (await promptYesNo(rl, action)) selected.add(action.id);
    }
    return selected;
  } finally {
    rl.close();
  }
}

async function promptYesNo(rl: ReturnType<typeof createInterface>, action: ProjectSetupGuidedAction): Promise<boolean> {
  const suffix = action.recommended ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`  Run ${action.command ?? action.label}? [${suffix}] `)).trim().toLowerCase();
  if (answer.length === 0) return action.recommended;
  return answer === 'y' || answer === 'yes';
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

export function handleUninstall(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  if (booleanOptionValue(opts, 'global') && booleanOptionValue(opts, 'project')) {
    console.error('error: choose either --global or --project, not both.');
    process.exitCode = 1;
    return;
  }
  const report = runUninstall({
    projectRoot: resolveProjectRoot(),
    global: booleanOptionValue(opts, 'global'),
    project: booleanOptionValue(opts, 'project'),
    dryRun: booleanOptionValue(opts, 'dryRun'),
  });

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('uninstall', [], opts, report);
    return;
  }

  const prefix = report.dryRun ? 'would ' : '';
  if (report.global) {
    for (const target of report.global.removed) console.log(`  ${prefix}remove: ${target}`);
    for (const target of report.global.left) console.log(`  left: ${target}`);
    for (const skip of report.global.skipped) console.log(`  skip: ${skip}`);
  }
  if (report.project) {
    for (const target of report.project.hooks.removed) console.log(`  ${prefix}remove: ${target}`);
    for (const target of report.project.agentSetup.removed) console.log(`  ${prefix}remove: ${target}`);
    for (const target of report.project.agentSetup.unchanged) console.log(`  ok: ${target} (no managed block)`);
    for (const skip of report.project.hooks.skipped) console.log(`  skip: ${skip.target} — ${skip.reason}`);
    for (const skip of report.project.agentSetup.skipped) console.log(`  skip: ${skip.target} — ${skip.reason}`);
    for (const target of report.project.left) console.log(`  left: ${target}`);
  }

  const removed =
    (report.global?.removed.length ?? 0) +
    (report.project?.hooks.removed.length ?? 0) +
    (report.project?.agentSetup.removed.length ?? 0);
  if (removed === 0) {
    console.log(report.dryRun ? 'No scip-query-owned files would be removed.' : 'No scip-query-owned files removed.');
  }
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
  const idleTimeout = numberOptionValue(opts, 'idleTimeout');
  const daemon = booleanOptionValue(opts, 'daemon');
  const status = booleanOptionValue(opts, 'status');
  const stop = booleanOptionValue(opts, 'stop');
  const json = booleanOptionValue(opts, 'json');
  const lifecycleModes = [daemon, status, stop].filter(Boolean).length;
  if (lifecycleModes > 1) {
    console.error('error: choose only one of --daemon, --status, or --stop.');
    process.exitCode = 1;
    return;
  }
  if (json && lifecycleModes === 0) {
    console.error('error: --json requires --daemon, --status, or --stop.');
    process.exitCode = 1;
    return;
  }
  const invalidTiming = [
    ['--debounce', debounce, false],
    ['--cooldown', cooldown, true],
    ['--git-poll', gitPoll, false],
    ['--idle-timeout', idleTimeout, true],
  ].find(([, value, allowZero]) => {
    return value !== undefined && (!Number.isInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0));
  });
  if (invalidTiming) {
    console.error(`error: ${invalidTiming[0]} requires ${invalidTiming[2] ? 'a non-negative' : 'a positive'} integer.`);
    process.exitCode = 1;
    return;
  }
  const watchOverrides = {
    ...(debounce === undefined ? {} : { debounceMs: debounce }),
    ...(cooldown === undefined ? {} : { cooldownMs: cooldown }),
    ...(gitPoll === undefined ? {} : { gitPollMs: gitPoll }),
    ...(idleTimeout === undefined ? {} : { idleTimeoutMs: idleTimeout }),
  };
  if (debounce) (config.watch ??= {}).debounceMs = debounce;
  if (cooldown !== undefined) (config.watch ??= {}).cooldownMs = cooldown;
  if (gitPoll) (config.watch ??= {}).gitPollMs = gitPoll;
  if (idleTimeout !== undefined) (config.watch ??= {}).idleTimeoutMs = idleTimeout;
  const watchConfig = resolveWatchConfig(config);
  config.watch = watchConfig;
  const paths = resolveIndexStoragePaths(projectRoot, config);
  const controllerOptions = { projectRoot, cacheDir: paths.cacheDir, cliVersion, watchOverrides };

  if (status) {
    const report = watchServiceReport(inspectWatchService(controllerOptions), watchConfig.enabled);
    if (json) printJsonEnvelope('watch', [], opts, report);
    else renderWatchServiceReport(report);
    return;
  }
  if (stop) {
    try {
      const result = stopWatchService(controllerOptions);
      if (json) printJsonEnvelope('watch', [], opts, result);
      else
        console.log(
          result.disposition === 'stopped'
            ? `Stopped watch service${result.pid ? ` (pid ${result.pid})` : ''}.`
            : 'Watch service is already stopped.',
        );
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (!watchConfig.enabled) {
    console.error('error: watch mode is disabled. Set "watch.enabled": true in .scipquery.json to start it.');
    process.exitCode = 1;
    return;
  }
  if (daemon) {
    try {
      const result = ensureWatchService(controllerOptions);
      if (json) printJsonEnvelope('watch', [], opts, result);
      else {
        console.log(
          `${result.disposition === 'started' ? 'Started' : 'Reused'} watch service for ${projectRoot} (pid ${result.state.pid}).`,
        );
      }
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  const watchLock = acquireWatchProcessLock(join(dirname(paths.dbPath), WATCH_LOCK_FILE), projectRoot);
  if (!watchLock.acquired) {
    console.error(watchLock.message);
    process.exitCode = 1;
    return;
  }

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
    `Debounce: ${watchConfig.debounceMs}ms | Cooldown: ${watchConfig.cooldownMs}ms | Git poll: ${watchConfig.gitPollMs}ms`,
  );
  console.log('Press Ctrl+C to stop.\n');
  watcher.start();

  process.on('SIGINT', () => {
    watcher.stop();
    watchLock.release();
    console.log('\nStopped.');
    process.exit(0);
  });
  process.once('exit', watchLock.release);
}

function watchServiceReport(inspection: WatchServiceInspection, enabled = true) {
  const { classification } = inspection;
  switch (classification.kind) {
    case 'stopped':
      if (inspection.lockIsLive && inspection.lock) {
        return {
          enabled,
          state: 'running' as const,
          mode: 'foreground-or-starting' as const,
          pid: inspection.lock.pid,
          startedAt: inspection.lock.startedAt,
        };
      }
      return { enabled, state: 'stopped' as const, mode: 'none' as const };
    case 'live':
      return {
        enabled,
        state: 'running' as const,
        mode: 'daemon' as const,
        pid: classification.state.pid,
        startedAt: classification.state.startedAt,
        heartbeatAt: classification.state.heartbeatAt,
        lastActivityAt: classification.state.lastActivityAt,
        idleDeadlineAt: classification.state.idleDeadlineAt,
        watcher: classification.state.watcher,
        lastRefresh: classification.state.lastRefresh,
        lastError: classification.state.lastError,
        typescriptSemantic: classification.state.typescriptSemantic,
        typescriptIndex: classification.state.typescriptIndex,
      };
    case 'stale':
    case 'incompatible':
      return {
        enabled,
        state: classification.kind,
        mode: 'daemon' as const,
        reason: classification.reason,
        pid: classification.state.pid,
        heartbeatAt: classification.state.heartbeatAt,
        watcher: classification.state.watcher,
        lastRefresh: classification.state.lastRefresh,
        lastError: classification.state.lastError,
        typescriptSemantic: classification.state.typescriptSemantic,
        typescriptIndex: classification.state.typescriptIndex,
      };
    default:
      return assertNeverWatchService(classification);
  }
}

function renderWatchServiceReport(report: ReturnType<typeof watchServiceReport>): void {
  if (report.state === 'stopped') {
    console.log(`Watch service: stopped${report.enabled ? '' : ' (disabled)'}`);
    return;
  }
  const pid = 'pid' in report ? ` (pid ${report.pid})` : '';
  console.log(`Watch service: ${report.state} [${report.mode}]${pid}`);
  if ('watcher' in report && report.watcher) console.log(`Watcher: ${formatStatus(report.watcher)}`);
  if ('idleDeadlineAt' in report && report.idleDeadlineAt) console.log(`Idle exit: ${report.idleDeadlineAt}`);
  if ('reason' in report) console.log(`Reason: ${report.reason}`);
  if ('lastError' in report && report.lastError) console.log(`Last error: ${report.lastError.message}`);
  if ('typescriptSemantic' in report && report.typescriptSemantic) {
    const semantic = report.typescriptSemantic;
    console.log(
      `TypeScript semantics: ${semantic.state} (${semantic.projectsCreated} Projects, ${semantic.requests} requests)`,
    );
  }
  if ('typescriptIndex' in report && report.typescriptIndex) {
    const index = report.typescriptIndex;
    console.log(
      `TypeScript index: ${index.state} (${index.initializations} warmups, ${index.programUpdates} updates, ${index.requests} requests)`,
    );
  }
}

function assertNeverWatchService(value: never): never {
  throw new Error(`Unhandled watch service classification: ${JSON.stringify(value)}`);
}

export function handleStatus(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const { report } = buildProjectDiagnosticReport('status');
  const watchEnabled = resolveWatchConfig(loadProjectConfig(report.projectRoot)).enabled;
  const watchService = watchServiceReport(
    inspectWatchService({
      projectRoot: report.projectRoot,
      cacheDir: dirname(report.configuredDbPath),
      cliVersion,
    }),
    watchEnabled,
  );
  const affectedSetShadow = readAffectedSetShadowStatus(report.dbPath);
  const sqliteGeneration = inspectSqliteGeneration(report.dbPath, report.freshness.metaPath);
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('status', [], opts, {
      ...report,
      affectedSetShadow,
      sqliteGeneration,
      watchService,
      stats: statusStats(report.exists),
    });
    return;
  }
  renderStatusReport(report, {
    affectedSetShadow,
    capabilities: booleanOptionValue(opts, 'capabilities'),
    sqliteGeneration,
    watchService,
  });
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
  opts: {
    affectedSetShadow: AffectedSetShadowStatus;
    capabilities: boolean;
    sqliteGeneration: SqliteGenerationInspection;
    watchService: ReturnType<typeof watchServiceReport>;
  },
): void {
  console.log(`Project:  ${report.projectRoot}`);
  console.log(`DB path:  ${report.dbPath}`);
  if (report.dbPath !== report.configuredDbPath) {
    console.log(`Config:   ${report.configuredDbPath} (fallback to project root index.db)`);
  }
  for (const semantic of semanticReadinessEntries(report.readiness)) {
    const semanticState = semantic.available ? 'available' : semantic.dependencyAvailable ? 'fallback' : 'unavailable';
    const label = semantic.language === 'typescript' ? 'TS sem:' : `${semantic.language} sem:`;
    console.log(`${label.padEnd(9)}${semanticState}${semanticDetailSuffix(semantic)}`);
    if (semantic.reason) console.log(`${semantic.language} note: ${semantic.reason}`);
  }
  console.log(`Exists:   ${report.exists ? 'yes' : 'no'}`);
  console.log(`Fresh:    ${report.freshness.state}${report.freshness.remedy ? ` (${report.freshness.remedy})` : ''}`);
  if (report.freshness.lastRefresh) {
    console.log(`Refresh:  ${formatLastRefresh(report.freshness.lastRefresh)}`);
  }
  renderWatchServiceReport(opts.watchService);
  renderSqliteGeneration(opts.sqliteGeneration);
  console.log(`Shadow:   ${formatAffectedSetShadowStatus(opts.affectedSetShadow)}`);
  console.log(`Latest:   ${opts.affectedSetShadow.latestPath}`);

  renderStatusStats(report.exists);
  if (opts.capabilities) {
    console.log('');
    renderCapabilityReport(report.capabilities);
  }
}

function renderSqliteGeneration(inspection: SqliteGenerationInspection): void {
  if (inspection.state === 'legacy') {
    console.log('DB gen:   legacy (no generation record)');
    return;
  }
  if (inspection.state === 'invalid') {
    console.log(`DB gen:   invalid (${inspection.reason})`);
    return;
  }
  const publication = inspection.generation.publication;
  const mode = publication?.mode ?? 'unknown';
  const details = publication
    ? [
        publication.affectedDocumentCount === undefined ? null : `${publication.affectedDocumentCount} affected`,
        publication.changedDocumentCount === undefined ? null : `${publication.changedDocumentCount} changed`,
        publication.producerDurationMs === undefined ? null : `${publication.producerDurationMs.toFixed(0)}ms producer`,
        `${publication.converterDurationMs.toFixed(0)}ms convert`,
        publication.patchDurationMs === undefined ? null : `${publication.patchDurationMs.toFixed(0)}ms patch`,
        `${publication.scipCompanion ?? 'current'} SCIP companion`,
      ]
        .filter((value): value is string => value !== null)
        .join(', ')
    : 'no publication metrics';
  console.log(
    `DB gen:   ${inspection.state} ${inspection.generation.currentGeneration.slice(0, 12)} (${mode}; ${details})`,
  );
  if (inspection.generation.previousGeneration) {
    console.log(
      `Recovery: ${inspection.generation.previousGeneration.generationIdentity.slice(0, 12)} at ${inspection.generation.previousGeneration.databasePath}`,
    );
  }
  if (publication?.fallbackReason) console.log(`DB fallback: ${publication.fallbackReason}`);
  if (inspection.reason) console.log(`DB note:   ${inspection.reason}`);
}

function semanticReadinessEntries(
  readiness: ReturnType<typeof getProjectReadiness>,
): NonNullable<ReturnType<typeof getProjectReadiness>['semantics']> {
  if (readiness.semantics) return readiness.semantics;
  return readiness.semantic ? [readiness.semantic] : [];
}

function semanticProviderLabel(
  status: NonNullable<ReturnType<typeof getProjectReadiness>['semantics']>[number],
): string {
  return status.language === 'typescript' ? 'ts-morph' : 'rust-analyzer';
}

function semanticDetailSuffix(
  status: NonNullable<ReturnType<typeof getProjectReadiness>['semantics']>[number],
): string {
  if (status.tsconfigPaths && status.tsconfigPaths.length > 1) return ` (${status.tsconfigPaths.length} tsconfigs)`;
  if (status.tsconfigPath) return ` (${status.tsconfigPath})`;
  if (status.resolvedBinary) return ` (${status.resolvedBinary})`;
  return '';
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
