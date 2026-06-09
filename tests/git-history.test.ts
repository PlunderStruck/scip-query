import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScipDatabase } from '../src/storage/db.js';
import {
  getChangeAmplification,
  getCoChangePairs,
  getCommitHistory,
  getFileChurn,
} from '../src/analysis/git-history.js';

let repoRoot: string;

// git-history only reads db.config.projectRoot and uses the db as a cache key.
function fakeDb(projectRoot: string): ScipDatabase {
  return { config: { projectRoot } } as ScipDatabase;
}

function git(...args: string[]): void {
  execFileSync('git', ['-C', repoRoot, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

function commit(message: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repoRoot, path), content);
  }
  git('add', '-A');
  git('commit', '-m', message, '--no-gpg-sign');
}

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'scip-git-history-'));
  git('init');
  // a.ts and b.ts always change together; c.ts changes alone.
  commit('initial', { 'a.ts': '1', 'b.ts': '1', 'c.ts': '1' });
  commit('feature one', { 'a.ts': '2', 'b.ts': '2' });
  commit('fix: regression in pair', { 'a.ts': '3', 'b.ts': '3' });
  commit('feature two', { 'a.ts': '4', 'b.ts': '4' });
  commit('solo change', { 'c.ts': '2' });
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('git history evidence', () => {
  it('parses bounded commit history', () => {
    const history = getCommitHistory(fakeDb(repoRoot));
    expect(history).not.toBeNull();
    expect(history!.commits).toHaveLength(5);
    expect(history!.commits[0]!.files).toContain('c.ts');
  });

  it('returns null outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'scip-no-git-'));
    expect(getCommitHistory(fakeDb(outside))).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('computes per-file churn with fix-commit counts', () => {
    const churn = getFileChurn(fakeDb(repoRoot))!;
    expect(churn.get('a.ts')!.changes).toBe(4);
    expect(churn.get('a.ts')!.fixChanges).toBe(1);
    expect(churn.get('c.ts')!.changes).toBe(2);
    expect(churn.get('c.ts')!.fixChanges).toBe(0);
  });

  it('computes change amplification percentiles', () => {
    const amplification = getChangeAmplification(fakeDb(repoRoot))!;
    expect(amplification.commitsAnalyzed).toBe(5);
    expect(amplification.medianFilesPerCommit).toBe(2);
  });

  it('finds high-confidence co-change pairs', () => {
    const pairs = getCoChangePairs(fakeDb(repoRoot), { minTogether: 3, minConfidence: 0.6 })!;
    const pair = pairs.find((entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts');
    expect(pair).toBeDefined();
    expect(pair!.together).toBe(4);
    expect(pair!.confidence).toBe(1);
  });
});
