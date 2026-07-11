import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScipDatabase } from '../../../src/storage/db.js';

describe('recent duplicate framework pruning', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../src/analysis/git-history.js');
    vi.doUnmock('../../../src/queries/cleanup/similar.js');
    vi.doUnmock('../../../src/queries/frontend/react-component-duplicates.js');
    vi.doUnmock('../../../src/queries/frontend/react-hook-candidates.js');
    vi.doUnmock('../../../src/queries/frontend/vue-component-duplicates.js');
    vi.doUnmock('../../../src/queries/frontend/vue-composable-candidates.js');
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('keeps callable duplicate output while skipping absent frontend frameworks', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-recent-pruning-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'echo.ts'), 'export function echo() { return shared(); }\n');
    writeFileSync(join(projectRoot, 'src', 'original.ts'), 'export function original() { return shared(); }\n');

    const failIfCalled = vi.fn(() => {
      throw new Error('frontend duplicate query should not run without matching source files');
    });

    vi.doMock('../../../src/analysis/git-history.js', () => {
      const fileAdds = new Map([['src/echo.ts', { commitsAgo: 0, addedAt: 1 }]]);
      return {
        getFileAddRecords: () => fileAdds,
        gitEvidenceProduct: () => ({
          fileAddRecords: () => fileAdds,
        }),
      };
    });
    vi.doMock('../../../src/queries/cleanup/similar.js', () => ({
      similarAll: () => [
        {
          symbolA: 'scip-typescript npm fixture 1.0.0 src/`echo.ts`/echo().',
          shortNameA: 'echo',
          fileA: 'src/echo.ts',
          symbolB: 'scip-typescript npm fixture 1.0.0 src/`original.ts`/original().',
          shortNameB: 'original',
          fileB: 'src/original.ts',
          similarity: 0.91,
          similarityBasis: 'callees',
          sharedCallees: ['shared'],
        },
      ],
    }));
    vi.doMock('../../../src/queries/frontend/react-component-duplicates.js', () => ({
      reactComponentDuplicates: failIfCalled,
    }));
    vi.doMock('../../../src/queries/frontend/react-hook-candidates.js', () => ({
      reactHookCandidates: failIfCalled,
    }));
    vi.doMock('../../../src/queries/frontend/vue-component-duplicates.js', () => ({
      vueComponentDuplicates: failIfCalled,
    }));
    vi.doMock('../../../src/queries/frontend/vue-composable-candidates.js', () => ({
      vueComposableCandidates: failIfCalled,
    }));

    const { recentDuplicates } = await import('../../../src/queries/cleanup/recent-duplicates.js');
    const db = {
      config: { projectRoot },
      all: () => [],
      isIgnored: () => false,
      pathExclusionsFor: () => '',
    } as unknown as ScipDatabase;

    const result = recentDuplicates(db, { windowCommits: 100, limit: 10 });

    expect(failIfCalled).not.toHaveBeenCalled();
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: 'echo',
        domain: 'callable',
        echoFile: 'src/echo.ts',
        establishedFile: 'src/original.ts',
        sharedCallees: ['shared'],
      }),
    ]);
  });

  it('excludes Rust trait-required implementations from directional duplicate advice', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-recent-rust-trait-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'new_plugin.rs'), 'impl Plugin for NewPlugin {}\n');
    writeFileSync(join(projectRoot, 'src', 'old_plugin.rs'), 'impl Plugin for OldPlugin {}\n');

    vi.doMock('../../../src/analysis/git-history.js', () => {
      const fileAdds = new Map([
        ['src/new_plugin.rs', { commitsAgo: 1, addedAt: 2 }],
        ['src/old_plugin.rs', { commitsAgo: 12, addedAt: 1 }],
      ]);
      return {
        getFileAddRecords: () => fileAdds,
        gitEvidenceProduct: () => ({ fileAddRecords: () => fileAdds }),
      };
    });
    vi.doMock('../../../src/queries/cleanup/similar.js', () => ({
      similarAll: () => [
        {
          symbolA: 'rust-analyzer cargo fixture 0.1.0 plugins/impl#[NewPlugin][Plugin]build().',
          shortNameA: 'plugins:impl:NewPlugin:Plugin:build()',
          fileA: 'src/new_plugin.rs',
          symbolB: 'rust-analyzer cargo fixture 0.1.0 plugins/impl#[OldPlugin][Plugin]build().',
          shortNameB: 'plugins:impl:OldPlugin:Plugin:build()',
          fileB: 'src/old_plugin.rs',
          similarity: 1,
          similarityBasis: 'callees',
          sharedCallees: ['add_systems', 'init_resource'],
        },
      ],
    }));
    vi.doMock('../../../src/queries/frontend/react-component-duplicates.js', () => ({
      reactComponentDuplicates: vi.fn(),
    }));
    vi.doMock('../../../src/queries/frontend/react-hook-candidates.js', () => ({ reactHookCandidates: vi.fn() }));
    vi.doMock('../../../src/queries/frontend/vue-component-duplicates.js', () => ({
      vueComponentDuplicates: vi.fn(),
    }));
    vi.doMock('../../../src/queries/frontend/vue-composable-candidates.js', () => ({
      vueComposableCandidates: vi.fn(),
    }));

    const { recentDuplicates } = await import('../../../src/queries/cleanup/recent-duplicates.js');
    const db = {
      config: { projectRoot },
      all: () => [],
      isIgnored: () => false,
      pathExclusionsFor: () => '',
    } as unknown as ScipDatabase;

    expect(recentDuplicates(db, { windowCommits: 100, limit: 10 }).findings).toEqual([]);
  });
});
