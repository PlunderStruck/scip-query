import { existsSync } from 'node:fs';
import type { SupportedLanguage } from '../domain/types.js';
import { augmentAuxiliaryDocuments, augmentVueResolvedReferences, detectLanguages, reindex } from '../reindex/index.js';
import { getProjectReadiness } from '../reindex/readiness.js';
import { loadProjectConfig, resolveIndexPaths, initProjectConfig } from './config.js';
import { Watcher } from './watch.js';
import { BUILTIN_SKILLS, installSkills, isScipInstalled, printScipInstallInstructions } from './setup.js';
import {
  collect,
  formatBytes,
  formatStatus,
  queries,
  resolveCliProjectContext,
  resolveActiveDbPath,
  resolveProjectRoot,
  withDb,
} from './cli-context.js';
import {
  renderDiffImpactReport,
  renderHealthReport,
  runIsolatedDiffImpactReport,
  runIsolatedHealthReport,
} from './cli-support.js';

type Options = Record<string, unknown>;

function options(value: unknown): Options {
  return value && typeof value === 'object' ? value as Options : {};
}

function stringOption(opts: Options, key: string): string | undefined {
  const value = opts[key];
  return typeof value === 'string' ? value : undefined;
}

function numberOption(opts: Options, key: string): number | undefined {
  const value = opts[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanOption(opts: Options, key: string): boolean {
  return Boolean(opts[key]);
}

function stringArrayOption(opts: Options, key: string): string[] {
  const value = opts[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

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
]);

function supportedLanguages(values: readonly string[]): SupportedLanguage[] {
  return values.filter((value): value is SupportedLanguage => SUPPORTED_LANGUAGES.has(value as SupportedLanguage));
}

// scip-query: ignore-extract — side-effect command lifecycle: option decoding,
// config/path resolution, reindex execution, and process-facing error handling
// are one CLI action.
export async function handleReindex(rawOpts: unknown): Promise<void> {
  const opts = options(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  try {
    const languages = supportedLanguages(stringArrayOption(opts, 'language'));
    const result = await reindex({
      projectRoot,
      languages: languages.length > 0 ? languages : config.languages,
      outputScip: paths.indexPath,
      outputDb: paths.dbPath,
      pnpmWorkspaces: booleanOption(opts, 'pnpmWorkspaces') || config.indexer?.typescript?.pnpmWorkspaces,
      skipIfUnchanged: !booleanOption(opts, 'force'),
      allowPartial: booleanOption(opts, 'allowPartial'),
      indexerConcurrency: numberOption(opts, 'indexerConcurrency'),
    });
    console.log(`${result.reused ? 'Reused' : 'Indexed'} ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`);
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
  const opts = options(rawOpts);
  const projectRoot = resolveProjectRoot();
  const dbPath = resolveActiveDbPath(projectRoot);
  try {
    const result = augmentVueResolvedReferences({
      projectRoot,
      dbPath,
      tsconfig: stringOption(opts, 'project') ?? 'frontend/tsconfig.scip.json',
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
  const opts = options(rawOpts);
  withDb((db) => {
    const files = JSON.parse(process.env['SCIP_QUERY_DIFF_IMPACT_FILES'] ?? '[]') as string[];
    const plan = queries.diffImpactPlan(db, { base: stringOption(opts, 'base') });
    const result = queries.diffImpactPartial(db, files, plan.changedFiles);
    console.log(JSON.stringify(result));
  });
}

export function handleDiffImpact(rawOpts: unknown): void {
  const opts = options(rawOpts);
  try {
    renderDiffImpactReport(runIsolatedDiffImpactReport({ base: stringOption(opts, 'base') }));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleHealthPhase(phase: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    if (!queries.HEALTH_PHASES.includes(phase as typeof queries.HEALTH_PHASES[number])) {
      console.error(`error: Unknown health phase: ${phase}`);
      process.exit(1);
    }
    const result = queries.healthPhase(db, phase as typeof queries.HEALTH_PHASES[number], {
      scope: stringOption(opts, 'scope'),
      full: booleanOption(opts, 'full'),
    });
    console.log(JSON.stringify(result));
  });
}

export function handleHealth(rawOpts: unknown): void {
  const opts = options(rawOpts);
  try {
    const report = runIsolatedHealthReport({
      scope: stringOption(opts, 'scope'),
      full: booleanOption(opts, 'full'),
      json: booleanOption(opts, 'json'),
    });
    renderHealthReport(report, booleanOption(opts, 'json'));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleInstallSkills(): void {
  const result = installSkills();
  const total = result.installed.length + result.alreadyLinked.length;
  console.log(`\n${result.installed.length} installed, ${result.alreadyLinked.length} already linked, ${result.skipped.length} skipped.`);
  if (total > 0) {
    console.log('Skills will be available in your next Claude Code / Codex session.');
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
    const configPath = status.tsconfigPaths && status.tsconfigPaths.length > 1
      ? ` (${status.tsconfigPaths.length} tsconfigs)`
      : status.tsconfigPath ? ` (${status.tsconfigPath})` : '';
    console.log('\nSemantic provider readiness:');
    console.log(`${prefix} typescript: ts-morph${configPath}`);
    if (status.reason) console.log(`    ${status.reason}; semantic checks will fall back to SCIP/source evidence`);
  }

  process.exitCode = hasProblems ? 1 : 0;
}

export function handleInit(): void {
  const projectRoot = resolveProjectRoot();
  const languages = detectLanguages(projectRoot);
  const configPath = initProjectConfig(projectRoot, languages);
  console.log(`Config written to ${configPath}`);
  console.log(`Detected languages: ${languages.join(', ') || '(none)'}`);
}

// scip-query: ignore-extract — long-running watch command lifecycle: option
// overrides, watcher callbacks, start/stop behavior, and SIGINT handling are
// one process action.
export function handleWatch(rawOpts: unknown): void {
  const opts = options(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const debounce = numberOption(opts, 'debounce');
  const cooldown = numberOption(opts, 'cooldown');
  if (debounce) (config.watch ??= {}).debounceMs = debounce;
  if (cooldown) (config.watch ??= {}).cooldownMs = cooldown;

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
  console.log(`Debounce: ${config.watch?.debounceMs ?? 30000}ms | Cooldown: ${config.watch?.cooldownMs ?? 60000}ms`);
  console.log('Press Ctrl+C to stop.\n');
  watcher.start();

  process.on('SIGINT', () => {
    watcher.stop();
    console.log('\nStopped.');
    process.exit(0);
  });
}

export function handleStatus(): void {
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();
  const readiness = getProjectReadiness(projectRoot, config);

  console.log(`Project:  ${projectRoot}`);
  console.log(`DB path:  ${dbPath}`);
  if (dbPath !== paths.dbPath) {
    console.log(`Config:   ${paths.dbPath} (fallback to project root index.db)`);
  }
  if (readiness.semantic) {
    const semanticState = readiness.semantic.available ? 'available' : 'fallback';
    const suffix = readiness.semantic.tsconfigPaths && readiness.semantic.tsconfigPaths.length > 1
      ? ` (${readiness.semantic.tsconfigPaths.length} tsconfigs)`
      : readiness.semantic.tsconfigPath ? ` (${readiness.semantic.tsconfigPath})` : '';
    console.log(`TS sem:   ${semanticState}${suffix}`);
    if (readiness.semantic.reason) console.log(`TS note:  ${readiness.semantic.reason}`);
  }
  console.log(`Exists:   ${existsSync(dbPath) ? 'yes' : 'no'}`);

  if (existsSync(dbPath)) {
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
}

export { collect };
