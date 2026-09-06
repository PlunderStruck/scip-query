import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginHealthDossierAttempt,
  finishHealthDossierAttempt,
  readHealthDossierAttempt,
  writeProjectHealthDossier,
} from '../../src/runtime/health-dossier.js';
import type { ProjectSetupReport } from '../../src/runtime/project-setup.js';

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe('writeProjectHealthDossier', () => {
  it('writes Markdown and JSON dossiers with availability, issues, blocked checks, and smoke tests', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-health-dossier-'));
    tempRoots.push(projectRoot);

    const report = {
      projectRoot,
      dbPath: join(homedir(), '.cache', 'scip-query', 'projects', 'example', 'index.db'),
      configuredDbPath: join(homedir(), '.cache', 'scip-query', 'projects', 'example', 'index.db'),
      scipCliInstalled: true,
      languages: ['typescript'],
      steps: [{ id: 'health', label: 'Health audit', status: 'ok', message: 'Health report available.' }],
      skills: { installed: [], alreadyLinked: ['Codex/scip-query'], pruned: [], skipped: [] },
      initialReadiness: {
        languages: ['typescript'],
        indexers: [{ language: 'typescript', binaryLabel: 'scip-typescript', installed: true, runnable: true }],
        checkers: [],
        gitAvailable: true,
      },
      indexerRemediation: [
        {
          language: 'java',
          binaryLabel: 'scip-java',
          attempted: false,
          installed: false,
          before: { language: 'java', binaryLabel: 'scip-java', installed: false, runnable: false },
          after: { language: 'java', binaryLabel: 'scip-java', installed: false, runnable: false },
          messages: ['No auto-install method is configured for scip-java.'],
          recovery: 'https://github.com/sourcegraph/scip-java/releases',
        },
      ],
      readiness: {
        languages: ['typescript'],
        indexers: [{ language: 'typescript', binaryLabel: 'scip-typescript', installed: true, runnable: true }],
        checkers: [],
        gitAvailable: true,
      },
      capabilities: { languages: ['typescript'], capabilities: [], matrix: [] },
      freshness: {
        state: 'fresh',
        checkedAt: '2026-06-23T00:00:00.000Z',
        metaPath: join(projectRoot, '.scip', 'index.meta.json'),
        reason: 'Index metadata fingerprint matches current source files.',
      },
      reindex: null,
      health: {
        available: true,
        issuesNeedAttention: [
          {
            category: 'Duplication',
            description: 'Merge repeated setup logic',
            count: 2,
            impact: 'high',
            effort: 'medium',
            evidence: 'heuristic',
            locRecoverable: 42,
            confirmationStatus: 'unconfirmed',
            safeForAgentToStart: false,
            recommendedNextStep:
              'Confirm this signal against its named source evidence before editing; fix it only when it matches the requested goal.',
          },
        ],
        warnings: [],
      },
      smokeTests: [
        { id: 'status', command: 'scip-query status', status: 'pass', evidence: 'Index freshness is fresh.' },
        {
          id: 'health',
          command: 'scip-query health',
          status: 'unavailable',
          evidence: 'Health report was not available.',
        },
      ],
      healthDossier: null,
      setupAgent: { written: ['AGENTS.md'], unchanged: [], skipped: [] },
      filesWritten: ['AGENTS.md'],
      verdict: 'partial',
    } satisfies ProjectSetupReport;

    const result = writeProjectHealthDossier(report);

    expect(result.status).toBe('written');
    expect(result.written).toEqual([result.markdownPath, result.jsonPath]);

    const markdown = readFileSync(result.markdownPath, 'utf-8');
    expect(markdown).not.toContain('Generated:');
    expect(markdown).not.toContain(projectRoot);
    expect(markdown).toContain('Health report: available; findings require source confirmation');
    expect(markdown).toContain('## Items That Need Attention');
    expect(markdown).toContain('Duplication: Merge repeated setup logic');
    expect(markdown).toContain('confirmation unconfirmed; safe to start no');
    expect(markdown).toContain('UNAVAILABLE `scip-query health`');
    expect(markdown).toContain('BLOCKED java');

    const json = JSON.parse(readFileSync(result.jsonPath, 'utf-8')) as ProjectSetupReport;
    expect(json.health.available).toBe(true);
    expect(json.projectRoot).toBe('.');
    expect(json.dbPath).toBe('~/.cache/scip-query/projects/example/index.db');
    expect(json.healthDossier?.markdownPath).toBe('docs/scip-query/health-dossier.md');
    expect(JSON.stringify(json)).not.toContain(projectRoot);
    expect(JSON.stringify(json)).not.toContain(homedir());

    const second = writeProjectHealthDossier(report);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toEqual([second.markdownPath, second.jsonPath]);
  });
});

describe('health dossier attempts', () => {
  it('records an attempt before the audit, exposes an interrupted one, and clears it after publication', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-health-attempt-'));
    tempRoots.push(projectRoot);

    const first = beginHealthDossierAttempt(projectRoot, {
      runId: 'run-1',
      startedAt: '2026-09-01T18:07:46.000Z',
      indexGeneration: 'generation-a',
    });
    expect(first.interrupted).toBeNull();
    expect(readHealthDossierAttempt(first.attemptPath)).toEqual({
      runId: 'run-1',
      startedAt: '2026-09-01T18:07:46.000Z',
      indexGeneration: 'generation-a',
    });

    // The first audit crashed before publishing: the next setup sees the marker.
    const second = beginHealthDossierAttempt(projectRoot, {
      runId: 'run-2',
      startedAt: '2026-09-01T18:25:00.000Z',
      indexGeneration: 'generation-b',
    });
    expect(second.interrupted).toEqual(expect.objectContaining({ runId: 'run-1', indexGeneration: 'generation-a' }));

    finishHealthDossierAttempt(second);
    expect(existsSync(second.attemptPath)).toBe(false);
    expect(readHealthDossierAttempt(second.attemptPath)).toBeNull();
  });

  it('publishes the generation and attempt in the dossier and ignores attempt timestamps when deciding change', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-health-attempt-'));
    tempRoots.push(projectRoot);
    const base = {
      projectRoot,
      verdict: 'ready',
      health: { score: 90, riskScore: 10, hygieneScore: 95, issuesNeedAttention: [] },
      smokeTests: [],
      steps: [],
      indexerRemediation: [],
      healthDossier: null,
      indexGeneration: 'generation-a',
    };

    const first = writeProjectHealthDossier(
      { ...base, attempt: { runId: 'run-1', startedAt: '2026-09-01T18:00:00.000Z', indexGeneration: 'generation-a' } },
      {},
    );
    expect(first.written).toHaveLength(2);
    const json = JSON.parse(readFileSync(first.jsonPath, 'utf8')) as Record<string, unknown>;
    expect(json).toEqual(expect.objectContaining({ indexGeneration: 'generation-a' }));
    expect(json['attempt']).toEqual(expect.objectContaining({ runId: 'run-1' }));
    expect(readFileSync(first.markdownPath, 'utf8')).toContain('Index generation: generation-a');

    const second = writeProjectHealthDossier(
      { ...base, attempt: { runId: 'run-2', startedAt: '2026-09-01T19:00:00.000Z', indexGeneration: 'generation-a' } },
      {},
    );
    expect(second.unchanged).toContain(second.jsonPath);

    const third = writeProjectHealthDossier(
      {
        ...base,
        indexGeneration: 'generation-b',
        attempt: { runId: 'run-3', startedAt: '2026-09-01T20:00:00.000Z', indexGeneration: 'generation-b' },
      },
      {},
    );
    expect(third.written).toContain(third.jsonPath);
  });
});
