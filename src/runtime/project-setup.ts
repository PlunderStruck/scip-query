import { existsSync } from 'node:fs';
import type { ProjectConfig, SupportedLanguage } from '../domain/types.js';
import type { HealthReport } from '../queries/index.js';
import { getIndexerDependencyStatus } from '../platform/indexer-toolchain.js';
import { getIndexerConfig } from '../reindex/indexers.js';
import { tryInstallIndexer } from '../reindex/install.js';
import { reindex, type ReindexResult } from '../reindex/index.js';
import { rustSemanticSessionStatus, type RustSemanticSessionStatus } from '../semantic/rust/lsp-session.js';
import { setupAgent } from './agent-setup.js';
import { cliVersion, runIsolatedHealthReport } from './cli-support.js';
import {
  configureProjectAutomaticRefresh,
  configureProjectLanguages,
  ensureProjectCollaborationDomain,
  resolveWatchConfig,
  validateProjectConfig,
  type ProjectAutomaticRefreshConfigResult,
} from './config.js';
import { resolveCliProjectContext } from './cli-context.js';
import {
  writeProjectHealthDossier,
  formatHealthScoreSummary as formatHealthScore,
  type ProjectSetupHealthDossier,
} from './health-dossier.js';
import { getIndexFreshness, type IndexFreshness } from './index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from './project-readiness.js';
import { installSkills, isScipInstalled } from './setup.js';
import { ensureWatchService, type WatchServiceEnsureResult } from './watch-service.js';
import { setupAstParsers, type AstParserSetupResult } from './ast-parser-setup.js';

type HealthAction = HealthReport['actions'][number];
type IndexerDependencyStatus = ReturnType<typeof getIndexerDependencyStatus>;
type InstallSkillsResult = ReturnType<typeof installSkills>;
type ProjectCapabilityReport = ReturnType<typeof getProjectCapabilities>;
type ProjectReadiness = ReturnType<typeof getProjectReadiness>;
type LanguageReadiness = ProjectReadiness['indexers'][number];
type SetupAgentResult = ReturnType<typeof setupAgent>;

export type ProjectSetupStepStatus = 'ok' | 'warn' | 'skipped' | 'failed';
export type ProjectSetupVerdict = 'ready' | 'partial' | 'blocked';
export type ProjectSetupSmokeStatus = 'pass' | 'unavailable' | 'fail';

export function validateSetupInteractionMode(opts: {
  guided: boolean;
  yes: boolean;
  json: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}): void {
  if (!opts.guided) return;
  if (opts.yes) throw new Error('--guided cannot be combined with --yes; choose interactive or automatic setup.');
  if (opts.json)
    throw new Error('--guided cannot be combined with --json; the interactive checklist emits human output.');
  if (!opts.stdinIsTty || !opts.stdoutIsTty) {
    throw new Error('--guided requires an interactive terminal; use --yes for non-interactive setup.');
  }
}

export interface ProjectSetupStep {
  id: string;
  label: string;
  status: ProjectSetupStepStatus;
  optional?: boolean;
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
  optional?: boolean;
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
  astParsers: AstParserSetupResult;
  initialReadiness: ProjectReadiness;
  indexerRemediation: ProjectSetupIndexerRemediation[];
  readiness: ProjectReadiness;
  capabilities: ProjectCapabilityReport;
  freshness: IndexFreshness;
  reindex: ReindexResult | null;
  automaticRefreshConfig: ProjectAutomaticRefreshConfigResult | null;
  watchService: WatchServiceEnsureResult | null;
  rustSemanticSession: RustSemanticSessionStatus | null;
  health: ProjectSetupHealthSummary;
  smokeTests: ProjectSetupSmokeTest[];
  healthDossier: ProjectSetupHealthDossier | null;
  setupAgent: SetupAgentResult | null;
  changeScopes: ProjectSetupChangeScopes;
  filesWritten: string[];
  verdict: ProjectSetupVerdict;
}

export interface ProjectSetupChangeScopes {
  repository: string[];
  checkout: string[];
  user: string[];
}

