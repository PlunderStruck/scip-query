import { existsSync } from 'node:fs';
import type { SupportedLanguage } from '../domain/types.js';
import * as queries from '../queries/index.js';
import { augmentAuxiliaryDocuments, augmentVueResolvedReferences, detectLanguages, reindex } from '../reindex/index.js';
import { loadProjectConfig, resolveIndexPaths, initProjectConfig } from './config.js';
import { getProjectReadiness } from './project-readiness.js';
import { Watcher } from './watch.js';
import { setupAgent } from './agent-setup.js';
import { installSkills, isScipInstalled, printScipInstallInstructions } from './setup.js';
import {
  collect,
  formatBytes,
  formatStatus,
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
import {
  booleanOptionValue,
  commandOptions,
  numberOptionValue,
  stringArrayOptionValue,
  stringOptionValue,
} from './command-execution.js';

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
      skipIfUnchanged: !booleanOptionValue(opts, 'force'),
      allowPartial: booleanOptionValue(opts, 'allowPartial'),
      indexerConcurrency: numberOptionValue(opts, 'indexerConcurrency'),
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
    const result = queries.diffImpactPartial(db, files, plan.changedFiles);
    console.log(JSON.stringify(result));
  });
}

export function handleDiffImpact(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  try {
    renderDiffImpactReport(runIsolatedDiffImpactReport({ base: stringOptionValue(opts, 'base') }));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleHealthPhase(phase: unknown, rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  withDb((db) => {
    if (!queries.HEALTH_PHASES.includes(phase as typeof queries.HEALTH_PHASES[number])) {
      console.error(`error: Unknown health phase: ${phase}`);
      process.exit(1);
    }
    const result = queries.healthPhase(db, phase as typeof queries.HEALTH_PHASES[number], {
      scope: stringOptionValue(opts, 'scope'),
      full: booleanOptionValue(opts, 'full'),
    });
    console.log(JSON.stringify(result));
  });
}

export function handleHealth(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  if (booleanOptionValue(opts, 'writeBaseline') || booleanOptionValue(opts, 'baseline')) {
    handleHealthBaseline(opts);
    return;
  }
  try {
    const report = runIsolatedHealthReport({
      scope: stringOptionValue(opts, 'scope'),
      full: booleanOptionValue(opts, 'full'),
      json: booleanOptionValue(opts, 'json'),
    });
    renderHealthReport(report, booleanOptionValue(opts, 'json'));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
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
      console.log(`${comparison.fixedFindings.length} finding(s) fixed since baseline. Re-run --write-baseline to ratchet down.`);
    }
    if (comparison.newFindings.length === 0) {
      console.log(`OK: no new findings vs baseline (${comparison.baselineCount} baselined, ${comparison.current.length} current).`);
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

// scip-query: ignore-extract — long-running watch command lifecycle: option
// overrides, watcher callbacks, start/stop behavior, and SIGINT handling are
// one process action.
export function handleWatch(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const debounce = numberOptionValue(opts, 'debounce');
  const cooldown = numberOptionValue(opts, 'cooldown');
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
