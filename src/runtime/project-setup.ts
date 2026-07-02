import { existsSync } from 'node:fs';
import type { SupportedLanguage } from '../domain/types.js';
import type { HealthReport } from '../queries/index.js';
import { getIndexerConfig } from '../reindex/indexers.js';
import { getIndexerDependencyStatus, tryInstallIndexer } from '../reindex/install.js';
import { reindex, type ReindexResult } from '../reindex/index.js';
import { setupAgent } from './agent-setup.js';
import { installProjectAgentHooks } from './agent-hooks.js';
import { runIsolatedHealthReport } from './cli-support.js';
import { resolveWatchConfig, validateProjectConfig } from './config.js';
import { resolveCliProjectContext } from './cli-context.js';
import {
  writeProjectHealthDossier,
  formatHealthScoreSummary as formatHealthScore,
  type ProjectSetupHealthDossier,
} from './health-dossier.js';
import { getIndexFreshness } from './index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from './project-readiness.js';
import { installSkills, isScipInstalled } from './setup.js';

type HealthAction = HealthReport['actions'][number];
type IndexFreshness = ReturnType<typeof getIndexFreshness>;
type IndexerDependencyStatus = ReturnType<typeof getIndexerDependencyStatus>;
type InstallSkillsResult = ReturnType<typeof installSkills>;
type ProjectCapabilityReport = ReturnType<typeof getProjectCapabilities>;
type ProjectReadiness = ReturnType<typeof getProjectReadiness>;
type LanguageReadiness = ProjectReadiness['indexers'][number];
type SetupAgentResult = ReturnType<typeof setupAgent>;
type SetupHooksResult = ReturnType<typeof installProjectAgentHooks>;

export type ProjectSetupStepStatus = 'ok' | 'warn' | 'skipped' | 'failed';
export type ProjectSetupVerdict = 'ready' | 'partial' | 'blocked';
export type ProjectSetupSmokeStatus = 'pass' | 'unavailable' | 'fail';

export interface ProjectSetupStep {
  id: string;
  label: string;
  status: ProjectSetupStepStatus;
  message?: string;
  details?: string[];
}

export interface ProjectSetupIssue {
  category: string;
  description: string;
  count: number;
  impact: HealthAction['impact'];
  effort: HealthAction['effort'];
  evidence: HealthAction['evidence'];
  locRecoverable: number;
  confirmationStatus: 'unconfirmed';
  safeForAgentToStart: false;
  recommendedNextStep: string;
}

export interface ProjectSetupHealthSummary {
  score: number | null;
  riskScore: number | null;
  hygieneScore: number | null;
  issuesNeedAttention: ProjectSetupIssue[];
  warnings: string[];
  unavailableReason?: string;
}

export interface ProjectSetupIndexerRemediation {
  language: SupportedLanguage;
  binaryLabel: string;
  attempted: boolean;
  installed: boolean;
  before: LanguageReadiness;
  after: LanguageReadiness;
  messages: string[];
  recovery?: string;
}

export interface ProjectSetupSmokeTest {
  id: string;
  command: string;
  status: ProjectSetupSmokeStatus;
  evidence: string;
}

// scip-query: ignore-stale — exported setup report envelope consumed by the CLI
// JSON surface, health dossier writer, and runtime tests.
export interface ProjectSetupReport {
  projectRoot: string;
  dbPath: string;
  configuredDbPath: string;
  scipCliInstalled: boolean;
  languages: SupportedLanguage[];
  steps: ProjectSetupStep[];
  skills: InstallSkillsResult;
  initialReadiness: ProjectReadiness;
  indexerRemediation: ProjectSetupIndexerRemediation[];
  readiness: ProjectReadiness;
  capabilities: ProjectCapabilityReport;
  freshness: IndexFreshness;
  reindex: ReindexResult | null;
  health: ProjectSetupHealthSummary;
  smokeTests: ProjectSetupSmokeTest[];
  healthDossier: ProjectSetupHealthDossier | null;
  hooks: SetupHooksResult | null;
  setupAgent: SetupAgentResult | null;
  filesWritten: string[];
  verdict: ProjectSetupVerdict;
}

export interface ProjectSetupOptions {
  gitHook?: boolean;
  noHooks?: boolean;
  dossierDir?: string;
}