// scip-query: ignore-stale — reviewed S1 owned contract; these options define the project-setup command boundary.
export interface ProjectSetupOptions {
  noAgentGuidance?: boolean;
  automaticRefresh?: boolean;
  installIndexers?: boolean;
  dossierDir?: string;
  languages?: readonly SupportedLanguage[];
  installSkills?: boolean;
  installAstParsers?: boolean;
  runHealth?: boolean;
  onStatus?: (message: string) => void;
}

export type ProjectSetupGuidedActionId =
  | 'create-agent-guidance'
  | 'update-agent-guidance'
  | 'enable-automatic-refresh'
  | 'install-indexers'
  | 'install-agent-skills'
  | 'run-health-analysis';

export type ProjectSetupActionScope = 'repository' | 'checkout' | 'user';

// scip-query: ignore-stale — reviewed S1 owned contract; guided setup constructs this file-selection payload.
export interface ProjectSetupGuidedFiles {
  agentsMd: boolean;
  claudeMd: boolean;
}

// scip-query: ignore-stale — reviewed S1 owned contract; guided setup renders this discriminated action payload.
export interface ProjectSetupGuidedAction {
  id: ProjectSetupGuidedActionId;
  scope: ProjectSetupActionScope;
  label: string;
  recommended: boolean;
  requiresConsent: true;
  reason: string;
  command?: string;
}

export interface ProjectSetupGuidedPlan {
  actions: ProjectSetupGuidedAction[];
}

export function planGuidedProjectSetup(input: {
  files: ProjectSetupGuidedFiles;
  watchEnabled: boolean;
  readiness: Pick<ProjectReadiness, 'indexers'>;
}): ProjectSetupGuidedPlan {
  const actions: ProjectSetupGuidedAction[] = [];

  if (!input.watchEnabled) {
    actions.push({
      id: 'enable-automatic-refresh',
      scope: 'repository',
      label: 'Enable automatic incremental indexing',
      recommended: true,
      requiresConsent: true,
      reason: 'A demand-started project service keeps indexes current and exits after a clean idle period.',
      command: 'scip-query setup',
    });
  }

  if (input.files.agentsMd || input.files.claudeMd) {
    actions.push({
      id: 'update-agent-guidance',
      scope: 'repository',
      label: 'Update project agent guidance',
      recommended: true,
      requiresConsent: true,
      reason: 'Existing AGENTS.md or CLAUDE.md guidance can be updated in place.',
      command: 'scip-query setup-agent',
    });
  } else {
    actions.push({
      id: 'create-agent-guidance',
      scope: 'repository',
      label: 'Create project agent guidance',
      recommended: false,
      requiresConsent: true,
      reason: 'No AGENTS.md or CLAUDE.md file exists, so setup should ask before creating one.',
      command: 'scip-query setup-agent',
    });
  }

  const blockedIndexers = input.readiness.indexers.filter((indexer) => !indexer.runnable);
  if (blockedIndexers.length > 0) {
    actions.push({
      id: 'install-indexers',
      scope: 'user',
      label: 'Install missing language indexers',
      recommended: true,
      requiresConsent: true,
      reason: `${blockedIndexers.length} detected language indexer(s) are not runnable.`,
      command: 'scip-query setup --install-missing',
    });
  }

  return { actions };
}

