import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SupportedLanguage } from '../../domain/types.js';
import { GRAPH_RELATION_UNAVAILABLE_FRONTIERS } from '../../domain/graph-relation-providers.js';
import { resolveIndexStoragePaths } from '../../platform/cache-layout.js';
import { WATCH_LOCK_FILE } from '../../platform/watch-service-state.js';
import * as queries from '../../queries/index.js';
import { augmentAuxiliaryDocuments, augmentVueResolvedReferencesAsync, detectLanguages } from '../../reindex/index.js';
import {
  formatAffectedSetShadowStatus,
  readAffectedSetShadowStatus,
  type AffectedSetShadowStatus,
} from '../../reindex/affected-shadow.js';
import { recordSuppressedReindexActivity } from '../../reindex/reindex-activity.js';
import {
  inspectLocalSqliteGenerationRetention,
  inspectSqliteGeneration,
  type LocalSqliteGenerationStatus,
  type SqliteGenerationInspection,
} from '../../reindex/sqlite-generation-store.js';
import {
  loadProjectConfig,
  resolveWatchConfig,
  initProjectConfigDetailed,
  validateProjectConfig,
  SUPPORTED_LANGUAGES,
} from '../config.js';
import { getIndexFreshness, type IndexFreshness } from '../index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from '../project-readiness.js';
import { Watcher } from '../watch.js';
import {
  acquireWatchProcessLock,
  ensureWatchService,
  inspectWatchService,
  stopWatchService,
  type WatchServiceInspection,
} from '../watch-service.js';
import { evaluateSetupAgentResult, setupAgent } from '../agent-setup.js';
import {
  planGuidedProjectSetup,
  renderProjectSetupReport,
  runProjectSetup,
  validateSetupInteractionMode,
  type ProjectSetupGuidedAction,
  type ProjectSetupGuidedFiles,
  type ProjectSetupOptions,
} from '../project-setup.js';
import { promptSetupChecklist, type SetupWizardChoice } from '../setup-wizard.js';
import { astParserLanguages } from '../ast-parser-setup.js';
import { installSkills, isScipInstalled, printScipInstallInstructions } from '../setup.js';
import { formatUninstallReport, runUninstall, selectUninstallScope } from '../uninstall.js';
import { inspectSharedCacheStatus, type SharedCacheStatus } from '../repository-cache-lifecycle.js';
import { rustSemanticSessionStatus } from '../../semantic/rust/lsp-session.js';
import { healthPhases } from '../../queries/health/health.js';
import { discloseHealthCapabilities } from '../health-capability-disclosure.js';
import {
  buildAutomatedSuppressionDecision,
  formatSuppressionWriteReceipt,
  writeSuppressionFile,
} from '../suppression-writer.js';
import { currentCliIndexGenerationObservationReceipt } from '../observation-receipt.js';
import { inspectWatchRefreshRequests } from '../../storage/watch-refresh-requests.js';
import { readSuppressionDir } from '../../storage/suppression-store.js';
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
  DIFF_IMPACT_BATCH_COMMAND,
  HEALTH_PHASE_COMMAND,
  cliVersion,
  renderDiffImpactReport,
  renderHealthReport,
  runIsolatedDiffImpactReportWithEvidence,
  runIsolatedHealthReportWithEvidence,
} from '../cli-support.js';
import {
  booleanOptionValue,
  commandOptions,
  dbCommand,
  numberOptionValue,
  printJsonEnvelope,
  stringArrayOptionValue,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { printIsolatedAnalysisResult } from '../isolated-analysis-runner.js';
import { GENERATED_EXPLORATION_CONTROLS } from '../generated-agent-command-catalog.js';
import { explorationRelationshipManualRows } from '../command-kit/exploration-manual.js';
import { GRAPH_EVIDENCE_STRENGTH_DEFINITIONS } from '../../domain/graph-relation-providers.js';
import { sanitizeTerminalLine } from '../../platform/terminal-output.js';
import { reindexConfiguredProject } from '../project-reindex.js';
import { evaluateArchitectureStop, renderArchitectureStopOutput } from './architecture-stop-hook.js';

// Descriptor-backed query commands live under runtime/query-commands/*.
// This file owns side-effect lifecycles such as reindex, setup, watch, and
// install commands.
const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);