// scip-query: ignore-extract - setup is a user-facing workflow transcript; the sequence is the behavior.
export async function runProjectSetup(opts: ProjectSetupOptions = {}): Promise<ProjectSetupReport> {
  const steps: ProjectSetupStep[] = [];
  const { projectRoot, config, paths, dbPath } = resolveCliProjectContext();
  const scipCliInstalled = isScipInstalled();

  addStep(steps, {
    id: 'scip-cli',
    label: 'scip CLI',
    status: scipCliInstalled ? 'ok' : 'warn',
    message: scipCliInstalled ? 'scip CLI is available.' : 'scip CLI is not available; reindex may attempt install.',
  });

  const skills = installSkills({ quiet: true });
  addStep(steps, {
    id: 'skills',
    label: 'Agent skills',
    status: skills.skipped.length > 0 ? 'warn' : 'ok',
    message: `${skills.installed.length} installed, ${skills.alreadyLinked.length} already linked, ${skills.pruned.length} pruned, ${skills.skipped.length} skipped.`,
    details: [...skills.pruned.map((entry) => `Pruned ${entry}`), ...skills.skipped.map((entry) => `Skipped ${entry}`)],
  });

  const configDiagnostics = validateProjectConfig(config, { projectRoot });
  const configErrors = configDiagnostics.filter((diagnostic) => diagnostic.level === 'error');
  addStep(steps, {
    id: 'config',
    label: 'Project config',
    status: configErrors.length > 0 ? 'failed' : configDiagnostics.length > 0 ? 'warn' : 'ok',
    message:
      configDiagnostics.length === 0
        ? 'Config OK.'
        : `${configDiagnostics.length} diagnostic(s), ${configErrors.length} error(s).`,
    details: configDiagnostics.map(
      (diagnostic) => `${diagnostic.level.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}`,
    ),
  });

  const watchConfig = resolveWatchConfig(config);
  addStep(steps, {
    id: 'watch-refresh',
    label: 'Watch refresh policy',
    status: watchConfig.autoRefresh === false ? 'skipped' : 'ok',
    message:
      watchConfig.autoRefresh === false
        ? 'Project hooks report freshness but do not auto-refresh stale indexes.'
        : `Project hooks auto-refresh stale indexes; live watch defaults are ${watchConfig.debounceMs}ms debounce, ${watchConfig.cooldownMs}ms cooldown, and ${watchConfig.gitPollMs}ms Git polling.`,
  });

  const initialReadiness = getProjectReadiness(projectRoot, config);
  addStep(steps, {
    id: 'readiness',
    label: 'Indexer readiness',
    status:
      initialReadiness.languages.length === 0
        ? 'failed'
        : initialReadiness.indexers.some((indexer) => !indexer.runnable)
          ? 'warn'
          : 'ok',
    message:
      initialReadiness.languages.length === 0
        ? 'No supported project languages detected.'
        : `Detected languages: ${initialReadiness.languages.join(', ')}`,
    details: initialReadiness.indexers.map((indexer) => {
      const state = indexer.runnable ? 'OK' : indexer.installed ? 'WARN' : 'MISSING';
      return `${state} ${indexer.language}: ${indexer.binaryLabel}${indexer.note ? ` - ${indexer.note}` : ''}`;
    }),
  });

  const indexerRemediation = remediateIndexers(projectRoot, initialReadiness, steps);
  const readyForIndexing = getProjectReadiness(projectRoot, config);

  let reindexResult: ReindexResult | null = null;
  if (readyForIndexing.languages.length === 0 || configErrors.length > 0) {
    addStep(steps, {
      id: 'reindex',
      label: 'Index refresh',
      status: 'skipped',
      message:
        readyForIndexing.languages.length === 0
          ? 'Skipped because no supported languages were detected.'
          : 'Skipped because config validation has errors.',
    });
  } else {
    const reindexMessages: string[] = [];
    try {
      reindexResult = await reindex({
        projectRoot,
        languages: readyForIndexing.languages,
        outputScip: paths.indexPath,
        outputDb: paths.dbPath,
        pnpmWorkspaces: config.indexer?.typescript?.pnpmWorkspaces,
        typescriptProjectMode: config.indexer?.typescript?.projectMode,
        typescriptProjects: config.indexer?.typescript?.projects,
        clojureConfigPath: config.indexer?.clojure?.configPath,
        skipIfUnchanged: true,
        allowPartial: true,
        indexerConcurrency: config.indexerConcurrency,
        trigger: { kind: 'setup', detail: 'scip-query setup' },
        onStatus: (message) => reindexMessages.push(message),
      });
      addStep(steps, {
        id: 'reindex',
        label: 'Index refresh',
        status: reindexResult.skipped.length > 0 ? 'warn' : 'ok',
        message: `${reindexResult.reused ? 'Reused' : 'Indexed'} ${reindexResult.languages.join(', ')} in ${(
          reindexResult.durationMs / 1000
        ).toFixed(1)}s.`,
        details: [
          ...reindexMessages,
          ...reindexResult.skipped.map((entry) => `Skipped ${entry.language}: ${entry.reason}`),
        ],
      });
    } catch (error) {
      addStep(steps, {
        id: 'reindex',
        label: 'Index refresh',
        status: 'failed',
        message: errorMessage(error),
        details: reindexMessages,
      });
    }
  }

  const readiness = getProjectReadiness(projectRoot, config);
  const capabilities = getProjectCapabilities(readiness);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  addStep(steps, {
    id: 'capabilities',
    label: 'Capability matrix',
    status: capabilityStatus(capabilities),
    message: capabilitySummary(capabilities),
  });

  const health = await runSetupHealth(paths.dbPath, steps);

  let hooksResult: SetupHooksResult | null = null;
  try {
    if (opts.noHooks) {
      addStep(steps, {
        id: 'project-hooks',
        label: 'Project agent hooks',
        status: 'skipped',
        message: 'Skipped by --no-hooks.',
      });
    } else {
      hooksResult = installProjectAgentHooks(projectRoot);
      addStep(steps, {
        id: 'project-hooks',
        label: 'Project agent hooks',
        status: hooksResult.skipped.length > 0 ? 'warn' : 'ok',
        message: `${hooksResult.installed.length} installed, ${hooksResult.updated.length} updated, ${hooksResult.unchanged.length} already configured, ${hooksResult.removed.length} hook config(s) cleaned up, ${hooksResult.skipped.length} skipped.`,
        details: [
          ...hooksResult.removed.map((entry) => `Removed ${entry}`),
          ...hooksResult.skipped.map((entry) => `Skipped ${entry.target}: ${entry.reason}`),
        ],
      });
    }
  } catch (error) {
    addStep(steps, {
      id: 'project-hooks',
      label: 'Project agent hooks',
      status: 'failed',
      message: errorMessage(error),
    });
  }

  let agentResult: SetupAgentResult | null = null;
  try {
    agentResult = setupAgent(projectRoot, { gitHook: opts.gitHook });
    addStep(steps, {
      id: 'agent-guidance',
      label: 'Project agent guidance',
      status: agentResult.skipped.length > 0 ? 'warn' : 'ok',
      message: `${agentResult.written.length} written, ${agentResult.unchanged.length} already wired, ${agentResult.skipped.length} skipped.`,
      details: agentResult.skipped.map((entry) => `Skipped ${entry.target}: ${entry.reason}`),
    });
  } catch (error) {
    addStep(steps, {
      id: 'agent-guidance',
      label: 'Project agent guidance',
      status: 'failed',
      message: errorMessage(error),
    });
  }

  const smokeTests = buildSetupSmokeTests({
    reindexResult,
    readiness,
    capabilities,
    freshness,
    health,
    hooksResult,
    agentResult,
    steps,
  });
  addStep(steps, {
    id: 'smoke-tests',
    label: 'Setup smoke tests',
    status: smokeStepStatus(smokeTests),
    message: smokeStepSummary(smokeTests),
    details: smokeTests.map((test) => `${test.command}: ${test.status} - ${test.evidence}`),
  });

  const report: ProjectSetupReport = {
    projectRoot,
    dbPath,
    configuredDbPath: paths.dbPath,
    scipCliInstalled,
    languages: readiness.languages,
    steps,
    skills,
    initialReadiness,
    indexerRemediation,
    readiness,
    capabilities,
    freshness,
    reindex: reindexResult,
    health,
    smokeTests,
    healthDossier: null,
    hooks: hooksResult,
    setupAgent: agentResult,
    filesWritten: agentResult?.written ?? [],
    verdict: setupVerdict(steps, readiness),
  };

  const healthDossier = writeProjectHealthDossier(report, { dossierDir: opts.dossierDir });
  report.healthDossier = healthDossier;
  report.filesWritten = [...report.filesWritten, ...healthDossier.written];
  addStep(steps, {
    id: 'health-dossier',
    label: 'Health dossier',
    status: healthDossier.status === 'failed' ? 'failed' : 'ok',
    message:
      healthDossier.status === 'failed'
        ? healthDossier.error
        : `${healthDossier.written.length} written, ${healthDossier.unchanged.length} unchanged.`,
    details: [healthDossier.markdownPath, healthDossier.jsonPath],
  });
  report.verdict = setupVerdict(steps, readiness);
  return report;
}

