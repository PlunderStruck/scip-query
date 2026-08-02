import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeProjectHealthDossier } from '../../src/runtime/health-dossier.js';
import type { ProjectSetupReport } from '../../src/runtime/project-setup.js';

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe('writeProjectHealthDossier', () => {
  it('writes Markdown and JSON dossiers with score, issues, blocked checks, and smoke tests', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-health-dossier-'));
    tempRoots.push(projectRoot);

    const report = {
      projectRoot,
      dbPath: join(homedir(), '.cache', 'scip-query', 'projects', 'example', 'index.db'),
      configuredDbPath: join(homedir(), '.cache', 'scip-query', 'projects', 'example', 'index.db'),
      scipCliInstalled: true,
      languages: ['typescript'],
      steps: [{ id: 'health', label: 'Health audit', status: 'ok', message: 'Health score 82.' }],
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
        score: 82,
        riskScore: 90,
        hygieneScore: 82,
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
    expect(markdown).toContain('Health score: 82 (risk 90, hygiene 82)');
    expect(markdown).toContain('## Items That Need Attention');
    expect(markdown).toContain('Duplication: Merge repeated setup logic');
    expect(markdown).toContain('confirmation unconfirmed; safe to start no');
    expect(markdown).toContain('UNAVAILABLE `scip-query health`');
    expect(markdown).toContain('BLOCKED java');

    const json = JSON.parse(readFileSync(result.jsonPath, 'utf-8')) as ProjectSetupReport;
    expect(json.health.score).toBe(82);
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