export const handleArchitectureStopHook = dbCommand(({ db }) => {
  try {
    const evaluation = evaluateArchitectureStop(resolveProjectRoot(), db);
    process.stdout.write(`${JSON.stringify(renderArchitectureStopOutput(evaluation))}\n`);
  } catch (error) {
    const reason =
      'scip-query could not verify architecture at Stop: ' +
      `${error instanceof Error ? error.message : String(error)}. ` +
      'The Stop was blocked because the architecture result is unknown.';
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
  }
});

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
    const result = await reindexConfiguredProject(projectRoot, config, paths, {
      languages: languages.length > 0 ? languages : config.languages,
      force: booleanOptionValue(opts, 'force'),
      allowPartial: booleanOptionValue(opts, 'allowPartial'),
      skipAutoInstall: process.env['SCIP_QUERY_SKIP_AUTO_INSTALL'] === '1',
      installMissing: booleanOptionValue(opts, 'installMissing'),
      trustProjectTools: booleanOptionValue(opts, 'trustProjectTools'),
      indexerConcurrency: numberOptionValue(opts, 'indexerConcurrency') ?? config.indexerConcurrency,
      trigger: { kind: 'manual-cli', detail: 'scip-query reindex' },
      // JSON output must remain pure machine-readable data on stdout.
      ...(json ? { onStatus: () => {} } : { onStatus: console.log }),
    });
    if (json) {
      printJsonEnvelope('reindex', [], opts, result);
      return;
    }
    if (result.skipped.length > 0) {
      const ready = result.languages.length > 0 ? result.languages.join(', ') : 'none';
      console.log(
        `Reindex partial: available language output ${ready}; ${result.skipped.length} skipped in ${(result.durationMs / 1000).toFixed(1)}s.`,
      );
      for (const skipped of result.skipped) console.log(`  skip: ${skipped.language} — ${skipped.reason}`);
    } else {
      console.log(
        `${result.reused ? 'Reused' : 'Indexed'} ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`,
      );
    }
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

export async function handleAugmentVue(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const dbPath = resolveActiveDbPath(projectRoot);
  try {
    const result = await augmentVueResolvedReferencesAsync({
      projectRoot,
      dbPath,
      tsconfig: stringOptionValue(opts, 'project') ?? 'frontend/tsconfig.scip.json',
      onStatus: (message) => console.log(message),
    });
    console.log(
      `Vue files: ${result.vueFiles}; resolved references: ${result.resolvedReferences}; inserted mentions: ${result.insertedMentions}; not-inserted identifier tokens: ${result.skippedReferences}; synthetic symbols: ${result.syntheticSymbols}.`,
    );
    console.log(
      `Not inserted by reason: no definition ${result.skippedReferenceReasons['no-definition']}; same-file definition ${result.skippedReferenceReasons['same-file-definition']}; unindexed definition ${result.skippedReferenceReasons['unindexed-definition']}; missing source ${result.skippedReferenceReasons['missing-source-file']}; missing service script ${result.skippedReferenceReasons['missing-service-script']}. Samples: ${result.skippedReferenceSamples.length} omitted, ${result.resolvedReferenceSamples.length} resolved.`,
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
    printIsolatedAnalysisResult(DIFF_IMPACT_BATCH_COMMAND, result);
  });
}

export async function handleDiffImpact(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  try {
    const analysis = await runIsolatedDiffImpactReportWithEvidence({ base: stringOptionValue(opts, 'base') });
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('diff-impact', [], opts, analysis.result, {
        observationReceipt: analysis.observationReceipt,
      });
      return;
    }
    renderDiffImpactReport(analysis.result);
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
    printIsolatedAnalysisResult(HEALTH_PHASE_COMMAND, result);
  });
}

export async function handleHealth(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  if (booleanOptionValue(opts, 'writeBaseline') || booleanOptionValue(opts, 'baseline')) {
    handleHealthBaseline(opts);
    return;
  }
  try {
    const analysis = await runIsolatedHealthReportWithEvidence({
      scope: stringOptionValue(opts, 'scope'),
      full: booleanOptionValue(opts, 'full'),
      json: booleanOptionValue(opts, 'json'),
    });
    const { projectRoot, config, dbPath } = resolveCliProjectContext();
    const capabilities = getProjectCapabilities(getProjectReadiness(projectRoot, config), {
      hasIndexedGraph: existsSync(dbPath),
    });
    const disclosedReport = discloseHealthCapabilities(analysis.result, capabilities);
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('health', [], opts, disclosedReport, {
        observationReceipt: analysis.observationReceipt,
      });
      return;
    }
    renderHealthReport(disclosedReport);
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
  renderCapabilities(rawOpts);
}