export function renderProjectSetupReport(report: ProjectSetupReport): void {
  console.log('scip-query setup');
  console.log(`Project: ${report.projectRoot}`);
  console.log(`Verdict: ${report.verdict}`);
  console.log(`Health score: ${formatHealthScore(report.health)}`);
  console.log('');

  if (report.health.issuesNeedAttention.length === 0) {
    console.log('Items that need attention: none reported by the health pass.');
  } else {
    console.log('Items that need attention:');
    for (const issue of report.health.issuesNeedAttention) {
      console.log(
        `  - ${issue.category}: ${issue.description} (${issue.count}; impact ${issue.impact}, effort ${issue.effort})`,
      );
    }
  }

  if (report.health.unavailableReason) {
    console.log(`Health pass: ${report.health.unavailableReason}`);
  }
  if (report.health.warnings.length > 0) {
    console.log('Health warnings:');
    for (const warning of report.health.warnings) console.log(`  - ${warning}`);
  }
  if (report.healthDossier) {
    console.log(`Health dossier: ${report.healthDossier.markdownPath}`);
  }

  console.log('');
  console.log('Setup steps:');
  for (const step of report.steps) {
    console.log(`  ${step.status.toUpperCase()} ${step.label}${step.message ? ` - ${step.message}` : ''}`);
  }

  console.log('');
  console.log('Smoke tests:');
  for (const test of report.smokeTests) {
    console.log(`  ${test.status.toUpperCase()} ${test.command} - ${test.evidence}`);
  }

  if (report.indexerRemediation.length > 0) {
    console.log('');
    console.log('Indexer remediation:');
    for (const remediation of report.indexerRemediation) {
      const state = remediation.after.runnable ? 'ready' : 'blocked';
      const attempted = remediation.attempted ? 'attempted install' : 'manual action required';
      console.log(`  - ${remediation.language}: ${state} (${attempted})`);
      if (remediation.recovery) console.log(`    ${remediation.recovery}`);
    }
  }
}

