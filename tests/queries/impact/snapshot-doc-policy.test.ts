import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { diffGate } from '../../../src/queries/impact/diff-gate.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

// Scenario: docs/benchmarks/2026-06-28-ledger.md cites src/a.ts. The
// working tree edits src/a.ts (uncommitted) without touching the doc.
// docs.snapshotPaths excludes docs/benchmarks/** from the doc-reference
// check, so no finding should appear regardless of the citation.

const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

function gitIn(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t.t',
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    },
  });
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function buildRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scip-snapshot-doc-policy-'));
  tempRoots.push(repoRoot);
  gitIn(repoRoot, 'init');
  writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 1;\n');
  writeFile(
    join(repoRoot, 'docs', 'benchmarks', '2026-06-28-ledger.md'),
    'This benchmark ledger cites src/a.ts as of 2026-06-28.\n',
  );
  gitIn(repoRoot, 'add', '-A');
  gitIn(repoRoot, 'commit', '-m', 'base', '--no-gpg-sign');
  return repoRoot;
}

function fixtureDb(repoRoot: string, snapshotPaths: string[] | undefined): ScipDatabase {
  const dbPath = join(repoRoot, 'index.db');
  evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/a.ts').write();

  const config: ScipQueryConfig = {
    dbPath,
    indexPath: join(repoRoot, 'index.scip'),
    projectRoot: repoRoot,
    docs: snapshotPaths ? { snapshotPaths } : undefined,
  };
  const db = new ScipDatabase(config);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SKIP_UNRELATED = [
  'echo',
  'incomplete-migration',
  'co-change-partner',
  'twin-partner',
  'coverage-contract',
  'unused-params',
  'new-dead',
] as const;

describe('diff-gate snapshot-doc policy', () => {
  it('excludes a docs.snapshotPaths glob match from doc-reference findings', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot, ['docs/benchmarks/**']);
    writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 2;\n');

    const result = diffGate(db, { base: 'HEAD', skip: [...SKIP_UNRELATED] });

    expect(result.findings.filter((finding) => finding.check === 'doc-reference')).toHaveLength(0);
  });

  it('still flags the same citation without a configured snapshot policy', () => {
    const repoRoot = buildRepo();
    const db = fixtureDb(repoRoot, undefined);
    writeFile(join(repoRoot, 'src', 'a.ts'), 'export const version = 2;\n');

    const result = diffGate(db, { base: 'HEAD', skip: [...SKIP_UNRELATED] });

    expect(result.findings.filter((finding) => finding.check === 'doc-reference')).toHaveLength(1);
  });
});
