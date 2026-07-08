import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';

async function loadProjectSetup(
  overrides: {
    dbExists?: boolean;
    languages?: string[];
    healthThrows?: boolean;
    config?: Record<string, unknown>;
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
      installed: true,
      runnable: true,
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
  const setupAgent = vi.fn(() => ({ written: ['AGENTS.md'], unchanged: [], skipped: [] }));
  const installProjectAgentHooks = vi.fn(() => ({
    installed: ['.codex/hooks.json', '.claude/settings.json'],
    updated: [],
    unchanged: [],
    removed: [],
    skipped: [],
  }));

  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs');
    return { ...actual, existsSync: vi.fn((target: string) => target === '/repo/.scip/index.db' && dbExists) };
  });
  vi.doMock('../../src/reindex/index.js', () => ({ reindex }));
  vi.doMock('../../src/runtime/agent-setup.js', () => ({ setupAgent }));
  vi.doMock('../../src/runtime/agent-hooks.js', () => ({ installProjectAgentHooks }));
  vi.doMock('../../src/runtime/cli-support.js', () => ({ runIsolatedHealthReport }));
  vi.doMock('../../src/runtime/config.js', () => ({
    validateProjectConfig: vi.fn(() => []),
    resolveWatchConfig: vi.fn(() => ({
      enabled: true,
      debounceMs: 30_000,
      cooldownMs: 60_000,
      gitPollMs: 2_000,
      autoRefresh: true,
      ignore: [],
    })),
  }));
  vi.doMock('../../src/runtime/cli-context.js', () => ({
    resolveCliProjectContext: vi.fn(() => ({
      projectRoot: '/repo',
      config: overrides.config ?? {},
      paths: {
        indexPath: '/repo/.scip/index.scip',
        dbPath: '/repo/.scip/index.db',
        metaPath: '/repo/.scip/index.meta.json',
      },
      dbPath: '/repo/.scip/index.db',
    })),
  }));
  vi.doMock('../../src/runtime/index-freshness.js', () => ({
    getIndexFreshness: vi.fn(() => ({
      state: dbExists ? 'fresh' : 'missing',
      checkedAt: '2026-06-23T00:00:00.000Z',
      metaPath: '/repo/.scip/index.meta.json',
      reason: dbExists ? 'fresh' : 'missing',
    })),
  }));
  vi.doMock('../../src/runtime/health-dossier.js', () => ({
    writeProjectHealthDossier: vi.fn(() => ({
      markdownPath: '/repo/docs/scip-query/health-dossier.md',
      jsonPath: '/repo/docs/scip-query/health-dossier.json',
      status: 'written',
      written: ['/repo/docs/scip-query/health-dossier.md', '/repo/docs/scip-query/health-dossier.json'],
      unchanged: [],
    })),
    formatHealthScoreSummary: (health: {
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

  const module = await import('../../src/runtime/project-setup.js');
  return { module, reindex, runIsolatedHealthReport, setupAgent, installProjectAgentHooks };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runProjectSetup', () => {
  it('plans guided setup choices without creating agent docs by default', async () => {
    const { module } = await loadProjectSetup();

    const plan = module.planGuidedProjectSetup({
      files: {
        agentsMd: false,
        claudeMd: false,
        codexHooks: false,
        claudeSettings: false,
      },
      readiness: {
        languages: ['rust'],
        indexers: [{ language: 'rust', binaryLabel: 'rust-analyzer', installed: true, runnable: true }],
        semantics: [],
        checkers: [],
        gitAvailable: true,
      },
      capabilities: {
        languages: ['rust'],
        capabilities: [],
        matrix: [
          {
            language: 'rust',
            indexing: { status: 'available' },
            sourceFacts: { status: 'unavailable', reason: 'tree-sitter native module not loadable' },
            semantic: { status: 'available' },
            cleanupVerification: { status: 'unavailable' },
          },
        ],
      },
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'create-agent-guidance',
          recommended: false,
          requiresConsent: true,
        }),
        expect.objectContaining({
          id: 'install-project-hooks',
          recommended: true,
          requiresConsent: true,
        }),
        expect.objectContaining({
          id: 'install-parser-runtimes',
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
      readiness: {
        languages: ['typescript'],
        indexers: [{ language: 'typescript', binaryLabel: 'scip-typescript', installed: true, runnable: true }],
        semantics: [],
        checkers: [],
        gitAvailable: true,
      },
      capabilities: {
        languages: ['typescript'],
        capabilities: [],
        matrix: [
          {
            language: 'typescript',
            indexing: { status: 'available' },
            sourceFacts: { status: 'available' },
            semantic: { status: 'available' },
            cleanupVerification: { status: 'available' },
          },
        ],
      },
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        id: 'update-agent-guidance',
        recommended: true,
        requiresConsent: true,
      }),
    ]);
  });

  it('reports health score and issue list before any cleanup work could begin', async () => {
    const { module, runIsolatedHealthReport, setupAgent, installProjectAgentHooks } = await loadProjectSetup();

    const report = await module.runProjectSetup({ gitHook: true });

    expect(report.health.score).toBe(91);
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
          'Run scip-cleanup-audit to confirm this signal; use scip-cleanup-improve when the user wants confirmed issues fixed autonomously.',
      },
    ]);
    expect(report.healthDossier).toMatchObject({
      markdownPath: '/repo/docs/scip-query/health-dossier.md',
      jsonPath: '/repo/docs/scip-query/health-dossier.json',
      status: 'written',
    });
    expect(report.filesWritten).toContain('/repo/docs/scip-query/health-dossier.md');
    expect(report.smokeTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'scip-query reindex', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query status', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query config-validate', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query capabilities', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query capability-matrix --json', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query health', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query diff-impact --json', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query diff-gate --json', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query setup-hooks', status: 'pass' }),
        expect.objectContaining({
          id: 'watch-refresh',
          command: expect.stringContaining('"hook_event_name":"SessionStart"'),
          status: 'pass',
        }),
        expect.objectContaining({ command: 'scip-query setup-agent', status: 'pass' }),
      ]),
    );
    expect(runIsolatedHealthReport).toHaveBeenCalledWith({ full: true, json: true });
    expect(installProjectAgentHooks).toHaveBeenCalledWith('/repo');
    expect(setupAgent).toHaveBeenCalledWith('/repo', { gitHook: true });

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

  it('blocks setup when no supported languages are detected', async () => {
    const { module, reindex, runIsolatedHealthReport } = await loadProjectSetup({
      dbExists: false,
      languages: [],
    });

    const report = await module.runProjectSetup();

    expect(report.verdict).toBe('blocked');
    expect(reindex).not.toHaveBeenCalled();
    expect(runIsolatedHealthReport).not.toHaveBeenCalled();
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
        expect.objectContaining({ command: 'scip-query capability-matrix --json', status: 'unavailable' }),
        expect.objectContaining({ command: 'scip-query health', status: 'unavailable' }),
        expect.objectContaining({ command: 'scip-query diff-impact --json', status: 'fail' }),
        expect.objectContaining({ command: 'scip-query diff-gate --json', status: 'fail' }),
        expect.objectContaining({ command: 'scip-query setup-hooks', status: 'pass' }),
        expect.objectContaining({ command: 'scip-query setup-agent', status: 'pass' }),
      ]),
    );
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
    vi.doMock('../../src/reindex/install.js', () => ({
      tryInstallIndexer,
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
    vi.doMock('../../src/runtime/agent-setup.js', () => ({
      setupAgent: vi.fn(() => ({ written: [], unchanged: ['AGENTS.md'], skipped: [] })),
    }));
    vi.doMock('../../src/runtime/agent-hooks.js', () => ({
      installProjectAgentHooks: vi.fn(() => ({
        installed: ['.codex/hooks.json', '.claude/settings.json'],
        updated: [],
        unchanged: [],
        removed: [],
        skipped: [],
      })),
    }));
    vi.doMock('../../src/runtime/cli-support.js', () => ({
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
      validateProjectConfig: vi.fn(() => []),
      resolveWatchConfig: vi.fn(() => ({
        enabled: false,
        debounceMs: 30_000,
        cooldownMs: 60_000,
        gitPollMs: 2_000,
        autoRefresh: true,
        ignore: [],
      })),
    }));
    vi.doMock('../../src/runtime/cli-context.js', () => ({
      resolveCliProjectContext: vi.fn(() => ({
        projectRoot: '/repo',
        config: {},
        paths: {
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
      writeProjectHealthDossier: vi.fn(() => ({
        markdownPath: '/repo/docs/scip-query/health-dossier.md',
        jsonPath: '/repo/docs/scip-query/health-dossier.json',
        status: 'written',
        written: ['/repo/docs/scip-query/health-dossier.md'],
        unchanged: ['/repo/docs/scip-query/health-dossier.json'],
      })),
      formatHealthScoreSummary: (health: {
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

    const module = await import('../../src/runtime/project-setup.js');
    const report = await module.runProjectSetup();

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