// scip-query: ignore-extract — reviewed E1 workflow owner; setup sequencing, recovery, and reporting stay together.
export async function runProjectSetup(opts: ProjectSetupOptions = {}): Promise<ProjectSetupReport> {
  const steps: ProjectSetupStep[] = [];
  const context = resolveCliProjectContext();
  const { projectRoot, paths, dbPath } = context;
  const automaticRefresh = opts.automaticRefresh ?? context.config.watch?.enabled ?? true;
  const initialConfigDiagnostics = validateProjectConfig(context.config, { projectRoot });
  const initialConfigErrors = initialConfigDiagnostics.filter((diagnostic) => diagnostic.level === 'error');
  let collaborationConfig: ProjectAutomaticRefreshConfigResult | null = null;
  let collaborationConfigError: string | null = null;
  if (initialConfigErrors.length === 0 && !context.config.collaborationDomainId) {
    try {
      collaborationConfig = ensureProjectCollaborationDomain(projectRoot, context.config);
    } catch (error) {
      collaborationConfigError = errorMessage(error);
    }
  }
  const collaborationReadyConfig = collaborationConfig?.config ?? context.config;
  const languageConfig = opts.languages
    ? configureProjectLanguages(projectRoot, collaborationReadyConfig, opts.languages)
    : null;
  const startingConfig = languageConfig?.config ?? collaborationReadyConfig;
  const existingConfigDiagnostics = validateProjectConfig(startingConfig, { projectRoot });
  const existingConfigErrors = existingConfigDiagnostics.filter((diagnostic) => diagnostic.level === 'error');
  let automaticRefreshConfig: ProjectAutomaticRefreshConfigResult | null = null;
  let automaticRefreshError: string | null = null;
  if (existingConfigErrors.length === 0 && startingConfig.watch?.enabled !== automaticRefresh) {
    try {
      automaticRefreshConfig = configureProjectAutomaticRefresh(projectRoot, startingConfig, automaticRefresh);
    } catch (error) {
      automaticRefreshError = errorMessage(error);
    }
  }
  const config = automaticRefreshConfig?.config ?? startingConfig;
  const scipCliInstalled = isScipInstalled();

  addStep(steps, {
    id: 'collaboration-domain-config',
    label: 'Collaboration domain',
    status: collaborationConfigError !== null ? 'failed' : initialConfigErrors.length > 0 ? 'skipped' : 'ok',
    message:
      collaborationConfigError ??
      (initialConfigErrors.length > 0
        ? 'Skipped because the existing project config has validation errors.'
        : collaborationConfig?.changed
          ? 'Generated the committed identity shared by merge-intended branches, clones, and forks.'
          : 'The committed collaboration-domain identity is already present.'),
    ...(collaborationConfig ? { details: [collaborationConfig.configPath] } : {}),
  });

  addStep(steps, {
    id: 'automatic-indexing-config',
    label: 'Automatic indexing config',
    status:
      automaticRefreshError !== null
        ? 'failed'
        : existingConfigErrors.length > 0 || !automaticRefresh
          ? 'skipped'
          : 'ok',
    message:
      automaticRefreshError ??
      (existingConfigErrors.length > 0
        ? 'Skipped because the existing project config has validation errors.'
        : automaticRefresh
          ? automaticRefreshConfig?.changed
            ? 'Enabled demand-started automatic incremental indexing for this project.'
            : 'Demand-started automatic incremental indexing is already enabled.'
          : 'Automatic incremental indexing remains explicitly disabled for this project.'),
    ...(automaticRefreshConfig ? { details: [automaticRefreshConfig.configPath] } : {}),
  });

  addStep(steps, {
    id: 'scip-cli',
    label: 'scip CLI',
    status: scipCliInstalled ? 'ok' : 'warn',
    message: scipCliInstalled
      ? 'scip CLI is available.'
      : 'scip CLI is not available; installation requires explicit --install-missing consent.',
  });

  const skills =
    opts.installSkills === false
      ? { installed: [], skipped: [], alreadyLinked: [], pruned: [] }
      : installSkills({ quiet: true });
  addStep(steps, {
    id: 'skills',
    label: 'Agent skills',
    status: opts.installSkills === false ? 'skipped' : skills.skipped.length > 0 ? 'warn' : 'ok',
    message:
      opts.installSkills === false
        ? 'Skipped by setup choice.'
        : `${skills.installed.length} installed, ${skills.alreadyLinked.length} already linked, ${skills.pruned.length} pruned, ${skills.skipped.length} skipped.`,
    details: [...skills.pruned.map((entry) => `Pruned ${entry}`), ...skills.skipped.map((entry) => `Skipped ${entry}`)],
  });

  const configDiagnostics = automaticRefreshConfig
    ? validateProjectConfig(config, { projectRoot })
    : existingConfigDiagnostics;
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

  const astParsers =
    opts.installAstParsers !== true
      ? {
          supportedLanguages: [],
          availableBefore: [],
          installed: [],
          availableAfter: [],
          unavailable: [],
          attempted: false,
        }
      : setupAstParsers(initialReadiness.languages);
  addStep(steps, {
    id: 'ast-parsers',
    label: 'AST parser packages',
    status: opts.installAstParsers !== true ? 'skipped' : astParsers.unavailable.length > 0 ? 'warn' : 'ok',
    message:
      opts.installAstParsers !== true
        ? 'Skipped because installing missing parser packages requires explicit consent.'
        : astParsers.supportedLanguages.length === 0
          ? 'No selected language uses a bundled Tree-sitter parser.'
          : `${astParsers.availableAfter.length}/${astParsers.supportedLanguages.length} selected language parser(s) available${astParsers.installed.length > 0 ? `; installed ${astParsers.installed.join(', ')}` : ''}.`,
    details: [
      ...(astParsers.unavailable.length > 0 ? [`Unavailable: ${astParsers.unavailable.join(', ')}`] : []),
      ...(astParsers.error ? [astParsers.error] : []),
    ],
  });

  const installIndexers = opts.installIndexers === true;
  const indexerRemediation = installIndexers ? remediateIndexers(projectRoot, initialReadiness, steps) : [];
  if (!installIndexers) {
    addStep(steps, {
      id: 'indexer-remediation',
      label: 'Indexer remediation',
      status: 'skipped',
      message: 'Skipped because installing missing indexers requires explicit consent.',
    });
  }
  const readyForIndexing = getProjectReadiness(projectRoot, config);

  const refreshed = await refreshSetupIndex({
    projectRoot,
    paths,
    config,
    readiness: readyForIndexing,
    configHasErrors: configErrors.length > 0,
    steps,
    onStatus: opts.onStatus,
    installMissing: opts.installIndexers === true,
  });
  const reindexResult = refreshed.reindexResult;
  const postReindexFreshness = refreshed.freshness;

  const watchConfig = resolveWatchConfig(config);
  const watchService = startSetupWatchService({
    projectRoot,
    cacheDir: paths.cacheDir,
    watchConfig,
    readiness: readyForIndexing,
    configHasErrors: configErrors.length > 0,
    reindexResult,
    postReindexFreshness,
    steps,
  });

  const readiness = getProjectReadiness(projectRoot, config);
  const capabilities = getProjectCapabilities(readiness);
  const freshness = getIndexFreshness(projectRoot, config, paths);
  addStep(steps, {
    id: 'capabilities',
    label: 'Capability matrix',
    status: capabilityStatus(capabilities),
    message: capabilitySummary(capabilities),
  });

  opts.onStatus?.(
    opts.runHealth === true ? 'Running optional full health audit…' : 'Skipping optional full health audit.',
  );
  const health = opts.runHealth === true ? await runSetupHealth(paths.dbPath, steps) : skippedSetupHealth(steps);
  const rustSemanticSession = readiness.languages.includes('rust')
    ? rustSemanticSessionStatus(projectRoot, process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'])
    : null;
  addStep(steps, {
    id: 'rust-semantic-session',
    label: 'Rust semantic session',
    status: rustSemanticSession === null ? 'skipped' : rustSemanticSession.valid ? 'ok' : 'failed',
    // A language service the detected project cannot use is not missing readiness.
    optional: rustSemanticSession === null,
    message:
      rustSemanticSession === null
        ? 'Skipped because Rust was not detected.'
        : `${rustSemanticSession.transport}/${rustSemanticSession.state} selected from ${rustSemanticSession.source}; ${rustSemanticSession.fallback} fallback; opt out with ${rustSemanticSession.optOut}.`,
  });

  let agentResult: SetupAgentResult | null = null;
  try {
    if (opts.noAgentGuidance) {
      addStep(steps, {
        id: 'agent-guidance',
        label: 'Project agent guidance',
        status: 'skipped',
        message: 'Skipped by guided setup choice.',
      });
    } else {
      agentResult = setupAgent(projectRoot);
      addStep(steps, {
        id: 'agent-guidance',
        label: 'Project agent guidance',
        status: agentResult.skipped.length > 0 ? 'warn' : 'ok',
        message: `${agentResult.written.length} written, ${agentResult.unchanged.length} already wired, ${agentResult.skipped.length} skipped.`,
        details: agentResult.skipped.map((entry) => `Skipped ${entry.target}: ${entry.reason}`),
      });
    }
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
    healthSelected: opts.runHealth === true,
    agentResult,
    watchConfig,
    watchService,
    rustSemanticSession,
    steps,
  });
  addStep(steps, {
    id: 'smoke-tests',
    label: 'Setup smoke tests',
    status: smokeStepStatus(smokeTests),
    message: smokeStepSummary(smokeTests),
    details: smokeTests.map((test) => `${test.command}: ${test.status} - ${test.evidence}`),
  });

  const changeScopes: ProjectSetupChangeScopes = {
    repository: [
      ...(languageConfig?.changed ? [languageConfig.configPath] : []),
      ...(automaticRefreshConfig?.changed ? [automaticRefreshConfig.configPath] : []),
      ...(agentResult?.written ?? []),
    ],
    checkout: [],
    user: [
      ...skills.installed,
      ...astParsers.installed,
      ...indexerRemediation.filter((entry) => entry.attempted).map((entry) => `${entry.binaryLabel} installer`),
    ],
  };
  const report: ProjectSetupReport = {
    projectRoot,
    dbPath,
    configuredDbPath: paths.dbPath,
    scipCliInstalled,
    languages: readiness.languages,
    steps,
    skills,
    astParsers,
    initialReadiness,
    indexerRemediation,
    readiness,
    capabilities,
    freshness,
    reindex: reindexResult,
    automaticRefreshConfig,
    watchService,
    rustSemanticSession,
    health,
    smokeTests,
    healthDossier: null,
    setupAgent: agentResult,
    changeScopes,
    filesWritten: agentResult?.written ?? [],
    verdict: setupVerdict(steps, readiness),
  };

  if (opts.runHealth !== true) {
    addStep(steps, {
      id: 'health-dossier',
      label: 'Health dossier',
      status: 'skipped',
      optional: true,
      message: 'Skipped because the optional health audit was not selected.',
    });
    report.verdict = setupVerdict(steps, readiness);
    return report;
  }
  const healthDossier = writeProjectHealthDossier(report, { dossierDir: opts.dossierDir });
  report.healthDossier = healthDossier;
  report.changeScopes.repository.push(...healthDossier.written);
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

interface SetupIndexRefreshInput {
  projectRoot: string;
  paths: ReturnType<typeof resolveCliProjectContext>['paths'];
  config: ProjectConfig;
  readiness: ProjectReadiness;
  configHasErrors: boolean;
  steps: ProjectSetupStep[];
  onStatus?: (message: string) => void;
  installMissing: boolean;
}

async function refreshSetupIndex(
  input: SetupIndexRefreshInput,
): Promise<{ reindexResult: ReindexResult | null; freshness: IndexFreshness | null }> {
  if (input.readiness.languages.length === 0 || input.configHasErrors) {
    addStep(input.steps, {
      id: 'reindex',
      label: 'Index refresh',
      status: 'skipped',
      message:
        input.readiness.languages.length === 0
          ? 'Skipped because no supported languages were detected.'
          : 'Skipped because config validation has errors.',
    });
    return { reindexResult: null, freshness: null };
  }

  const messages: string[] = [];
  let reindexResult: ReindexResult | null = null;
  let freshness: IndexFreshness | null = null;
  try {
    let totalDurationMs = 0;
    let rebuilt = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reindexResult = await reindex({
        projectRoot: input.projectRoot,
        languages: input.readiness.languages,
        outputScip: input.paths.indexPath,
        outputDb: input.paths.dbPath,
        pnpmWorkspaces: input.config.indexer?.typescript?.pnpmWorkspaces,
        typescriptProjectMode: input.config.indexer?.typescript?.projectMode,
        typescriptProjects: input.config.indexer?.typescript?.projects,
        maxHeapMb: input.config.indexer?.typescript?.maxHeapMb,
        clojureConfigPath: input.config.indexer?.clojure?.configPath,
        skipIfUnchanged: true,
        allowPartial: true,
        installMissing: input.installMissing,
        indexerConcurrency: input.config.indexerConcurrency,
        trigger: { kind: 'setup', detail: 'scip-query setup' },
        onStatus: (message) => {
          messages.push(message);
          input.onStatus?.(message);
        },
      });
      totalDurationMs += reindexResult.durationMs;
      rebuilt ||= !reindexResult.reused;
      freshness = getIndexFreshness(input.projectRoot, input.config, input.paths);
      if (attempt === 0 && reindexResult.skipped.length === 0 && freshness.state === 'stale') {
        messages.push(
          `Index inputs changed during the first build (${freshness.reason}); running one settling refresh.`,
        );
        continue;
      }
      break;
    }
    if (!reindexResult) throw new Error('Setup index refresh produced no result.');
    addStep(input.steps, {
      id: 'reindex',
      label: 'Index refresh',
      status: reindexResult.skipped.length > 0 ? 'warn' : 'ok',
      message: `${rebuilt ? 'Indexed' : 'Reused'} ${reindexResult.languages.join(', ')} in ${(
        totalDurationMs / 1000
      ).toFixed(1)}s.`,
      details: [...messages, ...reindexResult.skipped.map((entry) => `Skipped ${entry.language}: ${entry.reason}`)],
    });
  } catch (error) {
    addStep(input.steps, {
      id: 'reindex',
      label: 'Index refresh',
      status: 'failed',
      message: errorMessage(error),
      details: messages,
    });
  }
  return { reindexResult, freshness };
}