function buildSetupSmokeTests(opts: {
  reindexResult: ReindexResult | null;
  readiness: ProjectReadiness;
  capabilities: ProjectCapabilityReport;
  freshness: IndexFreshness;
  health: ProjectSetupHealthSummary;
  hooksResult: SetupHooksResult | null;
  agentResult: SetupAgentResult | null;
  steps: readonly ProjectSetupStep[];
}): ProjectSetupSmokeTest[] {
  const reindexStep = opts.steps.find((step) => step.id === 'reindex');
  const hooksStep = opts.steps.find((step) => step.id === 'project-hooks');
  const agentStep = opts.steps.find((step) => step.id === 'agent-guidance');
  const watchStep = opts.steps.find((step) => step.id === 'watch-refresh');
  return [
    {
      id: 'reindex',
      command: 'scip-query reindex',
      status: opts.reindexResult ? 'pass' : reindexStep?.status === 'failed' ? 'fail' : 'unavailable',
      evidence: opts.reindexResult
        ? `${opts.reindexResult.languages.join(', ')} indexed${opts.reindexResult.reused ? ' from cache' : ''}.`
        : (reindexStep?.message ?? 'No reindex result was produced.'),
    },
    {
      id: 'status',
      command: 'scip-query status',
      status: opts.freshness.state === 'missing' ? 'fail' : 'pass',
      evidence: `Index freshness is ${opts.freshness.state}: ${opts.freshness.reason}`,
    },
    {
      id: 'config-validate',
      command: 'scip-query config-validate',
      status: configValidationSmokeStatus(opts.steps),
      evidence: configValidationSmokeEvidence(opts.steps),
    },
    {
      id: 'capabilities',
      command: 'scip-query capabilities',
      status: opts.capabilities.matrix.length > 0 ? 'pass' : 'unavailable',
      evidence:
        opts.capabilities.matrix.length > 0
          ? `${opts.capabilities.matrix.length} language capability row(s) available.`
          : 'No detected languages produced capability rows.',
    },
    {
      id: 'capability-matrix',
      command: 'scip-query capability-matrix --json',
      status: opts.capabilities.matrix.length > 0 ? 'pass' : 'unavailable',
      evidence:
        opts.capabilities.matrix.length > 0
          ? capabilityMatrixSmokeEvidence(opts.capabilities)
          : 'No detected languages produced capability rows.',
    },
    {
      id: 'health',
      command: 'scip-query health',
      status: opts.health.score === null ? 'unavailable' : 'pass',
      evidence:
        opts.health.score === null
          ? (opts.health.unavailableReason ?? 'Health report was not available.')
          : `Health score ${opts.health.score}.`,
    },
    {
      id: 'diff-impact',
      command: 'scip-query diff-impact --json',
      status: gitBackedSmokeStatus(opts.readiness, opts.freshness),
      evidence: gitBackedSmokeEvidence(opts.readiness, opts.freshness),
    },
    {
      id: 'diff-gate',
      command: 'scip-query diff-gate --json',
      status: gitBackedSmokeStatus(opts.readiness, opts.freshness),
      evidence: gitBackedSmokeEvidence(opts.readiness, opts.freshness),
    },
    {
      id: 'cleanup-verification',
      command: 'scip-query cleanup-plan --verify',
      status: cleanupVerificationSmokeStatus(opts.capabilities),
      evidence: cleanupVerificationSmokeEvidence(opts.capabilities),
    },
    {
      id: 'setup-hooks',
      command: 'scip-query setup-hooks',
      status: opts.hooksResult ? 'pass' : hooksStep?.status === 'failed' ? 'fail' : 'unavailable',
      evidence: opts.hooksResult
        ? `${opts.hooksResult.installed.length} installed, ${opts.hooksResult.updated.length} updated, ${opts.hooksResult.unchanged.length} already configured.`
        : (hooksStep?.message ?? 'Project agent hooks were not configured.'),
    },
    {
      id: 'watch-refresh',
      command: `printf %s '{"hook_event_name":"SessionStart"}' | scip-query hook-context`,
      status: watchStep?.status === 'ok' ? 'pass' : 'unavailable',
      evidence: watchStep?.message ?? 'Watch refresh policy was not evaluated.',
    },
    {
      id: 'setup-agent',
      command: 'scip-query setup-agent',
      status: opts.agentResult ? 'pass' : agentStep?.status === 'failed' ? 'fail' : 'unavailable',
      evidence: opts.agentResult
        ? `${opts.agentResult.written.length} written, ${opts.agentResult.unchanged.length} already wired, ${opts.agentResult.skipped.length} skipped.`
        : (agentStep?.message ?? 'Project agent guidance was not written.'),
    },
  ];
}

