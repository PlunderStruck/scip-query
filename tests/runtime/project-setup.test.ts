import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import type * as ReindexInstall from '../../src/reindex/install.js';

async function loadProjectSetup(
  overrides: {
    dbExists?: boolean;
    languages?: string[];
    healthThrows?: boolean;
    config?: Record<string, unknown>;
    watchServiceThrows?: boolean;
    watchServiceMissingIdleDeadline?: boolean;
    rustSessionValid?: boolean;
    automaticRefreshConfigThrows?: boolean;
    configDiagnostics?: Array<{ level: 'error' | 'warning'; path: string; message: string }>;
    freshnessStates?: Array<'fresh' | 'stale' | 'missing' | 'unknown'>;
    indexerRunnable?: boolean;
    missingAstParsers?: string[];
  } = {},
) {
  vi.resetModules();

  const dbExists = overrides.dbExists ?? true;
  const languages = overrides.languages ?? ['typescript'];
  const reindex = vi.fn(async () => ({
    languages,
    indexPath: '/repo/.scip/index.scip',
    dbPath: '/repo/.scip/index.db',
    durationMs: 1234,
    reused: false,
    skipped: [],
  }));
  const tryInstallIndexer = vi.fn(() => true);
  const runIsolatedHealthReport = vi.fn(() => {
    if (overrides.healthThrows) throw new Error('health failed');
    return {
      score: 91,
      riskScore: 94,
      hygieneScore: 91,
      scoreBreakdown: [],
      overview: { documents: 3, symbols: 12, indexSizeBytes: 2048 },
      findings: {
        deadSymbols: 0,
        deadLoc: 0,
        isolatedSymbols: 0,
        isolatedLoc: 0,
        cycles: 0,
        similarPairs: 1,
        reactComponentDuplicatePairs: 0,
        reactHookCandidatePairs: 0,
        reactHookCandidateScoreCount: 0,
        reactLargeComponentPressureFiles: 0,
        vueComponentDuplicatePairs: 0,
        vueComposableCandidatePairs: 0,
        vueComposableCandidateScoreCount: 0,
        vueLargeViewPressureFiles: 0,
        extractionCandidates: 0,
        wrappers: 0,
        wrapperScoreCount: 0,
        passthroughs: 0,
        staleTypes: 0,
        driftedFiles: 0,
        complexityHotspotCount: 0,
        hiddenCouplingPairs: null,
        hiddenCouplingScoreCount: null,
      },
      axes: {},
      validation: null,
      suppressions: null,
      actions: [
        {
          category: 'Duplication',
          description: 'Merge similar setup helpers',
          effort: 'low',
          impact: 'high',
          count: 1,
          locRecoverable: 20,
          evidence: 'heuristic',
        },
      ],
      pressure: [],
      topComplexity: [],
      warnings: ['review heuristic matches before editing'],
    };
  });
  const readiness = {
    languages,
    indexers: languages.map((language) => ({
      language,
      binaryLabel: `scip-${language}`,
      installed: overrides.indexerRunnable ?? true,
      runnable: overrides.indexerRunnable ?? true,
    })),
    semantic: undefined,
    checkers: [],
    gitAvailable: true,
  };
  const capabilities = {
    languages,
    capabilities: [],
    matrix: languages.map((language) => ({
      language,
      indexing: { status: 'available' },
      sourceFacts: { status: 'available' },
      semantic: { status: 'unavailable', reason: 'No semantic provider.' },
      cleanupVerification: { status: 'unavailable', reason: 'No checker.' },
      detectors: [],
    })),
  };
  const setupAgent = vi.fn((_projectRoot: string, options?: { gitHook?: boolean }) => ({
    written: ['AGENTS.md', ...(options?.gitHook ? ['.git/hooks/pre-commit'] : [])],
    unchanged: [],
    skipped: [],
  }));
  const installProjectAgentHooks = vi.fn(() => ({
    installed: ['.codex/hooks.json', '.claude/settings.local.json'],
    updated: [],
    unchanged: [],
    removed: [],
    gitExcluded: ['.codex/hooks.json', '.claude/settings.local.json'],
    warnings: [],
    skipped: [],
  }));
  const setupAstParsers = vi.fn((selectedLanguages: string[]) => ({
    supportedLanguages: selectedLanguages,
    availableBefore: selectedLanguages,
    installed: [],
    availableAfter: selectedLanguages,
    unavailable: [],
    attempted: false,
  }));
  const missingAstParsers = overrides.missingAstParsers ?? [];
  const probeAstParsers = vi.fn((selectedLanguages: string[]) => ({
    supportedLanguages: selectedLanguages,
    available: selectedLanguages.filter((language) => !missingAstParsers.includes(language)),
    missing: selectedLanguages.filter((language) => missingAstParsers.includes(language)),
  }));
  const configureProjectAutomaticRefresh = vi.fn(
    (_projectRoot: string, config: Record<string, unknown>, enabled: boolean) => {
      if (overrides.automaticRefreshConfigThrows) throw new Error('config write failed');
      return {
        configPath: '/repo/.scipquery.json',
        config: {
          ...config,
          watch: {
            ...(typeof config['watch'] === 'object' && config['watch'] !== null ? config['watch'] : {}),
            enabled,
            autoRefresh: true,
          },
        },
        changed: true,
      };
    },
  );
  const ensureProjectCollaborationDomain = vi.fn((_projectRoot: string, config: Record<string, unknown>) => ({
    configPath: '/repo/.scipquery.json',
    config: {
      ...config,
      collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
    },
    changed: true,
  }));
  const ensureWatchService = vi.fn(() => {
    if (overrides.watchServiceThrows) throw new Error('watch startup failed');
    return {
      disposition: 'started' as const,
      state: {
        version: 1 as const,
        protocolVersion: 3 as const,
        pid: 456,
        projectRoot: '/repo',
        cliVersion: '0.15.0',
        startedAt: '2026-07-10T00:00:00.000Z',
        heartbeatAt: '2026-07-10T00:00:01.000Z',
        lastActivityAt: '2026-07-10T00:00:01.000Z',
        ...(overrides.watchServiceMissingIdleDeadline ? {} : { idleDeadlineAt: '2026-07-10T00:03:01.000Z' }),
        watcher: { state: 'idle' as const },
      },
    };
  });

  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs');
    return { ...actual, existsSync: vi.fn((target: string) => target === '/repo/.scip/index.db' && dbExists) };
  });
  vi.doMock('../../src/reindex/index.js', () => ({ reindex }));
  vi.doMock('../../src/reindex/install.js', async () => {
    const actual = await vi.importActual<typeof ReindexInstall>('../../src/reindex/install.js');
    return { ...actual, tryInstallIndexer };
  });
  vi.doMock('../../src/runtime/agent-setup.js', () => ({ setupAgent }));
  vi.doMock('../../src/runtime/agent-hooks.js', () => ({ installProjectAgentHooks }));
  vi.doMock('../../src/runtime/ast-parser-setup.js', () => ({ probeAstParsers, setupAstParsers }));
  vi.doMock('../../src/runtime/cli-support.js', () => ({ cliVersion: '0.15.0', runIsolatedHealthReport }));
  vi.doMock('../../src/runtime/config.js', () => ({
    configureProjectAutomaticRefresh,
    ensureProjectCollaborationDomain,
    validateProjectConfig: vi.fn(() => overrides.configDiagnostics ?? []),
    resolveWatchConfig: vi.fn(
      (config: { watch?: { enabled?: boolean; autoStart?: boolean; autoRefresh?: boolean } }) => ({
        enabled: config.watch?.enabled ?? false,
        autoStart: config.watch?.autoStart ?? false,
        debounceMs: 30_000,
        cooldownMs: 60_000,
        gitPollMs: 2_000,
        idleTimeoutMs: 180_000,
        autoRefresh: config.watch?.autoRefresh ?? true,
        ignore: [],
      }),
    ),
  }));
  vi.doMock('../../src/runtime/cli-context.js', () => ({
    resolveCliProjectContext: vi.fn(() => ({
      projectRoot: '/repo',
      config: overrides.config ?? {},
      paths: {
        cacheDir: '/repo/.scip',
        indexPath: '/repo/.scip/index.scip',
        dbPath: '/repo/.scip/index.db',
        metaPath: '/repo/.scip/index.meta.json',
      },
      dbPath: '/repo/.scip/index.db',
    })),
  }));
  let freshnessCall = 0;
  vi.doMock('../../src/runtime/index-freshness.js', () => ({
    getIndexFreshness: vi.fn(() => {
      const configured = overrides.freshnessStates;
      const state = configured
        ? configured[Math.min(freshnessCall++, configured.length - 1)]!
        : dbExists
          ? 'fresh'
          : 'missing';
      return {
        state,
        checkedAt: '2026-06-23T00:00:00.000Z',
        metaPath: '/repo/.scip/index.meta.json',
        reason: state,
      };
    }),
  }));
  vi.doMock('../../src/runtime/health-dossier.js', () => ({
    beginHealthDossierAttempt: vi.fn(() => ({
      attemptPath: '/repo/docs/scip-query/health-dossier.attempt.json',
      attempt: { runId: 'run-test', startedAt: '2026-09-01T18:00:00.000Z', indexGeneration: 'generation-test' },
      interrupted: null,
    })),
    finishHealthDossierAttempt: vi.fn(),
    writeProjectHealthDossier: vi.fn(() => ({
      markdownPath: '/repo/docs/scip-query/health-dossier.md',
      jsonPath: '/repo/docs/scip-query/health-dossier.json',
      status: 'written',
      written: ['/repo/docs/scip-query/health-dossier.md', '/repo/docs/scip-query/health-dossier.json'],
      unchanged: [],
    })),
    formatHealthAvailabilitySummary: (health: {
      score: number | null;
      riskScore: number | null;
      hygieneScore: number | null;
      unavailableReason?: string;
    }) =>
      health.score === null
        ? `unavailable (${health.unavailableReason ?? 'not checked'})`
        : `${health.score} (risk ${health.riskScore}, hygiene ${health.hygieneScore})`,
  }));
  vi.doMock('../../src/runtime/project-readiness.js', () => ({
    getProjectReadiness: vi.fn(() => readiness),
    getProjectCapabilities: vi.fn(() => capabilities),
  }));
  vi.doMock('../../src/runtime/setup.js', () => ({
    installSkills: vi.fn(() => ({ installed: ['Codex/scip-query'], alreadyLinked: [], pruned: [], skipped: [] })),
    isScipInstalled: vi.fn(() => true),
  }));
  vi.doMock('../../src/runtime/watch-service.js', () => ({ ensureWatchService }));
  const rustSemanticSessionStatus = vi.fn(() => ({
    transport: 'durable' as const,
    source: 'default' as const,
    fallback: 'worker' as const,
    valid: overrides.rustSessionValid ?? true,
    optOut: 'SCIP_RUST_SEMANTIC_DURABLE_SESSION=0',
    state: 'stopped' as const,
  }));
  vi.doMock('../../src/semantic/rust/lsp-session.js', () => ({
    rustSemanticSessionStatus,
  }));

  const module = await import('../../src/runtime/project-setup.js');
  return {
    module,
    reindex,
    runIsolatedHealthReport,
    setupAgent,
    installProjectAgentHooks,
    configureProjectAutomaticRefresh,
    ensureProjectCollaborationDomain,
    ensureWatchService,
    rustSemanticSessionStatus,
    tryInstallIndexer,
    setupAstParsers,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runProjectSetup', () => {
  it('requires explicit guided setup to remain interactive and unambiguous', async () => {
    const { module } = await loadProjectSetup();
    const valid = {
      guided: true,
      yes: false,
      json: false,
      stdinIsTty: true,
      stdoutIsTty: true,
    };

    expect(() => module.validateSetupInteractionMode(valid)).not.toThrow();
    expect(() => module.validateSetupInteractionMode({ ...valid, yes: true })).toThrow(
      '--guided cannot be combined with --yes',
    );
    expect(() => module.validateSetupInteractionMode({ ...valid, json: true })).toThrow(
      '--guided cannot be combined with --json',
    );
    expect(() => module.validateSetupInteractionMode({ ...valid, stdinIsTty: false })).toThrow(
      '--guided requires an interactive terminal',
    );
    expect(() => module.validateSetupInteractionMode({ ...valid, stdoutIsTty: false })).toThrow(
      '--guided requires an interactive terminal',
    );
    expect(() =>
      module.validateSetupInteractionMode({
        ...valid,
        guided: false,
        yes: true,
        json: true,
        stdinIsTty: false,
        stdoutIsTty: false,
      }),
    ).not.toThrow();
  });

  it('installs detected AST parsers only after explicit setup consent', async () => {
    const { module, setupAstParsers } = await loadProjectSetup({ languages: ['typescript', 'python'] });
    // Without consent the step probes instead of installing: parsers that
    // already load are reported as such, not as a skip that reads as missing.
    const probed = await module.runProjectSetup({ runHealth: false });
    expect(setupAstParsers).not.toHaveBeenCalled();
    expect(probed.steps).toContainEqual(
      expect.objectContaining({
        id: 'ast-parsers',
        status: 'ok',
        message: '2/2 selected language parser(s) available; nothing to install.',
      }),
    );

    const selected = await module.runProjectSetup({ runHealth: false, installAstParsers: true });
    expect(setupAstParsers).toHaveBeenCalledWith(['typescript', 'python']);
    expect(selected.steps).toContainEqual(expect.objectContaining({ id: 'ast-parsers', status: 'ok' }));
  });

  it('keeps the consent skip for a parser that does not load', async () => {
    const { module, setupAstParsers } = await loadProjectSetup({
      languages: ['typescript', 'kotlin'],
      missingAstParsers: ['kotlin'],
    });
    const report = await module.runProjectSetup({ runHealth: false });
    expect(setupAstParsers).not.toHaveBeenCalled();
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        id: 'ast-parsers',
        status: 'skipped',
        message: 'Skipped because installing missing parser packages requires explicit consent.',
        details: ['Missing: kotlin'],
      }),
    );
  });

  it('plans guided setup choices without creating agent docs by default', async () => {
    const { module } = await loadProjectSetup();

    const plan = module.planGuidedProjectSetup({
      files: {
        agentsMd: false,
        claudeMd: false,
        codexHooks: false,
        claudeSettings: false,
      },
      watchEnabled: false,
      readiness: {
        languages: ['rust'],
        indexers: [{ language: 'rust', binaryLabel: 'rust-analyzer', installed: false, runnable: false }],
        semantics: [],
        checkers: [],
        gitAvailable: true,
      },
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'enable-automatic-refresh',
          scope: 'repository',
          recommended: true,
          requiresConsent: true,
        }),
        expect.objectContaining({
          id: 'create-agent-guidance',
          scope: 'repository',
          recommended: false,
          requiresConsent: true,
        }),
        expect.objectContaining({
          id: 'install-indexers',
          scope: 'user',
          recommended: true,
          requiresConsent: true,
        }),
      ]),
    );
  });

  it('plans agent guidance updates when a project already has agent docs', async () => {
    const { module } = await loadProjectSetup();

    const plan = module.planGuidedProjectSetup({
      files: {
        agentsMd: true,
        claudeMd: false,
        codexHooks: true,
        claudeSettings: true,
      },
      watchEnabled: true,
      readiness: {
        languages: ['typescript'],
        indexers: [{ language: 'typescript', binaryLabel: 'scip-typescript', installed: true, runnable: true }],
        semantics: [],
        checkers: [],
        gitAvailable: true,
      },
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        id: 'update-agent-guidance',
        scope: 'repository',
        recommended: true,
        requiresConsent: true,
      }),
    ]);
  });

  it('reports health availability and issue list before any cleanup work could begin', async () => {
    const {
      module,
      runIsolatedHealthReport,
      setupAgent,
      installProjectAgentHooks,
      configureProjectAutomaticRefresh,
      ensureWatchService,
    } = await loadProjectSetup();

    const report = await module.runProjectSetup({ runHealth: true });

    expect(report.health.available).toBe(true);
    expect(report.health).not.toHaveProperty('score');
    expect(report.health.issuesNeedAttention).toEqual([
      {
        category: 'Duplication',
        description: 'Merge similar setup helpers',
        count: 1,
        impact: 'high',
        effort: 'low',
        evidence: 'heuristic',
        locRecoverable: 20,
        confirmationStatus: 'unconfirmed',
        safeForAgentToStart: false,
        recommendedNextStep:
          'Confirm this signal against its named source evidence before editing; fix it only when it matches the requested goal.',
      },
    ]);
    expect(report.healthDossier).toMatchObject({
      markdownPath: '/repo/docs/scip-query/health-dossier.md',
      jsonPath: '/repo/docs/scip-query/health-dossier.json',
      status: 'written',
    });
    expect(report.filesWritten).toContain('/repo/docs/scip-query/health-dossier.md');
    expect(report.changeScopes).toEqual({
      repository: [
        '/repo/.scipquery.json',
        'AGENTS.md',
        '/repo/docs/scip-query/health-dossier.md',
        '/repo/docs/scip-query/health-dossier.json',
      ],
      checkout: [],
      user: ['Codex/scip-query'],
    });
    expect(report.smokeTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'scip-query reindex', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query status', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query config-validate', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query capabilities', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query capabilities --matrix', status: 'pass', basis: 'readiness' }),
        expect.objectContaining({
          command: 'scip-query health --indexed --full',
          status: 'pass',
          basis: 'operation-result',
        }),
        expect.objectContaining({ command: 'scip-query diff-impact --json', status: 'pass', basis: 'readiness' }),
        expect.objectContaining({
          id: 'watch-refresh',
          command: 'scip-query status --json',
          status: 'unavailable',
        }),
        expect.objectContaining({ command: 'scip-query setup-agent', status: 'pass' }),
      ]),
    );
    expect(runIsolatedHealthReport).toHaveBeenCalledWith({ full: true, json: true });
    expect(configureProjectAutomaticRefresh).toHaveBeenCalledWith(
      '/repo',
      { collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5' },
      true,
    );
    expect(ensureWatchService).not.toHaveBeenCalled();
    expect(installProjectAgentHooks).not.toHaveBeenCalled();
    expect(setupAgent).toHaveBeenCalledWith('/repo');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    module.renderProjectSetupReport(report);
    const lines = log.mock.calls.map((call) => String(call[0]));

    expect(lines.findIndex((line) => line.startsWith('Health score: 91'))).toBeLessThan(
      lines.findIndex((line) => line === 'Setup steps:'),
    );
    expect(lines.findIndex((line) => line === 'Items that need attention:')).toBeLessThan(
      lines.findIndex((line) => line === 'Setup steps:'),
    );
  });

  it('skips health and dossier work by default while reporting the explicit recovery command', async () => {
    const { module, runIsolatedHealthReport } = await loadProjectSetup();

    const report = await module.runProjectSetup();

    expect(runIsolatedHealthReport).not.toHaveBeenCalled();
    expect(report.healthDossier).toBeNull();
    expect(report.health.unavailableReason).toContain('scip-query health --indexed --full');
    expect(report.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'health', status: 'skipped', optional: true }),
        expect.objectContaining({ id: 'health-dossier', status: 'skipped', optional: true }),
      ]),
    );
    expect(report.smokeTests).toContainEqual(
      expect.objectContaining({ id: 'health', status: 'unavailable', optional: true }),
    );
  });

  it('blocks setup when no supported languages are detected', async () => {
    const { module, reindex, runIsolatedHealthReport, ensureWatchService } = await loadProjectSetup({
      dbExists: false,
      languages: [],
    });

    const report = await module.runProjectSetup();

    expect(report.verdict).toBe('blocked');
    expect(reindex).not.toHaveBeenCalled();
    expect(runIsolatedHealthReport).not.toHaveBeenCalled();
    expect(ensureWatchService).not.toHaveBeenCalled();
    expect(report.steps.find((step) => step.id === 'reindex')).toMatchObject({
      status: 'skipped',
      message: 'Skipped because no supported languages were detected.',
    });
    expect(report.smokeTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'scip-query reindex', status: 'unavailable' }),
        expect.objectContaining({ command: 'scip-query status', status: 'fail' }),
        expect.objectContaining({ command: 'scip-query config-validate', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query capabilities', status: 'unavailable' }),
        expect.objectContaining({
          command: 'scip-query capabilities --matrix',
          status: 'unavailable',
          basis: 'readiness',
        }),
        expect.objectContaining({
          command: 'scip-query health --indexed --full',
          status: 'unavailable',
          basis: 'operation-result',
        }),
        expect.objectContaining({ command: 'scip-query diff-impact --json', status: 'fail' }),
        expect.objectContaining({ command: 'scip-query setup-agent', status: 'pass' }),
      ]),
    );
  });

  it('does not install a missing indexer when guided setup consent is declined', async () => {
    const { module, tryInstallIndexer } = await loadProjectSetup({ indexerRunnable: false });

    const report = await module.runProjectSetup({ installIndexers: false });

    expect(tryInstallIndexer).not.toHaveBeenCalled();
    expect(report.indexerRemediation).toEqual([]);
    expect(report.steps.find((step) => step.id === 'indexer-remediation')).toMatchObject({
      status: 'skipped',
      message: 'Skipped because installing missing indexers requires explicit consent.',
    });
  });

  it('settles one first-build input change before claiming freshness', async () => {
    const { module, reindex } = await loadProjectSetup({ freshnessStates: ['stale', 'fresh'] });

    const report = await module.runProjectSetup();

    expect(reindex).toHaveBeenCalledTimes(2);
    expect(report.freshness.state).toBe('fresh');
    expect(report.steps.find((step) => step.id === 'reindex')?.details).toEqual(
      expect.arrayContaining([expect.stringContaining('running one settling refresh')]),
    );
    expect(report.smokeTests.find((test) => test.id === 'status')).toMatchObject({ status: 'pass' });
  });

  it('fails the setup freshness smoke when the bounded settling pass remains stale', async () => {
    const { module, reindex, ensureWatchService } = await loadProjectSetup({
      freshnessStates: ['stale', 'stale', 'stale'],
    });

    const report = await module.runProjectSetup();

    expect(reindex).toHaveBeenCalledTimes(2);
    expect(ensureWatchService).not.toHaveBeenCalled();
    expect(report.freshness.state).toBe('stale');
    expect(report.steps.find((step) => step.id === 'watch-refresh')).toMatchObject({
      status: 'skipped',
      message: 'Skipped because the initial refresh did not produce a complete fresh generation.',
    });
    expect(report.smokeTests.find((test) => test.id === 'status')).toMatchObject({ status: 'fail' });
    expect(report.verdict).toBe('blocked');
  });

  it('preserves an explicit automatic-indexing opt-out', async () => {
    const { module, configureProjectAutomaticRefresh, ensureWatchService } = await loadProjectSetup({
      config: { watch: { enabled: false, autoRefresh: true } },
    });

    const report = await module.runProjectSetup();

    expect(configureProjectAutomaticRefresh).not.toHaveBeenCalled();
    expect(ensureWatchService).not.toHaveBeenCalled();
    expect(report.steps.find((step) => step.id === 'watch-refresh')).toMatchObject({
      status: 'skipped',
      message: 'Disabled by watch.enabled=false; setup left the explicit opt-out unchanged.',
    });
    expect(report.smokeTests.find((test) => test.id === 'watch-refresh')).toMatchObject({
      status: 'unavailable',
    });
  });

  it('adopts a missing collaboration domain before later setup writes', async () => {
    const { module, ensureProjectCollaborationDomain, configureProjectAutomaticRefresh } = await loadProjectSetup();

    const report = await module.runProjectSetup();

    expect(ensureProjectCollaborationDomain).toHaveBeenCalledWith('/repo', {});
    expect(configureProjectAutomaticRefresh).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
      }),
      true,
    );
    expect(report.steps.find((step) => step.id === 'collaboration-domain-config')).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('Generated the committed identity'),
    });
  });

  it('does not start the watch service until automatic startup is explicitly enabled', async () => {
    const { module, ensureWatchService } = await loadProjectSetup({
      config: { watch: { enabled: true, autoStart: false } },
    });

    const report = await module.runProjectSetup();

    expect(ensureWatchService).not.toHaveBeenCalled();
    // Demand start is the configured default, so the step is a configured
    // state, not something setup left undone.
    expect(report.steps.find((step) => step.id === 'watch-refresh')).toMatchObject({
      status: 'ok',
      optional: true,
      message:
        'Demand-started: the service starts with the first query that needs it (watch.autoStart=false); run scip-query watch --daemon to start it now.',
    });
    expect(report.smokeTests.find((test) => test.id === 'watch-refresh')).toMatchObject({
      status: 'unavailable',
      optional: true,
    });
  });

  it('reports config persistence failure without hiding the rest of setup', async () => {
    const { module, ensureWatchService } = await loadProjectSetup({ automaticRefreshConfigThrows: true });

    const report = await module.runProjectSetup();

    expect(report.verdict).toBe('blocked');
    expect(report.steps.find((step) => step.id === 'automatic-indexing-config')).toMatchObject({
      status: 'failed',
      message: 'config write failed',
    });
    expect(ensureWatchService).not.toHaveBeenCalled();
  });

  it('does not rewrite an existing config with validation errors', async () => {
    const { module, configureProjectAutomaticRefresh } = await loadProjectSetup({
      configDiagnostics: [{ level: 'error', path: 'watch.enabled', message: 'Expected a boolean.' }],
    });

    const report = await module.runProjectSetup();

    expect(configureProjectAutomaticRefresh).not.toHaveBeenCalled();
    expect(report.verdict).toBe('blocked');
    expect(report.steps.find((step) => step.id === 'automatic-indexing-config')).toMatchObject({
      status: 'skipped',
      message: 'Skipped because the existing project config has validation errors.',
    });
  });

  it('blocks setup when the enabled automatic-indexing service cannot start', async () => {
    const { module } = await loadProjectSetup({
      config: { watch: { enabled: true, autoStart: true } },
      watchServiceThrows: true,
    });

    const report = await module.runProjectSetup();

    expect(report.verdict).toBe('blocked');
    expect(report.steps.find((step) => step.id === 'watch-refresh')).toMatchObject({
      status: 'failed',
      message: 'watch startup failed',
    });
    expect(report.smokeTests.find((test) => test.id === 'watch-refresh')).toMatchObject({ status: 'fail' });
  });

  it('blocks setup when the service omits its configured idle deadline', async () => {
    const { module } = await loadProjectSetup({
      config: { watch: { enabled: true, autoStart: true } },
      watchServiceMissingIdleDeadline: true,
    });

    const report = await module.runProjectSetup();

    expect(report.verdict).toBe('blocked');
    expect(report.steps.find((step) => step.id === 'watch-refresh')).toMatchObject({
      status: 'failed',
      message: 'Automatic indexing service did not publish its configured clean-idle deadline.',
    });
  });

  it('reports the default durable Rust transport and fails invalid selection', async () => {
    const passing = await loadProjectSetup({ languages: ['rust'] });
    const passingReport = await passing.module.runProjectSetup({ runHealth: true });

    expect(passing.runIsolatedHealthReport.mock.invocationCallOrder[0]).toBeLessThan(
      passing.rustSemanticSessionStatus.mock.invocationCallOrder[0]!,
    );
    expect(passingReport.steps.find((step) => step.id === 'rust-semantic-session')).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('durable/stopped selected from default; worker fallback'),
    });
    expect(passingReport.smokeTests.find((test) => test.id === 'rust-semantic-session')).toMatchObject({
      status: 'pass',
    });

    const invalid = await loadProjectSetup({ languages: ['rust'], rustSessionValid: false });
    const invalidReport = await invalid.module.runProjectSetup();
    expect(invalidReport.verdict).toBe('blocked');
    expect(invalidReport.smokeTests.find((test) => test.id === 'rust-semantic-session')).toMatchObject({
      status: 'fail',
    });
  });

  it('reports attempted indexer remediation and keeps setup partial when a language remains blocked', async () => {
    vi.resetModules();

    const initialReadiness = {
      languages: ['typescript', 'java'],
      indexers: [
        {
          language: 'typescript',
          binaryLabel: 'scip-typescript',
          installed: false,
          runnable: false,
          installUrl: 'https://github.com/sourcegraph/scip-typescript',
        },
        {
          language: 'java',
          binaryLabel: 'scip-java',
          installed: false,
          runnable: false,
          installUrl: 'https://github.com/sourcegraph/scip-java/releases',
        },
      ],
      checkers: [],
      gitAvailable: true,
    };
    const afterReadiness = {
      ...initialReadiness,
      indexers: [
        {
          language: 'typescript',
          binaryLabel: 'scip-typescript',
          installed: true,
          runnable: true,
          resolvedBinary: 'scip-typescript',
        },
        initialReadiness.indexers[1],
      ],
    };
    const reindex = vi.fn(async () => ({
      languages: ['typescript'],
      indexPath: '/repo/.scip/index.scip',
      dbPath: '/repo/.scip/index.db',
      durationMs: 100,
      reused: false,
      skipped: [{ language: 'java', reason: 'scip-java could not be auto-installed.' }],
    }));
    const getProjectReadiness = vi
      .fn()
      .mockReturnValueOnce(initialReadiness)
      .mockReturnValueOnce(afterReadiness)
      .mockReturnValueOnce(afterReadiness);
    const tryInstallIndexer = vi.fn((config: { language: string }, onStatus: (message: string) => void) => {
      onStatus(`Installing ${config.language}`);
      return config.language === 'typescript';
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return { ...actual, existsSync: vi.fn((target: string) => target === '/repo/.scip/index.db') };
    });
    vi.doMock('../../src/reindex/index.js', () => ({ reindex }));
    vi.doMock('../../src/reindex/indexers.js', () => ({
      getIndexerConfig: vi.fn((language: string) => ({
        language,
        indexerBinary: language === 'typescript' ? 'scip-typescript' : 'scip-java',
        installMethods:
          language === 'typescript'
            ? [
                {
                  label: 'npm',
                  prerequisite: 'npm',
                  binary: 'npm',
                  args: ['install', '-g', '@sourcegraph/scip-typescript'],
                },
              ]
            : [],
        installUrl:
          language === 'typescript'
            ? 'https://github.com/sourcegraph/scip-typescript'
            : 'https://github.com/sourcegraph/scip-java/releases',
      })),
    }));
    vi.doMock('../../src/platform/indexer-toolchain.js', () => ({
      getIndexerDependencyStatus: vi.fn((config: { language: string; indexerBinary: string; installUrl: string }) =>
        config.language === 'typescript'
          ? {
              language: 'typescript',
              binaryLabel: 'scip-typescript',
              installed: true,
              runnable: true,
              resolvedBinary: 'scip-typescript',
            }
          : {
              language: 'java',
              binaryLabel: 'scip-java',
              installed: false,
              runnable: false,
              resolvedBinary: null,
              installUrl: config.installUrl,
            },
      ),
    }));
    vi.doMock('../../src/reindex/install.js', () => ({
      tryInstallIndexer,
    }));
    vi.doMock('../../src/runtime/agent-setup.js', () => ({
      setupAgent: vi.fn(() => ({ written: [], unchanged: ['AGENTS.md'], skipped: [] })),
    }));
    vi.doMock('../../src/runtime/agent-hooks.js', () => ({
      installProjectAgentHooks: vi.fn(() => ({
        installed: ['.codex/hooks.json', '.claude/settings.local.json'],
        updated: [],
        unchanged: [],
        removed: [],
        gitExcluded: ['.codex/hooks.json', '.claude/settings.local.json'],
        warnings: [],
        skipped: [],
      })),
    }));
    vi.doMock('../../src/runtime/cli-support.js', () => ({
      cliVersion: '0.15.0',
      runIsolatedHealthReport: vi.fn(() => ({
        score: 100,
        riskScore: 100,
        hygieneScore: 100,
        scoreBreakdown: [],
        overview: { documents: 1, symbols: 1, indexSizeBytes: 1 },
        findings: {},
        axes: {},
        validation: null,
        suppressions: null,
        actions: [],
        pressure: [],
        topComplexity: [],
      })),
    }));
    vi.doMock('../../src/runtime/config.js', () => ({
      ensureProjectCollaborationDomain: vi.fn((_projectRoot: string, config: Record<string, unknown>) => ({
        configPath: '/repo/.scipquery.json',
        config: {
          ...config,
          collaborationDomainId: '5ea57d1a-936c-4c91-b58f-5d61e45173a5',
        },
        changed: true,
      })),
      configureProjectAutomaticRefresh: vi.fn(
        (_projectRoot: string, config: Record<string, unknown>, enabled: boolean) => ({
          configPath: '/repo/.scipquery.json',
          config: { ...config, watch: { enabled, autoRefresh: true } },
          changed: true,
        }),
      ),
      validateProjectConfig: vi.fn(() => []),
      resolveWatchConfig: vi.fn((config: { watch?: { enabled?: boolean } }) => ({
        enabled: config.watch?.enabled ?? false,
        debounceMs: 30_000,
        cooldownMs: 60_000,
        gitPollMs: 2_000,
        idleTimeoutMs: 180_000,
        autoRefresh: true,
        ignore: [],
      })),
    }));
    vi.doMock('../../src/runtime/cli-context.js', () => ({
      resolveCliProjectContext: vi.fn(() => ({
        projectRoot: '/repo',
        config: {},
        paths: {
          cacheDir: '/repo/.scip',
          indexPath: '/repo/.scip/index.scip',
          dbPath: '/repo/.scip/index.db',
          metaPath: '/repo/.scip/index.meta.json',
        },
        dbPath: '/repo/.scip/index.db',
      })),
    }));
    vi.doMock('../../src/runtime/index-freshness.js', () => ({
      getIndexFreshness: vi.fn(() => ({
        state: 'fresh',
        checkedAt: '2026-06-23T00:00:00.000Z',
        metaPath: '/repo/.scip/index.meta.json',
        reason: 'fresh',
      })),
    }));
    vi.doMock('../../src/runtime/health-dossier.js', () => ({
      beginHealthDossierAttempt: vi.fn(() => ({
        attemptPath: '/repo/docs/scip-query/health-dossier.attempt.json',
        attempt: { runId: 'run-test', startedAt: '2026-09-01T18:00:00.000Z', indexGeneration: 'generation-test' },
        interrupted: null,
      })),
      finishHealthDossierAttempt: vi.fn(),
      writeProjectHealthDossier: vi.fn(() => ({
        markdownPath: '/repo/docs/scip-query/health-dossier.md',
        jsonPath: '/repo/docs/scip-query/health-dossier.json',
        status: 'written',
        written: ['/repo/docs/scip-query/health-dossier.md'],
        unchanged: ['/repo/docs/scip-query/health-dossier.json'],
      })),
      formatHealthAvailabilitySummary: (health: {
        score: number | null;
        riskScore: number | null;
        hygieneScore: number | null;
        unavailableReason?: string;
      }) =>
        health.score === null
          ? `unavailable (${health.unavailableReason ?? 'not checked'})`
          : `${health.score} (risk ${health.riskScore}, hygiene ${health.hygieneScore})`,
    }));
    vi.doMock('../../src/runtime/project-readiness.js', () => ({
      getProjectReadiness,
      getProjectCapabilities: vi.fn(() => ({
        languages: ['typescript', 'java'],
        capabilities: [],
        matrix: [
          {
            language: 'typescript',
            indexing: { status: 'available' },
            sourceFacts: { status: 'available' },
            semantic: { status: 'unavailable' },
            cleanupVerification: { status: 'unavailable' },
            detectors: [],
          },
          {
            language: 'java',
            indexing: { status: 'unavailable' },
            sourceFacts: { status: 'unavailable' },
            semantic: { status: 'unavailable' },
            cleanupVerification: { status: 'unavailable' },
            detectors: [],
          },
        ],
      })),
    }));
    vi.doMock('../../src/runtime/setup.js', () => ({
      installSkills: vi.fn(() => ({ installed: [], alreadyLinked: ['Codex/scip-query'], pruned: [], skipped: [] })),
      isScipInstalled: vi.fn(() => true),
    }));
    vi.doMock('../../src/runtime/watch-service.js', () => ({
      ensureWatchService: vi.fn(() => ({
        disposition: 'started',
        state: {
          pid: 456,
          idleDeadlineAt: '2026-07-10T00:03:01.000Z',
          watcher: { state: 'idle' },
        },
      })),
    }));
    vi.doMock('../../src/semantic/rust/lsp-session.js', () => ({
      rustSemanticSessionStatus: vi.fn(),
    }));

    const module = await import('../../src/runtime/project-setup.js');
    const report = await module.runProjectSetup({ installIndexers: true });

    expect(report.verdict).toBe('partial');
    expect(tryInstallIndexer).toHaveBeenCalledTimes(1);
    expect(report.indexerRemediation).toHaveLength(2);
    expect(report.indexerRemediation[0]).toMatchObject({
      language: 'typescript',
      attempted: true,
      installed: true,
      after: { runnable: true },
    });
    expect(report.indexerRemediation[1]).toMatchObject({
      language: 'java',
      attempted: false,
      after: { runnable: false },
      recovery: 'https://github.com/sourcegraph/scip-java/releases',
    });
    expect(report.steps.find((step) => step.id === 'indexer-remediation')).toMatchObject({
      status: 'warn',
      message: '1 install attempt(s); 1 indexer(s) still blocked.',
    });
  });

  it('passes persistent TypeScript project indexing config into setup reindex', async () => {
    const { module, reindex } = await loadProjectSetup({
      config: {
        indexer: { typescript: { projectMode: 'workspace', projects: ['packages/web'] } },
      },
    });

    await module.runProjectSetup();

    expect(reindex).toHaveBeenCalledWith(
      expect.objectContaining({
        typescriptProjectMode: 'workspace',
        typescriptProjects: ['packages/web'],
      }),
    );
  });
});