function renderCapabilities(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();
  const readiness = getProjectReadiness(projectRoot, config);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  const report = getProjectCapabilities(readiness, {
    hasIndexedGraph: existsSync(dbPath) && freshness.state !== 'missing',
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('capabilities', [], opts, {
      ...report,
      explorationControls: GENERATED_EXPLORATION_CONTROLS,
      relationshipQuestions: explorationRelationshipManualRows(),
      unavailableRelationshipFrontiers: GRAPH_RELATION_UNAVAILABLE_FRONTIERS,
    });
    return;
  }
  renderCapabilityReport(report, { matrix: booleanOptionValue(opts, 'matrix') });
}

export function handleInit(): void {
  const projectRoot = resolveProjectRoot();
  const languages = detectLanguages(projectRoot);
  const result = initProjectConfigDetailed(projectRoot, languages);
  console.log(
    result.changed
      ? `Config written to ${result.configPath}`
      : `Config already exists at ${result.configPath}; existing contents left unchanged.`,
  );
  console.log(`Detected languages: ${languages.join(', ') || '(none)'}`);
}

// scip-query: ignore-similar — shares CLI option/project/json scaffolding with
// capability rendering, but validates config diagnostics instead of capability
// evidence.
export function handleConfigValidate(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const suppressionRecords = readSuppressionDir(projectRoot);
  const diagnostics = [
    ...validateProjectConfig(config, { projectRoot }),
    ...suppressionRecords.compatibility.issues.map((issue) => ({
      level: 'error' as const,
      path: issue.path,
      message: issue.reason,
    })),
  ];
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
  const reasonCode = stringOptionValue(opts, 'reasonCode');
  const evidence = stringArrayOptionValue(opts, 'evidence');
  if (!reasonCode || evidence.length === 0) {
    console.error(
      'error: suppress requires --reason-code <code> and at least one --evidence <source|config|test|graph>:<referent> so automatic adjudication has inspectable counterevidence.',
    );
    process.exitCode = 1;
    return;
  }
  try {
    const projectRoot = resolveProjectRoot();
    const observation = (() => {
      try {
        return withDb(() => currentCliIndexGenerationObservationReceipt());
      } catch {
        return undefined;
      }
    })();
    const suppression = {
      id: String(id),
      check: stringOptionValue(opts, 'check'),
      file: stringOptionValue(opts, 'file'),
      reason,
      expiresAt: stringOptionValue(opts, 'expiresAt'),
      decision: buildAutomatedSuppressionDecision(projectRoot, reasonCode, evidence, reason, observation),
    };
    const result = writeSuppressionFile(projectRoot, suppression, {
      expectedRevision: stringOptionValue(opts, 'replace'),
    });
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('suppress', [String(id)], opts, result);
      return;
    }
    for (const line of formatSuppressionWriteReceipt(result, suppression)) console.log(line);
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
    freshness: IndexFreshness;
    capabilities: ReturnType<typeof getProjectCapabilities>;
    sharedCache: SharedCacheStatus;
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
  const sharedCache = inspectSharedCacheStatus(projectRoot, config, paths);
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
      sharedCache,
      ok: !hasAttention,
    },
    hasIndexerProblems,
    hasErrors,
  };
}

export function handleSetupAgent(rawOpts: unknown): void {
  commandOptions(rawOpts);
  const projectRoot = resolveProjectRoot();
  const result = setupAgent(projectRoot);
  for (const target of result.written) console.log(`  done: ${target}`);
  for (const target of result.unchanged) console.log(`  ok:   ${target} (already wired)`);
  for (const skip of result.skipped) console.log(`  skip: ${skip.target} — ${skip.reason}`);
  const evaluation = evaluateSetupAgentResult(result);
  if (evaluation.verdict === 'ready') {
    console.log('\nProject agent guidance is configured for every selected target.');
  } else if (evaluation.verdict === 'partial') {
    console.log(
      `\nProject agent guidance is only partially configured: ${evaluation.ready} target(s) ready, ${evaluation.skipped} skipped. Resolve the skips before relying on every agent integration.`,
    );
  } else {
    console.log(
      `\nProject agent guidance was not configured: all ${evaluation.skipped} selected target(s) were skipped.`,
    );
  }
  if (evaluation.ready > 0) {
    console.log(
      'Configured agents can use compiler-backed exploration, impact, architecture, and health evidence. When declared architecture rules are ready, setup also installs the local architecture-only Stop hook.',
    );
  }
  process.exitCode = evaluation.verdict === 'ready' ? 0 : 1;
}