interface SetupWatchServiceInput {
  projectRoot: string;
  cacheDir: string;
  watchConfig: ReturnType<typeof resolveWatchConfig>;
  readiness: ProjectReadiness;
  configHasErrors: boolean;
  reindexResult: ReindexResult | null;
  postReindexFreshness: IndexFreshness | null;
  steps: ProjectSetupStep[];
}

function startSetupWatchService(input: SetupWatchServiceInput): WatchServiceEnsureResult | null {
  // A deliberate configuration (watch disabled, or automatic startup off) is a
  // valid configured state, not incomplete setup; only the incidental skips
  // keep the verdict at partial.
  const skipped: { reason: string; optional: boolean } | null =
    input.readiness.languages.length === 0
      ? { reason: 'Skipped because no supported languages were detected.', optional: false }
      : input.configHasErrors
        ? { reason: 'Skipped because config validation has errors.', optional: false }
        : !input.watchConfig.enabled
          ? { reason: 'Disabled by watch.enabled=false; setup left the explicit opt-out unchanged.', optional: true }
          : input.reindexResult === null ||
              input.reindexResult.skipped.length > 0 ||
              input.postReindexFreshness?.state !== 'fresh'
            ? {
                reason: 'Skipped because the initial refresh did not produce a complete fresh generation.',
                optional: false,
              }
            : !input.watchConfig.autoStart
              ? {
                  reason:
                    'Automatic startup is disabled by watch.autoStart=false; run scip-query watch --daemon when this worktree should be watched.',
                  optional: true,
                }
              : null;
  if (skipped !== null) {
    addStep(input.steps, {
      id: 'watch-refresh',
      label: 'Automatic indexing service',
      status: 'skipped',
      optional: skipped.optional,
      message: skipped.reason,
    });
    return null;
  }

  try {
    const watchService = ensureWatchService({
      projectRoot: input.projectRoot,
      cacheDir: input.cacheDir,
      cliVersion,
      watchOverrides: input.watchConfig,
    });
    if (input.watchConfig.idleTimeoutMs > 0 && watchService.state.idleDeadlineAt === undefined) {
      throw new Error('Automatic indexing service did not publish its configured clean-idle deadline.');
    }
    const idlePolicy =
      input.watchConfig.idleTimeoutMs === 0
        ? 'configured to remain running'
        : `clean-idle exit scheduled for ${watchService.state.idleDeadlineAt}`;
    addStep(input.steps, {
      id: 'watch-refresh',
      label: 'Automatic indexing service',
      status: 'ok',
      message: `${watchService.disposition} pid ${watchService.state.pid}; ${idlePolicy}.`,
      details: [
        `watcher=${watchService.state.watcher.state}`,
        `autoRefresh=${input.watchConfig.autoRefresh}`,
        `gitPollMs=${input.watchConfig.gitPollMs}`,
      ],
    });
    return watchService;
  } catch (error) {
    addStep(input.steps, {
      id: 'watch-refresh',
      label: 'Automatic indexing service',
      status: 'failed',
      message: errorMessage(error),
    });
    return null;
  }
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
  console.log('Change scopes:');
  renderChangeScope('Repository records (commit)', report.changeScopes.repository);
  renderChangeScope('Checkout preferences (do not commit)', report.changeScopes.checkout);
  renderChangeScope('User environment', report.changeScopes.user);

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

function renderChangeScope(label: string, entries: readonly string[]): void {
  console.log(`  ${label}:`);
  if (entries.length === 0) {
    console.log('    - none');
    return;
  }
  for (const entry of entries) console.log(`    - ${entry}`);
}

function buildSetupSmokeTests(opts: {
  reindexResult: ReindexResult | null;
  readiness: ProjectReadiness;
  capabilities: ProjectCapabilityReport;
  freshness: IndexFreshness;
  health: ProjectSetupHealthSummary;
  healthSelected: boolean;
  agentResult: SetupAgentResult | null;
  watchConfig: ReturnType<typeof resolveWatchConfig>;
  watchService: WatchServiceEnsureResult | null;
  rustSemanticSession: RustSemanticSessionStatus | null;
  steps: readonly ProjectSetupStep[];
}): ProjectSetupSmokeTest[] {
  const reindexStep = opts.steps.find((step) => step.id === 'reindex');
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
      status: opts.freshness.state === 'fresh' ? 'pass' : 'fail',
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
      optional: !opts.healthSelected,
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
      id: 'cleanup-verification',
      command: 'scip-query cleanup-plan --verify',
      status: cleanupVerificationSmokeStatus(opts.capabilities),
      evidence: cleanupVerificationSmokeEvidence(opts.capabilities),
    },
    {
      id: 'watch-refresh',
      command: 'scip-query status --json',
      status:
        watchStep?.status === 'failed'
          ? 'fail'
          : opts.watchConfig.enabled && opts.watchService
            ? 'pass'
            : 'unavailable',
      evidence: watchStep?.message ?? 'Watch refresh policy was not evaluated.',
    },
    {
      id: 'rust-semantic-session',
      command: 'scip-query status --json',
      status: opts.rustSemanticSession === null ? 'unavailable' : opts.rustSemanticSession.valid ? 'pass' : 'fail',
      evidence:
        opts.rustSemanticSession === null
          ? 'Rust was not detected.'
          : `${opts.rustSemanticSession.transport}/${opts.rustSemanticSession.state}; ${opts.rustSemanticSession.fallback} fallback; ${opts.rustSemanticSession.optOut}.`,
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
  if (smokeTests.some((test) => test.status === 'unavailable' && test.optional !== true)) return 'warn';
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

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; readiness, installation, and step reporting form one remediation.
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

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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

function skippedSetupHealth(steps: ProjectSetupStep[]): ProjectSetupHealthSummary {
  const reason = 'Skipped by setup choice; run `scip-query health --full` when wanted.';
  addStep(steps, { id: 'health', label: 'Health audit', status: 'skipped', optional: true, message: reason });
  return emptyHealthSummary(reason);
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
      'Confirm this signal against its named source evidence before editing; fix it only when it matches the requested goal.',
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
  if (steps.some((step) => step.status === 'warn' || (step.status === 'skipped' && step.optional !== true))) {
    return 'partial';
  }
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

// scip-query: ignore-twin — workflow-local error normalization avoids coupling unrelated modules.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
