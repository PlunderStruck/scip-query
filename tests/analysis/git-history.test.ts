import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import {
  getChangeAmplification,
  getCoChangePairs,
  getCommitHistory,
  getFileChurn,
} from '../../src/analysis/git-history.js';
import { coChange } from '../../src/queries/impact/co-change.js';
import { docDrift } from '../../src/queries/cleanup/doc-drift.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';

let repoRoot: string;

// Git-history only reads db.config.projectRoot; coChange also asks for an empty
// dependency graph, so the query methods return no indexed edges.
function fakeDb(projectRoot: string, config: Partial<ScipQueryConfig> = {}): ScipDatabase {
  return {
    config: { projectRoot, ...config },
    all: () => [],
    pathExclusionsFor: () => '',
    isIgnored: () => false,
  } as unknown as ScipDatabase;
}

let commitClock = 1_700_000_000;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repoRoot, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t.t',
      // Distinct timestamps per commit — doc-drift compares them strictly.
      GIT_AUTHOR_DATE: `${commitClock} +0000`,
      GIT_COMMITTER_DATE: `${commitClock} +0000`,
    },
  });
}

function commit(message: string, files: Record<string, string>): void {
  commitClock += 60;
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
  // guide.md documents a.ts (co-changes 3x), then a.ts moves on without it.
  commit('initial', { 'a.ts': '1', 'b.ts': '1', 'c.ts': '1', 'guide.md': 'v1' });
  commit('feature one', { 'a.ts': '2', 'b.ts': '2', 'guide.md': 'v2' });
  commit('fix: regression in pair', { 'a.ts': '3', 'b.ts': '3', 'guide.md': 'v3' });
  commit('feature two', { 'a.ts': '4', 'b.ts': '4' });
  commit('solo change', { 'c.ts': '2' });
  commit('feature three', { 'a.ts': '5' });
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('git history evidence', () => {
  it('parses bounded commit history', () => {
    const history = getCommitHistory(fakeDb(repoRoot));
    expect(history).not.toBeNull();
    expect(history!.commits).toHaveLength(6);
    expect(history!.commits[0]!.files).toContain('a.ts');
  });

  it('returns null outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'scip-no-git-'));
    expect(getCommitHistory(fakeDb(outside))).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('computes per-file churn with fix-commit counts', () => {
    const churn = getFileChurn(fakeDb(repoRoot))!;
    expect(churn.get('a.ts')!.changes).toBe(5);
    expect(churn.get('a.ts')!.fixChanges).toBe(1);
    expect(churn.get('c.ts')!.changes).toBe(2);
    expect(churn.get('c.ts')!.fixChanges).toBe(0);
  });

  it('computes change amplification percentiles', () => {
    const amplification = getChangeAmplification(fakeDb(repoRoot))!;
    expect(amplification.commitsAnalyzed).toBe(6);
    expect(amplification.medianFilesPerCommit).toBe(3);
  });

  it('flags docs whose coupled code moved on without them', () => {
    const result = docDrift(fakeDb(repoRoot));
    expect(result.available).toBe(true);
    const guide = result.findings.find((finding) => finding.doc === 'guide.md');
    expect(guide).toBeDefined();
    // a.ts changed twice after guide.md's last update; b.ts once.
    expect(guide!.subjects).toEqual([
      expect.objectContaining({ file: 'a.ts', coChanges: 3, changesSinceDocUpdate: 2 }),
      expect.objectContaining({ file: 'b.ts', coChanges: 3, changesSinceDocUpdate: 1 }),
    ]);
    expect(guide!.staleness).toBe(3);
  });

  it('finds high-confidence co-change pairs', () => {
    const pairs = getCoChangePairs(fakeDb(repoRoot), { minTogether: 3, minConfidence: 0.6 })!;
    const pair = pairs.find((entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts');
    expect(pair).toBeDefined();
    expect(pair!.together).toBe(4);
    expect(pair!.confidence).toBe(1);
  });

  it('can ignore broad commits when computing co-change pairs', () => {
    const pairs = getCoChangePairs(fakeDb(repoRoot), {
      minTogether: 3,
      minConfidence: 0.6,
      maxFilesPerCommit: 2,
    })!;

    expect(pairs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts' }),
    ]));
  });

  it('treats declared coupling groups as structural links', () => {
    const plain = coChange(fakeDb(repoRoot), undefined, { minTogether: 3, minConfidence: 0.6, limit: 10 });
    expect(plain.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts', structurallyLinked: false }),
    ]));

    const declared = fakeDb(repoRoot, {
      declaredCouplings: [{
        name: 'fixture pair',
        files: ['a.ts', 'b.ts'],
        reason: 'The fixture deliberately moves these files together.',
      }],
    });
    expect(coChange(declared, undefined, { minTogether: 3, minConfidence: 0.6, limit: 10 }).findings)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ fileA: 'a.ts', fileB: 'b.ts' }),
      ]));

    const partner = coChange(declared, 'a.ts', { minTogether: 3, limit: 10 })
      .findings.find((entry) => entry.fileA === 'a.ts' && entry.fileB === 'b.ts');
    expect(partner).toEqual(expect.objectContaining({ structurallyLinked: true }));
  });
});