function smokeStepStatus(smokeTests: readonly ProjectSetupSmokeTest[]): ProjectSetupStepStatus {
  if (smokeTests.some((test) => test.status === 'fail')) return 'failed';
  if (smokeTests.some((test) => test.status === 'unavailable')) return 'warn';
  return 'ok';
}

function smokeStepSummary(smokeTests: readonly ProjectSetupSmokeTest[]): string {
  const passed = smokeTests.filter((test) => test.status === 'pass').length;
  const unavailable = smokeTests.filter((test) => test.status === 'unavailable').length;
  const failed = smokeTests.filter((test) => test.status === 'fail').length;
  return `${passed} passed, ${unavailable} unavailable, ${failed} failed.`;
}

function configValidationSmokeStatus(steps: readonly ProjectSetupStep[]): ProjectSetupSmokeStatus {
  const configStep = steps.find((step) => step.id === 'config');
  if (configStep?.status === 'failed') return 'fail';
  return 'pass';
}

function configValidationSmokeEvidence(steps: readonly ProjectSetupStep[]): string {
  const configStep = steps.find((step) => step.id === 'config');
  return configStep?.message ?? 'Config diagnostics were not produced.';
}

function capabilityMatrixSmokeEvidence(capabilities: ProjectCapabilityReport): string {
  const unavailableRows = capabilities.matrix.filter((row) =>
    [row.indexing, row.sourceFacts, row.semantic, row.cleanupVerification].some(
      (capability) => capability.status === 'unavailable',
    ),
  ).length;
  return `${capabilities.matrix.length} language row(s), ${unavailableRows} with unavailable capability cells.`;
}

