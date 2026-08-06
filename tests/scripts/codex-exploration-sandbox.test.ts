import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExplorationSandbox } from '../../scripts/codex-exploration-sandbox.mjs';

describe('Codex exploration sandbox', () => {
  let sourceRoot: string | null = null;

  afterEach(() => {
    if (sourceRoot) rmSync(sourceRoot, { recursive: true, force: true });
    sourceRoot = null;
  });

  it('observes a fixed commit and removes the worktree plus private cache', () => {
    sourceRoot = mkdtempSync(join(tmpdir(), 'scip-query-benchmark-source-'));
    git(sourceRoot, ['init']);
    git(sourceRoot, ['config', 'user.email', 'benchmark@example.test']);
    git(sourceRoot, ['config', 'user.name', 'Benchmark']);
    writeFileSync(join(sourceRoot, 'feature.ts'), 'export const value = "committed";\n');
    mkdirSync(join(sourceRoot, 'node_modules'));
    git(sourceRoot, ['add', 'feature.ts']);
    git(sourceRoot, ['commit', '-m', 'fixture']);
    const committedHead = git(sourceRoot, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(sourceRoot, 'feature.ts'), 'export const value = "live edit";\n');

    const sandbox = createExplorationSandbox(sourceRoot);
    const repository = sandbox.repository;
    const cacheDir = sandbox.cacheDir;
    try {
      expect(sandbox.commit).toBe(committedHead);
      expect(readFileSync(join(repository, 'feature.ts'), 'utf8')).toContain('committed');
      expect(readFileSync(join(repository, 'feature.ts'), 'utf8')).not.toContain('live edit');
      expect(existsSync(join(repository, 'node_modules'))).toBe(true);
      expect(existsSync(cacheDir)).toBe(true);
      expect(git(sourceRoot, ['worktree', 'list', '--porcelain'])).toContain(repository);
    } finally {
      sandbox.remove();
    }

    expect(existsSync(repository)).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
    expect(git(sourceRoot, ['worktree', 'list', '--porcelain'])).not.toContain(repository);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