export async function handleSetup(rawOpts: unknown): Promise<void> {
  const opts = commandOptions(rawOpts);
  try {
    const guided = booleanOptionValue(opts, 'guided');
    const yes = booleanOptionValue(opts, 'yes');
    const json = booleanOptionValue(opts, 'json');
    validateSetupInteractionMode({
      guided,
      yes,
      json,
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
    });
    const installMissing = booleanOptionValue(opts, 'installMissing');
    let setupOptions: ProjectSetupOptions = {
      dossierDir: stringOptionValue(opts, 'dossierDir'),
      runHealth: yes ? false : opts['health'] !== false,
      installSkills: opts['skills'] !== false,
      installIndexers: installMissing,
      installAstParsers: installMissing && opts['parsers'] !== false,
      ...(yes ? { automaticRefresh: true } : {}),
    };
    const interactive = !json && !yes && process.stdin.isTTY && process.stdout.isTTY;
    if (guided || interactive) {
      setupOptions = await guidedProjectSetupOptions(setupOptions, { json });
    }
    if (!json) setupOptions.onStatus = (message) => console.log(`  ${message}`);
    const report = await runProjectSetup(setupOptions);
    if (json) {
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

// scip-query: ignore-extract — reviewed E1 workflow owner; prompts and the resulting setup options form one guided interaction.
async function guidedProjectSetupOptions(
  base: ProjectSetupOptions,
  opts: { json: boolean },
): Promise<ProjectSetupOptions> {
  const { projectRoot, config } = resolveCliProjectContext();
  const readiness = getProjectReadiness(projectRoot, config);
  const plan = planGuidedProjectSetup({
    files: guidedProjectSetupFiles(projectRoot),
    watchEnabled: resolveWatchConfig(config).enabled,
    readiness,
  });
  const languageChoices = readiness.languages.map(
    (language): SetupWizardChoice => ({
      id: `language:${language}`,
      scope: 'project',
      label: `Index ${language}`,
      reason: 'Detected in this project.',
      selected: true,
    }),
  );
  const actionChoices = plan.actions.map(
    (action): SetupWizardChoice => ({
      id: action.id,
      scope: action.scope === 'repository' ? 'project' : action.scope,
      label: action.label,
      reason: action.reason,
      selected: action.recommended,
    }),
  );
  const parserLanguages = astParserLanguages(readiness.languages);
  actionChoices.push(
    {
      id: 'install-agent-skills',
      scope: 'user',
      label: 'Install agent skills',
      reason: 'Makes scip-query workflows available to local agents.',
      selected: true,
    },
    ...(parserLanguages.length > 0
      ? [
          {
            id: 'install-ast-parsers',
            scope: 'user' as const,
            label: `Install or repair AST parsers (${parserLanguages.join(', ')})`,
            reason: 'Installs the Tree-sitter runtime and grammars used for source-level analysis.',
            selected: true,
          },
        ]
      : []),
    {
      id: 'run-health-analysis',
      scope: 'analysis',
      label: 'Run full health analysis and write dossier',
      reason: 'Optional and can take much longer than indexing.',
      selected: false,
    },
  );
  const interactive = !opts.json && process.stdin.isTTY && process.stdout.isTTY;
  const selected = interactive
    ? await promptSetupChecklist([...languageChoices, ...actionChoices])
    : new Set([...recommendedGuidedActions(plan.actions), ...languageChoices.map((choice) => choice.id)]);
  if (interactive) renderGuidedSelection(plan.actions, selected);
  const agentActionSelected = selected.has('create-agent-guidance') || selected.has('update-agent-guidance');
  const automaticRefreshAction = plan.actions.some((action) => action.id === 'enable-automatic-refresh');
  const indexerAction = plan.actions.some((action) => action.id === 'install-indexers');
  return {
    ...base,
    ...(automaticRefreshAction ? { automaticRefresh: selected.has('enable-automatic-refresh') } : {}),
    noAgentGuidance: !agentActionSelected,
    ...(indexerAction
      ? { installIndexers: interactive ? selected.has('install-indexers') : base.installIndexers === true }
      : {}),
    languages: readiness.languages.filter((language) => selected.has(`language:${language}`)),
    installSkills: selected.has('install-agent-skills'),
    installAstParsers: interactive ? selected.has('install-ast-parsers') : base.installAstParsers === true,
    runHealth: selected.has('run-health-analysis'),
  };
}

function guidedProjectSetupFiles(projectRoot: string): ProjectSetupGuidedFiles {
  return {
    agentsMd: existsSync(join(projectRoot, 'AGENTS.md')),
    claudeMd: existsSync(join(projectRoot, 'CLAUDE.md')),
  };
}

function recommendedGuidedActions(actions: readonly ProjectSetupGuidedAction[]): Set<string> {
  return new Set([
    ...actions.filter((action) => action.recommended && action.id !== 'install-indexers').map((action) => action.id),
    'install-agent-skills',
  ]);
}

function renderGuidedSelection(actions: readonly ProjectSetupGuidedAction[], selected: ReadonlySet<string>): void {
  console.log('');
  console.log('Selected setup changes:');
  for (const scope of ['repository', 'checkout', 'user'] as const) {
    const labels = actions
      .filter((action) => action.scope === scope && selected.has(action.id))
      .map((action) => action.label);
    const guidance =
      scope === 'repository'
        ? 'commit these shared project changes'
        : scope === 'checkout'
          ? 'keep these local to this checkout'
          : 'changes this machine or user environment';
    console.log(`  ${scope} (${guidance}): ${labels.length > 0 ? labels.join(', ') : 'none'}`);
  }
}

export function handleUninstall(rawOpts: unknown): void {
  const opts = commandOptions(rawOpts);
  const selection = selectUninstallScope({
    global: booleanOptionValue(opts, 'global'),
    project: booleanOptionValue(opts, 'project'),
    dryRun: booleanOptionValue(opts, 'dryRun'),
  });
  if (!selection.ok) {
    console.error(`error: ${selection.message}`);
    process.exitCode = 1;
    return;
  }
  const report = runUninstall({
    projectRoot: resolveProjectRoot(),
    global: selection.global,
    project: selection.project,
    dryRun: booleanOptionValue(opts, 'dryRun'),
  });

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('uninstall', [], opts, report);
    return;
  }

  for (const line of formatUninstallReport(report, { verbose: booleanOptionValue(opts, 'verbose') })) console.log(line);
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
  const timingOptions = [
    ['--debounce', debounce],
    ['--cooldown', cooldown],
    ['--git-poll', gitPoll],
    ['--idle-timeout', idleTimeout],
  ] as const;
  const providedTimingOptions = timingOptions.filter(([, value]) => value !== undefined);
  if ((status || stop) && providedTimingOptions.length > 0) {
    console.error(
      `error: timing options (${providedTimingOptions.map(([flag]) => flag).join(', ')}) only apply when starting a foreground or daemon watcher; --status and --stop do not accept them.`,
    );
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
      if (providedTimingOptions.length > 0) {
        const inspection = inspectWatchService(controllerOptions);
        if (inspection.classification.kind === 'live') {
          throw new Error(
            `watch service pid ${inspection.classification.state.pid} is already running. Timing options only apply when the process starts; run "scip-query watch --stop", then repeat this daemon command.`,
          );
        }
      }
      const result = ensureWatchService(controllerOptions);
      if (json) printJsonEnvelope('watch', [], opts, result);
      else {
        console.log(
          `${result.disposition === 'started' ? 'Started' : 'Reused'} watch service for ${projectRoot} (pid ${result.state.pid}).`,
        );
        if (providedTimingOptions.length > 0) {
          console.log(
            `Process-local timing overrides: ${providedTimingOptions
              .map(([flag, value]) => `${flag}=${value}`)
              .join(', ')}. These were not written to .scipquery.json.`,
          );
        }
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
    outputDb: paths.dbPath,
    languages: config.languages,
    onStatus: (status) => {
      process.stdout.write(`\r\x1b[K${sanitizeTerminalLine(formatStatus(status))}`);
    },
    onReindexComplete: (durationMs) => {
      console.log(`\nReindex complete in ${(durationMs / 1000).toFixed(1)}s`);
      return getIndexFreshness(projectRoot, config, paths).state === 'fresh';
    },
    onRefreshSuppressed: (trigger) => {
      const activityWrite = recordSuppressedReindexActivity(paths.dbPath, trigger);
      if (activityWrite.state === 'failed') {
        console.error(`\nWatch warning: suppressed-refresh telemetry was not recorded: ${activityWrite.reason}`);
      }
      console.log('\nSkipped redundant refresh; the completed index already includes the queued changes.');
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

  let foregroundStopStarted = false;
  const stopForegroundWatcher = () => {
    if (foregroundStopStarted) return;
    foregroundStopStarted = true;
    void watcher.stop().then((result) => {
      if (result.state === 'degraded') {
        foregroundStopStarted = false;
        console.error(`\nUnable to stop safely: ${result.reasons.join('; ')}`);
        return;
      }
      watchLock.release();
      console.log('\nStopped.');
      process.exit(0);
    });
  };
  process.on('SIGINT', stopForegroundWatcher);
  process.on('SIGTERM', stopForegroundWatcher);
}

function watchServiceReport(inspection: WatchServiceInspection, enabled = true) {
  const { classification } = inspection;
  const refreshRequests = inspectWatchRefreshRequests(inspection.paths.refreshRequestsPath);
  switch (classification.kind) {
    case 'stopped':
      if (inspection.lockIsLive && inspection.lock) {
        return {
          enabled,
          state: 'running' as const,
          mode: 'foreground-or-starting' as const,
          pid: inspection.lock.pid,
          projectRoot: inspection.identity.projectRoot,
          worktreeId: inspection.identity.worktreeId,
          startedAt: inspection.lock.startedAt,
          refreshRequests,
        };
      }
      return { enabled, state: 'stopped' as const, mode: 'none' as const, refreshRequests };
    case 'live':
      return {
        enabled,
        state: 'running' as const,
        mode: 'daemon' as const,
        pid: classification.state.pid,
        projectRoot: classification.state.projectRoot,
        worktreeId: classification.state.worktreeId,
        startedAt: classification.state.startedAt,
        heartbeatAt: classification.state.heartbeatAt,
        lastActivityAt: classification.state.lastActivityAt,
        idleDeadlineAt: classification.state.idleDeadlineAt,
        watcher: classification.state.watcher,
        indexGeneration: classification.state.indexGeneration,
        lastRefresh: classification.state.lastRefresh,
        lastError: classification.state.lastError,
        reindexActivity: classification.state.reindexActivity,
        refreshRequests,
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
        projectRoot: classification.state.projectRoot,
        worktreeId: classification.state.worktreeId,
        heartbeatAt: classification.state.heartbeatAt,
        watcher: classification.state.watcher,
        indexGeneration: classification.state.indexGeneration,
        lastRefresh: classification.state.lastRefresh,
        lastError: classification.state.lastError,
        reindexActivity: classification.state.reindexActivity,
        refreshRequests,
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
    renderWatchRefreshRequestStatus(report.refreshRequests);
    return;
  }
  const pid = 'pid' in report ? ` (pid ${report.pid})` : '';
  console.log(`Watch service: ${report.state} [${report.mode}]${pid}`);
  if ('projectRoot' in report && report.projectRoot) {
    const worktree = 'worktreeId' in report && report.worktreeId ? ` [${report.worktreeId.slice(0, 12)}]` : '';
    console.log(`Worktree: ${report.projectRoot}${worktree}`);
  }
  if ('watcher' in report && report.watcher) console.log(`Watcher: ${formatStatus(report.watcher)}`);
  if ('indexGeneration' in report && report.indexGeneration) {
    console.log(`Index generation: ${report.indexGeneration.slice(0, 12)}`);
  }
  if ('idleDeadlineAt' in report && report.idleDeadlineAt) console.log(`Idle exit: ${report.idleDeadlineAt}`);
  if ('reason' in report) console.log(`Reason: ${report.reason}`);
  if ('lastError' in report && report.lastError) console.log(`Last error: ${report.lastError.message}`);
  if ('reindexActivity' in report && report.reindexActivity) {
    const activity = report.reindexActivity;
    console.log(
      `Reindex activity (24h): ${activity.runs} run(s) ` +
        `(${activity.rebuilt} rebuilt, ${activity.reused} reused, ${activity.failed} failed), ` +
        `${activity.suppressed} redundant refresh(es) suppressed, ` +
        `${formatBytes(activity.estimatedWriteBytes ?? activity.estimatedLogicalOutputBytes)} estimated writes ` +
        `(${formatBytes(activity.estimatedLogicalOutputBytes)} logical output)` +
        `${activity.confidence && activity.confidence !== 'complete' ? ` [${activity.confidence} evidence]` : ''}`,
    );
    if (activity.reflinkedBytes !== undefined || activity.fallbackCopiedBytes !== undefined) {
      console.log(
        `Reindex staging: ${formatBytes(activity.reflinkedBytes ?? 0)} reflinked, ` +
          `${formatBytes(activity.fallbackCopiedBytes ?? 0)} byte-copied`,
      );
    }
    for (const [language, detail] of Object.entries(activity.byLanguage ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!detail) continue;
      console.log(
        `Reindex language ${language}: ${detail.runs} run(s) ` +
          `(${detail.rebuilt} rebuilt, ${detail.reused} reused), ` +
          `${formatBytes(detail.producedOutputBytes)} produced, ` +
          `${formatIndexerDuration(detail.durationMs)} cumulative indexer time`,
      );
    }
    if (activity.languageAttribution && activity.languageAttribution !== 'complete') {
      console.log(
        `Reindex language attribution: ${activity.languageAttribution}; ` +
          `${activity.unattributedRuns ?? 0} completed run(s) unattributed, ` +
          `${activity.invalidLanguageDetails ?? 0} invalid detail(s) ignored`,
      );
    }
    if (activity.confidence && activity.confidence !== 'complete') {
      console.log(
        `Reindex evidence: ${activity.recordsRead ?? 0} record(s) read, ` +
          `${activity.invalidRecords ?? 0} invalid, ${activity.readErrors ?? 0} read error(s), ` +
          `${activity.ignoredPartialTailBytes ?? 0} incomplete byte(s) ignored`,
      );
    }
  }
  if ('refreshRequests' in report && report.refreshRequests) {
    renderWatchRefreshRequestStatus(report.refreshRequests);
  }
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

function renderWatchRefreshRequestStatus(requests: ReturnType<typeof inspectWatchRefreshRequests>): void {
  console.log(
    `Refresh requests: ${requests.pending} pending, ${requests.claimed} claimed, ` +
      `${requests.completed} completed, ${requests.expired} expired` +
      `${requests.invalid > 0 ? `, ${requests.invalid} invalid` : ''}`,
  );
}

function assertNeverWatchService(value: never): never {
  throw new Error(`Unhandled watch service classification: ${JSON.stringify(value)}`);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
  const localGenerations = inspectLocalSqliteGenerationRetention(report.dbPath);
  const rustSemanticSession = rustSemanticSessionStatus(
    report.projectRoot,
    process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'],
  );
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('status', [], opts, {
      ...report,
      affectedSetShadow,
      sqliteGeneration,
      localGenerations,
      rustSemanticSession,
      watchService,
      stats: statusStats(report.exists),
    });
    return;
  }
  renderStatusReport(report, {
    affectedSetShadow,
    capabilities: booleanOptionValue(opts, 'capabilities'),
    sqliteGeneration,
    localGenerations,
    rustSemanticSession,
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
  renderOperationalCapabilitySummary(report.capabilities);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function renderStatusReport(
  report: ReturnType<typeof buildProjectDiagnosticReport>['report'],
  opts: {
    affectedSetShadow: AffectedSetShadowStatus;
    capabilities: boolean;
    sqliteGeneration: SqliteGenerationInspection;
    localGenerations: LocalSqliteGenerationStatus;
    rustSemanticSession: ReturnType<typeof rustSemanticSessionStatus>;
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
  renderSharedCacheStatus(report.sharedCache);
  console.log(
    `Rust sess: ${opts.rustSemanticSession.transport}/${opts.rustSemanticSession.state} (${opts.rustSemanticSession.source}; worker fallback; opt out with ${opts.rustSemanticSession.optOut})`,
  );
  if (!opts.rustSemanticSession.valid) console.log('Rust note: invalid durable-session value; using worker fallback');
  renderSqliteGeneration(opts.sqliteGeneration);
  renderLocalSqliteGenerations(opts.localGenerations);
  console.log(`Shadow:   ${formatAffectedSetShadowStatus(opts.affectedSetShadow)}`);
  console.log(`Latest:   ${opts.affectedSetShadow.latestPath}`);

  renderStatusStats(report.exists);
  if (opts.capabilities) {
    console.log('');
    renderOperationalCapabilitySummary(report.capabilities);
    console.log('Run `scip-query capabilities` for the semantic control manual.');
  }
}

function renderOperationalCapabilitySummary(report: ReturnType<typeof getProjectCapabilities>): void {
  const capabilityCounts = countCapabilityStatuses(report.capabilities);
  const relationCounts = countCapabilityStatuses(report.relations);
  console.log(`  Languages: ${report.languages.join(', ') || '(none detected)'}`);
  console.log(
    `  Analysis readiness: ${capabilityCounts.available} available, ${capabilityCounts.partial} partial, ${capabilityCounts.unavailable} unavailable`,
  );
  console.log(
    `  Relationship providers: ${relationCounts.available} available, ${relationCounts.partial} partial, ${relationCounts.unavailable} unavailable`,
  );
}

function countCapabilityStatuses(rows: readonly { status: string }[]): {
  available: number;
  partial: number;
  unavailable: number;
} {
  return {
    available: rows.filter((row) => row.status === 'available').length,
    partial: rows.filter((row) => row.status === 'partial').length,
    unavailable: rows.filter((row) => row.status !== 'available' && row.status !== 'partial').length,
  };
}

function renderSharedCacheStatus(status: SharedCacheStatus): void {
  if (status.state !== 'managed') {
    console.log(`Shared:   ${status.state}${status.reason ? ` (${status.reason})` : ''}`);
    return;
  }
  const base = status.baseGenerationId?.slice(0, 12) ?? 'none';
  const active = status.activeGenerationId?.slice(0, 12) ?? 'none';
  const action = status.lastAction ?? 'none';
  console.log(
    `Shared:   ${action}, base ${base}, active ${active}, ${status.generations} generation(s), ${formatBytes(status.generationBytes)}`,
  );
  if (status.reason) console.log(`Share why: ${status.reason}`);
  console.log(
    `Share GC:  ${status.protectedGenerations} protected, ${status.unreferencedGenerations} unreferenced (${formatBytes(status.unreferencedBytes)}), ${status.temporaryGenerations} temporary`,
  );
  if (status.cleanup?.kind === 'swept') {
    console.log(
      `Cache GC: ${status.cleanup.deletedWorktrees ?? 0} worktree(s), ${status.cleanup.deletedGenerations ?? 0} generation(s), ${formatBytes(status.cleanup.deletedBytes ?? 0)} removed`,
    );
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
  console.log(
    `DB layout: ${inspection.generation.artifactSet === 'immutable-v1' ? 'immutable artifact set; stable paths are mirrors' : 'legacy stable paths'}`,
  );
  if (inspection.generation.previousGeneration) {
    console.log(
      `Recovery: ${inspection.generation.previousGeneration.generationIdentity.slice(0, 12)} at ${inspection.generation.previousGeneration.databasePath}`,
    );
  }
  if (publication?.fallbackReason) console.log(`DB fallback: ${publication.fallbackReason}`);
  if (inspection.reason) console.log(`DB note:   ${inspection.reason}`);
}

function renderLocalSqliteGenerations(status: LocalSqliteGenerationStatus): void {
  if (status.state === 'absent') return;
  console.log(
    `Local GC: ${status.state}, ${status.generationCount} generation(s), ${formatBytes(status.logicalBytes)}, ` +
      `${status.protectedGenerations} protected (${status.activeReaderLeases} live reader lease(s)); ` +
      `limits ${status.limits.maxGenerations} / ${formatBytes(status.limits.maxLogicalBytes)}`,
  );
  if (status.oldestGenerationAt) console.log(`Local age: oldest generation ${status.oldestGenerationAt}`);
  if (status.lastCollection) {
    console.log(
      `Local last: ${status.lastCollection.state} at ${status.lastCollection.at}, ` +
        `${status.lastCollection.removedGenerations} removed`,
    );
  }
  if (status.reason) console.log(`Local why: ${status.reason}`);
}

// scip-query: ignore-twin — command rendering and readiness computation expose different views.
function semanticReadinessEntries(
  readiness: ReturnType<typeof getProjectReadiness>,
): NonNullable<ReturnType<typeof getProjectReadiness>['semantics']> {
  if (readiness.semantics) return readiness.semantics;
  return readiness.semantic ? [readiness.semantic] : [];
}

// scip-query: ignore-twin — CLI labels and readiness labels have separate presentation contracts.
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

function formatLastRefresh(refresh: NonNullable<IndexFreshness['lastRefresh']>): string {
  const seconds = (refresh.durationMs / 1000).toFixed(1);
  const detail = refresh.trigger.detail ? ` (${refresh.trigger.detail})` : '';
  const error = refresh.error ? `: ${refresh.error}` : '';
  return `${refresh.result} by ${refresh.trigger.kind}${detail} in ${seconds}s at ${refresh.completedAt}${error}`;
}

function formatIndexerDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
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

function renderCapabilityReport(
  report: ReturnType<typeof getProjectCapabilities>,
  options: { matrix?: boolean } = {},
): void {
  console.log(`Exploration capabilities for: ${report.languages.join(', ') || '(no detected languages)'}`);
  console.log('\nPrimary controls:');
  for (const control of GENERATED_EXPLORATION_CONTROLS) {
    console.log(
      `  ${control.stage.toUpperCase().padEnd(8)} scip-query ${control.command} [${control.outputCost}] — ${control.question}`,
    );
  }
  console.log('\nRelationship controls:');
  for (const row of explorationRelationshipManualRows()) {
    const relation = report.relations.find((candidate) => candidate.family === row.family);
    const status = relation?.status ?? 'unsupported';
    console.log(`  ${status.toUpperCase().padEnd(11)} ${row.family} ${row.direction} — ${row.question}`);
  }
  console.log(
    `\nStrengths: ${Object.keys(GRAPH_EVIDENCE_STRENGTH_DEFINITIONS).join(', ')}. Unavailable analyses: ${GRAPH_RELATION_UNAVAILABLE_FRONTIERS.map((frontier) => frontier.id).join(', ')}.`,
  );
  console.log(
    '\nThe agent chooses a question, family, and direction; this command reports support and does not infer intent.',
  );
  if (!options.matrix) {
    console.log('Run `scip-query capabilities --matrix` only when a named claim needs contract or provider details.');
    return;
  }

  renderCapabilityContractDetails(report);
  renderCapabilityMatrix(report);
}

function renderCapabilityContractDetails(report: ReturnType<typeof getProjectCapabilities>): void {
  console.log('\nControl contracts:');
  for (const control of GENERATED_EXPLORATION_CONTROLS) {
    console.log(`  scip-query ${control.command}`);
    console.log(`             Input: ${control.requiredInput}`);
    console.log(`             Returns: ${control.returnedFact}`);
    console.log(`             Ceiling: ${control.evidenceCeiling}`);
    console.log(`             Does not establish: ${control.nonClaim}`);
    if (control.contrasts.length > 0) console.log(`             Contrast: ${control.contrasts.join(' ')}`);
    if (control.gapClosingCommands.length > 0) {
      console.log(`             Close disclosed gaps with: ${control.gapClosingCommands.join(', ')}`);
    }
  }
  console.log('\nRelationship contracts:');
  for (const row of explorationRelationshipManualRows()) {
    const relation = report.relations.find((candidate) => candidate.family === row.family);
    const status = relation?.status ?? 'unsupported';
    console.log(`  ${status.toUpperCase().padEnd(11)} ${row.family} ${row.direction}`);
    console.log(`             Establishes: ${row.establishes}`);
    console.log(`             Strengths: ${row.evidenceStrengths.join(', ') || 'none registered'}`);
    console.log(`             Provider ceilings: ${row.supportCeilings.join(', ') || 'none registered'}`);
    console.log(`             Does not establish: ${row.nonClaim}`);
  }
  console.log('\nEvidence strength legend:');
  for (const [strength, meaning] of Object.entries(GRAPH_EVIDENCE_STRENGTH_DEFINITIONS)) {
    console.log(`  ${strength.toUpperCase().padEnd(11)} ${meaning}`);
  }
  console.log('\nExplicitly unavailable relationship analyses:');
  for (const frontier of GRAPH_RELATION_UNAVAILABLE_FRONTIERS) {
    console.log(`  ${frontier.id} [${frontier.families.join(', ')}]`);
    console.log(`             ${frontier.capability}`);
    console.log(`             Consequence: ${frontier.consequence}`);
    console.log(`             Recover selected paths with: ${frontier.recoverWith.join(', ')}`);
  }
}

function renderCapabilityMatrix(report: ReturnType<typeof getProjectCapabilities>): void {
  console.log('\nProject capability matrix:');
  for (const capability of report.capabilities) {
    console.log(`  ${capability.status.toUpperCase().padEnd(11)} ${capability.label} [${capability.evidence}]`);
    console.log(`             ${capability.reason}`);
  }
  console.log('\nRelationship support:');
  for (const relation of report.relations) {
    console.log(`  ${relation.status.toUpperCase().padEnd(11)} ${relation.family}`);
    console.log(`             ${relation.establishes}`);
    console.log(`             Does not establish: ${relation.nonClaims.join(' ')}`);
    for (const provider of relation.providerCapabilities) {
      console.log(
        `             ${provider.status.toUpperCase().padEnd(11)} ${provider.id}: ${provider.subtypes.join(', ')}`,
      );
      console.log(`                         ${provider.reason}`);
    }
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