function gitBackedSmokeStatus(readiness: ProjectReadiness, freshness: IndexFreshness): ProjectSetupSmokeStatus {
  if (!readiness.gitAvailable) return 'unavailable';
  return freshness.state === 'missing' ? 'fail' : 'pass';
}

function gitBackedSmokeEvidence(readiness: ProjectReadiness, freshness: IndexFreshness): string {
  if (!readiness.gitAvailable) return 'Git is not available for this project.';
  const refresh = freshness.lastRefresh
    ? ` Last refresh: ${freshness.lastRefresh.result} by ${freshness.lastRefresh.trigger.kind} at ${freshness.lastRefresh.completedAt}.`
    : '';
  return `Git is available and index freshness is ${freshness.state}: ${freshness.reason}${refresh}`;
}

function cleanupVerificationSmokeStatus(capabilities: ProjectCapabilityReport): ProjectSetupSmokeStatus {
  const statuses = capabilities.matrix.map((row) => row.cleanupVerification.status);
  if (statuses.some((status) => status === 'available')) return 'pass';
  if (statuses.some((status) => status === 'partial')) return 'pass';
  return 'unavailable';
}

function cleanupVerificationSmokeEvidence(capabilities: ProjectCapabilityReport): string {
  if (capabilities.matrix.length === 0) return 'No detected languages produced capability rows.';
  const available = capabilities.matrix.filter((row) => row.cleanupVerification.status === 'available').length;
  const partial = capabilities.matrix.filter((row) => row.cleanupVerification.status === 'partial').length;
  const unavailable = capabilities.matrix.filter((row) => row.cleanupVerification.status === 'unavailable').length;
  return `${available} available, ${partial} partial, ${unavailable} unavailable cleanup-verification row(s).`;
}

function remediateIndexers(
  projectRoot: string,
  readiness: ProjectReadiness,
  steps: ProjectSetupStep[],
): ProjectSetupIndexerRemediation[] {
  const remediations: ProjectSetupIndexerRemediation[] = [];
  if (readiness.languages.length === 0) {
    addStep(steps, {
      id: 'indexer-remediation',
      label: 'Indexer remediation',
      status: 'skipped',
      message: 'Skipped because no supported languages were detected.',
    });
    return remediations;
  }

  for (const status of readiness.indexers) {
    if (status.runnable) continue;

    const config = getIndexerConfig(status.language);
    const messages: string[] = [];
    const attempted = !status.installed && Boolean(config.installMethods?.length);
    let installed = false;

    if (attempted) {
      installed = tryInstallIndexer(config, (message) => messages.push(message));
    } else if (status.installed) {
      messages.push(status.note ?? `${status.binaryLabel} is installed but is not runnable.`);
    } else if (!config.installMethods?.length) {
      messages.push(`No auto-install method is configured for ${status.binaryLabel}.`);
    }

    const after = languageReadinessFromDependencyStatus(getIndexerDependencyStatus(config, projectRoot));
    remediations.push({
      language: status.language,
      binaryLabel: status.binaryLabel,
      attempted,
      installed,
      before: status,
      after,
      messages,
      recovery: after.runnable
        ? undefined
        : (after.note ?? after.installUrl ?? `Install ${status.binaryLabel} and put it on PATH.`),
    });
  }

  if (remediations.length === 0) {
    addStep(steps, {
      id: 'indexer-remediation',
      label: 'Indexer remediation',
      status: 'ok',
      message: 'All detected indexers are runnable.',
    });
    return remediations;
  }

  const blocked = remediations.filter((entry) => !entry.after.runnable);
  const attempted = remediations.filter((entry) => entry.attempted);
  addStep(steps, {
    id: 'indexer-remediation',
    label: 'Indexer remediation',
    status: blocked.length > 0 ? 'warn' : 'ok',
    message:
      blocked.length === 0
        ? `${attempted.length} install attempt(s); all detected indexers are runnable.`
        : `${attempted.length} install attempt(s); ${blocked.length} indexer(s) still blocked.`,
    details: remediations.flatMap((entry) => [
      `${entry.language}: ${entry.after.runnable ? 'ready' : 'blocked'}`,
      ...entry.messages,
    ]),
  });
  return remediations;
}

function languageReadinessFromDependencyStatus(status: IndexerDependencyStatus): LanguageReadiness {
  return {
    ...status,
    resolvedBinary: status.resolvedBinary ?? undefined,
  };
}

async function runSetupHealth(dbPath: string, steps: ProjectSetupStep[]): Promise<ProjectSetupHealthSummary> {
  if (!existsSync(dbPath)) {
    const unavailableReason = 'Skipped because no SQLite index database exists yet.';
    addStep(steps, {
      id: 'health',
      label: 'Health audit',
      status: 'skipped',
      message: unavailableReason,
    });
    return emptyHealthSummary(unavailableReason);
  }

  try {
    const report = await runIsolatedHealthReport({ full: true, json: true });
    addStep(steps, {
      id: 'health',
      label: 'Health audit',
      status: 'ok',
      message: `Health score ${report.score}. ${report.actions.length} prioritized action(s).`,
    });
    return healthSummary(report);
  } catch (error) {
    const unavailableReason = errorMessage(error);
    addStep(steps, {
      id: 'health',
      label: 'Health audit',
      status: 'failed',
      message: unavailableReason,
    });
    return emptyHealthSummary(unavailableReason);
  }
}

function healthSummary(report: HealthReport): ProjectSetupHealthSummary {
  return {
    score: report.score,
    riskScore: report.riskScore,
    hygieneScore: report.hygieneScore,
    issuesNeedAttention: report.actions.map(projectSetupIssue),
    warnings: report.warnings ?? [],
  };
}

function projectSetupIssue(action: HealthAction): ProjectSetupIssue {
  return {
    category: action.category,
    description: action.description,
    count: action.count,
    impact: action.impact,
    effort: action.effort,
    evidence: action.evidence,
    locRecoverable: action.locRecoverable,
    confirmationStatus: 'unconfirmed',
    safeForAgentToStart: false,
    recommendedNextStep:
      'Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.',
  };
}

function emptyHealthSummary(unavailableReason: string): ProjectSetupHealthSummary {
  return {
    score: null,
    riskScore: null,
    hygieneScore: null,
    issuesNeedAttention: [],
    warnings: [],
    unavailableReason,
  };
}

function setupVerdict(steps: readonly ProjectSetupStep[], readiness: ProjectReadiness): ProjectSetupVerdict {
  if (steps.some((step) => step.status === 'failed')) return 'blocked';
  if (readiness.indexers.some((indexer) => !indexer.runnable)) return 'partial';
  if (steps.some((step) => step.status === 'warn' || step.status === 'skipped')) return 'partial';
  return 'ready';
}

function capabilityStatus(capabilities: ProjectCapabilityReport): ProjectSetupStepStatus {
  const statuses = capabilities.matrix.flatMap((row) => [
    row.indexing.status,
    row.sourceFacts.status,
    row.semantic.status,
    row.cleanupVerification.status,
  ]);
  if (statuses.some((status) => status === 'unavailable')) return 'warn';
  if (statuses.some((status) => status === 'partial')) return 'warn';
  return 'ok';
}

function capabilitySummary(capabilities: ProjectCapabilityReport): string {
  if (capabilities.matrix.length === 0) return 'No language capability rows.';
  const available = capabilities.matrix.filter((row) => row.indexing.status === 'available').length;
  return `${available}/${capabilities.matrix.length} language(s) have available indexing.`;
}

function addStep(steps: ProjectSetupStep[], step: ProjectSetupStep): void {
  steps.push({
    ...step,
    details: step.details?.filter((detail) => detail.trim() !== ''),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
